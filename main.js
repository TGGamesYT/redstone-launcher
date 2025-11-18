let ALLOW_CRACKED_TESTING = false;


import path from 'path';
import https from 'https';
import http from 'http';
import readline from "readline";
import tar from "tar-fs";
import zlib from "zlib";
import fs from 'fs';
const fsp = fs.promises;
import fetch from 'node-fetch';
import { shell, app, BrowserWindow, ipcMain, dialog } from 'electron';
import { vanilla, fabric, quilt, forge, neoforge } from 'tomate-loaders';
import { Client } from 'minecraft-launcher-core';
import { Auth } from 'msmc';
import serverManager from './serverManager.js';
import FormData from 'form-data';
import AdmZip from 'adm-zip';
import Store from 'electron-store';
import { exec, execSync, spawn } from "child_process";
import crypto from "crypto";
import nbt from "prismarine-nbt";
import base64url from "base64url";
import fernet from 'fernet';
import RPC from "discord-rpc";
import os from 'os';
import xml2js from "xml2js";
import { parseStringPromise } from "xml2js";
import unzipper from "unzipper";
import { profile } from 'console';
const totalRAMMB = Math.floor(os.totalmem() / (1024 * 1024));
const WORKER_URL = "https://curseforge.tgdoescode.workers.dev"

const CLASS_ID_FOLDERS = {
  6: "mods",
  12: "resourcepacks",
  5193: "datapacks",
  6552: "shaderpacks",
  17: "saves"
};



const _WHITESPACE_BYTES = new Set([
  9, 10, 13, 32 // \t, \n, \r, space  <-- match the Python set exactly
]);

// use Python's / CurseForge's multiplier constant (0x5bd1e995 == 1540483477)
const _MULTIPLEX = 0x5bd1e995;

function getFingerprint(path) {
  if (!fs.existsSync(path) || !fs.statSync(path).isFile()) {
    throw new Error(`File not found: ${path}`);
  }

  const data = fs.readFileSync(path);
  let lenNoWs = 0;
  for (const b of data) {
    if (!_WHITESPACE_BYTES.has(b)) lenNoWs++;
  }

  let num2 = (1 ^ lenNoWs) >>> 0;
  let num3 = 0;
  let num4 = 0;

  for (const b of data) {
    if (_WHITESPACE_BYTES.has(b)) continue;

    num3 |= (b << num4);
    num4 += 8;
    if (num4 === 32) {
      const num6 = Math.imul(num3, _MULTIPLEX) >>> 0;
      const num7 = Math.imul((num6 ^ (num6 >>> 24)) >>> 0, _MULTIPLEX) >>> 0;
      num2 = Math.imul(num2, _MULTIPLEX) ^ num7;
      num2 >>>= 0;
      num3 = 0;
      num4 = 0;
    }
  }

  if (num4 > 0) {
    num2 = Math.imul(num2 ^ num3, _MULTIPLEX) >>> 0;
  }

  let num6 = Math.imul(num2 ^ (num2 >>> 13), _MULTIPLEX) >>> 0;
  return (num6 ^ (num6 >>> 15)) >>> 0;
}

function computeSHA1(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const st = fs.statSync(filePath);
  if (!st.isFile()) throw new Error(`Not a file: ${filePath}`);
  const fileBuffer = fs.readFileSync(filePath);
  return crypto.createHash("sha1").update(fileBuffer).digest("hex");
}


// ========== INSTANCE TRACKING SYSTEM ==========
const runningInstances = new Map(); // key: unique key (id + pid) -> { id, pid, startTime }

function startInstance(id, pid) {
    const now = Date.now();
    const key = `${id}-${pid}`; // unique per process
    runningInstances.set(key, { id, pid, startTime: now });
    devtoolsLog(`[Tracker] Started instance ${id} (PID ${pid})`);
}

function stopInstance(id, pid = null) {
    if (pid) {
        const key = `${id}-${pid}`;
        if (runningInstances.has(key)) {
            runningInstances.delete(key);
            devtoolsLog(`[Tracker] Stopped instance ${id} (PID ${pid})`);
        }
    } else {
        // Stop all with same ID
        for (const [key, data] of runningInstances.entries()) {
            if (data.id === id) {
                runningInstances.delete(key);
                devtoolsLog(`[Tracker] Stopped instance ${id} (PID ${data.pid})`);
            }
        }
    }
}

function isInstanceRunning(id) {
    for (const data of runningInstances.values()) {
        if (data.id === id) return true;
    }
    return false;
}

function getRunningInstances() {
    return Array.from(runningInstances.values());
}

function stopByPid(pid) {
    for (const [key, data] of runningInstances.entries()) {
        if (data.pid === pid) {
            try {
                process.kill(pid);
                runningInstances.delete(key);
                devtoolsLog(`[Tracker] Killed instance ${data.id} (PID ${pid})`);
                return true;
            } catch (err) {
                devtoolsLog(`[Tracker] Failed to kill PID ${pid}:`, err.message);
                return false;
            }
        }
    }
    return false;
}
const storage = new Store();
const settings = new Store();
export default settings;
const sortStore = new Store({ name: "instance-sorting" });
if (!sortStore.has("sortMode")) sortStore.set("sortMode", "created-desc");
if (!sortStore.has("customOrder")) sortStore.set("customOrder", []);

const localdirname = path.dirname(new URL(import.meta.url).pathname);
const dataDir = path.join(app.getPath('userData'));
const credsPath = path.join(dataDir, "creds.json");
const frpcConfigPath = path.join(localdirname, "frpc.ini");
let frpcProcess = null;
const profilesPath = path.join(dataDir, 'profiles.json');
const playersPath = path.join(dataDir, 'players.json');
const JAVA_DIR = path.join(dataDir, "java_runtimes")

const clientId = '1413838664185679892';
let rpc = null; // will hold the Discord RPC client
let rpcConnected = false;
let shouldconnect = true;

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
    width: 1300,
    height: 800,
    minWidth: 1000,
    minHeight: 800,
    icon: path.join(iconPath),
    frame: false, 
    webPreferences: { 
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  if (typeof win.setAccentColor === "function") {
    win.setAccentColor(color);
  }
  win.loadFile('frontend/index.html');
  win.on("maximize", () => {
    win.webContents.send("window-maximized");
  });
  win.on("unmaximize", () => {
    win.webContents.send("window-unmaximized");
  });
  mainWindow = win
}

