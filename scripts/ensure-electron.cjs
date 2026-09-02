/**
 * A plain `npm i` on a fresh machine can leave the electron PACKAGE installed but
 * its actual binary missing — electron downloads that in a postinstall script, so
 * an interrupted download, a proxy hiccup or a partial cache leaves you with
 * "Electron failed to install correctly" and `npm i electron` as the only fix.
 *
 * This runs after every install, checks whether the binary is really there, and
 * re-runs electron's own installer if it isn't. It never fails the install — a
 * machine that's simply offline still gets a working `npm i`, just with a clear
 * message about what to run later.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.join(__dirname, "..");
const electronDir = path.join(root, "node_modules", "electron");

function log(msg) { console.log("[ensure-electron] " + msg); }

if (!fs.existsSync(electronDir)) {
  log("electron isn't installed (dev dependencies may have been skipped).");
  log('If you want to run the app from source, install it with: npm i');
  process.exit(0);
}

// electron writes the binary's name into path.txt and unpacks it under dist/.
function binaryPath() {
  try {
    const p = fs.readFileSync(path.join(electronDir, "path.txt"), "utf8").trim();
    return p ? path.join(electronDir, "dist", p) : null;
  } catch { return null; }
}
function installed() {
  const b = binaryPath();
  return !!(b && fs.existsSync(b));
}

if (installed()) process.exit(0);

log("the Electron binary is missing — running Electron's installer…");
try {
  execFileSync(process.execPath, [path.join(electronDir, "install.js")], {
    cwd: electronDir,
    stdio: "inherit",
  });
} catch {
  log("couldn't download the Electron binary (offline or blocked?).");
  log('Run "npm rebuild electron" once you have a connection.');
  process.exit(0);
}

if (installed()) log("Electron is ready.");
else log('still incomplete — try "npm rebuild electron".');
