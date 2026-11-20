// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice A token that tries to re-enter the vault from `transfer`, to prove the vault is reentrancy-safe.
interface IReenter {
    function onTokenTransfer() external;
}

contract EvilToken is ERC20 {
    address public target;

    constructor() ERC20("Evil", "EVIL") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setTarget(address t) external {
        target = t;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (target != address(0) && from == target) {
            address t = target;
            target = address(0); // one shot
            IReenter(to).onTokenTransfer();
            target = t;
        }
    }
}
