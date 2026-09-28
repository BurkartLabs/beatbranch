import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import type { Config } from "../config.js";
import { secret } from "../config.js";

export interface SignedUrlOptions {
  filename: string;
  contentType: string;
  userId: string | null;
  ttlSeconds: number;
  inline?: boolean;
}

export interface BlobStore {
  kind: "disk" | "azure";
  has(hash: string): Promise<boolean>;
  putFile(hash: string, file: string): Promise<void>;
  read(hash: string): Promise<Readable>;
  remove(hash: string): Promise<void>;
  signedUrl(hash: string, options: SignedUrlOptions): Promise<string>;
}

export const HASH = /^[0-9a-f]{64}$/;

function assertHash(hash: string): void {
  if (!HASH.test(hash)) throw new Error("not a blob hash");
}

function urlKey(config: Config): Buffer {
  const fromSecret = secret(config, "BLOB_URL_KEY");
  if (fromSecret) return Buffer.from(fromSecret, "utf8");
  const file = path.join(config.dataDir, "blob-url.key");
  if (!fs.existsSync(file)) {
    fs.mkdirSync(config.dataDir, { recursive: true });
    try {
      fs.writeFileSync(file, crypto.randomBytes(32).toString("base64url"), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  return Buffer.from(fs.readFileSync(file, "utf8").trim(), "utf8");
}

export function signPayload(key: Buffer, parts: string[]): string {
  return crypto.createHmac("sha256", key).update(parts.join("\n")).digest("base64url");
}

export class DiskBlobStore implements BlobStore {
  readonly kind = "disk" as const;
  private readonly root: string;
  private readonly key: Buffer;

  constructor(private readonly config: Config) {
    this.root = path.join(config.dataDir, "blobs");
    this.key = urlKey(config);
  }

  pathOf(hash: string): string {
    assertHash(hash);
    return path.join(this.root, hash.slice(0, 2), hash.slice(2, 4), hash);
  }

  async has(hash: string): Promise<boolean> {
    return fs.existsSync(this.pathOf(hash));
  }

  async putFile(hash: string, file: string): Promise<void> {
    const target = this.pathOf(hash);
    if (fs.existsSync(target)) return;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const staging = `${target}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.copyFileSync(file, staging);
    try {
      fs.renameSync(staging, target);
    } catch (error) {
      fs.rmSync(staging, { force: true });
      if (!fs.existsSync(target)) throw error;
    }
  }

  async read(hash: string): Promise<Readable> {
    return fs.createReadStream(this.pathOf(hash));
  }

  async remove(hash: string): Promise<void> {
    fs.rmSync(this.pathOf(hash), { force: true });
  }

  async signedUrl(hash: string, o: SignedUrlOptions): Promise<string> {
    assertHash(hash);
    const exp = String(Math.floor(Date.now() / 1000) + o.ttlSeconds);
    const u = o.userId ?? "";
    const d = o.inline ? "inline" : "attachment";
    const sig = signPayload(this.key, [hash, exp, u, o.filename, o.contentType, d]);
    const q = new URLSearchParams({ exp, u, n: o.filename, t: o.contentType, d, sig });
    return `/blob/${hash}?${q.toString()}`;
  }

  verify(hash: string, q: Record<string, string | undefined>, userId: string | null, now = Date.now()): { filename: string; contentType: string; inline: boolean } | null {
    if (!HASH.test(hash)) return null;
    const { exp, u, n, t, d, sig } = q;
    if (!exp || u === undefined || !n || !t || !d || !sig) return null;
    if (!/^\d{1,12}$/.test(exp) || Number(exp) * 1000 < now) return null;
    if (u !== (userId ?? "")) return null;
    const expected = signPayload(this.key, [hash, exp, u, n, t, d]);
    const a = Buffer.from(expected);
    const b = Buffer.from(sig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return { filename: n, contentType: t, inline: d === "inline" };
  }
}

export class AzureBlobStore implements BlobStore {
  readonly kind = "azure" as const;
  private clients: Promise<{ container: import("@azure/storage-blob").ContainerClient; service: import("@azure/storage-blob").BlobServiceClient; account: string }> | undefined;

  constructor(private readonly config: Config) {}

  private async get() {
    this.clients ??= (async () => {
      const { BlobServiceClient } = await import("@azure/storage-blob");
      const { DefaultAzureCredential } = await import("@azure/identity");
      const account = this.config.azureStorageAccount!;
      const service = new BlobServiceClient(`https://${account}.blob.core.windows.net`, new DefaultAzureCredential());
      const container = service.getContainerClient(this.config.azureBlobContainer);
      return { container, service, account };
    })();
    return this.clients;
  }

  async has(hash: string): Promise<boolean> {
    assertHash(hash);
    return (await this.get()).container.getBlockBlobClient(hash).exists();
  }

  async putFile(hash: string, file: string): Promise<void> {
    assertHash(hash);
    const blob = (await this.get()).container.getBlockBlobClient(hash);
    if (await blob.exists()) return;
    await blob.uploadFile(file, { blobHTTPHeaders: { blobContentType: "application/octet-stream" } });
  }

  async read(hash: string): Promise<Readable> {
    assertHash(hash);
    const r = await (await this.get()).container.getBlockBlobClient(hash).download();
    return r.readableStreamBody as unknown as Readable;
  }

  async remove(hash: string): Promise<void> {
    assertHash(hash);
    await (await this.get()).container.getBlockBlobClient(hash).deleteIfExists();
  }

  async signedUrl(hash: string, o: SignedUrlOptions): Promise<string> {
    assertHash(hash);
    const { BlobSASPermissions, generateBlobSASQueryParameters, SASProtocol } = await import("@azure/storage-blob");
    const { service, account } = await this.get();
    const startsOn = new Date(Date.now() - 60_000);
    const expiresOn = new Date(Date.now() + o.ttlSeconds * 1000);
    const key = await service.getUserDelegationKey(startsOn, expiresOn);
    const sas = generateBlobSASQueryParameters(
      {
        containerName: this.config.azureBlobContainer,
        blobName: hash,
        permissions: BlobSASPermissions.parse("r"),
        startsOn,
        expiresOn,
        protocol: SASProtocol.Https,
        contentType: o.contentType,
        contentDisposition: `${o.inline ? "inline" : "attachment"}; filename="${o.filename.replace(/["\\\r\n]/g, "_")}"`
      },
      key,
      account
    );
    return `https://${account}.blob.core.windows.net/${this.config.azureBlobContainer}/${hash}?${sas.toString()}`;
  }
}

export function blobStore(config: Config): BlobStore {
  return config.blobStore === "azure" ? new AzureBlobStore(config) : new DiskBlobStore(config);
}
