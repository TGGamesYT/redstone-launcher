// The game's own cache of server resource packs, checked before a launch.
//
// This folder is not the launcher's: the game downloads a server's resource
// pack into <gameDir>/downloads/<world uuid>/<sha1 of the pack> and never
// checks it again afterwards. A pack that arrived short is kept, and from then
// on every launch says "not found or had mismatched hash" and then loads it
// anyway -- which is the flood of "Exception loading blockstate definition"
// and a resource reload working from half a zip.
//
// The file is named after its own SHA-1, so whether it is the file it claims
// to be is answerable without asking anybody. The thing to prove is that it
// deletes exactly the broken ones and nothing else: this code removes files
// out of somebody's game directory.
import fs from "fs";
import path from "path";
import crypto from "crypto";
import os from "os";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let bad = 0;
const check = (label, got, want, note) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${note ? "  — " + note : ""}\n       got  ${JSON.stringify(got)}` + (ok ? "" : `\n       want ${JSON.stringify(want)}`));
};

// Sliced out of main.js, with the log it writes to collected instead.
const src = fs.readFileSync(path.join(ROOT, "backend/main.js"), "utf8");
const i = src.indexOf("function sweepServerPackCache(rootDir, profileId, run) {");
const j = src.indexOf("\n}\n", src.indexOf("look(root, 0);", i)) + 3;
if (i < 0 || j < 3) { console.log("FAIL could not find sweepServerPackCache in main.js"); process.exit(1); }
const said = [];
const sweep = new Function("fs", "path", "crypto", "said", `
  const broadcastLog = (id, msg) => said.push(msg);
  ${src.slice(i, j)}
  return sweepServerPackCache;
`)(fs, path, crypto, said);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "packcache-"));
const dl = path.join(root, "downloads", "6cc9310d-3c97-3b3f-957c-f346592dcebc");
fs.mkdirSync(dl, { recursive: true });

const sha = (b) => crypto.createHash("sha1").update(b).digest("hex");
const good = Buffer.from("a resource pack that arrived whole");
const goodName = sha(good);
fs.writeFileSync(path.join(dl, goodName), good);

// The broken one: named after the hash of the whole file, holding only part
// of it. Exactly what a connection cut halfway through leaves.
const whole = Buffer.alloc(4096, 9);
const brokenName = sha(whole);
fs.writeFileSync(path.join(dl, brokenName), whole.slice(0, 1200));

// And things that are not hash-named, which must be left alone whatever is in
// them -- the game puts files here on purpose too.
fs.writeFileSync(path.join(dl, "notes.txt"), "leave me");
fs.writeFileSync(path.join(root, "downloads", "top-level.dat"), "leave me too");
// A nested one, since the game nests by world.
const deep = path.join(root, "downloads", "another", "world");
fs.mkdirSync(deep, { recursive: true });
const deepBroken = sha(Buffer.from("x".repeat(100)));
fs.writeFileSync(path.join(deep, deepBroken), "not that at all");

sweep(root, "an-instance", null);

check("the damaged pack is gone", fs.existsSync(path.join(dl, brokenName)), false);
check("one nested deeper is found too", fs.existsSync(path.join(deep, deepBroken)), false,
  "the game nests these by world");
check("the one that matches its own hash is kept", fs.existsSync(path.join(dl, goodName)), true);
check("and nothing that is not named after a hash is touched",
  [fs.existsSync(path.join(dl, "notes.txt")), fs.existsSync(path.join(root, "downloads", "top-level.dat"))],
  [true, true],
  "this deletes files out of somebody's game directory");

check("it says what it did, and how many it looked at",
  said.filter(m => /damaged/.test(m)), ["[packs] 2 of 3 cached server packs were damaged; the server will send them again."]);
check("and names each one it removed", said.filter(m => /was not the file it claims/.test(m)).length, 2);

// Run again: there is nothing left to do and nothing is said.
said.length = 0;
sweep(root, "an-instance", null);
check("a second launch has nothing to say", said, []);

// No folder at all is the ordinary case for a new instance.
said.length = 0;
const empty = fs.mkdtempSync(path.join(os.tmpdir(), "packcache-none-"));
sweep(empty, "an-instance", null);
check("an instance that has never joined a server is not a problem", said, []);

fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(empty, { recursive: true, force: true });

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
