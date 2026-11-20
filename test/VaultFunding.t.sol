// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.t.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IWarrantVault} from "../src/interfaces/IWarrantVault.sol";
import {WarrantVault} from "../src/WarrantVault.sol";
import {MockUSD8} from "./mocks/MockUSD8.sol";
import {EvilToken, IReenter} from "./mocks/EvilToken.sol";

contract VaultFundingTest is Base {
    address internal funder;
    uint256 internal funderKey;

    function setUp() public override {
        super.setUp();
        (funder, funderKey) = makeAddrAndKey("funder");
        _fund(funder, 500 * USD);
    }

    function test_deposit_byAllowance() public {
        vm.startPrank(funder);
        token.approve(address(vault), 50 * USD);
        vm.expectEmit(true, false, false, true, address(vault));
        emit IWarrantVault.Deposited(funder, 50 * USD);
        vault.deposit(50 * USD);
        vm.stopPrank();
        assertEq(vault.balance(), 1_050 * USD);
        assertEq(token.balanceOf(funder), 450 * USD);
    }

    function test_deposit_withoutAllowanceReverts() public {
        vm.prank(funder);
        vm.expectRevert();
        vault.deposit(1 * USD);
    }

    function test_depositWithAuthorization_gaslessViaRelayer() public {
        MockUSD8 t = MockUSD8(address(token));
        bytes32 nonce = keccak256("auth-1");
        uint256 validAfter = block.timestamp - 1;
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                t.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                funder,
                address(vault),
                25 * USD,
                validAfter,
                validBefore,
                nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", t.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(funderKey, digest);

        assertEq(funder.balance, 0); // the signer holds no native gas at all
        vm.expectEmit(true, false, false, true, address(vault));
        emit IWarrantVault.Deposited(funder, 25 * USD);
        vm.prank(relayer);
        vault.depositWithAuthorization(funder, 25 * USD, validAfter, validBefore, nonce, v, r, s);
        assertEq(vault.balance(), 1_025 * USD);
        assertEq(token.balanceOf(funder), 475 * USD);
        assertTrue(t.authorizationState(funder, nonce));

        vm.expectRevert(); // single use
        vault.depositWithAuthorization(funder, 25 * USD, validAfter, validBefore, nonce, v, r, s);
    }

    function test_depositWithAuthorization_authorizedToAnotherPayeeFails() public {
        MockUSD8 t = MockUSD8(address(token));
        bytes32 nonce = keccak256("auth-2");
        uint256 validBefore = block.timestamp + 1 hours;
        // The funder authorised a transfer to *evil*; the vault can't use it.
        bytes32 structHash = keccak256(
            abi.encode(t.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), funder, evil, 25 * USD, 0, validBefore, nonce)
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(funderKey, keccak256(abi.encodePacked("\x19\x01", t.DOMAIN_SEPARATOR(), structHash)));
        vm.expectRevert();
        vault.depositWithAuthorization(funder, 25 * USD, 0, validBefore, nonce, v, r, s);
    }

    function _permit(uint256 value, uint256 deadline) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        MockUSD8 t = MockUSD8(address(token));
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                funder,
                address(vault),
                value,
                t.nonces(funder),
                deadline
            )
        );
        (v, r, s) =
            vm.sign(funderKey, keccak256(abi.encodePacked("\x19\x01", t.DOMAIN_SEPARATOR(), structHash)));
    }

    function test_depositWithPermit_gaslessViaRelayer() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permit(40 * USD, deadline);
        vm.prank(relayer);
        vault.depositWithPermit(funder, 40 * USD, deadline, v, r, s);
        assertEq(vault.balance(), 1_040 * USD);
        assertEq(token.allowance(funder, address(vault)), 0);
    }

    function test_depositWithPermit_frontRunPermit_relayerCannotUseStandingAllowance() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permit(40 * USD, deadline);
        // An attacker front-runs the permit on the token directly. The relayed call then can't re-use it...
        MockUSD8(address(token)).permit(funder, address(vault), 40 * USD, deadline, v, r, s);
        vm.prank(relayer);
        vm.expectRevert(IWarrantVault.Unauthorized.selector); // ...and a relayer must not spend a standing approval
        vault.depositWithPermit(funder, 40 * USD, deadline, v, r, s);
        // The funder can still finish it themselves on the existing allowance.
        vm.prank(funder);
        vault.depositWithPermit(funder, 40 * USD, deadline, v, r, s);
        assertEq(vault.balance(), 1_040 * USD);
    }

    function test_depositWithPermit_badSignatureReverts() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permit(40 * USD, deadline);
        vm.prank(relayer);
        vm.expectRevert(IWarrantVault.Unauthorized.selector);
        vault.depositWithPermit(funder, 41 * USD, deadline, v, r, s); // signed 40, asks 41
    }

    function test_plainTransferAlsoWorks() public {
        vm.prank(funder);
        token.transfer(address(vault), 10 * USD);
        assertEq(vault.balance(), 1_010 * USD);
    }

    function test_withdraw_ownerOnly_toAnyAddress() public {
        vm.prank(ownerAddr);
        vm.expectEmit(true, false, false, true, address(vault));
        emit IWarrantVault.Withdrawn(funder, 100 * USD);
        vault.withdraw(funder, 100 * USD);
        assertEq(token.balanceOf(funder), 600 * USD);

        vm.prank(agentAddr);
        vm.expectRevert(IWarrantVault.Unauthorized.selector);
        vault.withdraw(agentAddr, 1);
        vm.prank(guardian);
        vm.expectRevert(IWarrantVault.Unauthorized.selector);
        vault.withdraw(guardian, 1);
        vm.prank(ownerAddr);
        vm.expectRevert(IWarrantVault.ZeroAddress.selector);
        vault.withdraw(address(0), 1);
    }

    function test_withdraw_cannotExceedBalance() public {
        vm.prank(ownerAddr);
        vm.expectRevert();
        vault.withdraw(ownerAddr, 1_001 * USD);
    }

    function test_rescueERC20_otherTokensOnly() public {
        MockUSD8 other = new MockUSD8();
        other.mint(address(vault), 7 * USD);
        vm.prank(ownerAddr);
        vault.rescueERC20(IERC20(address(other)), ownerAddr, 7 * USD);
        assertEq(other.balanceOf(ownerAddr), 7 * USD);

        vm.prank(ownerAddr);
        vm.expectRevert(IWarrantVault.CannotRescueVaultToken.selector);
        vault.rescueERC20(token, ownerAddr, 1);
        vm.prank(evil);
        vm.expectRevert(IWarrantVault.Unauthorized.selector);
        vault.rescueERC20(IERC20(address(other)), evil, 1);
    }

    function test_vaultRejectsNativeValue() public {
        (bool ok,) = address(vault).call{value: 1}("");
        assertFalse(ok);
    }
}

