// fasthands — src/observe/engine.ts
//
// ObservationEngine: captures a compact interactive-element tree from a live
// Playwright Page in ONE page.evaluate() per snapshot, assigns stable refs
// across turns via a structural stability key (role+name+parent+sibling
// index), diffs against the previous snapshot, serializes to a compact text
// format, and enforces a token budget by progressively dropping offscreen
// nodes and then truncating names.
//
// Implements against src/types.ts (frozen contract). Do not import anything
// that isn't `import type` from that file — it must stay erasable.

import type { Page } from "playwright";
import type {
  FHNode,
  Observation,
  ObservationEngine,
  ResolvedNode,
  Snapshot,
} from "../types.ts";

// ---------------------------------------------------------------------------
// Ambient shims so this file typechecks without a "dom" lib entry (we can't
// touch tsconfig.json, which is out of scope). These identifiers only ever
// run inside page.evaluate()/elementHandle.evaluate() callbacks, i.e. in the
// browser realm — never in the Node realm this file is compiled/stripped in.
// `declare const` emits no runtime code, so this is purely a type-level fix.
// ---------------------------------------------------------------------------
declare const document: any;
declare const getComputedStyle: any;
declare const location: any;

// ---------------------------------------------------------------------------
// Shared small constants. NOTE: INTERACTIVE_ROLES is duplicated verbatim
// inside the in-browser evaluate callback below (walkPage) because
// page.evaluate() callbacks are serialized and re-executed in a separate JS
// realm — they cannot close over Node-side module variables. Keep the two
// copies in sync if you touch the role list.
// ---------------------------------------------------------------------------
const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "combobox",
  "textbox",
  "slider",
  "spinbutton",
  "searchbox",
  "option",
]);

// ---------------------------------------------------------------------------
// Internal node shape: a strict superset of FHNode. `stabilityKey` drives ref
// continuity across turns; `contentHash` drives diff/drift detection. Kept
// off the frozen FHNode type but structurally compatible with it, so we can
// hand `RawNode` straight to a `Snapshot.tree: FHNode` field without copying.
// ---------------------------------------------------------------------------
interface RawNode {
  ref: string;
  role: string;
  name: string;
  value?: string;
  state?: string[];
  inViewport: boolean;
  stabilityKey: string;
  contentHash: string;
  children: RawNode[];
}

interface RawSnapshotResult {
  url: string;
  title: string;
  tree: RawNode;
  nextCounter: number;
  scroll: { y: number; viewportH: number; docH: number };
}

interface WalkArgs {
  prevMap: [string, string][];
  startCounter: number;
}

