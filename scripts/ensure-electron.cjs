/**
 * A plain `npm i` on a fresh machine can leave the electron PACKAGE installed but
 * its actual binary missing — electron downloads that in a postinstall script, so
 * a skipped script (`ignore-scripts`), an interrupted download or a proxy hiccup
 * leaves you with "Electron failed to install correctly" and `npm i electron` as
 * the only fix.
 *
 * This runs as `postinstall` AND as `preapp`, so even if the install-time repair
 * never got the chance to run, `npm run app` fixes it before starting. It never
 * fails the install — a machine that's simply offline still gets a working
 * `npm i`, just with a clear message about what to run later.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.join(__dirname, "..");
const electronDir = path.join(root, "node_modules", "electron");

function log(msg) { console.log("[ensure-electron] " + msg); }

// electron writes the binary's name into path.txt and unpacks it under dist/.
// This mirrors what node_modules/electron/index.js itself checks, so if it passes
// here, requiring electron works.
function installed() {
  try {
    const p = fs.readFileSync(path.join(electronDir, "path.txt"), "utf8").trim();
    return !!p && fs.existsSync(path.join(electronDir, "dist", p));
  } catch { return false; }
}

// `npm rebuild` re-runs the package's own install scripts. --ignore-scripts=false
// beats an ignore-scripts=true in the user's global npm config, which is the most
// common reason electron's downloader never ran in the first place.
function npmRebuild() {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  execFileSync(npm, ["rebuild", "electron", "--ignore-scripts=false", "--foreground-scripts"], {
    cwd: root, stdio: "inherit", shell: process.platform === "win32",
  });
}

// Electron's own downloader, run directly. Works even when npm itself is the
// thing refusing to run scripts.
function runInstallScript() {
  const script = path.join(electronDir, "install.js");
  if (!fs.existsSync(script)) throw new Error("electron/install.js is missing");
  execFileSync(process.execPath, [script], { cwd: electronDir, stdio: "inherit" });
}

if (!fs.existsSync(electronDir)) {
  log("electron isn't installed (dev dependencies may have been skipped).");
  log('To run the app from source, install it with: npm i --include=dev');
  process.exit(0);
}

if (installed()) process.exit(0);

log("the Electron binary is missing — repairing…");
// Two ways in, because they fail for different reasons: the install script can be
// missing or be the wrong module kind, and npm can be configured not to run it.
for (const attempt of [runInstallScript, npmRebuild]) {
  try { attempt(); } catch (e) { log("that attempt failed: " + e.message); }
  if (installed()) { log("Electron is ready."); process.exit(0); }
}

log("still incomplete. With a working connection, run:");
log("  npm rebuild electron --ignore-scripts=false");
process.exit(0);
