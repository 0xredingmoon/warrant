// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {WarrantFactory} from "../src/WarrantFactory.sol";

/// @dev The deploy script runs end to end in-memory (no network, no real key).
contract DeployScriptTest is Test {
    function test_deployScript_wiresEverything() public {
        uint256 pk = uint256(keccak256("test deployer"));
        address deployer = vm.addr(pk);
        vm.setEnv("DEPLOYER_PRIVATE_KEY", vm.toString(bytes32(pk)));
        vm.setEnv("FEE_BPS", "10");
        vm.setEnv("TREASURY", vm.toString(address(0xBEEF)));
        (AgentRegistry registry, WarrantFactory factory) = new Deploy().run();

        assertEq(registry.factory(), address(factory));
        assertEq(address(factory.registry()), address(registry));
        assertEq(address(factory.token()), 0x456569838f1d43009A91ebA4263147Afd7233483);
        assertEq(factory.owner(), deployer);
        (uint16 bps, address t) = factory.feeConfig();
        assertEq(bps, 10);
        assertEq(t, address(0xBEEF));
    }
}
