import crypto from "node:crypto";
import { z } from "zod";
import { refuse, SESSION_COOKIE, type Deps, type Module } from "../app.js";
import { safeNext } from "../auth/module.js";
import { hashPassword } from "../auth/password.js";
import { createSession, RESERVED_HANDLES, SESSION_IDLE_MS } from "../auth/users.js";
import { secret } from "../config.js";

export type Provider = "google" | "discord";

export const PROVIDERS: Record<Provider, { name: string; authorize: string; token: string; me: string; scope: string }> = {
  google: { name: "Google", authorize: "https://accounts.google.com/o/oauth2/v2/auth", token: "https://oauth2.googleapis.com/token", me: "https://openidconnect.googleapis.com/v1/userinfo", scope: "openid email profile" },
  discord: { name: "Discord", authorize: "https://discord.com/oauth2/authorize", token: "https://discord.com/api/oauth2/token", me: "https://discord.com/api/users/@me", scope: "identify email" }
};

const OAUTH_COOKIE = "bb_oauth";

export function clientOf(deps: Deps, p: Provider): { id: string; secret: string } | null {
  const up = p.toUpperCase();
  const id = secret(deps.config, `${up}_CLIENT_ID`);
  const sec = secret(deps.config, `${up}_CLIENT_SECRET`);
  return id && sec ? { id, secret: sec } : null;
}

export function enabledProviders(deps: Deps): Provider[] {
  return (Object.keys(PROVIDERS) as Provider[]).filter((p) => clientOf(deps, p));
}

type Fetch = typeof fetch;
export function fetcher(deps: Deps): Fetch {
  return deps.fetch ?? fetch;
}

interface Profile {
  subject: string;
  email: string;
  verified: boolean;
  name: string;
}

async function profileOf(deps: Deps, p: Provider, code: string, redirect: string): Promise<Profile | null> {
  const client = clientOf(deps, p)!;
  const f = fetcher(deps);
  const tokenRes = await f(PROVIDERS[p].token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: client.id, client_secret: client.secret }).toString(),
    signal: AbortSignal.timeout(10000)
  });
  if (!tokenRes.ok) return null;
  const token = z.object({ access_token: z.string().min(1).max(4096) }).safeParse(await tokenRes.json());
  if (!token.success) return null;
  const meRes = await f(PROVIDERS[p].me, { headers: { authorization: `Bearer ${token.data.access_token}`, accept: "application/json" }, signal: AbortSignal.timeout(10000) });
  if (!meRes.ok) return null;
  const me = (await meRes.json()) as Record<string, unknown>;
  if (p === "google") {
    const g = z.object({ sub: z.string().max(255), email: z.string().max(254), email_verified: z.boolean(), name: z.string().max(200).optional() }).safeParse(me);
    return g.success ? { subject: g.data.sub, email: g.data.email.toLowerCase(), verified: g.data.email_verified, name: g.data.name ?? g.data.email.split("@")[0]! } : null;
  }
  const d = z.object({ id: z.string().max(64), email: z.string().max(254).nullable().optional(), verified: z.boolean().optional(), username: z.string().max(64), global_name: z.string().max(100).nullable().optional() }).safeParse(me);
  if (!d.success || !d.data.email) return null;
  return { subject: d.data.id, email: d.data.email.toLowerCase(), verified: d.data.verified === true, name: d.data.global_name || d.data.username };
}

export function handleFrom(name: string): string {
  const base = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  return base.length >= 3 ? base : `producer-${base}`.replace(/-+$/, "");
}

async function freeHandle(deps: Deps, name: string): Promise<string> {
  const base = handleFrom(name);
  for (let i = 0; i < 50; i++) {
    const h = i === 0 ? base : `${base}-${i + 1}`;
    if (RESERVED_HANDLES.has(h)) continue;
    if (!(await deps.db.get("SELECT 1 AS x FROM users WHERE handle = ?", [h]))) return h;
  }
  return `${base}-${crypto.randomBytes(3).toString("hex")}`;
}

