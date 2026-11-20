// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.t.sol";
import {IWarrantVault} from "../src/interfaces/IWarrantVault.sol";

/// @dev Co-sign threshold: payments at or above it wait in a queue for the owner.
contract VaultApprovalTest is Base {
    uint256 internal id;

    function setUp() public override {
        super.setUp();
        IWarrantVault.MandateParams memory p = _params();
        p.approvalThreshold = uint128(3 * USD);
        p.approvalWindow = 1 days;
        id = _create(p, merchantA, _rule(true, 0, 0));
    }

    function _queue(uint256 amount, bytes32 ref) internal returns (uint256 pid) {
        IWarrantVault.Reason r;
        (r, pid) = _pay(_intent(id, merchantA, amount, ref));
        assertEq(uint8(r), uint8(IWarrantVault.Reason.ApprovalRequired));
        assertGt(pid, 0);
    }

    function test_belowThreshold_executesImmediately() public {
        _payOk(id, merchantA, 3 * USD - 1, _ref(1));
        assertEq(token.balanceOf(merchantA), 3 * USD - 1);
    }

    function test_atThreshold_isQueued_fundsStay() public {
        IWarrantVault.PaymentIntent memory i = _intent(id, merchantA, 3 * USD, _ref(1));
        bytes memory sig = _sign(agentKey, i);
        assertEq(uint8(vault.check(i, sig)), uint8(IWarrantVault.Reason.ApprovalRequired));
        vm.expectEmit(true, true, true, true, address(vault));
        emit IWarrantVault.PaymentQueued(
            1, id, merchantA, _ref(1), 3 * USD, i.intentHash, uint48(T0 + 1 days)
        );
        vm.prank(relayer);
        (IWarrantVault.Reason r, uint256 pid) = vault.pay(i, sig);

        assertEq(uint8(r), uint8(IWarrantVault.Reason.ApprovalRequired));
        assertEq(pid, 1);
        assertEq(token.balanceOf(merchantA), 0);
        assertEq(vault.balance(), 1_000 * USD);
        assertEq(vault.getMandate(id).spentTotal, 0); // nothing booked until approved
        assertEq(uint8(vault.invoiceState(merchantA, _ref(1))), uint8(IWarrantVault.InvoiceState.Pending));
        IWarrantVault.Pending memory q = vault.getPending(pid);
        assertEq(uint8(q.status), uint8(IWarrantVault.PendingStatus.Open));
        assertEq(q.amount, 3 * USD);
        assertEq(q.merchant, merchantA);
        assertEq(q.expiresAt, T0 + 1 days);
        assertTrue(vault.nonceUsed(id, i.nonce));
    }

    function test_queuedInvoiceCannotBeSubmittedAgain() public {
        _queue(4 * USD, _ref(1));
        IWarrantVault.PaymentIntent memory again = _intent(id, merchantA, 4 * USD, _ref(1));
        again.nonce = bytes32(uint256(77));
        bytes memory sig = _sign(agentKey, again);
        _expectReject(IWarrantVault.Reason.InvoiceAlreadyUsed);
        vault.pay(again, sig);
    }

    function test_ownerApproves_executesAndBooksSpend() public {
        uint256 pid = _queue(4 * USD, _ref(1));
        vm.expectEmit(true, true, false, false, address(vault));
        emit IWarrantVault.PendingApproved(pid, ownerAddr);
        vm.prank(ownerAddr);
        vault.approve(pid);

        assertEq(token.balanceOf(merchantA), 4 * USD);
        assertEq(vault.getMandate(id).spentTotal, 4 * USD);
        assertEq(uint8(vault.invoiceState(merchantA, _ref(1))), uint8(IWarrantVault.InvoiceState.Paid));
        assertEq(uint8(vault.getPending(pid).status), uint8(IWarrantVault.PendingStatus.Approved));
    }

    function test_approve_onlyOwner_agentAndRelayerCannotSelfApprove() public {
        uint256 pid = _queue(4 * USD, _ref(1));
        vm.prank(agentAddr);
        vm.expectRevert(IWarrantVault.Unauthorized.selector);
        vault.approve(pid);
        vm.prank(guardian);
        vm.expectRevert(IWarrantVault.Unauthorized.selector);
        vault.approve(pid);
        vm.prank(relayer);
        vm.expectRevert(IWarrantVault.Unauthorized.selector);
        vault.approve(pid);
    }

    function test_approve_twiceReverts() public {
        uint256 pid = _queue(4 * USD, _ref(1));
        vm.startPrank(ownerAddr);
        vault.approve(pid);
        vm.expectRevert(IWarrantVault.PendingNotOpen.selector);
        vault.approve(pid);
        vm.stopPrank();
        assertEq(token.balanceOf(merchantA), 4 * USD);
    }

    function test_approve_unknownPending() public {
        vm.prank(ownerAddr);
        vm.expectRevert(IWarrantVault.PendingNotOpen.selector);
        vault.approve(123);
    }

    function test_approveBySig_anyoneCanRelay() public {
        uint256 pid = _queue(4 * USD, _ref(1));
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, vault.hashApproval(pid, deadline));
        vm.prank(relayer);
        vault.approveBySig(pid, deadline, abi.encodePacked(r, s, v));
        assertEq(token.balanceOf(merchantA), 4 * USD);
        assertEq(uint8(vault.getPending(pid).status), uint8(IWarrantVault.PendingStatus.Approved));
    }

    function test_approveBySig_wrongSignerOrExpiredOrWrongPending() public {
        uint256 pid = _queue(4 * USD, _ref(1));
        uint256 pid2 = _queue(4 * USD, _ref(2));
        uint256 deadline = block.timestamp + 1 hours;

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentKey, vault.hashApproval(pid, deadline)); // agent can't co-sign
        vm.expectRevert(IWarrantVault.Unauthorized.selector);
        vault.approveBySig(pid, deadline, abi.encodePacked(r, s, v));

        (v, r, s) = vm.sign(ownerKey, vault.hashApproval(pid, deadline));
        vm.expectRevert(IWarrantVault.Unauthorized.selector); // owner signed pid, relayer submits pid2
        vault.approveBySig(pid2, deadline, abi.encodePacked(r, s, v));

        vm.warp(deadline + 1);
        vm.expectRevert(IWarrantVault.SignatureExpired.selector);
        vault.approveBySig(pid, deadline, abi.encodePacked(r, s, v));
    }

    function test_approveBySig_signatureIsOneShot() public {
        uint256 pid = _queue(4 * USD, _ref(1));
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, vault.hashApproval(pid, deadline));
        vault.approveBySig(pid, deadline, abi.encodePacked(r, s, v));
        vm.expectRevert(IWarrantVault.PendingNotOpen.selector);
        vault.approveBySig(pid, deadline, abi.encodePacked(r, s, v));
    }

    function test_approve_afterWindowReverts_expireFreesInvoice() public {
        uint256 pid = _queue(4 * USD, _ref(1));
        vm.warp(T0 + 1 days); // window end is inclusive
        vm.prank(ownerAddr);
        vault.approve(pid); // still valid exactly at expiresAt
        assertEq(token.balanceOf(merchantA), 4 * USD);

        uint256 pid2 = _queue(4 * USD, _ref(2));
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(ownerAddr);
        vm.expectRevert(IWarrantVault.PendingWindowClosed.selector);
        vault.approve(pid2);

        vm.prank(relayer);
        vault.expirePending(pid2);
        assertEq(uint8(vault.getPending(pid2).status), uint8(IWarrantVault.PendingStatus.Expired));
        assertEq(uint8(vault.invoiceState(merchantA, _ref(2))), uint8(IWarrantVault.InvoiceState.None));
    }

    function test_expirePending_notBeforeWindowEnds() public {
        uint256 pid = _queue(4 * USD, _ref(1));
        vm.expectRevert(IWarrantVault.PendingStillOpen.selector);
        vault.expirePending(pid);
        vm.expectRevert(IWarrantVault.PendingNotOpen.selector);
        vault.expirePending(555);
    }

    function test_reject_byOwner_invoicePayableAgain() public {
        uint256 pid = _queue(4 * USD, _ref(1));
        vm.expectEmit(true, true, false, false, address(vault));
        emit IWarrantVault.PendingRejected(pid, ownerAddr);
        vm.prank(ownerAddr);
        vault.reject(pid);
        assertEq(uint8(vault.getPending(pid).status), uint8(IWarrantVault.PendingStatus.Rejected));
        assertEq(uint8(vault.invoiceState(merchantA, _ref(1))), uint8(IWarrantVault.InvoiceState.None));
        _queue(2 * USD + 1_000_000, _ref(1)); // can be re-requested (amount ≥ threshold again)
    }

    function test_reject_byAgentCancelsItsOwnRequest_strangerCannot() public {
        uint256 pid = _queue(4 * USD, _ref(1));
        vm.prank(evil);
        vm.expectRevert(IWarrantVault.Unauthorized.selector);
        vault.reject(pid);
        vm.prank(agentAddr);
        vault.reject(pid);
        vm.prank(ownerAddr);
        vm.expectRevert(IWarrantVault.PendingNotOpen.selector);
        vault.approve(pid);
    }

    function test_revokeAfterQueue_blocksApproval() public {
        uint256 pid = _queue(4 * USD, _ref(1));
        vm.prank(guardian);
        vault.revokeMandate(id);
        vm.prank(ownerAddr);
        vm.expectRevert(
            abi.encodeWithSelector(
                IWarrantVault.PaymentRejected.selector, IWarrantVault.Reason.MandateRevoked
            )
        );
        vault.approve(pid);
        assertEq(token.balanceOf(merchantA), 0);
    }

    function test_freezeAfterQueue_blocksApproval() public {
        uint256 pid = _queue(4 * USD, _ref(1));
        vm.prank(guardian);
        vault.freezeAll();
        vm.prank(ownerAddr);
        vm.expectRevert(
            abi.encodeWithSelector(IWarrantVault.PaymentRejected.selector, IWarrantVault.Reason.VaultFrozen)
        );
        vault.approve(pid);
    }

    function test_merchantRemovedAfterQueue_blocksApproval() public {
        uint256 pid = _queue(4 * USD, _ref(1));
        vm.startPrank(ownerAddr);
        vault.setMerchantRule(id, merchantA, _rule(false, 0, 0));
        vm.expectRevert(
            abi.encodeWithSelector(
                IWarrantVault.PaymentRejected.selector, IWarrantVault.Reason.MerchantNotAllowed
            )
        );
        vault.approve(pid);
        vm.stopPrank();
    }

    function test_approvalRechecksCapsAtApprovalTime() public {
        // Queue two 4 USD payments, then spend the rest of the daily cap directly: the second approval must fail.
        uint256 p1 = _queue(4 * USD, _ref(1));
        uint256 p2 = _queue(4 * USD, _ref(2));
        // Burn 14 USD of period cap with small payments (each < threshold 3): 5 x 2.8
        for (uint256 n; n < 5; ++n) {
            _payOk(id, merchantA, 2_800_000, _ref(100 + n));
        }
        // 14 spent; approving p1 (4) → 18 ok; p2 (4) → 22 > 20.
        vm.startPrank(ownerAddr);
        vault.approve(p1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IWarrantVault.PaymentRejected.selector, IWarrantVault.Reason.ExceedsPeriodCap
            )
        );
        vault.approve(p2);
        vm.stopPrank();
    }

    function test_approvalNeedsBalance() public {
        uint256 pid = _queue(4 * USD, _ref(1));
        vm.startPrank(ownerAddr);
        vault.withdraw(ownerAddr, 1_000 * USD);
        vm.expectRevert(
            abi.encodeWithSelector(
                IWarrantVault.PaymentRejected.selector, IWarrantVault.Reason.InsufficientBalance
            )
        );
        vault.approve(pid);
        vm.stopPrank();
    }

    function test_approvalAfterMandateExpiry_rejected() public {
        IWarrantVault.MandateParams memory p = _params();
        p.expiry = uint48(T0 + 2 hours);
        p.approvalThreshold = uint128(3 * USD);
        p.approvalWindow = 1 days; // window outlives the mandate
        uint256 id2 = _create(p, merchantA, _rule(true, 0, 0));
        IWarrantVault.PaymentIntent memory i = _intent(id2, merchantA, 4 * USD, _ref(1));
        (, uint256 pid) = vault.pay(i, _sign(agentKey, i));
        vm.warp(T0 + 3 hours);
        vm.prank(ownerAddr);
        vm.expectRevert(
            abi.encodeWithSelector(
                IWarrantVault.PaymentRejected.selector, IWarrantVault.Reason.MandateExpired
            )
        );
        vault.approve(pid);
    }

    function test_thresholdOne_requiresApprovalForEverything() public {
        IWarrantVault.MandateParams memory p = _params();
        p.approvalThreshold = 1;
        p.approvalWindow = 1 days;
        uint256 id2 = _create(p, merchantA, _rule(true, 0, 0));
        IWarrantVault.PaymentIntent memory i = _intent(id2, merchantA, 1, _ref(1));
        (IWarrantVault.Reason r,) = vault.pay(i, _sign(agentKey, i));
        assertEq(uint8(r), uint8(IWarrantVault.Reason.ApprovalRequired));
    }
}
