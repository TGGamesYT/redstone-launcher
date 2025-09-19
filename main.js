import path from 'path';
import https from 'https';
import fs from 'fs';
const fsp = fs.promises;
import fetch from 'node-fetch';
import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { vanilla, fabric, quilt, forge, neoforge } from 'tomate-loaders';
import { Client } from 'minecraft-launcher-core';
import { Auth } from 'msmc';
import serverManager from './serverManager.js';
import FormData from 'form-data';
import AdmZip from 'adm-zip';
import Store from 'electron-store';
import { spawnSync, spawn } from "child_process";
import crypto from "crypto";
import base64url from "base64url";
import fernet from 'fernet';
import RPC from "discord-rpc";
import os from 'os';
import gDriveDownloader from "@abrifq/google-drive-downloader";
const totalRAMMB = Math.floor(os.totalmem() / (1024 * 1024));
const WORKER_URL = "https://curseforge.tothgergoci.workers.dev"

const storage = new Store();
const settings = new Store();
export default settings;
const sortStore = new Store({ name: "instance-sorting" });
if (!sortStore.has("sortMode")) sortStore.set("sortMode", "created-desc");
if (!sortStore.has("customOrder")) sortStore.set("customOrder", []);

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
  const profiles = JSON.parse(fs.readFileSync(profilesPath, "utf8"));
  const sortMode = sortStore.get("sortMode");
  const customOrder = sortStore.get("customOrder");
  return applySort(profiles, sortMode, customOrder);
}
function saveProfiles(p) { fs.writeFileSync(profilesPath, JSON.stringify(p, null, 2)); }

// Helper to fetch Piston meta versions
let minecraftVersionsCache;
async function getPistonVersions() {
  if (minecraftVersionsCache) return minecraftVersionsCache;
  const res = await fetch("https://launchermeta.mojang.com/mc/game/version_manifest.json");
  const data = await res.json();
  minecraftVersionsCache = data.versions.map(v => v.id); // array of version IDs in order
  return minecraftVersionsCache;
}

/**
 * Sort profiles by various modes
 * @param {Array} profiles 
 * @param {String} mode 
 * @param {Array} order optional custom order array of IDs
 * @returns {Promise<Array>}
 */
async function applySort(profiles, mode, order) {
  switch (mode) {
    case "name-asc":
      return [...profiles].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    case "name-desc":
      return [...profiles].sort((a, b) => (b.name || "").localeCompare(a.name || ""));
    case "created-asc":
      return [...profiles].sort((a, b) => (a.created || 0) - (b.created || 0));
    case "created-desc":
      return [...profiles].sort((a, b) => (b.created || 0) - (a.created || 0));
    case "lastused-asc":
      return [...profiles].sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
    case "lastused-desc":
      return [...profiles].sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
    case "loader-asc":
      return [...profiles].sort((a, b) => (a.loader || "").localeCompare(b.loader || ""));
    case "loader-desc":
      return [...profiles].sort((a, b) => (b.loader || "").localeCompare(a.loader || ""));
    case "version-asc": {
      const pistonVersions = await getPistonVersions();
      const versionIndex = id => pistonVersions.indexOf(id) !== -1 ? pistonVersions.indexOf(id) : Infinity;
      return [...profiles].sort((a, b) => versionIndex(a.version) - versionIndex(b.version));
    }
    case "version-desc": {
      const pistonVersions = await getPistonVersions();
      const versionIndex = id => pistonVersions.indexOf(id) !== -1 ? pistonVersions.indexOf(id) : -Infinity;
      return [...profiles].sort((a, b) => versionIndex(b.version) - versionIndex(a.version));
    }
    case "custom":
      if (Array.isArray(order) && order.length > 0) {
        const orderMap = new Map(order.map((id, idx) => [String(id), idx]));
        return [...profiles].sort((a, b) => {
          const ai = orderMap.has(String(a.id)) ? orderMap.get(String(a.id)) : Infinity;
          const bi = orderMap.has(String(b.id)) ? orderMap.get(String(b.id)) : Infinity;
          return ai - bi;
        });
      }
      return profiles;
    default:
      return profiles;
  }
}


function loadPlayers() {
  ensureFile(playersPath);
  return JSON.parse(fs.readFileSync(playersPath));
}
function savePlayers(p) { fs.writeFileSync(playersPath, JSON.stringify(p, null, 2)); }
let mainWindow;
const iconPath = path.join(process.resourcesPath, 'frontend', 'icon.png');
const color = settings.get('baseColor', "#FF0000");
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
  win.setAccentColor(color);
  win.loadFile('frontend/index.html');
  mainWindow = win
}

