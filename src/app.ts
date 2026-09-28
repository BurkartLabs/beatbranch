// The web app: security headers, the sign-in guard, CSRF and origin checks, static files, and the feature modules
// (DESIGN "Security at design time"). Feature modules are found, not listed: each folder under src/ may hold a
// module.ts that exports a Module, so stories built in parallel add a folder instead of editing a shared list
// (P-SHARED-LINE). The shape is job-hunt's src/app.ts, which its route-inventory and cross-user tests grew on.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from "fastify";
import formbody from "@fastify/formbody";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { ZodError } from "zod";
import type { Config } from "./config.js";
import type { Db } from "./db/db.js";
import { findSession, getUser, type Session, type User } from "./auth/users.js";
import { page, type NavItem, type PageOptions } from "./web/layout.js";
import { html, type Html } from "./web/html.js";
import { repoRoot } from "./paths.js";
import { readVersion } from "./version.js";

export const SESSION_COOKIE = "bb_session";
/** The largest request body any route accepts. Uploads set their own limit on their own route. */
export const BODY_LIMIT = 64 * 1024;
const HSTS_MAX_AGE_SECONDS = 31_536_000;

/** The socket's own address, never a forwarded one, for a check that must hold even when a header lies. */
export function socketAddress(req: FastifyRequest): string {
  return (req.raw.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
}

export interface Deps {
  db: Db;
  config: Config;
  nav: NavItem[];
  fetch?: typeof fetch;
}

export interface Module {
  name: string;
  nav?: NavItem[];
  register(app: FastifyInstance, deps: Deps): void | Promise<void>;
}

declare module "fastify" {
  interface FastifyRequest {
    user: User | null;
    session: Session | null;
    sessionToken: string | undefined;
  }
  interface FastifyContextConfig {
    /** Reachable without signing in. beatbranch is public by default (AB#4685): most GET pages say so. */
    public?: boolean;
    multipart?: boolean;
  }
  interface FastifyInstance {
    /** Every route registered, in order: what the route inventory test holds the inventory to. */
    registeredRoutes: RegisteredRoute[];
  }
}

export interface RegisteredRoute {
  method: string;
  url: string;
  public: boolean;
}

/** Render a page for this request, with its user, navigation and CSRF token. */
export async function render(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: Deps,
  options: Omit<PageOptions, "user" | "nav">,
  body: Html,
  status = 200
): Promise<FastifyReply> {
  const user = req.user && req.session ? { displayName: req.user.displayName, handle: req.user.handle, csrfToken: req.session.csrfToken, admin: req.user.role === "admin" } : undefined;
  return reply
    .code(status)
    .type("text/html; charset=utf-8")
    .send(page({ ...options, user, nav: deps.nav }, body).value);
}

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const wantsHtml = (req: FastifyRequest) => String(req.headers.accept ?? "").includes("text/html");

/** Refuse a request with fixed text: a page for a browser, JSON for anything else. Never the input or a parser's message. */
export async function refuse(req: FastifyRequest, reply: FastifyReply, deps: Deps, status: number, text: string, action?: { href: string; label: string }) {
  if (!wantsHtml(req)) return reply.code(status).send({ error: text });
  const next = action ?? { href: req.user ? "/" : "/login", label: req.user ? "Back to your projects" : "Sign in" };
  return await render(req, reply, deps, { title: "Not done" }, html`<section class="panel narrow"><h1>Not done</h1><p>${text}</p><p><a class="button primary" href="${next.href}">${next.label}</a></p></section>`, status);
}

function sameOrigin(req: FastifyRequest, config: Config): boolean {
  const origin = req.headers.origin ?? (req.headers.referer ? safeOrigin(req.headers.referer) : undefined);
  if (!origin) return false; // browsers send Origin on every POST; its absence is not trusted (fail closed)
  const allowed = new Set([new URL(config.publicUrl).origin]);
  if (req.headers.host) allowed.add(`${config.secureCookies ? "https" : "http"}://${req.headers.host}`);
  return allowed.has(origin);
}

function safeOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function csrfFrom(req: FastifyRequest): string | undefined {
  const header = req.headers["x-csrf-token"];
  if (typeof header === "string") return header;
  const body = req.body as Record<string, unknown> | undefined;
  return body && typeof body._csrf === "string" ? body._csrf : undefined;
}

async function loadModules(): Promise<Module[]> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const ext = path.extname(fileURLToPath(import.meta.url)); // .ts under vitest, .js from dist
  const modules: Module[] = [];
  for (const entry of fs.readdirSync(here, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const file = path.join(here, entry.name, `module${ext}`);
    if (!fs.existsSync(file)) continue;
    const mod = (await import(pathToFileURL(file).href)).default as Module;
    if (!mod || typeof mod.register !== "function") throw new Error(`${entry.name}/module${ext} does not export a Module`);
    modules.push(mod);
  }
  return modules;
}

export async function buildApp(config: Config, db: Db, options: { logStream?: NodeJS.WritableStream; fetch?: typeof fetch } = {}): Promise<FastifyInstance> {
  const serverOptions: FastifyServerOptions = {
    bodyLimit: BODY_LIMIT,
    // Exactly one hop behind Container Apps' ingress, none otherwise (T-094: a hop count trusts nothing in this Fastify).
    trustProxy: config.trustProxy ? (_address: string, hop: number) => hop === 0 : false,
    logger:
      config.logLevel === "silent"
        ? false
        : {
            level: config.logLevel,
            ...(options.logStream ? { stream: options.logStream } : {}),
            // Logs carry ids, counts and codes only. No query strings, no bodies, no cookies.
            serializers: {
              req: (r) => ({ method: r.method, url: String(r.url).split("?")[0] ?? "", id: r.id }),
              res: (r) => ({ statusCode: r.statusCode })
            }
          }
  };
  const app = Fastify(serverOptions);

  const registered: RegisteredRoute[] = [];
  app.decorate("registeredRoutes", registered);
  app.addHook("onRoute", (route) => {
    for (const method of [route.method].flat()) {
      if (method === "HEAD") continue;
      registered.push({ method, url: route.url, public: route.config?.public === true });
    }
  });

  const modules = await loadModules();
  const deps: Deps = { db, config, nav: modules.flatMap((m) => m.nav ?? []), ...(options.fetch ? { fetch: options.fetch } : {}) };

  await app.register(formbody);
  await app.register(cookie);
  await app.register(fastifyStatic, {
    root: path.join(repoRoot(), "src", "web", "static"),
    prefix: "/static/",
    index: false,
    dotfiles: "deny"
  });

  app.decorateRequest("user", null);
  app.decorateRequest("session", null);
  app.decorateRequest("sessionToken", undefined);

  // Security headers on every response, the 404 included (T-102).
  app.addHook("onSend", async (req, reply) => {
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data:; media-src 'self' blob:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
    );
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "same-origin");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Cross-Origin-Opener-Policy", "same-origin");
    if (config.secureCookies) reply.header("Strict-Transport-Security", `max-age=${HSTS_MAX_AGE_SECONDS}; includeSubDomains`);
    if (!req.url.startsWith("/static/")) reply.header("Cache-Control", "no-store");
  });

  // Who is asking. A route is reachable signed out only when it says `public`; static files are public.
  app.addHook("onRequest", async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    const session = await findSession(deps.db, token);
    const user = session ? await getUser(deps.db, session.userId) : null;
    if (session && user) {
      req.session = session;
      req.user = user;
      req.sessionToken = token;
    }
    // An address nothing serves gets the 404 page whoever asks: a redirect to sign-in would tell a stranger nothing.
    const isPublic = req.is404 || req.url.startsWith("/static/") || req.routeOptions.config?.public === true;
    if (!req.user && !isPublic) {
      if (req.method === "GET" || req.method === "HEAD") return reply.redirect(`/login?next=${encodeURIComponent(req.url)}`, 303);
      return await refuse(req, reply, deps, 401, "You are signed out, so that was not saved. Sign in and try again.", { href: "/login", label: "Sign in" });
    }
  });

  // State-changing requests: same origin always, and the session's CSRF token once signed in, before the handler runs.
  app.addHook("preHandler", async (req, reply) => {
    if (!UNSAFE.has(req.method)) return;
    if (!sameOrigin(req, config)) return await refuse(req, reply, deps, 403, "That form did not come from this site, so it was not sent. Nothing was saved.");
    if (req.session && req.routeOptions.config?.multipart !== true && csrfFrom(req) !== req.session.csrfToken) {
      return await refuse(req, reply, deps, 403, "This form has expired. Reload the page and try again. Nothing was saved.");
    }
  });

  app.get("/healthz", { config: { public: true } }, async () => ({ ok: true }));
  // T-086: what this build is, so a running copy can say how far behind it is.
  app.get("/version", { config: { public: true } }, async () => readVersion(config.versionFile) ?? { version: null });

  for (const mod of modules) await mod.register(app, deps);

  app.setNotFoundHandler((req, reply) =>
    render(req, reply, deps, { title: "Not found" }, html`<section class="panel narrow"><h1>Not found</h1><p>There is nothing at this address.</p><p><a class="button" href="/">Home</a></p></section>`, 404)
  );

  app.setErrorHandler((error, req, reply) => {
    const status = Number((error as { statusCode?: number }).statusCode) || 500;
    if (error instanceof ZodError || (status >= 400 && status < 500)) {
      const text =
        status === 413 ? "That is more than this form accepts." : status === 415 ? "That kind of request is not accepted." : "That request could not be read.";
      return refuse(req, reply, deps, error instanceof ZodError ? 400 : status, text);
    }
    const failure = error as { name?: string; code?: string };
    req.log.error({ err: { type: failure.name, code: failure.code } }, "request failed");
    return refuse(req, reply, deps, 500, "Something went wrong. Nothing was saved.");
  });

  return app;
}