/// @dev A malicious merchant contract that re-enters the vault from the token callback.
contract ReenteringMerchant is IReenter {
    WarrantVault public vault;
    IWarrantVault.PaymentIntent public intent;
    bytes public sig;
    bool public reentered;
    bool public reentrySucceeded;

    function arm(WarrantVault v, IWarrantVault.PaymentIntent memory i, bytes memory s) external {
        vault = v;
        intent = i;
        sig = s;
    }

    function onTokenTransfer() external {
        reentered = true;
        try vault.pay(intent, sig) {
            reentrySucceeded = true;
        } catch {}
    }
}

contract VaultReentrancyTest is Base {
    EvilToken internal evilToken;
    ReenteringMerchant internal mal;

    function _deployToken() internal override {
        evilToken = new EvilToken();
        token = IERC20(address(evilToken));
    }

    function _mintTo(address to, uint256 amount) internal override {
        evilToken.mint(to, amount);
    }

    function test_merchantCannotReenterPayFromTokenCallback() public {
        mal = new ReenteringMerchant();
        evilToken.setTarget(address(vault));
        uint256 id = _create(_params(), address(mal), _rule(true, 0, 0));

        IWarrantVault.PaymentIntent memory first = _intent(id, address(mal), 1 * USD, _ref(1));
        IWarrantVault.PaymentIntent memory second = _intent(id, address(mal), 1 * USD, _ref(2));
        mal.arm(vault, second, _sign(agentKey, second));

        vault.pay(first, _sign(agentKey, first));
        assertTrue(mal.reentered());
        assertFalse(mal.reentrySucceeded()); // ReentrancyGuard held
        assertEq(token.balanceOf(address(mal)), 1 * USD); // paid once, not twice
        assertEq(vault.getMandate(id).spentTotal, 1 * USD);
    }
}
