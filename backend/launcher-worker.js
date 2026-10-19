// Runs a Minecraft launch OFF the main process.
//
// mclc's launch() does heavy, largely-synchronous work (hashing every asset,
// unzipping natives, verifying libraries) which blocked Electron's main event
// loop and froze the whole UI. This runs in an Electron utilityProcess, so all
// of that happens on a separate process/event loop and the app stays smooth.
//
// It receives a fully-resolved launch config from the main process, forwards
// mclc's log/progress events back, reports the spawned PID, and stays alive only
// long enough to report the game's exit (the game itself is detached and
// survives this worker).
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { Client } from "minecraft-launcher-core";
import { getLaunchConfig } from "./loader-versions.js";
const post = (m) => { try { process.parentPort.postMessage(m); } catch { /* ignore */ } };
const require_ = createRequire(import.meta.url);

// ── Not hashing three hundred megabytes on every launch ─────────────────────
//
// mclc's getAssets() runs over every object in the asset index and, for each
// one that is already on disk, reads the whole file and SHA-1s it. A modern
// version has four thousand of them and the better part of a gigabyte between
// them, so every launch re-read and re-hashed the lot -- minutes of disk, and
// a progress bar that sits on "assets" long enough to look like it is
// downloading them all over again.
//
// Nothing in mclc's options turns that off, so the check itself is made to
// remember: a file whose size and modified time are what they were when its
// hash was last verified is taken as still verified. Anything that has moved
// at all is hashed properly, and a file that has never been seen before
// always is. The record lives beside the assets, so deleting them takes it
// with them.
function rememberChecksums(assetRoot) {
  let Handler = null;
  try { Handler = require_("minecraft-launcher-core/components/handler"); }
  catch { return () => { }; }                 // a layout we do not know: hash away
  const file = path.join(assetRoot, ".verified.json");
  let seen = {};
  try { seen = JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch { /* first run */ }
  let dirty = false;
  const save = () => {
    if (!dirty) return;
    dirty = false;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(seen));
    } catch { /* a cache that cannot be written is only slower */ }
  };
  if (Handler.__remembersChecksums) { Handler.__seen = seen; return save; }
  const real = Handler.prototype.checkSum;
  Handler.prototype.checkSum = async function (hash, f) {
    let st = null;
    try { st = fs.statSync(f); } catch { return false; }
    const stamp = `${hash}|${st.size}|${Math.round(st.mtimeMs)}`;
    const memo = Handler.__seen || seen;
    if (memo[f] === stamp) return true;
    const ok = await real.call(this, hash, f);
    if (ok) { memo[f] = stamp; dirty = true; }
    return ok;
  };
  Handler.__remembersChecksums = true;
  Handler.__seen = seen;
  return save;
}