// ---------------------------------------------------------------------------
// The single in-page DOM walk. Runs entirely inside the browser via one
// page.evaluate() call — no per-node round trips. Computes role/name/value/
// state/inViewport, structural stability keys, content hashes, and tags each
// kept element with data-fh-ref so resolve() can find it later.
// ---------------------------------------------------------------------------
function walkPage(args: WalkArgs): RawSnapshotResult {
  const prevMap = new Map<string, string>(args.prevMap);
  let counter = args.startCounter;

  function fnv1a(s: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(16);
  }

  const INTERACTIVE_ROLES_ = new Set([
    "button",
    "link",
    "checkbox",
    "radio",
    "switch",
    "tab",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "combobox",
    "textbox",
    "slider",
    "spinbutton",
    "searchbox",
    "option",
  ]);
  const STRUCTURAL_TAGS = new Set([
    "HEADER",
    "NAV",
    "MAIN",
    "FOOTER",
    "ASIDE",
    "SECTION",
    "FORM",
    "TABLE",
    "UL",
    "OL",
    "LI",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
  ]);
  const STRUCTURAL_ROLES = new Set([
    "banner",
    "navigation",
    "main",
    "contentinfo",
    "complementary",
    "region",
    "form",
    "table",
    "list",
    "listitem",
    "listbox",
    "heading",
    "tablist",
    "tab",
    "row",
    "grid",
    "status",
    "alert",
    "dialog",
  ]);

  function implicitRole(el: any): string | null {
    const tag = el.tagName;
    const type = (el.getAttribute("type") || "").toLowerCase();
    switch (tag) {
      case "A":
        return el.hasAttribute("href") ? "link" : "generic";
      case "BUTTON":
        return "button";
      case "INPUT":
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "submit" || type === "button" || type === "reset") return "button";
        if (type === "range") return "slider";
        if (type === "search") return "searchbox";
        if (type === "hidden") return "none";
        return "textbox";
      case "SELECT":
        return "combobox";
      case "TEXTAREA":
        return "textbox";
      case "OPTION":
        return "option";
      case "SUMMARY":
        return "button";
      case "H1":
      case "H2":
      case "H3":
      case "H4":
      case "H5":
      case "H6":
        return "heading";
      case "UL":
      case "OL":
        return "list";
      case "LI":
        return "listitem";
      case "NAV":
        return "navigation";
      case "MAIN":
        return "main";
      case "HEADER":
        return "banner";
      case "FOOTER":
        return "contentinfo";
      case "ASIDE":
        return "complementary";
      case "FORM":
        return "form";
      case "TABLE":
        return "table";
      case "CANVAS":
        return "canvas";
      default:
        return null;
    }
  }

  function getRole(el: any): string {
    const explicit = el.getAttribute("role");
    if (explicit && explicit.trim()) return explicit.trim().split(/\s+/)[0];
    return implicitRole(el) || el.tagName.toLowerCase();
  }

  function isInteractive(el: any, role: string): boolean {
    if (INTERACTIVE_ROLES_.has(role)) return true;
    if (el.hasAttribute("onclick")) return true;
    if (el.hasAttribute("tabindex")) {
      const idx = parseInt(el.getAttribute("tabindex"), 10);
      if (!isNaN(idx) && idx >= 0) return true;
    }
    return false;
  }

  function isStructural(el: any, role: string): boolean {
    return STRUCTURAL_ROLES.has(role) || STRUCTURAL_TAGS.has(el.tagName);
  }

  function isHiddenStyle(el: any): boolean {
    if (el.hidden === true) return true;
    const cs = getComputedStyle(el);
    return cs.display === "none" || cs.visibility === "hidden";
  }

  function textOf(el: any): string {
    const t = el.innerText !== undefined ? el.innerText : el.textContent;
    return (t || "").trim().replace(/\s+/g, " ");
  }

  function computeName(el: any): string {
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim().slice(0, 80);

    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const text = labelledby
        .split(/\s+/)
        .map((id: string) => {
          const ref = document.getElementById(id);
          return ref ? textOf(ref) : "";
        })
        .filter(Boolean)
        .join(" ");
      if (text) return text.slice(0, 80);
    }

    if (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA") {
      if (el.id) {
        const labels = document.getElementsByTagName("label");
        for (const lbl of labels) {
          if (lbl.htmlFor === el.id) {
            const t = textOf(lbl);
            if (t) return t.slice(0, 80);
          }
        }
      }
      const parentLabel = el.closest ? el.closest("label") : null;
      if (parentLabel) {
        const t = textOf(parentLabel);
        if (t) return t.slice(0, 80);
      }
    }

    const alt = el.getAttribute("alt");
    if (alt && alt.trim()) return alt.trim().slice(0, 80);

    const title = el.getAttribute("title");
    if (title && title.trim()) return title.trim().slice(0, 80);

    return textOf(el).slice(0, 80);
  }

  function getValue(el: any, role: string): string | undefined {
    if (role === "canvas") {
      // Canvases carry no textual value of their own; surface their
      // CSS-pixel size ("WxH") as the node's `value` so the model can see
      // dimensions without ever touching pixels. Use the rendered box size
      // (not the width/height content attributes, which are backing-store
      // pixels and can diverge from CSS size under devicePixelRatio).
      const r = el.getBoundingClientRect();
      return `${Math.round(r.width)}x${Math.round(r.height)}`;
    }
    if (el.tagName === "SELECT") {
      const opt = el.selectedOptions && el.selectedOptions[0];
      return opt ? opt.text : el.value;
    }
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      if (el.type === "checkbox" || el.type === "radio") return undefined;
      return el.value;
    }
    return undefined;
  }

  function getStates(el: any, role: string): string[] {
    const states: string[] = [];
    if (el.tagName === "INPUT" && (role === "checkbox" || role === "radio")) {
      if (el.checked) states.push("checked");
    } else {
      const ariaChecked = el.getAttribute("aria-checked");
      if (ariaChecked === "true") states.push("checked");
      else if (ariaChecked === "mixed") states.push("mixed");
    }
    if (el.disabled === true || el.getAttribute("aria-disabled") === "true") {
      states.push("disabled");
    }
    const expanded = el.getAttribute("aria-expanded");
    if (expanded === "true") states.push("expanded");
    else if (expanded === "false") states.push("collapsed");
    if (document.activeElement === el) states.push("focused");
    const selected = el.getAttribute("aria-selected");
    if (selected === "true" || (el.tagName === "OPTION" && el.selected)) {
      states.push("selected");
    }
    return states;
  }

  function computeInViewport(rect: any): boolean {
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    return rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw;
  }

  // Recursively walk `el`'s subtree, returning the list of kept nodes it
  // contributes to its parent (0 if pruned/hidden, 1 if kept, N>=0 flattened
  // from children if `el` itself isn't meaningful on its own).
  function build(el: any): any[] {
    if (el.nodeType !== 1) return [];
    const tag = el.tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEMPLATE") return [];
    if (el.getAttribute && el.getAttribute("aria-hidden") === "true") return [];
    if (isHiddenStyle(el)) return [];

    let role = getRole(el);
    // Canvas is always surfaced as its own node — never flattened, never
    // reclassified as "text" — because once painting starts, its DOM
    // children (fallback content, if any) no longer describe what's
    // visible. It's kept purely so the tap/pixel modules have a ref to key
    // off of; its "value" carries WxH instead of text (see getValue()).
    const isCanvas = role === "canvas";
    const interactive = isInteractive(el, role);
    const structural = isStructural(el, role);
    const leafText =
      !interactive &&
      !structural &&
      !isCanvas &&
      el.childElementCount === 0 &&
      textOf(el).length > 0;

    const kept = interactive || structural || leafText || isCanvas;
    if (leafText) role = "text";

    let childNodes: any[] = [];
    if (!leafText && !isCanvas) {
      for (const child of el.children) {
        childNodes = childNodes.concat(build(child));
      }
    }

    if (!kept) return childNodes; // flatten non-meaningful wrapper upward

    const rect = el.getBoundingClientRect();
    const node: any = {
      role,
      name: computeName(el),
      inViewport: computeInViewport(rect),
      children: childNodes,
      __el: el,
    };
    const value = getValue(el, role);
    if (value !== undefined) node.value = value;
    const states = getStates(el, role);
    if (states.length) node.state = states;
    return [node];
  }

  // Clear stale tags from a previous run so resolve() never matches a
  // detached/renamed element by leftover attribute.
  const stale = document.querySelectorAll("[data-fh-ref]");
  for (const s of stale) s.removeAttribute("data-fh-ref");

  let rootChildren: any[] = [];
  for (const child of document.body.children) {
    rootChildren = rootChildren.concat(build(child));
  }
  const root: any = {
    role: "generic",
    name: "",
    inViewport: true,
    children: rootChildren,
    __el: document.body,
  };

  function assignKeys(node: any, parentKey: string, idx: number): void {
    const key = fnv1a(node.role + "|" + node.name + "|" + parentKey + "|" + idx);
    node.stabilityKey = key;
    node.contentHash = fnv1a(
      node.role + "|" + node.name + "|" + (node.value || "") + "|" + (node.state || []).join(","),
    );
    const ref = prevMap.get(key) || "e" + counter++;
    node.ref = ref;
    if (node.__el && node.__el.setAttribute) node.__el.setAttribute("data-fh-ref", ref);

    const roleCounts: Record<string, number> = {};
    for (const child of node.children) {
      const cidx = roleCounts[child.role] || 0;
      roleCounts[child.role] = cidx + 1;
      assignKeys(child, key, cidx);
    }
  }
  assignKeys(root, "ROOT", 0);

  function clean(node: any): RawNode {
    const { __el, children, ...rest } = node;
    return { ...rest, children: children.map(clean) } as RawNode;
  }

  return {
    url: location.href,
    title: document.title,
    tree: clean(root),
    nextCounter: counter,
    scroll: {
      y: Math.round(window.scrollY),
      viewportH: Math.round(window.innerHeight),
      docH: Math.round(document.documentElement.scrollHeight),
    },
  };
}

