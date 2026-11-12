// Does what the main process says actually reach the page?
//
// The launcher is one page now: a shell holding the two bars, with whichever
// page you are on in a frame beneath them. Electron's `webContents.send`
// delivers to a window's MAIN frame -- the shell -- and to no other, so every
// broadcast the launcher makes stopped there and the page heard none of it.
// A running game's log is sent that way, which is why its lines reached the
// launcher later than Electron's own terminal: nothing arrived, and the page
// fell back to asking every couple of seconds.
//
// That is not a thing to take anyone's word for, including mine, so this
// stands up a real window with a real frame in it and checks both halves:
// that a frame hears nothing without backend/ipcframes.js, and hears it with.
// Same webPreferences as the launcher's window, or it would be proving
// something about a different window.
//
// Needs Electron's binary (npm's postinstall fetches it) and, on a machine
// with no screen, xvfb. Without either it says so and passes, rather than
// failing for a reason that has nothing to do with the code.
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "node_modules", ".cache", "ipcframes");

let bad = 0;
const fail = (what, why) => { bad++; console.log(`FAIL ${what}\n       ${why}`); };
const ok = (what, note) => console.log(`ok   ${what}${note ? "  — " + note : ""}`);
const check = (what, got, want, note) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) ok(what, note); else fail(what, `got  ${a}\n       want ${b}`);
};
const skip = (why) => { console.log(`skip this needs ${why}`); console.log("\nall pass (skipped)"); process.exit(0); };

// Where Electron's binary is, without asking Electron -- its own entry point
// throws when the binary has not been downloaded.
let electron = null;
try {
  const dist = path.join(ROOT, "node_modules", "electron", "dist");
  for (const name of ["electron", "electron.exe", "Electron.app/Contents/MacOS/Electron"]) {
    const at = path.join(dist, name);
    if (fs.existsSync(at)) { electron = at; break; }
  }
} catch { /* not installed */ }
if (!electron) skip("Electron's binary, which npm install fetches");

const headless = process.platform === "linux" && !process.env.DISPLAY;
const xvfb = spawnSync("xvfb-run", ["--help"], { stdio: "ignore" });
if (headless && (xvfb.error || xvfb.status === undefined)) skip("a screen, or xvfb-run");

// ── the app under test ──
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const write = (name, text) => fs.writeFileSync(path.join(OUT, name), text);

write("package.json", JSON.stringify({ name: "ipcframes", version: "1.0.0", main: "main.cjs" }));
// A second frame that never gets a document of its own, which is what every
// frame is for the first moments of its life -- and what the launcher's own
// frame is while its first page loads. Nothing of ours is running in it, so
// sending to it reaches nobody and makes the renderer print
// "Attempted to get the 'ipcNative' object but it was missing".
write("shell.html", `<!doctype html><html><body>
<iframe src="inner.html"></iframe>
<iframe id="blank"></iframe>
<script>
  const { ipcRenderer } = require('electron');
  ipcRenderer.on('ping', (_e, what) => ipcRenderer.send('heard', { who: 'shell', what }));
</script></body></html>`);
write("inner.html", `<!doctype html><html><body>
<script>
  const { ipcRenderer } = require('electron');
  ipcRenderer.on('ping', (_e, what) => ipcRenderer.send('heard', { who: 'page', what }));
  ipcRenderer.send('up');
</script></body></html>`);

// `patched` decides whether the launcher's own fix is applied, so the run
// with it and the run without it differ in exactly that and nothing else.
write("main.cjs", `
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const patched = process.argv.includes('--patched');
const heard = [];
let framesUp = 0;
ipcMain.on('heard', (_e, m) => heard.push(m.who + ' <- ' + m.what));
ipcMain.on('up', () => { framesUp++; });

app.whenReady().then(async () => {
  if (patched) {
    const { deliverToEveryFrame } = await import(require('url').pathToFileURL(
      path.join(${JSON.stringify(ROOT)}, 'backend', 'ipcframes.js')).href);
    deliverToEveryFrame(app);
  }
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: true, contextIsolation: false,
      nodeIntegrationInSubFrames: true, webSecurity: false,
    },
  });
  await win.loadFile(path.join(__dirname, 'shell.html'));
  for (let i = 0; i < 60 && !framesUp; i++) await new Promise(r => setTimeout(r, 100));
  win.webContents.send('ping', 'a broadcast');
  await new Promise(r => setTimeout(r, 1000));
  console.log('ANSWER ' + JSON.stringify({ framesUp, heard: heard.sort() }));
  app.quit();
});
`);

function run(patched) {
  const args = [...(headless ? ["-a", electron] : []), ".", "--no-sandbox", ...(patched ? ["--patched"] : [])];
  const r = spawnSync(headless ? "xvfb-run" : electron, args,
    { cwd: OUT, encoding: "utf8", timeout: 120000, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" } });
  const line = String(r.stdout || "").split("\n").find(l => l.startsWith("ANSWER "));
  if (!line) {
    console.log((r.stdout || "").split("\n").slice(-6).join("\n"));
    console.log((r.stderr || "").split("\n").slice(-6).join("\n"));
    return null;
  }
  // Electron prints the ipcNative complaint to stderr, from the renderer --
  // it is not thrown, so no try/catch in the main process ever sees it.
  const noise = String(r.stdout || "") + String(r.stderr || "");
  return { ...JSON.parse(line.slice(7)), ipcNative: /ipcNative/.test(noise) };
}

const plain = run(false);
if (!plain) { fail("the test window runs at all", "Electron never answered"); process.exit(1); }
check("the window really has a frame in it", plain.framesUp, 1,
  "or the rest of this would be proving nothing");
check("a broadcast reaches the shell and NOT the page in the frame",
  plain.heard, ["shell <- a broadcast"],
  "which is the bug: every broadcast the launcher makes stopped at the shell");

const fixed = run(true);
if (!fixed) { fail("the test window runs with the fix", "Electron never answered"); process.exit(1); }
check("and with backend/ipcframes.js it reaches both",
  fixed.heard, ["page <- a broadcast", "shell <- a broadcast"],
  "the page hears a game's log lines as they happen again");

// And that reaching both does not mean shouting at a frame that is not
// there. This is the line that was in the launcher's log on every start:
// the window's first page is still loading, every broadcast goes to its
// empty frame as well, and each one prints the complaint.
check("and it says nothing to a frame with no document in it",
  fixed.ipcNative, false,
  "\"Attempted to get the 'ipcNative' object but it was missing\", once per broadcast");

// And that the launcher actually turns it on.
const src = fs.readFileSync(path.join(ROOT, "backend", "main.js"), "utf8");
check("the launcher turns it on", /deliverToEveryFrame\(app\);/.test(src), true);

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
