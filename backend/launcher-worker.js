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
      // Merged with whatever another launch has written since this one read
      // it, and written in one step -- two launches of the same instance
      // share this file, and a half-written one read by the other is a
      // whole folder's worth of checksums done again.
      let theirs = {};
      try { theirs = JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch { /* first run */ }
      writeAtomic(file, JSON.stringify({ ...theirs, ...seen }));
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

// ── Two games of the same instance, at the same time ───────────────────────
//
// "Run again" is a second copy of the same instance over the same folders,
// and a launch while one is already playing is the same thing. Everything
// under those folders is therefore shared between processes that know
// nothing about each other, and the launcher has to behave as though one of
// them is always in the middle of reading something.
//
// Two rules, and both of them are here rather than scattered about:
//
//   1. Nothing is written in place. A file that something else may be
//      reading is replaced by writing a new one beside it and renaming it
//      over the top, which is one step as far as any reader is concerned.
//   2. Nothing that may be IN USE is deleted. The natives folder is the one
//      that was: a stale stamp had it thrown away and extracted again, and
//      doing that to a game that is running out of it takes the DLLs out
//      from under it. Each launch leaves a mark while it holds the folder,
//      and the marks of launches that have gone are ignored.
const inUse = new Set();           // directories this launch has marked

/** Write a file in one step, so a reader never sees half of it. */
function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* never existed */ }
    throw e;
  }
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

/** Say that this launch is using a directory, and tidy up after ones that are gone. */
function markInUse(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `.inuse-${process.pid}`), String(Date.now()));
    inUse.add(dir);
  } catch { /* a mark that cannot be written only costs caution */ }
}

/** Is anything ELSE using it? Marks left by processes that have ended are swept. */
function usedByAnother(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return false; }
  let someone = false;
  for (const name of names) {
    const m = /^\.inuse-(\d+)$/.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid) continue;
    if (alive(pid)) { someone = true; continue; }
    try { fs.unlinkSync(path.join(dir, name)); } catch { /* another launch got there first */ }
  }
  return someone;
}

function releaseInUse() {
  for (const dir of inUse) {
    try { fs.unlinkSync(path.join(dir, `.inuse-${process.pid}`)); } catch { /* already gone */ }
  }
  inUse.clear();
}

/**
 * Do something no two launches may do at once.
 *
 * A lock file that is created exclusively: whoever makes it owns the
 * critical section. One left behind by a process that has died is taken
 * over, and one older than the longest this could reasonably take is taken
 * over too, so a crash cannot wedge every future launch.
 */
