import { getAddress, type Address } from "viem";

const env = (v: string | undefined, fallback: string) => (v && v.length > 0 ? v : fallback);

export const CHAIN_ID = Number(env(process.env.NEXT_PUBLIC_CHAIN_ID, "44005"));
export const RPC_URL = env(process.env.NEXT_PUBLIC_RPC_URL, "https://rpc-test.qday.info");
export const EXPLORER = env(process.env.NEXT_PUBLIC_EXPLORER, "https://explorer-test.qday.info");
export const FACTORY: Address = getAddress(env(process.env.NEXT_PUBLIC_FACTORY, "0x9D2CF5776359fD502a1a09862D8Ef03F41446442"));
export const REGISTRY: Address = getAddress(env(process.env.NEXT_PUBLIC_REGISTRY, "0x5Efd32A5BC15880CCa0bF2E19346316E3C00762a"));
export const DEPLOY_BLOCK = BigInt(env(process.env.NEXT_PUBLIC_DEPLOY_BLOCK, "3658490"));
export const RELAYER_URL: string | undefined = process.env.NEXT_PUBLIC_RELAYER_URL || undefined;
export const TOKEN: Address = getAddress("0x456569838f1d43009A91ebA4263147Afd7233483");
