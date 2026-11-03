import fs from "fs";
import path from "path";
import https from "https";
import { spawn } from "child_process";
import { app } from 'electron';
import rcon from "./rcon.js";

const servers = new Map(); // name → { proc, config, logs }
const dataDir = path.join(app.getPath('userData'));
const serversDir = path.join(dataDir, "servers");
fs.mkdirSync(serversDir, { recursive: true });

// Fetch a file, and either have the whole of it or none of it.
//
// Written to a .part and moved into place, so a connection that drops leaves
// nothing behind rather than a truncated server jar that looks finished and
// fails on the first run. The length the server promises is checked, because
// a body that stops short still ends the stream cleanly, and both the
// response and the file are listened to -- an 'error' with no listener is an
// uncaught exception.
function download(url, dest) {
  return new Promise((resolve, reject) => {
    const part = dest + ".part";
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      if (err) { try { fs.unlinkSync(part); } catch { /* never made it */ } reject(err); }
      else resolve(dest);
    };
    const get = (u, hops) => {
      https.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (hops <= 0) return done(new Error("Too many redirects"));
          return get(new URL(res.headers.location, u).href, hops - 1);
        }
        if (res.statusCode !== 200) { res.resume(); return done(new Error("Download failed " + res.statusCode)); }
        const expected = Number(res.headers["content-length"]);
        let got = 0;
        res.on("data", (c) => { got += c.length; });
        const file = fs.createWriteStream(part);
        file.on("error", done);
        res.on("error", done);
        res.pipe(file);
        file.on("finish", () => file.close(() => {
          if (Number.isFinite(expected) && expected > 0 && got !== expected) {
            return done(new Error(`Download cut short: ${got} of ${expected} bytes`));
          }
          try { fs.renameSync(part, dest); } catch (e) {
            try { fs.copyFileSync(part, dest); fs.unlinkSync(part); } catch { return done(e); }
          }
          done();
        }));
      }).on("error", done);
    };
    get(url, 5);
  });
}

// PaperMC's downloads service. Their old api.papermc.io/v2 has been switched
// off entirely -- it answers every request with {"ok":false,"error":"sunset"},
// which is why asking it for a version's builds produced an object with no
// `builds` in it and "versionInfo.builds is not iterable". This is where it
// moved to, and it asks that requests name the software making them rather
// than arriving as a bare library default.
const PAPER_API = "https://fill.papermc.io/v3";
const PAPER_UA = "RedstoneLauncher (https://github.com/TGGamesYT/redstone-launcher)";

function fetchJson(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, headers ? { headers } : undefined, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(err);
        }
      });
    }).on("error", reject);
  });
}

