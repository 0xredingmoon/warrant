// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IWarrantVault
/// @notice Types, events and errors of a Warrant vault. A vault holds a user's stablecoins and lets AI
///         agents spend them only inside signed, capped, expiring, revocable mandates.
interface IWarrantVault {
    /*//////////////////////////////////////////////////////////////
                                  TYPES
    //////////////////////////////////////////////////////////////*/

    /// @notice Why a payment can't (or can't yet) go through. Returned by `check`, carried by `PaymentRejected`.
    enum Reason {
        Ok, // would execute immediately
        ApprovalRequired, // valid, but at or above the co-sign threshold: it will be queued for the owner
        MandateNotFound,
        MandateRevoked,
        VaultFrozen,
        NotYetValid,
        MandateExpired,
        MerchantNotAllowed,
        ZeroAmount,
        ExceedsPerTxCap,
        ExceedsMerchantPerTxCap,
        ExceedsPeriodCap,
        ExceedsMerchantTotalCap,
        ExceedsTotalCap,
        InvoiceAlreadyUsed,
        IntentExpired,
        NonceUsed,
        BadSignature,
        InsufficientBalance
    }

    enum InvoiceState {
        None,
        Pending,
        Paid
    }

    enum PendingStatus {
        None,
        Open,
        Approved,
        Rejected,
        Expired
    }

    /// @notice What the owner grants an agent. Immutable after creation (create a new mandate to change it).
    struct MandateParams {
        address agent; // signing key: EOA or ERC-1271 contract
        uint256 agentId; // optional AgentRegistry identity (0 = none); the registry's wallet must equal `agent`
        uint128 perTxCap; // max per single payment
        uint128 periodCap; // max per fixed window of `periodLength` seconds, windows start at `validAfter`
        uint128 totalCap; // max over the whole life of the mandate
        uint32 periodLength; // seconds
        uint48 validAfter; // not usable before
        uint48 expiry; // not usable at or after
        uint128 approvalThreshold; // payments >= this need owner co-sign (0 = never)
        uint32 approvalWindow; // seconds the owner has to approve a queued payment (required if threshold > 0)
    }

    /// @notice Per-merchant rule inside a mandate. Merchants are an allowlist: not listed means not payable.
    struct MerchantRule {
        bool allowed;
        uint128 perTxCap; // 0 = no extra per-payment cap
        uint128 totalCap; // 0 = no extra lifetime cap for this merchant
    }

    struct Mandate {
        MandateParams params;
        uint128 spentTotal;
        uint128 periodSpent; // spent in window `periodIndex`
        uint64 periodIndex;
        bool revoked;
    }

    /// @notice What the agent signs (EIP-712 `PaymentIntent`). Anyone may submit it together with the signature.
    struct PaymentIntent {
        uint256 mandateId;
        address merchant;
        uint256 amount; // gross amount that leaves the vault (token units)
        bytes32 invoiceRef; // merchant's invoice id; each (merchant, invoiceRef) can be paid once per vault
        bytes32 intentHash; // hash of the agent's prompt/context/decision, kept on-chain for forensics
        bytes32 nonce; // random, single use per mandate
        uint256 deadline; // last timestamp at which this intent may be submitted
    }

    struct Pending {
        uint256 mandateId;
        address merchant;
        uint128 amount;
        uint48 createdAt;
        uint48 expiresAt;
        PendingStatus status;
        bytes32 invoiceRef;
        bytes32 intentHash;
    }

    /*//////////////////////////////////////////////////////////////
                                  EVENTS
    //////////////////////////////////////////////////////////////*/

    event MandateCreated(
        uint256 indexed mandateId, address indexed agent, uint256 indexed agentId, MandateParams params
    );
    event MerchantRuleSet(
        uint256 indexed mandateId, address indexed merchant, bool allowed, uint128 perTxCap, uint128 totalCap
    );
    event MandateRevoked(uint256 indexed mandateId, address indexed by);
    event VaultFrozen(address indexed by);
    event VaultUnfrozen(address indexed by);
    event GuardianSet(address indexed guardian);
    event NonceInvalidated(uint256 indexed mandateId, bytes32 indexed nonce, address indexed by);
    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);

    event PaymentExecuted(
        uint256 indexed mandateId,
        address indexed merchant,
        bytes32 indexed invoiceRef,
        address agent,
        uint256 amount,
        uint256 fee,
        bytes32 intentHash,
        bytes32 receiptId
    );
    event PaymentQueued(
        uint256 indexed pendingId,
        uint256 indexed mandateId,
        address indexed merchant,
        bytes32 invoiceRef,
        uint256 amount,
        bytes32 intentHash,
        uint48 expiresAt
    );
    event PendingApproved(uint256 indexed pendingId, address indexed by);
    event PendingRejected(uint256 indexed pendingId, address indexed by);
    event PendingExpired(uint256 indexed pendingId);
    /// @notice The registry refused or failed to record a receipt. The payment itself still went through.
    event ReceiptNotRecorded(uint256 indexed mandateId, bytes32 indexed invoiceRef);

    /*//////////////////////////////////////////////////////////////
                                  ERRORS
    //////////////////////////////////////////////////////////////*/

    error Unauthorized();
    error ZeroAddress();
    error InvalidCaps();
    error InvalidTimeWindow();
    error InvalidApproval();
    error NoMerchants();
    error TooManyMerchants();
    error LengthMismatch();
    error IdentityMismatch();
    error UnknownMandate();
    error PaymentRejected(Reason reason);
    error PendingNotOpen();
    error PendingStillOpen();
    error PendingWindowClosed();
    error SignatureExpired();
    error CannotRescueVaultToken();
}
