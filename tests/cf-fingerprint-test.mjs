// CurseForge's file fingerprint, which is the only handle on "which
// CurseForge file is this jar" -- there is no asking for one by sha1 the
// way Modrinth allows.
//
// It is a murmur2 over the file with every whitespace byte removed first,
// which is not what murmur2 normally does, so it is easy to move it and
// break it without noticing. It has just been moved out of main.js, hence
// this: the values below came from the implementation as it stood before
// the move, so a difference is a difference from the launcher that shipped.
import fp from "../backend/cf-fingerprint.js";

let bad = 0;
const check = (what, got, want, note) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${note ? "  — " + note : ""}`
    + (ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`));
};
const of = (s) => fp.fingerprintOf(Buffer.from(s, "binary"));

check("it is a number, not a string", typeof of("hello"), "number");
check("and an unsigned 32-bit one", of("hello") >= 0 && of("hello") <= 0xffffffff, true);

// The property the whole thing exists for.
check("whitespace does not change it",
  [of("a b c"), of("a\tb\nc"), of("abc")].every((v, _, all) => v === all[0]), true,
  "a jar repacked with different line endings still matches");
check("but anything else does", of("abc") === of("abd"), false);
check("an empty file has one too", typeof of(""), "number");

// Fixed values, taken from the implementation before it was moved. If one of
// these changes, every instance exported before now stops resolving its
// CurseForge mods.
check("the exact values have not moved",
  ["", "a", "abc", "hello world", "\u0000\u0001\u0002", "x".repeat(1000)].map(of),
  [1540447798, 626045324, 1621425345, 2824650221, 1374027183, 27999438],
  "written down rather than recomputed: comparing the function to itself proves nothing");

// It must be gone from main.js, or there are two and they will drift.
const fs = await import("fs");
const main = fs.readFileSync(new URL("../backend/main.js", import.meta.url), "utf8");
check("there is only one copy of it",
  /function getFingerprint\s*\(/.test(main), false,
  "two implementations of a hash is two implementations that will disagree one day");
check("and main.js uses this one",
  /from ['"]\.\/cf-fingerprint\.js['"]/.test(main), true);

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
