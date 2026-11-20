// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.t.sol";
import {IWarrantVault} from "../src/interfaces/IWarrantVault.sol";
import {WarrantVault} from "../src/WarrantVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract VaultMandatesTest is Base {
    function _createExpectRevert(IWarrantVault.MandateParams memory p, bytes4 sel) internal {
        address[] memory ms = new address[](1);
        ms[0] = merchantA;
        IWarrantVault.MerchantRule[] memory rs = new IWarrantVault.MerchantRule[](1);
        rs[0] = _rule(true, 0, 0);
        vm.prank(ownerAddr);
        vm.expectRevert(sel);
        vault.createMandate(p, ms, rs);
    }

    function test_createMandate_storesParamsAndEmits() public {
        IWarrantVault.MandateParams memory p = _params();
        vm.expectEmit(true, true, true, true, address(vault));
        emit IWarrantVault.MandateCreated(1, agentAddr, 0, p);
        vm.expectEmit(true, true, false, true, address(vault));
        emit IWarrantVault.MerchantRuleSet(1, merchantA, true, uint128(2 * USD), uint128(50 * USD));
        uint256 id = _create(p, merchantA, _rule(true, 2 * USD, 50 * USD));
        assertEq(id, 1);
        assertEq(vault.mandateCount(), 1);

        IWarrantVault.Mandate memory m = vault.getMandate(id);
        assertEq(m.params.agent, agentAddr);
        assertEq(m.params.perTxCap, 5 * USD);
        assertEq(m.params.periodCap, 20 * USD);
        assertEq(m.params.totalCap, 100 * USD);
        assertEq(m.params.expiry, T0 + 7 days);
        assertFalse(m.revoked);
        IWarrantVault.MerchantRule memory r = vault.getMerchantRule(id, merchantA);
        assertTrue(r.allowed);
        assertEq(r.perTxCap, 2 * USD);
    }

    function test_createMandate_incrementsIds() public {
        assertEq(_createDefault(), 1);
        assertEq(_createDefault(), 2);
    }

    function test_createMandate_onlyOwner() public {
        address[] memory ms = new address[](1);
        ms[0] = merchantA;
        IWarrantVault.MerchantRule[] memory rs = new IWarrantVault.MerchantRule[](1);
        rs[0] = _rule(true, 0, 0);
        IWarrantVault.MandateParams memory p = _params();
        vm.prank(agentAddr);
        vm.expectRevert(IWarrantVault.Unauthorized.selector);
        vault.createMandate(p, ms, rs);
        vm.prank(guardian);
        vm.expectRevert(IWarrantVault.Unauthorized.selector);
        vault.createMandate(p, ms, rs);
    }

    function test_createMandate_rejectsZeroAgent() public {
        IWarrantVault.MandateParams memory p = _params();
        p.agent = address(0);
        _createExpectRevert(p, IWarrantVault.ZeroAddress.selector);
    }

    function test_createMandate_rejectsBadCaps() public {
        IWarrantVault.MandateParams memory p = _params();
        p.perTxCap = 0;
        _createExpectRevert(p, IWarrantVault.InvalidCaps.selector);

        p = _params();
        p.perTxCap = p.periodCap + 1; // per-tx above period
        _createExpectRevert(p, IWarrantVault.InvalidCaps.selector);

        p = _params();
        p.periodCap = p.totalCap + 1; // period above total
        _createExpectRevert(p, IWarrantVault.InvalidCaps.selector);
    }

    function test_createMandate_rejectsBadTimeWindow() public {
        IWarrantVault.MandateParams memory p = _params();
        p.periodLength = 0;
        _createExpectRevert(p, IWarrantVault.InvalidTimeWindow.selector);

        p = _params();
        p.expiry = uint48(block.timestamp); // already expired
        _createExpectRevert(p, IWarrantVault.InvalidTimeWindow.selector);

        p = _params();
        p.validAfter = uint48(block.timestamp + 2 days);
        p.expiry = uint48(block.timestamp + 1 days); // expiry before start
        _createExpectRevert(p, IWarrantVault.InvalidTimeWindow.selector);

        p = _params();
        p.expiry = uint48(block.timestamp + 366 days); // lifetime too long
        _createExpectRevert(p, IWarrantVault.InvalidTimeWindow.selector);
    }

    function test_createMandate_lifetimeCountsFromValidAfterWhenInFuture() public {
        IWarrantVault.MandateParams memory p = _params();
        p.validAfter = uint48(block.timestamp + 100 days);
        p.expiry = uint48(block.timestamp + 100 days + 365 days);
        uint256 id = _create(p, merchantA, _rule(true, 0, 0)); // exactly the max lifetime from start is fine
        assertEq(id, 1);
    }

    function test_createMandate_rejectsBadApproval() public {
        IWarrantVault.MandateParams memory p = _params();
        p.approvalThreshold = uint128(3 * USD);
        p.approvalWindow = 0;
        _createExpectRevert(p, IWarrantVault.InvalidApproval.selector);

        p = _params();
        p.approvalThreshold = uint128(6 * USD); // above perTxCap: could never trigger
        p.approvalWindow = 1 hours;
        _createExpectRevert(p, IWarrantVault.InvalidApproval.selector);
    }

    function test_createMandate_merchantListChecks() public {
        IWarrantVault.MandateParams memory p = _params();
        address[] memory none = new address[](0);
        IWarrantVault.MerchantRule[] memory noRules = new IWarrantVault.MerchantRule[](0);
        vm.startPrank(ownerAddr);
        vm.expectRevert(IWarrantVault.NoMerchants.selector);
        vault.createMandate(p, none, noRules);

        address[] memory two = new address[](2);
        two[0] = merchantA;
        two[1] = merchantB;
        IWarrantVault.MerchantRule[] memory one = new IWarrantVault.MerchantRule[](1);
        one[0] = _rule(true, 0, 0);
        vm.expectRevert(IWarrantVault.LengthMismatch.selector);
        vault.createMandate(p, two, one);

        address[] memory many = new address[](33);
        IWarrantVault.MerchantRule[] memory manyRules = new IWarrantVault.MerchantRule[](33);
        vm.expectRevert(IWarrantVault.TooManyMerchants.selector);
        vault.createMandate(p, many, manyRules);

        address[] memory zero = new address[](1);
        vm.expectRevert(IWarrantVault.ZeroAddress.selector);
        vault.createMandate(p, zero, one);
        vm.stopPrank();
    }

    function test_createMandate_identityNeedsRegistryAndMatchingWallet() public {
        IWarrantVault.MandateParams memory p = _params();
        p.agentId = 1; // no such agent
        _createExpectRevert(p, IWarrantVault.IdentityMismatch.selector);

        // Registered, but the registry wallet is the registrant, not the mandate's agent key.
        vm.prank(makeAddr("agentOwner"));
        uint256 agentId = registry.register("ipfs://card");
        p.agentId = agentId;
        _createExpectRevert(p, IWarrantVault.IdentityMismatch.selector);
    }

    function test_setMerchantRule_addChangeRemove() public {
        uint256 id = _createDefault();
        vm.prank(ownerAddr);
        vault.setMerchantRule(id, merchantB, _rule(true, 1 * USD, 0));
        assertEq(uint8(vault.checkTerms(id, merchantB, 1 * USD, _ref(1))), uint8(IWarrantVault.Reason.Ok));
        assertEq(
            uint8(vault.checkTerms(id, merchantB, 2 * USD, _ref(1))),
            uint8(IWarrantVault.Reason.ExceedsMerchantPerTxCap)
        );

        vm.prank(ownerAddr);
        vault.setMerchantRule(id, merchantB, _rule(false, 0, 0));
        assertEq(
            uint8(vault.checkTerms(id, merchantB, 1 * USD, _ref(1))),
            uint8(IWarrantVault.Reason.MerchantNotAllowed)
        );
    }

    function test_setMerchantRule_onlyOwner_unknownMandate_zeroMerchant() public {
        uint256 id = _createDefault();
        vm.prank(agentAddr);
        vm.expectRevert(IWarrantVault.Unauthorized.selector);
        vault.setMerchantRule(id, merchantB, _rule(true, 0, 0));

        vm.startPrank(ownerAddr);
        vm.expectRevert(IWarrantVault.UnknownMandate.selector);
        vault.setMerchantRule(99, merchantB, _rule(true, 0, 0));
        vm.expectRevert(IWarrantVault.ZeroAddress.selector);
        vault.setMerchantRule(id, address(0), _rule(true, 0, 0));
        vm.stopPrank();
    }

    function test_revoke_byOwner_stopsPayments() public {
        uint256 id = _createDefault();
        _payOk(id, merchantA, 1 * USD, _ref(1));
        vm.expectEmit(true, true, false, false, address(vault));
        emit IWarrantVault.MandateRevoked(id, ownerAddr);
        vm.prank(ownerAddr);
        vault.revokeMandate(id);

        assertTrue(vault.getMandate(id).revoked);
        IWarrantVault.PaymentIntent memory i = _intent(id, merchantA, 1 * USD, _ref(2));
        bytes memory sig = _sign(agentKey, i);
        assertEq(uint8(vault.check(i, sig)), uint8(IWarrantVault.Reason.MandateRevoked));
        _expectReject(IWarrantVault.Reason.MandateRevoked);
        vault.pay(i, sig);
    }

    function test_revoke_byGuardian() public {
        uint256 id = _createDefault();
        vm.prank(guardian);
        vault.revokeMandate(id);
        assertTrue(vault.getMandate(id).revoked);
    }

    function test_revoke_strangerAndAgentCannot() public {
        uint256 id = _createDefault();
        vm.prank(agentAddr);
        vm.expectRevert(IWarrantVault.Unauthorized.selector);
        vault.revokeMandate(id);
        vm.prank(evil);
        vm.expectRevert(IWarrantVault.Unauthorized.selector);
        vault.revokeMandate(id);
    }

    function test_revoke_unknownMandate() public {
        vm.prank(ownerAddr);
        vm.expectRevert(IWarrantVault.UnknownMandate.selector);
        vault.revokeMandate(7);
    }

    function test_freeze_blocksAllMandates_onlyOwnerUnfreezes() public {
        uint256 id1 = _createDefault();
        uint256 id2 = _createDefault();
        vm.prank(guardian);
        vault.freezeAll();
        assertTrue(vault.frozen());
        assertEq(vault.remainingAllowance(id1, merchantA), 0);

        IWarrantVault.PaymentIntent memory i1 = _intent(id1, merchantA, 1 * USD, _ref(1));
        IWarrantVault.PaymentIntent memory i2 = _intent(id2, merchantA, 1 * USD, _ref(2));
        bytes memory s1 = _sign(agentKey, i1);
        bytes memory s2 = _sign(agentKey, i2);
        _expectReject(IWarrantVault.Reason.VaultFrozen);
        vault.pay(i1, s1);
        _expectReject(IWarrantVault.Reason.VaultFrozen);
        vault.pay(i2, s2);

        vm.prank(guardian);
        vm.expectRevert(IWarrantVault.Unauthorized.selector);
        vault.unfreeze();

        vm.prank(ownerAddr);
        vault.unfreeze();
        assertFalse(vault.frozen());
        vault.pay(i1, s1);
    }

    function test_freeze_strangerCannot() public {
        vm.prank(evil);
        vm.expectRevert(IWarrantVault.Unauthorized.selector);
        vault.freezeAll();
    }

    function test_freeze_ownerCanFreezeAndWithdrawWhileFrozen() public {
        vm.startPrank(ownerAddr);
        vault.freezeAll();
        vault.withdraw(ownerAddr, 10 * USD);
        vm.stopPrank();
        assertEq(token.balanceOf(ownerAddr), 10 * USD);
    }

    function test_setGuardian() public {
        vm.prank(ownerAddr);
        vault.setGuardian(evil);
        assertEq(vault.guardian(), evil);
        vm.prank(guardian); // old guardian lost its power
        vm.expectRevert(IWarrantVault.Unauthorized.selector);
        vault.freezeAll();
        vm.prank(evil);
        vault.freezeAll();
        vm.prank(agentAddr);
        vm.expectRevert(IWarrantVault.Unauthorized.selector);
        vault.setGuardian(agentAddr);
    }

    function test_noGuardianMeansNobodyElseCanFreeze() public {
        vm.prank(ownerAddr);
        vault.setGuardian(address(0));
        // address(0) can't call, and msg.sender == guardian == 0 is impossible
        vm.prank(evil);
        vm.expectRevert(IWarrantVault.Unauthorized.selector);
        vault.freezeAll();
    }

    function test_invalidateNonce() public {
        uint256 id = _createDefault();
        IWarrantVault.PaymentIntent memory i = _intent(id, merchantA, 1 * USD, _ref(1));
        bytes memory sig = _sign(agentKey, i);
        vm.prank(agentAddr);
        vault.invalidateNonce(id, i.nonce);
        assertEq(uint8(vault.check(i, sig)), uint8(IWarrantVault.Reason.NonceUsed));

        vm.prank(evil);
        vm.expectRevert(IWarrantVault.Unauthorized.selector);
        vault.invalidateNonce(id, bytes32(uint256(5)));
        vm.prank(ownerAddr);
        vault.invalidateNonce(id, bytes32(uint256(5)));
        vm.prank(ownerAddr);
        vm.expectRevert(IWarrantVault.UnknownMandate.selector);
        vault.invalidateNonce(42, bytes32(uint256(5)));
    }

    function test_vaultConstructor_zeroChecks() public {
        vm.expectRevert(IWarrantVault.ZeroAddress.selector);
        new WarrantVault(token, address(0), guardian, registry);
        vm.expectRevert(IWarrantVault.ZeroAddress.selector);
        new WarrantVault(IERC20(address(0)), ownerAddr, guardian, registry);
    }
}
