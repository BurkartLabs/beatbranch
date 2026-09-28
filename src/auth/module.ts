// Register, sign in, sign out (AB#2716; DESIGN "Accounts and projects"). Email + password only: Google and Discord
// sign-in are AB#2726. Open registration is the Board's answer (AB#4685); SIGNUP=closed turns the form off.
//
// Security: passwords are scrypt-hashed (password.ts); an unknown email and a wrong password get the same words and
// the same work (users.ts decoy hash); failed sign-ins are counted per address and per account and refused past ten
// in fifteen minutes; registrations are limited per address; the session cookie is HttpOnly, SameSite=Strict, Secure
// under https; every POST already passed the same-origin check in app.ts. Nothing identifying is logged.
import type { FastifyReply } from "fastify";
import { z } from "zod";
import { refuse, render, SESSION_COOKIE, type Deps, type Module } from "../app.js";
import { checkLimit, clearLimit, countLimit, RATE_LIMITS, retryAfterSeconds, retryWords, takeLimit } from "../limits/limits.js";
import { errorId, html, type Html } from "../web/html.js";
import { authenticate, createSession, createUser, destroySession, Email, Handle, NewUser, Password, SESSION_IDLE_MS, userIdForEmail } from "./users.js";

/** Where to go after signing in: a path on this site, never another site (an open redirect otherwise). */
export function safeNext(next: unknown): string {
  return typeof next === "string" && /^\/(?!\/)[^\s]*$/.test(next) && next.length <= 512 ? next : "/";
}

const RegisterForm = z.object({
  email: z.string().max(300),
  handle: z.string().max(60),
  displayName: z.string().max(120),
  password: z.string().max(300),
  next: z.string().max(512).optional()
});
const LoginForm = z.object({ email: z.string().max(300), password: z.string().max(300), next: z.string().max(512).optional() });

type FieldErrors = Partial<Record<"email" | "handle" | "displayName" | "password", string>>;

function field(name: keyof FieldErrors, label: string, input: Html, errors: FieldErrors, hint?: string): Html {
  const err = errors[name];
  return html`<label for="${name}">${label}</label>${input}${hint ? html`<p class="hint">${hint}</p>` : ""}${err ? html`<p class="field-error" id="${errorId(name)}">${err}</p>` : ""}`;
}

function registerPage(values: { email?: string; handle?: string; displayName?: string; next?: string }, errors: FieldErrors, csrf: string | undefined): Html {
  const aria = (n: keyof FieldErrors) => (errors[n] ? html` aria-invalid="true" aria-describedby="${errorId(n)}"` : "");
  return html`<section class="panel narrow">
  <h1>Create your account</h1>
  <p class="muted">Your handle is your page: beatbranch/@handle. Projects you make can be public, unlisted or private.</p>
  <form method="post" action="/register" novalidate>
    ${csrf ? html`<input type="hidden" name="_csrf" value="${csrf}">` : ""}
    <input type="hidden" name="next" value="${values.next ?? "/"}">
    ${field("displayName", "Artist name", html`<input id="displayName" name="displayName" type="text" required maxlength="80" autocomplete="name" value="${values.displayName ?? ""}"${aria("displayName")}>`, errors)}
    ${field("handle", "Handle", html`<input id="handle" name="handle" type="text" required maxlength="30" autocomplete="username" spellcheck="false" value="${values.handle ?? ""}"${aria("handle")}>`, errors, "3 to 30 letters, digits or hyphens.")}
    ${field("email", "Email", html`<input id="email" name="email" type="email" required maxlength="254" autocomplete="email" value="${values.email ?? ""}"${aria("email")}>`, errors)}
    ${field("password", "Password", html`<input id="password" name="password" type="password" required minlength="12" maxlength="256" autocomplete="new-password"${aria("password")}>`, errors, "At least 12 characters. A sentence works well.")}
    <div class="actions"><button type="submit" class="button primary">Create account</button><a class="button quiet" href="/login">I have an account</a></div>
  </form>
</section>`;
}

function loginPage(values: { email?: string; next?: string }, error: string | undefined, csrf: string | undefined): Html {
  return html`<section class="panel narrow">
  <h1>Sign in</h1>
  <form method="post" action="/login" novalidate>
    ${csrf ? html`<input type="hidden" name="_csrf" value="${csrf}">` : ""}
    <input type="hidden" name="next" value="${values.next ?? "/"}">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" required maxlength="254" autocomplete="email" value="${values.email ?? ""}"${error ? html` aria-invalid="true" aria-describedby="${errorId("login")}"` : ""}>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" required maxlength="256" autocomplete="current-password">
    ${error ? html`<p class="field-error" id="${errorId("login")}" role="alert">${error}</p>` : ""}
    <div class="actions"><button type="submit" class="button primary">Sign in</button><a class="button quiet" href="/register">Create an account</a></div>
  </form>
</section>`;
}

/** The Zod issues of NewUser, as one message per field. */
function fieldErrors(error: z.ZodError): FieldErrors {
  const out: FieldErrors = {};
  // Our own words per field, never the parser's: the schema's messages are for logs and tests, these are for people.
  for (const issue of error.issues) {
    const name = String(issue.path[0]) as keyof FieldErrors;
    out[name] ??= defaultMessage(name);
  }
  return out;
}

