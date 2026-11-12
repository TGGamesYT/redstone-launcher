// Git, for a mod project that came out of one.
//
// A dev instance is a folder somebody is working in, and nine times out of
// ten that folder is a clone. Being able to pull, change branch or go back
// to a commit without leaving the launcher is the difference between the
// dev instance being somewhere you test a mod and somewhere you work on
// one. Everything here is about a repository that is ALREADY somebody's
// working copy, so nothing destructive lives in this file: no reset --hard,
// no clean, no force push, no commit. Changing which commit is checked out
// is as far as it goes, and git itself refuses that when there is work that
// would be lost.
//
// ── which git ──
//
// The one on the PATH, first and by preference: it is the one the person
// already uses, with their identity, their SSH keys and their credential
// helper. Failing that, a copy the launcher fetched for itself, which on
// Windows is MinGit -- the portable build git-for-windows publishes for
// exactly this. There is no portable Git worth shipping for Linux or macOS
// and both have one a package manager away, so there the answer is to say
// so rather than to download something.
//
// ── credentials ──
//
// Where the system git has a credential helper set up, nothing here needs
// to know anything: git asks it and the fetch works. Where it does not --
// a private repository on a machine that has never pushed to one -- the
// launcher can hold a GitHub token.
//
// The token never goes on a command line. argv is world-readable on every
// platform this runs on, so a token in `git -c http.extraHeader=...` is a
// token in `ps`. It goes in the environment instead, through the
// GIT_CONFIG_COUNT/KEY/VALUE variables git has had since 2.31, which is the
// same way GitHub's own Actions runner does it.
//
// And `GIT_TERMINAL_PROMPT=0` on every call without exception: a git that
// cannot authenticate must fail and say so. Without it, a private clone
// stops dead waiting for a username to be typed into a terminal that does
// not exist, and the launcher waits with it, for ever.
import fs from "fs";
import path from "path";
import os from "os";
import https from "https";
import { spawn } from "child_process";

const WIN = process.platform === "win32";

/** Every git this computer has, in the order they are preferred. */
export function gitOnPath() {
  const names = WIN ? ["git.exe", "git.cmd", "git.bat"] : ["git"];
  for (const dir of String(process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const at = path.join(dir, name);
      try { if (fs.existsSync(at) && fs.statSync(at).isFile()) return at; } catch { /* unreadable */ }
    }
  }
  return null;
}

/** Where the launcher keeps a git of its own, if it has fetched one. */
export function ownGitPath(dataDir) {
  if (!dataDir) return null;
  const home = path.join(dataDir, "git");
  for (const rel of [["cmd", "git.exe"], ["bin", "git.exe"], ["bin", "git"]]) {
    const at = path.join(home, ...rel);
    try { if (fs.existsSync(at)) return at; } catch { /* unreadable */ }
  }
  return null;
}

/**
 * The git to run, and where it came from.
 *
 * `own` before `path` is never right: the one on the PATH is the person's
 * own, set up with their keys and their name on their commits, and a copy
 * the launcher fetched knows none of that.
 */
export function whichGit(dataDir) {
  const onPath = gitOnPath();
  if (onPath) return { bin: onPath, how: "system" };
  const own = ownGitPath(dataDir);
  if (own) return { bin: own, how: "own" };
  return { bin: null, how: null };
}

// ── running it ────────────────────────────────────────────────────────────