// ── The library jars nobody was checking ────────────────────────────────────
//
// mclc verifies a library against its published hash like this:
//
//     if (!this.checkSum(library.downloads.artifact.sha1, file)) await get(lib)
//
// checkSum is async, so the test is `!Promise`, which is never true. No
// library jar has ever been verified. Its downloader is just as trusting: it
// resolves when the write stream finishes, without ever comparing what
// arrived against Content-Length, so a transfer cut halfway through leaves a
// truncated jar on disk. The only test it then has to pass is
// `fs.existsSync`, which it passes forever.
//
// From 1.19 on the LWJGL natives ARE library jars -- lwjgl.dll, glfw.dll and
// the rest are unpacked out of them by LWJGL itself at startup. A truncated
// jar is a truncated DLL, and a truncated DLL is an access violation
// (0xC0000005, exit code 3221225477) the moment the game touches OpenGL. It
// happens on every launch and leaves no crash report, because by then there
// is no Java left to write one. This is that crash.
//
// So: after mclc has done its pass, hash every library it was supposed to
// have hashed and replace the ones that are wrong. The checksum memo above
// means this costs a full read once and a stat per launch after that.
function verifyLibraries() {
  let Handler = null;
  try { Handler = require_("minecraft-launcher-core/components/handler"); }
  catch { return; }
  if (Handler.__verifiesLibraries) return;
  const real = Handler.prototype.downloadToDirectory;

  Handler.prototype.downloadToDirectory = async function (directory, libraries, eventName) {
    const libs = await real.call(this, directory, libraries, eventName);
    let repaired = 0, broken = 0;
    await Promise.all((libraries || []).map(async (library) => {
      const art = library && library.downloads && library.downloads.artifact;
      // No url means a dependency the loader generates locally, and no hash
      // means nothing to check it against.
      if (!art || !art.sha1 || !art.path || !art.url) return;
      try {
        const name = art.path.split("/").pop();
        const dir = path.join(directory, this.popString(art.path));
        const file = path.join(dir, name);
        if (await this.checkSum(art.sha1, file)) return;
        this.client.emit("debug", `[redstone]: ${name} is damaged or incomplete, fetching it again`);
        for (let tries = 0; tries < 3; tries++) {
          try { fs.unlinkSync(file); } catch { /* it may simply be missing */ }
          await this.downloadAsync(art.url, dir, name, true, eventName);
          if (await this.checkSum(art.sha1, file)) { repaired++; return; }
        }
        broken++;
        this.client.emit("debug", `[redstone]: ${name} is STILL wrong after three tries`);
      } catch { /* a path we cannot work out; leave mclc's own result alone */ }
    }));
    if (repaired) this.client.emit("debug", `[redstone]: replaced ${repaired} damaged librar${repaired === 1 ? "y" : "ies"}`);
    if (broken) this.client.emit("debug", `[redstone]: ${broken} librar${broken === 1 ? "y is" : "ies are"} still wrong -- the game may crash`);
    return libs;
  };

  Handler.__verifiesLibraries = true;
}

// ── Natives extracted once and never looked at again ────────────────────────
//
// Below 1.19 the natives are zips that mclc unpacks into
// `<root>/natives/<version>`, and it decides whether to do that with
//
//     if (!fs.existsSync(dir) || !fs.readdirSync(dir).length)
//
// -- so an extraction interrupted halfway (the launcher closed, the disk
// full, a DLL quarantined) leaves a non-empty folder that is never touched
// again. The game then loads whichever DLLs made it, and a half-written DLL
// is the same access violation as a truncated one.
//
// A stamp file settles it: the hashes of the native zips the folder was
// built from. If it is missing -- which it is for a folder that was
// interrupted, because the stamp is written last -- or it names different
// zips, the folder is thrown away and extracted again.
//
// The same hook repairs the client jar, which mclc downloads without
// checking and re-downloads only when the file is altogether gone. Only an
// outright size mismatch counts here: a wrong hash could be a jar some
// loader patched in place, but a jar that is not the length Mojang published
// is simply an interrupted download.
function verifyNatives() {
  let Handler = null;
  try { Handler = require_("minecraft-launcher-core/components/handler"); }
  catch { return; }
  if (Handler.__verifiesNatives) return;
  const real = Handler.prototype.getNatives;

  Handler.prototype.getNatives = async function () {
    // mcPath and this.version are both set by the time launch() gets here.
    try {
      const want = this.version && this.version.downloads && this.version.downloads.client;
      const jar = this.options && this.options.mcPath;
      if (jar && want && want.size && fs.existsSync(jar)) {
        const size = fs.statSync(jar).size;
        if (size !== want.size) {
          this.client.emit("debug", `[redstone]: the client jar is ${size} bytes and should be ${want.size}, fetching it again`);
          fs.unlinkSync(jar);          // launch() downloads it again when it is gone
        }
      }
    } catch { /* leave the jar alone if it cannot be measured */ }

    let dir = null, stamp = null;
    try {
      // 1.19 and up keep their natives in the library jars instead, and mclc
      // never unpacks anything -- nothing here to stamp.
      if (parseInt(String(this.version.id).split(".")[1], 10) < 19) {
        dir = path.resolve((this.options.overrides && this.options.overrides.natives)
          || path.join(this.options.root, "natives", this.version.id));
        const os = this.getOS();
        const hashes = [];
        for (const lib of this.version.libraries || []) {
          if (!lib.downloads || !lib.downloads.classifiers) continue;
          if (this.parseRule(lib)) continue;
          const native = os === "osx"
            ? (lib.downloads.classifiers["natives-osx"] || lib.downloads.classifiers["natives-macos"])
            : lib.downloads.classifiers[`natives-${os}`];
          if (native && native.sha1) hashes.push(native.sha1);
        }
        hashes.sort();
        stamp = JSON.stringify(hashes);
        let had = null;
        try { had = fs.readFileSync(path.join(dir, ".extracted.json"), "utf8"); } catch { /* never stamped */ }
        if (had !== stamp && fs.existsSync(dir)) {
          this.client.emit("debug", "[redstone]: the natives were not extracted cleanly, doing it again");
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
    } catch { stamp = null; }

    const out = await real.call(this);
    if (dir && stamp) {
      try { fs.writeFileSync(path.join(dir, ".extracted.json"), stamp); }
      catch { /* a stamp that cannot be written only costs one extraction */ }
    }
    return out;
  };

  Handler.__verifiesNatives = true;
}

function isTransient(err) {
  const s = String(err && err.message || err || "");
  return /\b(429|500|502|503|504)\b/.test(s) || /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network|timed? ?out|fetch failed/i.test(s);
}
async function withRetry(fn, tries = 3) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try { return await fn(); }
    catch (e) { last = e; if (i >= tries || !isTransient(e)) throw e; await new Promise(r => setTimeout(r, 800 * 2 ** (i - 1))); }
  }
  throw last;
}