function fetchLatestFabricLoader() {
  return new Promise((resolve, reject) => {
    https.get('https://maven.fabricmc.net/net/fabricmc/fabric-loader/maven-metadata.xml', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          // Parse XML manually to find <release>
          const match = data.match(/<release>(.*?)<\/release>/);
          if (match && match[1]) {
            resolve(match[1]);
          } else {
            reject(new Error("Could not find release in metadata XML"));
          }
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

function fetchLatestQuiltLoader() {
  return new Promise((resolve, reject) => {
    https.get('https://meta.quiltmc.org/v3/versions/loader', (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { const arr = JSON.parse(data); resolve(arr[0]?.version); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// Resolve the download URL for a given server software + MC version.
async function resolveJarUrl(version, type, loaderVersion) {
  switch ((type || "").toLowerCase()) {
    case "vanilla": {
      const manifest = await fetchJson("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json");
      const entry = manifest.versions.find(v => v.id === version);
      if (!entry) throw new Error(`Vanilla version ${version} not found`);
      const metadata = await fetchJson(entry.url);
      return metadata.downloads.server.url;
    }
    case "paper":
    case "folia":
    case "velocity":
    case "waterfall": {
      const proj = type.toLowerCase();
      const builds = await fetchJson(
        `${PAPER_API}/projects/${proj}/versions/${version}/builds`,
        { "User-Agent": PAPER_UA });
      if (!Array.isArray(builds) || !builds.length) {
        // Their failures come back as an object, so say what it said rather
        // than letting it fall through as "not iterable".
        const why = builds && (builds.message || builds.error);
        throw new Error(`${type} has no builds for ${version}${why ? ` (${why})` : ""}`);
      }
      // Newest first, and a stable build in preference to an experimental
      // one -- a release candidate's server jar is not what somebody asking
      // for Paper expects to be handed.
      const build = builds.find(b => b && b.channel === "STABLE") || builds[0];
      const downloads = (build && build.downloads) || {};
      // They key the jar by what it is. `server:default` is the one we want;
      // the fallback is there so a project that names its download something
      // else still resolves rather than failing on a missing key.
      const file = downloads["server:default"] || Object.values(downloads)[0];
      if (!file || !file.url) throw new Error(`${type} build ${build && build.id} has no server download`);
      return file.url;
    }
    case "purpur": {
      // Purpur exposes a "latest" build alias.
      return `https://api.purpurmc.org/v2/purpur/${version}/latest/download`;
    }
    case "fabric": {
      const loaderVer = loaderVersion || await fetchLatestFabricLoader();
      return `https://meta.fabricmc.net/v2/versions/loader/${version}/${loaderVer}/1.1.0/server/jar`;
    }
    case "quilt": {
      const loaderVer = loaderVersion || await fetchLatestQuiltLoader();
      return `https://meta.quiltmc.org/v3/versions/loader/${version}/${loaderVer}/server/jar`;
    }
    default:
      throw new Error("Unknown server type " + type);
  }
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(d)); }).on("error", reject);
  });
}

// Latest Forge build for an MC version (recommended, else latest).
async function resolveForgeVersion(mc) {
  const promo = await fetchJson("https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json");
  const p = promo.promos || {};
  return p[`${mc}-recommended`] || p[`${mc}-latest`] || null;
}
// Latest NeoForge build for an MC version. NeoForge versions look like
// 21.1.x for MC 1.21.1, 20.4.x for 1.20.4, etc.
async function resolveNeoForgeVersion(mc) {
  const xml = await fetchText("https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml");
  const all = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map(m => m[1]);
  const m = mc.match(/^1\.(\d+)(?:\.(\d+))?$/);
  if (!m) return all[all.length - 1] || null;
  const prefix = `${m[1]}.${m[2] || 0}.`;
  const matching = all.filter(v => v.startsWith(prefix));
  return matching.length ? matching[matching.length - 1] : null;
}

// Run a modded-server installer and wait for it to finish.
function runInstaller(java, cwd, installerName, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(java, ["-jar", installerName, ...args], { cwd });
    let out = "";
    proc.stdout.on("data", d => out += d);
    proc.stderr.on("data", d => out += d);
    proc.on("error", reject);
    proc.on("close", (code) => code === 0 ? resolve(out) : reject(new Error("Installer exited " + code + "\n" + out.slice(-500))));
  });
}

// Find a Forge/NeoForge launch args file directory (contains unix_args.txt).
function findArgFileDir(root) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name === "unix_args.txt" || e.name === "win_args.txt") return path.relative(root, dir).replace(/\\/g, "/");
    }
  }
  return null;
}