const oauth: Module = {
  name: "oauth",
  register(app, deps: Deps) {
    app.get("/auth/:provider", { config: { public: true } }, async (req, reply) => {
      const p = z.enum(["google", "discord"]).safeParse((req.params as { provider: string }).provider);
      if (!p.success || !clientOf(deps, p.data)) return reply.callNotFound();
      const state = crypto.randomBytes(24).toString("base64url");
      const next = safeNext((req.query as { next?: string }).next);
      reply.setCookie(OAUTH_COOKIE, `${state}.${p.data}.${Buffer.from(next).toString("base64url")}`, { httpOnly: true, sameSite: "lax", secure: deps.config.secureCookies, path: "/auth", maxAge: 600 });
      const url = new URL(PROVIDERS[p.data].authorize);
      url.search = new URLSearchParams({ client_id: clientOf(deps, p.data)!.id, redirect_uri: `${deps.config.publicUrl}/auth/${p.data}/callback`, response_type: "code", scope: PROVIDERS[p.data].scope, state, prompt: p.data === "discord" ? "none" : "select_account" }).toString();
      return reply.redirect(url.toString(), 303);
    });

    app.get("/auth/:provider/callback", { config: { public: true } }, async (req, reply) => {
      const p = z.enum(["google", "discord"]).safeParse((req.params as { provider: string }).provider);
      if (!p.success || !clientOf(deps, p.data)) return reply.callNotFound();
      const q = z.object({ code: z.string().max(2048).optional(), state: z.string().max(200).optional() }).parse(req.query);
      const cookie = String(req.cookies[OAUTH_COOKIE] ?? "");
      reply.clearCookie(OAUTH_COOKIE, { path: "/auth" });
      const [state, provider, nextB64] = cookie.split(".");
      const back = { href: "/login", label: "Back to sign-in" };
      if (!q.code || !q.state || !state || provider !== p.data || q.state.length !== state.length || !crypto.timingSafeEqual(Buffer.from(q.state), Buffer.from(state))) {
        return refuse(req, reply, deps, 400, "That sign-in didn't come back the way it should, so it was stopped. Try again.", back);
      }
      let profile: Profile | null = null;
      try {
        profile = await profileOf(deps, p.data, q.code, `${deps.config.publicUrl}/auth/${p.data}/callback`);
      } catch {
        profile = null;
      }
      const name = PROVIDERS[p.data].name;
      if (!profile) return refuse(req, reply, deps, 502, `${name} didn't let us sign you in. Try again, or use your email and password.`, back);
      if (!profile.verified) return refuse(req, reply, deps, 403, `Your ${name} email isn't confirmed yet. Confirm it with ${name}, then try again.`, back);
      let userId = (await deps.db.get<{ user_id: string }>("SELECT user_id FROM identities WHERE provider = ? AND subject = ?", [p.data, profile.subject]))?.user_id;
      if (!userId) {
        const existing = await deps.db.get<{ id: string }>("SELECT id FROM users WHERE email = ?", [profile.email]);
        if (existing) userId = existing.id;
        else {
          if (deps.config.signup === "closed") return refuse(req, reply, deps, 403, "Registration is closed for now.", back);
          userId = crypto.randomUUID();
          const handle = await freeHandle(deps, profile.name);
          const unusable = await hashPassword(crypto.randomBytes(32).toString("base64url"));
          const first = !(await deps.db.get("SELECT 1 AS x FROM users LIMIT 1"));
          await deps.db.run("INSERT INTO users (id, email, handle, display_name, password_hash, role, created_at, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
            userId, profile.email, handle, profile.name.slice(0, 80).replace(/[<>\u0000-\u001f]/g, "") || handle, unusable, first ? "admin" : "producer", Date.now(), first ? Date.now() : null
          ]);
        }
        await deps.db.run("INSERT INTO identities (provider, subject, user_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING", [p.data, profile.subject, userId, Date.now()]);
      }
      const { token } = await createSession(deps.db, userId);
      reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: "strict", secure: deps.config.secureCookies, path: "/", maxAge: Math.floor(SESSION_IDLE_MS / 1000) });
      let next = "/";
      try {
        next = safeNext(Buffer.from(nextB64 ?? "", "base64url").toString("utf8"));
      } catch {
        next = "/";
      }
      return reply
        .type("text/html; charset=utf-8")
        .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${next.replace(/[&"<>]/g, "")}"><title>Signed in · BeatBranch</title><link rel="stylesheet" href="/static/app.css"></head><body><main class="main"><p class="panel narrow">Signed in. <a href="${next.replace(/[&"<>]/g, "")}">Continue</a></p></main></body></html>`);
    });
  }
};

export default oauth;
