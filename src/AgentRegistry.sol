// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import {IAgentRegistry} from "./interfaces/IAgentRegistry.sol";

/// @title AgentRegistry
/// @notice ERC-8004-shaped agent identity (an ERC-721 per agent, an `agentURI` pointing at its agent card,
///         key/value metadata and a verified `agentWallet`) plus **receipt-bound feedback**: only a merchant
///         that was actually paid by the agent, through a Warrant vault, can rate it, once per payment.
/// @dev QDay's official ERC-8004 registries are not open for the Builder Challenge, so this is our own
///      deployment that follows the ERC-8004 identity interface (`register`, `setAgentURI`, `setMetadata`,
///      `getMetadata`, `setAgentWallet`, `getAgentWallet`) and the reputation vocabulary (`value`,
///      `valueDecimals`, `tag1`, `tag2`, feedback URI + hash). Feedback differs on purpose: instead of
///      "any address may give feedback to any agent" (trivially sybil-able) it is gated by a verified receipt.
///      Swap-in note: when an official registry opens, vaults only need `getAgentWallet` and receipts.
contract AgentRegistry is ERC721, EIP712, IAgentRegistry {
    /*//////////////////////////////////////////////////////////////
                                 TYPES
    //////////////////////////////////////////////////////////////*/

    struct MetadataEntry {
        string metadataKey;
        bytes metadataValue;
    }

    struct Receipt {
        uint256 agentId;
        address vault;
        address merchant;
        uint128 amount;
        uint48 paidAt;
        bytes32 invoiceRef;
        bool exists;
    }

    struct Feedback {
        int128 value;
        uint8 valueDecimals;
        bool given;
        bool revoked;
        uint48 at;
        string tag1;
        string tag2;
        string feedbackURI;
        bytes32 feedbackHash;
    }

    struct Summary {
        uint64 feedbackCount; // active (non revoked) feedback entries
        int256 valueSum; // sum of values normalised to 18 decimals
        uint64 paymentCount; // receipts recorded
        uint256 verifiedVolume; // sum of receipt amounts, in the payment token's units
    }

    /*//////////////////////////////////////////////////////////////
                                CONSTANTS
    //////////////////////////////////////////////////////////////*/

    bytes32 public constant AGENT_WALLET_TYPEHASH =
        keccak256("AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)");
    bytes32 internal constant AGENT_WALLET_KEY = keccak256("agentWallet");
    uint256 public constant MAX_URI_LENGTH = 2048;
    uint8 public constant MAX_VALUE_DECIMALS = 18;

    /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

    address public immutable deployer;
    address public factory; // the only caller of `registerVault`, set once
    uint256 public totalAgents;

    mapping(address => bool) public override isVault;
    mapping(uint256 agentId => string) private _agentURI;
    mapping(uint256 agentId => address) private _agentWallet;
    mapping(uint256 agentId => mapping(bytes32 keyHash => bytes)) private _metadata;
    mapping(bytes32 receiptId => Receipt) private _receipts;
    mapping(bytes32 receiptId => Feedback) private _feedback;
    mapping(uint256 agentId => Summary) private _summary;

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy);
    event MetadataSet(uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue);
    event AgentWalletSet(uint256 indexed agentId, address indexed newWallet);
    event FactorySet(address indexed factory);
    event VaultRegistered(address indexed vault);
    event ReceiptRecorded(
        bytes32 indexed receiptId,
        uint256 indexed agentId,
        address indexed merchant,
        address vault,
        uint256 amount,
        bytes32 invoiceRef
    );
    event NewFeedback(
        uint256 indexed agentId,
        address indexed client,
        bytes32 indexed receiptId,
        int128 value,
        uint8 valueDecimals,
        string tag1,
        string tag2,
        string feedbackURI,
        bytes32 feedbackHash
    );
    event FeedbackRevoked(uint256 indexed agentId, address indexed client, bytes32 indexed receiptId);

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error NotAgentOwner();
    error AgentNotFound();
    error ReservedMetadataKey();
    error UriTooLong();
    error FactoryAlreadySet();
    error NotDeployer();
    error NotFactory();
    error NotVault();
    error SignatureExpired();
    error InvalidWalletProof();
    error ReceiptExists();
    error ReceiptNotFound();
    error NotReceiptMerchant();
    error FeedbackAlreadyGiven();
    error FeedbackNotActive();
    error SelfFeedback();
    error InvalidDecimals();
    error ZeroAddress();

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor() ERC721("Warrant Agent", "AGENT") EIP712("WarrantAgentRegistry", "1") {
        deployer = msg.sender;
    }

    /// @notice One-time wiring: the deployer names the factory whose vaults may record receipts.
    function setFactory(address factory_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (factory != address(0)) revert FactoryAlreadySet();
        if (factory_ == address(0)) revert ZeroAddress();
        factory = factory_;
        emit FactorySet(factory_);
    }

    /// @inheritdoc IAgentRegistry
    function registerVault(address vault) external override {
        if (msg.sender != factory) revert NotFactory();
        isVault[vault] = true;
        emit VaultRegistered(vault);
    }

    /*//////////////////////////////////////////////////////////////
                           IDENTITY (ERC-8004-SHAPED)
    //////////////////////////////////////////////////////////////*/

    function register() external returns (uint256 agentId) {
        agentId = _register("");
    }

    function register(string calldata agentURI) external returns (uint256 agentId) {
        agentId = _register(agentURI);
    }

    function register(string calldata agentURI, MetadataEntry[] calldata metadata)
        external
        returns (uint256 agentId)
    {
        agentId = _register(agentURI);
        for (uint256 i; i < metadata.length; ++i) {
            _setMetadata(agentId, metadata[i].metadataKey, metadata[i].metadataValue);
        }
    }

    function setAgentURI(uint256 agentId, string calldata newURI) external {
        _requireAgentOwner(agentId);
        if (bytes(newURI).length > MAX_URI_LENGTH) revert UriTooLong();
        _agentURI[agentId] = newURI;
        emit URIUpdated(agentId, newURI, msg.sender);
    }

    function setMetadata(uint256 agentId, string calldata metadataKey, bytes calldata metadataValue) external {
        _requireAgentOwner(agentId);
        _setMetadata(agentId, metadataKey, metadataValue);
    }

    function getMetadata(uint256 agentId, string calldata metadataKey) external view returns (bytes memory) {
        _requireExists(agentId);
        if (keccak256(bytes(metadataKey)) == AGENT_WALLET_KEY) return abi.encodePacked(_agentWallet[agentId]);
        return _metadata[agentId][keccak256(bytes(metadataKey))];
    }

    /// @notice Bind a signing wallet to the agent. The new wallet proves control with an EIP-712 signature
    ///         (EOA or ERC-1271), so nobody can attach a wallet they don't control.
    function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature)
        external
    {
        _requireAgentOwner(agentId);
        if (block.timestamp > deadline) revert SignatureExpired();
        if (newWallet == address(0)) revert ZeroAddress();
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(AGENT_WALLET_TYPEHASH, agentId, newWallet, ownerOf(agentId), deadline))
        );
        if (!SignatureChecker.isValidSignatureNow(newWallet, digest, signature)) revert InvalidWalletProof();
        _agentWallet[agentId] = newWallet;
        emit AgentWalletSet(agentId, newWallet);
    }

    function unsetAgentWallet(uint256 agentId) external {
        _requireAgentOwner(agentId);
        delete _agentWallet[agentId];
        emit AgentWalletSet(agentId, address(0));
    }

    /// @inheritdoc IAgentRegistry
    function getAgentWallet(uint256 agentId) external view override returns (address) {
        return _agentWallet[agentId];
    }

    function agentURI(uint256 agentId) external view returns (string memory) {
        _requireExists(agentId);
        return _agentURI[agentId];
    }

    function tokenURI(uint256 agentId) public view override returns (string memory) {
        _requireOwned(agentId);
        return _agentURI[agentId];
    }

    /*//////////////////////////////////////////////////////////////
                      RECEIPTS AND RECEIPT-BOUND FEEDBACK
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAgentRegistry
    function recordReceipt(uint256 agentId, address merchant, uint256 amount, bytes32 invoiceRef)
        external
        override
        returns (bytes32 receiptId)
    {
        if (!isVault[msg.sender]) revert NotVault();
        if (_ownerOf(agentId) == address(0)) revert AgentNotFound();
        receiptId = receiptIdOf(msg.sender, merchant, invoiceRef);
        if (_receipts[receiptId].exists) revert ReceiptExists();
        _receipts[receiptId] = Receipt({
            agentId: agentId,
            vault: msg.sender,
            merchant: merchant,
            amount: uint128(amount),
            paidAt: uint48(block.timestamp),
            invoiceRef: invoiceRef,
            exists: true
        });
        Summary storage s = _summary[agentId];
        s.paymentCount += 1;
        s.verifiedVolume += amount;
        emit ReceiptRecorded(receiptId, agentId, merchant, msg.sender, amount, invoiceRef);
    }

    /// @notice The paid merchant rates the agent for that one payment. `value` is a signed fixed-point number
    ///         with `valueDecimals` decimals (for example 87 with 0 decimals for "87/100").
    function giveFeedback(
        bytes32 receiptId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external {
        Receipt storage r = _receipts[receiptId];
        if (!r.exists) revert ReceiptNotFound();
        if (msg.sender != r.merchant) revert NotReceiptMerchant();
        Feedback storage f = _feedback[receiptId];
        if (f.given) revert FeedbackAlreadyGiven();
        if (valueDecimals > MAX_VALUE_DECIMALS) revert InvalidDecimals();
        if (bytes(feedbackURI).length > MAX_URI_LENGTH) revert UriTooLong();
        // A merchant that is the agent's own owner or wallet can't rate it: no self-dealing.
        if (r.merchant == _ownerOf(r.agentId) || r.merchant == _agentWallet[r.agentId]) revert SelfFeedback();

        f.value = value;
        f.valueDecimals = valueDecimals;
        f.given = true;
        f.at = uint48(block.timestamp);
        f.tag1 = tag1;
        f.tag2 = tag2;
        f.feedbackURI = feedbackURI;
        f.feedbackHash = feedbackHash;

        Summary storage s = _summary[r.agentId];
        s.feedbackCount += 1;
        s.valueSum += _normalise(value, valueDecimals);
        emit NewFeedback(r.agentId, msg.sender, receiptId, value, valueDecimals, tag1, tag2, feedbackURI, feedbackHash);
    }

    function revokeFeedback(bytes32 receiptId) external {
        Receipt storage r = _receipts[receiptId];
        if (!r.exists) revert ReceiptNotFound();
        if (msg.sender != r.merchant) revert NotReceiptMerchant();
        Feedback storage f = _feedback[receiptId];
        if (!f.given || f.revoked) revert FeedbackNotActive();
        f.revoked = true;
        Summary storage s = _summary[r.agentId];
        s.feedbackCount -= 1;
        s.valueSum -= _normalise(f.value, f.valueDecimals);
        emit FeedbackRevoked(r.agentId, msg.sender, receiptId);
    }

    function receiptIdOf(address vault, address merchant, bytes32 invoiceRef) public pure returns (bytes32) {
        return keccak256(abi.encode(vault, merchant, invoiceRef));
    }

    function getReceipt(bytes32 receiptId) external view returns (Receipt memory) {
        return _receipts[receiptId];
    }

    function readFeedback(bytes32 receiptId) external view returns (Feedback memory) {
        return _feedback[receiptId];
    }

    /// @return feedbackCount active feedback entries
    /// @return averageValue average feedback value with 18 decimals (0 if none)
    /// @return paymentCount verified payments received by the agent
    /// @return verifiedVolume verified volume paid to merchants by the agent
    function getSummary(uint256 agentId)
        external
        view
        returns (uint64 feedbackCount, int256 averageValue, uint64 paymentCount, uint256 verifiedVolume)
    {
        Summary storage s = _summary[agentId];
        feedbackCount = s.feedbackCount;
        averageValue = feedbackCount == 0 ? int256(0) : s.valueSum / int256(uint256(feedbackCount));
        paymentCount = s.paymentCount;
        verifiedVolume = s.verifiedVolume;
    }

    /*//////////////////////////////////////////////////////////////
                               INTERNALS
    //////////////////////////////////////////////////////////////*/

    function _register(string memory uri) internal returns (uint256 agentId) {
        if (bytes(uri).length > MAX_URI_LENGTH) revert UriTooLong();
        agentId = ++totalAgents;
        // Effects before the mint: `_safeMint` calls `onERC721Received` on contract receivers.
        _agentURI[agentId] = uri;
        _agentWallet[agentId] = msg.sender;
        _safeMint(msg.sender, agentId);
        emit Registered(agentId, uri, msg.sender);
        emit AgentWalletSet(agentId, msg.sender);
    }

    function _setMetadata(uint256 agentId, string memory key, bytes memory value) internal {
        bytes32 h = keccak256(bytes(key));
        if (h == AGENT_WALLET_KEY) revert ReservedMetadataKey();
        _metadata[agentId][h] = value;
        emit MetadataSet(agentId, key, key, value);
    }

    function _requireAgentOwner(uint256 agentId) internal view {
        address o = _ownerOf(agentId);
        if (o == address(0)) revert AgentNotFound();
        if (!_isAuthorized(o, msg.sender, agentId)) revert NotAgentOwner();
    }

    function _requireExists(uint256 agentId) internal view {
        if (_ownerOf(agentId) == address(0)) revert AgentNotFound();
    }

    function _normalise(int128 value, uint8 decimals) internal pure returns (int256) {
        return int256(value) * int256(10 ** (MAX_VALUE_DECIMALS - decimals));
    }

    /// @dev A transferred agent starts over: the wallet binding is cleared (as ERC-8004 specifies).
    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = super._update(to, tokenId, auth);
        if (from != address(0) && to != address(0)) {
            delete _agentWallet[tokenId];
            emit AgentWalletSet(tokenId, address(0));
        }
    }
}
