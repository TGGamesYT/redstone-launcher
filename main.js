import path from 'path';
import https from 'https';
import fs from 'fs';
import fetch from 'node-fetch';
import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { vanilla, fabric, quilt, forge, neoforge } from 'tomate-loaders';
import { Client } from 'minecraft-launcher-core';
import { Auth } from 'msmc';
import serverManager from './serverManager.js';
import FormData from 'form-data';
import AdmZip from 'adm-zip';
import Store from 'electron-store';

const storage = new Store();


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
const iconPath = path.join(process.resourcesPath, 'frontend', 'icon.png');
const preload = path.join(process.resourcesPath, 'preload.js');
function createWindow() {
  const win = new BrowserWindow({
    width: 1500,
    height: 1050,
    icon: path.join(iconPath),
    frame: false, 
    webPreferences: { 
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  win.setAccentColor('#FF0000');
  win.loadFile('frontend/index.html');
  mainWindow = win
}

/* ─────────────── Storing ─────────────── */

ipcMain.handle("get-selected-player", () => storage.get("selectedPlayerId", null));
ipcMain.on("set-selected-player", (event, id) => {
  storage.set("selectedPlayerId", id);
});


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
    loader: profile.loader || "vanilla",
    icon: profile.icon || "https://tggamesyt.dev/assets/redstone_launcher_defaulticon.png"
  };

  profiles.push(newProfile);
  saveProfiles(profiles);

  event.reply('profiles-updated', profiles);
});

ipcMain.on('edit-profile', (event, updatedProfile) => {
  const profiles = loadProfiles();
  const index = profiles.findIndex(p => p.id === updatedProfile.id);

  if (index === -1) {
    event.reply('edit-profile-error', `Profile with id ${updatedProfile.id} not found`);
    return;
  }

  // Merge updated fields into the existing profile
  profiles[index] = {
    ...profiles[index],
    ...updatedProfile
  };

  saveProfiles(profiles);
  event.reply('profiles-updated', profiles);
});


ipcMain.on("delete-profile", (event, profileId) => {
  const profiles = loadProfiles();
  const id = parseInt(profileId, 10);

  const newProfiles = profiles.filter(p => p.id !== id);

  if (newProfiles.length === profiles.length) {
    event.reply("delete-profile-error", `Profile with id ${id} not found`);
    return;
  }

  // Delete folder: datadir/client/PROFILEID
  const profilePath = path.join(dataDir, "client", String(id));
  try {
    if (fs.existsSync(profilePath)) {
      fs.rmSync(profilePath, { recursive: true, force: true });
    }
  } catch (err) {
    console.error("Failed to delete profile folder:", err);
  }

  saveProfiles(newProfiles);
  event.reply("profiles-updated", newProfiles);
});

ipcMain.on("close-app", () => {
  app.quit();
});

ipcMain.on("min-app", () => {
  mainWindow.minimize();
});

ipcMain.on("max-app", () => {
  if (!mainWindow.isMaximized()) {mainWindow.maximize()} else {mainWindow.unmaximize};
});

// Get game profiles
ipcMain.on('get-profiles', (event) => {
  event.reply('profiles-list', loadProfiles());
});

