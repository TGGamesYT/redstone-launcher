// Two copies of one instance are two runs.
//
// "Run again" starts a second process over the same game folder. Both wrote
// into a single console, interleaved, with no way to tell whose line was
// whose. A run is now a process: its own console, its own start time, and the
// strip above the log picks between them.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(ROOT, "backend/main.js"), "utf8");

let bad = 0;
const check = (label, got, want, note) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${note ? "  — " + note : ""}\n       got  ${JSON.stringify(got)}` + (ok ? "" : `\n       want ${JSON.stringify(want)}`));
};

// The launcher's own bookkeeping, sliced out rather than copied: a copy would
// pass while the launcher did something else.
const cut = (a, b) => {
  const i = src.indexOf(a), j = src.indexOf(b, i);
  if (i < 0 || j < 0) { console.log(`FAIL could not find ${JSON.stringify(i < 0 ? a : b)} in main.js`); process.exit(1); }
  return src.slice(i, j);
};
const runs = new Function(`
  ${cut("const instanceRuns = new Map();", "function flushLogs()")}
  return { beginRun, runsOf, findRun, runStarted, runEnded, instanceRuns, RUNS_KEPT };
`)();

// ── a run per launch ──
const a = runs.beginRun("Main");
const b = runs.beginRun("Main");
check("two launches of one instance are two runs", a === b, false);
check("and both are remembered, in the order they were started",
  runs.runsOf("Main").map(r => r.run), [a, b]);
check("another instance's runs are its own", runs.runsOf("Other"), []);

runs.runStarted("Main", a, 1111);
runs.runStarted("Main", b, 2222);
check("each knows which process it turned out to be",
  runs.runsOf("Main").map(r => r.pid), [1111, 2222]);
check("and when it was started",
  runs.runsOf("Main").every(r => typeof r.startedAt === "number" && r.startedAt > 0), true);

// ── their lines stay apart ──
const say = (run, text) => { const r = runs.findRun("Main", run); r.lines.push(text); };
say(a, "first copy says hello");
say(b, "second copy says hello");
say(a, "first copy again");
check("a line goes to the run it came from",
  [runs.findRun("Main", a).lines, runs.findRun("Main", b).lines],
  [["first copy says hello", "first copy again"], ["second copy says hello"]],
  "both used to land in one console, interleaved");

runs.runEnded("Main", a);
check("a run that has finished says when", typeof runs.findRun("Main", a).endedAt, "number");
check("and one still going has not", runs.findRun("Main", b).endedAt, null);
const was = runs.findRun("Main", a).endedAt;
runs.runEnded("Main", a);
check("ending it twice does not move the time", runs.findRun("Main", a).endedAt, was);

// ── starting one that has already stopped is the same console ──
//
// A run is its own console so that two copies running AT THE SAME TIME can be
// told apart. One after the other is not that, and it left a row of tabs, one
// per launch, all but the last of them dead.
const again = runs.beginRun("Main");
check("a launch takes over a run that has finished", again === a, true,
  "one console per copy that is running, not one per launch ever made");
check("and never one that is still going", again === b, false);
check("the run it took over is live again",
  [runs.findRun("Main", a).endedAt, runs.runsOf("Main").length], [null, 2]);
check("and what that console said before is kept, with the new session under it",
  runs.findRun("Main", a).lines,
  ["first copy says hello", "first copy again", "", "[Started again]"]);

const third = runs.beginRun("Main");
check("with nothing finished, a launch is a console of its own",
  [third === a, third === b, runs.runsOf("Main").length], [false, false, 3]);

// ── not forever ──
for (let i = 0; i < 20; i++) runs.beginRun("Main");
check("only the last few launches are kept", runs.runsOf("Main").length, runs.RUNS_KEPT,
  "a long session is thousands of lines, and there is no reason to hold every launch ever made");
check("and the ones kept are the newest",
  runs.runsOf("Main").some(r => r.run === a), false);

// ── what the window is given ──
check("a line is sent with the run it belongs to",
  /mainWindow\.webContents\.send\('launcher-log', \{ profileId, run/.test(src), true);
check("the console can ask for one run's lines",
  /ipcMain\.handle\('get-instance-logs', \(event, profileId, run\)/.test(src), true);
check("and for the list of runs to choose from",
  src.includes("ipcMain.handle('get-instance-runs'"), true);
check("a launch opens a run before it starts doing anything",
  /const run = beginRun\(profileId\);/.test(src), true);
check("and the lines of that launch carry it",
  (src.match(/broadcastLog\(profileId, [^;]*, run\)/g) || []).length > 8, true);

// The page that shows them.
const page = fs.readFileSync(path.join(ROOT, "frontend/instances.html"), "utf8");
check("the console has a strip to pick a run with", /runStrip\.className = "tabstrip log-runs"/.test(page), true);
check("hidden when there is only one", /runs\.length < 2.*runStrip\.style\.display = "none"/s.test(page), true);
check("and a line from another run is not appended to the one being read",
  /data\.run && shownRun && data\.run !== shownRun/.test(page), true);

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
