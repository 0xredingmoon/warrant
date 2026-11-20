// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The `receiveWithAuthorization` half of EIP-3009 (USDC-style signed transfers).
/// @dev tUSD8 on Aevum implements this. `receiveWithAuthorization` can only be submitted by the
///      payee (`to == msg.sender`), which stops anyone front-running the signature into a plain transfer.
interface IERC3009 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}