// Provision a server's files. Returns extra serverInfo fields (launch metadata).
async function provisionServer(serverDir, version, type, javaPath, loaderVersion, jarPath) {
  const t = (type || "").toLowerCase();
  // A jar of your own: a fork, a build you made, something with no download
  // service behind it at all. Copied in rather than fetched, and nothing else
  // about running it changes.
  if (t === "custom") {
    if (!jarPath) throw new Error("No server jar was chosen");
    if (!fs.existsSync(jarPath)) throw new Error(`There is no file at ${jarPath}`);
    fs.copyFileSync(jarPath, path.join(serverDir, "server.jar"));
    return { launchType: "jar", customJar: path.basename(jarPath) };
  }
  if (t === "forge" || t === "neoforge") {
    const isNeo = t === "neoforge";
    const build = isNeo ? await resolveNeoForgeVersion(version) : await resolveForgeVersion(version);
    if (!build) throw new Error(`No ${type} build found for Minecraft ${version}`);
    const installerName = "installer.jar";
    const url = isNeo
      ? `https://maven.neoforged.net/releases/net/neoforged/neoforge/${build}/neoforge-${build}-installer.jar`
      : `https://maven.minecraftforge.net/net/minecraftforge/forge/${version}-${build}/forge-${version}-${build}-installer.jar`;
    await download(url, path.join(serverDir, installerName));
    await runInstaller(javaPath || "java", serverDir, installerName, ["--installServer"]);
    const argDir = findArgFileDir(path.join(serverDir, "libraries")) || findArgFileDir(serverDir);
    if (!argDir) throw new Error(`${type} installed but no launch args file was produced`);
    return { launchType: "argfile", argFileDir: argDir.startsWith("libraries") ? argDir : path.join("libraries", argDir), buildVersion: build };
  }
  // Everything else is a single runnable jar.
  const jarUrl = await resolveJarUrl(version, type, loaderVersion);
  await download(jarUrl, path.join(serverDir, "server.jar"));
  return { launchType: "jar", customJar: null };
}

// --- Create a server ---
async function makeServer({ name, version, type, launchArgs, loaderVersion, icon, jarPath }, javaPath) {
  const serverDir = path.join(serversDir, name);
  fs.mkdirSync(serverDir, { recursive: true });

  const launchMeta = await provisionServer(serverDir, version, type, javaPath, loaderVersion, jarPath);

  // Leave the EULA UNaccepted — the launcher prompts the user on first launch.
  fs.writeFileSync(path.join(serverDir, "eula.txt"), "eula=false\n");
  if (!fs.existsSync(path.join(serverDir, "server.properties"))) {
    fs.writeFileSync(path.join(serverDir, "server.properties"), `motd=${name}\nserver-port=25565\n`);
  }

  // Save metadata (icon kept inline as a data: URL so it survives renames).
  const serverInfo = { name, version, type, launchArgs: launchArgs || "", loaderVersion: loaderVersion || "", icon: icon || "", ...launchMeta };
  fs.writeFileSync(path.join(serverDir, "serverinfo.json"), JSON.stringify(serverInfo, null, 2));

  const serverObj = { ...serverInfo, dir: serverDir, status: "stopped", process: null, logs: [] };
  servers.set(name, serverObj);
  return serverObj;
}