// --- Prevent multiple instances ---
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
  process.exit(0); // ✅ Ensures the process really stops here
} else {
  app.on('second-instance', () => {
    // Focus existing window instead of opening new
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    if (!mainWindow) createWindow(); // ✅ Only create once
  });

  app.on('activate', () => {
    // On macOS: only recreate if there are no open windows
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}

function devtoolsLog(text) {
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send("devtools-log", String(text));
    console.log(text)
  }
}

export function alert(message) {
  if (mainWindow && message) {
    mainWindow.webContents.send("alert-message", String(message));
  }
}


/* ─────────────── back/forth system ─────────────── */

ipcMain.on('go-back', () => {
  if (mainWindow.webContents.navigationHistory.canGoBack()) {
    mainWindow.webContents.navigationHistory.goBack();
  }
});

ipcMain.on('go-forward', () => {
  if (mainWindow.webContents.navigationHistory.canGoForward()) {
    mainWindow.webContents.navigationHistory.goForward();
  }
});


/* ─────────────── Storing ─────────────── */

ipcMain.handle("get-selected-player", () => storage.get("selectedPlayerId", null));
ipcMain.on("set-selected-player", (event, id) => {
  storage.set("selectedPlayerId", id);
});

function setSelectedPlayer(id) {
  storage.set("selectedPlayerId", id);
}


ipcMain.handle('get-settings', () => {
  return settings.store;
});

ipcMain.on('save-settings', (event, newsettings) => {
  let oldshouldconnect = settings.get('discord-presence', true);
  settings.set(newsettings);
  const color = settings.get('baseColor', "#FF0000");
  if (typeof mainWindow.setAccentColor === "function") {
    mainWindow.setAccentColor(color);
  }
  if (oldshouldconnect != settings.get('discord-presence', true)) updateDiscordPresenceToggle();
});

ipcMain.handle('get-system-ram', () => {
  return totalRAMMB;
});


/* ─────────────── Player Profiles ─────────────── */

async function refreshPlayer(player) {
  try {
    // Create an Auth instance
    const authManager = new Auth();

    // Call refresh with either:
    // - The saved msToken object
    // - Or just the refresh_token string
    const xboxManager = await authManager.refresh(player.refresh);

    // Get a new Minecraft token
    const token = await xboxManager.getMinecraft();

    // Convert for launcher-core
    const launcherAuth = token.mclc();

    // Update your stored player
    player.auth = launcherAuth;
    player.refresh = token.parent.msToken;

    return player;
  } catch (err) {
    devtoolsLog("Failed to refresh player:", err);
    throw err;
  }
}

function getUniqueFolderName(baseName) {
  const clientDir = path.join(dataDir, 'client');

  // Make sure the clientDir exists
  if (!fs.existsSync(clientDir)) fs.mkdirSync(clientDir, { recursive: true });

  const existingFolders = fs.readdirSync(clientDir).filter(f =>
    fs.statSync(path.join(clientDir, f)).isDirectory()
  );

  let uniqueName = baseName;
  let counter = 1;

  while (existingFolders.includes(uniqueName)) {
    uniqueName = `${baseName}-${counter}`;
    counter++;
  }

  return uniqueName;
}

// Add cracked player
ipcMain.on('create-cracked-player', (event, username) => {
  const players = loadPlayers();

  // Check if there's at least one Microsoft account
  const hasMicrosoftAccount = players.some(p => p.type === 'microsoft');

  let allowed = hasMicrosoftAccount || ALLOW_CRACKED_TESTING
  if (!allowed) {
    devtoolsLog("You must log in with a Microsoft account before adding a cracked player.");
    return;
  }

  // Create cracked player
  const id = Date.now();
  const newPlayer = { id, type: 'cracked', username };
  players.push(newPlayer);
  savePlayers(players);
  event.reply('players-updated', players);

  // Set as selected player
  setSelectedPlayer(id);
});

ipcMain.handle('are-crackeds-allowed', (event) => {
  const players = loadPlayers();

  // Check if there's at least one Microsoft account
  const hasMicrosoftAccount = players.some(p => p.type === 'microsoft');

  return(hasMicrosoftAccount || ALLOW_CRACKED_TESTING)
});

// Delete player by ID
ipcMain.on('delete-player', (event, playerToBeDeleted) => {
  let playerId = playerToBeDeleted.id;
  const players = loadPlayers();

  // Filter out the player with the given ID
  const updatedPlayers = players.filter(p => p.id !== playerId);

  // Save and notify frontend
  savePlayers(updatedPlayers);
  devtoolsLog("deleting player: " + playerId)
  if (updatedPlayers[0] != null && updatedPlayers[0].id != null) {
    setSelectedPlayer(updatedPlayers[0].id)
  }
  event.reply('players-updated', updatedPlayers);
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
    let id = Date.now();
    players.push({
      id,
      type: "microsoft",
      username: launcherAuth.name,
      auth: launcherAuth,
      refresh: token.parent.msToken
    });
    savePlayers(players);
    event.reply("players-updated", players);
    setSelectedPlayer(id)
  } catch (err) {
  devtoolsLog("MS login failed: " + err);
  event.reply("login-error", "MS login failed: " + (err?.message || JSON.stringify(err) || String(err)));
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
    id: getUniqueFolderName(profile.name),
    name: profile.name,
    version: profile.version || "1.20.1",
    loader: profile.loader || "vanilla",
    icon: profile.icon || "https://tggamesyt.dev/assets/redstone_launcher_defaulticon.png",
    created: Date.now()
  };

  profiles.push(newProfile);
  saveProfiles(profiles);

  event.reply('profiles-updated', profiles);
});

ipcMain.on('edit-profile', (event, updatedProfile) => {
  const profilesPromise = loadProfiles(); // returns a Promise because applySort is async
  // handle the promise here
  profilesPromise
    .then(profiles => {
      // ensure it's an array
      if (!Array.isArray(profiles)) profiles = Object.values(profiles || {});
      const index = profiles.findIndex(p => String(p.id) === String(updatedProfile.id));
      if (index === -1) {
        devtoolsLog('edit-profile-error', `Profile with id ${updatedProfile.id} not found`);
        event.reply('edit-profile-error', `Profile with id ${updatedProfile.id} not found`);
        return;
      }
      profiles[index] = { ...profiles[index], ...updatedProfile };

      saveProfiles(profiles);
      event.reply('profiles-updated', profiles);
    })
    .catch(err => {
      devtoolsLog('Failed to load profiles for edit:', err);
      event.reply('edit-profile-error', 'Failed to load profiles');
    });
});