async function withLock(file, fn, { waitMs = 120000 } = {}) {
  const started = Date.now();
  let held = false;
  while (Date.now() - started < waitMs) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: "wx" });
      held = true;
      break;
    } catch {
      let stale = false;
      try {
        const st = fs.statSync(file);
        const pid = Number(fs.readFileSync(file, "utf8").trim());
        stale = (Date.now() - st.mtimeMs > waitMs) || (Number.isFinite(pid) && pid > 0 && !alive(pid));
      } catch { stale = true; }          // it vanished between the two calls
      if (stale) { try { fs.unlinkSync(file); } catch { /* someone else took it */ } continue; }
      await new Promise(r => setTimeout(r, 150));
    }
  }
  try { return await fn(held); }
  finally { if (held) { try { fs.unlinkSync(file); } catch { /* already gone */ } } }
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
// ── A launch that stops dead with nothing more to say ───────────────────────
//
// mclc's getVersion() fetches the version's JSON and parses it inside the
// request's callback:
//
//     this.client.emit('debug', '[MCLC]: Parsed version from version manifest')
//     this.version = ... : JSON.parse(body)
//     return resolve(this.version)
//
// If that parse throws -- an empty body, a proxy's error page, a captive
// portal, a truncated response -- the throw happens inside a callback with
// nothing around it. The promise is never resolved and never REJECTED, so
// launch() waits on it for ever. The launcher shows the instance as
// launching with no error, no exit and nothing further in the log, which is
// exactly what was reported: the log ends on that very line.
//
// Note which line it ends on. "Parsed version from version manifest" is
// printed BEFORE the parse, not after it, so the last thing in the log is a
// claim that the thing which just failed had succeeded.
//
// So the fetch is done here instead, properly: with a timeout, checked for
// being JSON at all, and checked for having the parts mclc will reach for.
// The result is written to the file mclc looks for first, so the real
// getVersion takes its own fast path and the fragile code is never reached.
// Anything that goes wrong throws, which fails the launch with a reason --
// a launch that fails is worse than one that works and far better than one
// that hangs.
function fetchVersionJsonProperly() {
  let Handler = null;
  try { Handler = require_("minecraft-launcher-core/components/handler"); }
  catch { return; }
  if (Handler.__honestVersion) return;
  const real = Handler.prototype.getVersion;

  const getJson = async (url, what) => {
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), 60000);
    let res;
    try {
      res = await fetch(url, { signal: stop.signal });
    } catch (e) {
      throw new Error(`Could not reach ${what} (${url}): ${e && e.name === "AbortError" ? "it took too long" : (e && e.message) || e}`);
    } finally { clearTimeout(timer); }
    if (!res.ok) throw new Error(`${what}: the answer was ${res.status} ${res.statusText || ""} (${url})`);
    const body = await res.text();
    try { return JSON.parse(body); } catch {
      // The first line of it, because that is what says what it really was:
      // an HTML error page, a login portal, or nothing at all.
      const peek = body.trim().split("\n")[0].slice(0, 120) || "(it was empty)";
      throw new Error(`${what}: that is not JSON (${url}). It began: ${peek}`);
    }
  };

  Handler.prototype.getVersion = async function () {
    const number = this.options.version.number;
    const file = this.options.overrides.versionJson
      || path.join(this.options.directory, `${number}.json`);
    // Already here and readable: nothing to do, and this is the path mclc
    // takes on every launch after the first.
    try {
      if (fs.existsSync(file)) { JSON.parse(fs.readFileSync(file, "utf8")); return real.call(this); }
    } catch {
      // Here but not readable. mclc would throw on it from inside the
      // Promise executor, which does at least reject -- but the file is
      // rubbish either way, so it goes and is fetched again.
      try { fs.unlinkSync(file); } catch { /* it will be overwritten */ }
    }

    const meta = (this.options.overrides.url && this.options.overrides.url.meta) || "https://launchermeta.mojang.com";
    const manifest = await getJson(`${meta}/mc/game/version_manifest.json`, "Mojang's version list");
    const want = (manifest.versions || []).find(v => v && v.id === number);
    if (!want || !want.url) {
      throw new Error(`Mojang's version list has no "${number}" in it.`);
    }
    const version = await getJson(want.url, `the details of Minecraft ${number}`);
    // What mclc will reach into without checking. Saying which part is
    // missing here beats a TypeError three functions later.
    for (const key of ["id", "libraries", "downloads", "assetIndex"]) {
      if (!version[key]) throw new Error(`The details of Minecraft ${number} have no "${key}" in them.`);
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeAtomic(file, JSON.stringify(version, null, 2));
    } catch (e) {
      // It could not be saved, which is survivable: hand mclc the parsed
      // version directly and let it carry on.
      this.version = version;
      return version;
    }
    return real.call(this);
  };
  Handler.__honestVersion = true;
}

