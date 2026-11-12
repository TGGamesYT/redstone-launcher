// A launch that stops dead and says nothing more.
//
// mclc's getVersion() fetches the version's JSON and parses it inside the
// request's callback:
//
//     this.client.emit('debug', '[MCLC]: Parsed version from version manifest')
//     this.version = ... : JSON.parse(body)
//     return resolve(this.version)
//
// When that parse throws -- an empty body, a proxy's error page, a captive
// portal, a truncated response -- the throw is inside a callback with
// nothing around it. The promise is never resolved and never rejected, so
// launch() waits on it for ever: the instance says "launching", the log ends
// on that line, and nothing else ever happens.
//
// Note which line it ends on. The message is printed BEFORE the parse, so
// the last thing in the log claims that the thing which just failed worked.
//
// What is checked here is the replacement: that a body which is not JSON
// produces an error saying so instead of a promise nobody will ever settle,
// and that a good one is written where mclc looks for it first so the
// fragile path is never taken again.
//
// The real patch is sliced out of launcher-worker.js. A copy would pass
// while the launcher hung.
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(ROOT, "backend", "launcher-worker.js"), "utf8");

let bad = 0;
const check = (what, got, want, note) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${note ? "  — " + note : ""}`
    + (ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`));
};

const cut = (from, to) => {
  const i = src.indexOf(from), j = src.indexOf(to, i);
  if (i < 0 || j < 0) {
    console.log(`FAIL could not find ${JSON.stringify(i < 0 ? from : to)} in launcher-worker.js`);
    process.exit(1);
  }
  return src.slice(i, j);
};
const code = cut("function fetchVersionJsonProperly()", "function verifyNatives()");

// A stand-in for mclc's Handler, with the one method the patch replaces.
// `real` records that it was called, which is how "the fast path was taken"
// is checked.
const scratch = path.join(ROOT, "node_modules", ".cache");
fs.mkdirSync(scratch, { recursive: true });
const modFile = path.join(scratch, "versionjson.mjs");
fs.writeFileSync(modFile,
  'import fs from "fs";\nimport path from "path";\n'
  + "export const calls = [];\n"
  + "export class Handler { async getVersion() { calls.push('real'); return this.version || { from: 'the file' }; } }\n"
  + "const Handler_ = Handler;\n"
  + "const require_ = () => ({ prototype: Handler_.prototype });\n"
  + "export function writeAtomic(file, text) { fs.writeFileSync(file, text); }\n"
  + code.replace(/^function fetchVersionJsonProperly/m, "export function fetchVersionJsonProperly"));
const mod = await import("file://" + modFile + "?v=" + Date.now());
mod.fetchVersionJsonProperly();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rl-vjson-"));

// What the world answers, swapped per case.
let answers = {};
globalThis.fetch = async (url) => {
  const a = answers[String(url)];
  if (!a) throw new Error("nothing is listening");
  if (a.hang) await new Promise(() => { });      // never settles, like the bug
  return {
    ok: a.status === undefined || (a.status >= 200 && a.status < 300),
    status: a.status || 200,
    statusText: a.statusText || "OK",
    text: async () => a.body,
  };
};

const META = "https://launchermeta.mojang.com";
const MANIFEST = `${META}/mc/game/version_manifest.json`;
const VERSION_URL = "https://piston-meta.mojang.com/v1/packages/abc/26.3.json";
const GOOD = {
  id: "26.3",
  libraries: [],
  downloads: { client: { url: "https://example.invalid/client.jar", size: 1 } },
  assetIndex: { id: "26", url: "https://example.invalid/26.json" },
};

const handlerFor = (dir) => {
  const h = new mod.Handler();
  h.options = {
    version: { number: "26.3" },
    directory: dir,
    overrides: {},
  };
  return h;
};

const tryIt = async (h) => {
  try { return { ok: true, value: await h.getVersion() }; }
  catch (e) { return { ok: false, error: String(e.message) }; }
};

// ── a body that is not JSON ───────────────────────────────────────────────
//
// The case that hung. A captive portal, a proxy's error page, a 502 from a
// CDN -- all of them answer 200 with HTML.
{
  const dir = path.join(tmp, "html");
  answers = {
    [MANIFEST]: { body: JSON.stringify({ versions: [{ id: "26.3", url: VERSION_URL }] }) },
    [VERSION_URL]: { body: "<html><head><title>502 Bad Gateway</title></head>" },
  };
  const r = await tryIt(handlerFor(dir));
  check("a page of HTML where the version should be is an error, not a hang",
    [r.ok, /that is not JSON/.test(r.error || ""), /502 Bad Gateway/.test(r.error || "")],
    [false, true, true],
    "and the error quotes what did come back, because that is what says what went wrong");
}

