// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {AgentRegistry} from "../src/AgentRegistry.sol";
import {WarrantFactory} from "../src/WarrantFactory.sol";
import {IAgentRegistry} from "../src/interfaces/IAgentRegistry.sol";

/// @notice Deploys AgentRegistry and WarrantFactory to Aevum testnet (chain 44005) and wires them together.
/// @dev Env: DEPLOYER_PRIVATE_KEY (required, testnet-only key), TUSD8 (default: the Aevum tUSD8),
///      TREASURY (default: deployer), FEE_BPS (default 10 = 0.10%, hard cap 100).
///      Dry run:   forge script script/Deploy.s.sol --rpc-url aevum --legacy
///      Broadcast: forge script script/Deploy.s.sol --rpc-url aevum --legacy --broadcast
///      Aevum uses legacy (type 0) transactions and the Shanghai EVM (see foundry.toml).
contract Deploy is Script {
    address internal constant AEVUM_TUSD8 = 0x456569838f1d43009A91ebA4263147Afd7233483;

    function run() external returns (AgentRegistry registry, WarrantFactory factory) {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address token = vm.envOr("TUSD8", AEVUM_TUSD8);
        address treasury = vm.envOr("TREASURY", deployer);
        uint16 feeBps = uint16(vm.envOr("FEE_BPS", uint256(10)));

        vm.startBroadcast(pk);
        registry = new AgentRegistry();
        factory =
            new WarrantFactory(IERC20(token), IAgentRegistry(address(registry)), deployer, treasury, feeBps);
        registry.setFactory(address(factory));
        vm.stopBroadcast();

        console.log("chainid        ", block.chainid);
        console.log("deployer       ", deployer);
        console.log("tUSD8          ", token);
        console.log("AgentRegistry  ", address(registry));
        console.log("WarrantFactory ", address(factory));
        console.log("fee bps        ", feeBps);
        console.log("treasury       ", treasury);
    }
}
