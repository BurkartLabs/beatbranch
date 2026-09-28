// The only way pages build HTML. `html` escapes every interpolated value unless it is itself Html (built by `html` or
// passed through `trusted`), so a project name, a commit message or a handle can never become markup.

const brand = Symbol("html");

export interface Html {
  readonly [brand]: true;
  readonly value: string;
}

export function isHtml(v: unknown): v is Html {
  return typeof v === "object" && v !== null && (v as Html)[brand] === true;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function part(v: unknown): string {
  if (v === null || v === undefined || v === false) return "";
  if (isHtml(v)) return v.value;
  if (Array.isArray(v)) return v.map(part).join("");
  return escapeHtml(v);
}

/** Tagged template: `html\`<p>${name}</p>\`` escapes `name`; arrays are joined; null, undefined and false render nothing. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) out += part(values[i]) + (strings[i + 1] ?? "");
  return { [brand]: true, value: out };
}

/** Mark a string as markup. Only for strings this code wrote itself; never for anything that arrived from outside. */
export function trusted(markup: string): Html {
  return { [brand]: true, value: markup };
}

/** The id a field's error message gets, so the field can point at it with `aria-describedby`. */
export function errorId(field: string): string {
  return `err-${field}`;
}
