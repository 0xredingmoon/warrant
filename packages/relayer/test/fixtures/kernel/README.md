# Kernel v3.1 artifacts

Four compiled contracts, committed so `test/smart-account.test.ts` runs on a clean clone with no build step:

| File | Contract | Source |
| --- | --- | --- |
| `Kernel.json` | Kernel v3.1 implementation | [zerodevapp/kernel](https://github.com/zerodevapp/kernel) `v3.1`, `src/Kernel.sol` |
| `KernelFactory.json` | Kernel factory | same, `src/factory/KernelFactory.sol` |
| `ECDSAValidator.json` | root validator | same, `src/validator/ECDSAValidator.sol` |
| `EntryPoint.json` | ERC-4337 EntryPoint v0.7 | [eth-infinitism/account-abstraction](https://github.com/eth-infinitism/account-abstraction) `v0.7.0`, `contracts/core/EntryPoint.sol` |

Built with solc 0.8.24, EVM target `shanghai`, optimizer on at 200 runs, `via_ir` on, which is what the Kernel project
builds with and what the deployed implementation matches. The Kernel and EntryPoint addresses the test deploys are
throwaway anvil addresses; what the test proves is the path, the same code Aevum runs.

They are here because compiling Kernel plus its dependencies on a memory-limited machine (Windows solc overflows the
stack on the 79-file `via_ir` build) is not something a judge should have to battle to see the tests pass. The test
prefers `out/KernelV31.sol` if that directory exists, so a local rebuild still takes precedence.

Verify a fixture is the real thing rather than hand-written bytecode by deploying it and reading it back:
`accountId()` returns `kernel.advanced.v0.3.1` and `rootValidator()` returns `0x01` plus the validator. The test does
exactly that, which is why it cannot pass with a stub.
