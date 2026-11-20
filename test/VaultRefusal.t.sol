// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.t.sol";
import {IWarrantVault} from "../src/interfaces/IWarrantVault.sol";

/// @dev `payOrRefuse`: a refused-but-authentic intent becomes an on-chain record instead of a revert.
contract VaultRefusalTest is Base {
    uint256 internal id;

    function setUp() public override {
        super.setUp();
        id = _createDefault();
    }

    function _refuse(IWarrantVault.PaymentIntent memory i) internal returns (IWarrantVault.Reason r) {
        bytes memory sig = _sign(agentKey, i);
        vm.prank(relayer);
        (r,) = vault.payOrRefuse(i, sig);
    }

    function test_refusal_emitsEvent_movesNothing_consumesNonce() public {
        IWarrantVault.PaymentIntent memory i = _intent(id, evil, 3 * USD, _ref(1));
        uint256 before_ = vault.balance();
        vm.expectEmit(true, true, true, true, address(vault));
        emit IWarrantVault.PaymentRefused(
            id, agentAddr, evil, 3 * USD, IWarrantVault.Reason.MerchantNotAllowed, _ref(1), i.intentHash
        );
        IWarrantVault.Reason r = _refuse(i);

        assertEq(uint8(r), uint8(IWarrantVault.Reason.MerchantNotAllowed));
        assertEq(vault.balance(), before_);
        assertEq(token.balanceOf(evil), 0);
        assertTrue(vault.nonceUsed(id, i.nonce));
        assertEq(vault.refusalCount(id), 1);
        assertEq(vault.getMandate(id).spentTotal, 0);
        assertEq(uint8(vault.invoiceState(evil, _ref(1))), uint8(IWarrantVault.InvoiceState.None));
    }

    function test_refusal_sameIntentCannotBeLoggedTwice() public {
        IWarrantVault.PaymentIntent memory i = _intent(id, evil, 3 * USD, _ref(1));
        bytes memory sig = _sign(agentKey, i);
        vault.payOrRefuse(i, sig);
        vm.expectRevert(
            abi.encodeWithSelector(IWarrantVault.PaymentRejected.selector, IWarrantVault.Reason.NonceUsed)
        );
        vault.payOrRefuse(i, sig);
        assertEq(vault.refusalCount(id), 1);
    }

    function test_refusal_requiresTheAgentsSignature() public {
        IWarrantVault.PaymentIntent memory i = _intent(id, evil, 3 * USD, _ref(1));
        bytes memory sig = _sign(0xBAD, i); // someone else
        vm.expectRevert(
            abi.encodeWithSelector(IWarrantVault.PaymentRejected.selector, IWarrantVault.Reason.BadSignature)
        );
        vault.payOrRefuse(i, sig);
        assertEq(vault.refusalCount(id), 0);
        assertFalse(vault.nonceUsed(id, i.nonce));

        // A valid signature over different terms does not authenticate tampered terms either.
        bytes memory good = _sign(agentKey, i);
        i.amount = 4 * USD;
        vm.expectRevert(
            abi.encodeWithSelector(IWarrantVault.PaymentRejected.selector, IWarrantVault.Reason.BadSignature)
        );
        vault.payOrRefuse(i, good);
    }

    function test_refusal_unknownMandate_expired_revertSilently() public {
        IWarrantVault.PaymentIntent memory i = _intent(id + 7, evil, 1, _ref(1));
        bytes memory sig = _sign(agentKey, i);
        vm.expectRevert(
            abi.encodeWithSelector(IWarrantVault.PaymentRejected.selector, IWarrantVault.Reason.MandateNotFound)
        );
        vault.payOrRefuse(i, sig);

        i = _intent(id, evil, 1, _ref(2));
        sig = _sign(agentKey, i);
        vm.warp(i.deadline + 1);
        vm.expectRevert(
            abi.encodeWithSelector(IWarrantVault.PaymentRejected.selector, IWarrantVault.Reason.IntentExpired)
        );
        vault.payOrRefuse(i, sig);
    }

    function test_refusal_coversEveryTermReason() public {
        // over the per-payment cap
        assertEq(
            uint8(_refuse(_intent(id, merchantA, 5 * USD + 1, _ref(1)))),
            uint8(IWarrantVault.Reason.ExceedsPerTxCap)
        );
        // zero amount
        assertEq(
            uint8(_refuse(_intent(id, merchantA, 0, _ref(2)))), uint8(IWarrantVault.Reason.ZeroAmount)
        );
        // revoked
        vm.prank(ownerAddr);
        vault.revokeMandate(id);
        assertEq(
            uint8(_refuse(_intent(id, merchantA, 1 * USD, _ref(3)))),
            uint8(IWarrantVault.Reason.MandateRevoked)
        );
        assertEq(vault.refusalCount(id), 3);
        assertEq(token.balanceOf(merchantA), 0);
    }

    function test_refusal_periodCapAndInvoiceReuse() public {
        for (uint256 k = 1; k <= 4; ++k) _payOk(id, merchantA, 5 * USD, _ref(k));
        assertEq(
            uint8(_refuse(_intent(id, merchantA, 1 * USD, _ref(9)))),
            uint8(IWarrantVault.Reason.ExceedsPeriodCap)
        );
        assertEq(
            uint8(_refuse(_intent(id, merchantA, 1 * USD, _ref(1)))),
            uint8(IWarrantVault.Reason.ExceedsPeriodCap)
        );
    }

    function test_refusal_okPaymentsStillExecute() public {
        IWarrantVault.PaymentIntent memory i = _intent(id, merchantA, 3 * USD, _ref(1));
        IWarrantVault.Reason r = _refuse(i);
        assertEq(uint8(r), uint8(IWarrantVault.Reason.Ok));
        assertEq(token.balanceOf(merchantA), 3 * USD);
        assertEq(vault.refusalCount(id), 0);
    }

    function test_refusal_logIsBounded() public {
        uint256 cap = vault.MAX_LOGGED_REFUSALS();
        for (uint256 k; k < cap; ++k) {
            IWarrantVault.PaymentIntent memory i = _intent(id, evil, 1, _ref(k + 1));
            bytes memory sig = _sign(agentKey, i);
            vault.payOrRefuse(i, sig);
        }
        assertEq(vault.refusalCount(id), cap);
        IWarrantVault.PaymentIntent memory last = _intent(id, evil, 1, _ref(cap + 1));
        bytes memory lastSig = _sign(agentKey, last);
        vm.expectRevert(IWarrantVault.RefusalLogFull.selector);
        vault.payOrRefuse(last, lastSig);
        assertFalse(vault.nonceUsed(id, last.nonce));
    }

    function test_createdAtBlock() public view {
        assertEq(vault.createdAtBlock(), block.number);
    }
}
