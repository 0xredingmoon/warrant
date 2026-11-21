import { describe, expect, it } from "vitest";
import { defaultDatabasePath, defaultTrustedIpHeader, isServerlessHost, loadConfigFromEnv } from "../src/config";

const key = `0x${"11".repeat(32)}`;
const factory = "0x66687369d9C683aaaaDAe98b747b63eE7e0662E3";
const base = { RELAYER_PRIVATE_KEY: key, FACTORY_ADDRESS: factory };

describe("serverless defaults", () => {
  it("keeps a local sqlite file and no forwarded-for header on a normal host", () => {
    expect(isServerlessHost({})).toBe(false);
    expect(defaultDatabasePath({})).toBe("./data/relayer.db");
    expect(defaultTrustedIpHeader({})).toBeUndefined();
    const cfg = loadConfigFromEnv(base);
    expect(cfg.dbPath).toBe("./data/relayer.db");
    expect(cfg.trustedIpHeader).toBeUndefined();
  });

  it("uses /tmp and x-forwarded-for on Vercel and Netlify", () => {
    expect(isServerlessHost({ VERCEL: "1" })).toBe(true);
    expect(isServerlessHost({ NETLIFY: "true" })).toBe(true);
    expect(defaultDatabasePath({ VERCEL: "1" })).toBe("/tmp/relayer.db");
    expect(defaultDatabasePath({ NETLIFY: "1" })).toBe("/tmp/relayer.db");
    expect(defaultTrustedIpHeader({ VERCEL: "1" })).toBe("x-forwarded-for");
    const cfg = loadConfigFromEnv({ ...base, VERCEL: "1" });
    expect(cfg.dbPath).toBe("/tmp/relayer.db");
    expect(cfg.trustedIpHeader).toBe("x-forwarded-for");
  });

  it("lets DATABASE_PATH and TRUSTED_IP_HEADER override the serverless defaults", () => {
    expect(defaultDatabasePath({ VERCEL: "1", DATABASE_PATH: ":memory:" })).toBe(":memory:");
    expect(defaultTrustedIpHeader({ VERCEL: "1", TRUSTED_IP_HEADER: "cf-connecting-ip" })).toBe(
      "cf-connecting-ip",
    );
  });
});