function defaultMessage(name: keyof FieldErrors): string {
  return { email: "Enter an email address.", handle: "3 to 30 letters, digits or hyphens.", displayName: "Enter an artist name.", password: "At least 12 characters." }[name];
}

function setSessionCookie(reply: FastifyReply, deps: Deps, token: string) {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: deps.config.secureCookies,
    path: "/",
    maxAge: Math.floor(SESSION_IDLE_MS / 1000)
  });
}

const auth: Module = {
  name: "auth",
  register(app, deps) {
    app.get("/register", { config: { public: true } }, async (req, reply) => {
      if (req.user) return reply.redirect("/", 303);
      if (deps.config.signup === "closed") return refuse(req, reply, deps, 403, "Registration is closed for now.", { href: "/login", label: "Sign in" });
      const q = req.query as { next?: string };
      return render(req, reply, deps, { title: "Create your account", current: "/register" }, registerPage({ next: safeNext(q.next) }, {}, undefined));
    });

    app.post("/register", { config: { public: true } }, async (req, reply) => {
      if (req.user) return reply.redirect("/", 303);
      if (deps.config.signup === "closed") return refuse(req, reply, deps, 403, "Registration is closed for now.", { href: "/login", label: "Sign in" });
      const form = RegisterForm.parse(req.body);
      const next = safeNext(form.next);
      const values = { email: form.email, handle: form.handle, displayName: form.displayName, next };
      const parsed = NewUser.safeParse({ email: form.email, handle: form.handle, displayName: form.displayName, password: form.password });
      if (!parsed.success) return render(req, reply, deps, { title: "Create your account", current: "/register" }, registerPage(values, fieldErrors(parsed.error), undefined), 400);
      const limit = await takeLimit(deps.db, "register-address", req.ip);
      if (!limit.ok) {
        reply.header("Retry-After", retryAfterSeconds(limit.retryAt));
        return refuse(req, reply, deps, 429, `${RATE_LIMITS["register-address"].says} Try again ${retryWords(limit.retryAt)}.`, { href: "/", label: "Home" });
      }
      const made = await createUser(deps.db, parsed.data);
      if (!made.ok) {
        const errors: FieldErrors =
          made.reason === "email-taken" ? { email: "An account already uses that email. Sign in instead, or use another." } : made.reason === "handle-taken" ? { handle: "That handle is taken." } : { handle: "That handle is not available." };
        return render(req, reply, deps, { title: "Create your account", current: "/register" }, registerPage(values, errors, undefined), 409);
      }
      const { token } = await createSession(deps.db, made.user.id);
      setSessionCookie(reply, deps, token);
      req.log.info({ userId: made.user.id }, "account created");
      return reply.redirect(next, 303);
    });

    app.get("/login", { config: { public: true } }, async (req, reply) => {
      if (req.user) return reply.redirect("/", 303);
      const q = req.query as { next?: string };
      return render(req, reply, deps, { title: "Sign in", current: "/login" }, loginPage({ next: safeNext(q.next) }, undefined, undefined));
    });

    app.post("/login", { config: { public: true } }, async (req, reply) => {
      if (req.user) return reply.redirect("/", 303);
      const form = LoginForm.parse(req.body);
      const next = safeNext(form.next);
      const email = Email.safeParse(form.email);
      const password = Password.safeParse(form.password);
      // The address's failures first, then the account's: both refuse before any password work is done.
      const byAddress = await checkLimit(deps.db, "sign-in-address", req.ip);
      if (!byAddress.ok) return tooMany(byAddress.retryAt);
      const accountId = email.success ? await userIdForEmail(deps.db, email.data) : undefined;
      if (accountId) {
        const byAccount = await checkLimit(deps.db, "sign-in-account", accountId);
        if (!byAccount.ok) return tooMany(byAccount.retryAt);
      }
      // Whatever failed to parse, the same work and the same words as a wrong password (no field says which).
      const user = email.success && password.success ? await authenticate(deps.db, email.data, password.data) : await authenticate(deps.db, "nobody@invalid", String(form.password).slice(0, 256));
      if (!user) {
        await countLimit(deps.db, "sign-in-address", req.ip);
        if (accountId) await countLimit(deps.db, "sign-in-account", accountId);
        return render(req, reply, deps, { title: "Sign in", current: "/login" }, loginPage({ email: form.email, next }, "That email and password do not match.", undefined), 401);
      }
      await clearLimit(deps.db, "sign-in-account", user.id);
      const { token } = await createSession(deps.db, user.id);
      setSessionCookie(reply, deps, token);
      return reply.redirect(next, 303);

      function tooMany(retryAt: number) {
        reply.header("Retry-After", retryAfterSeconds(retryAt));
        return refuse(req, reply, deps, 429, `${RATE_LIMITS["sign-in-address"].says} Try again ${retryWords(retryAt)}.`, { href: "/login", label: "Back to sign-in" });
      }
    });

    app.post("/logout", async (req, reply) => {
      await destroySession(deps.db, req.sessionToken);
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      return reply.redirect("/", 303);
    });
  }
};

export default auth;
