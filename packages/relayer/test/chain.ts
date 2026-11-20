import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { createPublicClient, createWalletClient, getAddress, http, parseEventLogs, type Address, type Hex, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { warrantFactoryAbi } from "@warrant/sdk";

const OUT = join(__dirname, "../../../out");
const artifact = (file: string, name: string) => JSON.parse(readFileSync(join(OUT, file, `${name}.json`), "utf8")) as { abi: any; bytecode: { object: Hex } };

export const hasAnvil = (() => {
  try {
    return require("node:child_process").spawnSync("anvil", ["--version"]).status === 0;
  } catch {
    return false;
  }
})();

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as any).port;
      s.close(() => resolve(p));
    });
  });

/** Spawn a fresh anvil (chain 44005) and deploy the protocol with a mock tUSD8. */
export interface TestChain {
  rpcUrl: string;
  chain: any;
  publicClient: PublicClient;
  deployer: { account: PrivateKeyAccount; wallet: any };
  owner: { account: PrivateKeyAccount; wallet: any };
  token: Address;
  registry: Address;
  factory: Address;
  vault: Address;
  treasury: Address;
  relayerKey: Hex;
  mint: (to: Address, amount: bigint) => Promise<unknown>;
  stop: () => void;
}

export async function startChain(): Promise<TestChain> {
  const port = await freePort();
  const proc: ChildProcess = spawn("anvil", ["--port", String(port), "--chain-id", "44005", "--silent"], { stdio: "ignore" });
  const rpcUrl = `http://127.0.0.1:${port}`;
  const chain = { id: 44005, name: "anvil", nativeCurrency: { name: "t", symbol: "t", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } } as const;
  const publicClient: PublicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  for (let i = 0; i < 50; i++) {
    try {
      await publicClient.getChainId();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  // anvil's well-known dev accounts: this chain is local and throwaway
  const mk = (key: Hex) => {
    const account = privateKeyToAccount(key);
    return { account, wallet: createWalletClient({ account, chain, transport: http(rpcUrl) }) };
  };
  const deployer = mk("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
  const relayerKey = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
  const sendWait = async (hash: Hex) => publicClient.waitForTransactionReceipt({ hash });

  const deploy = async (file: string, name: string, args: unknown[] = []) => {
    const a = artifact(file, name);
    const hash = await deployer.wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args, chain, gas: 8_000_000n });
    return (await sendWait(hash)).contractAddress as Address;
  };
  const token = await deploy("MockUSD8.sol", "MockUSD8");
  const registry = await deploy("AgentRegistry.sol", "AgentRegistry");
  const treasury = privateKeyToAccount(generatePrivateKey()).address;
  const factory = await deploy("WarrantFactory.sol", "WarrantFactory", [token, registry, deployer.account.address, treasury, 10]);
  const reg = artifact("AgentRegistry.sol", "AgentRegistry");
  await sendWait(await deployer.wallet.writeContract({ address: registry, abi: reg.abi, functionName: "setFactory", args: [factory], chain }));

  const tok = artifact("MockUSD8.sol", "MockUSD8");
  const mint = async (to: Address, amount: bigint) =>
    sendWait(await deployer.wallet.writeContract({ address: token, abi: tok.abi, functionName: "mint", args: [to, amount], chain }));

  const owner = mk(generatePrivateKey());
  await sendWait(await deployer.wallet.sendTransaction({ to: owner.account.address, value: 10n ** 18n, chain }));
  const created = await sendWait(
    await owner.wallet.writeContract({ address: factory, abi: warrantFactoryAbi, functionName: "createVault", args: ["0x0000000000000000000000000000000000000000", "0x" + "00".repeat(32)], chain, gas: 4_500_000n } as any),
  );
  const vault = getAddress(parseEventLogs({ abi: warrantFactoryAbi, logs: created.logs, eventName: "VaultCreated" })[0]!.args.vault);
  await mint(vault, 1_000_000_000n);

  return {
    rpcUrl,
    chain,
    publicClient,
    deployer,
    owner,
    token,
    registry,
    factory,
    vault,
    treasury,
    relayerKey,
    mint,
    stop: () => proc.kill(),
  };
}