/** The environment a git call runs in: no prompts, and the token if there is one. */
function gitEnv(token, url) {
  const env = { ...process.env };
  // Never stop and wait for a terminal that does not exist. Both of these,
  // because git asks in two different ways depending on the transport.
  env.GIT_TERMINAL_PROMPT = "0";
  env.GCM_INTERACTIVE = "never";
  // An askpass inherited from a desktop session can pop a dialog box behind
  // the launcher and hang just as thoroughly as a terminal prompt.
  delete env.GIT_ASKPASS;
  delete env.SSH_ASKPASS;
  env.GIT_SSH_COMMAND = (env.GIT_SSH_COMMAND || "ssh") + " -o BatchMode=yes";
  if (!token) return env;
  // The token, out of argv. `x-access-token` is the username GitHub expects
  // for a token over HTTPS.
  const auth = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
  // Scoped to the host it is for, so a repository somewhere else never sees
  // a GitHub token. Everything this offers to sign in to is GitHub, so an
  // unknown host simply gets no header rather than the wrong one.
  const host = hostOf(url) === "github.com" ? "https://github.com/" : null;
  if (!host) return env;
  env.GIT_CONFIG_COUNT = "1";
  env.GIT_CONFIG_KEY_0 = `http.${host}.extraheader`;
  env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${auth}`;
  return env;
}

export function hostOf(url) {
  try { return new URL(String(url)).hostname.toLowerCase(); } catch { return null; }
}

/**
 * Run git once.
 *
 * Resolves with { ok, code, out, err } rather than throwing: "git said no"
 * is an answer to show somebody, not an exception. The output is kept
 * whole -- a git error is written for a person to read and the tab shows it
 * as git wrote it.
 */
export function run(bin, args, opts = {}) {
  const { cwd = null, token = null, url = null, onLine = null, timeout = 120000 } = opts;
  return new Promise((resolve) => {
    if (!bin) return resolve({ ok: false, code: -1, out: "", err: "There is no Git on this computer." });
    let child;
    try {
      child = spawn(bin, args, {
        cwd: cwd || undefined,
        env: gitEnv(token, url),
        windowsHide: true,
        shell: false,
      });
    } catch (e) {
      return resolve({ ok: false, code: -1, out: "", err: String(e && e.message || e) });
    }
    let out = "", err = "", done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, out, err });
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      err += "\nIt took too long and was stopped.";
      finish(-1);
    }, timeout);
    // Progress goes to stderr, which is also where errors go, so both are
    // passed on as they arrive and sorted out by whoever is reading.
    const feed = (where) => (buf) => {
      const s = buf.toString();
      if (where === "out") out += s; else err += s;
      if (onLine) for (const line of s.split(/\r?\n|\r/)) if (line.trim()) { try { onLine(line); } catch { /* the page went away */ } }
    };
    child.stdout.on("data", feed("out"));
    child.stderr.on("data", feed("err"));
    child.on("error", (e) => { err += String(e && e.message || e); finish(-1); });
    child.on("close", finish);
  });
}

// ── reading a repository ──────────────────────────────────────────────────

/** Is this folder inside a git repository, and where is its top? */
export async function topLevel(bin, dir) {
  if (!dir) return null;
  const r = await run(bin, ["rev-parse", "--show-toplevel"], { cwd: dir, timeout: 15000 });
  if (!r.ok) return null;
  const top = r.out.trim();
  return top ? path.resolve(top) : null;
}

const firstLine = (s) => String(s || "").split(/\r?\n/)[0].trim();

/**
 * Everything the Git tab shows about a repository, in one go.
 *
 * One function rather than a handler per fact, because the tab needs all of
 * it at once and a dozen separate spawns to draw one panel is a visible
 * stutter on a cold disk.
 */
export async function info(bin, dir, { commits = 15 } = {}) {
  const top = await topLevel(bin, dir);
  if (!top) return { repo: false };

  const at = (args, timeout = 20000) => run(bin, args, { cwd: top, timeout });
  const [branchR, headR, statusR, remotesR, upstreamR, logR, tagR] = await Promise.all([
    at(["rev-parse", "--abbrev-ref", "HEAD"]),
    at(["log", "-1", "--pretty=%H%x1f%h%x1f%s%x1f%an%x1f%aI"]),
    at(["status", "--porcelain"]),
    at(["remote", "-v"]),
    at(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]),
    at(["log", "-" + Math.max(1, Math.min(100, commits)), "--pretty=%H%x1f%h%x1f%s%x1f%an%x1f%aI"]),
    at(["describe", "--tags", "--exact-match"]),
  ]);

  const parseCommits = (text) => String(text || "").split(/\r?\n/).filter(Boolean).map((line) => {
    const [hash, short, subject, author, when] = line.split("\x1f");
    return { hash, short, subject, author, when };
  });

  const branch = firstLine(branchR.out);
  // "HEAD" from rev-parse means a detached head: sitting on a commit rather
  // than on a branch, which is exactly what "switch to a specific commit"
  // leaves you in, so it is a state to SHOW rather than an error.
  const detached = branch === "HEAD" || !branch;
  const upstream = upstreamR.ok ? firstLine(upstreamR.out) : null;

  let ahead = 0, behind = 0;
  if (upstream) {
    const c = await at(["rev-list", "--left-right", "--count", `${upstream}...HEAD`]);
    if (c.ok) {
      const [b, a] = firstLine(c.out).split(/\s+/).map(Number);
      behind = Number.isFinite(b) ? b : 0;
      ahead = Number.isFinite(a) ? a : 0;
    }
  }

  const remotes = {};
  for (const line of String(remotesR.out || "").split(/\r?\n/)) {
    const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim());
    if (!m) continue;
    remotes[m[1]] = remotes[m[1]] || {};
    remotes[m[1]][m[3]] = m[2];
  }

  // Changed files, as a count and as a short list: "you have 3 changes" is
  // the part that decides whether changing branch is going to work, and
  // naming them is what makes it actionable.
  const changes = String(statusR.out || "").split(/\r?\n/).filter(Boolean)
    .map(l => ({ state: l.slice(0, 2).trim() || "?", file: l.slice(3) }));

  return {
    repo: true,
    dir: top,
    branch: detached ? null : branch,
    detached,
    tag: tagR.ok ? firstLine(tagR.out) : null,
    head: parseCommits(headR.out)[0] || null,
    upstream, ahead, behind,
    remotes,
    changes: changes.slice(0, 40),
    changeCount: changes.length,
    commits: parseCommits(logR.out),
  };
}

/** Local branches, and the remote ones with no local branch of their own. */
export async function branches(bin, dir) {
  const local = await run(bin, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)%09%(upstream:short)", "refs/heads"], { cwd: dir });
  // `%(symref)` is empty for a real branch and set for a pointer to one.
  // Asked for, because the obvious filter does not work: a remote's default
  // pointer is `refs/remotes/origin/HEAD`, and git shortens that to plain
  // "origin" -- so skipping names ending in /HEAD let it through, and the
  // list offered a branch called "origin" that is not a branch.
  const remote = await run(bin, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)%09%(symref)", "refs/remotes"], { cwd: dir });
  const mine = [], theirs = [];
  for (const line of String(local.out || "").split(/\r?\n/).filter(Boolean)) {
    const [name, up] = line.split("\t");
    mine.push({ name, upstream: up || null });
  }
  const have = new Set(mine.map(b => b.name));
  for (const line of String(remote.out || "").split(/\r?\n/).filter(Boolean)) {
    const [name, symref] = line.split("\t");
    if (symref) continue;                      // the remote's default, not a branch
    if (/\/HEAD$/.test(name) || !name.includes("/")) continue;
    // "origin/thing" -> "thing", which is the branch checking it out makes.
    const bare = name.replace(/^[^/]+\//, "");
    if (have.has(bare)) continue;
    theirs.push({ name, makes: bare });
  }
  return { local: mine, remote: theirs };
}

// ── changing what is checked out ──────────────────────────────────────────

/**
 * Check something out: a branch, a remote branch, a tag or a commit.
 *
 * A remote branch is checked out as a local one tracking it, because
 * checking out `origin/thing` by name leaves a detached head that silently
 * loses anything committed on it. `--` so a ref that looks like an option,
 * or shares a name with a file, cannot be read as one.
 */
export async function checkout(bin, dir, ref, opts = {}) {
  const want = String(ref || "").trim();
  if (!want) return { ok: false, err: "Nothing to check out" };
  const remote = /^([^/\s]+)\/(.+)$/.exec(want);
  const args = ["checkout"];
  if (opts.asBranch && remote) args.push("-B", remote[2], "--track");
  args.push(want, "--");
  return run(bin, args, { cwd: dir, timeout: 120000, ...opts });
}

export async function fetchAll(bin, dir, opts = {}) {
  return run(bin, ["fetch", "--all", "--prune", "--tags"], { cwd: dir, timeout: 180000, ...opts });
}

/**
 * Pull, without ever rewriting what is already there.
 *
 * `--ff-only`: a pull that cannot fast-forward wants a merge or a rebase,
 * and both of those are decisions about somebody's work that a launcher has
 * no business taking on their behalf. It says what happened and leaves it
 * to them.
 */
export async function pull(bin, dir, opts = {}) {
  return run(bin, ["pull", "--ff-only"], { cwd: dir, timeout: 180000, ...opts });
}

export async function setRemote(bin, dir, name, url, opts = {}) {
  const who = String(name || "origin").trim();
  const where = String(url || "").trim();
  if (!/^[\w.-]+$/.test(who)) return { ok: false, err: "That is not a remote's name" };
  if (!where) return { ok: false, err: "Give it a URL" };
  // Only what git itself can fetch from, and nothing that could be read as
  // an option or as a local command: `ext::` runs a program.
  if (!/^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/.test(where)) {
    return { ok: false, err: "A remote is an https:// or ssh URL" };
  }
  const have = await run(bin, ["remote"], { cwd: dir });
  const known = String(have.out || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const args = known.includes(who) ? ["remote", "set-url", who, where] : ["remote", "add", who, where];
  return run(bin, args, { cwd: dir, ...opts });
}

// ── cloning ───────────────────────────────────────────────────────────────

/** Is this something git could clone, and what would the folder be called? */
export function readCloneUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return { ok: false, error: "Paste the repository's address" };
  // A plain "owner/name" is how everybody writes a GitHub repository.
  const short = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(raw);
  if (short && !/^[a-z]+:/.test(raw)) {
    return { ok: true, url: `https://github.com/${short[1]}/${short[2]}.git`, name: short[2], host: "github.com" };
  }
  const ssh = /^git@([\w.-]+):([\w.\-/]+?)(?:\.git)?$/.exec(raw);
  if (ssh) {
    return { ok: true, url: raw, name: ssh[2].split("/").pop(), host: ssh[1].toLowerCase() };
  }
  let u;
  try { u = new URL(raw); } catch { return { ok: false, error: "That is not a repository address" }; }
  if (!["https:", "http:", "ssh:", "git:"].includes(u.protocol)) {
    return { ok: false, error: "A repository is an https:// or ssh address" };
  }
  const name = u.pathname.replace(/\/+$/, "").split("/").pop().replace(/\.git$/, "");
  if (!name) return { ok: false, error: "That address has no repository in it" };
  return { ok: true, url: u.toString(), name, host: u.hostname.toLowerCase() };
}

