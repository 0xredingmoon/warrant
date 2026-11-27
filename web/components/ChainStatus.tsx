"use client";
import { useQuery } from "@tanstack/react-query";
import { CHAIN_ID, EXPLORER, FACTORY } from "@/lib/config";
import { publicClient } from "@/lib/chain";
import { addrLink, short } from "@/lib/format";

/** Live chain head, so the public landing page proves it is talking to Aevum even before a wallet is connected. */
export function ChainStatus() {
  const block = useQuery({
    queryKey: ["chain-head"],
    queryFn: () => publicClient.getBlockNumber(),
    refetchInterval: 12_000,
    retry: 2,
  });
  return (
    <p className="hint chain-status" data-testid="chain-status">
      {block.isError ? (
        <>Could not reach the Aevum RPC. Factory{" "}
          <a className="mono" href={addrLink(FACTORY)} target="_blank" rel="noreferrer">{short(FACTORY, 4)}</a>.
        </>
      ) : (
        <>
          Live on Aevum testnet (chain {CHAIN_ID}
          {block.data !== undefined ? <> · block {block.data.toString()}</> : " · reading block…"}
          ). Factory{" "}
          <a className="mono" href={addrLink(FACTORY)} target="_blank" rel="noreferrer">{short(FACTORY, 4)}</a>
          {EXPLORER ? <> · <a className="tap" href={EXPLORER} target="_blank" rel="noreferrer">explorer</a></> : null}.
        </>
      )}
    </p>
  );
}