// An empty body, which is what a connection cut at the wrong moment gives.
{
  answers = {
    [MANIFEST]: { body: JSON.stringify({ versions: [{ id: "26.3", url: VERSION_URL }] }) },
    [VERSION_URL]: { body: "" },
  };
  const r = await tryIt(handlerFor(path.join(tmp, "empty")));
  check("and so is an empty one",
    [r.ok, /it was empty/.test(r.error || "")], [false, true]);
}

// ── the ordinary case ─────────────────────────────────────────────────────
{
  const dir = path.join(tmp, "good");
  answers = {
    [MANIFEST]: { body: JSON.stringify({ versions: [{ id: "26.3", url: VERSION_URL }] }) },
    [VERSION_URL]: { body: JSON.stringify(GOOD) },
  };
  mod.calls.length = 0;
  const r = await tryIt(handlerFor(dir));
  check("a good one goes through", r.ok, true);
  const file = path.join(dir, "26.3.json");
  check("and is written where mclc looks for it first",
    [fs.existsSync(file), JSON.parse(fs.readFileSync(file, "utf8")).id],
    [true, "26.3"],
    "so the fetch that can hang is never reached on this instance again");
  check("the real getVersion is then left to take its own fast path",
    mod.calls, ["real"]);

  // Second time round: the file is there, so nothing is fetched at all.
  mod.calls.length = 0;
  answers = {};                                  // nothing would answer now
  const again = await tryIt(handlerFor(dir));
  check("and a second launch asks the network nothing",
    [again.ok, mod.calls], [true, ["real"]]);
}

// A file that is there but is rubbish: mclc parses that one in the Promise
// executor, which at least rejects -- but it is still rubbish, so it goes.
{
  const dir = path.join(tmp, "corrupt");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "26.3.json"), "{ this is not json");
  answers = {
    [MANIFEST]: { body: JSON.stringify({ versions: [{ id: "26.3", url: VERSION_URL }] }) },
    [VERSION_URL]: { body: JSON.stringify(GOOD) },
  };
  const r = await tryIt(handlerFor(dir));
  check("a half-written version file is replaced rather than tripped over",
    [r.ok, JSON.parse(fs.readFileSync(path.join(dir, "26.3.json"), "utf8")).id],
    [true, "26.3"]);
}

// ── the things mclc reaches into without looking ──────────────────────────
{
  const dir = path.join(tmp, "thin");
  answers = {
    [MANIFEST]: { body: JSON.stringify({ versions: [{ id: "26.3", url: VERSION_URL }] }) },
    [VERSION_URL]: { body: JSON.stringify({ id: "26.3", libraries: [] }) },
  };
  const r = await tryIt(handlerFor(dir));
  check("a version with pieces missing says which piece",
    [r.ok, /"downloads"/.test(r.error || "")], [false, true],
    "beats a TypeError three functions further on");
}

// A version the manifest does not have at all.
{
  answers = { [MANIFEST]: { body: JSON.stringify({ versions: [{ id: "1.21.1", url: VERSION_URL }] }) } };
  const r = await tryIt(handlerFor(path.join(tmp, "missing")));
  check("a version Mojang does not list says so",
    [r.ok, /no "26.3" in it/.test(r.error || "")], [false, true]);
}

// The list itself failing.
{
  answers = { [MANIFEST]: { body: "nope", status: 503, statusText: "Service Unavailable" } };
  const r = await tryIt(handlerFor(path.join(tmp, "down")));
  check("and Mojang being down says that, with the status",
    [r.ok, /503/.test(r.error || "")], [false, true]);
}

// ── the watchdog ──────────────────────────────────────────────────────────
//
// The patch above fixes the one hang that was found. The watchdog is for the
// next one: a launch where nothing at all has happened for minutes is a
// launch waiting on something that is not coming, and it should end with a
// reason rather than saying "launching" until the launcher is closed.
{
  const hasWatch = /QUIET_LIMIT/.test(src);
  check("a silent launch is given up on rather than waited on for ever", hasWatch, true);
  check("and every kind of progress counts as it still getting somewhere",
    ["data", "debug", "progress", "download-status"].every(e => src.includes(`"${e}"`)), true,
    "a download emits several times a second, so silence really does mean stuck");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