ipcMain.on("delete-profile", async (event, profileId) => {
  const profiles = await loadProfiles();
  const id = profileId

  const newProfiles = profiles.filter(p => p.id !== id);
  devtoolsLog(newProfiles)

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
    devtoolsLog("Failed to delete profile folder:", err);
  }

  saveProfiles(newProfiles);
  event.reply("profiles-updated", newProfiles);
  alert("deleted: " + id)
});

ipcMain.on("close-app", () => {
  app.quit();
});

ipcMain.on("min-app", () => {
  mainWindow.minimize();
});

ipcMain.on("max-app", () => {
  if (!mainWindow.isMaximized()) {
    mainWindow.maximize();
  } else {
    mainWindow.unmaximize();
  }
});

ipcMain.handle('get-profile-by-id', async (event, profileId) => {
  try {
    const profiles = await loadProfiles();
    const profile = profiles.find(p => String(p.id) === String(profileId));
    return profile || null;
  } catch (err) {
    devtoolsLog('Failed to get profile by ID:', err);
    return null;
  }
});

// Get game profiles
ipcMain.on('get-profiles', async (event) => {
  try {
    const profiles = await loadProfiles(); // make sure loadProfiles is async now
    event.reply('profiles-list', profiles);
  } catch (err) {
    devtoolsLog('Failed to load profiles:', err);
    event.reply('profiles-list', []); // send empty array on error
  }
});

