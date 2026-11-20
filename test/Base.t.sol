// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {WarrantVault} from "../src/WarrantVault.sol";
import {WarrantFactory} from "../src/WarrantFactory.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {IWarrantVault} from "../src/interfaces/IWarrantVault.sol";
import {IAgentRegistry} from "../src/interfaces/IAgentRegistry.sol";
import {MockUSD8} from "./mocks/MockUSD8.sol";

/// @dev Shared fixtures. `USD` is one tUSD8 (6 decimals).
abstract contract Base is Test {
    uint256 internal constant USD = 1e6;
    uint256 internal constant T0 = 1_800_000_000;

    IERC20 internal token;
    AgentRegistry internal registry;
    WarrantFactory internal factory;
    WarrantVault internal vault;

    address internal ownerAddr;
    uint256 internal ownerKey;
    address internal agentAddr;
    uint256 internal agentKey;
    address internal guardian = makeAddr("guardian");
    address internal merchantA = makeAddr("merchantA");
    address internal merchantB = makeAddr("merchantB");
    address internal evil = makeAddr("evil");
    address internal relayer = makeAddr("relayer");
    address internal treasury = makeAddr("treasury");

    function setUp() public virtual {
        vm.warp(T0);
        (ownerAddr, ownerKey) = makeAddrAndKey("owner");
        (agentAddr, agentKey) = makeAddrAndKey("agent");
        _deployToken();
        _deployProtocol(0);
        vm.prank(ownerAddr);
        vault = WarrantVault(factory.createVault(guardian, bytes32(0)));
        _fund(address(vault), 1_000 * USD);
    }

    /*//////////////////////////// hooks ////////////////////////////*/

    function _deployToken() internal virtual {
        token = IERC20(address(new MockUSD8()));
    }

    function _mintTo(address to, uint256 amount) internal virtual {
        MockUSD8(address(token)).mint(to, amount);
    }

    function _fund(address to, uint256 amount) internal {
        _mintTo(to, amount);
    }

    function _deployProtocol(uint16 feeBps) internal {
        registry = new AgentRegistry();
        factory = new WarrantFactory(token, IAgentRegistry(address(registry)), address(this), treasury, feeBps);
        registry.setFactory(address(factory));
    }

    /*//////////////////////////// builders ////////////////////////////*/

    function _params() internal view returns (IWarrantVault.MandateParams memory p) {
        p = IWarrantVault.MandateParams({
            agent: agentAddr,
            agentId: 0,
            perTxCap: uint128(5 * USD),
            periodCap: uint128(20 * USD),
            totalCap: uint128(100 * USD),
            periodLength: 1 days,
            validAfter: uint48(block.timestamp),
            expiry: uint48(block.timestamp + 7 days),
            approvalThreshold: 0,
            approvalWindow: 0
        });
    }

    function _rule(bool allowed, uint256 perTx, uint256 total) internal pure returns (IWarrantVault.MerchantRule memory) {
        return IWarrantVault.MerchantRule({allowed: allowed, perTxCap: uint128(perTx), totalCap: uint128(total)});
    }

    function _create(IWarrantVault.MandateParams memory p, address merchant, IWarrantVault.MerchantRule memory r)
        internal
        returns (uint256 id)
    {
        address[] memory ms = new address[](1);
        ms[0] = merchant;
        IWarrantVault.MerchantRule[] memory rs = new IWarrantVault.MerchantRule[](1);
        rs[0] = r;
        vm.prank(ownerAddr);
        id = vault.createMandate(p, ms, rs);
    }

    /// @dev Default mandate paying merchantA with no extra per-merchant caps.
    function _createDefault() internal returns (uint256) {
        return _create(_params(), merchantA, _rule(true, 0, 0));
    }

    function _intent(uint256 mandateId, address merchant, uint256 amount, bytes32 invoiceRef)
        internal
        view
        returns (IWarrantVault.PaymentIntent memory i)
    {
        i = IWarrantVault.PaymentIntent({
            mandateId: mandateId,
            merchant: merchant,
            amount: amount,
            invoiceRef: invoiceRef,
            intentHash: keccak256(abi.encode("why", invoiceRef)),
            nonce: keccak256(abi.encode("nonce", mandateId, merchant, invoiceRef, amount)),
            deadline: block.timestamp + 10 minutes
        });
    }

    function _sign(uint256 key, IWarrantVault.PaymentIntent memory i) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, vault.hashIntent(i));
        return abi.encodePacked(r, s, v);
    }

    /// @dev Sign with the agent key and submit through a relayer.
    function _pay(IWarrantVault.PaymentIntent memory i) internal returns (IWarrantVault.Reason r, uint256 pid) {
        bytes memory sig = _sign(agentKey, i);
        vm.prank(relayer);
        (r, pid) = vault.pay(i, sig);
    }

    function _payOk(uint256 mandateId, address merchant, uint256 amount, bytes32 ref) internal {
        (IWarrantVault.Reason r,) = _pay(_intent(mandateId, merchant, amount, ref));
        assertEq(uint8(r), uint8(IWarrantVault.Reason.Ok));
    }

    function _expectReject(IWarrantVault.Reason reason) internal {
        vm.expectRevert(abi.encodeWithSelector(IWarrantVault.PaymentRejected.selector, reason));
    }

    function _ref(uint256 n) internal pure returns (bytes32) {
        return bytes32(n);
    }
}
