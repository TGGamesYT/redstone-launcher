// Where a server's jar comes from, and what a generated pack says about
// itself. Both are things an outside service decides, and both broke because
// what the service answers changed under us.
import fs from "fs";
import os from "os";
import path from "path";
import https from "https";
import { fileURLToPath } from "url";
import { TOTEM_PACK_MCMETA } from "../backend/totem.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIVE = process.env.OFFLINE !== "1";
let bad = 0;
const check = (label, got, want, note) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${note ? "  — " + note : ""}\n       got  ${JSON.stringify(got)}` + (ok ? "" : `\n       want ${JSON.stringify(want)}`));
};

// ── the totem pack's own metadata ──
// The game reads one of three keys depending on how old it is, and a pack
// that answers only one way is filed under "Incompatible" by the rest. The
// newest clients go further: past format 64 they REQUIRE min_format and
// max_format, and log "missing mandatory fields" without them.
check("the pack declares its format three ways", TOTEM_PACK_MCMETA.pack, {
  description: "§7Custom Java §cTotem of Undying§7 Pack!",
  pack_format: 15,
  supported_formats: { min_inclusive: 15, max_inclusive: 999 },
  min_format: 15,
  max_format: 999,
}, "exactly these, or some version of the game refuses the pack");
check("and nothing claims a ceiling without the two keys that go with it",
  TOTEM_PACK_MCMETA.pack.supported_formats.max_inclusive > 64
    ? [TOTEM_PACK_MCMETA.pack.min_format != null, TOTEM_PACK_MCMETA.pack.max_format != null]
    : [true, true],
  [true, true]);

// ── resolving a server jar ──
// Sliced out of serverManager rather than reimplemented: a copy would pass
// while the launcher failed, which is exactly what happened when PaperMC
// switched their old API off.
const src = fs.readFileSync(path.join(ROOT, "backend/serverManager.js"), "utf8");
const cut = (a, b) => {
  const i = src.indexOf(a), j = src.indexOf(b, i);
  if (i < 0 || j < 0) { console.log(`FAIL could not find ${JSON.stringify(i < 0 ? a : b)} in serverManager.js`); process.exit(1); }
  return src.slice(i, j);
};
const scratch = path.join(ROOT, "node_modules", ".cache");
fs.mkdirSync(scratch, { recursive: true });
const modPath = path.join(scratch, "serverjar.mjs");
fs.writeFileSync(modPath, `import https from "https";\n`
  + cut("const PAPER_API =", "function fetchText(").replace(/^async function resolveJarUrl/m, "export async function resolveJarUrl"));
const { resolveJarUrl } = await import("file://" + modPath);

// In a string, that is: the comment explaining why it went still names it.
check("the old PaperMC API is no longer called", /["'`]https:\/\/api\.papermc\.io\/v2/.test(src), false,
  "it answers every request with {ok:false, error:'sunset'}, so asking it for builds gave an object with no builds in it");
check("and requests name the launcher, which the new one asks for",
  /User-Agent/.test(src) && /RedstoneLauncher/.test(src), true);

if (LIVE) {
  const jar = await resolveJarUrl("26.3", "paper");
  check("a Paper jar resolves for a current version", /^https:\/\/\S+\.jar$/.test(jar), true, jar);
  check("and for an older one", /\.jar$/.test(await resolveJarUrl("1.21.4", "paper")), true);
  check("Folia too", /folia-/.test(await resolveJarUrl("26.3", "folia")), true);
  // Whatever it resolves to has to actually be there.
  const head = await new Promise((ok) => https.request(jar, { method: "HEAD" }, (r) => ok(r.statusCode)).on("error", () => ok(0)).end());
  check("and the jar is really at that address", head, 200);
  let why = null;
  try { await resolveJarUrl("9.9.9", "paper"); } catch (e) { why = e.message; }
  check("a version they do not have says so, rather than 'not iterable'",
    [/no builds for 9\.9\.9/.test(why || ""), /iterable/.test(why || "")], [true, false]);
} else {
  console.log("ok   (the live checks were skipped: OFFLINE=1)");
}

// ── what the Console tab shows when nothing is running ──
//
// An instance's Logs tab falls back to the game's own latest.log, so it is a
// record of what happened. A server's showed an empty box: the only source
// was the in-memory buffer of the running process, so a stopped server, or
// any server at all after the launcher restarted, had nothing to show.
//
// The page joins what it gets with NOTHING between the entries, because the
// live ones carry their own newline. Lines read from a file have to do the
// same or they arrive as one very long line, so that is checked here rather
// than left to be noticed on screen.
{
  const sliced = cut("const CONSOLE_TAIL =", "// --- Delete a server");
  const modFile = path.join(scratch, "serverconsole.mjs");
  fs.writeFileSync(modFile,
    `import fs from "fs";\nimport path from "path";\n`
    + `export let serversDir = "";\nexport const setDir = (d) => { serversDir = d; };\n`
    + `const servers = new Map();\nexport const setLive = (n, logs) => servers.set(n, { logs });\n`
    + sliced.replace(/^function getConsole/m, "export function getConsole"));
  const { getConsole, setDir, setLive } = await import("file://" + modFile + "?v=" + Date.now());

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "srvconsole-"));
  setDir(dir);

  check("a server with no log and nothing running shows nothing",
    getConsole("ghost"), []);

  fs.mkdirSync(path.join(dir, "Survival", "logs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "Survival", "logs", "latest.log"),
    "[12:00:00] Starting minecraft server\n[12:00:02] Done (2.1s)!\n");

  const got = getConsole("Survival");
  check("a stopped server shows its own latest.log",
    got, ["[Loaded from latest.log]\n", "[12:00:00] Starting minecraft server\n", "[12:00:02] Done (2.1s)!\n"],
    "an empty Console tab for a server that has been running all week is not a console");
  check("and every entry carries its newline, as the live ones do",
    got.join("").split("\n").filter(Boolean),
    ["[Loaded from latest.log]", "[12:00:00] Starting minecraft server", "[12:00:02] Done (2.1s)!"],
    "the page joins them with nothing between, so one without a newline is a line glued to the next");
  check("the trailing blank line a file ends with is not one of them",
    got[got.length - 1], "[12:00:02] Done (2.1s)!\n");

  // A running server's own lines are the truth; the file is only the fallback.
  setLive("Survival", ["[12:05:00] <TGdoesCode> hi\n"]);
  check("a running server shows what it is saying now, not the file",
    getConsole("Survival"), ["[12:05:00] <TGdoesCode> hi\n"],
    "the file on disk lags behind by however long the server buffers it");

  // An empty live buffer is not an answer, it is the absence of one.
  setLive("Survival", []);
  check("and an empty buffer still falls back",
    getConsole("Survival")[0], "[Loaded from latest.log]\n");

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
