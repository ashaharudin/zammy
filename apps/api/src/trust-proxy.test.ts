import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { trustedProxyOption } from "./server.js";

/**
 * `request.ip` is what @fastify/rate-limit keys on, so whether a caller can
 * choose it decides whether the per-IP ceiling means anything (ARCHITECTURE 12).
 *
 * A bare Fastify rather than buildApp: this is about one constructor option, and
 * the full app would need Postgres and Redis to say the same thing.
 */
async function ipSeenBy(hops: number, forwardedFor?: string): Promise<string> {
  const app = Fastify({ trustProxy: trustedProxyOption(hops) });
  app.get("/ip", async (request) => ({ ip: request.ip }));
  try {
    const response = await app.inject({
      method: "GET",
      url: "/ip",
      headers: forwardedFor === undefined ? {} : { "x-forwarded-for": forwardedFor },
    });
    return response.json<{ ip: string }>().ip;
  } finally {
    await app.close();
  }
}

describe("trustedProxyOption", () => {
  it("disables proxy trust entirely at zero hops", () => {
    expect(trustedProxyOption(0)).toBe(false);
  });

  it("passes the count through when proxies are in front", () => {
    expect(trustedProxyOption(1)).toBe(1);
    expect(trustedProxyOption(2)).toBe(2);
  });

  it("ignores a forged header when nothing is in front", async () => {
    await expect(ipSeenBy(0, "1.2.3.4")).resolves.toBe("127.0.0.1");
  });

  // The regression this exists to catch. `trustProxy: true` would return the
  // leftmost entry — 9.9.9.9 — letting a caller rotate a header and mint a fresh
  // rate-limit bucket per request. One trusted hop returns what that hop saw.
  it("takes the address the trusted hop reported, not the one the caller supplied", async () => {
    await expect(ipSeenBy(1, "9.9.9.9, 5.5.5.5")).resolves.toBe("5.5.5.5");
  });

  it("still resolves to the socket address when a trusted hop sends no header", async () => {
    await expect(ipSeenBy(1)).resolves.toBe("127.0.0.1");
  });
});
