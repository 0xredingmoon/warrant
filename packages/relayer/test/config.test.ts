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

describe("try the attack demo config", () => {
  const demo = {
    DEMO_VAULT: "0x363E657fc8c8Df213AC35f675AeCA0C3E6805a16",
    DEMO_AGENT_KEY: `0x${"22".repeat(32)}`,
    DEMO_ALLOWED_MERCHANT: "0xf2b01C5b12DaAe6adAa0a876065D303302F4b4Ae",
  };

  it("is off when neither DEMO_VAULT nor DEMO_AGENT_KEY is set", () => {
    expect(loadConfigFromEnv(base).attackDemo).toBeUndefined();
  });

  it("reads the amounts as tUSD8 and keeps sensible defaults", () => {
    const cfg = loadConfigFromEnv({ ...base, ...demo }).attackDemo!;
    expect(cfg.vault).toBe(demo.DEMO_VAULT);
    expect(cfg.mandateId).toBe(1n);
    expect(cfg.overspendAmount).toBe(250_000_000n); // 250.00
    expect(cfg.offlistAmount).toBe(10_000n); // 0.01
    expect(cfg.blockedMerchant).toBe("0x000000000000000000000000000000000000dEaD");
    expect(cfg.cooldownSeconds).toBe(20);
  });

  it("refuses a half-configured demo instead of starting with a silently wrong target", () => {
    expect(() => loadConfigFromEnv({ ...base, DEMO_VAULT: demo.DEMO_VAULT })).toThrow(/missing DEMO_AGENT_KEY/);
    expect(() => loadConfigFromEnv({ ...base, ...demo, DEMO_AGENT_KEY: "0x1234" })).toThrow(/32-byte hex private key/);
    expect(() => loadConfigFromEnv({ ...base, ...demo, DEMO_ALLOWED_MERCHANT: "not-an-address" })).toThrow(/not an address/);
  });

  it("takes amount and cooldown overrides", () => {
    const cfg = loadConfigFromEnv({ ...base, ...demo, DEMO_OVERSPEND_AMOUNT: "1000", DEMO_OFFLIST_AMOUNT: "0.5", DEMO_COOLDOWN_SECONDS: "0", DEMO_MANDATE_ID: "7" }).attackDemo!;
    expect(cfg.overspendAmount).toBe(1_000_000_000n);
    expect(cfg.offlistAmount).toBe(500_000n);
    expect(cfg.cooldownSeconds).toBe(0);
    expect(cfg.mandateId).toBe(7n);
  });
});