// --- Edit a server (rename, change version/type, launch args) ---
async function editServer(name, { newName, version, type, launchArgs, loaderVersion, icon, jarPath }, javaPath) {
  const dir = path.join(serversDir, name);
  const infoPath = path.join(dir, "serverinfo.json");
  if (!fs.existsSync(infoPath)) throw new Error("Server not found");
  const info = JSON.parse(fs.readFileSync(infoPath, "utf-8"));
  const live = servers.get(name);
  const running = !!(live && live.process);

  // A jar handed over is always a reason to re-provision: it is a different
  // file even when every other field is the same.
  const changedJar = !!jarPath
    || (version && version !== info.version)
    || (type && type.toLowerCase() !== (info.type || "").toLowerCase())
    || (loaderVersion !== undefined && loaderVersion !== info.loaderVersion);
  const renaming = !!(newName && newName !== name);

  // Editing a running server used to be refused outright, whatever was being
  // changed -- so a server had to be stopped to give it a different icon.
  // Only the changes that actually reach the running process are refused:
  // swapping its jar out underneath it, and renaming the folder it has open.
  // An icon is a field in a file, and the launch arguments are read at the
  // next start.
  if (running && (changedJar || renaming)) {
    throw new Error(renaming && !changedJar
      ? "Stop the server before renaming it"
      : "Stop the server before changing its version, type or jar");
  }

  if (version) info.version = version;
  if (type) info.type = type;
  if (launchArgs !== undefined) info.launchArgs = launchArgs;
  if (loaderVersion !== undefined) info.loaderVersion = loaderVersion;
  if (icon !== undefined) info.icon = icon;

  if (changedJar) {
    const meta = await provisionServer(dir, info.version, info.type, javaPath, info.loaderVersion, jarPath);
    Object.assign(info, { launchType: undefined, argFileDir: undefined, buildVersion: undefined }, meta);
  }
  fs.writeFileSync(infoPath, JSON.stringify(info, null, 2));

  let finalDir = dir, finalName = name;
  if (renaming) {
    const target = path.join(serversDir, newName);
    if (fs.existsSync(target)) throw new Error("A server with that name already exists");
    fs.renameSync(dir, target);
    info.name = newName;
    fs.writeFileSync(path.join(target, "serverinfo.json"), JSON.stringify(info, null, 2));
    servers.delete(name);
    finalDir = target; finalName = newName;
  }
  // The process, its status and its console belong to the RUN, not to the
  // description. Replacing the whole entry with a stopped one was fine while
  // editing meant the server was stopped, and would have thrown a running
  // server's process away the moment it did not.
  const serverObj = {
    ...info, name: finalName, dir: finalDir,
    status: live ? live.status : "stopped",
    process: live ? live.process : null,
    logs: live ? live.logs : [],
  };
  servers.set(finalName, serverObj);
  return { success: true, name: finalName };
}

// ── Outliving the launcher ──────────────────────────────────────────────────
//
// A server started as an ordinary child of the launcher dies with it, and its
// console only exists while the launcher holds its pipes. Keeping one running
// across a restart therefore needs two things the pipes were doing:
//
//   its output   the server writes logs/latest.log itself, so that is read
//                instead -- and read the same way whether the launcher
//                started it or found it, so there is one path, not two.
//   its input    RCON, which is the game's own remote console: a port, a
//                password the launcher generates, and a command.
//
// The process itself is spawned detached and unref'd, so quitting the
// launcher leaves it alone, and its pid is written where the launcher can
// find it again.

// Switch RCON on with a password of this server's own, and say which port.
// Returns { port, password } so they can be kept with the server.
function ensureRcon(dir, info) {
  const propsPath = path.join(dir, "server.properties");
  let text = "";
  try { text = fs.readFileSync(propsPath, "utf-8"); } catch { text = "" ; }

  // The text work is in backend/rcon.js, where it can be checked without a
  // server: keeping a port and a password that are already there is the part
  // that matters, because a new password out from under a launcher that
  // remembers the old one locks it out of its own server.
  const r = rcon.rconProps(text, { port: info.rconPort, password: info.rconPassword });
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (r.text !== text) fs.writeFileSync(propsPath, r.text);
  } catch { /* it will be asked for again next start */ }
  return { port: r.port, password: r.password };
}

const alive = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; }     // running, just not ours to signal
};

// The server's own log, read as it is appended. This is the console for a
// server the launcher did not start, and for one it did but let go of.
const tails = new Map();            // name -> { timer, at, held }

