// Password hashing with scrypt from node:crypto: a random 16-byte salt per password, and the parameters stored with
// the hash so they can be raised later without breaking old hashes. Format: scrypt$<N>$<r>$<p>$<salt>$<hash>.
import crypto from "node:crypto";

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEYLEN = 64;
const MAXMEM = 128 * N * R * 2;

function scrypt(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password.normalize("NFKC"), salt, KEYLEN, { N: n, r, p, maxmem: 128 * n * r * 2 }, (err, key) =>
      err ? reject(err) : resolve(key)
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, N, R, P);
  return ["scrypt", N, R, P, salt.toString("base64url"), key.toString("base64url")].join("$");
}

/** True only for the right password. A malformed stored hash is false, never an error (fail closed). */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nText, rText, pText, saltText, hashText] = parts as [string, string, string, string, string, string];
  const n = Number(nText), r = Number(rText), p = Number(pText);
  if (![n, r, p].every(Number.isInteger) || n < 2 || 128 * n * r * 2 > MAXMEM * 4) return false;
  const expected = Buffer.from(hashText, "base64url");
  if (expected.length !== KEYLEN) return false;
  const actual = await scrypt(password, Buffer.from(saltText, "base64url"), n, r, p);
  return crypto.timingSafeEqual(actual, expected);
}