ipcMain.on('get-profiles-latest', async (event) => {
  try {
    ensureFile(profilesPath);
    let unsorted = JSON.parse(fs.readFileSync(profilesPath, "utf8"));
    const profiles =  await applySort(unsorted, "lastused-desc", null);
    event.reply('profiles-list', profiles);
  } catch (err) {
    devtoolsLog('Failed to load profiles:', err);
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
      created: Date.now()
    };

    const profiles = await loadProfiles();
    profiles.push(newProfile);
    saveProfiles(profiles);
    devtoolsLog(profileId)

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
    devtoolsLog(`Failed to fetch mod ${projectID}/${fileID}:`, err);
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

async function getModInfo(projectID) {
  const response = await fetch(`${WORKER_URL}/mods?modId=${projectID}`, {
    method: "GET",
    headers: { "Accept": "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch mod info for ${projectID}: ${response.status}`);
  }
  const data = await response.json();
  return data.data; // CF wraps data inside { data: {...} }
}

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
  const profileId = getUniqueFolderName(manifest.name);
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
      // Step 1: Lookup mod info → get classId
      const modInfo = await getModInfo(fileObj.projectID);
      let classId = modInfo.classId;
      if (Array.isArray(modInfo.categories)) {
        const anyCat = modInfo.categories.find(c => (c.classId || c.classId === 0));
        if (anyCat) classId = anyCat.classId;
      }

      // Step 2: Decide folder based on classId
      const subFolder = CLASS_ID_FOLDERS[classId] || "this_folder_is_for_projects_that_I_have_no_idea_of_what_the_type_is";
      const targetFolder = path.join(profileFolder, subFolder);

      await fs.promises.mkdir(targetFolder, { recursive: true });

      // Step 3: Get download URL
      const url = await getDownloadUrl(fileObj.projectID, fileObj.fileID);
      const fileName = path.basename(url.split("?")[0]);
      const dest = path.join(targetFolder, fileName);

      // Step 4: Download
      await downloadFile(url, dest);
      devtoolsLog(`✅ Installed ${fileName} to ${subFolder}`);
    } catch (err) {
      devtoolsLog(`❌ Failed to fetch mod ${fileObj.projectID}/${fileObj.fileID}:`, err);
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
    icon,
    created: Date.now()
  };

  const profiles = await loadProfiles();
  profiles.push(newProfile);
  saveProfiles(profiles);

  return { success: true, profile: newProfile };
}

async function getJavaForMinecraft(mcVersion) {
  // 1️⃣ Fetch the version manifest
  const manifestRes = await fetch("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json");
  if (!manifestRes.ok) throw new Error("Failed to fetch version manifest");
  const manifest = await manifestRes.json();

  // 2️⃣ Find the version object with the matching id
  const versionObj = manifest.versions.find((v) => v.id === mcVersion);
  if (!versionObj) throw new Error(`Minecraft version ${mcVersion} not found`);

  // 3️⃣ Fetch the version JSON
  const versionRes = await fetch(versionObj.url);
  if (!versionRes.ok) throw new Error(`Failed to fetch version JSON for ${mcVersion}`);
  const versionData = await versionRes.json();

  // 4️⃣ Extract javaVersion.majorVersion
  const javaVersion = versionData.javaVersion?.majorVersion;
  if (!javaVersion) throw new Error(`Java version info not found for Minecraft ${mcVersion}`);

  // 5️⃣ Check system Java
  try {
    const output = execSync("java -version 2>&1").toString();
    // Match "java version "23.0.2""
    const match = output.match(/version "(?<v>\d+)\.?/);
    if (match && match.groups.v) {
      const sysVer = parseInt(match.groups.v, 10);

      // Accept exact match only
      if (sysVer === javaVersion) return "java";

      // Optional: allow minor compatible versions (like Java 17–18)
      // if (javaVersion >= 17 && sysVer >= 17 && sysVer <= 18) return "java";
    }
  } catch (_) {
    // system Java not found
  }

  // 6️⃣ Detect OS & Arch
  const platform = process.platform;
  let osName;
  if (platform === "win32") osName = "windows";
  else if (platform === "darwin") osName = "mac";
  else if (platform === "linux") osName = "linux";
  else throw new Error(`Unsupported platform: ${platform}`);

  const arch = os.arch() === "x64" ? "x64" : os.arch() === "arm64" ? "aarch64" : null;
  if (!arch) throw new Error(`Unsupported architecture: ${os.arch()}`);

  // 7️⃣ Check if we already have extracted Java
  const installPath = path.join(JAVA_DIR, `${javaVersion}_${osName}_${arch}`);
  const javaBin = path.join(installPath, platform === "win32" ? "bin/javaw.exe" : "bin/java");
  if (fs.existsSync(javaBin)) {
    devtoolsLog(`Found existing Java ${javaVersion} at ${javaBin}`);
    return javaBin;
  }

  // 8️⃣ Fetch Adoptium API JSON
  const apiUrl = `https://api.adoptium.net/v3/assets/latest/${javaVersion}/hotspot?architecture=${arch}&os=${osName}&image_type=jre&release_type=ga`;
  const apiData = await new Promise((resolve, reject) => {
    https.get(apiUrl, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve(JSON.parse(data)));
      res.on("error", reject);
    });
  });

  if (!apiData[0]?.binary?.package?.link) {
    devtoolsLog(apiData);
    devtoolsLog("Failed to find Java download link in Adoptium API response.")
    throw new Error("Failed to find Java download link in Adoptium API response.");
  }

  const downloadUrl = apiData[0].binary.package.link;
  const tmpZip = path.join(os.tmpdir(), `java${javaVersion}.zip`);

  // 9️⃣ Download
  devtoolsLog(`Downloading Java ${javaVersion} for ${mcVersion} from Adoptium...`);
  await downloadFile(downloadUrl, tmpZip);

  // 10️⃣ Extract
  devtoolsLog("Extracting Java...");
  await fs.createReadStream(tmpZip)
    .pipe(unzipper.Parse())
    .on("entry", (entry) => {
      const entryPathParts = entry.path.split(/[/\\]/); // split path into parts
      entryPathParts.shift(); // remove the top-level folder
      const relativePath = entryPathParts.join(path.sep);
      const destPath = path.join(installPath, relativePath);

      if (entry.type === "Directory") {
        fs.mkdirSync(destPath, { recursive: true });
        entry.autodrain();
      } else {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        entry.pipe(fs.createWriteStream(destPath));
      }
    })
    .promise();

  fs.unlinkSync(tmpZip);

  return javaBin;
}



// Launch profile
ipcMain.on('launch-profile', async (event, { profileId, playerId, quickplaybool, quickplayip }) => {
  event.reply('launcher-log', "Launching, please wait.");
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
    try {
      await refreshPlayer(player);
      auth = player.auth
    } catch (err) {
      auth = player.auth
      event.reply('launch-error', "Failed to refresh Microsoft token: " + err.message);
    }
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
  const javaPath = await getJavaForMinecraft(profile.version);
  devtoolsLog("Java ready at:", javaPath);

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
    javaPath,
    overrides: {
      assetRoot: path.join(dataDir, 'assets'),
      detached: false
    },
    quickplay: quickplay
  }
  const childProcess = await launcher.launch(opts);

  launcher.on('data', msg => event.reply('launcher-log', msg));
  launcher.on('debug', msg => event.reply('launcher-log', msg));
  launcher.on('error', err => event.reply('launcher-log', "ERROR: " + err.message));
  const pid = childProcess.pid;
  devtoolsLog("PID: " + pid);
  startInstance(profileId, pid);
  event.reply('launcher-log', `[INFO] Launched Minecraft instance "${profileId}" (PID ${pid})`);

  // Handle process exit
  childProcess.on('exit', (code) => {
      stopInstance(profileId, pid);
      event.reply('launcher-log', `[INFO] Instance "${profileId}" exited with code ${code}`);
  });
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
    devtoolsLog("Failed to download file:", err);
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
    devtoolsLog("Failed to install .mrpack from URL:", err);
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
    devtoolsLog("Update check failed:", err);
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
    devtoolsLog("Update download failed:", err);
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
  devtoolsLog("[mrpack] START export for profileId:", profileId);

  try {
    if (!profileId) throw new Error("Missing profile id");

    // Load profiles
    const profilesPath = path.join(dataDir, 'profiles.json');
    if (!fs.existsSync(profilesPath)) throw new Error("profiles.json not found");
    const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
    const profile = profiles.find(p => Number(p.id) === Number(profileId));
    if (!profile) throw new Error("Profile not found");
    devtoolsLog("[mrpack] Profile found:", profile);

    const instanceFolder = path.join(dataDir, 'client', String(profile.id));
    if (!fs.existsSync(instanceFolder)) throw new Error("Instance folder not found: " + instanceFolder);
    devtoolsLog("[mrpack] Instance folder:", instanceFolder);

    // Collect all files
    devtoolsLog("[mrpack] Collecting files...");
    const files = await collectInstanceFiles(instanceFolder);
    devtoolsLog("[mrpack] Found", files.length, "files");

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

      devtoolsLog("[mrpack] Looking up Modrinth for:", relPath);
      const lookup = await lookupModrinthByHash(sha512, sha1);

      if (lookup && lookup.url) {
        devtoolsLog("[mrpack] Found on Modrinth:", relPath);
        indexFiles.push({
          path: relPath,
          hashes: { sha1, sha512 },
          env,
          downloads: [lookup.url],
          fileSize: buffer.length
        });
      } else {
        devtoolsLog("[mrpack] Not on Modrinth, adding to overrides:", relPath);
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
    devtoolsLog("[mrpack] Creating zip:", mrpackPath);

    const zip = new AdmZip();
    zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify(indexJson, null, 2), 'utf8'));

    // Add overrides files
    devtoolsLog("[mrpack] Adding overrides files:", overrideFiles.length);
    for (const f of overrideFiles) {
      const target = path.posix.join('overrides', f.relPath);
      zip.addFile(target, f.buffer);
    }

    zip.writeZip(mrpackPath);
    devtoolsLog("[mrpack] Export complete:", mrpackPath);

    return { success: true, mrpackPath, indexJson };

  } catch (err) {
    devtoolsLog("[mrpack] Error exporting:", err);
    return { success: false, error: err.message || String(err) };
  }
});

/* ─────────────── dihhcord ─────────────── */
function startDiscordPresence() {
  shouldconnect = settings.get('discord-presence', true);
  if (rpcConnected || !shouldconnect) return; // already running or shouldnt connect

  rpc = new RPC.Client({ transport: 'ipc' });

  rpc.on('ready', () => {
    devtoolsLog('[Discord RPC] Connected');
    rpcConnected = true;
    setActivity(); // initial presence
  });

  rpc.login({ clientId }).catch(devtoolsLog);
}

