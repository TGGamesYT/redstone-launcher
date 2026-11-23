// Signing in to GitHub, through a GitHub CLI of the launcher's own.
//
// `gh auth login --web` is the OAuth "device flow": a short code shown in the
// launcher, typed in at github.com/login/device, and approved there. No
// password goes anywhere near the launcher and no browser is embedded in it.
//
// The sign-in is the LAUNCHER'S. gh is run with a config folder of the
// launcher's own (GH_CONFIG_DIR) and told to keep the token in that folder
// rather than in the system keyring, which a gh installed on the computer
// shares -- so signing in here neither changes nor is changed by a gh you use
// in a terminal. And Git is not told about it (no `gh auth setup-git`, which
// rewrote the computer's global Git settings): the launcher hands the token to
// its own Git requests itself, and nothing else on the computer sees it.
//
// If there is no gh at all, the launcher fetches one of its own from GitHub
// CLI's releases, the way it fetches its own Git on Windows.
//
// There is no OAuth app of the launcher's own, and gh's client id is not
// borrowed for one: GitHub would then show "GitHub CLI wants access" for a
// request that is not from GitHub CLI.
import { spawn } from "child_process";
import fs from "fs";
import path from "path";

let DATA_DIR = null;
/** Where the launcher keeps its gh and gh's sign-in. Set once by main.js. */
export function configure({ dataDir }) { DATA_DIR = dataDir || null; }
export const ownGhDir = () => (DATA_DIR ? path.join(DATA_DIR, "gh") : null);
export const ghConfigDir = () => (DATA_DIR ? path.join(DATA_DIR, "gh-config") : null);

const EXE = process.platform === "win32" ? "gh.exe" : "gh";

/** gh's executable somewhere under `dir`, as its archives lay it out. */
export function ghExeIn(dir) {
  if (!dir) return null;
  const stack = [dir];
  for (let i = 0; i < 4000 && stack.length; i++) {
    const d = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const at = path.join(d, e.name);
      if (e.isDirectory()) stack.push(at);
      else if (e.name === EXE && path.basename(path.dirname(at)) === "bin") return at;
    }
  }
  return null;
}

/** The launcher's own gh, if it has fetched one. */
export function ownGh() { return ghExeIn(ownGhDir()); }

/** A gh installed on the computer, if there is one. */
export function ghOnPath() {
  const names = process.platform === "win32" ? ["gh.exe", "gh.cmd"] : ["gh"];
  for (const dir of String(process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const n of names) {
      const at = path.join(dir, n);
      try { if (fs.existsSync(at) && fs.statSync(at).isFile()) return at; } catch { /* unreadable */ }
    }
  }
  if (process.platform === "win32") {
    for (const at of [
      path.join(process.env.ProgramFiles || "C:\\Program Files", "GitHub CLI", "gh.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Programs", "GitHub CLI", "gh.exe"),
    ]) { try { if (fs.existsSync(at)) return at; } catch { /* keep looking */ } }
  }
  return null;
}

/**
 * The gh to run: the launcher's own, else one on the computer. Either way it
 * is run with the launcher's config folder, so the sign-in is the
 * launcher's and not the computer's.
 */
export function ghBin() { return ownGh() || ghOnPath(); }

/**
 * Which file of a GitHub CLI release is for this computer.
 * `release` is the GitHub API's answer for cli/cli's latest release.
 */
export function ghAsset(release, platform = process.platform, arch = process.arch) {
  const assets = (release && Array.isArray(release.assets)) ? release.assets : [];
  const cpu = arch === "arm64" ? "arm64" : arch === "ia32" ? "386" : "amd64";
  const want = platform === "win32" ? new RegExp(`_windows_${cpu}\\.zip$`)
    : platform === "darwin" ? /_macOS_(universal|amd64|arm64)\.zip$/
      : new RegExp(`_linux_${cpu}\\.tar\\.gz$`);
  // On a Mac, universal first, then the one for this processor.
  const ranked = platform === "darwin"
    ? [/_macOS_universal\.zip$/, new RegExp(`_macOS_${cpu}\\.zip$`)]
    : [want];
  for (const re of ranked) {
    const hit = assets.find(a => a && re.test(String(a.name || "")));
    if (hit) return hit;
  }
  return null;
}

const run = (bin, args, { input = null, onText = null, timeout = 15 * 60 * 1000, system = false } = {}) => new Promise((resolve) => {
  let child;
  const env = { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1", GH_NO_UPDATE_NOTIFIER: "1" };
  // `system` runs gh as the computer's own, with its own config -- only ever
  // to READ its sign-in, once, so the launcher can start from it.
  const cfg = system ? null : ghConfigDir();
  if (cfg) {
    try { fs.mkdirSync(cfg, { recursive: true }); } catch { /* gh makes it itself */ }
    env.GH_CONFIG_DIR = cfg;
    // A token in the environment would be used instead of the sign-in, and
    // be somebody else's; this is the launcher's own sign-in.
    delete env.GH_TOKEN; delete env.GITHUB_TOKEN;
  }
  try {
    child = spawn(bin, args, { windowsHide: true, shell: false, env });
  } catch (e) { return resolve({ ok: false, out: "", err: String(e.message || e) }); }
  let out = "", err = "";
  const timer = setTimeout(() => { try { child.kill(); } catch { } }, timeout);
  child.stdout.on("data", (d) => { const t = d.toString(); out += t; if (onText) onText(t); });
  child.stderr.on("data", (d) => { const t = d.toString(); err += t; if (onText) onText(t); });
  child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, out, err: err + String(e.message || e) }); });
  child.on("close", (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, out, err }); });
  if (input != null) { try { child.stdin.write(input); child.stdin.end(); } catch { /* it did not want any */ } }
  return child;
});