async function runLaunch(cfg) {
  // Not tomate-loaders: it accepts a loaderVersion and then ignores it, and
  // picks the OLDEST Forge/NeoForge build for the game version rather than the
  // newest. See loader-versions.js.
  const launcherConfig = await withRetry(() => getLaunchConfig({
    loader: cfg.loader,
    gameVersion: cfg.gameVersion,
    rootPath: cfg.rootPath,
    loaderVersion: cfg.loaderVersion || "",
  }, (line) => post({ type: "log", line })));

  const saveChecks = rememberChecksums(cfg.assetRoot || path.join(cfg.rootPath, "assets"));
  verifyLibraries();
  verifyNatives();

  const launcher = new Client();
  launcher.on("data", (m) => post({ type: "log", line: String(m) }));
  launcher.on("debug", (m) => post({ type: "log", line: String(m) }));
  launcher.on("error", (e) => post({ type: "log", line: "ERROR: " + (e?.message || e) }));
  launcher.on("progress", (p) => post({ type: "progress", p }));
  launcher.on("download-status", (s) => post({ type: "dl", s }));

  const opts = {
    ...launcherConfig,
    authorization: cfg.auth,
    memory: cfg.memory,
    javaPath: cfg.javaPath,
    overrides: { assetRoot: cfg.assetRoot, detached: true },
    quickPlay: cfg.quickPlay || null,
  };
  if (cfg.customArgs && cfg.customArgs.length) opts.customArgs = cfg.customArgs;
  if (cfg.customLaunchArgs && cfg.customLaunchArgs.length) opts.customLaunchArgs = cfg.customLaunchArgs;

  const child = await withRetry(() => launcher.launch(opts), 2);
  saveChecks();
  if (!child || !child.pid) { post({ type: "error", error: "The game process failed to start" }); return; }
  try { child.unref(); } catch { /* ignore */ }
  post({ type: "spawned", pid: child.pid });
  // NOTE: minecraft-launcher-core already forwards the child's stdout AND stderr
  // through its own "data" event (wired above), so capturing child.stdout/stderr
  // here as well would emit every game line twice. Don't re-capture them.
  child.on("exit", (code) => post({ type: "exit", pid: child.pid, code }));
  child.on("error", (e) => post({ type: "log", line: "ERROR: " + (e?.message || e) }));
}

process.parentPort.on("message", async (e) => {
  const msg = e.data;
  if (!msg || msg.type !== "launch") return;
  try { await runLaunch(msg.cfg); }
  catch (err) { post({ type: "error", error: err && err.message || String(err) }); }
});