// ---------------------------------------------------------------------------
// Node-side helpers: counting, serializing, diffing, budget enforcement.
// ---------------------------------------------------------------------------

function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function countNodes(nodes: RawNode[]): number {
  let n = 0;
  for (const node of nodes) n += 1 + countNodes(node.children);
  return n;
}

function serializeLine(node: RawNode): string {
  let line = `${node.ref} ${node.role} "${node.name}"`;
  if (node.value !== undefined) line += ` ="${node.value}"`;
  if (node.state && node.state.length) line += ` [${node.state.join(",")}]`;
  if (!node.inViewport) line += " {offscreen}";
  return line;
}

function serializeNodes(nodes: RawNode[], depth: number, out: string[]): void {
  const indent = "  ".repeat(depth);
  for (const node of nodes) {
    out.push(indent + serializeLine(node));
    serializeNodes(node.children, depth + 1, out);
  }
}

function header(url: string, title: string, scroll?: RawSnapshotResult["scroll"]): string[] {
  const lines = [`url: ${url}`, `title: ${title}`];
  // The scrollbar, in words: every page knows its own scroll extent, and no
  // observation format surfaces it — so models never realize more content
  // exists below the fold. Say it explicitly when the page is scrollable.
  if (scroll && scroll.docH > scroll.viewportH * 1.02) {
    const seenTo = Math.min(100, Math.round(((scroll.y + scroll.viewportH) / scroll.docH) * 100));
    lines.push(
      `scroll: viewing ${scroll.y}-${scroll.y + scroll.viewportH} of ${scroll.docH}px` +
        (seenTo < 100 ? ` — ${100 - seenTo}% of the page is below, scroll down to reveal` : " (at bottom)"),
    );
  }
  lines.push("");
  return lines;
}

