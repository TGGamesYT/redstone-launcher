// Every assets/… path the frontend names is a file that is in the repository.
//
// A file moved without its references moving with it still works on a
// computer that has an old copy lying where it used to be -- which is how
// assets/template.png and assets/rick.png worked in development and were
// "not found" in every built launcher once they had moved into
// assets/skins/.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FRONT = path.join(ROOT, "frontend");
let bad = 0;

// What git has, not what is on this disk: an untracked leftover is exactly
// what hid this.
let tracked = null;
try {
  const { execFileSync } = await import("child_process");
  tracked = new Set(execFileSync("git", ["ls-files", "frontend"], { cwd: ROOT }).toString()
    .split("\n").filter(Boolean).map(f => f.replace(/^frontend\//, "")));
} catch { /* no git here: fall back to the disk */ }
const exists = (rel) => tracked ? tracked.has(rel) : fs.existsSync(path.join(FRONT, rel));

const files = fs.readdirSync(FRONT).filter(f => /\.(js|html|css)$/.test(f) && !/bundle|three\.module/.test(f));
const RE = /['"`](?:\.\/)?(assets\/[A-Za-z0-9_./ -]+\.(?:png|jpe?g|gif|svg|webp|ogg|mp3|json|ttf|woff2?))['"`]/g;
const missing = [];
for (const f of files) {
  const text = fs.readFileSync(path.join(FRONT, f), "utf8");
  for (const m of text.matchAll(RE)) if (!exists(m[1])) missing.push(`${f}: ${m[1]}`);
}
const ok = missing.length === 0;
if (!ok) bad++;
console.log(`${ok ? "ok  " : "FAIL"} every assets/ path the frontend names is in the repository`
  + (ok ? "" : "\n       " + [...new Set(missing)].join("\n       ")));

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
