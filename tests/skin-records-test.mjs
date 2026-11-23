// What counts as a skin in the library.
//
// A card called "undefined" kept turning up on the skins page. Two ways in:
// a picture that never arrived, sent on as 'data:image/png;base64,' + undefined
// -- long enough to pass the old "longer than 32 characters" check -- and a
// name built from a missing value, which is the WORD "undefined". Both are
// refused or repaired now, on save, on load and in every list handed to a
// page. The real functions are cut out of backend/main.js; a copy would pass
// while the launcher was broken.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(ROOT, "backend", "main.js"), "utf8");
let bad = 0;
const check = (what, got, want, note) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${note ? "  — " + note : ""}`
    + (ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`));
};
const from = src.indexOf("const skinPngPayload");
const to = src.indexOf("function loadSkinLib");
if (from < 0 || to < 0) { console.log("FAIL could not find the skin record code in main.js"); process.exit(1); }
const { isSkinRecord, tidySkinRecord } = new Function(
  src.slice(from, to) + "\nreturn { isSkinRecord, tidySkinRecord };")();

// A real 1x1 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

check("a skin with a picture is a skin", isSkinRecord({ id: 1, name: "A", base64: PNG }), true);
check("with the data: prefix too", isSkinRecord({ id: 1, name: "A", base64: "data:image/png;base64," + PNG }), true);
check("a picture that never arrived is not",
  isSkinRecord({ id: 1, name: "A", base64: "data:image/png;base64,undefined" }), false,
  "the text is 31+ characters and passed the old length check");
check("nor is one that is not a PNG at all",
  isSkinRecord({ id: 1, name: "A", base64: "x".repeat(400) }), false);
check("nor one with no picture", isSkinRecord({ id: 1, name: "A" }), false);
check("nor something that is not a record", [null, undefined, "skin", 5].map(isSkinRecord), [false, false, false, false]);

const t = tidySkinRecord({ id: 5, name: "undefined", base64: PNG }, 0);
check("a name that is the word undefined is given a real one", t.name, "Skin");
check("so is null, and an empty one",
  [tidySkinRecord({ id: 5, name: "null", base64: PNG }, 0).name, tidySkinRecord({ id: 5, name: "  ", base64: PNG }, 0).name],
  ["Skin", "Skin"]);
check("an id that is the word undefined is replaced",
  String(tidySkinRecord({ id: "undefined", name: "A", base64: PNG, addedAt: 7 }, 3).id).startsWith("old-"), true);
const fine = { id: 9, name: "Mine", base64: PNG };
check("a good one is left exactly as it is", tidySkinRecord(fine, 0) === fine, true);

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
