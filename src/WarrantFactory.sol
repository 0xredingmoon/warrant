// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {WarrantVault} from "./WarrantVault.sol";
import {IAgentRegistry} from "./interfaces/IAgentRegistry.sol";
import {IWarrantFactory} from "./interfaces/IWarrantFactory.sol";

/// @title WarrantFactory
/// @notice Deploys one `WarrantVault` per user at a predictable (CREATE2) address, tells the agent registry
///         about it, and holds the one piece of protocol policy: an optional fee that is **hard-capped at 1%**
///         and charged to the merchant out of each payment (users never pay it).
contract WarrantFactory is IWarrantFactory, Ownable2Step {
    /// @notice Hard ceiling for the protocol fee: 100 bps = 1%. Not changeable.
    uint16 public constant MAX_FEE_BPS = 100;

    IERC20 public immutable token;
    IAgentRegistry public immutable registry;

    uint16 public feeBps;
    address public treasury;

    mapping(address owner => address[]) private _vaultsOf;
    mapping(address vault => bool) public isVault;
    uint256 public vaultCount;

    event VaultCreated(address indexed owner, address indexed vault, address indexed guardian, bytes32 salt);
    event FeeUpdated(uint16 feeBps, address treasury);

    error FeeTooHigh();
    error ZeroAddress();
    error TreasuryRequired();

    /// @param token_ stablecoin the vaults hold (tUSD8)
    /// @param registry_ agent registry (must call `setFactory(this)` after deployment)
    /// @param owner_ owner of the fee settings
    /// @param treasury_ fee recipient (address(0) with feeBps 0 = fee off)
    /// @param feeBps_ initial fee, <= MAX_FEE_BPS
    constructor(IERC20 token_, IAgentRegistry registry_, address owner_, address treasury_, uint16 feeBps_)
        Ownable(owner_)
    {
        if (address(token_) == address(0)) revert ZeroAddress();
        token = token_;
        registry = registry_;
        _setFee(feeBps_, treasury_);
    }

    /// @notice Create the caller's vault. `salt` lets one owner create several.
    /// @param guardian optional risk-reduction key (address(0) for none)
    function createVault(address guardian, bytes32 salt) external returns (address vault) {
        vault =
            address(new WarrantVault{salt: _salt(msg.sender, salt)}(token, msg.sender, guardian, registry));
        isVault[vault] = true;
        _vaultsOf[msg.sender].push(vault);
        ++vaultCount;
        if (address(registry) != address(0)) registry.registerVault(vault);
        emit VaultCreated(msg.sender, vault, guardian, salt);
    }

    /// @notice The address `createVault(guardian, salt)` will deploy to for `owner_`.
    function predictVault(address owner_, address guardian, bytes32 salt) external view returns (address) {
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(type(WarrantVault).creationCode, abi.encode(token, owner_, guardian, registry))
        );
        return address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(bytes1(0xff), address(this), _salt(owner_, salt), initCodeHash)
                    )
                )
            )
        );
    }

    function vaultsOf(address owner_) external view returns (address[] memory) {
        return _vaultsOf[owner_];
    }

    /// @inheritdoc IWarrantFactory
    function feeConfig() external view returns (uint16, address) {
        return (feeBps, treasury);
    }

    function setFee(uint16 feeBps_, address treasury_) external onlyOwner {
        _setFee(feeBps_, treasury_);
    }

    function _setFee(uint16 feeBps_, address treasury_) internal {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        if (feeBps_ != 0 && treasury_ == address(0)) revert TreasuryRequired();
        feeBps = feeBps_;
        treasury = treasury_;
        emit FeeUpdated(feeBps_, treasury_);
    }

    function _salt(address owner_, bytes32 salt) private pure returns (bytes32) {
        return keccak256(abi.encode(owner_, salt));
    }
}