/**
 * Clone into a folder that does not exist yet.
 *
 * Into `<parent>/<name>`, and never into a folder that already has anything
 * in it: a clone that lands on top of somebody's work is not recoverable by
 * pressing undo.
 */
export async function clone(bin, url, parent, opts = {}) {
  const read = readCloneUrl(url);
  if (!read.ok) return { ok: false, err: read.error };
  const dest = path.join(parent, opts.name || read.name);
  try {
    if (fs.existsSync(dest) && fs.readdirSync(dest).length) {
      return { ok: false, err: `There is already something in ${dest}`, dest };
    }
  } catch { /* it does not exist, which is what we want */ }
  const args = ["clone", "--progress"];
  if (opts.branch) args.push("--branch", String(opts.branch));
  // Depth is a choice the caller makes: a mod project somebody is going to
  // work in wants its history, and one they only want to build does not.
  if (opts.depth) args.push("--depth", String(Math.max(1, Number(opts.depth) | 0)));
  args.push("--", read.url, dest);
  const r = await run(bin, args, { timeout: 900000, url: read.url, ...opts });
  return { ...r, dest, url: read.url, host: read.host };
}

// ── a git of the launcher's own ───────────────────────────────────────────

/**
 * Where to get a portable git, asked of git-for-windows rather than pinned.
 *
 * A hard-coded URL is a version that goes stale and a download that starts
 * 404ing some months after it is written. The release list says what the
 * current MinGit is, and MinGit is the build made for being dropped in a
 * folder -- no installer, no registry, nothing outside the folder it is in.
 */
