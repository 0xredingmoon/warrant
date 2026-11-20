// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console} from "forge-std/console.sol";
import {Base} from "./Base.t.sol";
import {IWarrantVault} from "../src/interfaces/IWarrantVault.sol";
import {WarrantVault} from "../src/WarrantVault.sol";

/// @notice Measures the gas of the operations a user actually pays for and fails if one regresses.
///         Run `forge test --match-contract GasProfileTest -vv` for the table.
contract GasProfileTest is Base {
    function test_gasProfile() public {
        uint256 g;

        vm.prank(ownerAddr);
        g = gasleft();
        factory.createVault(guardian, bytes32(uint256(1)));
        g -= gasleft();
        console.log("WarrantFactory.createVault (deploys a vault):", g);
        assertLt(g, 4_200_000);

        uint256 id;
        {
            IWarrantVault.MandateParams memory p = _params();
            address[] memory ms = new address[](1);
            ms[0] = merchantA;
            IWarrantVault.MerchantRule[] memory rs = new IWarrantVault.MerchantRule[](1);
            rs[0] = _rule(true, 0, 0);
            vm.prank(ownerAddr);
            g = gasleft();
            id = vault.createMandate(p, ms, rs);
            g -= gasleft();
        }
        console.log("WarrantVault.createMandate (1 merchant):   ", g);
        assertLt(g, 330_000);

        IWarrantVault.PaymentIntent memory i = _intent(id, merchantA, 1 * USD, _ref(1));
        bytes memory sig = _sign(agentKey, i);
        vm.prank(relayer);
        g = gasleft();
        vault.pay(i, sig);
        g -= gasleft();
        console.log("WarrantVault.pay (first payment, cold):    ", g);
        assertLt(g, 260_000);

        i = _intent(id, merchantA, 1 * USD, _ref(2));
        sig = _sign(agentKey, i);
        vm.prank(relayer);
        g = gasleft();
        vault.pay(i, sig);
        g -= gasleft();
        console.log("WarrantVault.pay (warm):                   ", g);
        assertLt(g, 160_000);

        g = gasleft();
        vault.check(i, sig);
        g -= gasleft();
        console.log("WarrantVault.check (view):                 ", g);

        vm.prank(ownerAddr);
        g = gasleft();
        vault.revokeMandate(id);
        g -= gasleft();
        console.log("WarrantVault.revokeMandate:                ", g);
        assertLt(g, 60_000);

        vm.prank(guardian);
        g = gasleft();
        vault.freezeAll();
        g -= gasleft();
        console.log("WarrantVault.freezeAll:                    ", g);
        assertLt(g, 60_000);

        vm.prank(makeAddr("agentOwner"));
        g = gasleft();
        registry.register("ipfs://agent-card");
        g -= gasleft();
        console.log("AgentRegistry.register(uri):               ", g);
        assertLt(g, 200_000);
    }
}
