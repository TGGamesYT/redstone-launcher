// Git, for a dev instance whose project folder is a clone.
//
// Run against real repositories made here rather than against a fake git:
// the whole module is about what git actually says back, and a stub would
// agree with whatever this file assumed. Skipped with a word rather than a
// failure where there is no git to run, since that is a fact about the
// computer and not about the launcher.
//
// What is worth checking is in two halves. The parsing -- a URL somebody
// typed, a branch list with git's own shorthands in it, the difference
// between being on a branch and being on a commit -- and the refusals,
// which are the reason this module is allowed near somebody's working copy
// at all: nothing here may run a command that can lose work.
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import git from "../backend/git.js";

/** A file with its comments taken out, so a scan reads the code and not the prose. */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

let bad = 0;
const check = (what, got, want, note) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${note ? "  — " + note : ""}`
    + (ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`));
};

// ── what somebody can type into the box ───────────────────────────────────
{
  const r = git.readCloneUrl;
  check("a full https address",
    [r("https://github.com/someone/their-mod.git").url, r("https://github.com/someone/their-mod.git").name],
    ["https://github.com/someone/their-mod.git", "their-mod"]);
  check("and one without the .git, which is what the address bar gives you",
    r("https://github.com/someone/their-mod").name, "their-mod");
  check("owner/name on its own is GitHub, because that is how everybody writes one",
    r("someone/their-mod").url, "https://github.com/someone/their-mod.git");
  check("an ssh remote is taken as it is",
    [r("git@github.com:someone/their-mod.git").url, r("git@github.com:someone/their-mod.git").name],
    ["git@github.com:someone/their-mod.git", "their-mod"]);
  check("and a GitLab or self-hosted address is fine too",
    [r("https://gitlab.com/g/sub/thing.git").host, r("https://gitlab.com/g/sub/thing.git").name],
    ["gitlab.com", "thing"]);
  check("something that is not an address is refused",
    [r("nonsense").ok, r("").ok], [false, false]);
  // The one that matters: a transport that runs a program rather than
  // fetching anything. `ext::sh -c ...` is a remote that executes.
  check("and so is a remote that would run a program",
    r("ext::sh -c 'touch /tmp/pwned'").ok, false,
    "ext:: is a git transport that executes what it is given");
  check("as is a local file path pretending to be one",
    r("file:///etc").ok, false);
}