function serializeFull(raw: RawSnapshotResult, roots: RawNode[]): string {
  const lines = header(raw.url, raw.title, raw.scroll);
  serializeNodes(roots, 0, lines);
  return lines.join("\n");
}

// Drop subtrees matching `shouldDrop` bottom-up; a node survives if it has
// any surviving child, even if it matches `shouldDrop` itself (keeps it as
// connective tissue for indentation/context). Never touches nodes that fail
// `shouldDrop` in the first place. Returns the pruned list and how many
// whole nodes were dropped.
function pruneList(
  nodes: RawNode[],
  shouldDrop: (n: RawNode) => boolean,
  counter: { n: number },
): RawNode[] {
  const out: RawNode[] = [];
  for (const node of nodes) {
    const newChildren = pruneList(node.children, shouldDrop, counter);
    if (shouldDrop(node) && newChildren.length === 0) {
      counter.n++;
      continue;
    }
    out.push({ ...node, children: newChildren });
  }
  return out;
}

function truncateNames(nodes: RawNode[], max: number): RawNode[] {
  return nodes.map((n) => ({
    ...n,
    name: n.name.slice(0, max),
    children: truncateNames(n.children, max),
  }));
}

// Budget algorithm per SPEC: drop offscreen non-interactive, then offscreen
// interactive too (with an omission note), then truncate names to 40 chars.
// Never drops in-viewport interactive nodes (both predicates below always
// preserve them since they require !inViewport).
function fitFullToBudget(raw: RawSnapshotResult, roots: RawNode[], budget: number): string {
  let text = serializeFull(raw, roots);
  if (approxTokens(text) <= budget) return text;

  const c1 = { n: 0 };
  let pruned = pruneList(roots, (n) => !n.inViewport && !INTERACTIVE_ROLES.has(n.role), c1);
  text = serializeFull(raw, pruned);
  if (approxTokens(text) <= budget) return text;

  const c2 = { n: 0 };
  pruned = pruneList(pruned, (n) => !n.inViewport, c2);
  let lines = header(raw.url, raw.title, raw.scroll);
  serializeNodes(pruned, 0, lines);
  if (c2.n > 0) lines.push(`… ${c2.n} offscreen nodes omitted; scroll to reveal`);
  text = lines.join("\n");
  if (approxTokens(text) <= budget) return text;

  pruned = truncateNames(pruned, 40);
  lines = header(raw.url, raw.title, raw.scroll);
  serializeNodes(pruned, 0, lines);
  if (c2.n > 0) lines.push(`… ${c2.n} offscreen nodes omitted; scroll to reveal`);
  return lines.join("\n");
}

