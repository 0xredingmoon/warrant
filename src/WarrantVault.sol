// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IERC3009} from "./interfaces/IERC3009.sol";
import {IAgentRegistry} from "./interfaces/IAgentRegistry.sol";
import {IWarrantFactory} from "./interfaces/IWarrantFactory.sol";
import {IWarrantVault} from "./interfaces/IWarrantVault.sol";

/// @title WarrantVault
/// @notice A user's stablecoin vault for AI agents. The owner funds it and signs nothing the agent can
///         widen: the agent only ever holds a *mandate*, a narrow, capped, expiring, revocable permission to
///         pay allowlisted merchants. Every decision is an on-chain event.
/// @dev Trust model
///      - owner: full control (create/revoke mandates, withdraw, approve queued payments, unfreeze).
///      - guardian (optional): can only *reduce* risk (freeze the vault, revoke a mandate). Never move funds.
///      - agent: can only sign `PaymentIntent`s that satisfy every cap of its mandate. It has no gas and
///        no direct access to funds; anyone (a relayer, the merchant) may submit its signed intent.
///      - merchant: receives `amount - fee`. The protocol fee (capped in the factory) is charged to the merchant.
///      Spend window: `periodCap` bounds what is spent within ANY rolling `periodLength` seconds. Spending is
///      booked into 8 time buckets (ring of 9 slots); a payment is checked against every bucket that overlaps
///      the trailing window, so a spend counts for at least `periodLength` and at most `periodLength` plus one
///      bucket (`ceil(periodLength / 8)`) seconds. Proof sketch: take any window (a, a+L] and its last payment at
///      time t. At t the check counted every bucket overlapping (t-L, t], which contains every payment of the
///      window, and required the sum (including this payment) to stay <= periodCap.
///      Expiry is exclusive (`block.timestamp >= expiry` is expired).
contract WarrantVault is IWarrantVault, EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    bytes32 public constant PAYMENT_INTENT_TYPEHASH = keccak256(
        "PaymentIntent(uint256 mandateId,address merchant,uint256 amount,bytes32 invoiceRef,bytes32 intentHash,bytes32 nonce,uint256 deadline)"
    );
    bytes32 public constant APPROVE_PAYMENT_TYPEHASH =
        keccak256("ApprovePayment(uint256 pendingId,uint256 deadline)");

    uint256 public constant MAX_MANDATE_LIFETIME = 365 days;
    uint256 public constant MAX_MERCHANTS_PER_CALL = 32;
    uint256 public constant MAX_LOGGED_REFUSALS = 1_000;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant WINDOW_BUCKETS = 8;
    uint256 internal constant WINDOW_SLOTS = WINDOW_BUCKETS + 1;

    /*//////////////////////////////////////////////////////////////
                               IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    IERC20 public immutable token;
    address public immutable owner;
    address public immutable factory;
    IAgentRegistry public immutable registry; // may be address(0): identity binding disabled
    /// @notice Block this vault was created in: where an audit log read can start.
    uint256 public immutable createdAtBlock;

    /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

    address public guardian;
    bool public frozen;

    uint256 public mandateCount;
    uint256 public pendingCount;

    struct Bucket {
        uint128 amount; // spent in time bucket `index`
        uint64 index; // floor(timestamp / bucketSize)
    }

    mapping(uint256 mandateId => Mandate) internal _mandates;
    mapping(uint256 mandateId => Bucket[WINDOW_SLOTS]) internal _window;
    /// @notice Refusals logged on-chain for a mandate (bounded by `MAX_LOGGED_REFUSALS`).
    mapping(uint256 mandateId => uint256) public refusalCount;
    mapping(uint256 mandateId => mapping(address merchant => MerchantRule)) internal _rules;
    mapping(uint256 mandateId => mapping(address merchant => uint128)) public merchantSpent;
    mapping(uint256 mandateId => mapping(bytes32 nonce => bool)) public nonceUsed;
    mapping(bytes32 key => InvoiceState) internal _invoices; // key = keccak(merchant, invoiceRef)
    mapping(uint256 pendingId => Pending) internal _pending;

    /*//////////////////////////////////////////////////////////////
                               MODIFIERS
    //////////////////////////////////////////////////////////////*/

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlyOwnerOrGuardian() {
        if (msg.sender != owner && msg.sender != guardian) revert Unauthorized();
        _;
    }

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /// @param token_ the stablecoin this vault spends (tUSD8, 6 decimals, on Aevum)
    /// @param owner_ the human (or multisig) in control
    /// @param guardian_ optional risk-reduction key (address(0) for none)
    /// @param registry_ optional agent identity registry (address(0) for none)
    constructor(IERC20 token_, address owner_, address guardian_, IAgentRegistry registry_)
        EIP712("Warrant", "1")
    {
        if (address(token_) == address(0) || owner_ == address(0)) revert ZeroAddress();
        token = token_;
        owner = owner_;
        guardian = guardian_;
        registry = registry_;
        factory = msg.sender;
        createdAtBlock = block.number;
        emit GuardianSet(guardian_);
    }

    /*//////////////////////////////////////////////////////////////
                         FUNDING (OWNER OR ANYONE)
    //////////////////////////////////////////////////////////////*/

    /// @notice Deposit by allowance: the caller must have approved this vault.
    function deposit(uint256 amount) external nonReentrant {
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    /// @notice Gasless deposit with an EIP-3009 `ReceiveWithAuthorization` signed by `from` to this vault.
    /// @dev Anyone can relay it. The signer needs no native gas. The authorization nonce is chosen by the
    ///      signer and consumed by the token.
    function depositWithAuthorization(
        address from,
        uint256 amount,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        IERC3009(address(token))
            .receiveWithAuthorization(from, address(this), amount, validAfter, validBefore, nonce, v, r, s);
        emit Deposited(from, amount);
    }

    /// @notice Gasless deposit with an EIP-2612 permit signed by `from` for this vault as spender.
    /// @dev If the permit reverts (for example it was front-run), only `from` may continue on the allowance.
    function depositWithPermit(address from, uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        nonReentrant
    {
        try IERC20Permit(address(token)).permit(from, address(this), amount, deadline, v, r, s) {}
        catch {
            // The permit may have been front-run (so it can't be reused). Then only `from` itself may pull
            // on the existing allowance: a relayer must never spend someone's standing approval.
            if (msg.sender != from) revert Unauthorized();
        }
        token.safeTransferFrom(from, address(this), amount);
        emit Deposited(from, amount);
    }

    /*//////////////////////////////////////////////////////////////
                         OWNER: MANDATES AND FUNDS
    //////////////////////////////////////////////////////////////*/

    /// @notice Grant an agent a mandate. Returns its id (starting at 1).
    /// @dev Least privilege: caps must nest (perTx <= period <= total), the lifetime is bounded, and at
    ///      least one merchant must be listed. An unlisted merchant can never be paid.
    function createMandate(
        MandateParams calldata p,
        address[] calldata merchants,
        MerchantRule[] calldata rules
    ) external onlyOwner returns (uint256 mandateId) {
        if (p.agent == address(0)) revert ZeroAddress();
        if (p.perTxCap == 0 || p.perTxCap > p.periodCap || p.periodCap > p.totalCap) revert InvalidCaps();
        if (p.periodLength == 0) revert InvalidTimeWindow();
        if (p.expiry <= block.timestamp || p.expiry <= p.validAfter) revert InvalidTimeWindow();
        if (p.expiry - _max(p.validAfter, block.timestamp) > MAX_MANDATE_LIFETIME) {
            revert InvalidTimeWindow();
        }
        if (p.approvalThreshold != 0) {
            if (p.approvalThreshold > p.perTxCap || p.approvalWindow == 0) revert InvalidApproval();
        }
        if (merchants.length == 0) revert NoMerchants();
        if (merchants.length > MAX_MERCHANTS_PER_CALL) revert TooManyMerchants();
        if (merchants.length != rules.length) revert LengthMismatch();
        if (p.agentId != 0) {
            if (address(registry) == address(0) || registry.getAgentWallet(p.agentId) != p.agent) {
                revert IdentityMismatch();
            }
        }

        mandateId = ++mandateCount;
        _mandates[mandateId].params = p;
        emit MandateCreated(mandateId, p.agent, p.agentId, p);
        for (uint256 i; i < merchants.length; ++i) {
            _setMerchantRule(mandateId, merchants[i], rules[i]);
        }
    }

    /// @notice Add, change or remove (`allowed = false`) a merchant for a mandate.
    function setMerchantRule(uint256 mandateId, address merchant, MerchantRule calldata rule)
        external
        onlyOwner
    {
        if (_mandates[mandateId].params.agent == address(0)) revert UnknownMandate();
        _setMerchantRule(mandateId, merchant, rule);
    }

    /// @notice Instantly and permanently revoke a mandate. Queued payments under it can no longer be approved.
    function revokeMandate(uint256 mandateId) external onlyOwnerOrGuardian {
        Mandate storage m = _mandates[mandateId];
        if (m.params.agent == address(0)) revert UnknownMandate();
        m.revoked = true;
        emit MandateRevoked(mandateId, msg.sender);
    }

    /// @notice Panic switch: no payment of any mandate can execute or be approved until the owner unfreezes.
    function freezeAll() external onlyOwnerOrGuardian {
        frozen = true;
        emit VaultFrozen(msg.sender);
    }

    /// @notice Only the owner can lift a freeze (a compromised guardian can't undo it).
    function unfreeze() external onlyOwner {
        frozen = false;
        emit VaultUnfrozen(msg.sender);
    }

    function setGuardian(address newGuardian) external onlyOwner {
        guardian = newGuardian;
        emit GuardianSet(newGuardian);
    }

    /// @notice Owner or the mandate's agent can burn a nonce so a leaked, unsubmitted intent is useless.
    function invalidateNonce(uint256 mandateId, bytes32 nonce) external {
        Mandate storage m = _mandates[mandateId];
        if (m.params.agent == address(0)) revert UnknownMandate();
        if (msg.sender != owner && msg.sender != m.params.agent) revert Unauthorized();
        nonceUsed[mandateId][nonce] = true;
        emit NonceInvalidated(mandateId, nonce, msg.sender);
    }

    /// @notice Owner withdrawal. Works while frozen.
    function withdraw(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        token.safeTransfer(to, amount);
        emit Withdrawn(to, amount);
    }

    /// @notice Recover other tokens sent here by mistake. The vault's own token has `withdraw`.
    function rescueERC20(IERC20 other, address to, uint256 amount) external onlyOwner {
        if (other == token) revert CannotRescueVaultToken();
        other.safeTransfer(to, amount);
    }

    /*//////////////////////////////////////////////////////////////
                               PAYMENTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Submit an agent-signed intent. Anyone can call it (relayers, merchants, the agent itself).
    /// @return reason `Ok` if it executed, `ApprovalRequired` if it was queued for the owner.
    /// @return pendingId the queue id when queued, else 0.
    function pay(PaymentIntent calldata intent, bytes calldata agentSignature)
        external
        nonReentrant
        returns (Reason reason, uint256 pendingId)
    {
        reason = _check(intent, agentSignature);
        if (reason != Reason.Ok && reason != Reason.ApprovalRequired) revert PaymentRejected(reason);

        nonceUsed[intent.mandateId][intent.nonce] = true;

        if (reason == Reason.Ok) {
            _execute(intent.mandateId, intent.merchant, intent.amount, intent.invoiceRef, intent.intentHash);
        } else {
            pendingId = _queue(intent);
        }
    }

    /// @notice Like `pay`, but a payment the mandate's rules refuse is *recorded* instead of reverted: the call
    ///         succeeds, no funds move and `PaymentRefused` is emitted, so the refusal is visible on the explorer.
    /// @dev Griefing safety: the intent must carry the mandate agent's valid signature, be unexpired and unused
    ///      (otherwise it reverts like `pay`, logging nothing), so only the agent can cause an event. The nonce is
    ///      consumed, so one signed intent logs at most once. Per mandate at most `MAX_LOGGED_REFUSALS` are logged;
    ///      after that refusals revert as in `pay`.
    function payOrRefuse(PaymentIntent calldata intent, bytes calldata agentSignature)
        external
        nonReentrant
        returns (Reason reason, uint256 pendingId)
    {
        Mandate storage m = _mandates[intent.mandateId];
        if (m.params.agent == address(0)) revert PaymentRejected(Reason.MandateNotFound);
        if (block.timestamp > intent.deadline) revert PaymentRejected(Reason.IntentExpired);
        if (nonceUsed[intent.mandateId][intent.nonce]) revert PaymentRejected(Reason.NonceUsed);
        if (!SignatureChecker.isValidSignatureNow(m.params.agent, hashIntent(intent), agentSignature)) {
            revert PaymentRejected(Reason.BadSignature);
        }
        reason = _checkTerms(intent.mandateId, intent.merchant, intent.amount, intent.invoiceRef, false);
        nonceUsed[intent.mandateId][intent.nonce] = true;

        if (reason == Reason.Ok) {
            _execute(intent.mandateId, intent.merchant, intent.amount, intent.invoiceRef, intent.intentHash);
        } else if (reason == Reason.ApprovalRequired) {
            pendingId = _queue(intent);
        } else {
            uint256 n = refusalCount[intent.mandateId];
            if (n >= MAX_LOGGED_REFUSALS) revert RefusalLogFull();
            refusalCount[intent.mandateId] = n + 1;
            emit PaymentRefused(
                intent.mandateId,
                m.params.agent,
                intent.merchant,
                intent.amount,
                reason,
                intent.invoiceRef,
                intent.intentHash
            );
        }
    }

    /// @notice Owner approves a queued payment (the co-sign). It is re-validated against the mandate now.
    function approve(uint256 pendingId) external onlyOwner nonReentrant {
        _approve(pendingId, msg.sender);
    }

    /// @notice Same as `approve`, but with an owner EIP-712 `ApprovePayment` signature anyone can relay.
    function approveBySig(uint256 pendingId, uint256 deadline, bytes calldata ownerSignature)
        external
        nonReentrant
    {
        if (block.timestamp > deadline) revert SignatureExpired();
        bytes32 digest =
            _hashTypedDataV4(keccak256(abi.encode(APPROVE_PAYMENT_TYPEHASH, pendingId, deadline)));
        if (!SignatureChecker.isValidSignatureNow(owner, digest, ownerSignature)) revert Unauthorized();
        _approve(pendingId, owner);
    }

    /// @notice Owner, or the agent that asked, cancels a queued payment. The invoice becomes payable again.
    function reject(uint256 pendingId) external {
        Pending storage q = _pending[pendingId];
        if (q.status != PendingStatus.Open) revert PendingNotOpen();
        address agent = _mandates[q.mandateId].params.agent;
        if (msg.sender != owner && msg.sender != agent) revert Unauthorized();
        q.status = PendingStatus.Rejected;
        delete _invoices[_invoiceKey(q.merchant, q.invoiceRef)];
        emit PendingRejected(pendingId, msg.sender);
    }

    /// @notice Anyone can release an invoice whose approval window has closed.
    function expirePending(uint256 pendingId) external {
        Pending storage q = _pending[pendingId];
        if (q.status != PendingStatus.Open) revert PendingNotOpen();
        if (block.timestamp <= q.expiresAt) revert PendingStillOpen();
        q.status = PendingStatus.Expired;
        delete _invoices[_invoiceKey(q.merchant, q.invoiceRef)];
        emit PendingExpired(pendingId);
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice Dry-run a signed intent. Never reverts; the reason says exactly what would happen.
    function check(PaymentIntent calldata intent, bytes calldata agentSignature)
        external
        view
        returns (Reason)
    {
        return _check(intent, agentSignature);
    }

    /// @notice Dry-run the terms only (no signature, nonce or deadline). Handy for UIs and agents planning a spend.
    function checkTerms(uint256 mandateId, address merchant, uint256 amount, bytes32 invoiceRef)
        external
        view
        returns (Reason)
    {
        return _checkTerms(mandateId, merchant, amount, invoiceRef, false);
    }

    function getMandate(uint256 mandateId) external view returns (Mandate memory) {
        return _mandates[mandateId];
    }

    function getMerchantRule(uint256 mandateId, address merchant)
        external
        view
        returns (MerchantRule memory)
    {
        return _rules[mandateId][merchant];
    }

    function getPending(uint256 pendingId) external view returns (Pending memory) {
        return _pending[pendingId];
    }

    function invoiceState(address merchant, bytes32 invoiceRef) external view returns (InvoiceState) {
        return _invoices[_invoiceKey(merchant, invoiceRef)];
    }

    /// @notice The most the agent could pay a single merchant right now (ignores balance and approvals).
    function remainingAllowance(uint256 mandateId, address merchant) external view returns (uint256 amount) {
        Mandate storage m = _mandates[mandateId];
        MerchantRule memory r = _rules[mandateId][merchant];
        if (
            m.params.agent == address(0) || m.revoked || frozen || !r.allowed
                || block.timestamp < m.params.validAfter || block.timestamp >= m.params.expiry
        ) return 0;
        amount = m.params.perTxCap;
        if (r.perTxCap != 0) amount = _min(amount, r.perTxCap);
        amount = _min(amount, m.params.periodCap - _windowSpent(mandateId));
        amount = _min(amount, m.params.totalCap - m.spentTotal);
        if (r.totalCap != 0) amount = _min(amount, r.totalCap - merchantSpent[mandateId][merchant]);
    }

    /// @notice Spent within the trailing `periodLength` (bucket-conservative, see the contract notes).
    function periodSpent(uint256 mandateId) external view returns (uint256) {
        return _windowSpent(mandateId);
    }

    /// @notice When part of the window frees up: the oldest counted bucket's amount and the time it stops counting.
    function nextRelease(uint256 mandateId) external view returns (uint256 amount, uint256 releaseAt) {
        Mandate storage m = _mandates[mandateId];
        uint256 size = _bucketSize(m.params.periodLength);
        (uint256 lo, uint256 cur) = _windowRange(m.params.periodLength, size);
        Bucket[WINDOW_SLOTS] storage w = _window[mandateId];
        uint256 best = type(uint256).max;
        for (uint256 i; i < WINDOW_SLOTS; ++i) {
            Bucket memory b = w[i];
            if (b.amount != 0 && b.index >= lo && b.index <= cur && b.index < best) {
                best = b.index;
                amount = b.amount;
            }
        }
        if (best != type(uint256).max) releaseAt = (best + 1) * size + m.params.periodLength;
    }

    function balance() external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice The EIP-712 digest an agent must sign for `intent` on this vault.
    function hashIntent(PaymentIntent calldata intent) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    PAYMENT_INTENT_TYPEHASH,
                    intent.mandateId,
                    intent.merchant,
                    intent.amount,
                    intent.invoiceRef,
                    intent.intentHash,
                    intent.nonce,
                    intent.deadline
                )
            )
        );
    }

    /// @notice The EIP-712 digest the owner must sign to approve `pendingId` by signature.
    function hashApproval(uint256 pendingId, uint256 deadline) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(APPROVE_PAYMENT_TYPEHASH, pendingId, deadline)));
    }

    /*//////////////////////////////////////////////////////////////
                               INTERNALS
    //////////////////////////////////////////////////////////////*/

    function _setMerchantRule(uint256 mandateId, address merchant, MerchantRule memory rule) internal {
        if (merchant == address(0)) revert ZeroAddress();
        _rules[mandateId][merchant] = rule;
        emit MerchantRuleSet(mandateId, merchant, rule.allowed, rule.perTxCap, rule.totalCap);
    }

    function _check(PaymentIntent calldata intent, bytes calldata sig) internal view returns (Reason) {
        Mandate storage m = _mandates[intent.mandateId];
        if (m.params.agent == address(0)) return Reason.MandateNotFound;
        if (block.timestamp > intent.deadline) return Reason.IntentExpired;
        if (nonceUsed[intent.mandateId][intent.nonce]) return Reason.NonceUsed;
        if (!SignatureChecker.isValidSignatureNow(m.params.agent, hashIntent(intent), sig)) {
            return Reason.BadSignature;
        }
        return _checkTerms(intent.mandateId, intent.merchant, intent.amount, intent.invoiceRef, false);
    }

    /// @param executing true when re-validating a queued payment at approval time: skips the invoice
    ///        uniqueness check (the queue entry holds it) and the approval threshold (the owner is approving).
    function _checkTerms(
        uint256 mandateId,
        address merchant,
        uint256 amount,
        bytes32 invoiceRef,
        bool executing
    ) internal view returns (Reason) {
        Mandate storage m = _mandates[mandateId];
        if (m.params.agent == address(0)) return Reason.MandateNotFound;
        if (m.revoked) return Reason.MandateRevoked;
        if (frozen) return Reason.VaultFrozen;
        if (block.timestamp < m.params.validAfter) return Reason.NotYetValid;
        if (block.timestamp >= m.params.expiry) return Reason.MandateExpired;
        if (amount == 0) return Reason.ZeroAmount;

        MerchantRule memory r = _rules[mandateId][merchant];
        if (!r.allowed) return Reason.MerchantNotAllowed;
        if (amount > m.params.perTxCap) return Reason.ExceedsPerTxCap;
        if (r.perTxCap != 0 && amount > r.perTxCap) return Reason.ExceedsMerchantPerTxCap;
        if (amount + _windowSpent(mandateId) > m.params.periodCap) return Reason.ExceedsPeriodCap;
        if (r.totalCap != 0 && amount + merchantSpent[mandateId][merchant] > r.totalCap) {
            return Reason.ExceedsMerchantTotalCap;
        }
        if (amount + m.spentTotal > m.params.totalCap) return Reason.ExceedsTotalCap;

        if (!executing && _invoices[_invoiceKey(merchant, invoiceRef)] != InvoiceState.None) {
            return Reason.InvoiceAlreadyUsed;
        }
        if (token.balanceOf(address(this)) < amount) return Reason.InsufficientBalance;

        if (!executing && m.params.approvalThreshold != 0 && amount >= m.params.approvalThreshold) {
            return Reason.ApprovalRequired;
        }
        return Reason.Ok;
    }

    function _queue(PaymentIntent calldata intent) internal returns (uint256 pendingId) {
        Mandate storage m = _mandates[intent.mandateId];
        pendingId = ++pendingCount;
        uint48 expiresAt = uint48(block.timestamp + m.params.approvalWindow);
        _pending[pendingId] = Pending({
            mandateId: intent.mandateId,
            merchant: intent.merchant,
            amount: uint128(intent.amount), // bounded by perTxCap (uint128) in _checkTerms
            createdAt: uint48(block.timestamp),
            expiresAt: expiresAt,
            status: PendingStatus.Open,
            invoiceRef: intent.invoiceRef,
            intentHash: intent.intentHash
        });
        _invoices[_invoiceKey(intent.merchant, intent.invoiceRef)] = InvoiceState.Pending;
        emit PaymentQueued(
            pendingId,
            intent.mandateId,
            intent.merchant,
            intent.invoiceRef,
            intent.amount,
            intent.intentHash,
            expiresAt
        );
    }

    function _approve(uint256 pendingId, address by) internal {
        Pending storage q = _pending[pendingId];
        if (q.status != PendingStatus.Open) revert PendingNotOpen();
        if (block.timestamp > q.expiresAt) revert PendingWindowClosed();
        Reason r = _checkTerms(q.mandateId, q.merchant, q.amount, q.invoiceRef, true);
        if (r != Reason.Ok) revert PaymentRejected(r);
        q.status = PendingStatus.Approved;
        emit PendingApproved(pendingId, by);
        _execute(q.mandateId, q.merchant, q.amount, q.invoiceRef, q.intentHash);
    }

    function _execute(
        uint256 mandateId,
        address merchant,
        uint256 amount,
        bytes32 invoiceRef,
        bytes32 intentHash
    ) internal {
        Mandate storage m = _mandates[mandateId];

        // Effects: book the spend into the current time bucket and the lifetime counters.
        // Safe casts: amount <= perTxCap <= type(uint128).max, and each running total is capped by a uint128.
        _bookWindow(mandateId, amount);
        m.spentTotal += uint128(amount);
        merchantSpent[mandateId][merchant] += uint128(amount);
        _invoices[_invoiceKey(merchant, invoiceRef)] = InvoiceState.Paid;

        // Fee (charged to the merchant, bounded by the factory's hard cap).
        uint256 fee;
        address treasury;
        (uint16 feeBps, address t) = IWarrantFactory(factory).feeConfig();
        if (feeBps != 0 && t != address(0)) {
            treasury = t;
            fee = (amount * feeBps) / BPS;
        }

        // Interactions.
        token.safeTransfer(merchant, amount - fee);
        if (fee != 0) token.safeTransfer(treasury, fee);

        uint256 agentId = m.params.agentId;
        bytes32 receiptId = bytes32(0);
        if (agentId != 0) {
            try registry.recordReceipt(agentId, merchant, amount, invoiceRef) returns (bytes32 id) {
                receiptId = id;
            } catch {
                emit ReceiptNotRecorded(mandateId, invoiceRef);
            }
        }
        emit PaymentExecuted(
            mandateId, merchant, invoiceRef, m.params.agent, amount, fee, intentHash, receiptId
        );
    }

    /// @dev Bucket length in seconds: ceil(periodLength / WINDOW_BUCKETS), at least 1.
    function _bucketSize(uint256 periodLength) internal pure returns (uint256) {
        return (periodLength + WINDOW_BUCKETS - 1) / WINDOW_BUCKETS;
    }

    /// @dev Buckets with index in [lo, cur] overlap the trailing window (now - periodLength, now].
    function _windowRange(uint256 periodLength, uint256 size) internal view returns (uint256 lo, uint256 cur) {
        cur = block.timestamp / size;
        lo = block.timestamp >= periodLength ? (block.timestamp - periodLength) / size : 0;
    }

    function _windowSpent(uint256 mandateId) internal view returns (uint256 spent) {
        uint256 periodLength = _mandates[mandateId].params.periodLength;
        if (periodLength == 0) return 0;
        (uint256 lo, uint256 cur) = _windowRange(periodLength, _bucketSize(periodLength));
        Bucket[WINDOW_SLOTS] storage w = _window[mandateId];
        for (uint256 i; i < WINDOW_SLOTS; ++i) {
            Bucket memory b = w[i];
            if (b.amount != 0 && b.index >= lo && b.index <= cur) spent += b.amount;
        }
    }

    function _bookWindow(uint256 mandateId, uint256 amount) internal {
        uint256 cur = block.timestamp / _bucketSize(_mandates[mandateId].params.periodLength);
        Bucket storage b = _window[mandateId][cur % WINDOW_SLOTS];
        if (b.index != cur) {
            b.index = uint64(cur);
            b.amount = 0;
        }
        b.amount += uint128(amount); // <= periodCap (checked before booking), a uint128
    }

    function _invoiceKey(address merchant, bytes32 invoiceRef) internal pure returns (bytes32) {
        return keccak256(abi.encode(merchant, invoiceRef));
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }

    function _max(uint256 a, uint256 b) private pure returns (uint256) {
        return a > b ? a : b;
    }
}
