import { describe, expect, it } from "vitest";
import { loadConfig, parseEnvFile, secret } from "./config.js";
import fs from "node:fs";
import path from "node:path";
import { tempDir } from "../tests/temp-dir.js";

const GIB = 1024 ** 3;

describe("loadConfig", () => {
  it("defaults to a local disk store, open sign-up and a 2 GiB quota (AB#4685, AB#4686)", () => {
    const c = loadConfig({});
    expect(c.port).toBe(4420);
    expect(c.blobStore).toBe("disk");
    expect(c.signup).toBe("open");
    expect(c.storageQuotaBytes).toBe(2 * GIB);
    expect(c.secureCookies).toBe(false);
    expect(c.trustProxy).toBe(false);
  });
  it("fails closed on a bad value, naming the variable", () => {
    expect(() => loadConfig({ PORT: "abc" })).toThrow(/PORT/);
    expect(() => loadConfig({ SIGNUP: "maybe" })).toThrow(/SIGNUP/);
    expect(() => loadConfig({ BLOB_STORE: "azure" })).toThrow(/AZURE_STORAGE_ACCOUNT/);
  });
  it("takes secure cookies from PUBLIC_URL's scheme", () => {
    expect(loadConfig({ PUBLIC_URL: "https://beatbranch.example" }).secureCookies).toBe(true);
  });
});

describe("secret", () => {
  it("reads the environment first, then DATA_DIR/.env", () => {
    const dataDir = tempDir("bb-config-");
    fs.writeFileSync(path.join(dataDir, ".env"), "# comment\nDATABASE_URL=\"postgres://a:b@127.0.0.1/x\"\nlower=no\n");
    expect(secret({ dataDir }, "DATABASE_URL", {})).toBe("postgres://a:b@127.0.0.1/x");
    expect(secret({ dataDir }, "DATABASE_URL", { DATABASE_URL: "postgres://env" })).toBe("postgres://env");
    expect(secret({ dataDir }, "MISSING", {})).toBeUndefined();
    expect(parseEnvFile("A=1\nB='two'\n")).toEqual({ A: "1", B: "two" });
  });
});
