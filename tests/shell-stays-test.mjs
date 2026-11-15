// The shell must never be replaced by a page.
//
// The launcher is one window: a shell with the title bar and the sidebar,
// and the page you are on in a frame under them. That is what keeps the
// bars, the account's face, the instance shortcuts and the running list from
// reloading on every page change.
//
// sidebar.js runs in the shell as well as in every page, and two of its
// handlers did `window.location.href = 'instances.html?...'` -- which in the
// shell does not change the frame: it swaps the whole shell for a lone page.
// From then on, for the rest of the session, every page change reloaded
// everything and the loading screen started from scratch, which is exactly
// what was reported. "Add an instance" from any page but Instances did it,
// and so did clicking a running instance in the title bar.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let bad = 0;
const check = (what, got, want, note) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${note ? "  — " + note : ""}`
    + (ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`));
};
const code = (f) => fs.readFileSync(path.join(ROOT, f), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

// Every script the shell itself loads.
const shellHtml = fs.readFileSync(path.join(ROOT, "frontend", "shell.html"), "utf8");
const scripts = [...shellHtml.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
check("the shell's scripts can be read", scripts.length > 5, true);

const offenders = [];
for (const s of [...scripts, "playerhead.js"]) {
  let text = "";
  try { text = code(path.join("frontend", s)); } catch { continue; }
  text.split("\n").forEach((line, i) => {
    // Assigning the window's location, which in the shell means replacing it.
    if (/\blocation\.href\s*=[^=]|\blocation\s*=\s*[^=]|\blocation\.(assign|replace)\(/.test(line)) {
      // The one allowed form: goToPage's own last resort, for a page that is
      // NOT in a shell, after it has tried the shell first.
      if (/goToPage/.test(text) && /window\.location\.href = href;/.test(line)) return;
      // The frame's own address, not the shell's: that is a page change.
      if (/\bframe\.contentWindow\.location\./.test(line)) return;
      offenders.push(`${s}:${i + 1}: ${line.trim()}`);
    }
  });
}
check("nothing the shell runs sets the window's location", offenders, [],
  "in the shell that replaces the shell with a lone page; use goToPage");

const main = code("backend/main.js");
check("and the main process turns any such navigation into framing the page",
  /webContents\.on\("will-navigate"[\s\S]{0,600}?shell-navigate/.test(main), true,
  "so the next handler that does it cannot take the shell away either");

const shell = code("frontend/shell.js");
check("asking for the page you are on reloads it",
  /file === here[\s\S]{0,400}?location\.assign\(page\)/.test(shell), true,
  "its button is how a page is reloaded, and how Instances gets back to its list");
check("and does not quietly do nothing instead",
  /typeof w\.showListView === "function"/.test(shell), false);

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