// Function to stop Discord presence
function stopDiscordPresence() {
  if (!rpcConnected || !rpc) return;

  try {
    rpc.clearActivity(); // optional: clear presence
    rpc.destroy();       // disconnect
  } catch (err) {
    devtoolsLog('[Discord RPC] Error stopping:', err);
  } finally {
    rpc = null;
    rpcConnected = false;
    devtoolsLog('[Discord RPC] Disconnected');
  }
}
function setActivity(details = "In launcher", state = "Idle") {
  if (!rpcConnected || !rpc) return;

  rpc.setActivity({
    details,          // e.g., "Playing Minecraft"
    state,            // e.g., "On version 1.21"
    startTimestamp: Date.now(),
    instance: false
  }).catch(err => {
    devtoolsLog('[Discord RPC] Error setting activity:', err)
  });
}
function updateDiscordPresenceToggle() {
  shouldconnect = settings.get('discord-presence', true);
  if (!rpcConnected && shouldconnect) {
    startDiscordPresence();
  } else {
    stopDiscordPresence();
  }
}

// Optional: expose a function to update presence dynamically
global.setDiscordPresence = setActivity;

ipcMain.on('update-discord-presence', (event, { details, state }) => {
  setActivity(details, state);
});

async function getFabricLatestVersion() {
  const res = await fetch("https://meta.fabricmc.net/v2/versions/loader");
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("No fabric loader versions found");
  }
  return `fabric-${data[0].version}`;
}

// ✅ Quilt (Maven metadata XML)
async function getQuiltLatestVersion() {
  const res = await fetch("https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer/maven-metadata.xml");
  const xml = await res.text();
  const parsed = await xml2js.parseStringPromise(xml);
  const version = parsed.metadata.versioning[0].latest[0];
  return `quilt-${version}`;
}

// ✅ Forge (Maven metadata XML, filter by Minecraft version prefix, strip MC part)
async function getForgeLatestVersion(minecraftVersion) {
  const res = await fetch("https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml");
  const xml = await res.text();
  const parsed = await xml2js.parseStringPromise(xml);

  const versions = parsed.metadata.versioning[0].versions[0].version;
  const matching = versions.filter(v => v.startsWith(`${minecraftVersion}-`));
  if (matching.length === 0) {
    throw new Error(`No Forge builds found for Minecraft ${minecraftVersion}`);
  }
  const latest = matching[matching.length - 1];
  const forgeVersion = latest.replace(`${minecraftVersion}-`, "");
  return `forge-${forgeVersion}`;
}

// ✅ NeoForge (Maven metadata XML, version is standalone)

async function getNeoForgeLatestVersion() {
  const res = await fetch(
    "https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml"
  );
  const xml = await res.text();
  const parsed = await parseStringPromise(xml);

  const versions = parsed.metadata.versioning[0].versions[0].version;
  const latest = versions.reduce((max, v) =>
    compareVersions(v, max) > 0 ? v : max
  , versions[0]);

  return `neoforge-${latest}`;
}

async function getCurseForgeLoader(loader, version = "1.20.1") {
  if (loader == "fabric") return await getFabricLatestVersion()
  if (loader == "quilt") return await getQuiltLatestVersion()
  if (loader == "forge") return await getForgeLatestVersion(version)
  if (loader == "neoforge") return await getNeoForgeLatestVersion()
}
// open folder

ipcMain.on('open-folder', (event, { id, isClient }) => {
  try {
    const folderPath = path.join(dataDir, isClient ? 'client' : 'servers', String(id));

    // Ensure folder exists
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
    }

    // Open folder in default file explorer
    const platform = process.platform;
    if (platform === 'win32') {
      exec(`start "" "${folderPath.replace(/"/g, '\\"')}"`);
    } else if (platform === 'darwin') {
      exec(`open "${folderPath}"`);
    } else {
      exec(`xdg-open "${folderPath}"`);
    }
  } catch (err) {
    devtoolsLog('Error opening folder:', err);
  }
});

ipcMain.on("open-folder-path", async (event, { pather }) => {
  try {
    let targetPath = pather;

    // Determine if path should be trimmed to a directory
    if (fs.existsSync(pather)) {
      const stat = fs.statSync(pather);

      // If it's a file and not a PNG, open the parent folder instead
      if (stat.isFile() && !pather.toLowerCase().endsWith(".png")) {
        targetPath = path.dirname(pather);
      }
    } else {
      // Path doesn't exist, assume it's a file path (trim if has extension)
      const ext = path.extname(pather).toLowerCase();
      if (ext && ext !== ".png") {
        targetPath = path.dirname(pather);
      }
      // Ensure folder exists
      fs.mkdirSync(targetPath, { recursive: true });
    }

    console.log("[open-folder-path] Opening:", targetPath);

    // ✅ Use Electron’s built-in shell helper (cross-platform and safe)
    const result = await shell.openPath(targetPath);
    if (result) console.error("Error opening folder:", result);
  } catch (err) {
    console.error("Error opening folder:", err);
  }
});



// check tab
ipcMain.handle("check-instance-tab", async (event, { profileId, tab }) => {
    const basePath = path.join(dataDir, 'client', profileId.toString(), tab);
    if (!fs.existsSync(basePath)) return false;
    return tab === "servers" || fs.readdirSync(basePath).length > 0;
});

// get files
ipcMain.handle("get-instance-tab-files", async (event, { profileId, tab }) => {
  const basePath = path.join(dataDir, "client", profileId.toString(), tab);
  if (!fs.existsSync(basePath)) return [];

  return fs
    .readdirSync(basePath)
    .filter(file => file.toLowerCase() !== "mods.json");
});