/* ─────────────── Storing ─────────────── */

ipcMain.handle("get-selected-player", () => storage.get("selectedPlayerId", null));
ipcMain.on("set-selected-player", (event, id) => {
  storage.set("selectedPlayerId", id);
});


ipcMain.handle('get-settings', () => {
  return settings.store;
});

ipcMain.on('save-settings', (event, newsettings) => {
  settings.set(newsettings);
  const color = settings.get('baseColor', "#FF0000");
  mainWindow.setAccentColor(color);
});

ipcMain.handle('get-system-ram', () => {
  return totalRAMMB;
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
ipcMain.on('create-profile', async (event, profile) => {
  const profiles = await loadProfiles();

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


ipcMain.on("delete-profile", async (event, profileId) => {
  const profiles = await loadProfiles();
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
ipcMain.on('get-profiles', async (event) => {
  try {
    const profiles = await loadProfiles(); // make sure loadProfiles is async now
    event.reply('profiles-list', profiles);
  } catch (err) {
    console.error('Failed to load profiles:', err);
    event.reply('profiles-list', []); // send empty array on error
  }
});

ipcMain.handle("sort-instances", async (event, { mode, order }) => {
  if (!mode) return await loadProfiles();

  sortStore.set("sortMode", mode);
  if (mode === "custom" && Array.isArray(order)) {
    sortStore.set("customOrder", order);
  }

  return await loadProfiles();
});

ipcMain.handle("get-sort-mode", () => {
  return sortStore.get("sortMode", "created-desc");
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

      const profiles = await loadProfiles();
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
      icon
    };

    const profiles = await loadProfiles();
    profiles.push(newProfile);
    saveProfiles(profiles);

    return { success: true, profile: newProfile };
}

async function getDownloadUrl(projectID, fileID) {
  try {
    const response = await fetch(WORKER_URL + "/download-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectID, fileID })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    if (!data.data) throw new Error("No data field in response");

    return data.data; // this is the actual download URL
  } catch (err) {
    console.error(`Failed to fetch mod ${projectID}/${fileID}:`, err);
    return null;
  }
}

ipcMain.handle("import-curseforge-zip", async () => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: "Select CurseForge .zip file",
      filters: [{ name: "CurseForge Modpack", extensions: ["zip"] }],
      properties: ["openFile"]
    });
    if (canceled || !filePaths.length)
      return { success: false, error: "No file selected" };

    const zipPath = filePaths[0];
    return await curseforgeImport(zipPath);
  } catch (err) {
    return { success: false, error: err.message };
  }
});

async function curseforgeImport(zipPath) {
  const zip = new AdmZip(zipPath);

  const manifestEntry = zip.getEntry("manifest.json");
  if (!manifestEntry)
    return { success: false, error: "manifest.json not found in zip" };
  const manifest = JSON.parse(manifestEntry.getData().toString("utf8"));

  // Loader & Minecraft version
  const mcVersion = manifest.minecraft.version;
  let loaderwithshit = manifest.minecraft.modLoaders.find(l => l.primary)?.id || "vanilla";
  const loader = loaderwithshit.split("-")[0];

  // Create profile folder
  const profileId = Date.now();
  const profilesDir = path.join(dataDir, "client");
  if (!fs.existsSync(profilesDir)) fs.mkdirSync(profilesDir, { recursive: true });
  const profileFolder = path.join(profilesDir, `${profileId}`);
  fs.mkdirSync(profileFolder);

  // Extract overrides/
  zip.getEntries().forEach(entry => {
    if (!entry.isDirectory && entry.entryName.startsWith("overrides/")) {
      const relativePath = entry.entryName.replace(/^overrides\//, "");
      if (!relativePath) return;
      const outPath = path.join(profileFolder, relativePath);
      const outDir = path.dirname(outPath);
      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(outPath, entry.getData());
    }
  });

  // Download mods
  for (const fileObj of manifest.files || []) {
    try {
      const url = await getDownloadUrl(fileObj.projectID, fileObj.fileID);
      const fileName = path.basename(url.split("?")[0]);
      const dest = path.join(profileFolder, "mods", fileName);
      await downloadFile(url, dest);
    } catch (err) {
      console.error(`Failed to fetch mod ${fileObj.projectID}/${fileObj.fileID}:`, err);
    }
  }

  // Optional: read overrides/icon.png if exists
  let icon = null;
  const iconEntry = zip.getEntry("overrides/icon.png");
  if (iconEntry) icon = iconEntry.getData().toString("base64");

  const newProfile = {
    id: profileId,
    name: manifest.name || "Imported CurseForge Pack",
    version: mcVersion,
    loader,
    icon
  };

  const profiles = await loadProfiles();
  profiles.push(newProfile);
  saveProfiles(profiles);

  return { success: true, profile: newProfile };
}


// Launch profile
ipcMain.on('launch-profile', async (event, { profileId, playerId, quickplaybool, quickplayip }) => {
  const minRam = `${settings.get('ramInstancesMin', 1024)}m`;
  const maxRam = `${settings.get('ramInstancesMax', 4096)}m`;
  const profiles = await loadProfiles();
  const players = loadPlayers();

  const profile = profiles.find(p => p.id === profileId);
  if (!profile) return event.reply('launch-error', "Profile not found");
  if (profile) {
    profile.lastUsed = Date.now();
    saveProfiles(profiles);
  }
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
    memory: { max: maxRam, min: minRam },
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
  return serverManager.startServer(id, settings);
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


function getTypeFolder(type) {
  switch (type) {
    case "mod": return "mods";
    case "resourcepack": return "resourcepacks";
    case "datapack": return path.join("world", "datapacks");
    case "shader": return "shaderpacks";
    case "plugin": return "plugins";
    default: throw new Error(`Unknown project type: ${type}`);
  }
}

// ---------------- mod-download ----------------
ipcMain.handle("mod-download", async (event, { server, id, fileUrl, projectType }) => {
  try {
    const baseDir = server
      ? path.join(dataDir, "servers", String(id))
      : path.join(dataDir, "client", String(id));

    const typeFolder = getTypeFolder(projectType);
    const targetDir = path.join(baseDir, typeFolder);
    fs.mkdirSync(targetDir, { recursive: true });

    const fileName = path.basename(new URL(fileUrl).pathname);
    const dest = path.join(targetDir, fileName);

    await downloadFile(fileUrl, dest);

    // Special case: server-side resourcepack
    if (server && projectType === "resourcepack") {
      const serverPropsPath = path.join(baseDir, "server.properties");
      let props = "";
      if (fs.existsSync(serverPropsPath)) props = fs.readFileSync(serverPropsPath, "utf8");
      const lines = props.split(/\r?\n/).filter(l => !l.startsWith("resource-pack="));
      lines.push(`resource-pack=${fileUrl}`);
      fs.writeFileSync(serverPropsPath, lines.join("\n"), "utf8");
    }

    return { success: true, path: dest };
  } catch (err) {
    console.error("Failed to download file:", err);
    return { success: false, error: err.message };
  }
});

// ---------------- install-mrpack-url ----------------
ipcMain.handle("install-mrpack-url", async (event, url) => {
  try {
    // Download .mrpack to temp
    const tmpDir = app.getPath("temp");
    const fileName = path.basename(new URL(url).pathname);
    const tmpPath = path.join(tmpDir, fileName);

    await downloadFile(url, tmpPath);

    // Then run your normal mrpack import logic
    // Assuming you already have a function `mrpack(path)` that handles installation
    return await mrpack(tmpPath);
  } catch (err) {
    console.error("Failed to install .mrpack from URL:", err);
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
    const dir = path.dirname(dest);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true }); // create folder if missing
    }

    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // redirect
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

/* ─────────────── Updating ─────────────── */

// ---- CONFIG ----
const CODEWORD = "sub2TGdoesCode"; // keep only in backend
const UPDATE_URL = "https://redstone-launcher.com/updates.txt";

// turn password into Fernet key
function makeKey(codeword) {
  return base64url(crypto.createHash("sha256").update(codeword).digest());
}

async function fetchUpdates() {
  const res = await fetch(UPDATE_URL);
  const encrypted = await res.text();

  const key = makeKey(CODEWORD); // should return a base32 string

  // create a Secret
  const secret = new fernet.Secret(key);

  // create a Token instance
  const token = new fernet.Token({
    secret: secret,
    token: encrypted,
    ttl: 0 // 0 = ignore expiration check
  });

  // decode the token
  const decrypted = token.decode();

  return JSON.parse(decrypted);
}

function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const ai = pa[i] || 0;
    const bi = pb[i] || 0;
    if (ai > bi) return 1;
    if (ai < bi) return -1;
  }
  return 0;
}

ipcMain.handle("check-for-updates", async () => {
  try {
    const updates = await fetchUpdates();

    // latest version
    const versions = Object.keys(updates).sort(compareVersions);
    const latest = versions[versions.length - 1];

    const current = app.getVersion();
    const newer = compareVersions(latest, current) > 0;

    if (!newer) {
      return { updateAvailable: false };
    }

    return { updateAvailable: true, latest, url: updates[latest] };
  } catch (err) {
    console.error("Update check failed:", err);
    return { updateAvailable: false, error: err.message };
  }
});

ipcMain.handle("download-and-install", async (event, fileId, version) => {
  try {
    const savePath = path.join(app.getPath("temp"), `RedstoneLauncher-${version}.exe`);

    // Direct download URL for Node
    const gdriveDownloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;

    await downloadFile(gdriveDownloadUrl, savePath);

    // Run installer
    spawn(savePath, { shell: true, detached: true, stdio: "ignore" }).unref();
    app.quit();

    return { success: true };
  } catch (err) {
    console.error("Update download failed:", err);
    return { success: false, error: err.message };
  }
});



/* ─────────────── mrpack export ─────────────── */

// helper: compute hashes for a Buffer
function computeHashes(buffer) {
  const sha1 = crypto.createHash('sha1').update(buffer).digest('hex');
  const sha512 = crypto.createHash('sha512').update(buffer).digest('hex');
  return { sha1, sha512 };
}

// helper: simple https GET JSON
function fetchJson(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15000, headers: opts.headers || {} }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); } catch (err) { resolve(null); }
        } else {
          resolve({ __errorStatus: res.statusCode, body });
        }
      });
    });
    req.on('error', (err) => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// Best-effort: try to look up file on Modrinth by sha512 then sha1
async function lookupModrinthByHash(sha512hex, sha1hex) {
  // Try both SHA512 and SHA1 against Modrinth API
  const tryUrls = [
    `https://api.modrinth.com/v2/version_file/${sha512hex}`,
    `https://api.modrinth.com/v2/version_file/${sha1hex}`,
  ];

  for (const url of tryUrls) {
    try {
      const res = await fetchJson(url);
      if (!res) continue;
      if (res.__errorStatus) continue;

      // Modrinth returns an object with files array
      if (res.files && Array.isArray(res.files) && res.files.length > 0 && res.files[0].url) {
        return { url: res.files[0].url, data: res };
      }
    } catch (err) {
      // silently continue
    }
  }

  return null;
}

// Collect files from instance dir matching common folders and arbitrary root files
async function collectInstanceFiles(instanceFolder) {
  const disallowedDirs = ['logs', 'assets', 'cache', '.fabric', 'downloads', 'libraries', 'natives', 'screenshots', 'versions'];
  const disallowedFiles = ['usercache.json', 'command_history.txt', 'debug-profile.json', 'realms_presistence.json'];
  const results = [];

  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = path.relative(instanceFolder, full).replace(/\\/g, '/');

      // Skip directories in disallowedDirs
      if (e.isDirectory() && disallowedDirs.includes(e.name)) continue;

      // Skip files in disallowedFiles
      if (e.isFile() && disallowedFiles.some(f => rel.toLowerCase().endsWith(f))) continue;

      if (e.isDirectory()) {
        await walk(full); // recurse
      } else if (e.isFile()) {
        results.push({ full, rel });
      }
    }
  }

  await walk(instanceFolder);
  return results;
}

