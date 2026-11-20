// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.t.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {IWarrantVault} from "../src/interfaces/IWarrantVault.sol";
import {WarrantVault} from "../src/WarrantVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract VaultFuzzTest is Base {
    uint256 internal id;

    function setUp() public override {
        super.setUp();
        id = _createDefault();
    }

    /// @dev `check` is the truth: if it says Ok the payment executes, otherwise `pay` reverts with that reason.
    function testFuzz_checkPredictsPay(uint256 amount, uint256 warpBy, bool tamper) public {
        amount = bound(amount, 0, 7 * USD);
        warpBy = bound(warpBy, 0, 9 days);
        vm.warp(T0 + warpBy);
        IWarrantVault.PaymentIntent memory i = _intent(id, merchantA, amount, _ref(1));
        i.deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(agentKey, i);
        if (tamper) i.amount = amount + 1;
        IWarrantVault.Reason expected = vault.check(i, sig);
        if (expected == IWarrantVault.Reason.Ok) {
            vault.pay(i, sig);
            assertEq(token.balanceOf(merchantA), i.amount);
        } else {
            vm.expectRevert(abi.encodeWithSelector(IWarrantVault.PaymentRejected.selector, expected));
            vault.pay(i, sig);
            assertEq(token.balanceOf(merchantA), 0);
        }
    }

    /// @dev An unlisted merchant is never payable, whatever the amount or time.
    function testFuzz_unlistedMerchantNeverPaid(address merchant, uint256 amount) public {
        vm.assume(merchant != merchantA && merchant != address(0));
        amount = bound(amount, 1, 5 * USD);
        IWarrantVault.PaymentIntent memory i = _intent(id, merchant, amount, _ref(1));
        assertEq(uint8(vault.check(i, _sign(agentKey, i))), uint8(IWarrantVault.Reason.MerchantNotAllowed));
    }

    /// @dev Nobody but the agent key can ever produce a valid signature.
    function testFuzz_otherKeysNeverAuthorised(uint256 key, uint256 amount) public {
        key = bound(key, 1, type(uint160).max);
        vm.assume(key != agentKey);
        amount = bound(amount, 1, 5 * USD);
        IWarrantVault.PaymentIntent memory i = _intent(id, merchantA, amount, _ref(1));
        assertEq(uint8(vault.check(i, _sign(key, i))), uint8(IWarrantVault.Reason.BadSignature));
    }

    /// @dev Mandate creation never accepts caps that don't nest or a lifetime over a year.
    function testFuzz_createMandate_validation(
        uint128 perTx,
        uint128 period,
        uint128 total,
        uint32 length,
        uint32 life
    ) public {
        IWarrantVault.MandateParams memory p = _params();
        p.perTxCap = perTx;
        p.periodCap = period;
        p.totalCap = total;
        p.periodLength = length;
        p.expiry = uint48(block.timestamp + uint256(life));
        address[] memory ms = new address[](1);
        ms[0] = merchantA;
        IWarrantVault.MerchantRule[] memory rs = new IWarrantVault.MerchantRule[](1);
        rs[0] = _rule(true, 0, 0);
        bool valid =
            perTx > 0 && perTx <= period && period <= total && length > 0 && life > 0 && life <= 365 days;
        vm.prank(ownerAddr);
        if (valid) {
            uint256 mid = vault.createMandate(p, ms, rs);
            assertGt(mid, 0);
        } else {
            vm.expectRevert();
            vault.createMandate(p, ms, rs);
        }
    }

    function testFuzz_feeNeverExceedsOnePercent(uint256 amount, uint16 bps) public {
        bps = uint16(bound(bps, 0, 100));
        amount = bound(amount, 1, 5 * USD);
        factory.setFee(bps, treasury);
        IWarrantVault.PaymentIntent memory i = _intent(id, merchantA, amount, _ref(1));
        vault.pay(i, _sign(agentKey, i));
        assertLe(token.balanceOf(treasury), amount / 100);
        assertEq(token.balanceOf(treasury) + token.balanceOf(merchantA), amount);
        assertEq(token.balanceOf(address(vault)), 1_000 * USD - amount);
    }
}

