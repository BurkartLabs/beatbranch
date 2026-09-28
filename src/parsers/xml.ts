import { ParseError } from "./model.ts";

export interface El {
  name: string;
  attrs: Record<string, string>;
  children: El[];
  parent: El | null;
  start: number;
  end: number;
}

const MAX_ELEMENTS = 3_000_000;
const MAX_DEPTH = 400;

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g, (_, e: string) => {
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "amp") return "&";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    const code = e.startsWith("#x") ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
  });
}

export function parseXml(src: string): El {
  if (/<!DOCTYPE|<!ENTITY/i.test(src.slice(0, 4096)) || /<!ENTITY/i.test(src)) throw new ParseError("the file declares its own entities, which are refused");
  const root: El = { name: "#root", attrs: {}, children: [], parent: null, start: 0, end: src.length };
  let cur = root;
  let depth = 0;
  let count = 0;
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt < 0) break;
    if (src.startsWith("<!--", lt)) {
      const e = src.indexOf("-->", lt + 4);
      if (e < 0) throw new ParseError("an XML comment never ends");
      i = e + 3;
      continue;
    }
    if (src.startsWith("<?", lt)) {
      const e = src.indexOf("?>", lt + 2);
      if (e < 0) throw new ParseError("an XML declaration never ends");
      i = e + 2;
      continue;
    }
    if (src.startsWith("<![CDATA[", lt)) {
      const e = src.indexOf("]]>", lt);
      if (e < 0) throw new ParseError("a CDATA block never ends");
      i = e + 3;
      continue;
    }
    const gt = src.indexOf(">", lt);
    if (gt < 0) throw new ParseError("a tag never ends");
    if (src[lt + 1] === "/") {
      const name = src.slice(lt + 2, gt).trim();
      if (cur.name !== name) throw new ParseError(`the XML is badly nested at ${name.slice(0, 40)}`);
      cur.end = gt + 1;
      cur = cur.parent!;
      depth--;
      i = gt + 1;
      continue;
    }
    let body = src.slice(lt + 1, gt);
    let q = body.match(/"/g)?.length ?? 0;
    let close = gt;
    while (q % 2 === 1) {
      const next = src.indexOf(">", close + 1);
      if (next < 0) throw new ParseError("a tag never ends");
      body = src.slice(lt + 1, next);
      close = next;
      q = body.match(/"/g)?.length ?? 0;
    }
    const selfClosing = body.endsWith("/");
    if (selfClosing) body = body.slice(0, -1);
    const sp = body.search(/\s/);
    const name = sp < 0 ? body : body.slice(0, sp);
    const attrs: Record<string, string> = {};
    if (sp >= 0) {
      const re = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(body.slice(sp)))) attrs[m[1]!] = decode(m[2] ?? m[3] ?? "");
    }
    if (++count > MAX_ELEMENTS) throw new ParseError("the file holds too many elements");
    const el: El = { name, attrs, children: [], parent: cur, start: lt, end: close + 1 };
    cur.children.push(el);
    if (!selfClosing) {
      cur = el;
      if (++depth > MAX_DEPTH) throw new ParseError("the XML nests too deeply");
    }
    i = close + 1;
  }
  if (cur !== root) throw new ParseError("the XML ends before its elements close");
  return root;
}

export function child(el: El | null | undefined, name: string): El | null {
  return el?.children.find((c) => c.name === name) ?? null;
}

export function path(el: El | null | undefined, ...names: string[]): El | null {
  let cur: El | null = el ?? null;
  for (const n of names) cur = child(cur, n);
  return cur;
}

export function val(el: El | null | undefined, ...names: string[]): string | null {
  const e = path(el, ...names);
  return e?.attrs.Value ?? null;
}

export function* walk(el: El): Generator<El> {
  for (const c of el.children) {
    yield c;
    yield* walk(c);
  }
}

export function all(el: El, name: string): El[] {
  const out: El[] = [];
  for (const e of walk(el)) if (e.name === name) out.push(e);
  return out;
}

export function under(el: El, ancestor: string): boolean {
  for (let p = el.parent; p; p = p.parent) if (p.name === ancestor) return true;
  return false;
}
