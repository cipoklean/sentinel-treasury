// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title InvoiceRegistry
/// @notice On-chain registry of payable invoices. Vendors submit their own
///         invoices; the operator may cancel any of them and a vendor may
///         cancel its own. The PolicyVault settles invoices when it executes
///         or finally rejects a payment.
contract InvoiceRegistry {
    enum Status {
        Pending,
        Paid,
        Rejected,
        Cancelled
    }

    struct Invoice {
        address payable vendor;
        uint256 amount;
        bytes32 ref;
        Status status;
        uint64 createdAt;
    }

    uint256 public nextId = 1;
    mapping(uint256 => Invoice) private _invoices;

    address public immutable operator;
    address public vault;

    event InvoiceSubmitted(uint256 indexed id, address indexed vendor, uint256 amount, bytes32 ref);
    event InvoiceCancelled(uint256 indexed id);
    event InvoiceSettled(uint256 indexed id, Status status);
    event VaultSet(address indexed vault);

    error NotOperator();
    error NotVault();
    error NotVendorOrOperator();
    error InvoiceNotPending(uint256 id);
    error VaultAlreadySet();
    error ZeroAmount();

    constructor() {
        operator = msg.sender;
    }

    /// @notice One-time wiring of the vault that may settle invoices.
    function setVault(address v) external {
        if (msg.sender != operator) revert NotOperator();
        if (vault != address(0)) revert VaultAlreadySet();
        vault = v;
        emit VaultSet(v);
    }

    function invoice(uint256 id) external view returns (Invoice memory) {
        return _invoices[id];
    }

    /// @notice A vendor submits an invoice for `amount` wei. `ref` is an
    ///         application-level reference (e.g. hash of the off-chain invoice).
    function submit(uint256 amount, bytes32 ref) external returns (uint256 id) {
        if (amount == 0) revert ZeroAmount();
        id = nextId++;
        _invoices[id] = Invoice(payable(msg.sender), amount, ref, Status.Pending, uint64(block.timestamp));
        emit InvoiceSubmitted(id, msg.sender, amount, ref);
    }

    /// @notice Cancel a pending invoice. The vendor or the operator may cancel.
    function cancel(uint256 id) external {
        Invoice storage inv = _invoices[id];
        if (inv.status != Status.Pending) revert InvoiceNotPending(id);
        if (msg.sender != inv.vendor && msg.sender != operator) revert NotVendorOrOperator();
        inv.status = Status.Cancelled;
        emit InvoiceCancelled(id);
    }

    /// @notice Settle a pending invoice. Callable by the vault (payment path)
    ///         or directly by the operator account (abstract-account rail).
    function settle(uint256 id, bool paid) external {
        if (msg.sender != vault && msg.sender != operator) revert NotVault();
        Invoice storage inv = _invoices[id];
        if (inv.status != Status.Pending) revert InvoiceNotPending(id);
        inv.status = paid ? Status.Paid : Status.Rejected;
        emit InvoiceSettled(id, inv.status);
    }
}
