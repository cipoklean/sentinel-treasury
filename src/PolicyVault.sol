// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {IQorePQC} from "./interfaces/IQorePQC.sol";
import {InvoiceRegistry} from "./InvoiceRegistry.sol";

/// @title PolicyVault
/// @notice Smart account holding a treasury and enforcing the Sentinel agent's
///         spending policy on chain. Payments are executed by the autonomous
///         agent either from its own EOA (which the network only admits inside
///         a scoped EVM authorisation window targeting this contract) or through
///         a delegated x/abstractaccount execution from the operator account.
///         Payments above `mandateThreshold` additionally need an operator
///         mandate: an ML-DSA-87 signature verified here against the operator's
///         chain-registered post-quantum key (precompile 0x0A01).
contract PolicyVault {
    /// @dev PQC signature verify precompile (testnet).
    IQorePQC internal constant PQC_VERIFY = IQorePQC(address(0x0A01));
    /// @dev PQC key-status precompile (testnet).
    IQorePQC internal constant PQC_STATUS = IQorePQC(address(0x0A02));

    /// @notice The cold operator account. Its key is post-quantum: it opens
    ///         EVM windows, owns the abstract account and signs mandates.
    address public immutable operator;
    /// @notice The hot agent EOA allowed to trigger payments.
    address public agent;
    /// @notice Registry invoices are settled against.
    InvoiceRegistry public immutable registry;

    /// @notice Maximum amount a single payment may move.
    uint256 public perTxCap;
    /// @notice Maximum total paid out per UTC day.
    uint256 public dailyCap;
    /// @notice Amounts strictly above this need an operator mandate.
    uint256 public mandateThreshold;
    /// @notice Emergency stop set by the operator.
    bool public paused;
    /// @notice Vendor allowlist for payouts.
    mapping(address => bool) public vendorAllowed;

    /// @notice Amount paid out in the current UTC day.
    uint256 public spentToday;
    /// @notice UTC day index `spentToday` refers to.
    uint64 public spentDay;
    /// @notice Lifetime payouts.
    uint256 public totalPaid;

    uint8 private _locked;

    event Deposited(address indexed from, uint256 amount);
    event PaymentExecuted(
        uint256 indexed invoiceId,
        address indexed vendor,
        uint256 amount,
        bytes32 decisionRef,
        bool withMandate
    );
    /// @notice Policy refusals are recorded on chain (the tx still succeeds) so
    ///         the feed and the jury can see the enforcement working.
    event PaymentRefused(uint256 indexed invoiceId, address indexed vendor, uint256 amount, string reason);
    event VendorAllowed(address indexed vendor, bool allowed);
    event PolicySet(uint256 perTxCap, uint256 dailyCap, uint256 mandateThreshold);
    event AgentSet(address indexed agent);
    event PauseSet(bool paused);
    event Withdrawn(address indexed to, uint256 amount);

    error NotOperator();
    error NotAuthorized();
    error OperatorPqcKeyMissing();
    error Reentrant();
    error TransferFailed(address to, uint256 amount);

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    modifier lock() {
        if (_locked != 0) revert Reentrant();
        _locked = 1;
        _;
        _locked = 0;
    }

    /// @param registry_ The InvoiceRegistry this vault settles against.
    /// @param agent_ The agent EOA allowed to trigger payments.
    constructor(address registry_, address agent_, uint256 perTxCap_, uint256 dailyCap_, uint256 mandateThreshold_) {
        operator = msg.sender;
        _requireOperatorPqc();
        registry = InvoiceRegistry(registry_);
        agent = agent_;
        perTxCap = perTxCap_;
        dailyCap = dailyCap_;
        mandateThreshold = mandateThreshold_;
        emit AgentSet(agent_);
        emit PolicySet(perTxCap_, dailyCap_, mandateThreshold_);
    }

    /// @notice Treasury funding.
    receive() external payable {
        emit Deposited(msg.sender, msg.value);
    }

    function deposit() external payable {
        emit Deposited(msg.sender, msg.value);
    }

    // ------------------------------------------------------------------
    // Operator administration. Every admin call re-checks that the operator
    // account still holds a proven ML-DSA-87 key on chain.
    // ------------------------------------------------------------------

    function setAgent(address a) external onlyOperator {
        _requireOperatorPqc();
        agent = a;
        emit AgentSet(a);
    }

    function setPolicy(uint256 perTxCap_, uint256 dailyCap_, uint256 mandateThreshold_) external onlyOperator {
        _requireOperatorPqc();
        perTxCap = perTxCap_;
        dailyCap = dailyCap_;
        mandateThreshold = mandateThreshold_;
        emit PolicySet(perTxCap_, dailyCap_, mandateThreshold_);
    }

    function setVendorAllowed(address vendor, bool allowed) external onlyOperator {
        _requireOperatorPqc();
        vendorAllowed[vendor] = allowed;
        emit VendorAllowed(vendor, allowed);
    }

    function setPaused(bool p) external onlyOperator {
        _requireOperatorPqc();
        paused = p;
        emit PauseSet(p);
    }

    /// @notice Operator withdrawal. The agent cannot reach this: even with the
    ///         agent key an attacker cannot move funds to an arbitrary address.
    function withdraw(address payable to, uint256 amount) external onlyOperator lock {
        _requireOperatorPqc();
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed(to, amount);
        emit Withdrawn(to, amount);
    }

    // ------------------------------------------------------------------
    // Agent payment paths
    // ------------------------------------------------------------------

    /// @notice Pay a pending invoice within policy. `decisionRef` binds the
    ///         payment to the agent's off-chain decision record.
    function pay(uint256 invoiceId, bytes32 decisionRef) external lock {
        _authorizeCaller();
        _settle(invoiceId, decisionRef, 0, "", false);
    }

    /// @notice Pay an invoice above `mandateThreshold`. `signature` must be the
    ///         operator's ML-DSA-87 signature over `mandateMessage`.
    function payWithMandate(uint256 invoiceId, bytes32 decisionRef, uint64 expiry, bytes calldata signature)
        external
        lock
    {
        _authorizeCaller();
        _settle(invoiceId, decisionRef, expiry, signature, true);
    }

    /// @notice The agent EOA (inside its scoped window) or the operator account
    ///         itself (owner txs and relayed authenticator executions).
    function _authorizeCaller() internal view {
        if (msg.sender != agent && msg.sender != operator) revert NotAuthorized();
    }

    /// @dev Policy refusals are emitted, not reverted, so they stay on chain.
    function _settle(uint256 invoiceId, bytes32 decisionRef, uint64 expiry, bytes memory signature, bool withMandate)
        internal
    {
        InvoiceRegistry.Invoice memory inv = registry.invoice(invoiceId);
        if (paused) return _refuse(invoiceId, inv.vendor, inv.amount, "paused");
        if (inv.status != InvoiceRegistry.Status.Pending) return _refuse(invoiceId, inv.vendor, inv.amount, "not pending");
        if (!vendorAllowed[inv.vendor]) return _refuse(invoiceId, inv.vendor, inv.amount, "vendor not allowed");
        if (inv.amount > perTxCap) return _refuse(invoiceId, inv.vendor, inv.amount, "over per-tx cap");

        uint64 today = uint64(block.timestamp / 1 days);
        uint256 spent = spentDay == today ? spentToday : 0;
        if (spent + inv.amount > dailyCap) return _refuse(invoiceId, inv.vendor, inv.amount, "over daily cap");

        bool mandate = false;
        if (inv.amount > mandateThreshold) {
            if (!withMandate || expiry < block.timestamp) {
                return _refuse(invoiceId, inv.vendor, inv.amount, "mandate required");
            }
            bytes memory message = mandateMessage(invoiceId, inv.vendor, inv.amount, expiry);
            if (!_verifyOperatorMandate(message, signature)) {
                return _refuse(invoiceId, inv.vendor, inv.amount, "bad mandate");
            }
            mandate = true;
        }

        spentDay = today;
        spentToday = spent + inv.amount;
        totalPaid += inv.amount;
        registry.settle(invoiceId, true);
        (bool ok,) = inv.vendor.call{value: inv.amount}("");
        if (!ok) revert TransferFailed(inv.vendor, inv.amount);
        emit PaymentExecuted(invoiceId, inv.vendor, inv.amount, decisionRef, mandate);
    }

    /// @notice The mandate bytes the operator's ML-DSA-87 key signs to approve
    ///         one specific payment. Domain-separated, replay-safe.
    function mandateMessage(uint256 invoiceId, address vendor, uint256 amount, uint64 expiry)
        public
        view
        returns (bytes memory)
    {
        return abi.encodePacked(
            "sentinel-mandate-v1\n",
            "chain: ", uint64(block.chainid), "\n",
            "vault: ", address(this), "\n",
            "invoice: ", invoiceId, "\n",
            "vendor: ", vendor, "\n",
            "amount: ", amount, "\n",
            "expiry: ", expiry
        );
    }

    /// @dev Verifies `signature` over `message` with the operator's
    ///      chain-registered ML-DSA-87 key (fetched on chain, not supplied).
    function _verifyOperatorMandate(bytes memory message, bytes memory signature) internal view returns (bool) {
        (bool registered,, bytes memory pubkey, bool proven) = PQC_STATUS.pqcKeyStatus(operator);
        if (!registered || !proven) return false;
        return PQC_VERIFY.pqcVerify(pubkey, signature, message);
    }

    function _requireOperatorPqc() internal view {
        (bool registered,,, bool proven) = PQC_STATUS.pqcKeyStatus(operator);
        if (!registered || !proven) revert OperatorPqcKeyMissing();
    }

    function _refuse(uint256 invoiceId, address vendor, uint256 amount, string memory reason) internal {
        emit PaymentRefused(invoiceId, vendor, amount, reason);
    }
}