/// @dev Random sequences of payments, time travel, revokes and freezes must never break the money rules.
contract Handler is Base {
    uint256 internal id;
    uint256 public ghostPaid;
    uint256 public ghostPaidA;
    uint256 public counter;
    uint256[] public payTimes;
    uint256[] public payAmounts;

    function payCount() external view returns (uint256) {
        return payTimes.length;
    }

    function init() external {
        super.setUp();
        id = _createDefault();
        vm.prank(ownerAddr);
        vault.setMerchantRule(id, merchantB, _rule(true, 1 * USD, 8 * USD));
    }

    function setUp() public override {}

    function v() external view returns (WarrantVault) {
        return vault;
    }

    function tok() external view returns (IERC20) {
        return token;
    }

    function mA() external view returns (address) {
        return merchantA;
    }

    function mB() external view returns (address) {
        return merchantB;
    }

    function pay(uint256 amount, bool toB) external {
        amount = bound(amount, 1, 6 * USD);
        address m = toB ? merchantB : merchantA;
        IWarrantVault.PaymentIntent memory i = _intent(id, m, amount, _ref(++counter));
        bytes memory sig = _sign(agentKey, i);
        try vault.pay(i, sig) {
            ghostPaid += amount;
            if (!toB) ghostPaidA += amount;
            payTimes.push(block.timestamp);
            payAmounts.push(amount);
        } catch {}
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 0, 14 hours));
    }

    function freezeToggle(bool f) external {
        vm.prank(ownerAddr);
        if (f) vault.freezeAll();
        else vault.unfreeze();
    }

    function withdrawSome(uint256 amount) external {
        amount = bound(amount, 0, vault.balance() / 4);
        vm.prank(ownerAddr);
        vault.withdraw(ownerAddr, amount);
    }
}

contract VaultInvariantTest is StdInvariant, Base {
    Handler internal h;

    function setUp() public override {
        h = new Handler();
        h.init();
        targetContract(address(h));
        bytes4[] memory sels = new bytes4[](4);
        sels[0] = Handler.pay.selector;
        sels[1] = Handler.warp.selector;
        sels[2] = Handler.freezeToggle.selector;
        sels[3] = Handler.withdrawSome.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sels}));
    }

    function invariant_neverSpendsMoreThanTotalCap() public view {
        IWarrantVault.Mandate memory m = h.v().getMandate(1);
        assertLe(m.spentTotal, m.params.totalCap);
    }

    /// @dev The rolling bound: for every payment, the spend in the `periodLength` ending at it (inclusive,
    ///      exclusive of the start) never exceeds periodCap. Fixed windows would fail this at window edges.
    function invariant_anyRollingPeriodStaysUnderPeriodCap() public view {
        IWarrantVault.MandateParams memory p = h.v().getMandate(1).params;
        uint256 n = h.payCount();
        for (uint256 j; j < n; ++j) {
            uint256 end = h.payTimes(j);
            uint256 sum;
            for (uint256 k; k <= j; ++k) {
                uint256 t = h.payTimes(k);
                if (t + p.periodLength > end) sum += h.payAmounts(k);
            }
            assertLe(sum, p.periodCap);
        }
    }

    function invariant_windowCounterNeverAbovePeriodCap() public view {
        assertLe(h.v().periodSpent(1), 20 * USD);
    }

    function invariant_merchantBCapsHold() public view {
        assertLe(h.v().merchantSpent(1, h.mB()), 8 * USD);
    }

    function invariant_bookkeepingEqualsBalances() public view {
        IWarrantVault.Mandate memory m = h.v().getMandate(1);
        assertEq(m.spentTotal, h.ghostPaid());
        assertEq(h.tok().balanceOf(h.mA()) + h.tok().balanceOf(h.mB()), h.ghostPaid());
    }
}
