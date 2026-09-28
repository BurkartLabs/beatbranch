import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp, SESSION_COOKIE } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createSession, createUser } from "../src/auth/users.js";
import type { PostgresDb } from "../src/db/db.js";
import { testDb } from "./test-db.js";
import { tempDir } from "./temp-dir.js";

export const ORIGIN = "http://127.0.0.1:4420";

export type Person = { id: string; handle: string; cookie: string; csrf: string };

export async function world(env: Record<string, string> = {}): Promise<{ app: FastifyInstance; db: PostgresDb; dataDir: string }> {
  const db = await testDb();
  const dataDir = tempDir("bb-world-");
  const app = await buildApp(loadConfig({ DATA_DIR: dataDir, LOG_LEVEL: "silent", ...env }), db);
  return { app, db, dataDir };
}

export async function person(db: PostgresDb, handle: string): Promise<Person> {
  const made = await createUser(db, { email: `${handle}@example.com`, password: "twelve letters at least", handle, displayName: handle.toUpperCase() });
  if (!made.ok) throw new Error(made.reason);
  const { token, session } = await createSession(db, made.user.id);
  return { id: made.user.id, handle, cookie: `${SESSION_COOKIE}=${token}`, csrf: session.csrfToken };
}

export const get = (app: FastifyInstance, url: string, who?: Person) =>
  app.inject({ method: "GET", url, headers: { accept: "text/html", ...(who ? { cookie: who.cookie } : {}) } });

export const post = (app: FastifyInstance, url: string, who: Person, fields: Record<string, string>) =>
  app.inject({
    method: "POST",
    url,
    payload: new URLSearchParams({ _csrf: who.csrf, ...fields }).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie: who.cookie, accept: "text/html" }
  });

export type Part = { name: string; value: string } | { name: string; filename: string; data: Buffer; type?: string };

export function multipartBody(parts: Part[]): { body: Buffer; type: string } {
  const boundary = `----bb${crypto.randomBytes(8).toString("hex")}`;
  const chunks: Buffer[] = [];
  for (const p of parts) {
    if ("filename" in p) {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\nContent-Type: ${p.type ?? "application/octet-stream"}\r\n\r\n`));
      chunks.push(p.data, Buffer.from("\r\n"));
    } else {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"\r\n\r\n${p.value}\r\n`));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), type: `multipart/form-data; boundary=${boundary}` };
}

export function postMultipart(app: FastifyInstance, url: string, who: Person, parts: Part[], withCsrf = true) {
  const { body, type } = multipartBody(withCsrf ? [{ name: "_csrf", value: who.csrf }, ...parts] : parts);
  return app.inject({ method: "POST", url, payload: body, headers: { "content-type": type, origin: ORIGIN, cookie: who.cookie, accept: "text/html" } });
}

export function flp(seed: string, size = 64): Buffer {
  const b = Buffer.alloc(size, 0);
  b.write("FLhd", 0, "latin1");
  b.writeUInt32LE(6, 4);
  b.write("FLdt", 14, "latin1");
  b.write(seed, 22, "utf8");
  return b;
}

export function wav(seed: string, samples = 800): Buffer {
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin((i + seed.length) / 8) * 8000), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "latin1");
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8, "latin1");
  h.write("fmt ", 12, "latin1");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(8000, 24);
  h.writeUInt32LE(16000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "latin1");
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data, Buffer.from(seed)]);
}
