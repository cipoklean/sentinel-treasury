// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {InvoiceRegistry} from "../src/InvoiceRegistry.sol";
import {PolicyVault} from "../src/PolicyVault.sol";

/// @dev Stand-in for the QoreChain PQC precompiles (0x0A01 verify / 0x0A02
///      status). vm.etch places its code at the precompile addresses so the
///      vault's staticcalls succeed in a local EVM.
contract MockPQC {
    bool public verifyResult = true;
    bool public keyRegistered = true;

    function setVerifyResult(bool v) external {
        verifyResult = v;
    }

    function setKeyRegistered(bool v) external {
        keyRegistered = v;
    }

    function pqcVerify(bytes calldata, bytes calldata signature, bytes calldata message)
        external
        view
        returns (bool)
    {
        // Mock semantics: a "valid signature" is the message bytes verbatim.
        return verifyResult && keccak256(signature) == keccak256(message);
    }

    function pqcKeyStatus(address) external view returns (bool, uint8, bytes memory, bool) {
        return (keyRegistered, 1, new bytes(2592), keyRegistered);
    }
}

contract PolicyVaultTest is Test {
    address internal constant PQC_VERIFY = address(0x0A01);
    address internal constant PQC_STATUS = address(0x0A02);

    address internal operator = address(0x0F00);
    address internal agent = address(0xA9E47);
    address internal vendor = address(0xBEEF);
    address internal vendor2 = address(0xCAFE);
    address internal nobody = address(0xDEAD);

    InvoiceRegistry internal registry;
    PolicyVault internal vault;
    MockPQC internal mock;

    uint256 internal constant PER_TX = 5 ether;
    uint256 internal constant DAILY = 20 ether;
    uint256 internal constant THRESHOLD = 2 ether;

    event PaymentExecuted(uint256 indexed, address indexed, uint256, bytes32, bool);
    event PaymentRefused(uint256 indexed, address indexed, uint256, string);

    function setUp() public {
        mock = new MockPQC();
        vm.etch(PQC_VERIFY, address(mock).code);
        vm.etch(PQC_STATUS, address(mock).code);
        // etch copies code only; initialize the etched instances' storage.
        MockPQC(PQC_VERIFY).setVerifyResult(true);
        MockPQC(PQC_STATUS).setKeyRegistered(true);

        vm.prank(operator);
        registry = new InvoiceRegistry();
        vm.prank(operator);
        vault = new PolicyVault(address(registry), agent, PER_TX, DAILY, THRESHOLD);
        vm.prank(operator);
        registry.setVault(address(vault));

        vm.deal(operator, 100 ether);
        vm.prank(operator);
        vault.deposit{value: 50 ether}();
    }

    function _invoice(uint256 amount) internal returns (uint256 id) {
        return _invoiceFor(vendor, amount);
    }

    function _invoiceFor(address v, uint256 amount) internal returns (uint256 id) {
        vm.prank(v);
        id = registry.submit(amount, keccak256("ref"));
    }

    function _allow(address v) internal {
        vm.prank(operator);
        vault.setVendorAllowed(v, true);
    }

    // ---- happy path --------------------------------------------------

    function test_PayWithinPolicy() public {
        _allow(vendor);
        uint256 id = _invoice(1 ether);
        vm.prank(agent);
        vault.pay(id, bytes32("decision"));
        assertEq(vendor.balance, 1 ether);
        InvoiceRegistry.Invoice memory inv = registry.invoice(id);
        assertEq(uint8(inv.status), uint8(InvoiceRegistry.Status.Paid));
        assertEq(vault.totalPaid(), 1 ether);
    }

    function test_OperatorCanPayToo() public {
        // Same call reaches the vault when relayed through x/abstractaccount:
        // the execution comes from the operator's address.
        _allow(vendor);
        uint256 id = _invoice(1 ether);
        vm.prank(operator);
        vault.pay(id, bytes32(0));
        assertEq(vendor.balance, 1 ether);
    }

    // ---- authorization -----------------------------------------------

    function test_RevertWhen_StrangerPays() public {
        _allow(vendor);
        uint256 id = _invoice(1 ether);
        vm.prank(nobody);
        vm.expectRevert(PolicyVault.NotAuthorized.selector);
        vault.pay(id, bytes32(0));
    }

    function test_RevertWhen_NonOperatorAdmin() public {
        vm.prank(nobody);
        vm.expectRevert(PolicyVault.NotOperator.selector);
        vault.setVendorAllowed(vendor, true);
    }

    // ---- policy refusals (emitted, not reverted) ----------------------

    function test_RefusesUnlistedVendor() public {
        uint256 id = _invoice(1 ether);
        vm.expectEmit(address(vault));
        emit PaymentRefused(id, vendor, 1 ether, "vendor not allowed");
        vm.prank(agent);
        vault.pay(id, bytes32(0));
        assertEq(vendor.balance, 0);
    }

    function test_RefusesOverPerTxCap() public {
        _allow(vendor);
        uint256 id = _invoice(PER_TX + 1);
        vm.expectEmit(address(vault));
        emit PaymentRefused(id, vendor, PER_TX + 1, "over per-tx cap");
        vm.prank(agent);
        vault.pay(id, bytes32(0));
    }

    function test_RefusesOverDailyCap() public {
        _allow(vendor);
        for (uint256 i = 0; i < 10; i++) {
            uint256 paid = _invoice(THRESHOLD); // at threshold: no mandate needed
            vm.prank(agent);
            vault.pay(paid, bytes32(0)); // 10*2 = 20 = daily cap
        }
        uint256 id = _invoice(1 ether);
        vm.expectEmit(address(vault));
        emit PaymentRefused(id, vendor, 1 ether, "over daily cap");
        vm.prank(agent);
        vault.pay(id, bytes32(0));
    }

    function test_RefusesWhenPaused() public {
        _allow(vendor);
        vm.prank(operator);
        vault.setPaused(true);
        uint256 id = _invoice(1 ether);
        vm.expectEmit(address(vault));
        emit PaymentRefused(id, vendor, 1 ether, "paused");
        vm.prank(agent);
        vault.pay(id, bytes32(0));
    }

    function test_RefusesNonPending() public {
        _allow(vendor);
        uint256 id = _invoice(1 ether);
        vm.prank(vendor);
        registry.cancel(id);
        vm.expectEmit(address(vault));
        emit PaymentRefused(id, vendor, 1 ether, "not pending");
        vm.prank(agent);
        vault.pay(id, bytes32(0));
    }

    // ---- mandate path --------------------------------------------------

    function test_MandateRequiredAboveThreshold() public {
        _allow(vendor);
        uint256 id = _invoice(THRESHOLD + 1);
        vm.expectEmit(address(vault));
        emit PaymentRefused(id, vendor, THRESHOLD + 1, "mandate required");
        vm.prank(agent);
        vault.pay(id, bytes32(0));
        assertEq(vendor.balance, 0);
    }

    function _mandate(uint256 id, uint64 expiry) internal view returns (bytes memory) {
        return vault.mandateMessage(id, vendor, registry.invoice(id).amount, expiry);
    }

    function test_PayWithValidMandate() public {
        _allow(vendor);
        uint256 id = _invoice(THRESHOLD + 1);
        uint64 expiry = uint64(block.timestamp + 1 hours);
        bytes memory sig = _mandate(id, expiry); // mock verifies sig == message
        vm.prank(agent);
        vault.payWithMandate(id, bytes32(0), expiry, sig);
        assertEq(vendor.balance, THRESHOLD + 1);
    }

    function test_RefusesExpiredMandate() public {
        _allow(vendor);
        uint256 id = _invoice(THRESHOLD + 1);
        uint64 expiry = uint64(block.timestamp - 1);
        bytes memory sig = _mandate(id, expiry);
        vm.expectEmit(address(vault));
        emit PaymentRefused(id, vendor, THRESHOLD + 1, "mandate required");
        vm.prank(agent);
        vault.payWithMandate(id, bytes32(0), expiry, sig);
    }

    function test_RefusesBadMandateSig() public {
        _allow(vendor);
        uint256 id = _invoice(THRESHOLD + 1);
        bytes memory sig = bytes("forged");
        vm.expectEmit(address(vault));
        emit PaymentRefused(id, vendor, THRESHOLD + 1, "bad mandate");
        vm.prank(agent);
        vault.payWithMandate(id, bytes32(0), uint64(block.timestamp + 1 hours), sig);
    }

    function test_RefusesMandateForOtherInvoice() public {
        _allow(vendor);
        uint256 id1 = _invoice(THRESHOLD + 1);
        uint256 id2 = _invoice(THRESHOLD + 1);
        uint64 expiry = uint64(block.timestamp + 1 hours);
        // Mandate signed for invoice id1 must not pay invoice id2.
        bytes memory sig = _mandate(id1, expiry);
        vm.expectEmit(address(vault));
        emit PaymentRefused(id2, vendor, THRESHOLD + 1, "bad mandate");
        vm.prank(agent);
        vault.payWithMandate(id2, bytes32(0), expiry, sig);
    }

    // ---- admin ---------------------------------------------------------

    function test_RevertWhen_OperatorLosesPqcKey() public {
        MockPQC(PQC_STATUS).setKeyRegistered(false);
        vm.prank(operator);
        vm.expectRevert(PolicyVault.OperatorPqcKeyMissing.selector);
        vault.setPaused(true);
    }

    function test_WithdrawOnlyOperator() public {
        vm.prank(nobody);
        vm.expectRevert(PolicyVault.NotOperator.selector);
        vault.withdraw(payable(nobody), 1 ether);
        vm.prank(operator);
        vault.withdraw(payable(operator), 1 ether);
    }
}