function startTail(name) {
  stopTail(name);
  const server = servers.get(name);
  if (!server) return;
  const file = path.join(server.dir, "logs", "latest.log");
  // From the end: what is already in the file is history, and the console
  // already has whatever of it the launcher saw.
  let at = 0;
  try { at = fs.statSync(file).size; } catch { at = 0; }
  const state = { at, held: "", timer: null };
  const read = () => {
    let size = 0;
    try { size = fs.statSync(file).size; } catch { return; }
    // A restart truncates it, or the server rolls it over.
    if (size < state.at) { state.at = 0; state.held = ""; }
    if (size === state.at) return;
    let fd = null;
    try {
      fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(size - state.at);
      fs.readSync(fd, buf, 0, buf.length, state.at);
      state.at = size;
      state.held += buf.toString("utf8");
      const lines = state.held.split(/\r?\n/);
      state.held = lines.pop();
      for (const line of lines) {
        if (!line.length) continue;
        server.logs.push(line + "\n");
        tell(name, line);
      }
    } catch { /* it will be read again in a moment */ }
    finally { if (fd != null) { try { fs.closeSync(fd); } catch { /* fine */ } } }
  };
  state.timer = setInterval(read, 700);
  if (state.timer.unref) state.timer.unref();
  tails.set(name, state);
}

function stopTail(name) {
  const t = tails.get(name);
  if (!t) return;
  clearInterval(t.timer);
  tails.delete(name);
}

// Watch a detached server's pid, so the launcher notices when it stops.
const pidWatchers = new Map();

function watchPid(name, pid) {
  const had = pidWatchers.get(name);
  if (had) clearInterval(had);
  const timer = setInterval(() => {
    if (alive(pid)) return;
    clearInterval(timer);
    pidWatchers.delete(name);
    const server = servers.get(name);
    if (server) { server.status = "stopped"; server.detachedPid = null; }
    stopTail(name);
    tell(name, null);
  }, 2000);
  if (timer.unref) timer.unref();
  pidWatchers.set(name, timer);
}

/**
 * Pick up a server that is still running from a previous launcher session.
 * `saved` is what `runningState()` handed over last time. Returns true when
 * the server was found alive and adopted.
 */
function adoptServer({ name, pid, rconPort, rconPassword } = {}) {
  const server = servers.get(name);
  if (!server || !pid || !alive(pid)) return false;
  server.status = "running";
  server.detachedPid = pid;
  if (rconPort) server.rconPort = rconPort;
  if (rconPassword) server.rconPassword = rconPassword;
  startTail(name);
  watchPid(name, pid);
  return true;
}

/** Every server the launcher is holding onto, for writing down. */
function runningState() {
  const out = [];
  for (const [name, s] of servers) {
    const pid = s.detachedPid || (s.process ? s.process.pid : null);
    if (!pid || s.status !== "running") continue;
    out.push({ name, pid, rconPort: s.rconPort || null, rconPassword: s.rconPassword || null });
  }
  return out;
}

