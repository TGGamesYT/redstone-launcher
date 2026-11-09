// Two copies of one instance, running at the same time.
//
// "Run again" is a second game over the same folders, and launching one
// while another is already playing is the same thing. Those folders are
// shared between processes that know nothing about each other, so the
// launcher has to behave as though one of them is always in the middle of
// reading something -- otherwise a second launch takes the natives out from
// under the game already using them, or two launches write over each other
// and leave a file that is neither of theirs.
//
// The rules are in backend/launcher-worker.js and they are sliced out of it
// here rather than copied, so a test cannot pass while the launcher does
// something else.
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(ROOT, "backend/launcher-worker.js"), "utf8");

let bad = 0;
const fail = (what, why) => { bad++; console.log(`FAIL ${what}\n       ${why}`); };
const ok = (what, note) => console.log(`ok   ${what}${note ? "  — " + note : ""}`);
const check = (what, got, want, note) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) ok(what, note); else fail(what, `got  ${a}\n       want ${b}`);
};

const cut = (a, b) => {
  const i = src.indexOf(a), j = src.indexOf(b, i);
  if (i < 0 || j < 0) { console.log(`FAIL could not find ${JSON.stringify(i < 0 ? a : b)} in launcher-worker.js`); process.exit(1); }
  return src.slice(i, j);
};
const W = new Function("fs", "path", "process", `
  ${cut("const inUse = new Set();", "// ── The library jars")}
  return { writeAtomic, alive, markInUse, usedByAnother, releaseInUse, withLock, inUse };
`)(fs, path, process);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "rl-conc-"));
const dir = path.join(TMP, "natives");
fs.mkdirSync(dir, { recursive: true });

// ── nothing is written in place ──
{
  const file = path.join(TMP, "stamp.json");
  fs.writeFileSync(file, '{"old":true}');
  W.writeAtomic(file, '{"new":true}');
  check("a file is replaced, not rewritten", fs.readFileSync(file, "utf8"), '{"new":true}');
  check("and nothing is left beside it",
    fs.readdirSync(TMP).filter(f => f.startsWith("stamp.json.")), [],
    "a temp file left behind would be read as a stamp by nobody, but it would pile up");

  // The point of it, measured against ANOTHER PROCESS -- which is the only
  // place it can be measured. A write within one process cannot be caught
  // half done by that same process, so a test that watches its own writing
  // proves nothing whichever way the writing is done.
  //
  // Both ways are run: writing into the file is seen half done, renaming
  // over it never is. The first half is there so the second half cannot
  // quietly stop meaning anything.
  const racer = (how) => {
    const target = path.join(TMP, `race-${how}.json`);
    fs.writeFileSync(target, '{"n":0}');
    const code = how === "atomic"
      ? `const tmp = f + ".tmp"; fs.writeFileSync(tmp, text); fs.renameSync(tmp, f);`
      : `fs.writeFileSync(f, text);`;
    const child = spawn(process.execPath, ["-e", `
      const fs = require("fs");
      const f = ${JSON.stringify(target)};
      const text = JSON.stringify({ n: 1, pad: "x".repeat(3000000) });
      const until = Date.now() + 1500;
      while (Date.now() < until) { ${code} }
    `], { stdio: "ignore" });
    let seen = 0, reads = 0;
    const until = Date.now() + 1500;
    while (Date.now() < until) {
      reads++;
      try { JSON.parse(fs.readFileSync(target, "utf8")); } catch { seen++; }
    }
    try { child.kill(); } catch { /* already done */ }
    return { seen, reads };
  };
  const inPlace = racer("in-place");
  const atomic = racer("atomic");
  check("a file written INTO is caught half there by another process",
    inPlace.seen > 0, true,
    `${inPlace.seen} of ${inPlace.reads} reads -- which is what the launcher must not do`);
  check("and one renamed over it never is",
    atomic.seen, 0,
    `${atomic.reads} reads while another process replaced it over and over`);
}

// ── nothing in use is deleted ──
{
  check("a folder nobody has marked is free", W.usedByAnother(dir), false);

  W.markInUse(dir);
  check("this launch's own mark does not count as somebody else",
    W.usedByAnother(dir), false,
    "or a launch could never rebuild a folder it had just claimed");

  // Another launch, which is still running. A pid that is definitely alive
  // and definitely not us: a child process held open for the check.
  const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  await new Promise(r => setTimeout(r, 200));
  fs.writeFileSync(path.join(dir, `.inuse-${other.pid}`), String(Date.now()));
  check("a mark from a launch that is still running counts", W.usedByAnother(dir), true,
    "this is the one that stops the natives being taken out from under a game");
  other.kill();
  await new Promise(r => setTimeout(r, 400));
  check("and once it has gone, it does not", W.usedByAnother(dir), false);
  check("its mark is swept rather than left for ever",
    fs.readdirSync(dir).filter(f => /^\.inuse-/.test(f)).length, 1,
    "only this launch's own is left");

  W.releaseInUse();
  check("and a launch lets go when it is done",
    fs.readdirSync(dir).filter(f => /^\.inuse-/.test(f)), []);
}

// ── two launches do not do it at once ──
{
  const lock = path.join(TMP, "natives.lock");
  const order = [];
  let inside = 0, overlapped = false;
  const job = (name) => W.withLock(lock, async (held) => {
    if (!held) { order.push(name + ":unlocked"); return; }
    inside++;
    if (inside > 1) overlapped = true;
    order.push(name + ":in");
    await new Promise(r => setTimeout(r, 120));
    order.push(name + ":out");
    inside--;
  });
  await Promise.all([job("a"), job("b"), job("c")]);
  check("three launches take the folder in turn", overlapped, false,
    order.join(" "));
  check("and all three get it", order.filter(o => o.endsWith(":in")).length, 3);
  check("and the lock is not left behind", fs.existsSync(lock), false);
}

// ── a lock left by a launch that died ──
{
  const lock = path.join(TMP, "stale.lock");
  // A pid that cannot be running: one we have just reaped.
  const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const deadPid = dead.pid;
  await new Promise(r => dead.on("exit", r));
  await new Promise(r => setTimeout(r, 200));
  fs.writeFileSync(lock, String(deadPid));

  let got = false;
  const started = Date.now();
  await W.withLock(lock, (held) => { got = held; }, { waitMs: 5000 });
  check("a lock left behind by a launch that died is taken over", got, true,
    `in ${Date.now() - started}ms, rather than every future launch waiting on it`);
  check("and released again", fs.existsSync(lock), false);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
