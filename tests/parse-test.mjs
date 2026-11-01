// Does it even load?
//
// Every backend module is parsed as a module, and every page's inline script
// as a script, before anything else runs. A syntax error in a page is
// invisible to a test that pokes at one function inside it -- the page simply
// does nothing in the app -- and a top-level binding used before it is
// declared is a ReferenceError at import time that only Electron ever sees.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as acorn from "acorn";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let bad = 0;
const fail = (what, why) => { bad++; console.log(`FAIL ${what}\n       ${why}`); };

// ── backend modules ──
const backend = fs.readdirSync(path.join(ROOT, "backend")).filter(f => f.endsWith(".js"));
for (const f of backend) {
  const src = fs.readFileSync(path.join(ROOT, "backend", f), "utf8");
  let ast = null;
  try {
    ast = acorn.parse(src, { ecmaVersion: "latest", sourceType: "module" });
  } catch (e) { fail(`backend/${f} parses`, e.message); continue; }

  // A top-level `const` used by something declared above it throws on import,
  // which no test outside Electron would ever reach. This caught a release
  // that would not start at all.
  const declared = new Map();                 // name -> index of its statement
  ast.body.forEach((node, i) => {
    if (node.type === "VariableDeclaration") {
      for (const d of node.declarations) if (d.id.type === "Identifier") declared.set(d.id.name, i);
    }
  });
  const used = (node, seen = new Set()) => {
    if (!node || typeof node !== "object") return seen;
    if (Array.isArray(node)) { for (const n of node) used(n, seen); return seen; }
    // A function body is not run at import time, so what it names is fine.
    if (/Function(Expression|Declaration)|ArrowFunctionExpression/.test(node.type)) return seen;
    if (node.type === "Identifier") seen.add(node.name);
    // `{ color: 1 }` and `a.color` name a property, not the binding `color`.
    const skip = new Set(["type", "start", "end"]);
    if ((node.type === "Property" || node.type === "MemberExpression") && !node.computed) {
      skip.add(node.type === "Property" ? "key" : "property");
    }
    for (const k of Object.keys(node)) if (!skip.has(k)) used(node[k], seen);
    return seen;
  };
  ast.body.forEach((node, i) => {
    if (node.type !== "VariableDeclaration") return;
    for (const d of node.declarations) {
      if (!d.init) continue;
      for (const name of used(d.init)) {
        const at = declared.get(name);
        if (at != null && at > i) fail(`backend/${f} has no use-before-declare`, `${name} is used at statement ${i} and declared at ${at}`);
      }
    }
  });
}

// ── the pages' own scripts ──
const pages = fs.readdirSync(path.join(ROOT, "frontend")).filter(f => f.endsWith(".html"));
for (const f of pages) {
  const html = fs.readFileSync(path.join(ROOT, "frontend", f), "utf8");
  // Inline scripts only: a src= one is parsed on its own below.
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m, n = 0;
  while ((m = re.exec(html))) {
    n++;
    const type = /type=["']module["']/.test(m[0]) ? "module" : "script";
    try { acorn.parse(m[1], { ecmaVersion: "latest", sourceType: type }); }
    catch (e) {
      const line = html.slice(0, m.index).split("\n").length;
      fail(`frontend/${f} script #${n} parses`, `${e.message} (the <script> starts at line ${line})`);
    }
  }
}

// ── the pages' own files ──
const SKIP = new Set(["three.module.js", "skinview3d.bundle.js", "marked.min.js", "nouislider.min.js"]);
for (const f of fs.readdirSync(path.join(ROOT, "frontend")).filter(x => x.endsWith(".js") && !SKIP.has(x))) {
  const src = fs.readFileSync(path.join(ROOT, "frontend", f), "utf8");
  try { acorn.parse(src, { ecmaVersion: "latest", sourceType: "script" }); }
  catch (e) {
    try { acorn.parse(src, { ecmaVersion: "latest", sourceType: "module" }); }
    catch { fail(`frontend/${f} parses`, e.message); }
  }
}

console.log(bad ? `\n${bad} FAILURES` : `\nall pass (${backend.length} backend modules, ${pages.length} pages)`);
process.exit(bad ? 1 : 0);
