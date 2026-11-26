// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {WarrantFactory} from "../src/WarrantFactory.sol";
import {WarrantVault} from "../src/WarrantVault.sol";
import {IWarrantVault} from "../src/interfaces/IWarrantVault.sol";

/// @title DemoAttackVault
/// @notice Deploys the small vault behind the dashboard's "Try the attack" panel.
///
///         The owner is DEMO_OWNER. It deploys one vault, deposits a little tUSD8 and issues one narrow mandate to
///         the demonstration's agent: one allowed merchant, 2.00 tUSD8 per payment, 10.00 per day, 50.00 in total,
///         no owner-approval threshold (an approving owner would make the demonstration look staged), 180 days.
///
///         That shape is what makes the two attacks unambiguous: 250.00 to the allowed merchant is above the
///         2.00 per-payment cap, and 0.01 to anyone else is off the allowlist. Neither can ever succeed, so the
///         demonstration cannot be drained, and re-running it costs only the relayer's gas.
///
///         Run once per chain. Everything it needs comes from the environment, and the private key is never printed.
///
/// usage:
///   set -a; . ./.env; set +a
///   forge script script/DemoAttackVault.s.sol --rpc-url aevum --legacy --broadcast
/// required env: DEMO_PRIVATE_KEY (pays gas, owns the vault), DEMO_AGENT_ADDRESS, DEMO_MERCHANT_ADDRESS
/// optional env: FACTORY_ADDRESS, TUSD8, DEMO_OWNER (defaults to the signer), DEMO_DEPOSIT (default "5")
contract DemoAttackVault is Script {
    /// 2.00 tUSD8: the per-payment cap the overspend attack exceeds
    uint128 internal constant PER_TX_CAP = 2_000_000;
    /// 10.00 tUSD8: the per-period cap
    uint128 internal constant PERIOD_CAP = 10_000_000;
    /// 50.00 tUSD8: the lifetime cap
    uint128 internal constant TOTAL_CAP = 50_000_000;

    function run() external {
        uint256 pk = vm.envUint("DEMO_PRIVATE_KEY");
        address signer = vm.addr(pk);
        address factory = vm.envOr("FACTORY_ADDRESS", address(0x66687369d9C683aaaaDAe98b747b63eE7e0662E3));
        address token = vm.envOr("TUSD8", address(0x456569838f1d43009A91ebA4263147Afd7233483));
        address owner = vm.envOr("DEMO_OWNER", signer);
        address agent = vm.envAddress("DEMO_AGENT_ADDRESS");
        address merchant = vm.envAddress("DEMO_MERCHANT_ADDRESS");
        uint256 deposit = vm.envOr("DEMO_DEPOSIT", uint256(5)) * 1e6;

        require(owner == signer, "DEMO_OWNER must be the signing key: createVault sets msg.sender as owner");
        require(agent != address(0) && merchant != address(0), "agent and merchant are required");

        // a faucet hands out a fixed amount, and it may be less than DEMO_DEPOSIT: fund with what is actually there
        // rather than refusing. The vault only has to hold more than the off-list attack's amount, which is tiny.
        uint256 available = IERC20(token).balanceOf(signer);
        if (available == 0) {
            revert("the signer holds no tUSD8: claim it from faucet.qday.info first");
        }
        if (available < deposit) {
            console.log("held less than DEMO_DEPOSIT; using the whole balance instead", available);
            deposit = available;
        }

        vm.startBroadcast(pk);

        address vault = WarrantFactory(factory).createVault(address(0), keccak256("warrant-demo-attack"));

        IERC20(token).approve(vault, deposit);
        WarrantVault(vault).deposit(deposit);

        uint48 now = uint48(block.timestamp);
        IWarrantVault.MandateParams memory p = IWarrantVault.MandateParams({
            agent: agent,
            agentId: 0,
            perTxCap: PER_TX_CAP,
            periodCap: PERIOD_CAP,
            totalCap: TOTAL_CAP,
            periodLength: 1 days,
            validAfter: now,
            expiry: now + 180 days,
            approvalThreshold: 0,
            approvalWindow: 0
        });
        address[] memory merchants = new address[](1);
        merchants[0] = merchant;
        IWarrantVault.MerchantRule[] memory rules = new IWarrantVault.MerchantRule[](1);
        rules[0] = IWarrantVault.MerchantRule({allowed: true, perTxCap: 0, totalCap: 0});
        WarrantVault(vault).createMandate(p, merchants, rules);

        vm.stopBroadcast();

        console.log("vault                     ", vault);
        console.log("owner                     ", owner);
        console.log("agent                     ", agent);
        console.log("allowed merchant          ", merchant);
        console.log("deposited tUSD8 (6dp)     ", deposit);
        console.log("mandate id                ", WarrantVault(vault).mandateCount());
    }
}
