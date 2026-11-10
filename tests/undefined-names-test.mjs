// A name used in the backend that nothing ever defined.
//
// buildDefaultSkins() called cachedJarPath(). model-assets.js exports it;
// main.js had never imported it. So every run threw ReferenceError, landed
// in that function's catch, and logged "Failed to get default skins", which
// reads like Mojang being unreachable -- while the real cause was a missing
// import line and the default skins silently never built.
//
// node --check does not catch it: the file parses perfectly. It is only
// wrong when the line runs, and that line is inside a try.
//
// So: parse every backend module, walk its scopes, and report any identifier
// that is read but was never declared, imported, or a global. One name is
// enough to make this worth having.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as acorn from "acorn";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "backend");

let bad = 0;
const check = (what, got, want, note) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${note ? "  — " + note : ""}`
    + (ok ? "" : `\n       got  ${JSON.stringify(got, null, 2)}\n       want ${JSON.stringify(want)}`));
};

// Everything a module may use without declaring it.
const GLOBALS = new Set([
  "globalThis", "console", "process", "Buffer", "URL", "URLSearchParams", "TextEncoder",
  "TextDecoder", "AbortController", "AbortSignal", "Event", "EventTarget", "fetch", "Headers",
  "Request", "Response", "FormData", "Blob", "File", "crypto", "structuredClone", "queueMicrotask",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "clearImmediate",
  "require", "module", "exports", "__dirname", "__filename", "performance", "navigator",
  "Object", "Array", "String", "Number", "Boolean", "Symbol", "BigInt", "Function", "Date",
  "RegExp", "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError",
  "URIError", "AggregateError", "Promise", "Map", "Set", "WeakMap", "WeakSet", "WeakRef",
  "Proxy", "Reflect", "JSON", "Math", "Intl", "ArrayBuffer", "SharedArrayBuffer", "DataView",
  "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array",
  "Uint32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
  "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURI", "decodeURI",
  "encodeURIComponent", "decodeURIComponent", "escape", "unescape", "undefined", "NaN", "Infinity",
  "arguments", "eval", "atob", "btoa", "window", "document", "self", "global",
]);

/** Every name a node binds, including destructuring. */
function bound(node, out = []) {
  if (!node) return out;
  switch (node.type) {
    case "Identifier": out.push(node.name); break;
    case "ObjectPattern":
      for (const p of node.properties) {
        if (p.type === "RestElement") bound(p.argument, out);
        else bound(p.value, out);
      }
      break;
    case "ArrayPattern": for (const e of node.elements) bound(e, out); break;
    case "AssignmentPattern": bound(node.left, out); break;
    case "RestElement": bound(node.argument, out); break;
    default: break;
  }
  return out;
}

function walk(node, visit, parent = null) {
  if (!node || typeof node.type !== "string") return;
  visit(node, parent);
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end" || key === "loc") continue;
    const v = node[key];
    if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === "string") walk(c, visit, node); }
    else if (v && typeof v.type === "string") walk(v, visit, node);
  }
}

/** Names a module declares anywhere in it, at any depth. */
function declared(ast) {
  const names = new Set();
  walk(ast, (n) => {
    if (n.type === "VariableDeclarator") for (const b of bound(n.id)) names.add(b);
    else if (n.type === "FunctionDeclaration" || n.type === "ClassDeclaration") {
      if (n.id) names.add(n.id.name);
      for (const p of (n.params || [])) for (const b of bound(p)) names.add(b);
    } else if (n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression") {
      if (n.id) names.add(n.id.name);
      for (const p of (n.params || [])) for (const b of bound(p)) names.add(b);
    } else if (n.type === "ClassExpression") { if (n.id) names.add(n.id.name); }
    else if (n.type === "ImportDeclaration") for (const s of n.specifiers) names.add(s.local.name);
    else if (n.type === "CatchClause") { if (n.param) for (const b of bound(n.param)) names.add(b); }
    else if (n.type === "LabeledStatement") names.add(n.label.name);
    else if (n.type === "ImportExpression") { /* dynamic import, no binding */ }
  });
  return names;
}

/** Identifiers a module READS: not property names, not keys, not labels. */
function readNames(ast) {
  const used = new Map();   // name -> first line it is read on
  walk(ast, (n, parent) => {
    if (n.type !== "Identifier") return;
    if (!parent) return;
    // import.meta parses as a MetaProperty whose two halves are Identifiers;
    // neither is a name in scope.
    if (parent.type === "MetaProperty") return;
    // obj.prop -- `prop` is not a name in scope
    if (parent.type === "MemberExpression" && parent.property === n && !parent.computed) return;
    // { prop: value } -- `prop` is not either
    if (parent.type === "Property" && parent.key === n && !parent.computed) return;
    if (parent.type === "PropertyDefinition" && parent.key === n && !parent.computed) return;
    if (parent.type === "MethodDefinition" && parent.key === n && !parent.computed) return;
    // import/export specifiers, labels, and the names being declared
    if (parent.type === "ImportSpecifier" || parent.type === "ImportDefaultSpecifier"
      || parent.type === "ImportNamespaceSpecifier" || parent.type === "ExportSpecifier") return;
    if (parent.type === "LabeledStatement" || parent.type === "BreakStatement"
      || parent.type === "ContinueStatement") return;
    if (!used.has(n.name)) used.set(n.name, n.loc ? n.loc.start.line : 0);
  });
  return used;
}

const files = fs.readdirSync(DIR)
  .filter(f => f.endsWith(".js"))
  .sort();

const offenders = [];
for (const file of files) {
  const text = fs.readFileSync(path.join(DIR, file), "utf8");
  let ast;
  try {
    ast = acorn.parse(text, { ecmaVersion: "latest", sourceType: "module", locations: true });
  } catch {
    // A CommonJS worker or similar; parse it that way rather than skip it.
    try { ast = acorn.parse(text, { ecmaVersion: "latest", sourceType: "script", locations: true, allowReturnOutsideFunction: true }); }
    catch (e) { offenders.push({ file, name: "(could not parse)", line: 0, why: e.message }); continue; }
  }
  const have = declared(ast);
  for (const [name, line] of readNames(ast)) {
    if (have.has(name) || GLOBALS.has(name)) continue;
    offenders.push({ file, name, line });
  }
}

check("every name the backend uses is one it declared or imported",
  offenders, [],
  "node --check cannot see this: the file parses, and the line only fails when it runs");

console.log(bad ? `\n${bad} FAILURES` : `\nall pass  (${files.length} backend modules)`);
process.exit(bad ? 1 : 0);