function verifyNatives() {
  let Handler = null;
  try { Handler = require_("minecraft-launcher-core/components/handler"); }
  catch { return; }
  if (Handler.__verifiesNatives) return;
  const real = Handler.prototype.getNatives;

  Handler.prototype.getNatives = async function () {
    // Only one launch at a time gets to decide about the natives folder, and
    // none of them may take it away from a game that is running out of it.
    // Two copies of an instance started together used to both find the same
    // stale stamp, both throw the folder away and both extract into it --
    // interleaved -- and a launch while one was already playing deleted the
    // DLLs that game had open.
    const nativesDir = (() => {
      try {
        return path.resolve((this.options.overrides && this.options.overrides.natives)
          || path.join(this.options.root, "natives", this.version.id));
      } catch { return null; }
    })();
    if (nativesDir) {
      return withLock(`${nativesDir}.lock`, async () => {
        markInUse(nativesDir);
        return nativesInner.call(this);
      });
    }
    return nativesInner.call(this);
  };

  async function nativesInner() {
    // mcPath and this.version are both set by the time launch() gets here.
    try {
      const want = this.version && this.version.downloads && this.version.downloads.client;
      const jar = this.options && this.options.mcPath;
      if (jar && want && want.size && fs.existsSync(jar)) {
        const size = fs.statSync(jar).size;
        if (size !== want.size) {
          // Not while another copy of this instance is playing from it: the
          // game maps its own jar, and on Windows this fails outright while
          // elsewhere it quietly pulls the file out from under it.
          if (usedByAnother(path.dirname(jar))) {
            this.client.emit("debug",
              `[redstone]: the client jar is the wrong size, but another copy of this instance is using it -- left alone`);
          } else {
            this.client.emit("debug", `[redstone]: the client jar is ${size} bytes and should be ${want.size}, fetching it again`);
            fs.unlinkSync(jar);        // launch() downloads it again when it is gone
          }
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
          if (usedByAnother(dir)) {
            // Another copy of this instance is running out of this folder.
            // Whatever is wrong with it, taking it away mid-game is worse:
            // the DLLs it has open go with it. It stays as it is, and the
            // next launch with nothing else running rebuilds it.
            this.client.emit("debug",
              "[redstone]: the natives want rebuilding, but another copy of this instance is using them -- left alone");
            stamp = null;                 // and not stamped as though it were fresh
          } else {
            this.client.emit("debug", "[redstone]: the natives were not extracted cleanly, doing it again");
            fs.rmSync(dir, { recursive: true, force: true });
          }
        }
      }
    } catch { stamp = null; }

    const out = await real.call(this);
    if (dir && stamp) {
      // In one step: another launch may be reading this to decide whether
      // the folder is sound.
      try { writeAtomic(path.join(dir, ".extracted.json"), stamp); }
      catch { /* a stamp that cannot be written only costs one extraction */ }
    }
    return out;
  }

  Handler.__verifiesNatives = true;
}

