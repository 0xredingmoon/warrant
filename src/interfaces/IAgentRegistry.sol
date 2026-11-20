// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The slice of the AgentRegistry that vaults and the factory talk to.
interface IAgentRegistry {
    /// @notice Called once by the factory for every vault it deploys.
    function registerVault(address vault) external;

    /// @notice Called by a registered vault after every executed payment made under a mandate that is
    ///         bound to an agent identity. Creates the receipt a merchant can later attach feedback to.
    function recordReceipt(uint256 agentId, address merchant, uint256 amount, bytes32 invoiceRef)
        external
        returns (bytes32 receiptId);

    /// @notice The wallet bound to `agentId`, or address(0) if the agent doesn't exist or has none.
    function getAgentWallet(uint256 agentId) external view returns (address);

    function isVault(address vault) external view returns (bool);
}
