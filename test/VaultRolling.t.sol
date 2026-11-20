// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.t.sol";
import {IWarrantVault} from "../src/interfaces/IWarrantVault.sol";

/// @dev The spend window is rolling: no `periodLength` can contain more than `periodCap`.
contract VaultRollingTest is Base {
    uint256 internal id;
    uint256 internal n;

    function setUp() public override {
        super.setUp();
        id = _createDefault(); // perTx 5, period 20 per day, total 100
    }

    function _spend(uint256 amount) internal {
        _payOk(id, merchantA, amount, _ref(++n));
    }

    function _refused(uint256 amount) internal view returns (bool) {
        return vault.checkTerms(id, merchantA, amount, _ref(n + 1000))
            == IWarrantVault.Reason.ExceedsPeriodCap;
    }

    /// @dev The classic fixed-window hole: fill the cap just before a boundary, again just after.
    function test_noDoubleBurstAcrossWhatWouldBeAWindowEdge() public {
        uint256 start = T0 + 1 days - 30 minutes; // just before where a fixed window would end
        vm.warp(start);
        for (uint256 k; k < 4; ++k) _spend(5 * USD); // 20 = periodCap
        vm.warp(start + 31 minutes); // fixed windows would have reset here
        assertTrue(_refused(1));
        assertEq(vault.remainingAllowance(id, merchantA), 0);
        vm.warp(start + 1 days - 1);
        assertTrue(_refused(1));
        vm.warp(start + 1 days + 3 hours);
        assertEq(vault.remainingAllowance(id, merchantA), 5 * USD);
    }

    function test_partialRelease_oldSpendRollsOffFirst() public {
        vm.warp(T0);
        _spend(5 * USD);
        vm.warp(T0 + 12 hours);
        _spend(5 * USD);
        _spend(5 * USD);
        _spend(5 * USD); // 20 inside one day
        assertEq(vault.periodSpent(id), 20 * USD);

        (uint256 amt, uint256 at) = vault.nextRelease(id);
        assertEq(amt, 5 * USD);
        assertGe(at, T0 + 1 days);
        assertLe(at, T0 + 1 days + 3 hours);

        vm.warp(at); // the first 5 stop counting, the later 15 still do
        assertEq(vault.periodSpent(id), 15 * USD);
        assertEq(vault.remainingAllowance(id, merchantA), 5 * USD);
        (amt, at) = vault.nextRelease(id);
        assertEq(amt, 15 * USD);
    }

    function test_spendCountsForAtLeastTheFullPeriod() public {
        vm.warp(T0 + 777);
        _spend(5 * USD);
        for (uint256 dt = 0; dt < 1 days; dt += 1 hours + 7 minutes) {
            vm.warp(T0 + 777 + dt);
            assertGe(vault.periodSpent(id), 5 * USD);
        }
        vm.warp(T0 + 777 + 1 days - 1);
        assertEq(vault.periodSpent(id), 5 * USD);
        vm.warp(T0 + 777 + 1 days + 3 hours);
        assertEq(vault.periodSpent(id), 0);
    }

    function test_tinyPeriod_bucketSizeOneSecond() public {
        IWarrantVault.MandateParams memory p = _params();
        p.periodLength = 8;
        p.perTxCap = uint128(2 * USD);
        p.periodCap = uint128(4 * USD);
        uint256 id2 = _create(p, merchantA, _rule(true, 0, 0));
        vm.warp(T0 + 100);
        _payOk(id2, merchantA, 2 * USD, _ref(1));
        _payOk(id2, merchantA, 2 * USD, _ref(2));
        assertEq(vault.remainingAllowance(id2, merchantA), 0);
        vm.warp(T0 + 100 + 7);
        assertEq(vault.remainingAllowance(id2, merchantA), 0);
        vm.warp(T0 + 100 + 9);
        assertEq(vault.remainingAllowance(id2, merchantA), 2 * USD);
    }

    function test_periodShorterThanBuckets_stillBounded() public {
        IWarrantVault.MandateParams memory p = _params();
        p.periodLength = 3; // bucket size ceil(3/8) = 1
        p.perTxCap = uint128(1 * USD);
        p.periodCap = uint128(1 * USD);
        uint256 id2 = _create(p, merchantA, _rule(true, 0, 0));
        vm.warp(T0 + 50);
        _payOk(id2, merchantA, 1 * USD, _ref(1));
        vm.warp(T0 + 52);
        assertEq(vault.remainingAllowance(id2, merchantA), 0);
        vm.warp(T0 + 54);
        assertEq(vault.remainingAllowance(id2, merchantA), 1 * USD);
    }

    function test_yearLongPeriod() public {
        IWarrantVault.MandateParams memory p = _params();
        p.periodLength = uint32(365 days);
        p.expiry = uint48(block.timestamp + 365 days);
        uint256 id2 = _create(p, merchantA, _rule(true, 0, 0));
        for (uint256 k; k < 20; ++k) {
            vm.warp(block.timestamp + 10 days);
            if (k < 4) _payOk(id2, merchantA, 5 * USD, _ref(k + 1));
        }
        assertEq(vault.remainingAllowance(id2, merchantA), 0); // 20 spent inside the year
    }

    /// @dev Slot reuse: after more than 9 buckets of silence the ring slots hold stale buckets.
    function testFuzz_ringSlotReuseNeverLeaksOrLoses(uint256 gap1, uint256 gap2) public {
        gap1 = bound(gap1, 0, 3 days);
        gap2 = bound(gap2, 0, 3 days);
        vm.warp(T0);
        _spend(5 * USD);
        uint256 t1 = block.timestamp;
        vm.warp(t1 + gap1);
        _spend(5 * USD);
        uint256 t2 = block.timestamp;
        vm.warp(t2 + gap2);
        uint256 expected;
        if (t1 + 1 days > block.timestamp) expected += 5 * USD; // definitely inside the window
        if (t2 + 1 days > block.timestamp) expected += 5 * USD;
        uint256 got = vault.periodSpent(id);
        assertGe(got, expected); // never loses a spend that is inside the true window
        assertLe(got, 10 * USD);
        // and never counts a spend older than one bucket past the window
        if (block.timestamp >= t2 + 1 days + 3 hours) assertEq(got, 0);
    }

    /// @dev Over random schedules no true rolling window exceeds the cap.
    function testFuzz_randomSchedule_neverExceedsCapInAnyDay(uint256[8] memory gaps, uint256[8] memory amts)
        public
    {
        uint256[] memory times = new uint256[](8);
        uint256[] memory paid = new uint256[](8);
        uint256 count;
        for (uint256 k; k < 8; ++k) {
            vm.warp(block.timestamp + bound(gaps[k], 0, 9 hours));
            uint256 a = bound(amts[k], 1, 5 * USD);
            IWarrantVault.PaymentIntent memory i = _intent(id, merchantA, a, _ref(++n));
            bytes memory sig = _sign(agentKey, i);
            if (vault.check(i, sig) == IWarrantVault.Reason.Ok) {
                vault.pay(i, sig);
                times[count] = block.timestamp;
                paid[count++] = a;
            }
        }
        for (uint256 j; j < count; ++j) {
            uint256 sum;
            for (uint256 k; k <= j; ++k) {
                if (times[k] + 1 days > times[j]) sum += paid[k];
            }
            assertLe(sum, 20 * USD);
        }
    }
}