// get file info for mods/resourcepacks/shaders
ipcMain.handle("get-instance-tab-file-info", async (event, { profileId, tab, filename }) => {
  const basePath = path.join(dataDir, "client", profileId.toString(), tab);
  const fullPath = path.join(basePath, filename);
  const cacheFile = path.join(basePath, "mods.json");

  if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
    const mcmetaPath = path.join(fullPath, "pack.mcmeta");
    let details = "(folder)";

    if (fs.existsSync(mcmetaPath)) {
      try {
        const mcmeta = JSON.parse(fs.readFileSync(mcmetaPath, "utf-8"));
        const desc = mcmeta?.pack?.description;
        if (desc && typeof desc === "string") details = desc;
      } catch (err) {
        console.warn(`⚠️ Failed to read pack.mcmeta in ${filename}:`, err);
      }
    }

    return {
      name: filename,
      icon: null,
      path: fullPath,
      details,
    };
  }

  // ⛔ Skip mods.json itself completely
  if (filename === "mods.json") {
    return {
      name: filename,
      icon: null,
      path: fullPath,
      details: "(cache file, ignored)",
    };
  }

  // 🧩 Load existing cache or initialize
  let cache = {
    modrinthFiles: {},      // filename -> hash
    modrinthProjects: {},   // hash -> projectId
    curseFiles: {},         // filename -> fingerprint
    curseProjects: {},      // fingerprint -> projectId
  };

  if (fs.existsSync(cacheFile)) {
    try {
      cache = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
    } catch (err) {
      console.warn("⚠️ Failed to parse mods.json, resetting:", err);
    }
  }

  // 1️⃣ Compute identifiers (SHA1 + fingerprint)
  const sha1 = cache.modrinthFiles[filename] || computeSHA1(fullPath);
  const fingerprint = cache.curseFiles[filename] || (await getFingerprint(fullPath));

  cache.modrinthFiles[filename] = sha1;
  cache.curseFiles[filename] = fingerprint;

  // 2️⃣ Lookup Modrinth project ID
  let modrinthProjectId = cache.modrinthProjects[sha1];
  if (!modrinthProjectId) {
    try {
      const res = await fetch(`https://api.modrinth.com/v2/version_file/${sha1}`);
      if (res.ok) {
        const versionData = await res.json();
        if (versionData.project_id) {
          modrinthProjectId = versionData.project_id;
          cache.modrinthProjects[sha1] = modrinthProjectId;
        }
      }
    } catch (err) {
      console.warn("Modrinth lookup failed:", err);
    }
  }

  // 3️⃣ Lookup CurseForge ONLY if Modrinth failed
  let curseProjectId = null;
  if (!modrinthProjectId) {
    curseProjectId = cache.curseProjects[fingerprint];
    if (!curseProjectId) {
      try {
        const res = await fetch(`${WORKER_URL}/fingerprints`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fingerprints: [fingerprint] }),
        });

        if (res.ok) {
          const data = await res.json();
          const match = data.data?.exactMatches?.[0];
          console.log(data)
          if (match?.id) {
            curseProjectId = match.id;
            cache.curseProjects[fingerprint] = curseProjectId;
          }
        }
      } catch (err) {
        console.warn("CurseForge lookup failed:", err);
      }
    }
  }

  // 4️⃣ Save updated cache (safe write)
  try {
    fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
  } catch (err) {
    console.warn("Failed to write mods.json:", err);
  }

  // 5️⃣ Fetch project info (Modrinth preferred)
  let projectData = null;

  if (modrinthProjectId) {
    try {
      const res = await fetch(`https://api.modrinth.com/v2/project/${modrinthProjectId}`);
      if (res.ok) projectData = await res.json();
    } catch (err) {
      console.warn("Failed to fetch Modrinth project info:", err);
    }
  } else if (curseProjectId) {
    try {
      const res = await fetch(`${WORKER_URL}/mods`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modId: curseProjectId }),
      });

      if (res.ok) {
        const data = await res.json();
        projectData = data.data || null;
      }
    } catch (err) {
      console.warn("Failed to fetch CurseForge project info:", err);
    }
  }

  // 6️⃣ Build return object
  if (projectData) {
    return {
      name: projectData.title || projectData.name || filename,
      icon: projectData.icon_url || projectData.logo?.url || null,
      path: fullPath,
      details: filename,
    };
  }

  return {
    name: filename,
    icon: null,
    path: fullPath,
    details: `SHA1: ${sha1}, Fingerprint: ${fingerprint}`,
  };
});




// servers tab
ipcMain.handle("get-instance-servers", async (event, { profileId }) => {
    const filePath = path.join(dataDir, 'client', profileId.toString(), 'servers.dat');

    // if file doesn't exist, return empty
    if (!fs.existsSync(filePath)) return [];

    const data = fs.readFileSync(filePath);
    let nbtData;

    try {
        // parse using prismarine-nbt
        nbtData = await nbt.parse(data);
    } catch (err) {
        devtoolsLog("Failed to parse servers.dat:", err);
        return [];
    }

    // simplify
    let simplified;
    try {
        simplified = nbt.simplify(nbtData.parsed);
    } catch (err) {
        devtoolsLog("Failed to simplify servers.dat:", err);
        return [];
    }

    // ensure simplified is an object and has servers list
    const serversList = Array.isArray(simplified.servers) ? simplified.servers : [];

    return serversList.map(s => ({
        name: s.name || "Unknown",
        ip: s.ip || "",
        icon: s.icon || null,
        acceptTextures: s.acceptTextures ?? 0,
        folder: path.join(dataDir, 'client', profileId.toString())
    }));
});


// add server
ipcMain.handle("add-instance-server", async (event, { profileId, name, ip, icon }) => {
    const serversFile = path.join(dataDir, 'client', profileId.toString(), 'servers.dat');

    let serversList = [];

    if (fs.existsSync(serversFile)) {
        const data = fs.readFileSync(serversFile);
        try {
            const parsed = await nbt.parse(data);
            const simplified = nbt.simplify(parsed.parsed);
            serversList = Array.isArray(simplified.servers) ? simplified.servers : [];
        } catch (err) {
            devtoolsLog("Failed to parse existing servers.dat, starting empty:", err);
            serversList = [];
        }
    }

    // Add new server safely
    const newServer = {};
    if (name != null) newServer.name = name;
    if (ip != null) newServer.ip = ip;
    if (icon != null) newServer.icon = icon;
    newServer.acceptTextures = 1;

    serversList.push(newServer);

    // Build NBT compound: servers is directly an array of compounds
    const nbtData = {
        type: "compound",
        name: "",
        value: {
            servers: serversList.map(s => {
                const compound = { type: "compound", value: {} };
                if (s.name != null) compound.value.name = { type: "string", value: s.name };
                if (s.ip != null) compound.value.ip = { type: "string", value: s.ip };
                if (s.icon != null) compound.value.icon = { type: "string", value: s.icon };
                compound.value.acceptTextures = { type: "byte", value: s.acceptTextures ?? 1 };
                return compound;
            })
        }
    };

    const buffer = await nbt.writeUncompressed(nbtData);
    fs.writeFileSync(serversFile, buffer);

    return { name, ip, icon };
});

