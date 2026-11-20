// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "../Base.t.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {IWarrantVault} from "../../src/interfaces/IWarrantVault.sol";
import {AgentRegistry} from "../../src/AgentRegistry.sol";

/// @notice Runs Warrant against the **real tUSD8 on Aevum testnet** (chain 44005) on a local fork, with the
///         EVM pinned to Shanghai. Nothing is sent to the real network. Skipped if the RPC is unreachable.
///         Override the endpoint with AEVUM_RPC_URL.
contract AevumForkTest is Base {
    address internal constant TUSD8 = 0x456569838f1d43009A91ebA4263147Afd7233483;
    bytes32 internal constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    address internal funder;
    uint256 internal funderKey;

    function _deployToken() internal override {
        string memory url = vm.envOr("AEVUM_RPC_URL", string("https://rpc-test.qday.info"));
        try vm.createSelectFork(url) {}
        catch {
            vm.skip(true);
        }
        require(block.chainid == 44005, "not Aevum testnet");
        token = IERC20(TUSD8);
    }

    function _mintTo(address to, uint256 amount) internal override {
        deal(TUSD8, to, amount, true);
    }

    function setUp() public override {
        super.setUp();
        (funder, funderKey) = makeAddrAndKey("fork-funder");
        _fund(funder, 500 * USD);
    }

    /*//////////////////////////// the token we depend on ////////////////////////////*/

    function test_fork_tUSD8_isWhatWeExpect() public view {
        assertEq(block.chainid, 44005);
        assertEq(IERC20Metadata(TUSD8).decimals(), 6);
        assertEq(IERC20Metadata(TUSD8).symbol(), "tUSD8");
        assertEq(IERC20Metadata(TUSD8).name(), "tUSD8");
        assertGt(IERC20(TUSD8).totalSupply(), 0);
        assertTrue(IERC20Permit(TUSD8).DOMAIN_SEPARATOR() != bytes32(0));
    }

    function test_fork_tUSD8_domainIsNameTUSD8Version2() public view {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("tUSD8"),
                keccak256("2"),
                uint256(44005),
                TUSD8
            )
        );
        assertEq(IERC20Permit(TUSD8).DOMAIN_SEPARATOR(), expected);
    }

    /*//////////////////////////// deployment on the real EVM rules ////////////////////////////*/

    function test_fork_protocolDeploysAndRuns_underShanghai() public view {
        assertGt(address(factory).code.length, 0);
        assertGt(address(registry).code.length, 0);
        assertGt(address(vault).code.length, 0);
        assertEq(vault.owner(), ownerAddr);
        assertEq(address(vault.token()), TUSD8);
    }

    /*//////////////////////////// gasless deposit with the real token ////////////////////////////*/

    function test_fork_depositWithAuthorization_realTUSD8() public {
        bytes32 nonce = keccak256("fork-auth-1");
        uint256 validAfter = block.timestamp - 1;
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(RECEIVE_TYPEHASH, funder, address(vault), 25 * USD, validAfter, validBefore, nonce)
        );
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", IERC20Permit(TUSD8).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(funderKey, digest);

        uint256 before = vault.balance();
        assertEq(funder.balance, 0, "signer has no native gas");
        vm.prank(relayer);
        vault.depositWithAuthorization(funder, 25 * USD, validAfter, validBefore, nonce, v, r, s);
        assertEq(vault.balance(), before + 25 * USD);
        assertEq(IERC20(TUSD8).balanceOf(funder), 475 * USD);

        vm.expectRevert(); // nonce is single use on the real token too
        vault.depositWithAuthorization(funder, 25 * USD, validAfter, validBefore, nonce, v, r, s);
    }

    function test_fork_depositWithAuthorization_wrongPayeeRejectedByRealToken() public {
        bytes32 nonce = keccak256("fork-auth-2");
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 structHash =
            keccak256(abi.encode(RECEIVE_TYPEHASH, funder, evil, 5 * USD, 0, validBefore, nonce));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            funderKey,
            keccak256(abi.encodePacked("\x19\x01", IERC20Permit(TUSD8).DOMAIN_SEPARATOR(), structHash))
        );
        vm.expectRevert();
        vault.depositWithAuthorization(funder, 5 * USD, 0, validBefore, nonce, v, r, s);
    }

    function test_fork_depositWithPermit_realTUSD8() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                PERMIT_TYPEHASH,
                funder,
                address(vault),
                40 * USD,
                IERC20Permit(TUSD8).nonces(funder),
                deadline
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            funderKey,
            keccak256(abi.encodePacked("\x19\x01", IERC20Permit(TUSD8).DOMAIN_SEPARATOR(), structHash))
        );
        uint256 before = vault.balance();
        vm.prank(relayer);
        vault.depositWithPermit(funder, 40 * USD, deadline, v, r, s);
        assertEq(vault.balance(), before + 40 * USD);
    }

    /*//////////////////////////// the whole story on the real token ////////////////////////////*/

    uint256 internal agentId_;
    uint256 internal mandateId_;

    function _registerBoundAgent() internal {
        address agentOwner = makeAddr("agentOwner");
        vm.prank(agentOwner);
        agentId_ = registry.register("ipfs://warrant-demo-agent");
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 sh = keccak256(
            abi.encode(registry.AGENT_WALLET_TYPEHASH(), agentId_, agentAddr, agentOwner, deadline)
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(agentKey, keccak256(abi.encodePacked("\x19\x01", _registryDomain(), sh)));
        vm.prank(agentOwner);
        registry.setAgentWallet(agentId_, agentAddr, deadline, abi.encodePacked(r, s, v));
    }

    function _registryDomain() internal view returns (bytes32) {
        (, string memory n, string memory ver, uint256 cid, address vc,,) = registry.eip712Domain();
        return keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes(n)),
                keccak256(bytes(ver)),
                cid,
                vc
            )
        );
    }

    function _approveBySig(uint256 pid) internal {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, vault.hashApproval(pid, deadline));
        vm.prank(relayer);
        vault.approveBySig(pid, deadline, abi.encodePacked(r, s, v));
    }

    function test_fork_endToEnd_mandate_pay_queue_approve_revoke_feedback() public {
        factory.setFee(25, treasury); // 0.25% fee on the merchant side
        _registerBoundAgent();

        // mandate: 5/tx, 20/day, 100 total, co-sign from 3
        IWarrantVault.MandateParams memory p = _params();
        p.agentId = agentId_;
        p.approvalThreshold = uint128(3 * USD);
        p.approvalWindow = 1 days;
        mandateId_ = _create(p, merchantA, _rule(true, 0, 0));

        _smallPaymentAndInjection();
        _bigPaymentNeedsCoSign();
        _feedbackAndReputation();
        _revokeAndWithdraw();
    }

    function _smallPaymentAndInjection() internal {
        // small payment executes instantly, fee goes to treasury
        IWarrantVault.PaymentIntent memory small = _intent(mandateId_, merchantA, 2 * USD, _ref(1));
        uint256 treasuryBefore = IERC20(TUSD8).balanceOf(treasury);
        uint256 merchantBefore = IERC20(TUSD8).balanceOf(merchantA);
        vm.prank(relayer);
        vault.pay(small, _sign(agentKey, small));
        assertEq(IERC20(TUSD8).balanceOf(merchantA) - merchantBefore, 2 * USD - 5_000);
        assertEq(IERC20(TUSD8).balanceOf(treasury) - treasuryBefore, 5_000);

        // prompt-injection attempt: unlisted merchant is refused, funds unchanged
        IWarrantVault.PaymentIntent memory attack = _intent(mandateId_, evil, 1 * USD, _ref(2));
        bytes memory attackSig = _sign(agentKey, attack);
        _expectReject(IWarrantVault.Reason.MerchantNotAllowed);
        vault.pay(attack, attackSig);
        assertEq(IERC20(TUSD8).balanceOf(evil), 0);
    }

    function _bigPaymentNeedsCoSign() internal {
        IWarrantVault.PaymentIntent memory big = _intent(mandateId_, merchantA, 4 * USD, _ref(3));
        (, uint256 pid) = _pay(big);
        assertEq(pid, 1);
        _approveBySig(pid);
        assertEq(vault.getMandate(mandateId_).spentTotal, 6 * USD);
    }

    function _feedbackAndReputation() internal {
        bytes32 rid = registry.receiptIdOf(address(vault), merchantA, _ref(3));
        vm.prank(merchantA);
        registry.giveFeedback(rid, 95, 0, "delivery", "", "ipfs://fb", keccak256("fb"));
        (uint64 fc, int256 avg, uint64 pc, uint256 vol) = registry.getSummary(agentId_);
        assertEq(fc, 1);
        assertEq(avg, 95e18);
        assertEq(pc, 2);
        assertEq(vol, 6 * USD);
    }

    function _revokeAndWithdraw() internal {
        vm.prank(guardian);
        vault.revokeMandate(mandateId_);
        IWarrantVault.PaymentIntent memory after_ = _intent(mandateId_, merchantA, 1 * USD, _ref(4));
        bytes memory afterSig = _sign(agentKey, after_);
        assertEq(uint8(vault.check(after_, afterSig)), uint8(IWarrantVault.Reason.MandateRevoked));

        uint256 left = vault.balance();
        vm.prank(ownerAddr);
        vault.withdraw(ownerAddr, left);
        assertEq(IERC20(TUSD8).balanceOf(address(vault)), 0);
        assertEq(IERC20(TUSD8).balanceOf(ownerAddr), left);
    }

    function test_fork_emptyVault_rejectsCleanly_nothingBooked() public {
        // A payment the vault can't cover is refused up front and books nothing: the invoice stays payable.
        uint256 id = _createDefault();
        vm.prank(ownerAddr);
        vault.withdraw(ownerAddr, 1_000 * USD); // vault empty
        IWarrantVault.PaymentIntent memory i = _intent(id, merchantA, 1 * USD, _ref(1));
        bytes memory sig = _sign(agentKey, i);
        _expectReject(IWarrantVault.Reason.InsufficientBalance);
        vault.pay(i, sig);
        assertEq(vault.getMandate(id).spentTotal, 0);
        assertEq(uint8(vault.invoiceState(merchantA, _ref(1))), uint8(IWarrantVault.InvoiceState.None));
    }
}
