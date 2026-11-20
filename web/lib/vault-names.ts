"use client";
import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";
import { short } from "./format";

// Vault names live in this browser only (the contract has no name). Without one a vault is "Vault 1", "Vault 2"…
// in the order it was created, which is the order the factory lists them.
const KEY = "warrant:vault-names";
const EVENT = "warrant:vault-names-changed";

const read = (): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
};

export function useVaultNames() {
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    const load = () => setNames(read());
    load();
    window.addEventListener(EVENT, load);
    window.addEventListener("storage", load);
    return () => {
      window.removeEventListener(EVENT, load);
      window.removeEventListener("storage", load);
    };
  }, []);
  const rename = useCallback((vault: Address, name: string) => {
    const all = read();
    const clean = name.trim().slice(0, 32);
    if (clean) all[vault.toLowerCase()] = clean;
    else delete all[vault.toLowerCase()];
    try {
      localStorage.setItem(KEY, JSON.stringify(all));
    } catch {
      /* storage blocked: the name just is not kept */
    }
    window.dispatchEvent(new Event(EVENT));
  }, []);
  /** "Research budget" or "Vault 2" */
  const nameOf = useCallback((vault: Address, vaults: readonly Address[]) => {
    const n = names[vault.toLowerCase()];
    if (n) return n;
    const i = vaults.findIndex((v) => v.toLowerCase() === vault.toLowerCase());
    return i >= 0 ? `Vault ${i + 1}` : "Vault";
  }, [names]);
  return { names, nameOf, rename };
}

/** "Vault 2 · 0x1234…abcd" */
export const vaultTag = (name: string, vault: Address) => `${name} · ${short(vault)}`;