/** "! First copy your one-time code: ABCD-1234" -> "ABCD-1234" */
export function codeFromGhOutput(text) {
  const m = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i.exec(String(text || ""));
  return m ? m[1].toUpperCase() : null;
}

/**
 * The account `gh auth status` says is signed in to github.com, or null.
 *
 * gh 2.40 and later print "Logged in to github.com account NAME (keyring)",
 * one line per account, with "Active account: true" under the one in use;
 * older ones print "Logged in to github.com as NAME (oauth_token)".
 */
export function loginFromGhStatus(text) {
  const lines = String(text || "").split(/\r?\n/);
  const accounts = [];
  for (const line of lines) {
    const m = /Logged in to \S+ (?:account|as) ([A-Za-z0-9-]+)/.exec(line);
    if (m) { accounts.push({ login: m[1], active: false }); continue; }
    if (accounts.length && /Active account:\s*true/i.test(line)) accounts[accounts.length - 1].active = true;
  }
  const pick = accounts.find(a => a.active) || accounts[0];
  return pick ? pick.login : null;
}

/**
 * The computer's gh sign-in, taken over once.
 *
 * Somebody already signed in to GitHub CLI should not have to sign in again
 * for the launcher. So the first time the launcher looks, if its own sign-in
 * is empty and the computer's gh is signed in, that token is read and the
 * launcher's own copy is signed in with it. Once only: signing the launcher
 * out afterwards is not undone by it quietly coming back. The computer's gh
 * is only read, never changed.
 */
export async function adoptSystemSignIn() {
  const cfg = ghConfigDir();
  if (!cfg) return { adopted: false };
  const marker = path.join(cfg, ".adopted-system-sign-in");
  try { if (fs.existsSync(marker)) return { adopted: false }; } catch { /* look below */ }
  const mark = () => { try { fs.mkdirSync(cfg, { recursive: true }); fs.writeFileSync(marker, new Date().toISOString()); } catch { /* next time, then */ } };
  const system = ghOnPath();
  const mine = ghBin();
  if (!system || !mine) return { adopted: false };      // not settled: there may be a gh later
  const own = await run(mine, ["auth", "status", "--hostname", "github.com"], { timeout: 20000 });
  if (own.ok) { mark(); return { adopted: false }; }    // already signed in here
  const tok = await run(system, ["auth", "token", "--hostname", "github.com"], { timeout: 20000, system: true });
  const token = tok.ok ? String(tok.out || "").trim() : "";
  if (!token) { mark(); return { adopted: false }; }
  const r = await run(mine, ["auth", "login", "--hostname", "github.com", "--git-protocol", "https",
    "--with-token", "--insecure-storage"], { input: token + "\n", timeout: 30000 });
  mark();
  return { adopted: r.ok, token: r.ok ? token : null };
}

/** Whether the launcher has a gh, and who the LAUNCHER is signed in as. */
export async function ghAccount() {
  const gh = ghBin();
  if (!gh) return { gh: false, own: false, login: null };
  try { await adoptSystemSignIn(); } catch { /* signed out, then */ }
  // gh writes the status to stderr, and exits non-zero when signed out.
  const r = await run(gh, ["auth", "status", "--hostname", "github.com"], { timeout: 20000 });
  return { gh: true, own: gh === ownGh(), login: r.ok ? loginFromGhStatus(r.out + "\n" + r.err) : null };
}

/**
 * Sign the launcher in through GitHub CLI.
 *
 * `onCode({ code, url })` is called as soon as gh prints the code, so the
 * launcher can show it while gh waits for it to be entered.
 */
export async function signInWithGh({ onCode, openUrl } = {}) {
  const gh = ghBin();
  if (!gh) return { ok: false, error: "GitHub CLI is not here yet." };
  try { await adoptSystemSignIn(); } catch { /* the sign-in below, then */ }
  const status = await run(gh, ["auth", "status", "--hostname", "github.com"], { timeout: 20000 });
  let login = status.ok ? loginFromGhStatus(status.out + "\n" + status.err) : null;
  if (!status.ok) {
    let told = false;
    const r = await run(gh, ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web",
      "--scopes", "repo", "--insecure-storage"], {
      // gh asks for Enter before it opens the browser; it is given one, and
      // the launcher opens the page itself so it is the launcher's window
      // that says what is happening.
      input: "\n",
      onText: (t) => {
        if (told) return;
        const code = codeFromGhOutput(t);
        if (!code) return;
        told = true;
        const url = "https://github.com/login/device";
        if (onCode) onCode({ code, url });
        if (openUrl) { try { openUrl(url); } catch { /* they can click it */ } }
      },
    });
    if (!r.ok) return { ok: false, error: (r.err || r.out || "GitHub CLI could not sign in").trim().split("\n").slice(-2).join(" ") };
  }
  const tok = await run(gh, ["auth", "token", "--hostname", "github.com"], { timeout: 20000 });
  const token = tok.ok ? tok.out.trim() : null;
  if (!login) login = (await ghAccount()).login;
  return { ok: true, via: "gh", token, login, gitHelper: false };
}

/** Sign the launcher out of GitHub. The computer's own gh is not touched. */
export async function signOutOfGh() {
  const gh = ghBin();
  if (!gh) return { ok: true };
  const r = await run(gh, ["auth", "logout", "--hostname", "github.com"], { input: "y\n", timeout: 20000 });
  return { ok: r.ok || /not logged in/i.test(r.err + r.out) };
}

export default {
  configure, ownGhDir, ghConfigDir, ghExeIn, ownGh, ghOnPath, ghBin, ghAsset,
  ghAccount, adoptSystemSignIn, loginFromGhStatus, signInWithGh, signOutOfGh, codeFromGhOutput,
};