interface FlatEntry {
  node: RawNode;
  parentRef: string;
  parentKey: string;
}

function flattenChildren(nodes: RawNode[], parentRef: string, parentKey: string, out: Map<string, FlatEntry>): void {
  for (const node of nodes) {
    out.set(node.stabilityKey, { node, parentRef, parentKey });
    flattenChildren(node.children, node.ref, node.stabilityKey, out);
  }
}

interface DiffData {
  changed: RawNode[];
  added: FlatEntry[];
  removed: RawNode[];
  total: number;
}

function computeDiff(prevRoot: RawNode, currRoot: RawNode): DiffData {
  const prevMap = new Map<string, FlatEntry>();
  flattenChildren(prevRoot.children, prevRoot.ref, prevRoot.stabilityKey, prevMap);
  const currMap = new Map<string, FlatEntry>();
  flattenChildren(currRoot.children, currRoot.ref, currRoot.stabilityKey, currMap);

  const changed: RawNode[] = [];
  const added: FlatEntry[] = [];
  for (const [key, entry] of currMap) {
    const prev = prevMap.get(key);
    if (!prev) added.push(entry);
    else if (prev.node.contentHash !== entry.node.contentHash) changed.push(entry.node);
  }
  const removed: RawNode[] = [];
  for (const [key, entry] of prevMap) {
    if (!currMap.has(key)) removed.push(entry.node);
  }

  return { changed, added, removed, total: changed.length + added.length + removed.length };
}

