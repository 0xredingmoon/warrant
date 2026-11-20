// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IWarrantFactory {
    /// @notice Protocol fee in basis points and where it goes. Charged to the merchant, out of the payment.
    function feeConfig() external view returns (uint16 feeBps, address treasury);
}
