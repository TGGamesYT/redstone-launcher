const path = require('path');
const { exec } = require("child_process");
const https = require("https");
const fs = require('fs');
const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
const { Client, Authenticator } = require('minecraft-launcher-core');
const { Auth } = require('msmc');


const profilesPath = path.join(__dirname, 'profiles.json');
const playersPath = path.join(__dirname, 'players.json');

// Ensure files exist
if (!fs.existsSync(profilesPath)) fs.writeFileSync(profilesPath, JSON.stringify([]));
if (!fs.existsSync(playersPath)) fs.writeFileSync(playersPath, JSON.stringify([]));

// Load & save helpers
function loadProfiles() { return JSON.parse(fs.readFileSync(profilesPath)); }
function saveProfiles(p) { fs.writeFileSync(profilesPath, JSON.stringify(p, null, 2)); }

function loadPlayers() { return JSON.parse(fs.readFileSync(playersPath)); }
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

// Create cracked player
ipcMain.on("create-cracked-player", (event, username) => {
  const players = loadPlayers();

  const newPlayer = {
    id: Date.now(),
    type: "cracked",
    username: username
  };

  players.push(newPlayer);
  savePlayers(players);

  event.reply("players-updated", players);
});

// Get game profiles
ipcMain.on('get-profiles', (event) => {
  event.reply('profiles-list', loadProfiles());
});

// Launch profile
ipcMain.on('launch-profile', async (event, profileId) => {
  const profiles = loadProfiles();
  const players = loadPlayers();

  const profile = profiles.find(p => p.id === profileId);
  if (!profile) return event.reply('launch-error', "Profile not found");

  const player = players.find(p => p.id === profile.playerId);
  if (!player) return event.reply('launch-error', "Player not found");

  const launcher = new Client();
  let auth;

  if (player.type === "cracked") {
  auth = { name: player.username, uuid: "0", access_token: "0" };
} else {
  try {
    // Just use the stored Microsoft token; msmc tokens don’t need Mojang refresh
    auth = player.auth;
  } catch (err) {
    return event.reply('launch-error', "Microsoft login invalid, please re-login");
  }
  }

  const rootDir = path.join(__dirname, 'minecraft', String(profile.id));
  fs.mkdirSync(rootDir, { recursive: true });

  launcher.launch({
    authorization: auth,
    root: rootDir,
    version: { number: profile.version, type: versionToType(profile.version) },
    memory: { max: "4G", min: "1G" }
  });

  launcher.on('debug', (msg) => event.reply('launcher-log', msg));
  launcher.on('data', (msg) => event.reply('launcher-log', msg));
  launcher.on('error', (err) => event.reply('launcher-log', "ERROR: " + err.message));
});

/* ─────────────── modloaders ─────────────── */

ipcMain.on("install-modloader", async (event, { type, version, instanceId }) => {
  try {
    const instanceDir = path.join(__dirname, "minecraft", String(instanceId));
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

    // Download the installer
    await downloadFile(installerUrl, installerPath);

    // Build the command
    let cmd;
    if(type.toLowerCase() === "fabric" || type.toLowerCase() === "quilt") {
      cmd = `java -jar "${installerPath}" client -dir "${instanceDir}" -snapshot -mcversion ${version}`;
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
