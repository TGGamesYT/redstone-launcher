const path = require('path');
const { exec } = require("child_process");
const https = require("https");
const fs = require('fs');
const fetch = require('node-fetch');
const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
const { vanilla, fabric, quilt, forge, neoforge } = require('tomate-loaders');
const { Client, Authenticator } = require('minecraft-launcher-core');
const { Auth } = require('msmc');
const serverManager = require("./serverManager");
const FormData = require('form-data');

const dataDir = path.join(app.getPath('userData'));
const profilesPath = path.join(dataDir, 'profiles.json');
const playersPath = path.join(dataDir, 'players.json');

// Ensure files exist
if (!fs.existsSync(profilesPath)) fs.writeFileSync(profilesPath, JSON.stringify([]));
if (!fs.existsSync(playersPath)) fs.writeFileSync(playersPath, JSON.stringify([]));

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
let mainWindow;
function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    icon: path.join(dataDir, 'assets', 'icon.png'),
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  win.loadFile('frontend/index.html');
  mainWindow = win
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
    loader: profile.loader || "vanilla"
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

  const rootDir = path.join(dataDir, 'client', String(profile.id));
  fs.mkdirSync(rootDir, { recursive: true });

  const launcher = new Client();
  let loaderer;
  if (profile.loader == "fabric") {
    loaderer = fabric
  } else if (profile.loader == "quilt") {
    loaderer = quilt
  } else if (profile.loader == "forge") {
    loaderer = forge
  } else if (profile.loader == "neoforge") {
    loaderer = neoforge
  } else {
    loaderer = vanilla
  } 
  const launcherConfig = await loaderer.getMCLCLaunchConfig({
    gameVersion: profile.version,
    rootPath: rootDir
  });
  launcher.launch({
    ...launcherConfig,
    authorization: auth,
    memory: { max: "4G", min: "1G" },
    overrides: {
      detached: false
    }
  });

  launcher.on('debug', (msg) => event.reply('launcher-log', msg));
  launcher.on('data', (msg) => event.reply('launcher-log', msg));
  launcher.on('error', (err) => event.reply('launcher-log', "ERROR: " + err.message));
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

/* ─────────────── Modrinth ─────────────── */

ipcMain.on("open-modrinth-browser", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const wc = mainWindow.webContents;

  // Remove previous listeners to avoid duplicates
  wc.session.removeAllListeners("will-download");

  // Intercept download requests
  wc.session.on("will-download", (event, item) => {
    const url = item.getURL();

    if (url.includes("cdn.modrinth.com/data/") && url.endsWith(".jar")) {
      event.preventDefault(); // stop default save dialog
      const encoded = encodeURIComponent(url);

      // Navigate main window to modrinth.html instead
      mainWindow.loadFile("frontend/modrinth.html", {
        query: { file: encoded }
      });
    }
  });

  // Load the actual Modrinth site inside the main window
  mainWindow.loadURL("https://modrinth.com");
});


ipcMain.handle("mod-download", async (event, { instanceId, fileUrl }) => {
  try {
    const profiles = loadProfiles();
    const profile = profiles.find(p => p.id === parseInt(instanceId));
    if (!profile) throw new Error("Instance not found");

    const modsDir = path.join(app.getPath("userData"), "client", String(profile.id), "mods");
    fs.mkdirSync(modsDir, { recursive: true });

    const fileName = path.basename(new URL(fileUrl).pathname);
    const dest = path.join(modsDir, fileName);

    await downloadFile(fileUrl, dest);

    return { success: true, path: dest };
  } catch (err) {
    console.error("Failed to download mod:", err);
    return { success: false, error: err.message };
  }
});

/* ─────────────── Access Token for skin changing ─────────────── */

// Returns the full player object
ipcMain.handle("get-player", async (event, playerId) => {
  const players = loadPlayers();
  const player = players.find(p => p.id === Number(playerId));
  if (!player) throw new Error("Player not found");
  return player; // return the whole object
});

ipcMain.handle('set-player-skin', async (event, { playerId, skinPath, model }) => {
    const players = loadPlayers();
    const player = players.find(p => p.id === Number(playerId));
    if (!player || player.type !== 'microsoft') throw new Error('Invalid Microsoft player');

    const token = player.auth.access_token;

    const skinBuffer = fs.readFileSync(skinPath);
    const fileName = require('path').basename(skinPath);

    const form = new FormData();
    form.append('model', model);
    form.append('file', skinBuffer, { filename: fileName });

    const res = await fetch('https://api.minecraftservices.com/minecraft/profile/skins', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            ...form.getHeaders()
        },
        body: form
    });

    if (!res.ok) throw new Error(`Failed to upload skin: ${res.statusText}`);
});



/* ─────────────── Helpers ─────────────── */
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
