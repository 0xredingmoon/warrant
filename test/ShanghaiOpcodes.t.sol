// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

/// @notice Aevum runs the Shanghai EVM. Code compiled for Cancun can deploy fine and then die with
///         `invalid opcode`. This scans the *runtime* bytecode of every shipped contract for opcodes that
///         don't exist on Shanghai: MCOPY (0x5e), TSTORE (0x5d), TLOAD (0x5c), BLOBHASH (0x49), BLOBBASEFEE (0x4a).
contract ShanghaiOpcodesTest is Test {
    function _scan(bytes memory code) internal pure returns (bool found, uint256 pc, uint8 op) {
        // strip the CBOR metadata (last two bytes = its length) so its bytes aren't read as opcodes
        uint256 end = code.length;
        if (end >= 2) {
            uint256 metaLen = (uint256(uint8(code[end - 2])) << 8) | uint256(uint8(code[end - 1]));
            if (metaLen + 2 <= end) end -= metaLen + 2;
        }
        uint256 i;
        while (i < end) {
            uint8 o = uint8(code[i]);
            if (o == 0x5c || o == 0x5d || o == 0x5e || o == 0x49 || o == 0x4a) return (true, i, o);
            // skip PUSH1..PUSH32 immediate data
            if (o >= 0x60 && o <= 0x7f) i += uint256(o) - 0x5f;
            ++i;
        }
        return (false, 0, 0);
    }

    function _check(string memory artifact) internal view {
        bytes memory code = vm.getDeployedCode(artifact);
        assertGt(code.length, 0, "no code");
        (bool found, uint256 pc, uint8 op) = _scan(code);
        assertFalse(
            found,
            string.concat(artifact, ": post-Shanghai opcode ", vm.toString(op), " at pc ", vm.toString(pc))
        );
    }

    function test_vaultHasNoCancunOpcodes() public view {
        _check("WarrantVault.sol:WarrantVault");
    }

    function test_factoryHasNoCancunOpcodes() public view {
        _check("WarrantFactory.sol:WarrantFactory");
    }

    function test_registryHasNoCancunOpcodes() public view {
        _check("AgentRegistry.sol:AgentRegistry");
    }

    /// @dev Guard the guard: the scanner must really flag the opcodes it claims to.
    function test_scannerDetectsForbiddenOpcodes() public pure {
        (bool f,, uint8 op) = _scan(hex"6001600052" hex"5d" hex"00");
        assertTrue(f);
        assertEq(op, 0x5d);
        (f,, op) = _scan(hex"605e00");
        assertFalse(f); // 0x5e here is PUSH1's immediate data, not an opcode
        (f,, op) = _scan(hex"5e");
        assertTrue(f);
        assertEq(op, 0x5e);
    }
}
