// Every setting, read from the environment once and validated. A bad value stops start-up with a message naming the
// variable; it never falls back to something unsafe (fail closed, DESIGN "Security at design time").
//
// Secrets (DATABASE_URL, the Azure storage account's connection) are not settings: they are read by name through
// `secret()` from the process environment or DATA_DIR/.env, and are never logged, rendered or stored.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { repoRoot } from "./paths.js";

export interface Config {
  host: string;
  port: number;
  /** Local state: the disk blob store (BLOB_STORE=disk) and DATA_DIR/.env. */
  dataDir: string;
  /** The address people use to reach the app. Its scheme decides `Secure` cookies and HSTS. */
  publicUrl: string;
  secureCookies: boolean;
  /** Off unless set (fail closed): only behind Container Apps' ingress, exactly one hop (T-094). */
  trustProxy: boolean;
  /** Who may make an account: open (the Board's answer, AB#4685) or closed (the owner invites). */
  signup: "open" | "closed";
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "silent";
  /** Where content-addressed blobs live: the disk under DATA_DIR, or Azure Blob Storage (AB#3821). */
  blobStore: "disk" | "azure";
  /** BLOB_STORE=azure: the storage account and container; the identity is the process's own (managed identity or az login). */
  azureStorageAccount: string | undefined;
  azureBlobContainer: string;
  /** Per-account storage quota in bytes (AB#2834; Decision AB#4686's default: 2 GiB). */
  storageQuotaBytes: number;
  /** How long a blob URL stays valid (AB#2845). */
  blobUrlTtlSeconds: number;
  versionFile: string;
}

const GIB = 1024 ** 3;

function defaultDataDir(env: NodeJS.ProcessEnv): string {
  const local = env.LOCALAPPDATA;
  return local ? path.join(local, "beatbranch") : path.join(os.homedir(), ".beatbranch");
}

const Env = z.object({
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4420),
  DATA_DIR: z.string().min(1).optional(),
  PUBLIC_URL: z.url({ protocol: /^https?$/ }).optional(),
  TRUST_PROXY: z.enum(["true", "false"]).default("false"),
  SIGNUP: z.enum(["open", "closed"]).default("open"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "silent"]).default("info"),
  BLOB_STORE: z.enum(["disk", "azure"]).default("disk"),
  AZURE_STORAGE_ACCOUNT: z.string().regex(/^[a-z0-9]{3,24}$/).optional(),
  AZURE_BLOB_CONTAINER: z.string().regex(/^[a-z0-9-]{3,63}$/).default("blobs"),
  STORAGE_QUOTA_BYTES: z.coerce.number().int().min(1).default(2 * GIB),
  BLOB_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  VERSION_FILE: z.string().min(1).optional()
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const names = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid configuration: ${names}. See README.md, "Settings".`);
  }
  const e = parsed.data;
  if (e.BLOB_STORE === "azure" && !e.AZURE_STORAGE_ACCOUNT) {
    throw new Error("Invalid configuration: BLOB_STORE=azure needs AZURE_STORAGE_ACCOUNT. See README.md, \"Settings\".");
  }
  const publicUrl = e.PUBLIC_URL ?? `http://${e.HOST.includes(":") ? `[${e.HOST}]` : e.HOST}:${e.PORT}`;
  return {
    host: e.HOST,
    port: e.PORT,
    dataDir: path.resolve(e.DATA_DIR ?? defaultDataDir(env)),
    publicUrl: publicUrl.replace(/\/+$/, ""),
    secureCookies: publicUrl.startsWith("https:"),
    trustProxy: e.TRUST_PROXY === "true",
    signup: e.SIGNUP,
    logLevel: e.LOG_LEVEL,
    blobStore: e.BLOB_STORE,
    azureStorageAccount: e.AZURE_STORAGE_ACCOUNT,
    azureBlobContainer: e.AZURE_BLOB_CONTAINER,
    storageQuotaBytes: e.STORAGE_QUOTA_BYTES,
    blobUrlTtlSeconds: e.BLOB_URL_TTL_SECONDS,
    versionFile: path.resolve(e.VERSION_FILE ?? path.join(repoRoot(), "version.json"))
  };
}

/** Parse a .env file: KEY=value lines, # comments, optional quotes. Values are never echoed. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

/** A secret by name: the process environment first, then DATA_DIR/.env. Missing means `undefined`; the caller fails closed. */
export function secret(config: Pick<Config, "dataDir">, name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromEnv = env[name];
  if (fromEnv) return fromEnv;
  let text: string;
  try {
    text = fs.readFileSync(path.join(config.dataDir, ".env"), "utf8");
  } catch {
    return undefined;
  }
  const value = parseEnvFile(text)[name];
  return value ? value : undefined;
}