export function minGitAsset(release) {
  const assets = (release && release.assets) || [];
  const bits = process.arch === "arm64" ? "arm64" : (process.arch === "x64" ? "64-bit" : "32-bit");
  const want = assets.filter(a => /^MinGit-/.test(a.name) && a.name.endsWith(".zip") && !/busybox/i.test(a.name));
  return want.find(a => a.name.includes(bits)) || want.find(a => a.name.includes("64-bit")) || null;
}

/** The latest MinGit release, as GitHub describes it. */
export function latestMinGit() {
  return new Promise((resolve) => {
    const req = https.get("https://api.github.com/repos/git-for-windows/git/releases/latest", {
      headers: {
        // GitHub refuses a request with no user agent. A generic one: whose
        // launcher it is is nobody's business but theirs.
        "User-Agent": "minecraft-launcher",
        Accept: "application/vnd.github+json",
      },
      timeout: 30000,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

/** What to tell somebody with no git, which is not the same answer everywhere. */
export function noGitAdvice() {
  if (WIN) return { canFetch: true, say: "The launcher can fetch a small copy of Git for itself." };
  if (process.platform === "darwin") {
    return { canFetch: false, say: "Install Git first — `xcode-select --install` in a terminal is the quickest way." };
  }
  return { canFetch: false, say: "Install Git with your package manager — `sudo apt install git`, or whatever yours is." };
}

export default {
  gitOnPath, ownGitPath, whichGit, run, topLevel, info, branches,
  checkout, fetchAll, pull, setRemote, clone, readCloneUrl,
  minGitAsset, latestMinGit, noGitAdvice, hostOf,
};