// --- Server Lifecycle ---
function startServer(name, settings, javaPath) {
  // Accept a number or a "1024m"/"1024" string; emit a clean "-Xms1024m".
  const ramMB = (key, def) => {
    let v = settings ? settings.get(key, def) : def;
    const n = parseInt(String(v).replace(/[^\d]/g, ""), 10) || def;
    return n + "m";
  };
  const minRam = ramMB('ramServersMin', 1024);
  const maxRam = ramMB('ramServersMax', 4096);
  const server = servers.get(name);
  if (!server) throw new Error("Server not found");
  if (server.process) return; // already running
  // Or running without us holding it, from a previous launcher session.
  if (server.detachedPid && alive(server.detachedPid)) return;

  // Whether this server should outlive the launcher. RCON is set up either
  // way, so a server started attached can still be talked to after a restart
  // -- the setting only decides whether the process is left alone on quit.
  const detach = !!(settings && settings.get("serversOutliveLauncher", false));
  const creds = ensureRcon(server.dir, server);
  server.rconPort = creds.port;
  server.rconPassword = creds.password;
  try {
    const infoPath = path.join(server.dir, "serverinfo.json");
    const info = JSON.parse(fs.readFileSync(infoPath, "utf-8"));
    if (info.rconPort !== creds.port || info.rconPassword !== creds.password) {
      info.rconPort = creds.port;
      info.rconPassword = creds.password;
      fs.writeFileSync(infoPath, JSON.stringify(info, null, 2));
    }
  } catch { /* the properties file is the one that matters */ }

  // Use the launcher-resolved Java (correct major version for this MC version);
  // fall back to system "java" only if none was provided.
  const java = javaPath || "java";
  const extraArgs = server.launchArgs ? String(server.launchArgs).split(/\s+/).filter(Boolean) : [];

  let jvmArgs;
  if (server.launchType === "argfile" && server.argFileDir) {
    // Forge / NeoForge: launch via the generated @args file (classpath etc.).
    const argFile = path.join(server.argFileDir, process.platform === "win32" ? "win_args.txt" : "unix_args.txt");
    if (!fs.existsSync(path.join(server.dir, argFile))) throw new Error("Server launch args file missing (reinstall the server)");
    jvmArgs = ["-Xms" + minRam, "-Xmx" + maxRam, ...extraArgs, "@" + argFile, "nogui"];
  } else {
    const jarPath = path.join(server.dir, "server.jar");
    if (!fs.existsSync(jarPath)) throw new Error("Server jar missing");
    jvmArgs = ["-Xms" + minRam, "-Xmx" + maxRam, ...extraArgs, "-jar", jarPath, "nogui"];
  }
  // Detached: its own process group, nothing of ours attached to its pipes,
  // and unref'd so the launcher is free to quit. Its console comes from the
  // log it writes itself, which it would be writing anyway.
  const proc = detach
    ? spawn(java, jvmArgs, { cwd: server.dir, detached: true, stdio: "ignore" })
    : spawn(java, jvmArgs, { cwd: server.dir });

  server.status = "running";
  if (detach) {
    try { proc.unref(); } catch { /* fine */ }
    server.process = null;
    server.detachedPid = proc.pid;
    startTail(name);
    watchPid(name, proc.pid);
    return;
  }
  server.process = proc;
  server.detachedPid = null;

  // A watcher is told one LINE at a time.
  //
  // stdout arrives in chunks of whatever happened to be written, which is not
  // the same thing: a chunk may hold several lines, or stop halfway through
  // one. Handing the chunk straight to the watchers meant a line split across
  // two of them matched nothing -- which is why an event server's
  // "when a player joins" fired sometimes and not others -- and that two
  // players joining close together were one match between them, because a
  // regex over a chunk finds the first and stops.
  const feed = (prefix) => {
    let held = "";
    return (data) => {
      const text = prefix + data.toString();
      server.logs.push(text);
      held += text;
      const lines = held.split(/\r?\n/);
      held = lines.pop();                 // whatever came after the last newline
      for (const line of lines) if (line.length) tell(name, line);
      // A line with no newline after it is not finished, EXCEPT when it is the
      // prompt-like last line of a long pause. Held is flushed when the
      // process ends, which is the only point it is certainly complete.
      return held;
    };
  };
  const outFeed = feed("");
  const errFeed = feed("[ERR] ");
  let lastHeldOut = "", lastHeldErr = "";

  proc.stdout.on("data", (data) => {
    lastHeldOut = outFeed(data);
    console.log(`[SERVER ${name}] ${data.toString()}`);
  });

  proc.stderr.on("data", (data) => {
    lastHeldErr = errFeed(data);
    console.error(`[SERVER ${name}] ${data.toString()}`);
  });

  proc.on("close", () => {
    // Anything left without a newline after it still happened.
    for (const rest of [lastHeldOut, lastHeldErr]) if (rest && rest.length) tell(name, rest);
    server.process = null;
    server.status = "stopped";
    tell(name, null);                     // it has gone
  });
}

// ── Watching a server's console ──────────────────────────────────────────
//
// The console was only ever pulled -- getConsole hands back what has piled
// up. An event server has to act the moment the server says it has finished
// starting, or that somebody has joined, which means being told rather than
// asking. A watcher is given each line as it arrives, and null when the
// server stops.
const watchers = new Map();               // name -> Set<fn>
const allWatchers = new Set();            // fn(name, line), for every server

