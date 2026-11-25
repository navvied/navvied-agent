/**
 * The page as the browser's accessibility tree describes it, as text: what a person sees and can use, with a number on everything that
 * can be clicked or filled in. The numbers (refs) belong to one reading of one page; the tab that made them says when they expire.
 */

export interface AxValue { value?: unknown }
export interface AxNode {
  nodeId: string;
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
  value?: AxValue;
  properties?: { name: string; value: AxValue }[];
  childIds?: string[];
  backendDOMNodeId?: number;
}

/** What a number stands for: the element (by the browser's own id), and what it was called when it was numbered. */
export interface Ref { node: number; role: string; name: string; href?: string }

const USED = new Set(["button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "slider", "spinbutton", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "treeitem", "DisclosureTriangle", "PopUpButton", "ListBoxOption", "option", "listbox"]);
const FILLED = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider", "PopUpButton"]);
/** Roles that only group: they say nothing, their content does. */
const PLAIN = new Set(["generic", "none", "presentation", "paragraph", "group", "list", "section", "div", "Section", "RootWebArea", "WebArea", "LayoutTable", "LayoutTableRow", "LayoutTableCell", "listitem", "article", "rowgroup", "cell", "row", "gridcell", "Pre", "blockquote", "figure", "caption", "time", "mark", "emphasis", "strong", "code", "InlineTextBox", "LineBreak"]);
const NAMED = new Set(["navigation", "main", "banner", "contentinfo", "form", "search", "region", "complementary", "dialog", "alertdialog", "table", "grid", "toolbar", "menu", "menubar", "tablist", "tree", "alert", "status", "img", "image", "heading", "separator", "columnheader", "rowheader"]);

const text = (v: AxValue | undefined): string => (typeof v?.value === "string" || typeof v?.value === "number" ? String(v.value) : "");
const prop = (n: AxNode, name: string): unknown => n.properties?.find((p) => p.name === name)?.value.value;
const clean = (s: string, max = 200): string => { const t = s.replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max)}…` : t; };

export interface Reading { lines: string[]; refs: Map<number, Ref> }

export function readTree(nodes: AxNode[]): Reading {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const lines: string[] = [];
  const refs = new Map<number, Ref>();

  const options = (n: AxNode): string[] => {
    const out: string[] = [];
    const visit = (id: string): void => { const c = byId.get(id); if (!c) return; if (/option/i.test(text(c.role)) && text(c.name)) out.push(clean(text(c.name), 40)); else for (const k of c.childIds ?? []) visit(k); };
    for (const k of n.childIds ?? []) visit(k);
    return out.slice(0, 12);
  };

  const walk = (id: string, depth: number): void => {
    const n = byId.get(id);
    if (!n) return;
    const role = text(n.role), name = clean(text(n.name));
    const at = "  ".repeat(Math.min(depth, 6));
    const children = (d: number): void => { for (const k of n.childIds ?? []) walk(k, d); };
    if (n.ignored) { children(depth); return; }
    if (role === "StaticText" || role === "text") { if (name) lines.push(`${at}${name}`); return; }
    if (role === "InlineTextBox" || role === "LineBreak" || role === "ListMarker") return;
    const used = USED.has(role) && n.backendDOMNodeId !== undefined;
    // A generic element the page made focusable and named (a clickable div) is a control as well.
    const control = used || (n.backendDOMNodeId !== undefined && prop(n, "focusable") === true && !!name && (role === "generic" || role === ""));
    if (control) {
      const number = refs.size + 1;
      const href = role === "link" ? text({ value: prop(n, "url") }) : "";
      refs.set(number, { node: n.backendDOMNodeId!, role: role || "generic", name, ...(href ? { href } : {}) });
      const state: string[] = [];
      const checked = prop(n, "checked"); if (checked !== undefined) state.push(checked === "mixed" ? "mixed" : checked === true || checked === "true" ? "checked" : "unchecked");
      for (const flag of ["disabled", "expanded", "selected", "required", "invalid", "pressed"]) { const v = prop(n, flag); if (v === true || v === "true") state.push(flag); }
      const value = FILLED.has(role) || role === "combobox" ? clean(text(n.value), 60) : "";
      const choices = role === "combobox" || role === "PopUpButton" ? options(n) : [];
      lines.push(`${at}[${number}] ${role || "clickable"}${name ? ` "${name}"` : ""}${state.length ? ` (${state.join(", ")})` : ""}${value ? ` value="${value}"` : ""}${href ? ` -> ${href.slice(0, 120)}` : ""}${choices.length ? ` options: ${choices.join(" | ")}` : ""}`);
      if (role === "listbox" || role === "tree" || role === "tab") children(depth + 1);
      return;
    }
    if (role === "heading") { if (name) lines.push(`${at}heading${prop(n, "level") ? ` ${prop(n, "level")}` : ""}: ${name}`); else children(depth); return; }
    if ((role === "img" || role === "image") && name) { lines.push(`${at}image: ${name}`); return; }
    if (NAMED.has(role) && role !== "img" && role !== "image") {
      if (name) lines.push(`${at}${role} "${name}"`);
      children(name ? depth + 1 : depth);
      return;
    }
    if (role === "listitem") { const before = lines.length; children(depth + 1); if (lines.length > before) lines[before] = `${at}- ${lines[before]!.trimStart()}`; return; }
    if (PLAIN.has(role) || !role) { children(depth); return; }
    // Anything else with a name is said once, with its role.
    if (name) lines.push(`${at}${role}: ${name}`); else children(depth);
  };

  const roots = nodes.filter((n) => !nodes.some((o) => o.childIds?.includes(n.nodeId)));
  for (const r of roots.length ? roots : nodes.slice(0, 1)) walk(r.nodeId, 0);
  return { lines, refs };
}
