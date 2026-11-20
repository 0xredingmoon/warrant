// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.t.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {IWarrantVault} from "../src/interfaces/IWarrantVault.sol";
import {WarrantVault} from "../src/WarrantVault.sol";
import {MockSmartAgent} from "./mocks/MockSmartAgent.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAgentRegistry} from "../src/interfaces/IAgentRegistry.sol";

contract AgentRegistryTest is Base {
    address internal agentOwner = makeAddr("agentOwner");
    uint256 internal agentId;
    uint256 internal mandateId;

    function setUp() public override {
        super.setUp();
        vm.prank(agentOwner);
        agentId = registry.register("ipfs://agent-card");
        _bindAgentWallet(agentId, agentAddr, agentKey);

        IWarrantVault.MandateParams memory p = _params();
        p.agentId = agentId;
        mandateId = _create(p, merchantA, _rule(true, 0, 0));
    }

    function _bindAgentWallet(uint256 id, address wallet, uint256 walletKey) internal {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(registry.AGENT_WALLET_TYPEHASH(), id, wallet, registry.ownerOf(id), deadline)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _registryDomain(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(walletKey, digest);
        vm.prank(registry.ownerOf(id));
        registry.setAgentWallet(id, wallet, deadline, abi.encodePacked(r, s, v));
    }

    function _registryDomain() internal view returns (bytes32) {
        (, string memory name, string memory version, uint256 chainId, address vc,,) = registry.eip712Domain();
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                chainId,
                vc
            )
        );
    }

    /*//////////////////////////// identity ////////////////////////////*/

    function test_register_mintsNftWithDefaultWalletAndUri() public {
        vm.expectEmit(true, true, false, true, address(registry));
        emit AgentRegistry.Registered(2, "ipfs://x", evil);
        vm.prank(evil);
        uint256 id = registry.register("ipfs://x");
        assertEq(id, 2);
        assertEq(registry.ownerOf(id), evil);
        assertEq(registry.getAgentWallet(id), evil);
        assertEq(registry.agentURI(id), "ipfs://x");
        assertEq(registry.tokenURI(id), "ipfs://x");
        assertEq(registry.totalAgents(), 2);
    }

    function test_register_variants() public {
        vm.startPrank(evil);
        uint256 a = registry.register();
        assertEq(registry.agentURI(a), "");
        AgentRegistry.MetadataEntry[] memory md = new AgentRegistry.MetadataEntry[](2);
        md[0] = AgentRegistry.MetadataEntry("model", bytes("gpt"));
        md[1] = AgentRegistry.MetadataEntry("version", hex"0102");
        uint256 b = registry.register("ipfs://b", md);
        vm.stopPrank();
        assertEq(string(registry.getMetadata(b, "model")), "gpt");
        assertEq(registry.getMetadata(b, "version"), hex"0102");
    }

    function test_register_uriTooLong() public {
        bytes memory big = new bytes(2049);
        for (uint256 i; i < big.length; ++i) {
            big[i] = "a";
        }
        vm.expectRevert(AgentRegistry.UriTooLong.selector);
        registry.register(string(big));
    }

    function test_setAgentURI_ownerOnly() public {
        vm.prank(agentOwner);
        registry.setAgentURI(agentId, "ipfs://v2");
        assertEq(registry.agentURI(agentId), "ipfs://v2");
        vm.prank(evil);
        vm.expectRevert(AgentRegistry.NotAgentOwner.selector);
        registry.setAgentURI(agentId, "ipfs://evil");
        vm.prank(evil);
        vm.expectRevert(AgentRegistry.AgentNotFound.selector);
        registry.setAgentURI(999, "x");
    }

    function test_metadata_setGet_andReservedKey() public {
        vm.startPrank(agentOwner);
        registry.setMetadata(agentId, "tier", hex"01");
        assertEq(registry.getMetadata(agentId, "tier"), hex"01");
        vm.expectRevert(AgentRegistry.ReservedMetadataKey.selector);
        registry.setMetadata(agentId, "agentWallet", abi.encodePacked(evil));
        vm.stopPrank();
        // the reserved key reads back the verified wallet
        assertEq(registry.getMetadata(agentId, "agentWallet"), abi.encodePacked(agentAddr));
        vm.expectRevert(AgentRegistry.AgentNotFound.selector);
        registry.getMetadata(404, "tier");
    }

    function test_setAgentWallet_requiresProofFromNewWallet() public {
        uint256 deadline = block.timestamp + 1 hours;
        (, uint256 otherKey) = makeAddrAndKey("someoneElse");
        bytes32 structHash = keccak256(
            abi.encode(registry.AGENT_WALLET_TYPEHASH(), agentId, evil, agentOwner, deadline)
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(otherKey, keccak256(abi.encodePacked("\x19\x01", _registryDomain(), structHash)));
        vm.prank(agentOwner);
        vm.expectRevert(AgentRegistry.InvalidWalletProof.selector); // `evil` never signed
        registry.setAgentWallet(agentId, evil, deadline, abi.encodePacked(r, s, v));
    }

    function test_setAgentWallet_expiredAndZeroAndNotOwner() public {
        vm.startPrank(agentOwner);
        vm.expectRevert(AgentRegistry.SignatureExpired.selector);
        registry.setAgentWallet(agentId, agentAddr, block.timestamp - 1, "");
        vm.expectRevert(AgentRegistry.ZeroAddress.selector);
        registry.setAgentWallet(agentId, address(0), block.timestamp + 1, "");
        vm.stopPrank();
        vm.prank(evil);
        vm.expectRevert(AgentRegistry.NotAgentOwner.selector);
        registry.setAgentWallet(agentId, agentAddr, block.timestamp + 1, "");
    }

    function test_setAgentWallet_smartContractWallet_erc1271() public {
        MockSmartAgent smart = new MockSmartAgent(agentAddr);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash =
            keccak256(abi.encode(registry.AGENT_WALLET_TYPEHASH(), agentId, address(smart), agentOwner, deadline));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(agentKey, keccak256(abi.encodePacked("\x19\x01", _registryDomain(), structHash)));
        vm.prank(agentOwner);
        registry.setAgentWallet(agentId, address(smart), deadline, abi.encodePacked(r, s, v));
        assertEq(registry.getAgentWallet(agentId), address(smart));
    }

    function test_unsetAgentWallet_andTransferClearsWallet() public {
        vm.prank(agentOwner);
        registry.unsetAgentWallet(agentId);
        assertEq(registry.getAgentWallet(agentId), address(0));

        _bindAgentWallet(agentId, agentAddr, agentKey);
        assertEq(registry.getAgentWallet(agentId), agentAddr);
        vm.prank(agentOwner);
        registry.transferFrom(agentOwner, evil, agentId);
        assertEq(registry.getAgentWallet(agentId), address(0)); // a sold agent doesn't keep its old wallet
    }

    function test_mandateBinding_walletClearedLaterBlocksNewMandates() public {
        vm.prank(agentOwner);
        registry.transferFrom(agentOwner, evil, agentId);
        IWarrantVault.MandateParams memory p = _params();
        p.agentId = agentId;
        address[] memory ms = new address[](1);
        ms[0] = merchantA;
        IWarrantVault.MerchantRule[] memory rs = new IWarrantVault.MerchantRule[](1);
        rs[0] = _rule(true, 0, 0);
        vm.prank(ownerAddr);
        vm.expectRevert(IWarrantVault.IdentityMismatch.selector);
        vault.createMandate(p, ms, rs);
    }

    /*//////////////////////////// receipts ////////////////////////////*/

    function test_payment_recordsReceiptOnRegistry() public {
        IWarrantVault.PaymentIntent memory i = _intent(mandateId, merchantA, 4 * USD, _ref(1));
        bytes32 rid = registry.receiptIdOf(address(vault), merchantA, _ref(1));
        vm.expectEmit(true, true, true, true, address(registry));
        emit AgentRegistry.ReceiptRecorded(rid, agentId, merchantA, address(vault), 4 * USD, _ref(1));
        vm.expectEmit(true, true, true, true, address(vault));
        emit IWarrantVault.PaymentExecuted(mandateId, merchantA, _ref(1), agentAddr, 4 * USD, 0, i.intentHash, rid);
        vault.pay(i, _sign(agentKey, i));

        AgentRegistry.Receipt memory r = registry.getReceipt(rid);
        assertTrue(r.exists);
        assertEq(r.agentId, agentId);
        assertEq(r.vault, address(vault));
        assertEq(r.merchant, merchantA);
        assertEq(r.amount, 4 * USD);
        (uint64 fc,, uint64 pc, uint256 vol) = registry.getSummary(agentId);
        assertEq(fc, 0);
        assertEq(pc, 1);
        assertEq(vol, 4 * USD);
    }

    function test_unboundMandate_recordsNothing() public {
        uint256 plain = _createDefault();
        _payOk(plain, merchantA, 1 * USD, _ref(9));
        (,, uint64 pc,) = registry.getSummary(agentId);
        assertEq(pc, 0);
    }

    function test_recordReceipt_onlyRegisteredVaults() public {
        vm.prank(evil);
        vm.expectRevert(AgentRegistry.NotVault.selector);
        registry.recordReceipt(agentId, evil, 1, _ref(1));
    }

    function test_registryFailureNeverBlocksPayment() public {
        // Burn the agent NFT's existence? Not possible; simulate a failing registry by deleting the registrant's
        // agent via an unregistered vault: use a vault created by a *different* factory that the registry doesn't know.
        WarrantFactoryLike f2 = WarrantFactoryLike(address(new Rogue(token, registry)));
        vm.prank(ownerAddr);
        WarrantVault rogueVault = WarrantVault(f2.createVault(guardian));
        _fund(address(rogueVault), 10 * USD);

        IWarrantVault.MandateParams memory p = _params();
        p.agentId = agentId;
        address[] memory ms = new address[](1);
        ms[0] = merchantA;
        IWarrantVault.MerchantRule[] memory rs = new IWarrantVault.MerchantRule[](1);
        rs[0] = _rule(true, 0, 0);
        vm.prank(ownerAddr);
        rogueVault.createMandate(p, ms, rs);

        IWarrantVault.PaymentIntent memory i = _intent(1, merchantA, 1 * USD, _ref(1));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentKey, rogueVault.hashIntent(i));
        vm.expectEmit(true, true, false, false, address(rogueVault));
        emit IWarrantVault.ReceiptNotRecorded(1, _ref(1));
        rogueVault.pay(i, abi.encodePacked(r, s, v));
        assertEq(token.balanceOf(merchantA), 1 * USD); // paid, receipt simply not recorded
        (,, uint64 pc,) = registry.getSummary(agentId);
        assertEq(pc, 0);
    }

    /*//////////////////////////// feedback ////////////////////////////*/

    function _paid(bytes32 ref, uint256 amount) internal returns (bytes32 rid) {
        IWarrantVault.PaymentIntent memory i = _intent(mandateId, merchantA, amount, ref);
        vault.pay(i, _sign(agentKey, i));
        rid = registry.receiptIdOf(address(vault), merchantA, ref);
    }

    function test_feedback_onlyPaidMerchant_once() public {
        bytes32 rid = _paid(_ref(1), 2 * USD);

        vm.prank(evil); // a random address can't rate
        vm.expectRevert(AgentRegistry.NotReceiptMerchant.selector);
        registry.giveFeedback(rid, 5, 0, "quality", "", "", bytes32(0));

        vm.expectEmit(true, true, true, true, address(registry));
        emit AgentRegistry.NewFeedback(agentId, merchantA, rid, 87, 0, "quality", "api", "ipfs://fb", keccak256("fb"));
        vm.prank(merchantA);
        registry.giveFeedback(rid, 87, 0, "quality", "api", "ipfs://fb", keccak256("fb"));

        AgentRegistry.Feedback memory f = registry.readFeedback(rid);
        assertTrue(f.given);
        assertEq(f.value, 87);
        assertEq(f.tag1, "quality");
        assertEq(f.tag2, "api");
        assertEq(f.feedbackURI, "ipfs://fb");

        vm.prank(merchantA);
        vm.expectRevert(AgentRegistry.FeedbackAlreadyGiven.selector);
        registry.giveFeedback(rid, 1, 0, "", "", "", bytes32(0));
    }

    function test_feedback_requiresRealReceipt() public {
        vm.prank(merchantA);
        vm.expectRevert(AgentRegistry.ReceiptNotFound.selector);
        registry.giveFeedback(bytes32(uint256(1234)), 5, 0, "", "", "", bytes32(0));
    }

    function test_feedback_summaryAveragesAcrossDecimals() public {
        bytes32 r1 = _paid(_ref(1), 1 * USD);
        bytes32 r2 = _paid(_ref(2), 2 * USD);
        bytes32 r3 = _paid(_ref(3), 3 * USD);
        vm.startPrank(merchantA);
        registry.giveFeedback(r1, 80, 0, "", "", "", bytes32(0)); // 80
        registry.giveFeedback(r2, 90, 0, "", "", "", bytes32(0)); // 90
        registry.giveFeedback(r3, 9_500, 2, "", "", "", bytes32(0)); // 95.00
        vm.stopPrank();
        (uint64 fc, int256 avg, uint64 pc, uint256 vol) = registry.getSummary(agentId);
        assertEq(fc, 3);
        assertEq(pc, 3);
        assertEq(vol, 6 * USD);
        assertEq(avg, int256(88333333333333333333)); // (80+90+95)/3 at 18 decimals, truncated
    }

    function test_feedback_negativeValuesAndRevoke() public {
        bytes32 r1 = _paid(_ref(1), 1 * USD);
        bytes32 r2 = _paid(_ref(2), 1 * USD);
        vm.startPrank(merchantA);
        registry.giveFeedback(r1, -50, 0, "scam", "", "", bytes32(0));
        registry.giveFeedback(r2, 100, 0, "", "", "", bytes32(0));
        (, int256 avg,,) = registry.getSummary(agentId);
        assertEq(avg, int256(25e18));

        vm.expectEmit(true, true, true, false, address(registry));
        emit AgentRegistry.FeedbackRevoked(agentId, merchantA, r1);
        registry.revokeFeedback(r1);
        (uint64 fc, int256 avg2,,) = registry.getSummary(agentId);
        assertEq(fc, 1);
        assertEq(avg2, int256(100e18));

        vm.expectRevert(AgentRegistry.FeedbackNotActive.selector);
        registry.revokeFeedback(r1);
        vm.expectRevert(AgentRegistry.FeedbackAlreadyGiven.selector); // can't re-rate the same receipt
        registry.giveFeedback(r1, 1, 0, "", "", "", bytes32(0));
        vm.stopPrank();
    }

    function test_revokeFeedback_guards() public {
        bytes32 rid = _paid(_ref(1), 1 * USD);
        vm.prank(merchantA);
        vm.expectRevert(AgentRegistry.FeedbackNotActive.selector);
        registry.revokeFeedback(rid); // nothing given yet
        vm.prank(evil);
        vm.expectRevert(AgentRegistry.NotReceiptMerchant.selector);
        registry.revokeFeedback(rid);
        vm.prank(merchantA);
        vm.expectRevert(AgentRegistry.ReceiptNotFound.selector);
        registry.revokeFeedback(bytes32(uint256(9)));
    }

    function test_feedback_decimalsBound() public {
        bytes32 rid = _paid(_ref(1), 1 * USD);
        vm.prank(merchantA);
        vm.expectRevert(AgentRegistry.InvalidDecimals.selector);
        registry.giveFeedback(rid, 1, 19, "", "", "", bytes32(0));
        vm.prank(merchantA);
        registry.giveFeedback(rid, 1, 18, "", "", "", bytes32(0)); // boundary ok
    }

    function test_feedback_noSelfDealing() public {
        // The agent's own owner sets up a mandate paying *themselves* and tries to rate their own agent.
        vm.prank(ownerAddr);
        vault.setMerchantRule(mandateId, agentOwner, _rule(true, 0, 0));
        IWarrantVault.PaymentIntent memory i = _intent(mandateId, agentOwner, 1 * USD, _ref(7));
        vault.pay(i, _sign(agentKey, i));
        bytes32 rid = registry.receiptIdOf(address(vault), agentOwner, _ref(7));
        vm.prank(agentOwner);
        vm.expectRevert(AgentRegistry.SelfFeedback.selector);
        registry.giveFeedback(rid, 100, 0, "", "", "", bytes32(0));

        // ...nor the agent's own signing wallet
        vm.prank(ownerAddr);
        vault.setMerchantRule(mandateId, agentAddr, _rule(true, 0, 0));
        IWarrantVault.PaymentIntent memory j = _intent(mandateId, agentAddr, 1 * USD, _ref(8));
        vault.pay(j, _sign(agentKey, j));
        bytes32 rid2 = registry.receiptIdOf(address(vault), agentAddr, _ref(8));
        vm.prank(agentAddr);
        vm.expectRevert(AgentRegistry.SelfFeedback.selector);
        registry.giveFeedback(rid2, 100, 0, "", "", "", bytes32(0));
    }

    function test_feedback_uriTooLong() public {
        bytes32 rid = _paid(_ref(1), 1 * USD);
        bytes memory big = new bytes(2049);
        for (uint256 i; i < big.length; ++i) {
            big[i] = "a";
        }
        vm.prank(merchantA);
        vm.expectRevert(AgentRegistry.UriTooLong.selector);
        registry.giveFeedback(rid, 1, 0, "", "", string(big), bytes32(0));
    }

    function testFuzz_summaryAverageMatchesManual(int64 a, int64 b, uint8 da, uint8 db) public {
        da = uint8(bound(da, 0, 18));
        db = uint8(bound(db, 0, 18));
        bytes32 r1 = _paid(_ref(1), 1 * USD);
        bytes32 r2 = _paid(_ref(2), 1 * USD);
        vm.startPrank(merchantA);
        registry.giveFeedback(r1, a, da, "", "", "", bytes32(0));
        registry.giveFeedback(r2, b, db, "", "", "", bytes32(0));
        vm.stopPrank();
        (, int256 avg,,) = registry.getSummary(agentId);
        int256 sum = int256(a) * int256(10 ** (18 - da)) + int256(b) * int256(10 ** (18 - db));
        assertEq(avg, sum / 2);
    }
}

interface WarrantFactoryLike {
    function createVault(address guardian) external returns (address);
}

/// @dev A factory the registry doesn't trust: its vaults can't record receipts.
contract Rogue {
    IERC20 internal immutable token;
    IAgentRegistry internal immutable registry;

    constructor(IERC20 t, AgentRegistry r) {
        token = t;
        registry = IAgentRegistry(address(r));
    }

    function createVault(address guardian) external returns (address) {
        return address(new WarrantVault(token, msg.sender, guardian, registry));
    }

    function feeConfig() external pure returns (uint16, address) {
        return (0, address(0));
    }
}