function tell(name, line) {
  for (const fn of [...allWatchers]) {
    try { fn(name, line); } catch { /* a watcher's problem is its own */ }
  }
  const set = watchers.get(name);
  if (!set) return;
  for (const fn of [...set]) {
    try { fn(line); } catch { /* a watcher's problem is its own */ }
  }
}

/**
 * Every server's console, as it happens.
 *
 * watchServer is for something that cares about one server it already knows
 * the name of. The window wants whichever one is open, and which one that is
 * changes while the launcher is running -- so it takes the lot and ignores
 * what it is not showing. Without this the console was PULLED, once a second,
 * which is exactly how far behind the launcher's console ran.
 */
function watchAllServers(fn) {
  allWatchers.add(fn);
  return () => allWatchers.delete(fn);
}

function watchServer(name, fn) {
  if (!watchers.has(name)) watchers.set(name, new Set());
  watchers.get(name).add(fn);
  return () => {
    const set = watchers.get(name);
    if (!set) return;
    set.delete(fn);
    if (!set.size) watchers.delete(name);
  };
}

function stopServer(name) {
  const server = servers.get(name);
  if (!server) throw new Error("Server not running");
  if (server.process) { server.process.stdin.write("stop\n"); return; }
  // Nothing of ours is attached to it, so it is asked over RCON the same way
  // any other command is.
  if (server.detachedPid && alive(server.detachedPid)) {
    return rcon.once({ port: server.rconPort, password: server.rconPassword }, "stop")
      .catch(() => {
        // RCON refused or is not up yet. Asking the process to stop is the
        // next best thing; the game treats SIGTERM as a clean shutdown.
        try { process.kill(server.detachedPid, "SIGTERM"); } catch { /* already gone */ }
      });
  }
  throw new Error("Server not running");
}

function restartServer(name, settings, javaPath) {
  const server = servers.get(name);
  if (server?.process) stopServer(name);
  setTimeout(() => startServer(name, settings, javaPath), 5000);
}

function sendServerCommand(name, cmd) {
  const server = servers.get(name);
  if (server && !server.process && server.detachedPid && alive(server.detachedPid)) {
    // Over RCON, and the reply goes into the console so it is not lost: a
    // command sent this way does not appear in the server's own log unless
    // the server chooses to log it.
    return rcon.once({ port: server.rconPort, password: server.rconPassword }, cmd)
      .then((reply) => {
        if (reply && reply.trim()) {
          server.logs.push(reply.trimEnd() + "\n");
          for (const line of reply.split(/\r?\n/)) if (line.length) tell(name, line);
        }
        return { success: true, reply: reply || "" };
      })
      .catch((e) => ({ success: false, error: e.message }));
  }
  if (!server?.process) throw new Error("Server not running");
  server.process.stdin.write(cmd + "\n");
}

// --- Server List / Console ---
function getServers() {
  const list = [];
  const folders = fs.readdirSync(serversDir, { withFileTypes: true });

  for (const folder of folders) {
    if (!folder.isDirectory()) continue;
    const infoPath = path.join(serversDir, folder.name, "serverinfo.json");
    if (!fs.existsSync(infoPath)) continue;

    const info = JSON.parse(fs.readFileSync(infoPath, "utf-8"));
    const server = servers.get(info.name) || {
      ...info,
      dir: path.join(serversDir, folder.name),
      status: "stopped",
      process: null,
      logs: []
    };
    servers.set(info.name, server);

    list.push({
      name: server.name,
      version: server.version,
      type: server.type,
      status: server.status,
      icon: server.icon || info.icon || ""
    });
  }

  return list;
}

function getConsole(name) {
  const server = servers.get(name);
  return server ? server.logs : [];
}

