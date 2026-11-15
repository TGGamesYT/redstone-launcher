// Signing in to GitHub, the way `gh auth login` does it.
//
// That is the OAuth "device flow": the launcher asks GitHub for a short code,
// shows it, sends you to github.com/login/device to type it in, and waits.
// No password goes anywhere near the launcher and no browser has to be
// embedded in it.
//
// Two ways to do it, used in this order:
//
//   1. The launcher's own OAuth app, if one is registered (GITHUB_CLIENT_ID
//      below). This is the device flow done directly. Registering an OAuth
//      app is free and takes a couple of minutes -- see the note at the
//      constant. Until one is, this way is simply not offered.
//
//   2. GitHub CLI, if `gh` is installed: `gh auth login --web` runs the very
//      same flow with gh's own app, and `gh auth setup-git` then makes the
//      system Git use gh for its credentials -- so every clone, fetch and
//      pull works afterwards, from the launcher or from a terminal, with
//      nothing stored by the launcher at all except a copy of the token for
//      its own GitHub API calls (the credits).
//
// Deliberately NOT done: borrowing gh's client id for a device flow of our
// own. It is public, and it would work, and it would also mean GitHub showing
// "GitHub CLI wants access" for a request that is not from GitHub CLI.
import { spawn } from "child_process";
import fs from "fs";
import path from "path";

/**
 * The launcher's own GitHub OAuth app.
 *
 * To fill it in: github.com -> Settings -> Developer settings -> OAuth Apps ->
 * New OAuth App. Any name, homepage https://redstone-launcher.com, callback
 * URL the same (it is not used by the device flow). Then tick "Enable Device
 * Flow", save, and paste the Client ID here. There is no client SECRET in the
 * device flow, so nothing secret goes in the launcher.
 */
export const GITHUB_CLIENT_ID = "";
export const SCOPES = "repo read:user";

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

export function methods() {
  return { native: !!GITHUB_CLIENT_ID, gh: ghOnPath() ? true : false };
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
  return { ok: true, via: "gh", token, gitHelper: true };
}

/**
 * The device flow, with the launcher's own OAuth app.
 *
 * https://docs.github.com/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow
 */
export async function signInDeviceFlow({ onCode, openUrl, fetchImpl = fetch, sleep = (ms) => new Promise(r => setTimeout(r, ms)) } = {}) {
  if (!GITHUB_CLIENT_ID) return { ok: false, error: "No GitHub app is set up for the launcher." };
  const form = (o) => new URLSearchParams(o).toString();
  const headers = { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "redstone-launcher" };
  let start;
  try {
    const r = await fetchImpl("https://github.com/login/device/code", { method: "POST", headers, body: form({ client_id: GITHUB_CLIENT_ID, scope: SCOPES }) });
    start = await r.json();
  } catch (e) { return { ok: false, error: "GitHub could not be reached: " + (e.message || e) }; }
  if (!start || !start.device_code) return { ok: false, error: (start && (start.error_description || start.error)) || "GitHub did not give a code" };
  if (onCode) onCode({ code: start.user_code, url: start.verification_uri });
  if (openUrl) { try { openUrl(start.verification_uri); } catch { } }
  let interval = Math.max(5, Number(start.interval) || 5) * 1000;
  const until = Date.now() + (Number(start.expires_in) || 900) * 1000;
  while (Date.now() < until) {
    await sleep(interval);
    let r;
    try {
      const res = await fetchImpl("https://github.com/login/oauth/access_token", {
        method: "POST", headers,
        body: form({ client_id: GITHUB_CLIENT_ID, device_code: start.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
      });
      r = await res.json();
    } catch { continue; }
    if (r.access_token) return { ok: true, via: "device", token: r.access_token, gitHelper: false };
    if (r.error === "authorization_pending") continue;
    if (r.error === "slow_down") { interval += 5000; continue; }
    return { ok: false, error: r.error_description || r.error || "GitHub said no" };
  }
  return { ok: false, error: "The code ran out before it was entered." };
}

export default { GITHUB_CLIENT_ID, methods, ghOnPath, signInWithGh, signInDeviceFlow, codeFromGhOutput };
