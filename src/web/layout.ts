// The page shell every screen renders into: the top bar, the navigation the feature modules register, the flash
// message and the sign-out form. No inline script or style anywhere (the CSP forbids both).
import { html, type Html } from "./html.js";

export interface NavItem {
  href: string;
  label: string;
  /** Lower first. */
  order: number;
  /** Shown to everyone, or only when signed in. */
  who: "everyone" | "signed-in";
}

export interface PageUser {
  displayName: string;
  handle: string;
  csrfToken: string;
  admin: boolean;
}

export interface PageOptions {
  title: string;
  user?: PageUser | undefined;
  nav?: NavItem[];
  current?: string;
  flash?: { kind: "ok" | "error"; text: string } | undefined;
  /** Extra stylesheets for this page, under /static/. */
  styles?: string[];
  /** Scripts for this page, under /static/: progressive enhancement only, every page works without them. */
  scripts?: string[];
  /** The page runs edge to edge (the landing page), not in the reading column. */
  fullWidth?: boolean;
}

export function initialsOf(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter((w) => /\p{L}|\p{N}/u.test(w));
  if (!words.length) return "?";
  const first = (w: string) => Array.from(w.replace(/^[^\p{L}\p{N}]+/u, ""))[0] ?? "";
  const letters = words.length === 1 ? first(words[0]!) : first(words[0]!) + first(words[words.length - 1]!);
  return letters.toLocaleUpperCase() || "?";
}

const asset = (s: string, ext: "css" | "js") => new RegExp(`^/static/[a-z0-9-]+\\.${ext}$`).test(s);

export function page(options: PageOptions, body: Html): Html {
  const { title, user, nav = [], current, flash, styles = [], scripts = [] } = options;
  const items = [...nav].filter((i) => i.who === "everyone" || user).sort((a, b) => a.order - b.order);
  const link = (i: NavItem) => html`<a href="${i.href}"${i.href === current ? html` aria-current="page"` : ""}>${i.label}</a>`;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title} · BeatBranch</title>
<link rel="stylesheet" href="/static/app.css">
${styles.filter((s) => asset(s, "css")).map((s) => html`<link rel="stylesheet" href="${s}">`)}
<link rel="icon" href="/static/icon.svg" type="image/svg+xml">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="topbar">
  <a class="brand" href="/"><img src="/static/icon.svg" alt="" width="26" height="26"><span>BeatBranch</span></a>
  <nav class="topnav" aria-label="Main">${items.map(link)}</nav>
  ${user
    ? html`<div class="topbar-end">
    <a class="button primary" href="/new">New project</a>
    <details class="profile">
      <summary class="avatar"><span aria-hidden="true">${initialsOf(user.displayName)}</span><span class="visually-hidden">Account menu for ${user.displayName}</span></summary>
      <div class="profile-menu">
        <p class="profile-name">${user.displayName} <span class="muted">@${user.handle}</span></p>
        <a href="/@${user.handle}">Your page</a>
        <a href="/settings">Settings</a>
        ${user.admin ? html`<a href="/admin/reports">Reports</a>` : ""}
        <form class="signout" method="post" action="/logout">
          <input type="hidden" name="_csrf" value="${user.csrfToken}">
          <button type="submit" class="button quiet">Sign out</button>
        </form>
      </div>
    </details>
  </div>`
    : html`<nav class="topbar-end" aria-label="Account"><a class="button quiet" href="/login">Sign in</a><a class="button primary" href="/register">Register</a></nav>`}
</header>
<main id="main" class="main${options.fullWidth ? " main-full" : ""}">
  ${flash ? html`<p class="flash ${flash.kind}" role="${flash.kind === "error" ? "alert" : "status"}">${flash.text}</p>` : ""}
  ${body}
</main>
${scripts.filter((s) => asset(s, "js")).map((s) => html`<script src="${s}" defer></script>`)}
</body>
</html>`;
}