// --- Delete a server (stops it first) ---
function deleteServer(name) {
  const server = servers.get(name);
  try { if (server?.process) server.process.kill(); } catch { /* ignore */ }
  // One of ours from a previous session has to be stopped too, or the folder
  // is deleted from underneath a running server.
  if (server?.detachedPid && alive(server.detachedPid)) {
    try { process.kill(server.detachedPid, "SIGTERM"); } catch { /* already gone */ }
  }
  stopTail(name);
  const watching = pidWatchers.get(name);
  if (watching) { clearInterval(watching); pidWatchers.delete(name); }
  servers.delete(name);
  const dir = path.join(serversDir, name);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  return { success: true };
}

// --- server.properties read/write ---
function getServerProperties(name) {
  const p = path.join(serversDir, name, "server.properties");
  try { return fs.readFileSync(p, "utf-8"); } catch { return ""; }
}

function saveServerProperties(name, text) {
  const p = path.join(serversDir, name, "server.properties");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return { success: true };
}

// Read the configured server port from server.properties (defaults to 25565).
function getServerPort(name) {
  const props = getServerProperties(name);
  const m = props.match(/^server-port\s*=\s*(\d+)/m);
  return m ? Number(m[1]) : 25565;
}

// --- Simple file explorer (scoped to the server's folder) ---
function safeServerPath(name, rel) {
  const root = path.resolve(path.join(serversDir, name));
  const target = path.resolve(path.join(root, rel || ""));
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

function listFiles(name, rel) {
  const dir = safeServerPath(name, rel);
  if (!dir || !fs.existsSync(dir)) return { path: rel || "", entries: [] };
  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) return { path: rel || "", entries: [] };
  const entries = fs.readdirSync(dir, { withFileTypes: true }).map(d => {
    let size = 0;
    try { size = d.isFile() ? fs.statSync(path.join(dir, d.name)).size : 0; } catch { /* ignore */ }
    return { name: d.name, isDir: d.isDirectory(), size };
  });
  // Folders first, then files, alphabetical.
  entries.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
  return { path: (rel || "").replace(/\\/g, "/"), entries };
}

// Read a file's text (returns { text } or { binary:true } for non-text).
function readFile(name, rel) {
  const p = safeServerPath(name, rel);
  if (!p || !fs.existsSync(p) || fs.statSync(p).isDirectory()) return { error: "Not a file" };
  try {
    const buf = fs.readFileSync(p);
    // Heuristic: treat as binary if it has NUL bytes in the first chunk.
    if (buf.slice(0, 8000).includes(0)) return { binary: true };
    return { text: buf.toString("utf-8") };
  } catch (e) { return { error: e.message }; }
}

function writeFile(name, rel, text) {
  const p = safeServerPath(name, rel);
  if (!p) return { error: "Invalid path" };
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return { success: true }; }
  catch (e) { return { error: e.message }; }
}

function deleteFile(name, rel) {
  const p = safeServerPath(name, rel);
  if (!p || p === path.resolve(path.join(serversDir, name))) return { error: "Invalid path" };
  try { fs.rmSync(p, { recursive: true, force: true }); return { success: true }; }
  catch (e) { return { error: e.message }; }
}

// Single-server info incl. live status.
function getServerInfo(name) {
  const server = servers.get(name);
  const dir = path.join(serversDir, name);
  let info = { name };
  try { info = JSON.parse(fs.readFileSync(path.join(dir, "serverinfo.json"), "utf-8")); } catch { /* ignore */ }
  return {
    ...info,
    dir,
    status: server?.status || "stopped",
    port: getServerPort(name),
  };
}

export default {
  makeServer,
  editServer,
  startServer,
  stopServer,
  adoptServer,
  runningState,
  ensureRcon,
  restartServer,
  sendServerCommand,
  getServers,
  getConsole,
  deleteServer,
  getServerProperties,
  saveServerProperties,
  getServerPort,
  getServerInfo,
  listFiles,
  readFile,
  writeFile,
  deleteFile,
  safeServerPath,
  watchServer,
  watchAllServers,
};
