const path = require('path');
const { exec } = require("child_process");
const https = require("https");
const fs = require('fs');
const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
const { Client, Authenticator } = require('minecraft-launcher-core');
const { Auth } = require('msmc');
const serverManager = require("./serverManager");


const profilesPath = path.join(__dirname, 'profiles.json');
const playersPath = path.join(__dirname, 'players.json');

// Ensure files exist
if (!fs.existsSync(profilesPath)) fs.writeFileSync(profilesPath, JSON.stringify([]));
if (!fs.existsSync(playersPath)) fs.writeFileSync(playersPath, JSON.stringify([]));

// Load & save helpers
// Load & save helpers
function ensureFile(path) {
  if (!fs.existsSync(path)) fs.writeFileSync(path, JSON.stringify([]));
}

function loadProfiles() {
  ensureFile(profilesPath);
  return JSON.parse(fs.readFileSync(profilesPath));
}
function saveProfiles(p) { fs.writeFileSync(profilesPath, JSON.stringify(p, null, 2)); }

function loadPlayers() {
  ensureFile(playersPath);
  return JSON.parse(fs.readFileSync(playersPath));
}
function savePlayers(p) { fs.writeFileSync(playersPath, JSON.stringify(p, null, 2)); }
function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  win.loadFile('frontend/index.html');
}

/* ─────────────── Player Profiles ─────────────── */

// Add cracked player
ipcMain.on('create-cracked-player', (event, username) => {
  const players = loadPlayers();
  const newPlayer = { id: Date.now(), type: 'cracked', username };
  players.push(newPlayer);
  savePlayers(players);
  event.reply('players-updated', players);
});

// Start Microsoft login flow
ipcMain.on("login-microsoft", async (event) => {
  try {
    const authManager = new Auth("select_account"); // use desired prompt
    const xboxManager = await authManager.launch("electron"); // launch Electron login window
    const token = await xboxManager.getMinecraft(); // retrieves session token

    // Convert token to launcher-compatible auth
    const launcherAuth = token.mclc();

    // Save player in players.json
    const players = loadPlayers();
    players.push({
      id: Date.now(),
      type: "microsoft",
      auth: launcherAuth
    });
    savePlayers(players);
    event.reply("players-updated", players);

  } catch (err) {
    console.error("MS login failed:", err);
    event.reply("login-error", "MS login failed: " + err.message);
  }
});

// Get all players
ipcMain.on('get-players', (event) => {
  event.reply('players-list', loadPlayers());
});

/* ─────────────── Game Profiles ─────────────── */

// Create game profile
ipcMain.on('create-profile', (event, profile) => {
  const profiles = loadProfiles();

  const newProfile = {
    id: Date.now(),
    name: profile.name,
    version: profile.version || "1.20.1",
    playerId: profile.playerId // link to a player
  };

  profiles.push(newProfile);
  saveProfiles(profiles);

  event.reply('profiles-updated', profiles);
});

// Get game profiles
ipcMain.on('get-profiles', (event) => {
  event.reply('profiles-list', loadProfiles());
});

// Launch profile
ipcMain.on('launch-profile', async (event, { profileId, playerId }) => {
  const profiles = loadProfiles();
  const players = loadPlayers();

  const profile = profiles.find(p => p.id === profileId);
  if (!profile) return event.reply('launch-error', "Profile not found");

  const player = players.find(p => p.id === playerId);
  if (!player) return event.reply('launch-error', "Player not found");

  let auth;
  if (player.type === "cracked") {
    auth = { name: player.username, uuid: "0", access_token: "0" };
  } else {
    auth = player.auth;
  }

  const rootDir = path.join(__dirname, 'client', String(profile.id));
  fs.mkdirSync(rootDir, { recursive: true });

  const launcher = new Client();
  launcher.launch({
    authorization: auth,
    root: rootDir,
    version: { number: profile.version, type: versionToType(profile.version) },
    memory: { max: "4G", min: "1G" },
    overrides: {
      detached: false
    }
  });

  launcher.on('debug', (msg) => event.reply('launcher-log', msg));
  launcher.on('data', (msg) => event.reply('launcher-log', msg));
  launcher.on('error', (err) => event.reply('launcher-log', "ERROR: " + err.message));
});