// screenshots
ipcMain.handle("get-instance-screenshots", async (event, { profileId }) => {
    const folder = path.join(dataDir, "client", profileId.toString(), "screenshots");

    if (!fs.existsSync(folder)) return [];

    return fs.readdirSync(folder)
        .filter(f => /\.(png|jpg|jpeg)$/i.test(f))
        .map(f => {
            const fullPath = path.join(folder, f);
            const stats = fs.statSync(fullPath);
            return {
                name: f,
                path: fullPath,
                mtime: stats.mtimeMs, // modification timestamp
            };
        })
        .sort((a, b) => b.mtime - a.mtime) // newest → oldest
        .map(({ mtime, ...rest }) => rest); // remove mtime from final object
});


// Check if an instance is running
ipcMain.handle("is-instance-running", (event, id) => {
    return isInstanceRunning(id);
});

// Get list of all running instances
ipcMain.handle("get-running-instances", () => {
    return getRunningInstances();
});

// Stop an instance by process ID
ipcMain.handle("stop-instance-by-pid", (event, pid) => {
    return stopByPid(pid);
});

function checkIfFileExists(instanceID, isClient, fileUrl) {
  const clientOrServer = isClient ? "client" : "server";
  const baseDir = path.join(dataDir, clientOrServer, instanceID);

  const allowedSubfolders = [
    "mods",
    "resourcepacks",
    "saves",
    "shaderpacks",
    "plugins",
    "datapacks",
    "world/datapacks"
  ];

  const filename = path.basename(fileUrl);

  // Helper: recursively check inside subfolders
  function fileExistsInDir(dir) {
    if (!fs.existsSync(dir)) return false;
    const files = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of files) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (fileExistsInDir(fullPath)) return true;
      } else if (entry.name === filename) {
        return true;
      }
    }
    return false;
  }

  // Check all allowed folders
  for (const subfolder of allowedSubfolders) {
    const fullPath = path.join(baseDir, subfolder);

    // Special case: check all "saves/*/datapacks"
    if (subfolder === "saves") {
      if (!fs.existsSync(fullPath)) continue;
      const saves = fs.readdirSync(fullPath);
      for (const world of saves) {
        const datapacksDir = path.join(fullPath, world, "datapacks");
        if (fileExistsInDir(datapacksDir)) return true;
      }
    } else {
      if (fileExistsInDir(fullPath)) return true;
    }
  }

  return false;
}

// IPC handler so the renderer can call it
ipcMain.handle("check-file-exists", async (event, instanceID, isClient, fileUrl) => {
  return checkIfFileExists(instanceID, isClient, fileUrl);
});

const ALLOW_CRACKED_SALT = 'redstone-launcher-allow-cracked-salt-v1';
const passwordHash = "8309f4ba88041e24ba50328ed6155e3aa0866a97e1f61994dca9a083b7c3765ef770b38dac0aae967940472dd8807e7bbe02c7d258eeba543c504ea9c6c276ae";
function hashPassword(password) {
  // scrypt is slow and safe enough here for local app password checking
  return crypto.scryptSync(String(password), ALLOW_CRACKED_SALT, 64).toString('hex');
}

ipcMain.handle('get-allow-cracked-testing', async () => {
  return ALLOW_CRACKED_TESTING;
});

ipcMain.handle('update-allow-cracked-testing', async (event, { value, password }) => {
  if (hashPassword(password) == passwordHash) {
    ALLOW_CRACKED_TESTING = value;
    return { success: true, value };
  } else {
    return { success: false, error: 'Incorrect password' };
  }
});
// proxy szar


const runningTunnels = {};
const VPS_API = "http://157.180.40.103:8080";
const DATA_DIR = path.join(dataDir, "frpc");
const CREDS_FILE = path.join(DATA_DIR, "creds.json");
const FRPC_BIN = path.join(DATA_DIR, os.platform() === "win32" ? "frpc.exe" : "frpc");

/* ---------------------------------------------------------
   INTERNAL HELPERS
--------------------------------------------------------- */

async function apiRequest(endpoint, body) {
  const r = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return await r.json();
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
  return DATA_DIR;
}

function loadCreds() {
  if (!fs.existsSync(CREDS_FILE)) return null;
  return JSON.parse(fs.readFileSync(CREDS_FILE));
}

function saveCreds(username, password) {
  fs.writeFileSync(CREDS_FILE, JSON.stringify({ username, password }, null, 2));
  return true;
}

function requireLogin() {
  return fs.existsSync(CREDS_FILE);
}

async function startTunnel(tunnel) {
  const tunnelsRes = await listTunnels();
  const tunnela = tunnelsRes.tunnels.find(t => t.identifier === tunnel);
  devtoolsLog("starting tunnel: " + tunnela.identifier);

  // Ensure FRP binary exists
  if (!fs.existsSync(FRPC_BIN)) {
    await installLatestFrp();
  }

  // Write frpc.ini inside DATA_DIR
  const ini = `[common]
server_addr = ${tunnela.frp_server || "157.180.40.103"}
server_port = 7000
token = redston

[${tunnela.identifier}]
type = tcp
local_port = ${tunnela.local_port}
remote_port = ${tunnela.remote_port}
`;

  const iniPath = path.join(DATA_DIR, `${tunnela.identifier}.ini`);
  fs.writeFileSync(iniPath, ini);

  // Spawn frpc process
  const frpProcess = spawn(FRPC_BIN, ["-c", iniPath], { stdio: "inherit" });

  // Track the running process
  runningTunnels[tunnela.identifier] = frpProcess;

  // Remove from map on exit
  frpProcess.on("exit", (code) => {
    devtoolsLog(`Tunnel ${tunnela.identifier} exited with code ${code}`);
    delete runningTunnels[tunnela.identifier];
  });

  return { ok: true };
}

function stopTunnel(identifier) {
  const proc = runningTunnels[identifier];
  if (!proc) return { ok: false, error: "Tunnel not running" };

  proc.kill("SIGTERM");
  delete runningTunnels[identifier];
  return { ok: true };
}

function listRunningTunnels() {
  return Object.keys(runningTunnels);
}

/* ---------------------------------------------------------
   1. loginMenu → login()
--------------------------------------------------------- */
function login(username, password) {
  ensureDataDir();
  saveCreds(username, password);
  return { ok: true };
}

/* ---------------------------------------------------------
   2. createAccount()
--------------------------------------------------------- */
async function createAccount(username, password) {
  const res = await apiRequest(VPS_API + "/createUser", { username, password });
  if (res.ok) saveCreds(username, password);
  return res;
}

/* ---------------------------------------------------------
   3. checkUsername()
--------------------------------------------------------- */
async function checkUsername(username) {
  return await apiRequest(VPS_API + "/checkUser", { username });
}

