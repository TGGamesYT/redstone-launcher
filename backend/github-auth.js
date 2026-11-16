// Signing in to GitHub, through GitHub CLI.
//
// `gh auth login --web` is the OAuth "device flow": a short code shown in the
// launcher, typed in at github.com/login/device, and approved there. No
// password goes anywhere near the launcher and no browser is embedded in it.
// `gh auth setup-git` then makes the system Git use gh for its credentials, so
// every clone, fetch and pull works afterwards, from the launcher or from a
// terminal. The launcher keeps only a copy of the token for its own GitHub API
// calls (the credits).
//
// There is no OAuth app of the launcher's own, and gh's client id is not
// borrowed for one: GitHub would then show "GitHub CLI wants access" for a
// request that is not from GitHub CLI.
import { spawn } from "child_process";
import fs from "fs";
import path from "path";

export function ghOnPath() {
  const names = process.platform === "win32" ? ["gh.exe", "gh.cmd"] : ["gh"];
  for (const dir of String(process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const n of names) {
      const at = path.join(dir, n);
      try { if (fs.existsSync(at) && fs.statSync(at).isFile()) return at; } catch { /* unreadable */ }
    }
  }
  // Where the Windows installer puts it, which a launcher started before the
  // PATH was updated does not see.
  if (process.platform === "win32") {
    for (const at of [
      path.join(process.env.ProgramFiles || "C:\\Program Files", "GitHub CLI", "gh.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Programs", "GitHub CLI", "gh.exe"),
    ]) { try { if (fs.existsSync(at)) return at; } catch { /* keep looking */ } }
  }
  return null;
}


const run = (bin, args, { input = null, onText = null, timeout = 15 * 60 * 1000 } = {}) => new Promise((resolve) => {
  let child;
  try {
    child = spawn(bin, args, { windowsHide: true, shell: false, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } });
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

/** Whether gh is here, and who it is signed in to github.com as. */
export async function ghAccount() {
  const gh = ghOnPath();
  if (!gh) return { gh: false, login: null };
  // gh writes the status to stderr, and exits non-zero when signed out.
  const r = await run(gh, ["auth", "status", "--hostname", "github.com"], { timeout: 20000 });
  return { gh: true, login: r.ok ? loginFromGhStatus(r.out + "\n" + r.err) : null };
}

/**
 * Sign in through GitHub CLI.
 *
 * `onCode({ code, url })` is called as soon as gh prints the code, so the
 * launcher can show it while gh waits for it to be entered.
 */
export async function signInWithGh({ onCode, openUrl } = {}) {
  const gh = ghOnPath();
  if (!gh) return { ok: false, error: "GitHub CLI is not installed." };
  // Already signed in: nothing to do but make sure Git uses it.
  const status = await run(gh, ["auth", "status", "--hostname", "github.com"], { timeout: 20000 });
  let login = status.ok ? loginFromGhStatus(status.out + "\n" + status.err) : null;
  if (!status.ok) {
    let told = false;
    const login = await run(gh, ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--scopes", "repo"], {
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
    if (!login.ok) return { ok: false, error: (login.err || login.out || "GitHub CLI could not sign in").trim().split("\n").slice(-2).join(" ") };
  }
  // Git uses gh for github.com from now on, from anywhere.
  await run(gh, ["auth", "setup-git", "--hostname", "github.com"], { timeout: 20000 });
  const tok = await run(gh, ["auth", "token", "--hostname", "github.com"], { timeout: 20000 });
  const token = tok.ok ? tok.out.trim() : null;
  if (!login) login = (await ghAccount()).login;
  return { ok: true, via: "gh", token, login, gitHelper: true };
}

export default { ghOnPath, ghAccount, loginFromGhStatus, signInWithGh, codeFromGhOutput };