// ── the rest needs a git ──────────────────────────────────────────────────
const bin = git.gitOnPath();
if (!bin) {
  console.log("note: there is no git on this computer, so the rest is skipped");
  console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
  process.exit(bad ? 1 : 0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rl-git-"));
const sh = (cwd, ...args) => execFileSync(bin, args, {
  cwd, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@e" },
}).toString();

// A repository with two branches, which is the case the whole feature is
// for: one branch is one Minecraft version and the other is another.
const origin = path.join(tmp, "origin");
fs.mkdirSync(origin, { recursive: true });
sh(origin, "init", "-q", "-b", "main");
fs.writeFileSync(path.join(origin, "gradle.properties"), "minecraft_version=1.21.1\n");
sh(origin, "add", "-A"); sh(origin, "commit", "-qm", "fabric 1.21.1");
sh(origin, "checkout", "-q", "-b", "neo-1.20");
fs.writeFileSync(path.join(origin, "gradle.properties"), "minecraft_version=1.20.1\n");
sh(origin, "add", "-A"); sh(origin, "commit", "-qm", "neoforge 1.20.1");
sh(origin, "checkout", "-q", "main");

const work = path.join(tmp, "work");
sh(tmp, "clone", "-q", origin, work);

// ── reading one ───────────────────────────────────────────────────────────
{
  const i = await git.info(bin, work);
  check("a clone reads as a repository", [i.repo, i.branch, i.detached], [true, "main", false]);
  check("with the commit it is on", [i.head.subject, i.head.short.length >= 7], ["fabric 1.21.1", true]);
  check("and where it came from", !!i.remotes.origin.fetch, true);
  check("nothing is uncommitted in a fresh clone", i.changeCount, 0);

  // A folder deeper in is still the same repository: a Gradle project can
  // sit anywhere inside one, which is why this asks git rather than looking
  // for a .git folder beside the build script.
  const deep = path.join(work, "src", "main");
  fs.mkdirSync(deep, { recursive: true });
  check("and a folder inside it finds the top", await git.topLevel(bin, deep), fs.realpathSync(work));
  check("while a folder that is not in one says so", await git.topLevel(bin, tmp), null);
}

// ── branches ──────────────────────────────────────────────────────────────
{
  const b = await git.branches(bin, work);
  check("the branch it is on is listed as its own", b.local.map(x => x.name), ["main"]);
  check("and the one only the remote has is offered under the name it would get",
    b.remote.map(x => x.makes), ["neo-1.20"]);
  // git shortens refs/remotes/origin/HEAD to plain "origin", which is not a
  // branch and must not be offered as one.
  check("the remote's default pointer is not offered as a branch",
    b.remote.map(x => x.makes).includes("origin"), false,
    "git calls that ref 'origin', so filtering names ending in /HEAD missed it");
}

// ── switching ─────────────────────────────────────────────────────────────
{
  const r = await git.checkout(bin, work, "origin/neo-1.20", { asBranch: true });
  check("a remote branch is checked out", r.ok, true);
  const i = await git.info(bin, work);
  check("as a local branch tracking it, not as a detached head",
    [i.branch, i.detached, i.upstream], ["neo-1.20", false, "origin/neo-1.20"],
    "checking out origin/thing by name loses anything committed on it");
  check("and the files really are that branch's",
    fs.readFileSync(path.join(work, "gradle.properties"), "utf8").trim(), "minecraft_version=1.20.1");

  await git.checkout(bin, work, "main");
  const back = await git.info(bin, work);
  check("and it goes back", [back.branch, back.detached], ["main", false]);

  // A commit, which is the "go back to a specific commit" case and leaves a
  // detached head on purpose.
  const old = back.commits[back.commits.length - 1];
  await git.checkout(bin, work, old.hash);
  const at = await git.info(bin, work);
  check("checking out a commit leaves you on it rather than on a branch",
    [at.detached, at.branch, at.head.short], [true, null, old.short]);
  await git.checkout(bin, work, "main");
}

// ── what it will not do ───────────────────────────────────────────────────
//
// This is pointed at somebody's working copy. A launcher that can lose a
// day's work in one is a launcher nobody should point at one, so the
// commands that can are not in the file at all -- checked by reading it,
// because the guarantee is "there is no code that does this" rather than
// "the code that does this is not called".
{
  // The code, not the prose about it: this file explains in words why
  // `--hard` is not here, and a scan that reads the explanation as the thing
  // it warns about is a scan nobody can write a comment near.
  const src = code(fs.readFileSync(new URL("../backend/git.js", import.meta.url), "utf8"));
  const forbidden = [
    [/["']reset["']/, "reset"],
    [/--hard/, "--hard"],
    [/["']clean["']/, "clean"],
    [/--force\b|["']-f["']/, "--force"],
    [/["']push["']/, "push"],
    [/["']commit["']/, "commit"],
    [/["']rebase["']/, "rebase"],
    [/["']stash["']/, "stash"],
  ];
  check("nothing here can lose somebody's work",
    forbidden.filter(([re]) => re.test(src)).map(([, name]) => name), [],
    "this is pointed at a working copy, so the destructive commands are simply absent");
  check("and a pull cannot turn into a merge nobody asked for",
    /"pull", "--ff-only"/.test(src.replace(/\s+/g, " ")) || /\["pull", "--ff-only"\]/.test(src), true,
    "a pull that cannot fast-forward is a decision about somebody's work");

  // A ref is passed after `--`, so one that looks like an option, or shares
  // a name with a file, cannot be read as either.
  const r = await git.checkout(bin, work, "--upload-pack=touch /tmp/pwned");
  check("a ref that looks like an option is not run as one", r.ok, false);
  check("and nothing came of trying", fs.existsSync("/tmp/pwned"), false);
}

// ── a token never goes on a command line ──────────────────────────────────
//
// argv is readable by anything on the machine, so a token in `git -c
// http.extraHeader=...` is a token in `ps`. It goes in the environment,
// which is what GitHub's own runner does.
{
  const src = code(fs.readFileSync(new URL("../backend/git.js", import.meta.url), "utf8"));
  check("the token is passed in the environment, not in the arguments",
    [/GIT_CONFIG_KEY_0/.test(src), /extraHeader=/.test(src)], [true, false]);
  check("and git is never left waiting for a prompt that cannot appear",
    /GIT_TERMINAL_PROMPT = "0"/.test(src), true,
    "without it a private clone hangs for ever instead of failing");
}

// ── which git, and in which order ─────────────────────────────────────────
{
  const w = git.whichGit(tmp);
  check("the one on the PATH is preferred", w.how, "system",
    "it is the person's own, with their keys, their name and their credential helper");
  check("and there is advice for a computer with none",
    typeof git.noGitAdvice().say === "string" && git.noGitAdvice().say.length > 10, true);
  check("which is a download only where there is one worth downloading",
    git.noGitAdvice().canFetch, process.platform === "win32");
}

// ── picking the right download ────────────────────────────────────────────
{
  const release = {
    assets: [
      { name: "Git-2.47.0-64-bit.exe" },
      { name: "MinGit-2.47.0-32-bit.zip" },
      { name: "MinGit-2.47.0-64-bit.zip" },
      { name: "MinGit-2.47.0-busybox-64-bit.zip" },
      { name: "PortableGit-2.47.0-64-bit.7z.exe" },
    ],
  };
  const got = git.minGitAsset(release);
  check("the portable build is the one taken, not the installer",
    got && got.name, process.arch === "arm64" ? "MinGit-2.47.0-64-bit.zip" : "MinGit-2.47.0-64-bit.zip",
    "MinGit unzips into a folder and touches nothing outside it");
  check("and not the busybox one, which is missing half of git",
    /busybox/.test((got && got.name) || ""), false);
  check("a release with nothing usable in it is no asset rather than a wrong one",
    git.minGitAsset({ assets: [{ name: "Git-2.47.0-64-bit.exe" }] }), null);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
