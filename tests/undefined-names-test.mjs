// A name used in the backend that nothing in scope ever defined.
//
// Two of these have reached a user. buildDefaultSkins() called
// cachedJarPath() with no import, so every run threw and logged "Failed to
// get default skins" -- which reads like Mojang being unreachable.
// launchViaWorker() read `quickPlay`, which is a parameter of
// launchProfileCore, two functions away: the launcher fell over with a
// JavaScript error dialog at the exact moment the game came up.
//
// node --check sees neither: the file parses, and the line only fails when
// it runs -- in the first case inside a try, in the second on the one line
// of the launch that runs only on success.
//
// The first version of this test was hand-rolled and collected declarations
// flat across a file, so a name declared in ANY function counted as declared
// in all of them. It passed on the quickPlay bug. ESLint's scope analyser is
// the real thing and is already here, so no-undef does the work now.
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ESLint is here as something else's dependency rather than one of ours, and
// it has no ESM entry point, so it is asked for the CommonJS way. If it ever
// is not here this says so and fails: a guard that quietly stops guarding is
// worse than no guard, because the output still says everything passed.
let Linter;
try {
  Linter = createRequire(import.meta.url)("eslint").Linter;
} catch (err) {
  console.log("FAIL this guard needs eslint, and it is not installed"
    + "\n       " + String(err && err.message || err)
    + "\n       it rides on a transitive dependency; make it a devDependency to pin it");
  process.exit(1);
}
const DIRS = ["backend", "scripts"];

let bad = 0;
const check = (what, got, want, note) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${note ? "  — " + note : ""}`
    + (ok ? "" : `\n       got  ${JSON.stringify(got, null, 2)}\n       want ${JSON.stringify(want)}`));
};

// What a module may use without declaring it: Node's globals, the web ones
// Electron's main process also has, and the CommonJS names, since not every
// file here is ESM.
const GLOBALS = {};
for (const name of [
  "globalThis", "global", "console", "process", "Buffer", "URL", "URLSearchParams",
  "TextEncoder", "TextDecoder", "AbortController", "AbortSignal", "Event", "EventTarget",
  "MessageChannel", "MessagePort", "MessageEvent", "Blob", "File", "FormData",
  "fetch", "Headers", "Request", "Response", "WebSocket", "crypto", "structuredClone",
  "queueMicrotask", "setTimeout", "clearTimeout", "setInterval", "clearInterval",
  "setImmediate", "clearImmediate", "performance", "navigator", "atob", "btoa",
  "require", "module", "exports", "__dirname", "__filename",
]) GLOBALS[name] = "readonly";

const linter = new Linter();

function look(file) {
  const text = fs.readFileSync(file, "utf8");
  const run = (sourceType) => linter.verify(text, {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType,
      globals: GLOBALS,
    },
    rules: { "no-undef": "error" },
  });
  let msgs = run("module");
  // A worker or a script that is not ESM parses as a script instead; a parse
  // error from the wrong guess is not a finding.
  if (msgs.some(m => m.fatal)) {
    const asScript = run("script");
    if (!asScript.some(m => m.fatal)) msgs = asScript;
  }
  return msgs.map(m => ({
    file: path.relative(ROOT, file).split(path.sep).join("/"),
    name: m.fatal ? "(could not parse)" : (/'([^']+)'/.exec(m.message) || [])[1] || m.message,
    line: m.line,
    ...(m.fatal ? { why: m.message } : {}),
  }));
}

const files = [];
for (const dir of DIRS) {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) continue;
  for (const name of fs.readdirSync(full).sort()) {
    if (name.endsWith(".js") || name.endsWith(".mjs")) files.push(path.join(full, name));
  }
}

const offenders = files.flatMap(look);
check("every name the backend uses is one its own scope can see",
  offenders, [],
  "node --check cannot see this: the file parses, and the line only fails when it runs");

// The test is only worth having if it actually catches the two that got out,
// so it is asked to find them in code that has them.
{
  const asIfBroken = [
    // The import that was missing.
    "const latest = '1.21';\nconst r = cachedJarPath(latest);\nexport default r;\n",
    // The parameter read from another function, which is the one the flat
    // version of this test waved through.
    "function core({ quickPlay }) { return quickPlay; }\n"
    + "function worker(cfg) { return quickPlay ? 1 : 0; }\n"
    + "export default [core, worker];\n",
  ];
  const found = asIfBroken.map(code => linter.verify(code, {
    languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: GLOBALS },
    rules: { "no-undef": "error" },
  }).map(m => (/'([^']+)'/.exec(m.message) || [])[1]));
  check("and it finds both of the ones that got out",
    found, [["cachedJarPath"], ["quickPlay"]],
    "a guard nobody has watched fail is a guard nobody knows the shape of");
}

console.log(bad ? `\n${bad} FAILURES` : `\nall pass  (${files.length} files)`);
process.exit(bad ? 1 : 0);
