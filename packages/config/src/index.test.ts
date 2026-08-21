import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, redactConfig } from "./index.js";

const base = {
  DATABASE_URL: "postgres://zammy:secret@localhost:5432/zammy",
  REDIS_URL: "redis://localhost:6379",
  CURRENTS_USER_AGENT: "zammy/0.1 (+test)",
};

/** Not a real certificate — the schema checks the PEM envelope, not the bytes. */
const CA_CERT = "-----BEGIN CERTIFICATE-----\nZm9v\n-----END CERTIFICATE-----";

describe("loadConfig", () => {
  it("accepts a minimal fixture-mode configuration", () => {
    const config = loadConfig({ ...base } as NodeJS.ProcessEnv);
    expect(config.CURRENTS_MODE).toBe("fixture");
    expect(config.PORT).toBe(3000);
  });

  it("requires an explicit User-Agent, since Cloudflare 403s the default", () => {
    expect(() =>
      loadConfig({ ...base, CURRENTS_USER_AGENT: "" } as NodeJS.ProcessEnv),
    ).toThrow(ConfigError);
  });

  // Redis being unreachable is survivable and stays that way (health.ts reports
  // `degraded` and keeps serving). A URL that can never resolve to a Redis at
  // all is not survivable — it is a deploy defect that otherwise hides behind an
  // HTTP 200 forever (DEPLOYMENT-OCI §2.4, archival).
  it("accepts both redis:// and rediss:// URLs", () => {
    for (const url of [
      "redis://localhost:6379",
      "rediss://cache.example.internal:6380",
      "redis://:password@10.0.2.5:6379/0",
    ]) {
      expect(() =>
        loadConfig({ ...base, REDIS_URL: url } as NodeJS.ProcessEnv),
      ).not.toThrow();
    }
  });

  it("refuses a REDIS_URL that is not a redis URL, rather than degrading forever", () => {
    for (const url of [
      "redis//localhost:6379", // missing colon — parses as a relative path
      "http://cache:6379", // parses fine, and is just as dead
      "localhost:6379", // host:port, no scheme
      "redis:6379", // right protocol, no host — ioredis would use localhost
    ]) {
      expect(() =>
        loadConfig({ ...base, REDIS_URL: url } as NodeJS.ProcessEnv),
      ).toThrow(/redis:\/\/ or rediss:\/\//);
    }
  });

  // The per-IP rate limit keys on request.ip, so this number decides whether the
  // ceiling is real. It is a count rather than a boolean because trusting the whole
  // X-Forwarded-For chain lets the caller pick the leftmost entry.
  it("trusts no proxy hops by default", () => {
    expect(loadConfig({ ...base } as NodeJS.ProcessEnv).TRUSTED_PROXY_HOPS).toBe(0);
  });

  it("coerces the hop count from a string and rejects a negative one", () => {
    expect(
      loadConfig({ ...base, TRUSTED_PROXY_HOPS: "2" } as NodeJS.ProcessEnv)
        .TRUSTED_PROXY_HOPS,
    ).toBe(2);
    expect(() =>
      loadConfig({ ...base, TRUSTED_PROXY_HOPS: "-1" } as NodeJS.ProcessEnv),
    ).toThrow(ConfigError);
  });

  it("requires an API key in live mode", () => {
    expect(() =>
      loadConfig({ ...base, CURRENTS_MODE: "live" } as NodeJS.ProcessEnv),
    ).toThrow(/CURRENTS_API_KEY is required/);
  });

  it("does not require an API key in fixture mode", () => {
    expect(() =>
      loadConfig({ ...base, CURRENTS_MODE: "fixture" } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it("groups by default, and refuses a misspelt switch rather than guessing", () => {
    // A truthiness test would read `flase` as "on" and quietly ship the
    // feature to an operator who turned it off (§12: refuse to start).
    expect(loadConfig({ ...base } as NodeJS.ProcessEnv).GROUPING_ENABLED).toBe(true);
    expect(
      loadConfig({ ...base, GROUPING_ENABLED: "false" } as NodeJS.ProcessEnv).GROUPING_ENABLED,
    ).toBe(false);
    expect(() =>
      loadConfig({ ...base, GROUPING_ENABLED: "flase" } as NodeJS.ProcessEnv),
    ).toThrow(ConfigError);
  });

  it("rejects a reserve that would starve background ingestion entirely", () => {
    expect(() =>
      loadConfig({
        ...base,
        INTERACTIVE_RESERVE: "1000",
        CURRENTS_DAILY_CALL_LIMIT: "1000",
      } as NodeJS.ProcessEnv),
    ).toThrow(/must be below/);
  });

  it("rejects a retrievable cap that is not a whole number of pages", () => {
    expect(() =>
      loadConfig({
        ...base,
        CURRENTS_MAX_PAGE_SIZE: "20",
        CURRENTS_MAX_RETRIEVABLE_RESULTS: "90",
      } as NodeJS.ProcessEnv),
    ).toThrow(/multiple of/);
  });

  it("rejects retention shorter than the upstream lookback", () => {
    // Beyond the 30-day lookback our store is the only copy, so this would
    // discard history that cannot be re-fetched.
    expect(() =>
      loadConfig({ ...base, RETENTION_DAYS: "10" } as NodeJS.ProcessEnv),
    ).toThrow(/discards history/);
  });

  // TLS has one home. node-postgres silently ignores the `ssl` options object
  // when the connection string carries sslmode, so a URL that sets it cannot be
  // hardened later and nothing says why — the refusal is the only signal
  // available (RESEARCH-VERCEL-SUPABASE 4.2).
  it("refuses a DATABASE_URL that decides TLS for itself", () => {
    for (const url of [
      "postgres://u:p@host:5432/db?sslmode=require",
      "postgres://u:p@host:5432/db?sslmode=disable",
      "postgres://u:p@host:5432/db?application_name=zammy&sslmode=verify-full",
      "postgres://u:p@host:5432/db?sslnegotiation=direct",
    ]) {
      expect(() =>
        loadConfig({ ...base, DATABASE_URL: url } as NodeJS.ProcessEnv),
      ).toThrow(/sslmode/);
    }
  });

  it("applies the same refusal to the session-mode URL", () => {
    expect(() =>
      loadConfig({
        ...base,
        DATABASE_SESSION_URL: "postgres://u:p@host:5432/db?sslmode=require",
      } as NodeJS.ProcessEnv),
    ).toThrow(/sslmode/);
  });

  // Unset means "the same server", which is the whole local and single-server
  // case; it is only a pooled Postgres that needs the two to differ.
  it("leaves DATABASE_SESSION_URL unset by default and accepts a clean one", () => {
    expect(loadConfig({ ...base } as NodeJS.ProcessEnv).DATABASE_SESSION_URL).toBeUndefined();
    expect(
      loadConfig({
        ...base,
        DATABASE_SESSION_URL: "postgres://u:p@pooler:5432/db",
      } as NodeJS.ProcessEnv).DATABASE_SESSION_URL,
    ).toBe("postgres://u:p@pooler:5432/db");
  });

  it("defaults the pool to 10 and coerces a configured size", () => {
    expect(loadConfig({ ...base } as NodeJS.ProcessEnv).DATABASE_POOL_MAX).toBe(10);
    expect(
      loadConfig({ ...base, DATABASE_POOL_MAX: "2" } as NodeJS.ProcessEnv).DATABASE_POOL_MAX,
    ).toBe(2);
    expect(() =>
      loadConfig({ ...base, DATABASE_POOL_MAX: "0" } as NodeJS.ProcessEnv),
    ).toThrow(ConfigError);
  });

  it("defaults TLS to disable, since the Compose Postgres offers none", () => {
    expect(loadConfig({ ...base } as NodeJS.ProcessEnv).DATABASE_SSL).toBe("disable");
  });

  it("requires a CA certificate for verify-full, and refuses one that verifies nothing", () => {
    expect(() =>
      loadConfig({ ...base, DATABASE_SSL: "verify-full" } as NodeJS.ProcessEnv),
    ).toThrow(/DATABASE_CA_CERT is required/);

    // The dangerous half: a certificate in the environment reads as "we verify
    // TLS" while the connection is plaintext.
    expect(() =>
      loadConfig({
        ...base,
        DATABASE_SSL: "disable",
        DATABASE_CA_CERT: CA_CERT,
      } as NodeJS.ProcessEnv),
    ).toThrow(/verifies nothing/);

    expect(() =>
      loadConfig({
        ...base,
        DATABASE_SSL: "verify-full",
        DATABASE_CA_CERT: CA_CERT,
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it("treats an empty certificate as unset, and a non-PEM one as an error", () => {
    expect(
      loadConfig({ ...base, DATABASE_CA_CERT: "" } as NodeJS.ProcessEnv).DATABASE_CA_CERT,
    ).toBeUndefined();
    expect(() =>
      loadConfig({
        ...base,
        DATABASE_SSL: "verify-full",
        DATABASE_CA_CERT: "/etc/ssl/certs/supabase.crt",
      } as NodeJS.ProcessEnv),
    ).toThrow(/BEGIN CERTIFICATE/);
  });

  it("reports every problem at once rather than only the first", () => {
    try {
      loadConfig({
        DATABASE_URL: "postgres://x@localhost/db",
        REDIS_URL: "redis://localhost:6379",
        CURRENTS_USER_AGENT: "ua",
        CURRENTS_MODE: "live",
        RETENTION_DAYS: "5",
      } as NodeJS.ProcessEnv);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).issues.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("redactConfig", () => {
  it("removes the API key and database credentials", () => {
    const config = loadConfig({
      ...base,
      CURRENTS_MODE: "live",
      CURRENTS_API_KEY: "super-secret-key",
    } as NodeJS.ProcessEnv);

    const serialised = JSON.stringify(redactConfig(config));
    expect(serialised).not.toContain("super-secret-key");
    expect(serialised).not.toContain("secret@");
    expect(serialised).toContain("[redacted]");
  });

  // A second URL is a second password, and the boot line prints all of them.
  it("removes the session-mode connection's credentials too", () => {
    const config = loadConfig({
      ...base,
      DATABASE_SESSION_URL: "postgres://zammy:pooler-secret@pooler:5432/zammy",
    } as NodeJS.ProcessEnv);

    const serialised = JSON.stringify(redactConfig(config));
    expect(serialised).not.toContain("pooler-secret");
    expect(serialised).toContain("pooler");
  });

  // Public, but a kilobyte of PEM in the line nobody then reads.
  it("collapses the CA certificate to a presence flag", () => {
    const config = loadConfig({
      ...base,
      DATABASE_SSL: "verify-full",
      DATABASE_CA_CERT: CA_CERT,
    } as NodeJS.ProcessEnv);

    const redacted = redactConfig(config);
    expect(redacted.DATABASE_CA_CERT).toBe("[present]");
    expect(redactConfig(loadConfig({ ...base } as NodeJS.ProcessEnv)).DATABASE_CA_CERT).toBeNull();
  });
});
