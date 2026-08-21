import { describe, expect, it } from "vitest";
import { databaseSsl } from "./database.js";

/**
 * The one part of `database.ts` with logic rather than types. No database
 * needed: what is under test is what `pg` gets handed, which is exactly the
 * thing a live connection would hide (a pool that connects tells you nothing
 * about whether it verified anything).
 */

const PEM = "-----BEGIN CERTIFICATE-----\nZm9v\n-----END CERTIFICATE-----";

describe("databaseSsl", () => {
  it("returns false for disable, so pg is handed no TLS at all", () => {
    expect(databaseSsl({ mode: "disable" })).toBe(false);
    // A certificate alongside disable is a config error @zammy/config refuses;
    // here the mode still decides, rather than the presence of a cert quietly
    // switching TLS on.
    expect(databaseSsl({ mode: "disable", caCert: PEM })).toBe(false);
  });

  it("encrypts without verifying for require, and says so in the shape", () => {
    expect(databaseSsl({ mode: "require" })).toEqual({ rejectUnauthorized: false });
  });

  it("verifies against the supplied chain for verify-full", () => {
    expect(databaseSsl({ mode: "verify-full", caCert: PEM })).toEqual({
      ca: PEM,
      rejectUnauthorized: true,
    });
  });

  // A secret store or a dashboard field hands back one line with the newlines
  // escaped; Node's TLS stack rejects that, and the error it raises names
  // neither the setting nor the cause.
  it("restores escaped newlines in a one-line PEM", () => {
    const oneLine = "-----BEGIN CERTIFICATE-----\\nZm9v\\n-----END CERTIFICATE-----";
    expect(databaseSsl({ mode: "verify-full", caCert: oneLine })).toEqual({
      ca: PEM,
      rejectUnauthorized: true,
    });
  });

  // @zammy/config catches this at boot for every process that loads it; the
  // migrator CLI reads the environment raw, so the throw is its only guard.
  it("refuses verify-full with nothing to verify against", () => {
    expect(() => databaseSsl({ mode: "verify-full" })).toThrow(/requires DATABASE_CA_CERT/);
    expect(() => databaseSsl({ mode: "verify-full", caCert: "   " })).toThrow(
      /requires DATABASE_CA_CERT/,
    );
  });
});