/**
 * Main handler
 * Returns { success: true, mrpackPath, indexJson } or { success: false, error }
 */
ipcMain.handle('export-mrpack', async (event, profileId) => {
  console.log("[mrpack] START export for profileId:", profileId);

  try {
    if (!profileId) throw new Error("Missing profile id");

    // Load profiles
    const profilesPath = path.join(dataDir, 'profiles.json');
    if (!fs.existsSync(profilesPath)) throw new Error("profiles.json not found");
    const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
    const profile = profiles.find(p => Number(p.id) === Number(profileId));
    if (!profile) throw new Error("Profile not found");
    console.log("[mrpack] Profile found:", profile);

    const instanceFolder = path.join(dataDir, 'client', String(profile.id));
    if (!fs.existsSync(instanceFolder)) throw new Error("Instance folder not found: " + instanceFolder);
    console.log("[mrpack] Instance folder:", instanceFolder);

    // Collect all files
    console.log("[mrpack] Collecting files...");
    const files = await collectInstanceFiles(instanceFolder);
    console.log("[mrpack] Found", files.length, "files");

    // Prepare index files and overrides
    const indexFiles = [];
    const overrideFiles = [];

    for (const f of files) {
      const buffer = await fsp.readFile(f.full);
      const { sha1, sha512 } = computeHashes(buffer);
      const relPath = f.rel.replace(/\\/g,'/');

      // Determine environment
      let env = { client: 'optional', server: 'optional' };
      const l = relPath.toLowerCase();
      if (l.startsWith('mods/') || l.includes('/mods/')) env = { client: 'required', server: 'unsupported' };
      else if (l.startsWith('resourcepacks/') || l.includes('/resourcepacks/')) env = { client: 'required', server: 'optional' };
      else if (l.startsWith('shaderpacks/') || l.includes('/shaderpacks/')) env = { client: 'required', server: 'unsupported' };

      console.log("[mrpack] Looking up Modrinth for:", relPath);
      const lookup = await lookupModrinthByHash(sha512, sha1);

      if (lookup && lookup.url) {
        console.log("[mrpack] Found on Modrinth:", relPath);
        indexFiles.push({
          path: relPath,
          hashes: { sha1, sha512 },
          env,
          downloads: [lookup.url],
          fileSize: buffer.length
        });
      } else {
        console.log("[mrpack] Not on Modrinth, adding to overrides:", relPath);
        overrideFiles.push({ relPath, buffer });
      }
    }

    // Build modrinth.index.json
    const indexJson = {
      formatVersion: 1,
      game: "minecraft",
      versionId: String(Date.now()),
      name: profile.name || `Instance ${profile.id}`,
      files: indexFiles,
      dependencies: { minecraft: profile.version || "1.20.1" }
    };
    if (profile.loader) {
      if (profile.loader === 'fabric') indexJson.dependencies['fabric-loader'] = "unknown";
      else if (profile.loader === 'quilt') indexJson.dependencies['quilt-loader'] = "unknown";
      else if (profile.loader === 'forge') indexJson.dependencies['forge'] = "unknown";
      else if (profile.loader === 'neoforge') indexJson.dependencies['neoforge'] = "unknown";
    }

    // Create .mrpack zip
    const mrpackName = `${profile.name.replace(/[<>:"/\\|?*\x00-\x1F]/g,'_') || 'pack'}-${profile.id}.mrpack`;
    const mrpackPath = path.join(dataDir, mrpackName);
    console.log("[mrpack] Creating zip:", mrpackPath);

    const zip = new AdmZip();
    zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify(indexJson, null, 2), 'utf8'));

    if (profile.icon) console.log("[mrpack] Icon detected (optional)");

    // Add overrides files
    console.log("[mrpack] Adding overrides files:", overrideFiles.length);
    for (const f of overrideFiles) {
      const target = path.posix.join('overrides', f.relPath);
      zip.addFile(target, f.buffer);
    }

    zip.writeZip(mrpackPath);
    console.log("[mrpack] Export complete:", mrpackPath);

    return { success: true, mrpackPath, indexJson };

  } catch (err) {
    console.error("[mrpack] Error exporting:", err);
    return { success: false, error: err.message || String(err) };
  }
});

/* ─────────────── dihhcord ─────────────── */

const clientId = '1413838664185679892';
const rpc = new RPC.Client({ transport: 'ipc' });
rpc.on('ready', () => {
  console.log('[Discord RPC] Connected');

  // Set initial presence
  setActivity();
});

function setActivity(details = "In launcher", state = "Idle") {
  if (!rpc) return;

  rpc.setActivity({
    details,          // e.g., "Playing Minecraft"
    state,            // e.g., "On version 1.21"
    startTimestamp: Date.now(),
    instance: false
  }).catch(err => console.error('[Discord RPC] Error setting activity:', err));
}

// Connect to Discord
rpc.login({ clientId }).catch(console.error);

// Optional: expose a function to update presence dynamically
global.setDiscordPresence = setActivity;

ipcMain.on('update-discord-presence', (event, { details, state }) => {
  setActivity(details, state);
});


app.whenReady().then(createWindow);
