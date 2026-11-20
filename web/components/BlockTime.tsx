"use client";
import { useQuery } from "@tanstack/react-query";
import { dateTime } from "@/lib/format";
import { useClient } from "@/lib/queries";

/** The wall-clock time of a block, read once from the RPC. */
export function useBlockTime(block?: bigint) {
  const client = useClient();
  return useQuery({
    queryKey: ["block-time", block?.toString()],
    enabled: block !== undefined,
    queryFn: async () => Number((await client.getBlock({ blockNumber: block! })).timestamp),
    staleTime: Infinity,
  });
}

export function BlockTime({ block }: { block: bigint }) {
  const t = useBlockTime(block);
  return <time dateTime={t.data ? new Date(t.data * 1000).toISOString() : undefined}>{t.data ? dateTime(t.data) : `block ${block}`}</time>;
}
