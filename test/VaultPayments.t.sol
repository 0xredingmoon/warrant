// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.t.sol";
import {IWarrantVault} from "../src/interfaces/IWarrantVault.sol";
import {MockSmartAgent} from "./mocks/MockSmartAgent.sol";

contract VaultPaymentsTest is Base {
    uint256 internal id;

    function setUp() public override {
        super.setUp();
        id = _createDefault();
    }

    /*//////////////////////////// happy path ////////////////////////////*/

    function test_pay_movesFundsAndEmitsAuditEvent() public {
        IWarrantVault.PaymentIntent memory i = _intent(id, merchantA, 3 * USD, _ref(1));
        bytes memory sig = _sign(agentKey, i);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IWarrantVault.PaymentExecuted(
            id, merchantA, _ref(1), agentAddr, 3 * USD, 0, i.intentHash, bytes32(0)
        );
        vm.prank(relayer);
        (IWarrantVault.Reason r, uint256 pid) = vault.pay(i, sig);

        assertEq(uint8(r), uint8(IWarrantVault.Reason.Ok));
        assertEq(pid, 0);
        assertEq(token.balanceOf(merchantA), 3 * USD);
        assertEq(vault.balance(), 997 * USD);
        assertEq(uint8(vault.invoiceState(merchantA, _ref(1))), uint8(IWarrantVault.InvoiceState.Paid));
        IWarrantVault.Mandate memory m = vault.getMandate(id);
        assertEq(m.spentTotal, 3 * USD);
        assertEq(m.periodSpent, 3 * USD);
        assertEq(vault.merchantSpent(id, merchantA), 3 * USD);
        assertTrue(vault.nonceUsed(id, i.nonce));
    }

    function test_pay_callableByAnyone_agentNeedsNoGas() public {
        IWarrantVault.PaymentIntent memory i = _intent(id, merchantA, 1 * USD, _ref(1));
        bytes memory sig = _sign(agentKey, i);
        assertEq(agentAddr.balance, 0);
        vm.prank(merchantA); // the merchant can pull its own payment too
        vault.pay(i, sig);
        assertEq(token.balanceOf(merchantA), 1 * USD);
    }

    function test_pay_exactCapsAreAllowed() public {
        _payOk(id, merchantA, 5 * USD, _ref(1)); // == perTxCap
        _payOk(id, merchantA, 5 * USD, _ref(2));
        _payOk(id, merchantA, 5 * USD, _ref(3));
        _payOk(id, merchantA, 5 * USD, _ref(4)); // == periodCap (20) reached exactly
        assertEq(vault.remainingAllowance(id, merchantA), 0);
    }

    /*//////////////////////////// caps ////////////////////////////*/

    function test_pay_rejectsAbovePerTxCap() public {
        IWarrantVault.PaymentIntent memory i = _intent(id, merchantA, 5 * USD + 1, _ref(1));
        bytes memory sig = _sign(agentKey, i);
        assertEq(uint8(vault.check(i, sig)), uint8(IWarrantVault.Reason.ExceedsPerTxCap));
        _expectReject(IWarrantVault.Reason.ExceedsPerTxCap);
        vault.pay(i, sig);
        assertEq(token.balanceOf(merchantA), 0);
    }

    function test_pay_rejectsAbovePeriodCap_thenResetsNextWindow() public {
        for (uint256 n = 1; n <= 4; ++n) {
            _payOk(id, merchantA, 5 * USD, _ref(n));
        }
        IWarrantVault.PaymentIntent memory i = _intent(id, merchantA, 1, _ref(5));
        bytes memory sig = _sign(agentKey, i);
        _expectReject(IWarrantVault.Reason.ExceedsPeriodCap);
        vault.pay(i, sig);

        vm.warp(T0 + 1 days); // window 1 begins
        i = _intent(id, merchantA, 5 * USD, _ref(6));
        assertEq(uint8(vault.checkTerms(id, merchantA, 5 * USD, _ref(6))), uint8(IWarrantVault.Reason.Ok));
        _payOk(id, merchantA, 5 * USD, _ref(6));
        assertEq(vault.getMandate(id).periodSpent, 5 * USD);
        assertEq(vault.getMandate(id).periodIndex, 1);
        assertEq(vault.getMandate(id).spentTotal, 25 * USD);
    }

    function test_pay_rejectsAboveTotalCap() public {
        // 5 windows x 20 = 100 = totalCap
        for (uint256 w; w < 5; ++w) {
            vm.warp(T0 + w * 1 days);
            for (uint256 n; n < 4; ++n) {
                _payOk(id, merchantA, 5 * USD, _ref(w * 10 + n + 1));
            }
        }
        assertEq(vault.getMandate(id).spentTotal, 100 * USD);
        vm.warp(T0 + 5 days);
        IWarrantVault.PaymentIntent memory i = _intent(id, merchantA, 1, _ref(999));
        bytes memory sig = _sign(agentKey, i);
        _expectReject(IWarrantVault.Reason.ExceedsTotalCap);
        vault.pay(i, sig);
    }

    function test_pay_perMerchantCaps() public {
        uint256 id2 = _create(_params(), merchantA, _rule(true, 2 * USD, 6 * USD));
        _payOk(id2, merchantA, 2 * USD, _ref(1));
        IWarrantVault.PaymentIntent memory big = _intent(id2, merchantA, 2 * USD + 1, _ref(2));
        bytes memory bigSig = _sign(agentKey, big);
        _expectReject(IWarrantVault.Reason.ExceedsMerchantPerTxCap);
        vault.pay(big, bigSig);

        _payOk(id2, merchantA, 2 * USD, _ref(3));
        _payOk(id2, merchantA, 2 * USD, _ref(4)); // merchant total 6 reached
        IWarrantVault.PaymentIntent memory over = _intent(id2, merchantA, 1, _ref(5));
        bytes memory overSig = _sign(agentKey, over);
        _expectReject(IWarrantVault.Reason.ExceedsMerchantTotalCap);
        vault.pay(over, overSig);
        assertEq(vault.remainingAllowance(id2, merchantA), 0);
    }

    function test_pay_merchantNotAllowed_leavesFundsUntouched() public {
        IWarrantVault.PaymentIntent memory i = _intent(id, evil, 1 * USD, _ref(1));
        bytes memory sig = _sign(agentKey, i);
        assertEq(uint8(vault.check(i, sig)), uint8(IWarrantVault.Reason.MerchantNotAllowed));
        _expectReject(IWarrantVault.Reason.MerchantNotAllowed);
        vault.pay(i, sig);
        assertEq(token.balanceOf(evil), 0);
        assertEq(vault.balance(), 1_000 * USD);
    }

    function test_pay_zeroAmount() public {
        IWarrantVault.PaymentIntent memory i = _intent(id, merchantA, 0, _ref(1));
        bytes memory sig = _sign(agentKey, i);
        _expectReject(IWarrantVault.Reason.ZeroAmount);
        vault.pay(i, sig);
    }

    function test_pay_hugeAmountDoesNotOverflow() public {
        IWarrantVault.PaymentIntent memory i = _intent(id, merchantA, type(uint256).max, _ref(1));
        bytes memory sig = _sign(agentKey, i);
        _expectReject(IWarrantVault.Reason.ExceedsPerTxCap);
        vault.pay(i, sig);
    }

    function test_pay_insufficientBalance() public {
        vm.prank(ownerAddr);
        vault.withdraw(ownerAddr, 999 * USD + 500_000); // leave 0.5
        IWarrantVault.PaymentIntent memory i = _intent(id, merchantA, 1 * USD, _ref(1));
        bytes memory sig = _sign(agentKey, i);
        assertEq(uint8(vault.check(i, sig)), uint8(IWarrantVault.Reason.InsufficientBalance));
        _expectReject(IWarrantVault.Reason.InsufficientBalance);
        vault.pay(i, sig);
    }

    /*//////////////////////////// time ////////////////////////////*/

    function test_pay_notYetValid_thenValid() public {
        IWarrantVault.MandateParams memory p = _params();
        p.validAfter = uint48(T0 + 1 hours);
        p.expiry = uint48(T0 + 2 days);
        uint256 id2 = _create(p, merchantA, _rule(true, 0, 0));
        IWarrantVault.PaymentIntent memory i = _intent(id2, merchantA, 1 * USD, _ref(1));
        i.deadline = T0 + 3 hours;
        bytes memory sig = _sign(agentKey, i);
        _expectReject(IWarrantVault.Reason.NotYetValid);
        vault.pay(i, sig);

        vm.warp(T0 + 1 hours); // validAfter is inclusive
        vault.pay(i, sig);
        assertEq(token.balanceOf(merchantA), 1 * USD);
    }

    function test_pay_expiryIsExclusive() public {
        vm.warp(T0 + 7 days - 1);
        IWarrantVault.PaymentIntent memory i = _intent(id, merchantA, 1 * USD, _ref(1));
        i.deadline = T0 + 8 days;
        bytes memory sig = _sign(agentKey, i);
        assertEq(uint8(vault.check(i, sig)), uint8(IWarrantVault.Reason.Ok)); // one second left
        vm.warp(T0 + 7 days);
        assertEq(uint8(vault.check(i, sig)), uint8(IWarrantVault.Reason.MandateExpired));
        _expectReject(IWarrantVault.Reason.MandateExpired);
        vault.pay(i, sig);
        assertEq(vault.remainingAllowance(id, merchantA), 0);
    }

    function test_pay_intentDeadline() public {
        IWarrantVault.PaymentIntent memory i = _intent(id, merchantA, 1 * USD, _ref(1));
        bytes memory sig = _sign(agentKey, i);
        vm.warp(i.deadline); // deadline is inclusive
        assertEq(uint8(vault.check(i, sig)), uint8(IWarrantVault.Reason.Ok));
        vm.warp(i.deadline + 1);
        assertEq(uint8(vault.check(i, sig)), uint8(IWarrantVault.Reason.IntentExpired));
        _expectReject(IWarrantVault.Reason.IntentExpired);
        vault.pay(i, sig);
    }

    /*//////////////////////////// identity of signer ////////////////////////////*/

    function test_pay_wrongSignerRejected() public {
        (, uint256 otherKey) = makeAddrAndKey("other");
        IWarrantVault.PaymentIntent memory i = _intent(id, merchantA, 1 * USD, _ref(1));
        bytes memory sig = _sign(otherKey, i);
        assertEq(uint8(vault.check(i, sig)), uint8(IWarrantVault.Reason.BadSignature));
        _expectReject(IWarrantVault.Reason.BadSignature);
        vault.pay(i, sig);
    }

    function test_pay_tamperedFieldsRejected() public view {
        IWarrantVault.PaymentIntent memory i = _intent(id, merchantA, 1 * USD, _ref(1));
        bytes memory sig = _sign(agentKey, i);

        // A relayer swaps the merchant, the amount, the invoice, the memo, or the mandate: every one breaks the signature.
        IWarrantVault.PaymentIntent memory t = _intent(id, merchantA, 1 * USD, _ref(1));
        t.amount = 2 * USD;
        assertEq(uint8(vault.check(t, sig)), uint8(IWarrantVault.Reason.BadSignature));
        t = _intent(id, merchantA, 1 * USD, _ref(1));
        t.merchant = merchantB;
        assertEq(uint8(vault.check(t, sig)), uint8(IWarrantVault.Reason.BadSignature));
        t = _intent(id, merchantA, 1 * USD, _ref(1));
        t.invoiceRef = _ref(2);
        assertEq(uint8(vault.check(t, sig)), uint8(IWarrantVault.Reason.BadSignature));
        t = _intent(id, merchantA, 1 * USD, _ref(1));
        t.intentHash = bytes32(uint256(1));
        assertEq(uint8(vault.check(t, sig)), uint8(IWarrantVault.Reason.BadSignature));
        t = _intent(id, merchantA, 1 * USD, _ref(1));
        t.deadline += 1;
        assertEq(uint8(vault.check(t, sig)), uint8(IWarrantVault.Reason.BadSignature));
    }

    function test_pay_garbageSignatureRejectedNotReverted() public view {
        IWarrantVault.PaymentIntent memory i = _intent(id, merchantA, 1 * USD, _ref(1));
        assertEq(uint8(vault.check(i, hex"")), uint8(IWarrantVault.Reason.BadSignature));
        assertEq(uint8(vault.check(i, hex"deadbeef")), uint8(IWarrantVault.Reason.BadSignature));
        assertEq(uint8(vault.check(i, new bytes(65))), uint8(IWarrantVault.Reason.BadSignature));
    }

    function test_pay_signatureBoundToThisVault() public {
        vm.prank(ownerAddr);
        WarrantVaultLike other = WarrantVaultLike(factory.createVault(guardian, bytes32(uint256(1))));
        _fund(address(other), 100 * USD);
        address[] memory ms = new address[](1);
        ms[0] = merchantA;
        IWarrantVault.MerchantRule[] memory rs = new IWarrantVault.MerchantRule[](1);
        rs[0] = _rule(true, 0, 0);
        IWarrantVault.MandateParams memory p = _params();
        vm.prank(ownerAddr);
        other.createMandate(p, ms, rs);

        IWarrantVault.PaymentIntent memory i = _intent(1, merchantA, 1 * USD, _ref(1));
        bytes memory sigForVault = _sign(agentKey, i); // signed for `vault`, replayed on `other`
        assertEq(uint8(other.check(i, sigForVault)), uint8(IWarrantVault.Reason.BadSignature));
    }

    function test_pay_smartContractAgent_erc1271() public {
        MockSmartAgent smart = new MockSmartAgent(agentAddr);
        IWarrantVault.MandateParams memory p = _params();
        p.agent = address(smart);
        uint256 id2 = _create(p, merchantA, _rule(true, 0, 0));
        IWarrantVault.PaymentIntent memory i = _intent(id2, merchantA, 2 * USD, _ref(1));
        bytes memory sig = _sign(agentKey, i); // the smart agent's configured signer signs
        vault.pay(i, sig);
        assertEq(token.balanceOf(merchantA), 2 * USD);

        (, uint256 otherKey) = makeAddrAndKey("other");
        IWarrantVault.PaymentIntent memory j = _intent(id2, merchantA, 2 * USD, _ref(2));
        assertEq(uint8(vault.check(j, _sign(otherKey, j))), uint8(IWarrantVault.Reason.BadSignature));
    }

    function test_pay_unknownMandate() public {
        IWarrantVault.PaymentIntent memory i = _intent(77, merchantA, 1 * USD, _ref(1));
        bytes memory sig = _sign(agentKey, i);
        assertEq(uint8(vault.check(i, sig)), uint8(IWarrantVault.Reason.MandateNotFound));
        assertEq(
            uint8(vault.checkTerms(77, merchantA, 1, _ref(1))), uint8(IWarrantVault.Reason.MandateNotFound)
        );
        _expectReject(IWarrantVault.Reason.MandateNotFound);
        vault.pay(i, sig);
    }

    /*//////////////////////////// idempotency and replay ////////////////////////////*/

    function test_pay_replayOfSameIntentRejected() public {
        IWarrantVault.PaymentIntent memory i = _intent(id, merchantA, 1 * USD, _ref(1));
        bytes memory sig = _sign(agentKey, i);
        vault.pay(i, sig);
        _expectReject(IWarrantVault.Reason.NonceUsed);
        vault.pay(i, sig);
        assertEq(token.balanceOf(merchantA), 1 * USD);
    }

    function test_pay_sameInvoiceTwiceWithFreshNonceRejected() public {
        IWarrantVault.PaymentIntent memory i = _intent(id, merchantA, 1 * USD, _ref(1));
        vault.pay(i, _sign(agentKey, i));

        // The agent retries after a timeout with a new nonce: the invoice is already paid, so no double charge.
        IWarrantVault.PaymentIntent memory retry = _intent(id, merchantA, 1 * USD, _ref(1));
        retry.nonce = bytes32(uint256(0xbeef));
        bytes memory sig = _sign(agentKey, retry);
        assertEq(uint8(vault.check(retry, sig)), uint8(IWarrantVault.Reason.InvoiceAlreadyUsed));
        _expectReject(IWarrantVault.Reason.InvoiceAlreadyUsed);
        vault.pay(retry, sig);
        assertEq(token.balanceOf(merchantA), 1 * USD);
    }

    function test_pay_sameInvoiceRefDifferentMerchantsAreIndependent() public {
        vm.prank(ownerAddr);
        vault.setMerchantRule(id, merchantB, _rule(true, 0, 0));
        _payOk(id, merchantA, 1 * USD, _ref(1));
        _payOk(id, merchantB, 1 * USD, _ref(1));
        assertEq(token.balanceOf(merchantB), 1 * USD);
    }

    function test_pay_failedPaymentDoesNotBurnNonce() public {
        IWarrantVault.PaymentIntent memory i = _intent(id, merchantA, 1 * USD, _ref(1));
        bytes memory sig = _sign(agentKey, i);
        vm.prank(ownerAddr);
        vault.freezeAll();
        _expectReject(IWarrantVault.Reason.VaultFrozen);
        vault.pay(i, sig);
        assertFalse(vault.nonceUsed(id, i.nonce)); // reverted: nothing consumed
        vm.prank(ownerAddr);
        vault.unfreeze();
        vault.pay(i, sig); // the very same signed intent still works
    }

    function test_pay_nonceScopedPerMandate() public {
        uint256 id2 = _createDefault();
        IWarrantVault.PaymentIntent memory a = _intent(id, merchantA, 1 * USD, _ref(1));
        IWarrantVault.PaymentIntent memory b = _intent(id2, merchantA, 1 * USD, _ref(2));
        b.nonce = a.nonce; // same nonce value, different mandate
        vault.pay(a, _sign(agentKey, a));
        vault.pay(b, _sign(agentKey, b));
    }

    /*//////////////////////////// fee ////////////////////////////*/

    function test_fee_chargedToMerchant_notToVault() public {
        factory.setFee(50, treasury); // 0.5%
        IWarrantVault.PaymentIntent memory i = _intent(id, merchantA, 4 * USD, _ref(1));
        bytes memory sig = _sign(agentKey, i);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IWarrantVault.PaymentExecuted(
            id, merchantA, _ref(1), agentAddr, 4 * USD, 20_000, i.intentHash, bytes32(0)
        );
        vault.pay(i, sig);
        assertEq(token.balanceOf(merchantA), 4 * USD - 20_000);
        assertEq(token.balanceOf(treasury), 20_000);
        assertEq(vault.balance(), 996 * USD); // the vault paid exactly the gross amount
        assertEq(vault.getMandate(id).spentTotal, 4 * USD); // caps count gross
    }

    function test_fee_zeroWhenOffOrRoundsToZero() public {
        _payOk(id, merchantA, 1 * USD, _ref(1));
        assertEq(token.balanceOf(treasury), 0);
        factory.setFee(1, treasury); // 0.01%
        IWarrantVault.PaymentIntent memory i = _intent(id, merchantA, 9_999, _ref(2)); // 0.9999 cent
        vault.pay(i, _sign(agentKey, i));
        assertEq(token.balanceOf(treasury), 0);
        assertEq(token.balanceOf(merchantA), 1 * USD + 9_999);
    }

    /*//////////////////////////// views ////////////////////////////*/

    function test_remainingAllowance_tracksTightestLimit() public {
        assertEq(vault.remainingAllowance(id, merchantA), 5 * USD); // perTx
        _payOk(id, merchantA, 5 * USD, _ref(1));
        _payOk(id, merchantA, 5 * USD, _ref(2));
        _payOk(id, merchantA, 5 * USD, _ref(3));
        assertEq(vault.remainingAllowance(id, merchantA), 5 * USD);
        _payOk(id, merchantA, 3 * USD, _ref(4));
        assertEq(vault.remainingAllowance(id, merchantA), 2 * USD); // period: 20 - 18
        assertEq(vault.remainingAllowance(id, evil), 0);
        assertEq(vault.remainingAllowance(99, merchantA), 0);
    }

    function test_hashIntent_matchesManualEip712() public view {
        IWarrantVault.PaymentIntent memory i = _intent(id, merchantA, 1 * USD, _ref(1));
        bytes32 structHash = keccak256(
            abi.encode(
                vault.PAYMENT_INTENT_TYPEHASH(),
                i.mandateId,
                i.merchant,
                i.amount,
                i.invoiceRef,
                i.intentHash,
                i.nonce,
                i.deadline
            )
        );
        assertEq(
            vault.hashIntent(i), keccak256(abi.encodePacked("\x19\x01", vault.DOMAIN_SEPARATOR(), structHash))
        );
    }
}

interface WarrantVaultLike {
    function createMandate(
        IWarrantVault.MandateParams calldata p,
        address[] calldata merchants,
        IWarrantVault.MerchantRule[] calldata rules
    ) external returns (uint256);
    function check(IWarrantVault.PaymentIntent calldata intent, bytes calldata sig)
        external
        view
        returns (IWarrantVault.Reason);
}