// ── Every download, finished or not, was being kept ─────────────────────────
//
// mclc's downloadAsync pipes the response straight into the file it is meant
// to end up as, and resolves on the write stream's `finish`:
//
//     const file = fs.createWriteStream(path.join(directory, name))
//     _request.pipe(file)
//     file.once('finish', () => resolve({ failed: false, asset: null }))
//
// A connection cut halfway through ends the response, which ends the pipe,
// which finishes the file. Nothing ever compares what arrived against the
// Content-Length it was told to expect, so a transfer that stopped at 40%
// resolves as a completed download, and the truncated file is sitting at its
// real name where everything afterwards takes it for the finished article.
//
// For libraries and natives that is the access violation (0xC0000005 /
// 3221225477) the two patches above now repair. For ASSETS it is worse,
// because of what getAssets does with the result:
//
//     if (!fs.existsSync(f) || !await this.checkSum(hash, f)) await this.downloadAsync(...)
//
// It checks the hash BEFORE downloading and never again after. So a truncated
// asset is used by the game this launch; next launch the hash check catches
// it, re-downloads it, and uses the new one unchecked as well. A half-written
// .ogg handed to OpenAL or a half-written .png handed to stb_image is a read
// off the end of a native buffer: an access violation if it lands outside the
// heap, and heap corruption (0xC0000374 / 3221226356) if it lands inside it.
// Both of the codes being reported, from inside native code, with no Java
// stack trace and no crash report -- and it follows the broken file from
// machine to machine, because the assets folder is what gets copied.
//
// So the download itself is replaced with one that cannot leave a lie on
// disk: the bytes go to a `.part` file, the full Content-Length must arrive,
// the SHA-1 is checked as it streams whenever the name is the hash (which is
// how every asset is stored), and only then is it renamed to the name
// everything else looks for. Anything short is thrown away and fetched again.
// A file that is not there at all is a miss, which every caller handles; a
// file that is there and wrong is what nothing handles.
function verifyDownloads() {
  let Handler = null;
  try { Handler = require_("minecraft-launcher-core/components/handler"); }
  catch { return; }
  if (Handler.__verifiesDownloads) return;

  const HASH_NAME = /^[0-9a-f]{40}$/i;
  const TRIES = 4;
  const IDLE = 45000;              // a socket that has said nothing for this long is gone
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // mclc asks for all four thousand assets at once with a single Promise.all
  // and relied on `request`'s two-socket pool to queue them. fetch has no
  // such pool, so without a gate of our own that is four thousand concurrent
  // connections: descriptor exhaustion and a storm of resets, which is to
  // say more truncated files. Eight at a time is both safe and four times
  // what mclc managed.
  let active = 0;
  const waiting = [];
  const enter = () => active < 8 ? (active++, Promise.resolve()) : new Promise(r => waiting.push(r));
  const leave = () => { const next = waiting.shift(); if (next) next(); else active--; };

  // Waiting on a write stream without leaving a listener behind.
  //
  // Both of these used to be written inline as `out.once("drain", ok);
  // out.once("error", no)`, which leaves the OTHER listener attached for ever
  // -- one pair per chunk, so a large file ends up with thousands of dead
  // listeners on the same stream and node starts warning about a leak.
  const drained = (s) => new Promise((ok, no) => {
    const onDrain = () => { s.off("error", onError); ok(); };
    const onError = (e) => { s.off("drain", onDrain); no(e); };
    s.once("drain", onDrain);
    s.once("error", onError);
  });
  const ended = (s) => new Promise((ok, no) => {
    const onError = (e) => no(e);
    s.once("error", onError);
    s.end(() => { s.off("error", onError); ok(); });
  });

  // One temp name per download, not one per FILE.
  //
  // `<name>.part` is the same path for everybody, and the assets folder is
  // shared: two instances starting at once, or one starting while another is
  // already running, both decide the same asset needs fetching and both
  // write to that one temp file. Two writers interleaving in one file, then
  // renamed into place under the asset's hash -- which is the name the game
  // trusts and never checks again. That is an asset that has been on the
  // disk since forever reading as missing or broken, with no download having
  // failed and nothing in any log to say so.
  const stamp = `${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  let partSeq = 0;

  Handler.prototype.downloadAsync = async function (url, directory, name, retry, type) {
    const dest = path.join(directory, name);
    const part = `${dest}.part-${stamp}-${(++partSeq).toString(36)}`;
    const wantHash = HASH_NAME.test(name) ? name.toLowerCase() : null;
    let last = null;

    await enter();
    try {
      for (let attempt = 1; attempt <= TRIES; attempt++) {
        let out = null;
        try {
          fs.mkdirSync(directory, { recursive: true });
          const stop = new AbortController();
          let idle = setTimeout(() => stop.abort(), IDLE);
          const res = await fetch(url, { redirect: "follow", signal: stop.signal });
          if (res.status === 404) {
            clearTimeout(idle);
            this.client.emit("debug", `[MCLC]: Failed to download ${url} due to: File not found...`);
            return false;                               // what mclc's callers expect
          }
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const stated = parseInt(res.headers.get("content-length"), 10);
          const total = Number.isFinite(stated) && stated > 0 ? stated : 0;

          const sha = wantHash ? require_("crypto").createHash("sha1") : null;
          out = fs.createWriteStream(part);
          // There must ALWAYS be something listening for this stream's
          // errors.
          //
          // The catch below destroys `out` on any failure -- an aborted
          // fetch, a short body, a hash that does not match. A write already
          // handed to the filesystem then comes back as ERR_STREAM_DESTROYED
          // and is emitted as an 'error' event; with nothing listening, node
          // turns that into an uncaught exception, which in the main process
          // takes the launcher down mid-download. The transient listeners
          // around drain and end did not cover it, because a failure
          // anywhere else in the loop reaches the catch with neither of them
          // attached.
          //
          // Swallowing it here loses nothing: whatever actually went wrong
          // is already in `last`, and the retry loop deals with it.
          out.on("error", () => { });
          let got = 0, told = 0;
          for await (const chunk of res.body) {
            clearTimeout(idle);
            idle = setTimeout(() => stop.abort(), IDLE);
            got += chunk.length;
            if (sha) sha.update(chunk);
            if (!out.write(chunk)) await drained(out);
            // One message per chunk of four thousand files is a lot of IPC for
            // a number nobody can read that fast.
            const now = Date.now();
            if (now - told > 120 || got === total) {
              told = now;
              this.client.emit("download-status", { name, type, current: got, total: total || got });
            }
          }
          clearTimeout(idle);
          await ended(out);
          out = null;

          if (total && got !== total) throw new Error(`only ${got} of ${total} bytes arrived`);
          if (!got && total !== 0) throw new Error("nothing arrived");
          if (sha) {
            const had = sha.digest("hex");
            if (had !== wantHash) throw new Error(`sha1 is ${had} and should be ${wantHash}`);
          }
          // Into place in one step, so nothing ever reads a half-written
          // file under the real name.
          //
          // On Windows this fails outright when something else has the
          // destination open -- another instance of the game, or another
          // launch doing the same thing a moment earlier. That is not a
          // failure if what is already there is the file we were going to
          // write: an asset is stored under its own hash, so a destination
          // whose name we just matched byte for byte is the same file, and
          // the copy we fetched is simply redundant.
          try {
            fs.renameSync(part, dest);
          } catch (renameFailed) {
            const already = wantHash && fs.existsSync(dest)
              && require_("crypto").createHash("sha1").update(fs.readFileSync(dest)).digest("hex") === wantHash;
            if (!already) throw renameFailed;
            try { fs.unlinkSync(part); } catch { /* it will be swept up */ }
          }
          this.client.emit("download", name);
          return { failed: false, asset: null };
        } catch (e) {
          last = e;
          if (out) { try { out.destroy(); } catch { /* already gone */ } }
          try { fs.unlinkSync(part); } catch { /* it may not have been created */ }
          if (attempt < TRIES) await sleep(400 * 2 ** (attempt - 1));
        }
      }
    } finally { leave(); }

    this.client.emit("debug", `[redstone]: gave up on ${name} after ${TRIES} tries: ${last && last.message || last}`);
    return;                                             // mclc treats this as a miss
  };

  Handler.__verifiesDownloads = true;
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
  verifyDownloads();
  verifyLibraries();
  verifyNatives();
  fetchVersionJsonProperly();

  const launcher = new Client();
  launcher.on("data", (m) => post({ type: "log", line: String(m) }));
  launcher.on("debug", (m) => post({ type: "log", line: String(m) }));
  launcher.on("error", (e) => post({ type: "log", line: "ERROR: " + (e?.message || e) }));
  launcher.on("progress", (p) => post({ type: "progress", p }));
  launcher.on("download-status", (s) => post({ type: "dl", s }));

  // The loader's own JVM arguments, which are not optional: NeoForge needs
  // -DlibraryDirectory to find its libraries at all, and without it FML
  // stops before the window opens. Added to whatever the instance asks for.
  const loaderJvm = Array.isArray(launcherConfig.loaderJvmArgs) ? launcherConfig.loaderJvmArgs : [];
  delete launcherConfig.loaderJvmArgs;
  if (loaderJvm.length) post({ type: "log", line: `[loader] ${loaderJvm.length} JVM argument${loaderJvm.length === 1 ? "" : "s"} the loader asks for: ${loaderJvm.join(" ")}` });

  const opts = {
    ...launcherConfig,
    authorization: cfg.auth,
    memory: cfg.memory,
    javaPath: cfg.javaPath,
    overrides: { assetRoot: cfg.assetRoot, detached: true },
    quickPlay: cfg.quickPlay || null,
  };
  const extraJvm = [...loaderJvm, ...(cfg.customArgs || [])];
  if (extraJvm.length) opts.customArgs = extraJvm;
  if (cfg.customLaunchArgs && cfg.customLaunchArgs.length) opts.customLaunchArgs = cfg.customLaunchArgs;

  // ── A launch that has stopped getting anywhere ────────────────────────────
  //
  // Everything in a launch reports as it goes: a download emits progress
  // several times a second, a library check emits a line per library, mclc
  // narrates each step. So complete silence does not mean "it is busy", it
  // means something is waiting on something that is never going to happen --
  // a promise that was neither resolved nor rejected, a socket with no
  // timeout on it.
  //
  // Left to itself that is an instance that says "launching" for ever, with
  // nothing in the log and no way to find out why, which is what was
  // reported. A launch that gives up with a reason is not a good outcome,
  // but it is an outcome.
  const QUIET_LIMIT = 4 * 60 * 1000;
  let lastWord = Date.now();
  const quiet = setInterval(() => {
    if (Date.now() - lastWord < QUIET_LIMIT) return;
    clearInterval(quiet);
    post({
      type: "log",
      line: `[redstone] Nothing has happened for ${Math.round(QUIET_LIMIT / 60000)} minutes. `
        + "Something in the launch is waiting on something that is not coming -- "
        + "usually the game's files could not be fetched. Giving up rather than waiting for ever.",
    });
    post({ type: "error", error: "The launch stopped getting anywhere and was given up on." });
    releaseInUse();
    // The whole point is that nothing here will finish on its own, so there
    // is nothing to await and nothing to cancel: the process goes.
    try { process.exit(1); } catch { /* going anyway */ }
  }, 15000);
  const heard = () => { lastWord = Date.now(); };
  for (const ev of ["data", "debug", "progress", "download-status"]) launcher.on(ev, heard);

  let child;
  try { child = await withRetry(() => launcher.launch(opts), 2); }
  finally { clearInterval(quiet); }
  saveChecks();
  if (!child || !child.pid) { post({ type: "error", error: "The game process failed to start" }); return; }
  try { child.unref(); } catch { /* ignore */ }
  post({ type: "spawned", pid: child.pid });
  // NOTE: minecraft-launcher-core already forwards the child's stdout AND stderr
  // through its own "data" event (wired above), so capturing child.stdout/stderr
  // here as well would emit every game line twice. Don't re-capture them.
  child.on("exit", (code) => {
    // This launch is no longer using the shared folders, so the next one may
    // rebuild them.
    releaseInUse();
    post({ type: "exit", pid: child.pid, code });
  });
  child.on("error", (e) => post({ type: "log", line: "ERROR: " + (e?.message || e) }));
}

process.parentPort.on("message", async (e) => {
  const msg = e.data;
  if (!msg || msg.type !== "launch") return;
  try { await runLaunch(msg.cfg); }
  catch (err) { releaseInUse(); post({ type: "error", error: err && err.message || String(err) }); }
});

// However this process ends, it stops laying claim to the shared folders.
// A mark left behind is swept by the next launch -- it checks whether the
// process that left it is still alive -- but not leaving one is better.
for (const signal of ["exit", "SIGINT", "SIGTERM"]) {
  try { process.on(signal, releaseInUse); } catch { /* not every signal everywhere */ }
}
