// Lifting named declarations out of backend/main.js so a test can run the
// real thing.
//
// main.js is the main process: importing it means importing Electron, and
// its top level registers a few hundred ipcMain handlers. So the functions
// under test are cut out by NAME and assembled into a little module of their
// own, with whatever they lean on (the settings store, fs, sharp) handed in.
//
// By name and not by line range, because a range would drag in whatever
// happens to sit between two functions -- and in main.js that is
// ipcMain.handle(...) calls, which run on import.
//
// Found by the shape of the file: main.js is flat, so a top-level
// declaration starts in column one and ends at the next line that is nothing
// but its own closing bracket in column one. Counting brackets would mean
// lexing JavaScript, and the first regular expression with a quote in it --
// ["'] , which main.js has several of -- would be read as the start of a
// string and swallow the rest of the program.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function mainSource() {
  return fs.readFileSync(path.join(ROOT, "backend", "main.js"), "utf8");
}

/** The text of one top-level declaration, or null if it cannot be lifted. */
export function declarationIn(src, name) {
  const lines = src.split(/\r?\n/);
  const re = new RegExp(`^(?:async function|function|const|let)\\s+${name}\\b`);
  const at = lines.findIndex(l => re.test(l));
  if (at < 0) return null;
  if (/;\s*(\/\/.*)?$/.test(lines[at])) return lines[at];
  for (let i = at + 1; i < lines.length; i++) {
    if (/^[}\])]+;?\s*$/.test(lines[i])) return lines.slice(at, i + 1).join("\n");
    // Something else started at the top level, so this is not a shape that
    // can be lifted.
    if (/^(async function|function|const|let|ipcMain|app|if|\/\/)/.test(lines[i])) break;
  }
  return null;
}

/**
 * Build a module out of named declarations from main.js and import it.
 *
 * `prelude` is whatever the lifted code needs around it, as source; every
 * name in `names` is exported.
 */
export async function liftModule(names, { prelude = "", file = "lifted" } = {}) {
  const src = mainSource();
  const parts = [];
  for (const n of names) {
    const text = declarationIn(src, n);
    if (!text) throw new Error(`${n} is not a declaration this can lift out of main.js`);
    parts.push(text.replace(/^(async function|function|const|let)/, "export $1"));
  }
  const scratch = path.join(ROOT, "node_modules", ".cache");
  fs.mkdirSync(scratch, { recursive: true });
  const out = path.join(scratch, `${file}.mjs`);
  fs.writeFileSync(out, `${prelude}\n${parts.join("\n\n")}\n`);
  return import("file://" + out + "?v=" + Date.now());
}
