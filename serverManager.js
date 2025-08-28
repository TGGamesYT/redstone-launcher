const fs = require("fs");
const path = require("path");
const https = require("https");
const { spawn } = require("child_process");

const servers = new Map(); // name → { proc, config, logs }
const serversDir = path.join(__dirname, "servers");
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

// --- Create a server ---
async function makeServer({ name, version, type }) {
  const serverDir = path.join(serversDir, name);
  fs.mkdirSync(serverDir, { recursive: true });

  let jarUrl;

  switch (type.toLowerCase()) {
    case "vanilla": {
      const manifest = await fetchJson("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json");
      const entry = manifest.versions.find(v => v.id === version);
      if (!entry) throw new Error(`Vanilla version ${version} not found`);
      const metadata = await fetchJson(entry.url);
      jarUrl = metadata.downloads.server.url;
      break;
    }
    case "paper": {
      const versionInfo = await fetchJson(`https://api.papermc.io/v2/projects/paper/versions/${version}`);
      const latestBuild = Math.max(...versionInfo.builds);
      const buildInfo = await fetchJson(`https://api.papermc.io/v2/projects/paper/versions/${version}/builds/${latestBuild}`);
      const fileName = buildInfo.downloads.application.name;
      jarUrl = `https://api.papermc.io/v2/projects/paper/versions/${version}/builds/${latestBuild}/downloads/${fileName}`;
      break;
    }
    case "fabric": {
      jarUrl = `https://meta.fabricmc.net/v2/versions/loader/${version}/0.14.23/${version}/server/jar`;
      break;
    }
    default:
      throw new Error("Unknown server type " + type);
  }

  const jarPath = path.join(serverDir, "server.jar");
  await download(jarUrl, jarPath);

  fs.writeFileSync(path.join(serverDir, "eula.txt"), "eula=true\n");
  fs.writeFileSync(path.join(serverDir, "server.properties"), `motd=${name}\nserver-port=25565\n`);

  // Save metadata
  const serverInfo = { name, version, type };
  fs.writeFileSync(path.join(serverDir, "serverinfo.json"), JSON.stringify(serverInfo, null, 2));

  const serverObj = { ...serverInfo, dir: serverDir, status: "stopped", process: null, logs: [] };
  servers.set(name, serverObj);
  return serverObj;
}

// --- Server Lifecycle ---
function startServer(name) {
  const server = servers.get(name);
  if (!server) throw new Error("Server not found");

  const jarPath = path.join(server.dir, "server.jar");
  if (!fs.existsSync(jarPath)) throw new Error("Server jar missing");

  const proc = spawn("java", ["-Xmx2G", "-jar", jarPath, "nogui"], { cwd: server.dir });

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

function restartServer(name) {
  stopServer(name);
  setTimeout(() => startServer(name), 5000);
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
      status: server.status
    });
  }

  return list;
}

function getConsole(name) {
  const server = servers.get(name);
  return server ? server.logs : [];
}

module.exports = {
  makeServer,
  startServer,
  stopServer,
  restartServer,
  sendServerCommand,
  getServers,
  getConsole
};
