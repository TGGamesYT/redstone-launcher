// Build the quiclime sidecar.
//
//   npm run sidecar                 for the machine you are on
//   npm run sidecar -- --all        every target this machine can link
//   npm run sidecar -- --mac-both   both macOS architectures
//
// The sidecar is the little Rust program that talks to e4mc's relays, because
// Electron cannot speak QUIC (see sidecar/README.md). The launcher works
// without it -- the relay setting falls back to our own relay -- but a release
// that quietly lost e4mc support is not something to find out about later, so
// this fails loudly rather than skipping. SKIP_SIDECAR=1 is the way out when
// that is genuinely wanted.
//
// Two copies of the binary end up on disk, on purpose:
//
//   sidecar/dist/<platform>-<arch>/   kept per target, which is what the CI
//                                     workflow uploads and what somebody
//                                     assembling a release by hand collects
//   sidecar/dist/current/             what electron-builder packages, so the
//                                     packaging config needs no macros and
//                                     cannot pick the wrong one
//
// Each release job runs on its own operating system, so "current" is never
// ambiguous: the Windows job builds the Windows binary, and so on. That is
// also how a release ends up with all of them without anybody cross-compiling.
import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CRATE = path.join(ROOT, "sidecar", "quiclime");
const DIST = path.join(ROOT, "sidecar", "dist");

// node's names for a platform and a chip, and Rust's name for the pair.
const TARGETS = {
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
};
const exeName = (platform) => (platform === "win32" ? "quiclime.exe" : "quiclime");

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const host = `${process.platform}-${process.arch}`;

if (process.env.SKIP_SIDECAR === "1") {
  console.log("[sidecar] SKIP_SIDECAR=1 — not building it.");
  console.log("[sidecar] The launcher will fall back to its own relay for sharing.");
  process.exit(0);
}

function have(command) {
  const r = spawnSync(command, ["--version"], { stdio: "ignore", shell: process.platform === "win32" });
  return !r.error && r.status === 0;
}

if (!have("cargo")) {
  console.error("");
  console.error("[sidecar] cargo was not found, so the e4mc helper cannot be built.");
  console.error("[sidecar] Install Rust from https://rustup.rs and run this again.");
  console.error("[sidecar] Or set SKIP_SIDECAR=1 to build the launcher without it --");
  console.error("[sidecar] sharing a world then uses our own relay instead of e4mc's.");
  console.error("");
  process.exit(1);
}

/** Make sure rustup has the target installed. Best-effort: cargo says so if not. */
function addTarget(triple) {
  if (!have("rustup")) return;
  try {
    const installed = execFileSync("rustup", ["target", "list", "--installed"], { encoding: "utf8" });
    if (installed.split(/\r?\n/).includes(triple)) return;
    console.log(`[sidecar] adding the ${triple} target`);
    execFileSync("rustup", ["target", "add", triple], { stdio: "inherit" });
  } catch { /* cargo will say if it is missing */ }
}

/**
 * Build one target. Returns where the binary ended up, or throws.
 *
 * The host target is built WITHOUT --target, because cargo then puts it in
 * target/release -- which is exactly where backend/e4mc.js looks when the
 * launcher is run from a checkout. So `npm run sidecar` leaves a developer
 * able to use e4mc immediately, with no packaging step.
 */
function build(key) {
  const triple = TARGETS[key];
  if (!triple) throw new Error(`no Rust target is known for ${key}`);
  const [platform] = key.split("-");
  const isHost = key === host;
  if (!isHost) addTarget(triple);

  console.log(`[sidecar] building ${key} (${triple})`);
  execFileSync("cargo", isHost
    ? ["build", "--release"]
    : ["build", "--release", "--target", triple],
    { cwd: CRATE, stdio: "inherit" });

  const built = isHost
    ? path.join(CRATE, "target", "release", exeName(platform))
    : path.join(CRATE, "target", triple, "release", exeName(platform));
  if (!fs.existsSync(built)) throw new Error(`cargo said it built ${key} but ${built} is not there`);

  const into = path.join(DIST, key);
  fs.mkdirSync(into, { recursive: true });
  const at = path.join(into, exeName(platform));
  fs.copyFileSync(built, at);
  if (platform !== "win32") { try { fs.chmodSync(at, 0o755); } catch { /* ignore */ } }
  return at;
}

/** The copy electron-builder packages. */
function makeCurrent(from, platform) {
  const dir = path.join(DIST, "current");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const at = path.join(dir, exeName(platform));
  fs.copyFileSync(from, at);
  if (platform !== "win32") { try { fs.chmodSync(at, 0o755); } catch { /* ignore */ } }
  return at;
}

// Which targets to do.
let wanted;
if (has("--all")) {
  wanted = Object.keys(TARGETS);
} else if (has("--mac-both")) {
  wanted = ["darwin-arm64", "darwin-x64"];
} else {
  const only = (args.find(a => a.startsWith("--target=")) || "").slice(9);
  wanted = [only || host];
}

if (!TARGETS[wanted[0]] && !has("--all")) {
  console.error(`[sidecar] ${wanted[0]} is not a target this knows about.`);
  console.error(`[sidecar] Known: ${Object.keys(TARGETS).join(", ")}`);
  process.exit(1);
}

const done = [];
const failed = [];
for (const key of wanted) {
  try {
    const at = build(key);
    done.push(key);
    // The one being packaged is the one for this machine, which on a release
    // job is the platform that job is for.
    if (key === host || wanted.length === 1) makeCurrent(at, key.split("-")[0]);
  } catch (e) {
    failed.push({ key, why: String(e && e.message || e).split("\n")[0] });
  }
}

console.log("");
if (done.length) console.log(`[sidecar] built: ${done.join(", ")}`);
for (const f of failed) console.log(`[sidecar] could not build ${f.key}: ${f.why}`);

// Asking for everything on one machine is expected to miss most of them --
// there is no Windows linker on a Mac. Asking for ONE and not getting it is a
// failure.
if (has("--all")) {
  if (!done.length) {
    console.error("[sidecar] nothing built at all.");
    process.exit(1);
  }
  console.log("[sidecar] The ones that failed need the platform they are for,");
  console.log("[sidecar] or a cross-linker. The release workflow builds each");
  console.log("[sidecar] on its own runner, which is why it needs neither.");
  process.exit(0);
}

if (failed.length) process.exit(1);
console.log(`[sidecar] packaged copy: sidecar/dist/current/${exeName(process.platform)}`);