/* ─────────────── modloaders ─────────────── */

ipcMain.on("install-modloader", async (event, { type, version, instanceId }) => {
  try {
    const instanceDir = path.join(__dirname, "client", String(instanceId));
    fs.mkdirSync(instanceDir, { recursive: true });

    let installerUrl;
    let installerName;

    switch(type.toLowerCase()) {
      case "fabric":
        installerUrl = "https://maven.fabricmc.net/net/fabricmc/fabric-installer/1.1.0/fabric-installer-1.1.0.jar";
        installerName = "fabric-installer.jar";
        break;
      case "quilt":
        installerUrl = "https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer/0.16.0/quilt-installer-0.16.0.jar";
        installerName = "quilt-installer.jar";
        break;
      case "forge":
        installerUrl = "https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-47.0.82/forge-1.20.1-47.0.82-installer.jar";
        installerName = "forge-installer.jar";
        break;
      case "neoforge":
        installerUrl = "https://neoforge.net/downloads/installer/1.20.1-neoforge-installer.jar";
        installerName = "neoforge-installer.jar";
        break;
      default:
        return event.reply("modloader-error", "Unknown modloader type");
    }

    const installerPath = path.join(instanceDir, installerName);

    // Helper to download file with redirect support
    function downloadFile(url, dest) {
      return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https.get(url, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            // follow redirect
            downloadFile(res.headers.location, dest).then(resolve).catch(reject);
            return;
          }
          res.pipe(file);
          file.on("finish", () => file.close(resolve));
        }).on("error", (err) => {
          fs.unlink(dest, ()=>{}); // delete partial file
          reject(err);
        });
      });
    }

    //create a dummy launcher profiles json

    const launcherProfile = {
      profiles: {
        "redstone-temp": {
          name: "Redstone Temp",
          lastVersionId: version,
          type: "custom"
        }
      }
    };

    fs.writeFileSync(
      path.join(instanceDir, "launcher_profiles.json"),
      JSON.stringify(launcherProfile, null, 2)
    );

    // Download the installer
    await downloadFile(installerUrl, installerPath);

    // Build the command
    let cmd;
    if(type.toLowerCase() === "fabric" || type.toLowerCase() === "quilt") {
      cmd = `java -jar "${installerPath}" client -dir "${instanceDir}" -mcversion ${version}`;
    } else { // forge/neoforge
      cmd = `java -jar "${installerPath}" --installClient -mcdir "${instanceDir}"`;
    }

    const child = exec(cmd);
    child.stdout.on("data", (data) => event.reply("modloader-log", data.toString()));
    child.stderr.on("data", (data) => event.reply("modloader-log", data.toString()));
    child.on("exit", () => event.reply("modloader-done", type));

  } catch (err) {
    event.reply("modloader-error", err.message);
  }
});

//shi

ipcMain.handle("make-server", async (event, params) => {
  return await serverManager.makeServer(params);
});

ipcMain.handle("start-server", (event, id) => {
  return serverManager.startServer(id);
});

ipcMain.handle("stop-server", (event, id) => {
  return serverManager.stopServer(id);
});

ipcMain.handle("restart-server", (event, id) => {
  return serverManager.restartServer(id);
});

ipcMain.handle("list-servers", () => {
  return serverManager.getServers();
});

ipcMain.handle("server-console", (event, id) => {
  return serverManager.getConsole(id);
});

ipcMain.handle("send-server-command", (event, id, cmd) => {
  return serverManager.sendServerCommand(id, cmd);
});




/* ─────────────── Helpers ─────────────── */
function versionToType(version) {
  return version.includes('.') ? "release" : "snapshot";
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // redirect
        downloadFile(res.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      res.pipe(file);
      file.on("finish", () => {
        file.close(resolve); // close ensures file is fully written
      });
    }).on("error", (err) => {
      fs.unlink(dest, ()=>{}); // delete partial file
      reject(err);
    });
  });
}


app.whenReady().then(createWindow);
