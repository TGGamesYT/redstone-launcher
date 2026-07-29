import fs from "fs";
import path from "path";
import https from "https";
import { spawn } from "child_process";
import { app } from 'electron';

const servers = new Map(); // name → { proc, config, logs }
const dataDir = path.join(app.getPath('userData'));
const serversDir = path.join(dataDir, "servers");
fs.mkdirSync(serversDir, { recursive: true });

// Helper: download file
function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode !== 200) return reject(new Error("Download failed " + res.statusCode));
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve(dest)));
    }).on("error", reject);
  });
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
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
      const versionInfo = await fetchJson(`https://api.papermc.io/v2/projects/${proj}/versions/${version}`);
      const latestBuild = Math.max(...versionInfo.builds);
      const buildInfo = await fetchJson(`https://api.papermc.io/v2/projects/${proj}/versions/${version}/builds/${latestBuild}`);
      const fileName = buildInfo.downloads.application.name;
      return `https://api.papermc.io/v2/projects/${proj}/versions/${version}/builds/${latestBuild}/downloads/${fileName}`;
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
async function provisionServer(serverDir, version, type, javaPath, loaderVersion) {
  const t = (type || "").toLowerCase();
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
  return { launchType: "jar" };
}

// --- Create a server ---
async function makeServer({ name, version, type, launchArgs, loaderVersion, icon }, javaPath) {
  const serverDir = path.join(serversDir, name);
  fs.mkdirSync(serverDir, { recursive: true });

  const launchMeta = await provisionServer(serverDir, version, type, javaPath, loaderVersion);

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
async function editServer(name, { newName, version, type, launchArgs, loaderVersion, icon }, javaPath) {
  const dir = path.join(serversDir, name);
  const infoPath = path.join(dir, "serverinfo.json");
  if (!fs.existsSync(infoPath)) throw new Error("Server not found");
  const info = JSON.parse(fs.readFileSync(infoPath, "utf-8"));
  if (servers.get(name)?.process) throw new Error("Stop the server before editing it");

  const changedJar = (version && version !== info.version) || (type && type.toLowerCase() !== (info.type || "").toLowerCase()) || (loaderVersion !== undefined && loaderVersion !== info.loaderVersion);
  if (version) info.version = version;
  if (type) info.type = type;
  if (launchArgs !== undefined) info.launchArgs = launchArgs;
  if (loaderVersion !== undefined) info.loaderVersion = loaderVersion;
  if (icon !== undefined) info.icon = icon;

  if (changedJar) {
    const meta = await provisionServer(dir, info.version, info.type, javaPath, info.loaderVersion);
    Object.assign(info, { launchType: undefined, argFileDir: undefined, buildVersion: undefined }, meta);
  }
  fs.writeFileSync(infoPath, JSON.stringify(info, null, 2));

  let finalDir = dir, finalName = name;
  if (newName && newName !== name) {
    const target = path.join(serversDir, newName);
    if (fs.existsSync(target)) throw new Error("A server with that name already exists");
    fs.renameSync(dir, target);
    info.name = newName;
    fs.writeFileSync(path.join(target, "serverinfo.json"), JSON.stringify(info, null, 2));
    servers.delete(name);
    finalDir = target; finalName = newName;
  }
  const serverObj = { ...info, name: finalName, dir: finalDir, status: "stopped", process: null, logs: [] };
  servers.set(finalName, serverObj);
  return { success: true, name: finalName };
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
  const proc = spawn(java, jvmArgs, { cwd: server.dir });

  server.process = proc;
  server.status = "running";

  proc.stdout.on("data", (data) => {
    const msg = data.toString();
    server.logs.push(msg);
    console.log(`[SERVER ${name}] ${msg}`);
  });

  proc.stderr.on("data", (data) => {
    const msg = "[ERR] " + data.toString();
    server.logs.push(msg);
    console.error(`[SERVER ${name}] ${msg}`);
  });

  proc.on("close", () => {
    server.process = null;
    server.status = "stopped";
  });
}

function stopServer(name) {
  const server = servers.get(name);
  if (!server?.process) throw new Error("Server not running");
  server.process.stdin.write("stop\n");
}

function restartServer(name, settings, javaPath) {
  const server = servers.get(name);
  if (server?.process) stopServer(name);
  setTimeout(() => startServer(name, settings, javaPath), 5000);
}

function sendServerCommand(name, cmd) {
  const server = servers.get(name);
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
};