// Import .mrpack
ipcMain.handle("import-mrpack", async () => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: "Select .mrpack file",
      filters: [{ name: "Modrinth Pack", extensions: ["mrpack"] }],
      properties: ["openFile"]
    });

    if (canceled || !filePaths.length) return { success: false, error: "No file selected" };

    const mrpackPath = filePaths[0];
    return mrpack(mrpackPath);
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("handle-mrpack-quickplay", async (event, { accountId, serverIp, mrpackUrl }) => {
  try {
    if (!accountId) throw new Error("No account selected");

    if (!mrpackUrl) throw new Error("Invalid or missing mrpack Path");

    // import the mrpack
    const result = await mrpackFromUrl(mrpackUrl);
    if (!result.success) return result;

    const profile_main = result.profile;

    // trigger launch with quickplay
    let profileId = profile.id
    let playerId = accountId
    let quickplaybool = true
    let quickplayip = serverIp

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
  let quickplay = null;
  if (quickplaybool) {
    quickplay = {
      "type": 'legacy',
      "identifier": quickplayip
    }
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
  let opts = {
    ...launcherConfig,
    authorization: auth,
    memory: { max: "4G", min: "1G" },
    overrides: {
      detached: false
    },
    quickplay
  }
  launcher.launch(opts);

  launcher.on('debug', (msg) => event.reply('launcher-log', msg));
  launcher.on('error', (err) => event.reply('launcher-log', "ERROR: " + err.message));

    return { success: true, profile_main };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

async function mrpackFromUrl(url) {
  const tmpFile = join(os.tmpdir(), `tmp-${Date.now()}.mrpack`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download mrpack: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(tmpFile, buffer);
  return mrpack(tmpFile); // call your existing mrpack() function
}

async function mrpack(mrpackPath) {
  const zip = new AdmZip(mrpackPath);

    const indexEntry = zip.getEntry("modrinth.index.json");
    if (!indexEntry) return { success: false, error: "modrinth.index.json not found in .mrpack" };
    const indexJson = JSON.parse(indexEntry.getData().toString("utf8"));

    // Determine loader and Minecraft version
    const deps = indexJson.dependencies || {};
    let loader = "vanilla";
    if (deps["fabric-loader"]) loader = "fabric";
    else if (deps["quilt-loader"]) loader = "quilt";
    else if (deps["forge"]) loader = "forge";
    else if (deps["neoforge"]) loader = "neoforge";
    const mcVersion = deps["minecraft"] || "1.20.1";

    // Create instance folder
    const profileId = Date.now();
    const profilesDir = path.join(dataDir, "client");
    if (!fs.existsSync(profilesDir)) fs.mkdirSync(profilesDir, { recursive: true });
    const profileFolder = path.join(profilesDir, `${profileId}`);
    fs.mkdirSync(profileFolder);

    // Handle overrides inside the .mrpack (everything except modrinth.index.json)
zip.getEntries().forEach(entry => {
  if (!entry.isDirectory && entry.entryName !== "modrinth.index.json") {
    // If the entry is inside "overrides/", strip that prefix
    let relativePath = entry.entryName;
    if (relativePath.startsWith("overrides/")) {
      relativePath = relativePath.slice("overrides/".length);
    }

    // Only process files inside overrides or other root-level files
    if (!relativePath) return;

    const entryPath = path.join(profileFolder, relativePath);
    const entryDir = path.dirname(entryPath);
    if (!fs.existsSync(entryDir)) fs.mkdirSync(entryDir, { recursive: true });
    fs.writeFileSync(entryPath, entry.getData());
  }
});

    // Download files listed in indexJson.files
    for (const fileObj of indexJson.files || []) {
      const filePath = path.join(profileFolder, fileObj.path.replace(/\//g, path.sep));
      const fileDir = path.dirname(filePath);
      if (!fs.existsSync(fileDir)) fs.mkdirSync(fileDir, { recursive: true });

      const url = fileObj.downloads[0]; // we take the first URL
      await downloadFile(url, filePath)
    }

    // Optional: read icon from pack
    let icon = null;
    const iconEntry = zip.getEntry("icon.png");
    if (iconEntry) icon = iconEntry.getData().toString("base64");

    const newProfile = {
      id: profileId,
      name: indexJson.name || "Imported Profile",
      version: mcVersion,
      loader,
      icon,
      folder: profileFolder,
      files: indexJson.files || []
    };

    const profiles = loadProfiles();
    profiles.push(newProfile);
    saveProfiles(profiles);

    return { success: true, profile: newProfile };
}

// Launch profile
ipcMain.on('launch-profile', async (event, { profileId, playerId, quickplaybool, quickplayip }) => {
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
  let quickplay = null;
  if (quickplaybool) {
    quickplay = {
      "type": 'legacy',
      "identifier": quickplayip
    }
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
  let opts = {
    ...launcherConfig,
    authorization: auth,
    memory: { max: "4G", min: "1G" },
    overrides: {
      detached: false
    },
    quickplay: quickplay
  }
  launcher.launch(opts);

  launcher.on('debug', (msg) => event.reply('launcher-log', msg));
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

ipcMain.handle("download-file", async (event, { type, id, relativePath, fileUrl }) => {
  return new Promise((resolve, reject) => {
    if (!['client', 'server'].includes(type)) {
      return reject(new Error(`Invalid type: ${type}`));
    }

    if (!id || !relativePath || !fileUrl) {
      return reject(new Error("Missing parameters: id, relativePath, or fileUrl"));
    }

    // Determine full path
    const baseDir = path.join(dataDir, type, String(id), relativePath);
    const fileName = path.basename(fileUrl.split("?")[0]); // removes query params if any
    const fullPath = path.join(baseDir, fileName);

    // Ensure directory exists
    fs.mkdirSync(baseDir, { recursive: true });

    // Choose http or https
    const client = fileUrl.startsWith("https") ? https : http;

    const file = fs.createWriteStream(fullPath);
    client.get(fileUrl, (response) => {
      if (response.statusCode !== 200) {
        return reject(new Error(`Failed to download file: ${response.statusCode}`));
      }

      response.pipe(file);

      file.on("finish", () => {
        file.close();
        resolve({ success: true, path: fullPath });
      });
    }).on("error", (err) => {
      fs.unlinkSync(fullPath); // delete incomplete file
      reject(err);
    });
  });
});


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