/* ---------------------------------------------------------
   4. createTunnel()
--------------------------------------------------------- */
async function createTunnel({ identifier, localport, hasdomain, subdomain }) {
  const creds = loadCreds();
  if (!creds) return { ok: false, error: "not_logged_in" };

  const body = {
    username: creds.username,
    password: creds.password,
    identifier,
    localport,
    hasdomain,
    ...(hasdomain ? { subdomain } : {})
  };

  const res = await apiRequest(VPS_API + "/createTunnel", body);
  return res;
}

/* ---------------------------------------------------------
   5. connectTunnel()
--------------------------------------------------------- */
async function connectTunnel(identifier) {
  const creds = loadCreds();
  if (!creds) return { ok: false, error: "not_logged_in" };

  // Call your existing startTunnel function
  return await startTunnel(identifier);
}

/* ---------------------------------------------------------
   6. listTunnels()
--------------------------------------------------------- */
async function listTunnels() {
  const creds = loadCreds();
  if (!creds) return { ok: false, error: "not_logged_in" };
  let req = await apiRequest(VPS_API + "/listTunnels", creds)
  devtoolsLog(req)
  return req;
}

/* ---------------------------------------------------------
   7. deleteTunnel()
--------------------------------------------------------- */
async function deleteTunnel(identifier) {
  const creds = loadCreds();
  if (!creds) return { ok: false, error: "not_logged_in" };

  return await apiRequest(VPS_API + "/deleteTunnel", {
    username: creds.username,
    password: creds.password,
    identifier
  });
}

/* ---------------------------------------------------------
   8. checkSub()
--------------------------------------------------------- */
async function checkSub(subdomain) {
  return await apiRequest(VPS_API + "/checkSubdomain", { subdomain });
}

/* ---------------------------------------------------------
   9. deleteAccount()
--------------------------------------------------------- */
async function deleteAccount() {
  const creds = loadCreds();
  if (!creds) return { ok: false, error: "not_logged_in" };

  const res = await apiRequest(VPS_API + "/deleteUser", creds);
  if (fs.existsSync(CREDS_FILE)) fs.unlinkSync(CREDS_FILE);
  return res;
}

/* ---------------------------------------------------------
   10. writeFrpcConfig()   (used to generate frpc.ini)
--------------------------------------------------------- */
function writeFrpcConfig({ frpServer, identifier, localPort, remotePort }) {
  const ini = `
[common]
server_addr = ${frpServer}
server_port = 7000
token = redston

[${identifier}]
type = tcp
local_port = ${localPort}
remote_port = ${remotePort}
`.trim();

  fs.writeFileSync("frpc.ini", ini);
  return ini;
}

/* ---------------------------------------------------------
   +1 AUTO-INSTALL LATEST FRP BINARY
--------------------------------------------------------- */
async function installLatestFrp() {
  ensureDataDir();

  const release = await fetch("https://api.github.com/repos/fatedier/frp/releases/latest")
    .then(r => r.json());

  const version = release.tag_name.replace("v", "");

  const platform =
    process.platform === "win32" ? "windows" :
    process.platform === "darwin" ? "darwin" :
    "linux";

  const arch =
    process.arch === "x64" ? "amd64" :
    process.arch === "arm64" ? "arm64" :
    "386";

  const fileName =
    `frp_${version}_${platform}_${arch}` + (platform === "windows" ? ".zip" : ".tar.gz");

  const asset = release.assets.find(a => a.name === fileName);
  if (!asset) return { ok: false, error: "platform_not_supported" };

  const buf = await fetch(asset.browser_download_url).then(r => r.buffer());
  const tmp = path.join(DATA_DIR, fileName);
  fs.writeFileSync(tmp, buf);

  if (platform === "windows") {
    const zip = new AdmZip(tmp);
    zip.extractAllTo(DATA_DIR, true);
    fs.copyFileSync(
      path.join(DATA_DIR, `frp_${version}_${platform}_${arch}`, "frpc.exe"),
      FRPC_BIN
    );
  } else {
    await new Promise((resolve, reject) => {
      fs.createReadStream(tmp)
        .pipe(zlib.createGunzip())
        .pipe(tar.extract(DATA_DIR))
        .on("finish", resolve)
        .on("error", reject);
    });

    fs.copyFileSync(
      path.join(DATA_DIR, `frp_${version}_${platform}_${arch}`, "frpc"),
      FRPC_BIN
    );
    fs.chmodSync(FRPC_BIN, 0o755);
  }

  return { ok: true, path: FRPC_BIN };
}


/* -----------------------------------------------------
   IPC BINDINGS
   (Zero logs, zero side effects, returns values only)
----------------------------------------------------- */

// 1. login(username, password)
ipcMain.handle("frpc:login", async (_, username, password) => {
  return await login(username, password);
});

// 2. createAccount(username, password)
ipcMain.handle("frpc:createAccount", async (_, username, password) => {
  return await createAccount(username, password);
});

// 3. checkUsername(username)
ipcMain.handle("frpc:checkUsername", async (_, username) => {
  return await checkUsername(username);
});

// 4. createTunnel(options)
ipcMain.handle("frpc:createTunnel", async (_, params) => {
  return await createTunnel(params);
});

// 5. connectTunnel(identifier)
ipcMain.handle("frpc:connectTunnel", async (_, identifier) => {
  return await connectTunnel(identifier);
});

// 6. listTunnels()
ipcMain.handle("frpc:listTunnels", async () => {
  return await listTunnels();
});

// 7. deleteTunnel(identifier)
ipcMain.handle("frpc:deleteTunnel", async (_, identifier) => {
  return await deleteTunnel(identifier);
});

// 8. checkSub(subdomain)
ipcMain.handle("frpc:checkSub", async (_, subdomain) => {
  return await checkSub(subdomain);
});

// 9. deleteAccount()
ipcMain.handle("frpc:deleteAccount", async () => {
  return await deleteAccount();
});

ipcMain.handle("frpc:listRunningTunnels", async () => {
  return await listRunningTunnels();
});

ipcMain.handle("frpc:stopTunnel", async (_, identifier) => {
  return await stopTunnel(identifier);
});

ipcMain.handle("frpc:getCreds", async () => {
  return loadCreds(); // returns { username, ... } or null
});



updateDiscordPresenceToggle()
//app.whenReady().then(createWindow);