function serializeDiff(
  raw: RawSnapshotResult,
  diff: DiffData,
  nodeCount: number,
  rootRef: string,
  budget?: number,
): string {
  const addedKeys = new Set(diff.added.map((a) => a.node.stabilityKey));
  let topLevelAdded = diff.added.filter((a) => !addedKeys.has(a.parentKey));

  let changed = diff.changed;
  let removed = diff.removed;

  const render = (): string => {
    const lines = header(raw.url, raw.title, raw.scroll);
    lines.push(
      `${changed.length} changed, ${topLevelAddedCount(topLevelAdded)} added, ${removed.length} removed (of ${nodeCount} nodes)`,
    );
    if (changed.length) {
      lines.push("", "~ changed:");
      for (const n of changed) lines.push(serializeLine(n));
    }
    if (topLevelAdded.length) {
      lines.push("", "+ added:");
      for (const entry of topLevelAdded) {
        lines.push(`under ${entry.parentRef === rootRef ? "(root)" : entry.parentRef}:`);
        const sub: string[] = [];
        serializeNodes([entry.node], 0, sub);
        lines.push(...sub);
      }
    }
    if (removed.length) {
      lines.push("", "- removed:");
      for (const n of removed) lines.push(serializeLine(n));
    }
    return lines.join("\n");
  };

  // "added" count in the summary reflects total added nodes (spec's "2
  // added" style count), not just top-level groups — count every added node.
  function topLevelAddedCount(_groups: FlatEntry[]): number {
    return diff.added.length;
  }

  let text = render();
  if (budget === undefined || approxTokens(text) <= budget) return text;

  // Budget fitting for diffs: prune offscreen material out of the added
  // subtrees first (non-interactive, then interactive too), then fall back
  // to name truncation across changed/added/removed as a last resort.
  const c1 = { n: 0 };
  topLevelAdded = topLevelAdded.map((e) => ({
    ...e,
    node: pruneList([e.node], (n) => !n.inViewport && !INTERACTIVE_ROLES.has(n.role), c1)[0] ?? e.node,
  }));
  text = render();
  if (approxTokens(text) <= budget) return text;

  const c2 = { n: 0 };
  topLevelAdded = topLevelAdded.map((e) => ({
    ...e,
    node: pruneList([e.node], (n) => !n.inViewport, c2)[0] ?? e.node,
  }));
  text = render();
  if (c2.n > 0) text += `\n… ${c2.n} offscreen nodes omitted; scroll to reveal`;
  if (approxTokens(text) <= budget) return text;

  changed = truncateNames(changed, 40);
  removed = truncateNames(removed, 40);
  topLevelAdded = topLevelAdded.map((e) => ({ ...e, node: truncateNames([e.node], 40)[0] }));
  text = render();
  if (c2.n > 0) text += `\n… ${c2.n} offscreen nodes omitted; scroll to reveal`;
  return text;
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export function createObservationEngine(page: Page): ObservationEngine {
  let lastRawRoot: RawNode | null = null;
  let lastUrl = "";
  let refCounter = 1;
  let forceFull = true;
  let refIndex = new Map<string, RawNode>();

  function indexRefs(node: RawNode, map: Map<string, RawNode>): void {
    map.set(node.ref, node);
    for (const c of node.children) indexRefs(c, map);
  }

  async function capture(): Promise<RawSnapshotResult> {
    const prevMap: [string, string][] = [];
    if (lastRawRoot) {
      const m = new Map<string, string>();
      const collect = (n: RawNode) => {
        m.set(n.stabilityKey, n.ref);
        for (const c of n.children) collect(c);
      };
      collect(lastRawRoot);
      for (const [k, v] of m) prevMap.push([k, v]);
    }
    const raw = await page.evaluate(walkPage, { prevMap, startCounter: refCounter });
    refCounter = raw.nextCounter;
    return raw;
  }

  return {
    async observe(budget?: number): Promise<Observation> {
      const raw = await capture();
      const nodeCount = countNodes(raw.tree.children);
      const snapshot: Snapshot = {
        url: raw.url,
        title: raw.title,
        tree: raw.tree,
        nodeCount,
        capturedAt: Date.now(),
      };

      const urlChanged = lastUrl !== "" && lastUrl !== raw.url;
      let kind: "full" | "diff" = "full";
      let text: string;

      if (!forceFull && lastRawRoot && !urlChanged) {
        const diff = computeDiff(lastRawRoot, raw.tree);
        const denom = Math.max(countNodes(lastRawRoot.children), 1);
        const ratio = diff.total / denom;
        if (ratio <= 0.6) {
          kind = "diff";
          text = serializeDiff(raw, diff, nodeCount, raw.tree.ref, budget);
        } else {
          text = budget !== undefined ? fitFullToBudget(raw, raw.tree.children, budget) : serializeFull(raw, raw.tree.children);
        }
      } else {
        text = budget !== undefined ? fitFullToBudget(raw, raw.tree.children, budget) : serializeFull(raw, raw.tree.children);
      }

      lastRawRoot = raw.tree;
      lastUrl = raw.url;
      forceFull = false;
      refIndex = new Map();
      indexRefs(raw.tree, refIndex);

      return { kind, text, snapshot, approxTokens: approxTokens(text) };
    },

    invalidate(): void {
      forceFull = true;
    },

    async resolve(ref: string): Promise<ResolvedNode | null> {
      const prevNode = refIndex.get(ref);
      if (!prevNode) return null;

      const handle = await page.$(`[data-fh-ref="${ref}"]`);
      if (!handle) return null;

      const liveHash: string = await handle.evaluate((el: any) => {
        function fnv1a(s: string): string {
          let h = 0x811c9dc5;
          for (let i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
          }
          return h.toString(16);
        }
        const INTERACTIVE_ROLES_LOCAL = new Set([
          "button",
          "link",
          "checkbox",
          "radio",
          "switch",
          "tab",
          "menuitem",
          "menuitemcheckbox",
          "menuitemradio",
          "combobox",
          "textbox",
          "slider",
          "spinbutton",
          "searchbox",
          "option",
        ]);
        function implicitRole(e: any): string | null {
          const tag = e.tagName;
          const type = (e.getAttribute("type") || "").toLowerCase();
          switch (tag) {
            case "A":
              return e.hasAttribute("href") ? "link" : "generic";
            case "BUTTON":
              return "button";
            case "INPUT":
              if (type === "checkbox") return "checkbox";
              if (type === "radio") return "radio";
              if (type === "submit" || type === "button" || type === "reset") return "button";
              if (type === "range") return "slider";
              if (type === "search") return "searchbox";
              if (type === "hidden") return "none";
              return "textbox";
            case "SELECT":
              return "combobox";
            case "TEXTAREA":
              return "textbox";
            case "OPTION":
              return "option";
            case "SUMMARY":
              return "button";
            case "H1":
            case "H2":
            case "H3":
            case "H4":
            case "H5":
            case "H6":
              return "heading";
            case "UL":
            case "OL":
              return "list";
            case "LI":
              return "listitem";
            case "NAV":
              return "navigation";
            case "MAIN":
              return "main";
            case "HEADER":
              return "banner";
            case "FOOTER":
              return "contentinfo";
            case "ASIDE":
              return "complementary";
            case "FORM":
              return "form";
            case "TABLE":
              return "table";
            case "CANVAS":
              return "canvas";
            default:
              return null;
          }
        }
        const explicit = el.getAttribute("role");
        const role = explicit && explicit.trim() ? explicit.trim().split(/\s+/)[0] : implicitRole(el) || el.tagName.toLowerCase();
        const isCanvas = role === "canvas";
        const isInteractive = INTERACTIVE_ROLES_LOCAL.has(role) || el.hasAttribute("onclick");
        const isLeafText = !isCanvas && !isInteractive && el.childElementCount === 0;
        const effectiveRole = isCanvas ? role : isLeafText && role !== "text" ? "text" : role;

        function textOf(e: any): string {
          const t = e.innerText !== undefined ? e.innerText : e.textContent;
          return (t || "").trim().replace(/\s+/g, " ");
        }
        function computeName(e: any): string {
          const ariaLabel = e.getAttribute("aria-label");
          if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim().slice(0, 80);
          const labelledby = e.getAttribute("aria-labelledby");
          if (labelledby) {
            const text = labelledby
              .split(/\s+/)
              .map((id: string) => {
                const ref2 = document.getElementById(id);
                return ref2 ? textOf(ref2) : "";
              })
              .filter(Boolean)
              .join(" ");
            if (text) return text.slice(0, 80);
          }
          if (e.tagName === "INPUT" || e.tagName === "SELECT" || e.tagName === "TEXTAREA") {
            if (e.id) {
              const labels = document.getElementsByTagName("label");
              for (const lbl of labels) {
                if (lbl.htmlFor === e.id) {
                  const t = textOf(lbl);
                  if (t) return t.slice(0, 80);
                }
              }
            }
            const parentLabel = e.closest ? e.closest("label") : null;
            if (parentLabel) {
              const t = textOf(parentLabel);
              if (t) return t.slice(0, 80);
            }
          }
          const alt = e.getAttribute("alt");
          if (alt && alt.trim()) return alt.trim().slice(0, 80);
          const title = e.getAttribute("title");
          if (title && title.trim()) return title.trim().slice(0, 80);
          return textOf(e).slice(0, 80);
        }
        const name = computeName(el);
        let value: string | undefined;
        if (isCanvas) {
          const r = el.getBoundingClientRect();
          value = `${Math.round(r.width)}x${Math.round(r.height)}`;
        } else if (el.tagName === "SELECT") {
          const opt = el.selectedOptions && el.selectedOptions[0];
          value = opt ? opt.text : el.value;
        } else if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
          if (!(el.type === "checkbox" || el.type === "radio")) value = el.value;
        }
        const states: string[] = [];
        if (el.tagName === "INPUT" && (role === "checkbox" || role === "radio")) {
          if (el.checked) states.push("checked");
        } else {
          const ariaChecked = el.getAttribute("aria-checked");
          if (ariaChecked === "true") states.push("checked");
          else if (ariaChecked === "mixed") states.push("mixed");
        }
        if (el.disabled === true || el.getAttribute("aria-disabled") === "true") states.push("disabled");
        const expanded = el.getAttribute("aria-expanded");
        if (expanded === "true") states.push("expanded");
        else if (expanded === "false") states.push("collapsed");
        if (document.activeElement === el) states.push("focused");
        const selected = el.getAttribute("aria-selected");
        if (selected === "true" || (el.tagName === "OPTION" && el.selected)) states.push("selected");

        return fnv1a(effectiveRole + "|" + name + "|" + (value || "") + "|" + states.join(","));
      });

      return { ref, handle, stillMatches: liveHash === prevNode.contentHash };
    },
  };
}
