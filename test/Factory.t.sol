// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.t.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {WarrantFactory} from "../src/WarrantFactory.sol";
import {WarrantVault} from "../src/WarrantVault.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {IAgentRegistry} from "../src/interfaces/IAgentRegistry.sol";

contract FactoryTest is Base {
    function test_createVault_setsOwnerGuardianTokenRegistry() public view {
        assertEq(vault.owner(), ownerAddr);
        assertEq(vault.guardian(), guardian);
        assertEq(address(vault.token()), address(token));
        assertEq(address(vault.registry()), address(registry));
        assertEq(vault.factory(), address(factory));
        assertTrue(factory.isVault(address(vault)));
        assertTrue(registry.isVault(address(vault)));
        assertEq(factory.vaultCount(), 1);
        assertEq(factory.vaultsOf(ownerAddr).length, 1);
        assertEq(factory.vaultsOf(ownerAddr)[0], address(vault));
    }

    function test_createVault_emitsEvent() public {
        address predicted = factory.predictVault(agentAddr, address(0), bytes32(uint256(5)));
        vm.expectEmit(true, true, true, true, address(factory));
        emit WarrantFactory.VaultCreated(agentAddr, predicted, address(0), bytes32(uint256(5)));
        vm.prank(agentAddr);
        factory.createVault(address(0), bytes32(uint256(5)));
    }

    function test_predictVault_matchesDeployment() public {
        address predicted = factory.predictVault(ownerAddr, guardian, bytes32(uint256(42)));
        assertEq(predicted.code.length, 0);
        vm.prank(ownerAddr);
        address actual = factory.createVault(guardian, bytes32(uint256(42)));
        assertEq(actual, predicted);
    }

    function test_createVault_sameSaltTwiceReverts_differentSaltsOk() public {
        vm.startPrank(ownerAddr);
        factory.createVault(guardian, bytes32(uint256(1)));
        vm.expectRevert();
        factory.createVault(guardian, bytes32(uint256(1)));
        address v3 = factory.createVault(guardian, bytes32(uint256(2)));
        vm.stopPrank();
        assertEq(factory.vaultsOf(ownerAddr).length, 3);
        assertTrue(v3 != address(vault));
    }

    function test_vaultAddressesDifferPerOwner_noSquatting() public {
        // Same salt, different owner → different address: nobody can pre-deploy your vault address.
        address a = factory.predictVault(ownerAddr, guardian, bytes32(0));
        address b = factory.predictVault(agentAddr, guardian, bytes32(0));
        assertTrue(a != b);
    }

    function test_vaultOwnerIsAlwaysTheCreator() public {
        vm.prank(evil);
        WarrantVault v = WarrantVault(factory.createVault(address(0), bytes32(0)));
        assertEq(v.owner(), evil);
    }

    /*//////////////////////////// fee policy ////////////////////////////*/

    function test_fee_defaultsAndConfig() public view {
        (uint16 bps, address t) = factory.feeConfig();
        assertEq(bps, 0);
        assertEq(t, treasury);
    }

    function test_setFee_cappedAtOnePercent() public {
        factory.setFee(100, treasury); // max allowed
        (uint16 bps,) = factory.feeConfig();
        assertEq(bps, 100);
        vm.expectRevert(WarrantFactory.FeeTooHigh.selector);
        factory.setFee(101, treasury);
        assertEq(factory.MAX_FEE_BPS(), 100);
    }

    function test_setFee_needsTreasuryWhenNonZero() public {
        vm.expectRevert(WarrantFactory.TreasuryRequired.selector);
        factory.setFee(10, address(0));
        factory.setFee(0, address(0)); // fully off is fine
    }

    function test_setFee_onlyOwner() public {
        vm.prank(evil);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, evil));
        factory.setFee(10, evil);
    }

    function test_setFee_emits() public {
        vm.expectEmit(false, false, false, true, address(factory));
        emit WarrantFactory.FeeUpdated(25, treasury);
        factory.setFee(25, treasury);
    }

    function test_ownershipIsTwoStep() public {
        factory.transferOwnership(evil);
        assertEq(factory.owner(), address(this)); // not yet
        vm.prank(evil);
        factory.acceptOwnership();
        assertEq(factory.owner(), evil);
    }

    function test_constructor_checks() public {
        vm.expectRevert(WarrantFactory.ZeroAddress.selector);
        new WarrantFactory(IERC20(address(0)), IAgentRegistry(address(registry)), address(this), treasury, 0);
        vm.expectRevert(WarrantFactory.FeeTooHigh.selector);
        new WarrantFactory(token, IAgentRegistry(address(registry)), address(this), treasury, 101);
        vm.expectRevert(WarrantFactory.TreasuryRequired.selector);
        new WarrantFactory(token, IAgentRegistry(address(registry)), address(this), address(0), 5);
    }

    function test_factoryWithoutRegistry_stillWorks() public {
        WarrantFactory f = new WarrantFactory(token, IAgentRegistry(address(0)), address(this), treasury, 0);
        vm.prank(ownerAddr);
        WarrantVault v = WarrantVault(f.createVault(guardian, bytes32(0)));
        assertEq(address(v.registry()), address(0));
        assertTrue(f.isVault(address(v)));
    }

    function test_registryWiring_isOneShotAndDeployerOnly() public {
        AgentRegistry r = new AgentRegistry();
        vm.prank(evil);
        vm.expectRevert(AgentRegistry.NotDeployer.selector);
        r.setFactory(evil);
        vm.expectRevert(AgentRegistry.ZeroAddress.selector);
        r.setFactory(address(0));
        r.setFactory(address(factory));
        vm.expectRevert(AgentRegistry.FactoryAlreadySet.selector);
        r.setFactory(evil);
    }

    function test_registerVault_onlyFactory() public {
        vm.prank(evil);
        vm.expectRevert(AgentRegistry.NotFactory.selector);
        registry.registerVault(evil);
    }
}
