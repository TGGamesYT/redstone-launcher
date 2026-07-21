process.noDeprecation = true;
let ALLOW_CRACKED_TESTING = false;

import path from 'path';
import https from 'https';
import http from 'http';
import tar from "tar-fs";
import zlib from "zlib";
import fs from 'fs';
const fsp = fs.promises;
import { ssim } from "ssim.js";
import sharp from "sharp";
import { shell, app, BrowserWindow, ipcMain, dialog } from 'electron';
import { vanilla, fabric, quilt, forge, neoforge } from 'tomate-loaders';
import { Client } from 'minecraft-launcher-core';
import { Auth } from 'msmc';
import serverManager from './serverManager.js';
import upnp from './upnp.js';
import AdmZip from 'adm-zip';
import Store from 'electron-store';
import { exec, execSync, spawn } from "child_process";
import crypto from "crypto";
import nbt from "prismarine-nbt";
import RPC from "discord-rpc";
import os from 'os';
import xml2js from "xml2js";
import unzipper from "unzipper";
import QRCode from "qrcode";

const totalRAMMB = Math.floor(os.totalmem() / (1024 * 1024));
const WORKER_URL = "https://curseforge.tgdoescode.workers.dev"
let ACCESS_TOKEN = "";

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

function checkJavaVersion(javaPath, requiredVersion) {
  try {
    const output = execSync(`"${javaPath}" -version 2>&1`).toString();
    const match = output.match(/(?:java|openjdk) version "(?<v>\d+)\.?/);
    if (match && match.groups.v) {
      const sysVer = parseInt(match.groups.v, 10);
      // Minecraft is generally happy with major version matches
      return sysVer === requiredVersion;
    }
  } catch (e) {
    return false;
  }
  return false;
}

function findSystemJava(requiredVersion) {
  const candidates = new Set();

  // 1. Check JAVA_HOME
  if (process.env.JAVA_HOME) {
    const bin = path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    candidates.add(bin);
  }

  // 2. Check PATH
  candidates.add('java');

  // 3. Common paths
  if (process.platform === 'win32') {
    const progFiles = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']];
    for (const p of progFiles) {
      if (!p) continue;
      const javaDir = path.join(p, 'Java');
      if (fs.existsSync(javaDir)) {
        try {
          fs.readdirSync(javaDir).forEach(v => {
            candidates.add(path.join(javaDir, v, 'bin', 'java.exe'));
          });
        } catch (e) {}
      }
    }
  } else if (process.platform === 'linux') {
    const linuxPaths = ['/usr/bin/java', '/usr/lib/jvm'];
    linuxPaths.forEach(p => {
      if (fs.existsSync(p)) {
        if (fs.statSync(p).isDirectory()) {
          try {
            fs.readdirSync(p).forEach(v => {
              candidates.add(path.join(p, v, 'bin', 'java'));
            });
          } catch (e) {}
        } else {
          candidates.add(p);
        }
      }
    });
  }

  for (const c of candidates) {
    if (checkJavaVersion(c, requiredVersion)) return c;
  }
  return null;
}

// ========== INSTANCE TRACKING SYSTEM ==========
const runningInstances = new Map(); // key: unique key (id + pid) -> { id, pid, startTime }
const launchingProfiles = new Map(); // track profiles currently in the launch process - key: profileId, value: timestamp
const instanceLogs = new Map(); // profileId -> string[]
const instanceMeta = new Map(); // profileId -> { name, version } (for Discord presence)

// Renderer log delivery is throttled/batched: minecraft-launcher-core emits a
// huge amount of debug/data lines while downloading, and sending one IPC
// message per line was a big source of UI lag during launch.
const pendingLogs = new Map(); // profileId -> string[] buffered for the renderer
let logFlushTimer = null;

function flushLogs() {
  logFlushTimer = null;
  if (!mainWindow || !mainWindow.webContents || mainWindow.isDestroyed()) {
    pendingLogs.clear();
    return;
  }
  for (const [profileId, lines] of pendingLogs.entries()) {
    if (lines.length) {
      mainWindow.webContents.send('launcher-log', { profileId, msg: lines.join('\n') });
    }
  }
  pendingLogs.clear();
}

function scheduleLogFlush() {
  if (logFlushTimer) return;
  logFlushTimer = setTimeout(flushLogs, 120);
}

function broadcastLog(profileId, msg) {
  if (!instanceLogs.has(profileId)) {
    instanceLogs.set(profileId, []);
  }
  const text = typeof msg === 'string' ? msg.replace(/\r?\n$/, '') : String(msg);
  const logs = instanceLogs.get(profileId);
  logs.push(text);
  if (logs.length > 2000) logs.shift(); // Keep last 2000 lines

  if (!pendingLogs.has(profileId)) pendingLogs.set(profileId, []);
  pendingLogs.get(profileId).push(text);
  scheduleLogFlush();
}

// Human-readable label for minecraft-launcher-core progress phases.
function progressLabel(type) {
  switch (type) {
    case 'assets': return 'Downloading assets';
    case 'assets-copy': return 'Copying assets';
    case 'natives': return 'Extracting natives';
    case 'classes':
    case 'classes-maven-custom': return 'Downloading libraries';
    case 'forge': return 'Installing Forge';
    default: return 'Preparing ' + (type || 'files');
  }
}

// Progress events fire extremely often (per download chunk); throttle them so
// they don't flood the renderer. The leading frame of a burst is sent
// immediately (so the bar appears instantly), intermediate frames are
// rate-limited, and a trailing frame is always flushed so the last state
// before a pause isn't lost. "done" frames bypass the throttle entirely so the
// bar disappears the moment work finishes.
const lastProgressSent = new Map();    // profileId -> timestamp of last send
const pendingProgress = new Map();     // profileId -> { progress, timer }
const PROGRESS_MIN_GAP = 80;           // ms between rate-limited frames
function sendProgressNow(profileId, progress) {
  lastProgressSent.set(profileId, Date.now());
  if (mainWindow && mainWindow.webContents && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('launch-progress', { profileId, ...progress });
  }
}
function broadcastProgress(profileId, progress) {
  // Terminal frames go through immediately and cancel any pending trailing send.
  if (progress.done) {
    const pend = pendingProgress.get(profileId);
    if (pend && pend.timer) clearTimeout(pend.timer);
    pendingProgress.delete(profileId);
    lastProgressSent.delete(profileId);
    sendProgressNow(profileId, progress);
    return;
  }
  const now = Date.now();
  const last = lastProgressSent.get(profileId) || 0;
  const gap = now - last;
  if (gap >= PROGRESS_MIN_GAP) {
    // Leading edge: send right away.
    const pend = pendingProgress.get(profileId);
    if (pend && pend.timer) clearTimeout(pend.timer);
    pendingProgress.delete(profileId);
    sendProgressNow(profileId, progress);
  } else {
    // Too soon: remember the latest frame and flush it when the gap elapses.
    let pend = pendingProgress.get(profileId);
    if (!pend) { pend = { progress: null, timer: null }; pendingProgress.set(profileId, pend); }
    pend.progress = progress;
    if (!pend.timer) {
      pend.timer = setTimeout(() => {
        const p = pendingProgress.get(profileId);
        pendingProgress.delete(profileId);
        if (p && p.progress) sendProgressNow(profileId, p.progress);
      }, PROGRESS_MIN_GAP - gap);
    }
  }
}

// Wire up all of a launcher's events (logs + progress) before launch() is
// called, so download progress isn't missed while the game is being prepared.
function attachLauncherEvents(launcher, profileId) {
  launcher.on('data', msg => broadcastLog(profileId, msg));
  launcher.on('debug', msg => broadcastLog(profileId, msg));
  launcher.on('error', err => broadcastLog(profileId, "ERROR: " + (err?.message || err)));
  launcher.on('progress', (p) => broadcastProgress(profileId, {
    stage: p.type,
    current: p.task,
    total: p.total,
    label: progressLabel(p.type)
  }));
  launcher.on('download-status', (s) => broadcastProgress(profileId, {
    stage: s.type,
    fileName: s.name,
    current: s.current,
    total: s.total,
    bytes: true,
    label: 'Downloading files'
  }));
}

// Running games are detached and survive launcher restarts, so we persist the
// tracker to disk and re-detect live PIDs on startup.
function persistRunningInstances() {
  try { storage.set('runningInstances', Array.from(runningInstances.values())); } catch { /* ignore */ }
}

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function startInstance(id, pid) {
  const now = Date.now();
  const key = `${id}-${pid}`; // unique per process
  runningInstances.set(key, { id, pid, startTime: now });
  persistRunningInstances();
  devtoolsLog(`[Tracker] Started instance ${id} (PID ${pid})`);
}

function stopInstance(id, pid = null) {
  if (pid) {
    const key = `${id}-${pid}`;
    if (runningInstances.has(key)) {
      runningInstances.delete(key);
      devtoolsLog(`[Tracker] Stopped instance ${id} (PID ${pid})`);
      if (!isInstanceRunning(id)) {
        instanceLogs.delete(id); // Clean up logs when fully stopped
      }
    }
  } else {
    // Stop all with same ID
    for (const [key, data] of runningInstances.entries()) {
      if (data.id === id) {
        runningInstances.delete(key);
        devtoolsLog(`[Tracker] Stopped instance ${id} (PID ${data.pid})`);
      }
    }
    instanceLogs.delete(id);
  }
  persistRunningInstances();
}

// Called whenever an instance exits: refresh presence and, if the launcher
// window is already closed and nothing is left running, quit.
function onInstanceExited(profileId) {
  updateGamePresence();
  quitIfHeadlessAndIdle();
}

function quitIfHeadlessAndIdle() {
  if (getRunningInstances().length === 0 && BrowserWindow.getAllWindows().length === 0) {
    app.quit();
  }
}

// On startup, restore tracked games that are still alive, drop the dead ones,
// and poll periodically so games that exit while the launcher is open (or were
// closed externally) get cleaned up and the UI refreshed.
function restoreRunningInstances() {
  let saved = [];
  try { saved = storage.get('runningInstances', []) || []; } catch { saved = []; }
  for (const inst of saved) {
    if (inst && inst.pid && isPidAlive(inst.pid)) {
      runningInstances.set(`${inst.id}-${inst.pid}`, inst);
    }
  }
  persistRunningInstances();

  // Repopulate presence metadata (name/version) for restored games.
  loadProfiles().then(profiles => {
    for (const inst of getRunningInstances()) {
      const profile = profiles.find(p => String(p.id) === String(inst.id));
      if (profile) instanceMeta.set(inst.id, { name: profile.name, version: profile.version });
    }
    updateGamePresence();
  }).catch(() => {});

  setInterval(() => {
    let changed = false;
    for (const [key, data] of runningInstances.entries()) {
      if (!isPidAlive(data.pid)) {
        runningInstances.delete(key);
        if (!isInstanceRunning(data.id)) instanceLogs.delete(data.id);
        changed = true;
        devtoolsLog(`[Tracker] Instance ${data.id} (PID ${data.pid}) is no longer running`);
      }
    }
    if (changed) {
      persistRunningInstances();
      updateGamePresence();
      if (mainWindow && mainWindow.webContents && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('running-instances-changed', getRunningInstances());
      }
      quitIfHeadlessAndIdle();
    }
  }, 4000);
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

ipcMain.handle('get-instance-logs', (event, profileId) => {
  const live = instanceLogs.get(profileId);
  if (live && live.length) return live;

  // No in-memory logs (game already exited, or the launcher was restarted):
  // fall back to the game's own latest.log so the console isn't blank.
  try {
    const logPath = path.join(dataDir, 'client', String(profileId), 'logs', 'latest.log');
    if (fs.existsSync(logPath)) {
      const lines = fs.readFileSync(logPath, 'utf-8').split(/\r?\n/);
      // keep the tail so huge logs don't bog the renderer down
      const tail = lines.slice(-1500);
      return ["[Loaded from latest.log]", ...tail];
    }
  } catch (err) {
    devtoolsLog("Failed to read latest.log:", err);
  }
  return [];
});

function stopByPid(pid) {
  for (const [key, data] of runningInstances.entries()) {
    if (data.pid === pid) {
      try {
        process.kill(pid);
        runningInstances.delete(key);
        persistRunningInstances();
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
const JAVA_DIR = path.join(dataDir, "java_runtimes");
const notificationsPath = path.join(dataDir, 'notifications.json');
const dismissalsPath = path.join(dataDir, 'notification-dismissals.json');

function initNotifications() {
  if (!fs.existsSync(notificationsPath)) {
    fs.writeFileSync(notificationsPath, JSON.stringify([], null, 2));
  }
  if (!fs.existsSync(dismissalsPath)) {
    fs.writeFileSync(dismissalsPath, JSON.stringify({}, null, 2));
  }
}

function getMachineId() {
  if (!settings.has('machineId')) {
    settings.set('machineId', crypto.randomUUID());
  }
  return settings.get('machineId');
}

function loadNotifications() {
  try {
    if (fs.existsSync(notificationsPath)) {
      return JSON.parse(fs.readFileSync(notificationsPath, 'utf8'));
    }
  } catch (e) {
    console.error('Error loading notifications:', e);
  }
  return [];
}

function saveNotifications(notifications) {
  fs.writeFileSync(notificationsPath, JSON.stringify(notifications, null, 2));
}

function loadDismissals() {
  try {
    if (fs.existsSync(dismissalsPath)) {
      return JSON.parse(fs.readFileSync(dismissalsPath, 'utf8'));
    }
  } catch (e) {
    console.error('Error loading dismissals:', e);
  }
  return {};
}

function saveDismissals(dismissals) {
  fs.writeFileSync(dismissalsPath, JSON.stringify(dismissals, null, 2));
}

function dismissNotification(notificationId) {
  const machineId = getMachineId();
  const dismissals = loadDismissals();
  if (!dismissals[notificationId]) {
    dismissals[notificationId] = [];
  }
  if (!dismissals[notificationId].includes(machineId)) {
    dismissals[notificationId].push(machineId);
    saveDismissals(dismissals);
  }
}

function getUnreadNotifications() {
  const machineId = getMachineId();
  const notifications = loadNotifications();
  const dismissals = loadDismissals();
  const now = Date.now();
  
  return notifications.filter(n => {
    const dismissed = dismissals[n.id] && dismissals[n.id].includes(machineId);
    const expired = (now - n.createdAt) > (7 * 24 * 60 * 60 * 1000);
    return !dismissed && !expired;
  });
}

function getNotificationStats() {
  const notifications = loadNotifications();
  const dismissals = loadDismissals();
  
  return {
    totalNotifications: notifications.length,
    dismissalStats: notifications.map(n => ({
      id: n.id,
      title: n.title,
      totalDismissals: dismissals[n.id] ? dismissals[n.id].length : 0,
      createdAt: n.createdAt
    }))
  };
}

initNotifications();
getMachineId();

// Global profile cache to prevent 429 Too Many Requests
let profileCache = new Map(); // playerID -> { data, timestamp }
const PROFILE_CACHE_TTL = 1000 * 60 * 5; // 5 minutes

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

function createAdminWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    icon: path.join(iconPath),
    frame: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  win.loadFile('frontend/admin.html');
  return win;
}

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

const ADMIN_PASSWORD = 'redstone2026@admin';
let adminMode = false;

const args = process.argv.slice(1);
if (args.includes('admin')) {
  const adminIndex = args.indexOf('admin');
  const providedPassword = args[adminIndex + 1];
  if (providedPassword === ADMIN_PASSWORD) {
    adminMode = true;
  } else {
    console.error('Invalid admin password');
    process.exit(1);
  }
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
  process.exit(0);
} else {
  app.on('second-instance', () => {
    // If the window was closed while games kept running, relaunching brings it
    // back instead of starting a second copy.
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else if (!adminMode) {
      createWindow();
    }
  });

  app.whenReady().then(async () => {
    if (adminMode) {
      createAdminWindow();
      return;
    }

    // Apply any update staged on a previous run BEFORE opening the window, so
    // updates never interrupt an active session.
    const applied = await maybeApplyStagedUpdate();
    if (applied) return; // installer launched; app is quitting

    if (!mainWindow) createWindow();

    // Re-detect games still running from a previous launcher session.
    restoreRunningInstances();

    // Quietly stage the next update in the background (no install this run).
    stageUpdateInBackground();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      if (adminMode) {
        createAdminWindow();
      } else {
        createWindow();
      }
    }
  });

  app.on('window-all-closed', () => {
    // Keep the (lightweight) main process alive while games are running so the
    // Discord presence stays active and we keep tracking them. Once nothing is
    // running, quit so the launcher isn't sitting in the background for nothing.
    if (getRunningInstances().length > 0) {
      devtoolsLog('[App] Window closed but games are running; staying alive for presence/tracking.');
      return;
    }
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}

function devtoolsLog(...args) {
  const text = args.map(arg => {
    if (arg instanceof Error) return arg.stack || arg.message;
    if (typeof arg === 'object') {
      try { return JSON.stringify(arg); } catch(e) { return String(arg); }
    }
    return String(arg);
  }).join(' ');

  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send("devtools-log", text);
  }
  console.log(...args);
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

ipcMain.handle('get-setting', (event, key) => {
  return settings.get(key);
});

ipcMain.on('save-settings', (event, newsettings) => {
  let oldshouldconnect = settings.get('discordPresence', true);
  settings.set(newsettings);
  const color = settings.get('baseColor', "#FF0000");
  if (typeof mainWindow.setAccentColor === "function") {
    mainWindow.setAccentColor(color);
  }
  if (oldshouldconnect != settings.get('discordPresence', true)) updateDiscordPresenceToggle();
});

ipcMain.handle('get-system-ram', () => {
  return totalRAMMB;
});

ipcMain.handle('get-unread-notifications', () => {
  return getUnreadNotifications();
});

ipcMain.handle('get-notification-stats', () => {
  return getNotificationStats();
});

ipcMain.on('dismiss-notification', (event, notificationId) => {
  dismissNotification(notificationId);
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('notification-dismissed', notificationId);
  }
});

ipcMain.handle('get-all-notifications', () => {
  return loadNotifications();
});

ipcMain.on('create-notification', (event, notification) => {
  const notifications = loadNotifications();
  const newNotif = {
    id: crypto.randomUUID(),
    title: notification.title,
    message: notification.message,
    moreInfoUrl: notification.moreInfoUrl || null,
    createdAt: Date.now()
  };
  notifications.push(newNotif);
  saveNotifications(notifications);
});

ipcMain.on('delete-notification', (event, notificationId) => {
  const notifications = loadNotifications();
  const filtered = notifications.filter(n => n.id !== notificationId);
  saveNotifications(filtered);
});

/* ─────────────── Player Profiles ─────────────── */
async function refreshPlayer(player) {
  try {
    // QR / device-code accounts use the login.live.com (MBI_SSL, "t=") path,
    // which msmc can't refresh — handle them with the manual chain.
    if (player.authKind === "live") {
      const tok = await refreshLiveToken(player.refresh);
      player.auth = await completeLiveLogin(tok.access_token, player.auth?.client_token);
      player.refresh = tok.refresh_token || player.refresh;
      return player;
    }

    const authManager = new Auth("login");

    const xboxManager = await authManager.refresh(player.refresh)

    const token = await xboxManager.getMinecraft()

    const launcherAuth = token.mclc();

    player.auth = launcherAuth;

    if (token.parent && token.parent.msToken) {
      player.refresh = token.parent.msToken;
    } else if (player.refresh) {
      player.refresh = player.refresh;
    }

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

  return (hasMicrosoftAccount || ALLOW_CRACKED_TESTING)
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
    const authManager = new Auth("select_account");
    const xboxManager = await authManager.launch("electron");
    const token = await xboxManager.getMinecraft();

    const launcherAuth = token.mclc();

    const players = loadPlayers();
    let id = Date.now();
    
    let msToken = token.parent?.msToken || token.refresh_token || "";
    
    players.push({
      id,
      type: "microsoft",
      username: launcherAuth.name,
      auth: launcherAuth,
      refresh: msToken
    });
    savePlayers(players);
    event.reply("players-updated", players);
    setSelectedPlayer(id)
  } catch (err) {
    devtoolsLog("MS login failed:", err);
    event.reply("login-error", "MS login failed: " + (err?.message || JSON.stringify(err) || String(err)));
  }
});

/* ─────────────── QR / device-code login ───────────────
 * Ported from TGGamesYT/mcdev-premlogin (MinecraftOAuthManager). This uses the
 * Microsoft Account (login.live.com) device-code flow with the public Xbox
 * client id and the MBI_SSL scope — NOT the Azure AD flow and NOT msmc. The
 * Azure device-code flow can't grant the Xbox Live consent on a phone ("users
 * are not permitted to consent to first party applications"), whereas this MSA
 * flow is the native Xbox/Minecraft device-login path with no such limit.
 *
 * Tokens from login.live.com are RPS tickets, so the Xbox Live exchange uses
 * the "t=" RpsTicket prefix (the Azure/msmc path uses "d="). These accounts are
 * tagged authKind:"live" so refreshPlayer() refreshes them the same way. */
const MSA_CLIENT_ID = "00000000402b5328";
const LIVE_DEVICECODE_URL = "https://login.live.com/oauth20_connect.srf";
const LIVE_TOKEN_URL = "https://login.live.com/oauth20_token.srf";
const LIVE_SCOPE = "service::user.auth.xboxlive.com::MBI_SSL";
// api.minecraftservices.com is behind Cloudflare and rejects requests with no
// (or Node's default) User-Agent, returning a bare {"path":...} body. A normal
// launcher-style UA is required for the Minecraft auth/profile calls to work.
const LAUNCHER_UA = "RedstoneLauncher/1.15.0 (+https://redstone-launcher.com)";
let qrLoginAbort = null;

async function msDeviceCodeStart() {
  const res = await fetch(LIVE_DEVICECODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": LAUNCHER_UA },
    body: new URLSearchParams({
      client_id: MSA_CLIENT_ID,
      scope: LIVE_SCOPE,
      response_type: "device_code"
    }).toString()
  });
  if (res.status >= 500) throw new Error("Microsoft auth servers are unreachable (HTTP " + res.status + ")");
  const json = await res.json().catch(() => ({}));
  if (!json.device_code) throw new Error("Device code request failed: " + JSON.stringify(json));
  return json; // { user_code, device_code, verification_uri, verification_uri_complete?, interval, expires_in }
}

async function msDeviceCodePoll(deviceCode, interval, expiresIn, isAborted) {
  const deadline = Date.now() + (expiresIn || 900) * 1000;
  let wait = Math.max(interval || 5, 1) * 1000;
  while (Date.now() < deadline) {
    if (isAborted()) throw new Error("__aborted__");
    await new Promise(r => setTimeout(r, wait));
    if (isAborted()) throw new Error("__aborted__");

    const res = await fetch(LIVE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": LAUNCHER_UA },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: MSA_CLIENT_ID,
        device_code: deviceCode
      }).toString()
    });
    if (res.status >= 500) throw new Error("Microsoft auth servers are unreachable (HTTP " + res.status + ")");
    const data = await res.json().catch(() => ({}));
    if (data.access_token) return data; // includes refresh_token
    switch (data.error) {
      case "authorization_pending": continue;
      case "slow_down": wait += 5000; continue;
      case "authorization_declined": throw new Error("Login was declined");
      case "expired_token": throw new Error("The login code expired, please try again");
      default: throw new Error(data.error_description || data.error || "Login failed");
    }
  }
  throw new Error("Login timed out");
}

// Exchange a Microsoft token for an Xbox Live user token. login.live.com
// (device-code) tokens use the "t=" RpsTicket prefix; Azure tokens use "d=".
async function xboxAuthenticate(msToken, azure) {
  const res = await fetch("https://user.auth.xboxlive.com/user/authenticate", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "User-Agent": LAUNCHER_UA },
    body: JSON.stringify({
      Properties: { AuthMethod: "RPS", SiteName: "user.auth.xboxlive.com", RpsTicket: (azure ? "d=" : "t=") + msToken },
      RelyingParty: "http://auth.xboxlive.com",
      TokenType: "JWT"
    })
  });
  if (!res.ok) throw new Error("Xbox Live auth failed (HTTP " + res.status + "): " + await res.text().catch(() => ""));
  const json = await res.json();
  return { token: json.Token, uhs: json.DisplayClaims.xui[0].uhs };
}

async function xstsAuthorize(xblToken) {
  const res = await fetch("https://xsts.auth.xboxlive.com/xsts/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "User-Agent": LAUNCHER_UA },
    body: JSON.stringify({
      Properties: { SandboxId: "RETAIL", UserTokens: [xblToken] },
      RelyingParty: "rp://api.minecraftservices.com/",
      TokenType: "JWT"
    })
  });
  if (!res.ok) throw new Error("XSTS authorization failed (HTTP " + res.status + "): " + await res.text().catch(() => ""));
  const json = await res.json();
  return { token: json.Token, uhs: json.DisplayClaims.xui[0].uhs };
}

async function minecraftLoginWithXbox(uhs, xstsToken) {
  const res = await fetch("https://api.minecraftservices.com/authentication/login_with_xbox", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "User-Agent": LAUNCHER_UA },
    body: JSON.stringify({ identityToken: `XBL3.0 x=${uhs};${xstsToken}` })
  });
  const json = await res.json().catch(() => ({}));
  if (!json.access_token) throw new Error(`Minecraft auth failed (HTTP ${res.status}): ${JSON.stringify(json)}`);
  return json.access_token;
}

async function fetchMinecraftProfile(mcToken) {
  const res = await fetch("https://api.minecraftservices.com/minecraft/profile", {
    headers: { "Authorization": "Bearer " + mcToken, "Accept": "application/json", "User-Agent": LAUNCHER_UA }
  });
  const json = await res.json().catch(() => ({}));
  if (!json.id) throw new Error(`Could not load Minecraft profile (HTTP ${res.status}, account may not own Minecraft): ${JSON.stringify(json)}`);
  return { id: json.id, name: json.name };
}

// Full Xbox -> XSTS -> Minecraft -> profile chain for a login.live.com token,
// returning an mclc-shaped authorization object.
async function completeLiveLogin(msAccessToken, existingClientToken) {
  const xbl = await xboxAuthenticate(msAccessToken, false); // "t=" prefix
  const xsts = await xstsAuthorize(xbl.token);
  const mcToken = await minecraftLoginWithXbox(xsts.uhs, xsts.token);
  const profile = await fetchMinecraftProfile(mcToken);
  return {
    access_token: mcToken,
    client_token: existingClientToken || crypto.randomUUID().replace(/-/g, ""),
    uuid: profile.id,
    name: profile.name,
    user_properties: "{}",
    meta: { type: "msa", demo: false }
  };
}

// Refresh a login.live.com (device-code/QR) account using its refresh token.
async function refreshLiveToken(refreshToken) {
  const res = await fetch(LIVE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": LAUNCHER_UA },
    body: new URLSearchParams({
      client_id: MSA_CLIENT_ID,
      grant_type: "refresh_token",
      scope: LIVE_SCOPE,
      refresh_token: refreshToken
    }).toString()
  });
  const json = await res.json().catch(() => ({}));
  if (!json.access_token) throw new Error("Live token refresh failed: " + JSON.stringify(json));
  return { access_token: json.access_token, refresh_token: json.refresh_token || refreshToken };
}

// Build the URL to encode in the QR: prefer the complete URL Microsoft returns
// (code embedded), else append ?otc=<code> so scanning pre-fills the code.
function qrTarget(dc) {
  if (dc.verification_uri_complete) return dc.verification_uri_complete;
  const sep = dc.verification_uri.includes("?") ? "&" : "?";
  return dc.verification_uri + sep + "otc=" + dc.user_code;
}

ipcMain.on("login-microsoft-qr", async (event) => {
  const myAbort = { aborted: false };
  qrLoginAbort = myAbort;
  const isAborted = () => myAbort.aborted || qrLoginAbort !== myAbort;
  const reply = (payload) => { try { event.reply("qr-login-update", payload); } catch { /* window gone */ } };

  try {
    const dc = await msDeviceCodeStart();
    const link = qrTarget(dc);
    const qr = await QRCode.toDataURL(link, { margin: 1, width: 240 });
    reply({
      status: "pending",
      qr,
      userCode: dc.user_code,
      verificationUri: dc.verification_uri,
      link
    });

    const tokenData = await msDeviceCodePoll(dc.device_code, dc.interval, dc.expires_in, isAborted);
    if (isAborted()) throw new Error("__aborted__");

    // Full manual Xbox/XSTS/Minecraft handshake (login.live.com -> "t=" prefix).
    const auth = await completeLiveLogin(tokenData.access_token);
    if (isAborted()) throw new Error("__aborted__");

    const players = loadPlayers();
    // Replace an existing entry for the same account instead of duplicating.
    const existing = players.find(p => p.type === "microsoft" && p.username === auth.name);
    let id;
    if (existing) {
      id = existing.id;
      existing.auth = auth;
      existing.refresh = tokenData.refresh_token || existing.refresh;
      existing.authKind = "live";
    } else {
      id = Date.now();
      players.push({ id, type: "microsoft", authKind: "live", username: auth.name, auth, refresh: tokenData.refresh_token });
    }
    savePlayers(players);
    setSelectedPlayer(id);

    reply({ status: "success", username: auth.name });
    event.reply("players-updated", players);
  } catch (err) {
    if (myAbort.aborted || (err && err.message === "__aborted__")) {
      reply({ status: "cancelled" });
    } else {
      devtoolsLog("QR login failed:", err);
      reply({ status: "error", error: err?.message || String(err) });
    }
  } finally {
    if (qrLoginAbort === myAbort) qrLoginAbort = null;
  }
});

ipcMain.on("cancel-qr-login", () => {
  if (qrLoginAbort) qrLoginAbort.aborted = true;
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
    alwaysUpdate: !!profile.alwaysUpdate,
    autoUpdateVersion: !!profile.alwaysUpdate,
    created: Date.now(),
    lastUsed: Date.now()
  };

  profiles.push(newProfile);
  saveProfiles(profiles);

  event.reply('profiles-updated', profiles);
  event.reply('profile-created', newProfile);
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
    const profiles = await applySort(unsorted, "lastused-desc", null);
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
    let playerId = accountId
    let quickplaybool = true
    let quickplayip = serverIp

    const profiles = await loadProfiles();
    const players = loadPlayers();

    let profileId = profile_main.id
    const profile = profiles.find(p => p.id === profileId);
    if (!profile) {
      broadcastLog(profileId, "[ERROR] Profile not found");
      return;
    }

    const player = players.find(p => p.id === playerId);
    if (!player) {
      broadcastLog(profileId, "[ERROR] Player not found");
      return;
    }

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
    attachLauncherEvents(launcher, profileId);
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
        // Detached so the game keeps running if the launcher is closed.
        detached: true
      },
      quickPlay: quickplay
    }
    const childProcess = await launcher.launch(opts);

    launchingProfiles.delete(profileId);
    broadcastProgress(profileId, { done: true, label: 'Starting Minecraft' });

    if (childProcess && typeof childProcess.unref === 'function') childProcess.unref();

    const pid = childProcess.pid;
    devtoolsLog("PID: " + pid);
    instanceMeta.set(profileId, { name: profile.name, version: profile.version });
    startInstance(profileId, pid);
    updateGamePresence();
    broadcastLog(profileId, `[INFO] Launched Minecraft instance "${profileId}" (PID ${pid})`);

    // Handle process exit
    childProcess.on('exit', (code) => {
      stopInstance(profileId, pid);
      onInstanceExited(profileId);
      broadcastProgress(profileId, { done: true });
      broadcastLog(profileId, `[INFO] Instance "${profileId}" exited with code ${code}`);
    });
  } catch (err) {
    return { success: false, error: err.message };
  }
});

async function mrpackFromUrl(url) {
  const tmpFile = path.join(os.tmpdir(), `tmp-${Date.now()}.mrpack`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download mrpack: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(tmpFile, buffer);
  return mrpack(tmpFile); // call your existing mrpack() function
}

async function mrpack(mrpackPath, onProgress) {
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

  // Unique instance id/folder derived from the pack name.
  const profileId = getUniqueFolderName(indexJson.name || "Imported Profile");

  // Create instance folder
  const profilesDir = path.join(dataDir, "client");
  if (!fs.existsSync(profilesDir)) fs.mkdirSync(profilesDir, { recursive: true });
  const profileFolder = path.join(profilesDir, `${profileId}`);
  fs.mkdirSync(profileFolder, { recursive: true });

  // Record every file the pack places (path -> sha1) so a later "update
  // modpack" can diff against it and tell user edits from pack changes.
  const packFiles = {};

  // Handle overrides inside the .mrpack (everything except modrinth.index.json)
  zip.getEntries().forEach(entry => {
    if (!entry.isDirectory) {
      const relativePath = mrpackRelPath(entry.entryName);
      if (!relativePath) return;

      const data = entry.getData();
      const entryPath = path.join(profileFolder, relativePath);
      const entryDir = path.dirname(entryPath);
      if (!fs.existsSync(entryDir)) fs.mkdirSync(entryDir, { recursive: true });
      fs.writeFileSync(entryPath, data);
      packFiles[relativePath.split(path.sep).join("/")] = sha1OfBuffer(data);
    }
  });

  // Download files listed in indexJson.files
  const dlList = indexJson.files || [];
  let dlDone = 0;
  for (const fileObj of dlList) {
    const rel = fileObj.path.replace(/\\/g, "/");
    const filePath = path.join(profileFolder, fileObj.path.replace(/\//g, path.sep));
    const fileDir = path.dirname(filePath);
    if (!fs.existsSync(fileDir)) fs.mkdirSync(fileDir, { recursive: true });

    const url = fileObj.downloads[0]; // we take the first URL
    await downloadFile(url, filePath)
    packFiles[rel] = fileObj.hashes?.sha1 || (fs.existsSync(filePath) ? computeSHA1(filePath) : null);
    dlDone++;
    if (typeof onProgress === "function") onProgress(dlDone, dlList.length, rel);
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
    modpack: true,
    created: Date.now(),
    lastUsed: Date.now()
  };

  writeModpackMeta(profileFolder, { name: newProfile.name, files: packFiles });

  const profiles = await loadProfiles();
  profiles.push(newProfile);
  saveProfiles(profiles);
  devtoolsLog(profileId)

  return { success: true, profile: newProfile };
}

const MODPACK_META = ".modpackmeta.json";

function sha1OfBuffer(buf) {
  return crypto.createHash("sha1").update(buf).digest("hex");
}

// Path an .mrpack entry maps to inside the instance folder (strips overrides/;
// keeps root-level files; skips the manifest and server-only overrides). Shared
// by import and the update-diff so both agree on what a pack "owns".
function mrpackRelPath(entryName) {
  if (entryName === "modrinth.index.json") return null;
  if (entryName === "icon.png") return null; // pack icon, not an instance file
  if (entryName.startsWith("overrides/")) return entryName.slice("overrides/".length) || null;
  if (entryName.startsWith("client-overrides/")) return entryName.slice("client-overrides/".length) || null;
  if (entryName.startsWith("server-overrides/")) return null; // server-only
  return entryName;
}

function writeModpackMeta(profileFolder, meta) {
  try {
    fs.writeFileSync(path.join(profileFolder, MODPACK_META), JSON.stringify({ ...meta, updatedAt: Date.now() }));
  } catch (e) { devtoolsLog("Failed to write modpack meta:", e); }
}

function readModpackMeta(profileFolder) {
  try { return JSON.parse(fs.readFileSync(path.join(profileFolder, MODPACK_META), "utf8")); } catch { return null; }
}

// Parse a .mrpack file into { name, files: { relPath -> { sha1, source } } }
// WITHOUT writing anything. `source` says where to fetch the file when applying
// an update: a download URL, or an override entry inside the zip.
function readMrpackPlan(zipPath) {
  const zip = new AdmZip(zipPath);
  const indexEntry = zip.getEntry("modrinth.index.json");
  if (!indexEntry) throw new Error("modrinth.index.json not found in .mrpack");
  const indexJson = JSON.parse(indexEntry.getData().toString("utf8"));

  const files = {};
  for (const f of indexJson.files || []) {
    const rel = f.path.replace(/\\/g, "/");
    files[rel] = { sha1: f.hashes?.sha1 || null, source: { type: "url", url: f.downloads?.[0] || null } };
  }
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const rel = mrpackRelPath(entry.entryName);
    if (!rel) continue;
    const relKey = rel.split(path.sep).join("/");
    files[relKey] = { sha1: sha1OfBuffer(entry.getData()), source: { type: "override", entryName: entry.entryName } };
  }
  return { name: indexJson.name || "Modpack", deps: indexJson.dependencies || {}, files };
}

// Prepared-but-not-applied modpack updates, keyed by profile id.
const pendingModpackUpdates = new Map();

// Resolve rel -> absolute path inside the instance, guarding against traversal.
function safeInstancePath(profileFolder, rel) {
  const dest = path.resolve(path.join(profileFolder, rel.split("/").join(path.sep)));
  if (dest !== path.resolve(profileFolder) && !dest.startsWith(path.resolve(profileFolder) + path.sep)) return null;
  return dest;
}

// Diff a new .mrpack against the instance's stored modpack meta + current disk
// state, returning a plan the renderer can present before anything is written.
ipcMain.handle("prepare-modpack-update", async (event, { profileId }) => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: "Select the new .mrpack to update to",
      filters: [{ name: "Modrinth Pack", extensions: ["mrpack"] }],
      properties: ["openFile"]
    });
    if (canceled || !filePaths.length) return { success: false, error: "No file selected" };
    const newZipPath = filePaths[0];

    const profileFolder = path.join(dataDir, "client", String(profileId));
    const oldMeta = readModpackMeta(profileFolder);
    const oldFiles = oldMeta?.files || {};              // rel -> sha1
    const newPlan = readMrpackPlan(newZipPath);
    const newFiles = newPlan.files;                     // rel -> { sha1, source }

    const curHash = (rel) => {
      const p = safeInstancePath(profileFolder, rel);
      try { return p && fs.existsSync(p) ? computeSHA1(p) : null; } catch { return null; }
    };

    const add = [], updateSafe = [], updateConflict = [], deleteSafe = [], deleteModified = [];

    // Files present in the NEW pack.
    for (const rel of Object.keys(newFiles)) {
      const oldSha = oldFiles[rel] || null;
      const newSha = newFiles[rel].sha1;
      const cur = curHash(rel);
      if (!oldSha) {
        if (cur == null) { add.push(rel); }                 // brand-new file
        else if (cur !== newSha) { updateConflict.push(rel); } // user-added, differs
        continue;
      }
      if (oldSha === newSha) {                                // pack didn't change it
        if (cur == null) add.push(rel);                      // user deleted → reinstall
        continue;
      }
      // Pack changed this file.
      if (cur == null) add.push(rel);                        // user deleted → install new
      else if (cur === oldSha) updateSafe.push(rel);         // untouched → safe update
      else updateConflict.push(rel);                         // user modified → ask
    }

    // Files that the OLD pack had but the NEW pack drops.
    for (const rel of Object.keys(oldFiles)) {
      if (newFiles[rel]) continue;
      const cur = curHash(rel);
      if (cur == null) continue;                             // already gone
      if (cur === oldFiles[rel]) deleteSafe.push(rel);       // untouched → safe delete
      else deleteModified.push(rel);                         // user modified → ask
    }

    const plan = { add, updateSafe, updateConflict, deleteSafe, deleteModified };
    pendingModpackUpdates.set(String(profileId), { newZipPath, newPlan, plan });

    return { success: true, hasMeta: !!oldMeta, name: newPlan.name, plan };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Apply a previously-prepared modpack update using the user's per-file choices.
// decisions = { conflicts: { rel: "update"|"keep" }, deletes: { rel: "delete"|"keep" } }
ipcMain.handle("apply-modpack-update", async (event, { profileId, decisions }) => {
  try {
    const stash = pendingModpackUpdates.get(String(profileId));
    if (!stash) return { success: false, error: "No prepared update — please start again." };
    const { newZipPath, newPlan, plan } = stash;
    const profileFolder = path.join(dataDir, "client", String(profileId));
    const zip = new AdmZip(newZipPath);

    decisions = decisions || {};
    const conflictChoice = decisions.conflicts || {};
    const deleteChoice = decisions.deletes || {};

    const writeFile = async (rel) => {
      const info = newPlan.files[rel];
      const dest = safeInstancePath(profileFolder, rel);
      if (!info || !dest) return;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (info.source.type === "url" && info.source.url) {
        await downloadFile(info.source.url, dest);
      } else if (info.source.type === "override") {
        const entry = zip.getEntry(info.source.entryName);
        if (entry) fs.writeFileSync(dest, entry.getData());
      }
    };
    const rmFile = (rel) => {
      const dest = safeInstancePath(profileFolder, rel);
      try { if (dest && fs.existsSync(dest)) fs.unlinkSync(dest); } catch { /* ignore */ }
    };

    for (const rel of plan.add) await writeFile(rel);
    for (const rel of plan.updateSafe) await writeFile(rel);
    for (const rel of plan.updateConflict) if (conflictChoice[rel] === "update") await writeFile(rel);
    for (const rel of plan.deleteSafe) rmFile(rel);
    for (const rel of plan.deleteModified) if (deleteChoice[rel] === "delete") rmFile(rel);

    // New meta = the new pack's file map (only for files that now exist).
    const files = {};
    for (const rel of Object.keys(newPlan.files)) {
      const dest = safeInstancePath(profileFolder, rel);
      if (dest && fs.existsSync(dest)) {
        try { files[rel] = newPlan.files[rel].sha1 || computeSHA1(dest); } catch { /* skip */ }
      }
    }
    writeModpackMeta(profileFolder, { name: newPlan.name, files });
    pendingModpackUpdates.delete(String(profileId));

    // Bring the profile's version/loader in line with the new pack.
    const deps = newPlan.deps || {};
    let loader = "vanilla";
    if (deps["fabric-loader"]) loader = "fabric";
    else if (deps["quilt-loader"]) loader = "quilt";
    else if (deps["forge"]) loader = "forge";
    else if (deps["neoforge"]) loader = "neoforge";
    const profiles = await loadProfiles();
    const idx = profiles.findIndex(p => String(p.id) === String(profileId));
    if (idx !== -1) {
      if (deps["minecraft"]) profiles[idx].version = deps["minecraft"];
      profiles[idx].loader = loader;
      profiles[idx].modpack = true;
      saveProfiles(profiles);
      event.reply?.("profiles-updated", profiles);
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

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

// One import entry point: accepts a Modrinth .mrpack or a CurseForge .zip and
// dispatches by extension, emitting import-progress to the renderer.
ipcMain.handle("import-pack", async (event) => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: "Select a modpack (.mrpack or CurseForge .zip)",
      filters: [{ name: "Modpack", extensions: ["mrpack", "zip"] }],
      properties: ["openFile"]
    });
    if (canceled || !filePaths.length) return { success: false, error: "No file selected" };
    const p = filePaths[0];
    const onProgress = (done, total, label) => {
      try { event.sender.send("import-progress", { done, total, label }); } catch { /* ignore */ }
      // Also surface in the global top-right toolbar progress.
      broadcastProgress("import", { label: label || "Importing modpack", current: done, total });
    };
    onProgress(0, 1, "Reading pack…");
    const res = p.toLowerCase().endsWith(".mrpack")
      ? await mrpack(p, onProgress)
      : await curseforgeImport(p, onProgress);
    try { event.sender.send("import-progress", { done: 1, total: 1, finished: true }); } catch { /* ignore */ }
    broadcastProgress("import", { done: true, label: "Imported" });
    return res;
  } catch (err) {
    try { event.sender.send("import-progress", { finished: true }); } catch { /* ignore */ }
    return { success: false, error: err.message };
  }
});
ipcMain.handle("import-curseforge-code", async (e, code) => {
  try {
    // --- 1. Validate input ---
    if (!code || typeof code !== "string" || code.trim() === "") {
      return { success: false, error: "No CurseForge code provided" };
    }

    const dataDir = path.join(process.env.APPDATA || process.env.HOME, ".yourApp");
    const tempDir = path.join(dataDir, "temp");

    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const zipPath = path.join(tempDir, `${code}.zip`);
    const url = `https://api.curseforge.com/v1/shared-profile/${code}`;

    // --- 2. Download file ---
    try {
      await downloadFile(url, zipPath);
    } catch (downloadErr) {
      return {
        success: false,
        error: downloadErr.message || "Failed to download CurseForge profile"
      };
    }

    // --- 3. Call your existing import handler ---
    return await curseforgeImport(zipPath);

  } catch (err) {
    return { success: false, error: err.message, };
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

async function curseforgeImport(zipPath, onProgress) {
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
  const cfList = manifest.files || [];
  let cfDone = 0;
  for (const fileObj of cfList) {
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
    cfDone++;
    if (typeof onProgress === "function") onProgress(cfDone, cfList.length, `mod ${cfDone}/${cfList.length}`);
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
    created: Date.now(),
    lastUsed: Date.now()
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

  // 5️⃣ Check custom Java path from settings
  const customJava = settings.get('customJavaPath');
  if (customJava && fs.existsSync(customJava)) {
    if (checkJavaVersion(customJava, javaVersion)) {
      return customJava;
    } else {
      devtoolsLog(`[Java] Custom Java path ${customJava} is not compatible with version ${javaVersion}`);
    }
  }

  // 6️⃣ Check system Java
  const systemJava = findSystemJava(javaVersion);
  if (systemJava) {
    devtoolsLog(`[Java] Found compatible system Java: ${systemJava}`);
    return systemJava;
  }

  // 7️⃣ Detect OS & Arch for download
  const platform = process.platform;
  let osName;
  if (platform === "win32") osName = "windows";
  else if (platform === "darwin") osName = "mac";
  else if (platform === "linux") osName = "linux";
  else throw new Error(`Unsupported platform: ${platform}`);

  const arch = os.arch() === "x64" ? "x64" : os.arch() === "arm64" ? "aarch64" : null;
  if (!arch) throw new Error(`Unsupported architecture: ${os.arch()}`);

  // 8️⃣ Check if we already have extracted Java in our runtimes folder
  const installPath = path.join(JAVA_DIR, `${javaVersion}_${osName}_${arch}`);
  const javaBin = path.join(installPath, platform === "win32" ? "bin/javaw.exe" : "bin/java");
  if (fs.existsSync(javaBin)) {
    devtoolsLog(`[Java] Found existing bundled Java ${javaVersion} at ${javaBin}`);
    return javaBin;
  }

  // 9️⃣ If no Java found and auto-download is disabled, stop
  if (settings.get('autoDownloadJava', true) === false) {
    throw new Error(`No compatible Java ${javaVersion} found on your system, and auto-download is disabled in settings.`);
  }

  // 🔟 Fetch Adoptium API JSON
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

  // 10️⃣ Download
  devtoolsLog(`Downloading Java ${javaVersion} for ${mcVersion} from Adoptium...`);
  await downloadFile(downloadUrl, tmpZip);

  // 11️⃣ Extract
  devtoolsLog("Extracting Java...");
  const directory = await unzipper.Open.file(tmpZip);
  for (const entry of directory.files) {
    const entryPathParts = entry.path.split(/[/\\]/);
    entryPathParts.shift();
    const relativePath = entryPathParts.join(path.sep);
    if (!relativePath) continue;
    const destPath = path.join(installPath, relativePath);

    if (entry.type === 'Directory') {
      fs.mkdirSync(destPath, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      await new Promise((resolve, reject) => {
        entry.stream()
          .pipe(fs.createWriteStream(destPath))
          .on('finish', resolve)
          .on('error', reject);
      });
    }
  }

  fs.unlinkSync(tmpZip);

  return javaBin;
}

// Launch profile
ipcMain.on('launch-profile', async (event, { profileId, playerId, quickplaybool, quickplayip, quickPlay }) => {
  const now = Date.now();
  const lastLaunch = launchingProfiles.get(profileId);
  
  // Check if already launching (within last 500ms)
  if (lastLaunch && (now - lastLaunch) < 500) {
    // Silently ignore - prevent spam
    return;
  }
  
  if (launchingProfiles.has(profileId)) {
    broadcastLog(profileId, "[WARN] This profile is already launching. Please wait.");
    return;
  }

  // Check if already running
  const isRunning = Array.from(runningInstances.values()).some(i => i.id === profileId);
  if (isRunning) {
    broadcastLog(profileId, "[WARN] This profile is already running. Please close it first.");
    return;
  }

  launchingProfiles.set(profileId, now);

  try {
    broadcastLog(profileId, "Launching, please wait.");
    // Per-instance RAM override falls back to the global setting.
    const profileForRam = (await loadProfiles()).find(p => String(p.id) === String(profileId)) || {};
    const minRam = `${profileForRam.ramMin || settings.get('ramInstancesMin', 1024)}m`;
    const maxRam = `${profileForRam.ramMax || settings.get('ramInstancesMax', 4096)}m`;
    const profiles = await loadProfiles();
    const players = loadPlayers();

    const profile = profiles.find(p => p.id === profileId);
    if (!profile) {
      launchingProfiles.delete(profileId);
      broadcastLog(profileId, "[ERROR] Profile not found");
      return;
    }
    profile.lastUsed = Date.now();
    saveProfiles(profiles);

    const player = players.find(p => p.id === playerId);
    if (!player) {
      launchingProfiles.delete(profileId);
      broadcastLog(profileId, "[ERROR] Player not found");
      return;
    }

    let auth;
    if (player.type === "cracked") {
      auth = { name: player.username, uuid: "0", access_token: "0" };
    } else {
      try {
        await refreshPlayer(player);
        auth = player.auth
      } catch (err) {
        auth = player.auth
        broadcastLog(profileId, "[ERROR] Failed to refresh Microsoft token: " + err.message);
      }
    }
    // Quick Play: join a server / open a world straight away. Accepts an
    // explicit { type, identifier } (multiplayer/singleplayer/legacy) or the
    // legacy quickplaybool/quickplayip pair.
    let quickplay = null;
    if (quickPlay && quickPlay.type && quickPlay.identifier) {
      quickplay = quickPlay;
    } else if (quickplaybool) {
      quickplay = { type: 'legacy', identifier: quickplayip };
    }

    const rootDir = path.join(dataDir, 'client', String(profile.id));
    fs.mkdirSync(rootDir, { recursive: true });
    const javaPath = await getJavaForMinecraft(profile.version);
    devtoolsLog("Java ready at:", javaPath);

    const launcher = new Client();
    // Attach log + progress listeners BEFORE launch() so the loading bar
    // reflects the (often lengthy) download/prepare phase.
    attachLauncherEvents(launcher, profileId);
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
        // Detached so the game keeps running if the launcher is closed.
        detached: true
      },
      quickPlay: quickplay
    }
    // Per-instance custom JVM args (Instance Settings → Java & Launch).
    const extraArgs = (profileForRam.launchArgs || "").trim();
    if (extraArgs) opts.customArgs = extraArgs.split(/\s+/).filter(Boolean);
    const childProcess = await launcher.launch(opts);

    launchingProfiles.delete(profileId);
    // Downloads are done and the JVM has been spawned.
    broadcastProgress(profileId, { done: true, label: 'Starting Minecraft' });

    // Fully decouple the game from the launcher's event loop so quitting the
    // launcher leaves the game running.
    if (childProcess && typeof childProcess.unref === 'function') childProcess.unref();

    const pid = childProcess.pid;
    devtoolsLog("PID: " + pid);
    instanceMeta.set(profileId, { name: profile.name, version: profile.version });
    startInstance(profileId, pid);
    updateGamePresence();
    broadcastLog(profileId, `[INFO] Launched Minecraft instance "${profileId}" (PID ${pid})`);

    // Handle process exit
    childProcess.on('exit', (code) => {
      stopInstance(profileId, pid);
      onInstanceExited(profileId);
      broadcastProgress(profileId, { done: true });
      broadcastLog(profileId, `[INFO] Instance "${profileId}" exited with code ${code}`);
    });
  } catch (err) {
    launchingProfiles.delete(profileId);
    broadcastLog(profileId, "[ERROR] " + err.message);
  }
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
  return serverManager.restartServer(id, settings);
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

ipcMain.handle("delete-server", (event, id) => {
  return serverManager.deleteServer(id);
});

ipcMain.handle("get-server-info", (event, id) => {
  return serverManager.getServerInfo(id);
});

ipcMain.handle("get-server-properties", (event, id) => {
  return serverManager.getServerProperties(id);
});

ipcMain.handle("save-server-properties", (event, id, text) => {
  return serverManager.saveServerProperties(id, text);
});

ipcMain.handle("server-fs:list", (event, { name, path: rel }) => serverManager.listFiles(name, rel));
ipcMain.handle("server-fs:read", (event, { name, path: rel }) => serverManager.readFile(name, rel));
ipcMain.handle("server-fs:write", (event, { name, path: rel, text }) => serverManager.writeFile(name, rel, text));
ipcMain.handle("server-fs:delete", (event, { name, path: rel }) => serverManager.deleteFile(name, rel));

// ── UPnP auto port-forward (self-hosting) ──
ipcMain.handle("upnp:open", async (event, { port, description }) => {
  try {
    // Open TCP (Minecraft Java) — and UDP too, harmless if unused, needed for
    // some query/voice mods.
    const r = await upnp.openPort(Number(port), "TCP", description || "Redstone Launcher server");
    try { await upnp.openPort(Number(port), "UDP", description || "Redstone Launcher server"); } catch { /* UDP is best-effort */ }
    return r;
  } catch (err) { console.error("[UPnP] open failed:", err); return { success: false, error: err.message }; }
});

ipcMain.handle("upnp:close", async (event, { port }) => {
  try {
    const r = await upnp.closePort(Number(port), "TCP");
    try { await upnp.closePort(Number(port), "UDP"); } catch { /* ignore */ }
    return r;
  } catch (err) { console.error("[UPnP] close failed:", err); return { success: false, error: err.message }; }
});

// Public IP lookup: try the router (UPnP) first, then fall back to an external
// HTTPS service so this always resolves as long as there's internet.
function fetchPublicIpExternal() {
  return new Promise((resolve, reject) => {
    const req = https.get("https://api.ipify.org", { timeout: 6000 }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        const ip = data.trim();
        /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? resolve(ip) : reject(new Error("Bad response"));
      });
    });
    req.on("timeout", () => req.destroy(new Error("Timed out")));
    req.on("error", reject);
  });
}

ipcMain.handle("upnp:externalIp", async () => {
  try {
    const ip = await upnp.getExternalIP();
    if (ip) return { success: true, ip };
    throw new Error("empty");
  } catch (err) {
    console.warn("[UPnP] router IP lookup failed, using external service:", err.message);
    try { return { success: true, ip: await fetchPublicIpExternal(), viaExternal: true }; }
    catch (e2) { return { success: false, error: e2.message }; }
  }
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
    const fileName = decodeURIComponent(path.basename(fileUrl.split("?")[0])); // removes query params if any
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

    // Decode %20 etc. so the saved file keeps its real name (spaces, +, …).
    const fileName = decodeURIComponent(path.basename(new URL(fileUrl).pathname));
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

// Set up (once) an instance for a Modrinth server project, then return its id so
// the caller can launch + quick-join. Re-running with the same server project
// reuses the existing instance instead of re-importing.
ipcMain.handle("setup-server-instance", async (event, { projectId, name, address, iconUrl, mrpackUrl, kind, version }) => {
  try {
    const SETUP_ID = "server-setup";
    // Already set up? Reuse it.
    let profiles = await loadProfiles();
    const existing = profiles.find(p => p.serverProjectId && String(p.serverProjectId) === String(projectId));
    if (existing) return { success: true, profileId: existing.id, existed: true };

    let profileId;
    if (mrpackUrl) {
      broadcastProgress(SETUP_ID, { label: "Downloading modpack", current: 0, total: 1 });
      const tmpPath = path.join(app.getPath("temp"), `srv-${Date.now()}.mrpack`);
      await downloadFile(mrpackUrl, tmpPath);
      const res = await mrpack(tmpPath, (done, total, label) =>
        broadcastProgress(SETUP_ID, { label: "Installing " + (name || "server"), current: done, total }));
      if (!res || !res.success) { broadcastProgress(SETUP_ID, { done: true }); return { success: false, error: res?.error || "import failed" }; }
      profileId = res.profile.id;
    } else {
      // Vanilla-kind server: a plain instance to join from.
      profileId = getUniqueFolderName(name || "Server");
      const folder = path.join(dataDir, "client", String(profileId));
      fs.mkdirSync(folder, { recursive: true });
      profiles = await loadProfiles();
      profiles.push({
        id: profileId, name: name || "Server", version: version || "1.21",
        loader: "vanilla", created: Date.now(), lastUsed: Date.now()
      });
      saveProfiles(profiles);
    }

    // Tag the instance with the server so re-clicks launch instead of re-setup,
    // and give it the project icon when the pack didn't ship one.
    profiles = await loadProfiles();
    const idx = profiles.findIndex(p => String(p.id) === String(profileId));
    if (idx !== -1) {
      profiles[idx].serverProjectId = projectId;
      profiles[idx].serverAddress = address || null;
      profiles[idx].lastUsed = Date.now();
      const defIcon = "https://tggamesyt.dev/assets/redstone_launcher_defaulticon.png";
      if (iconUrl && (!profiles[idx].icon || profiles[idx].icon === defIcon)) profiles[idx].icon = iconUrl;
      saveProfiles(profiles);
    }
    broadcastProgress(SETUP_ID, { done: true, label: "Ready" });
    try { event.sender.send("profiles-updated", profiles); } catch { /* ignore */ }
    return { success: true, profileId, existed: false };
  } catch (err) {
    broadcastProgress("server-setup", { done: true });
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
  const fileName = path.basename(skinPath);

  const form = new FormData();
  form.append('model', model);
  form.append('file', new Blob([skinBuffer], { type: 'image/png' }), fileName);

  const res = await fetch('https://api.minecraftservices.com/minecraft/profile/skins', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`
    },
    body: form
  });

  if (!res.ok) throw new Error(`Failed to upload skin: ${res.statusText}`);
});

/* ─────────────── Helpers ─────────────── */
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {

    const task = () => new Promise((taskResolve, taskReject) => {

      const dir = path.dirname(dest);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const client = url.startsWith("https") ? https : http;
      const request = client.get(url, (res) => {

        // Handle redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          downloadFile(res.headers.location, dest)
            .then(resolve)
            .catch(reject);
          taskResolve();
          return;
        }

        if (res.statusCode !== 200) {
          taskReject(new Error(`Download failed: ${res.statusCode}`));
          return;
        }

        const file = fs.createWriteStream(dest);
        res.pipe(file);

        file.on("finish", () => {
          file.close(() => {
            resolve();
            taskResolve();
          });
        });

        file.on("error", (err) => {
          fs.unlink(dest, () => {});
          taskReject(err);
          reject(err);
        });

      });

      request.on("error", (err) => {
        reject(err);
        taskReject(err);
      });

    });

    downloadQueue.push(task);
    runNextDownload();
  });
}

/* ─────────────── GitHub-Based Updater ─────────────── */

/* ---------- Determine platform-specific asset ---------- */
function getPlatformAssetName() {
  switch (os.platform()) {
    case "win32":
      return "Redstone-Launcher.exe";
    case "linux":
      return "Redstone-Launcher.AppImage";
    case "darwin":
      return "Redstone-Launcher.dmg";
    default:
      return null;
  }
}

/* ---------- Fetch JSON from GitHub ---------- */
async function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "RedstoneLauncher-Updater" } }, res => {
        let data = "";
        res.on("data", chunk => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on("error", reject);
  });
}

/* ---------- Check for updates ---------- */
let cachedUpdate = null;
let lastUpdateCheck = 0;
const UPDATE_CHECK_INTERVAL = 1000 * 60 * 60; // 1 hour

async function checkForUpdate(force = false) {
  const now = Date.now();
  if (!force && cachedUpdate && (now - lastUpdateCheck < UPDATE_CHECK_INTERVAL)) {
    return cachedUpdate;
  }

  const apiURL = `https://api.github.com/repos/tggamesyt/redstone-launcher/releases/latest`;

  let latest;
  try {
    latest = await fetchJSON(apiURL);
  } catch (err) {
    console.error("Failed to check for updates:", err);
    return { updateAvailable: false, error: err.message };
  }

  const currentVersion = app.getVersion();
  const latestVersion = (latest.tag_name || "").replace(/^v/i, "");
  devtoolsLog("current: " + currentVersion + ", latest: " + latestVersion)
  if (!latestVersion || !isVersionNewer(latestVersion, currentVersion)) {
    const result = { updateAvailable: false };
    cachedUpdate = result;
    lastUpdateCheck = Date.now();
    return result;
  }


  const assetName = getPlatformAssetName();
  const asset = latest.assets?.find(a => a.name === assetName);
  devtoolsLog(assetName)
  devtoolsLog(latest)

  if (!asset) {
    console.error("No matching asset found for this platform");
    const result = { updateAvailable: false, error: "No asset for this platform" };
    cachedUpdate = result;
    lastUpdateCheck = Date.now();
    return result;
  }

  const result = {
    updateAvailable: true,
    version: latestVersion,
    assetURL: asset.browser_download_url,
    assetName
  };

  cachedUpdate = result;
  lastUpdateCheck = Date.now();
  return result;
}

/* ---------- Download the update ---------- */
async function downloadUpdate(assetURL, assetName, destDir = app.getPath("temp")) {
  fs.mkdirSync(destDir, { recursive: true });
  const downloadPath = path.join(destDir, assetName);

  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(downloadPath);

    function request(url) {
      https.get(url, { headers: { "User-Agent": "RedstoneLauncher-Updater" } }, res => {
        // Handle redirect (GitHub asset URLs ALWAYS redirect)
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return request(res.headers.location);
        }

        // Reject on bad status
        if (res.statusCode !== 200) {
          return reject(new Error(`Download failed. Status: ${res.statusCode}`));
        }

        // Pipe into file
        res.pipe(file);
        file.on("finish", () => file.close(() => resolve(downloadPath)));
      })
        .on("error", err => {
          fs.unlink(downloadPath, () => reject(err));
        });
    }

    request(assetURL);
  });
}

/* ---------- Install downloaded update ---------- */
async function installUpdate(downloadPath) {
  switch (os.platform()) {
    case "win32":
      spawn(downloadPath, [], {
        detached: true,
        stdio: "ignore"
      }).unref();
      app.quit();
      break;

    case "linux":
      fs.chmodSync(downloadPath, 0o755);
      spawn(downloadPath, [], { detached: true, stdio: "ignore" }).unref();
      app.quit();
      break;

    case "darwin":
      shell.openPath(downloadPath);
      app.quit();
      break;
  }
}

/* ---------- Staged updates ----------
 * We never interrupt a running session to install. Instead, on each startup we
 * (1) apply any update that was staged on a previous run, BEFORE the window
 * opens, and (2) quietly download the newest update in the background and
 * record it as "pending" for next launch. */
const UPDATES_DIR = path.join(dataDir, "updates");

function getPendingUpdate() {
  return settings.get("pendingUpdate", null);
}

// Called before the window is created. If a valid, still-newer update was
// staged previously, run its installer now and quit. Returns true if so.
async function maybeApplyStagedUpdate() {
  const pending = getPendingUpdate();
  if (!pending || !pending.path) return false;

  const stillNewer = pending.version && isVersionNewer(pending.version, app.getVersion());
  if (!stillNewer || !fs.existsSync(pending.path)) {
    // Already up to date, or the staged file vanished — clear it.
    settings.delete("pendingUpdate");
    try { if (pending.path && fs.existsSync(pending.path)) fs.unlinkSync(pending.path); } catch { /* ignore */ }
    return false;
  }

  try {
    devtoolsLog("Applying staged update " + pending.version + " before launch");
    settings.delete("pendingUpdate"); // clear first so a failed install can't loop
    await installUpdate(pending.path); // spawns installer + app.quit()
    return true;
  } catch (err) {
    devtoolsLog("Failed to apply staged update:", err);
    return false;
  }
}

// Runs after the window is open. Downloads the newest update to a stable
// location and records it as pending — without installing it.
async function stageUpdateInBackground() {
  try {
    if (!settings.get("autoUpdates", true)) return;
    const result = await checkForUpdate(true);
    if (!result || !result.updateAvailable) return;

    const pending = getPendingUpdate();
    if (pending && pending.version === result.version && pending.path && fs.existsSync(pending.path)) {
      return; // already staged this version
    }

    const stagedPath = await downloadUpdate(result.assetURL, result.assetName, UPDATES_DIR);
    settings.set("pendingUpdate", { version: result.version, path: stagedPath, assetName: result.assetName });
    devtoolsLog("Update " + result.version + " staged; it will install on next launch.");
  } catch (err) {
    devtoolsLog("Background update staging failed:", err);
  }
}

/* ---------- IPC handlers ---------- */
ipcMain.handle("check-for-updates", async () => {
  return await checkForUpdate();
});

ipcMain.handle("force-check-for-updates", async () => {
  return await checkForUpdate(true);
});

// Renderer asks whether an update is already staged for next launch.
ipcMain.handle("get-pending-update", () => {
  return getPendingUpdate();
});

// Manual "install now" for an already-staged update.
ipcMain.handle("apply-staged-update", async () => {
  const pending = getPendingUpdate();
  if (!pending || !pending.path || !fs.existsSync(pending.path)) {
    return { success: false, error: "No staged update available" };
  }
  try {
    settings.delete("pendingUpdate");
    await installUpdate(pending.path);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("download-and-install", async (event, assetURL, assetName) => {
  try {
    const path = await downloadUpdate(assetURL, assetName);
    devtoolsLog(path)
    await installUpdate(path);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

function isVersionNewer(latest, current) {
  const latestParts = latest.split('.').map(Number);
  const currentParts = current.split('.').map(Number);

  for (let i = 0; i < Math.max(latestParts.length, currentParts.length); i++) {
    const l = latestParts[i] || 0;
    const c = currentParts[i] || 0;
    if (l > c) return true;     // latest is newer
    if (l < c) return false;    // current is newer
  }
  return false; // equal
}

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
    // Profile ids can be strings (e.g. "sulfur"), so compare as strings.
    const profile = profiles.find(p => String(p.id) === String(profileId));
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
      const relPath = f.rel.replace(/\\/g, '/');

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
    const mrpackName = `${profile.name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_') || 'pack'}-${profile.id}.mrpack`;
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
// Keep a single launcher-start timestamp so the elapsed timer in the Discord
// activity doesn't reset every time we update the presence text.
const discordLauncherStart = Date.now();
// Remember the last requested presence so it can be (re)applied the moment we
// (re)connect, instead of resetting to the default.
let lastActivity = { details: "In launcher", state: "Idle" };
// What the UI (renderer pages) last asked for — used only when no game is running.
let lastUiActivity = { details: "In launcher", state: "Idle" };

function startDiscordPresence() {
  shouldconnect = settings.get('discordPresence', true);
  if (!shouldconnect) return;        // user disabled it
  if (rpc) return;                   // already connecting or connected

  const client = new RPC.Client({ transport: 'ipc' });
  rpc = client; // claim the slot immediately so we don't spawn duplicates

  client.on('ready', () => {
    // If the toggle was flipped off (or replaced) while we were connecting,
    // tear this connection down right away.
    if (!shouldconnect || rpc !== client) {
      try { client.destroy(); } catch { /* ignore */ }
      if (rpc === client) { rpc = null; rpcConnected = false; }
      return;
    }
    rpcConnected = true;
    devtoolsLog('[Discord RPC] Connected');
    setActivity(lastActivity.details, lastActivity.state);
  });

  client.on('disconnected', () => {
    if (rpc === client) { rpc = null; rpcConnected = false; }
  });

  client.login({ clientId }).catch(err => {
    devtoolsLog('[Discord RPC] Login failed:', err);
    if (rpc === client) { rpc = null; rpcConnected = false; }
  });
}

// Function to stop Discord presence
function stopDiscordPresence() {
  const client = rpc;
  // Drop our references first so any in-flight 'ready' handler bails out.
  rpc = null;
  rpcConnected = false;
  if (!client) return;
  try { client.clearActivity().catch(() => {}); } catch { /* ignore */ }
  try {
    const res = client.destroy();
    if (res && typeof res.catch === 'function') res.catch(() => {});
  } catch (err) {
    devtoolsLog('[Discord RPC] Error stopping:', err);
  }
  devtoolsLog('[Discord RPC] Disconnected');
}

function setActivity(details = "In launcher", state = "Idle") {
  lastActivity = { details, state };
  if (!rpcConnected || !rpc) return;

  rpc.setActivity({
    details,          // e.g., "Playing Minecraft"
    state,            // e.g., "On version 1.21"
    startTimestamp: discordLauncherStart,
    instance: false
  }).catch(err => {
    devtoolsLog('[Discord RPC] Error setting activity:', err)
  });
}

// Reflect running games in the presence: "Playing Minecraft" + version while a
// game is open, otherwise whatever the UI last requested.
function updateGamePresence() {
  const running = getRunningInstances();
  if (running.length === 0) {
    setActivity(lastUiActivity.details, lastUiActivity.state);
    return;
  }
  const latest = running.slice().sort((a, b) => (b.startTime || 0) - (a.startTime || 0))[0];
  const meta = instanceMeta.get(latest.id) || {};
  const details = running.length > 1 ? `Playing Minecraft · ${running.length} instances` : "Playing Minecraft";
  const state = meta.version
    ? `Version ${meta.version}${meta.name ? " — " + meta.name : ""}`
    : (meta.name || "In game");
  setActivity(details, state);
}

// Idempotent: brings the RPC connection in line with the current setting.
function updateDiscordPresenceToggle() {
  shouldconnect = settings.get('discordPresence', true);
  if (shouldconnect) {
    startDiscordPresence();
  } else {
    stopDiscordPresence();
  }
}

// Optional: expose a function to update presence dynamically
global.setDiscordPresence = setActivity;

ipcMain.on('update-discord-presence', (event, { details, state }) => {
  // Remember what the UI wants, but a running game takes priority.
  lastUiActivity = { details, state };
  if (getRunningInstances().length === 0) {
    setActivity(details, state);
  }
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
  const parsed = await xml2js.parseStringPromise(xml);

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

ipcMain.on('open-folder', (event, { id, isClient, sub }) => {
  try {
    const folderPath = path.join(dataDir, isClient ? 'client' : 'servers', String(id), sub || '');

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

// Open a specific subfolder of an instance (mods, resourcepacks, saves, …).
ipcMain.on("open-instance-folder", (event, { profileId, sub }) => {
  try {
    const folderPath = path.join(dataDir, 'client', String(profileId), sub || "");
    fs.mkdirSync(folderPath, { recursive: true });
    shell.openPath(folderPath);
  } catch (err) {
    devtoolsLog("open-instance-folder failed:", err);
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

/* ─────────────── fast incremental mod detection ───────────────
 * The old flow listed files and then made one IPC round-trip + SHA1 + network
 * lookup PER FILE, re-hashing everything on every visit. This handler does it
 * the way the Modrinth app feels fast:
 *   - keep a small index keyed by filename+mtime+size and only re-hash files
 *     that are new or changed,
 *   - resolve all unknown hashes in a SINGLE batched Modrinth request,
 *   - return everything in one IPC call so the tab paints immediately.
 */
const MOD_INDEX_FILE = ".modindex.json";
const SKIP_TAB_FILES = new Set(["mods.json", MOD_INDEX_FILE]);

// Pull a display name / version / authors out of a mod jar's own metadata, so
// even mods not found on any provider show something meaningful.
function jarAuthorsToString(a) {
  if (!a) return null;
  if (Array.isArray(a)) return a.map(x => typeof x === "string" ? x : (x && x.name) || "").filter(Boolean).join(", ") || null;
  if (typeof a === "string") return a;
  if (typeof a === "object" && a.name) return a.name;
  return null;
}

function readJarMeta(filePath) {
  try {
    const zip = new AdmZip(filePath);
    const fabric = zip.getEntry("fabric.mod.json") || zip.getEntry("quilt.mod.json");
    if (fabric) {
      const j = JSON.parse(zip.readAsText(fabric).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ""));
      if (j.quilt_loader) {
        const q = j.quilt_loader;
        return { name: q.metadata?.name || q.id || null, version: q.version || null, authors: jarAuthorsToString(q.metadata?.contributors) };
      }
      return { name: j.name || j.id || null, version: j.version || null, authors: jarAuthorsToString(j.authors) };
    }
    const toml = zip.getEntry("META-INF/mods.toml") || zip.getEntry("META-INF/neoforge.mods.toml");
    if (toml) {
      const t = zip.readAsText(toml);
      const name = (t.match(/displayName\s*=\s*["'](.*?)["']/) || [])[1] || null;
      let version = (t.match(/\bversion\s*=\s*["'](.*?)["']/) || [])[1] || null;
      const authors = (t.match(/authors\s*=\s*["'](.*?)["']/) || [])[1] || null;
      if (version && version.includes("${")) {
        const mf = zip.getEntry("META-INF/MANIFEST.MF");
        if (mf) {
          const mv = (zip.readAsText(mf).match(/Implementation-Version:\s*(.*)/) || [])[1];
          if (mv) version = mv.trim();
        }
      }
      return { name, version, authors };
    }
    const yml = zip.getEntry("plugin.yml") || zip.getEntry("paper-plugin.yml");
    if (yml) {
      const y = zip.readAsText(yml);
      return {
        name: (y.match(/^name:\s*(.*)$/m) || [])[1]?.trim() || null,
        version: (y.match(/^version:\s*["']?(.*?)["']?\s*$/m) || [])[1]?.trim() || null,
        authors: (y.match(/^author:\s*(.*)$/m) || [])[1]?.trim() || null
      };
    }
  } catch { /* not a readable jar */ }
  return {};
}

// Read a resource pack's pack.mcmeta "description" (from a folder or a .zip),
// returning the RAW text component (string / object / array) so the renderer
// can reproduce Minecraft's colours and formatting.
function readPackDescription(fullPath, isDir) {
  try {
    let text = null;
    if (isDir) {
      const p = path.join(fullPath, "pack.mcmeta");
      if (fs.existsSync(p)) text = fs.readFileSync(p, "utf-8");
    } else if (/\.zip(\.disabled)?$/i.test(fullPath)) {
      const zip = new AdmZip(fullPath);
      const e = zip.getEntry("pack.mcmeta");
      if (e) text = zip.readAsText(e);
    }
    if (!text) return null;
    const j = JSON.parse(text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ""));
    return j?.pack?.description ?? null;
  } catch { return null; }
}

ipcMain.handle("get-instance-mods", async (event, { profileId, tab }) => {
  const basePath = path.join(dataDir, "client", profileId.toString(), tab);
  if (!fs.existsSync(basePath)) return [];

  // Instance loader/version drive update checks.
  let loader = null, gameVersion = null;
  try {
    const profiles = await loadProfiles();
    const profile = profiles.find(p => String(p.id) === String(profileId));
    if (profile) { loader = profile.loader; gameVersion = profile.version; }
  } catch { /* ignore */ }
  const requireLoader = tab === "mods";

  const enabledPacks = tab === "resourcepacks" ? readEnabledResourcePacks(profileId) : null;

  const MOD_INDEX_VERSION = 3; // bump to force a rebuild when the entry shape changes
  const indexFile = path.join(basePath, MOD_INDEX_FILE);
  let index = { version: MOD_INDEX_VERSION, entries: {} };
  if (fs.existsSync(indexFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(indexFile, "utf-8"));
      if (parsed && parsed.entries && parsed.version === MOD_INDEX_VERSION) index = parsed;
    } catch { /* rebuild from scratch */ }
  }

  let dirents = [];
  try { dirents = fs.readdirSync(basePath, { withFileTypes: true }); } catch { return []; }
  // ".toupdate" files are mods/plugins set aside pending a compatible release
  // for the instance's version — hide them from the active content list.
  const files = dirents.filter(d => !SKIP_TAB_FILES.has(d.name.toLowerCase()) && !d.name.endsWith(".toupdate"));

  const results = [];
  const needLookup = []; // { filename, sha1 }

  for (const d of files) {
    const filename = d.name;
    const fullPath = path.join(basePath, filename);

    if (d.isDirectory()) {
      const description = tab === "resourcepacks" ? readPackDescription(fullPath, true) : null;
      const enabled = enabledPacks ? enabledPacks.includes("file/" + filename) : true;
      results.push({ name: filename, filename, icon: null, path: fullPath, details: "(folder)", description, version: null, author: null, disabled: !enabled, enabled, isFolder: true });
      continue;
    }

    let stat;
    try { stat = fs.statSync(fullPath); } catch { continue; }

    const disabled = filename.toLowerCase().endsWith(".disabled");
    let entry = index.entries[filename];
    if (!entry || entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
      // New/changed file: re-hash, re-read jar / pack metadata, invalidate matches.
      entry = {
        mtimeMs: stat.mtimeMs, size: stat.size,
        sha1: computeSHA1(fullPath),
        jar: filename.match(/\.jar(\.disabled)?$/i) ? readJarMeta(fullPath) : {},
        packDescription: tab === "resourcepacks" ? readPackDescription(fullPath, false) : null,
        modrinth: null
      };
      index.entries[filename] = entry;
    }
    if (!entry.modrinth) needLookup.push({ filename, sha1: entry.sha1 });

    const enabled = (tab === "resourcepacks")
      ? (enabledPacks ? enabledPacks.includes("file/" + filename) : true)
      : !disabled;

    results.push({ _filename: filename, path: fullPath, enabled, disabled: !enabled, isFolder: false });
  }

  // Drop index entries for files that have been removed.
  const present = new Set(files.map(f => f.name));
  for (const k of Object.keys(index.entries)) if (!present.has(k)) delete index.entries[k];

  // One batched Modrinth lookup for every still-unknown hash.
  if (needLookup.length) {
    try {
      const hashes = [...new Set(needLookup.map(x => x.sha1))];
      const res = await fetch("https://api.modrinth.com/v2/version_files", {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": LAUNCHER_UA },
        body: JSON.stringify({ hashes, algorithm: "sha1" })
      });
      if (res.ok) {
        const versionMap = await res.json(); // { sha1: versionObject }
        const projectIds = [...new Set(Object.values(versionMap).map(v => v.project_id).filter(Boolean))];
        const projects = {};
        if (projectIds.length) {
          const pr = await fetch(`https://api.modrinth.com/v2/projects?ids=${encodeURIComponent(JSON.stringify(projectIds))}`, { headers: { "User-Agent": LAUNCHER_UA } });
          if (pr.ok) for (const p of await pr.json()) projects[p.id] = p;
        }
        for (const { filename, sha1 } of needLookup) {
          const v = versionMap[sha1];
          if (v?.project_id && index.entries[filename]) {
            const p = projects[v.project_id];
            index.entries[filename].modrinth = {
              projectId: v.project_id,
              title: p?.title || null,
              icon: p?.icon_url || null,
              author: p?.author || null,
              versionNumber: v.version_number || null,
              datePublished: v.date_published || null,
              // Keep incompatible-type dependencies so we can warn when a
              // conflicting mod is installed alongside this one.
              incompatibleWith: (v.dependencies || [])
                .filter(d => d.dependency_type === "incompatible" && d.project_id)
                .map(d => d.project_id)
            };
          }
        }
      }
    } catch (err) {
      console.warn("Batch Modrinth lookup failed:", err);
    }
  }

  // For anything Modrinth didn't recognise, try CurseForge by fingerprint so
  // those items can still open their project page.
  {
    const cfCandidates = results.filter(r => r._filename && !index.entries[r._filename]?.modrinth
      && index.entries[r._filename]?.curse === undefined
      && /\.(jar|zip)(\.disabled)?$/i.test(r._filename));
    if (cfCandidates.length) {
      try {
        for (const r of cfCandidates) {
          const e = index.entries[r._filename];
          if (e.fingerprint === undefined) e.fingerprint = await getFingerprint(r.path);
        }
        const fps = cfCandidates.map(r => index.entries[r._filename].fingerprint).filter(Boolean);
        if (fps.length) {
          const fr = await fetch(`${WORKER_URL}/fingerprints`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fingerprints: fps })
          });
          if (fr.ok) {
            const data = await fr.json();
            const matches = data.data?.exactMatches || [];
            const byFp = {};
            for (const m of matches) { if (m.file?.fileFingerprint) byFp[m.file.fileFingerprint] = m; }
            for (const r of cfCandidates) {
              const e = index.entries[r._filename];
              const m = byFp[e.fingerprint];
              if (m?.id) {
                let title = null, icon = null;
                try {
                  const mr = await fetch(`${WORKER_URL}/mods`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ modId: m.id }) });
                  if (mr.ok) { const md = (await mr.json()).data; title = md?.name || null; icon = md?.logo?.url || null; }
                } catch { /* ignore */ }
                e.curse = { projectId: m.id, title, icon };
              } else {
                e.curse = null; // record "checked, not found"
              }
            }
          }
        }
      } catch (err) {
        console.warn("CurseForge fingerprint lookup failed:", err);
      }
    }
  }

  // Check for updates on Modrinth-matched files (best-effort, cached ~1h).
  if (loader && gameVersion) {
    const now = Date.now();
    await Promise.all(results.filter(r => r._filename).map(async (r) => {
      const e = index.entries[r._filename];
      if (!e?.modrinth?.projectId) return;
      if (e.update && (now - e.update.checkedAt) < 3600000) return; // cached
      try {
        const params = new URLSearchParams();
        params.set("game_versions", JSON.stringify([gameVersion]));
        if (requireLoader && loader) params.set("loaders", JSON.stringify([loader === "vanilla" ? "minecraft" : loader]));
        const vr = await fetch(`https://api.modrinth.com/v2/project/${e.modrinth.projectId}/version?${params.toString()}`, { headers: { "User-Agent": LAUNCHER_UA } });
        if (!vr.ok) return;
        const versions = await vr.json();
        const newest = (Array.isArray(versions) ? versions : []).sort((a, b) => new Date(b.date_published) - new Date(a.date_published))[0];
        if (newest && e.modrinth.datePublished && new Date(newest.date_published) > new Date(e.modrinth.datePublished)) {
          const file = (newest.files || []).find(f => f.primary) || (newest.files || [])[0];
          e.update = { checkedAt: now, available: true, url: file?.url || null, latestNumber: newest.version_number || null };
        } else {
          e.update = { checkedAt: now, available: false };
        }
      } catch { /* ignore */ }
    }));
  }

  // Map installed Modrinth project ids -> display name so we can flag mods that
  // declare an installed project as "incompatible".
  const installedProjects = {};
  for (const fn of Object.keys(index.entries)) {
    const md = index.entries[fn]?.modrinth;
    if (md?.projectId) installedProjects[md.projectId] = md.title || fn;
  }

  // Fold resolved metadata into the results.
  for (const r of results) {
    if (!r._filename) continue;
    const e = index.entries[r._filename];
    const m = e?.modrinth;
    const cf = e?.curse;
    const jar = e?.jar || {};
    const cleanName = r._filename.replace(/\.disabled$/i, "");

    r.filename = r._filename;
    r.name = (m && m.title) || (cf && cf.title) || jar.name || cleanName;
    r.icon = (m && m.icon) || (cf && cf.icon) || null;
    r.version = (m && m.versionNumber) || jar.version || null;
    r.author = (m && m.author) || jar.authors || null;
    r.projectId = (m && m.projectId) || null;
    r.curseId = (cf && cf.projectId) || null;
    r.projectType = m ? "modrinth" : (cf ? "curseforge" : null);
    r.updateAvailable = !!(e?.update?.available);
    r.updateUrl = e?.update?.url || null;
    r.latestVersion = e?.update?.latestNumber || null;
    // Warn if this mod flags an installed mod as incompatible.
    r.incompatibleWith = (m?.incompatibleWith || [])
      .filter(pid => pid !== r.projectId && installedProjects[pid])
      .map(pid => installedProjects[pid]);
    // Resource packs: expose the raw pack.mcmeta description for rich rendering.
    if (tab === "resourcepacks") r.description = e?.packDescription ?? null;
    // Second line: "version • author" (falls back to filename).
    r.details = [r.version, r.author].filter(Boolean).join("  •  ") || cleanName;
    delete r._filename;
  }

  try { fs.writeFileSync(indexFile, JSON.stringify(index)); } catch { /* best effort */ }
  return results;
});

// servers tab
//
// servers.dat is an UNCOMPRESSED, big-endian (Java) NBT file with this shape:
//   TAG_Compound("") {
//     TAG_List("servers") of TAG_Compound {
//       TAG_String("name"), TAG_String("ip"), TAG_String("icon")?,
//       TAG_Byte("acceptTextures")?, TAG_Byte("hidden")?
//     }
//   }
// The previous writer emitted `servers` as a raw JS array of {type:'compound'}
// wrappers instead of a proper TAG_List, which produced a malformed file that
// Minecraft (and re-reads) treated as corrupt. These helpers write the correct
// structure and read it back defensively.

const serversDatPath = (profileId) =>
  path.join(dataDir, 'client', profileId.toString(), 'servers.dat');

async function readServersList(profileId) {
  const filePath = serversDatPath(profileId);
  if (!fs.existsSync(filePath)) return [];
  try {
    const parsed = await nbt.parse(fs.readFileSync(filePath));
    const simplified = nbt.simplify(parsed.parsed);
    return Array.isArray(simplified.servers) ? simplified.servers : [];
  } catch (err) {
    devtoolsLog("Failed to parse servers.dat:", err);
    return [];
  }
}

async function writeServersList(profileId, serversList) {
  const filePath = serversDatPath(profileId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const serverCompounds = serversList.map(s => {
    const value = {};
    value.name = { type: "string", value: String(s.name ?? "") };
    value.ip = { type: "string", value: String(s.ip ?? "") };
    if (s.icon != null && s.icon !== "") value.icon = { type: "string", value: String(s.icon) };
    value.acceptTextures = { type: "byte", value: Number(s.acceptTextures ?? 1) ? 1 : 0 };
    return value; // list elements are bare compound value-maps
  });

  const nbtData = {
    type: "compound",
    name: "",
    value: {
      servers: {
        type: "list",
        value: {
          type: "compound",
          value: serverCompounds
        }
      }
    }
  };

  const buffer = nbt.writeUncompressed(nbtData);
  // Write atomically so a crash mid-write can't truncate/corrupt the file.
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, buffer);
  fs.renameSync(tmp, filePath);
}

ipcMain.handle("get-instance-servers", async (event, { profileId }) => {
  const serversList = await readServersList(profileId);
  return serversList.map((s, index) => ({
    index,
    name: s.name || "Unknown",
    ip: s.ip || "",
    icon: s.icon || null,
    acceptTextures: s.acceptTextures ?? 0,
    folder: path.join(dataDir, 'client', profileId.toString())
  }));
});

// add server
// servers.dat stores the icon as bare base64 (no data: URL prefix).
function normalizeServerIcon(icon) {
  if (!icon) return null;
  return String(icon).replace(/^data:image\/\w+;base64,/, "");
}

ipcMain.handle("add-instance-server", async (event, { profileId, name, ip, icon }) => {
  const serversList = await readServersList(profileId);
  const newServer = { name: name ?? "", ip: ip ?? "", acceptTextures: 1 };
  const ic = normalizeServerIcon(icon);
  if (ic) newServer.icon = ic;
  serversList.push(newServer);
  await writeServersList(profileId, serversList);
  return { success: true, name, ip };
});

// edit server (by index). Pass icon:"" to clear it, null/undefined to keep it.
ipcMain.handle("edit-instance-server", async (event, { profileId, index, name, ip, icon }) => {
  const serversList = await readServersList(profileId);
  if (index < 0 || index >= serversList.length) {
    return { success: false, error: "Server not found" };
  }
  if (name != null) serversList[index].name = name;
  if (ip != null) serversList[index].ip = ip;
  if (icon !== undefined) {
    const ic = normalizeServerIcon(icon);
    if (ic) serversList[index].icon = ic;
    else delete serversList[index].icon;
  }
  await writeServersList(profileId, serversList);
  return { success: true };
});

// delete server (by index)
ipcMain.handle("delete-instance-server", async (event, { profileId, index }) => {
  const serversList = await readServersList(profileId);
  if (index < 0 || index >= serversList.length) {
    return { success: false, error: "Server not found" };
  }
  serversList.splice(index, 1);
  await writeServersList(profileId, serversList);
  return { success: true };
});

// reorder a server from one position to another (drag to reorder)
ipcMain.handle("reorder-instance-server", async (event, { profileId, from, to }) => {
  const serversList = await readServersList(profileId);
  if (from < 0 || from >= serversList.length || to < 0 || to >= serversList.length) {
    return { success: false, error: "Out of range" };
  }
  const [item] = serversList.splice(from, 1);
  serversList.splice(to, 0, item);
  await writeServersList(profileId, serversList);
  return { success: true };
});

// Live server status (MOTD, players, favicon) via mcsrvstat.
ipcMain.handle("get-server-status", async (event, { ip }) => {
  if (!ip) return { online: false };
  try {
    const res = await fetch(`https://api.mcsrvstat.us/3/${encodeURIComponent(ip)}`, {
      headers: { "User-Agent": LAUNCHER_UA }
    });
    const d = await res.json();
    // Prefer the raw (§-coded) MOTD so the UI can render its colours/formatting.
    const motdRaw = d.motd?.raw ? d.motd.raw.join("\n").trim() : null;
    const motdClean = d.motd?.clean ? d.motd.clean.join("\n").trim() : null;
    return {
      online: !!d.online,
      motd: motdRaw || motdClean || null,
      players: d.players ? { online: d.players.online, max: d.players.max } : null,
      version: d.version || null,
      icon: d.icon || null // already a data: URL
    };
  } catch (err) {
    devtoolsLog("Server status lookup failed:", err);
    return { online: false };
  }
});

/* ─────────────── Worlds (singleplayer saves) ─────────────── */
function nbtLongToNumber(v) {
  if (Array.isArray(v)) return v[0] * 4294967296 + (v[1] >>> 0);
  return Number(v) || 0;
}

// Find the directory that actually contains level.dat (handles worlds that were
// zipped/foldered with an extra wrapper directory).
function findLevelDatDir(root, depth = 0) {
  try {
    if (fs.existsSync(path.join(root, "level.dat"))) return root;
    if (depth > 2) return null;
    const subs = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory());
    for (const e of subs) {
      const r = findLevelDatDir(path.join(root, e.name), depth + 1);
      if (r) return r;
    }
  } catch { /* ignore */ }
  return null;
}

ipcMain.handle("get-instance-worlds", async (event, { profileId }) => {
  const savesDir = path.join(dataDir, "client", String(profileId), "saves");
  if (!fs.existsSync(savesDir)) return [];
  const out = [];
  for (const folder of fs.readdirSync(savesDir)) {
    const worldPath = path.join(savesDir, folder);
    let stat; try { stat = fs.statSync(worldPath); } catch { continue; }
    if (!stat.isDirectory()) continue;

    let name = folder, version = null, lastPlayed = 0;
    const levelDat = path.join(worldPath, "level.dat");
    try {
      if (fs.existsSync(levelDat)) {
        const parsed = await nbt.parse(fs.readFileSync(levelDat));
        const d = (nbt.simplify(parsed.parsed) || {}).Data || {};
        name = d.LevelName || folder;
        version = d.Version?.Name || null;
        lastPlayed = nbtLongToNumber(d.LastPlayed);
      }
    } catch (err) { devtoolsLog("level.dat parse failed for", folder, err); }

    let icon = null;
    const iconPath = path.join(worldPath, "icon.png");
    if (fs.existsSync(iconPath)) {
      try { icon = "data:image/png;base64," + fs.readFileSync(iconPath).toString("base64"); } catch { /* ignore */ }
    }
    out.push({ folder, name, version, lastPlayed, icon, path: worldPath });
  }
  out.sort((a, b) => b.lastPlayed - a.lastPlayed);
  return out;
});

ipcMain.handle("import-world", async (event, { profileId, mode }) => {
  // NOTE: Windows/Linux can't show a picker that accepts BOTH a file and a
  // directory at once (combining openFile+openDirectory silently becomes
  // directory-only), which is why .zip import "only took folders". So the
  // caller tells us which kind of picker to show.
  const wantFolder = mode === "folder";
  const result = await dialog.showOpenDialog({
    title: wantFolder ? "Import a world folder" : "Import a world (.zip)",
    properties: wantFolder ? ["openDirectory"] : ["openFile"],
    filters: wantFolder ? [] : [{ name: "World zip", extensions: ["zip"] }]
  });
  if (result.canceled || !result.filePaths.length) return { success: false, cancelled: true };

  const src = result.filePaths[0];
  const savesDir = path.join(dataDir, "client", String(profileId), "saves");
  fs.mkdirSync(savesDir, { recursive: true });

  let worldDir = null;
  let tmp = null;
  try {
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      worldDir = findLevelDatDir(src);
    } else if (src.toLowerCase().endsWith(".zip")) {
      tmp = path.join(app.getPath("temp"), "world-import-" + Date.now());
      fs.mkdirSync(tmp, { recursive: true });
      new AdmZip(src).extractAllTo(tmp, true);
      worldDir = findLevelDatDir(tmp);
    } else {
      return { success: false, error: "Please select a world folder or a .zip" };
    }

    if (!worldDir) return { success: false, error: "No valid world (level.dat) found in the selection" };

    // Name the destination after the world folder, made unique within saves.
    let base = path.basename(worldDir);
    if (!base || base === "." ) base = "world";
    let dest = path.join(savesDir, base);
    let n = 1;
    while (fs.existsSync(dest)) { dest = path.join(savesDir, `${base}-${n++}`); }

    fs.cpSync(worldDir, dest, { recursive: true });
    return { success: true, name: path.basename(dest) };
  } catch (err) {
    devtoolsLog("World import failed:", err);
    return { success: false, error: err.message };
  } finally {
    if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
});

/* ─────────────── enable/disable content ─────────────── */
// Mods & shaders toggle by adding/removing a ".disabled" suffix.
ipcMain.handle("set-mod-enabled", async (event, { profileId, tab, filename, enabled }) => {
  const dir = path.join(dataDir, "client", String(profileId), tab);
  const full = path.join(dir, filename);
  if (!fs.existsSync(full)) return { success: false, error: "File not found" };
  try {
    let target;
    if (enabled) {
      if (!filename.endsWith(".disabled")) return { success: true, filename };
      target = full.replace(/\.disabled$/, "");
    } else {
      if (filename.endsWith(".disabled")) return { success: true, filename };
      target = full + ".disabled";
    }
    fs.renameSync(full, target);
    return { success: true, filename: path.basename(target) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Resource packs are enabled via options.txt (resourcePacks:[...]) rather than
// a file suffix, mirroring how Minecraft itself tracks them.
function readEnabledResourcePacks(profileId) {
  const optionsPath = path.join(dataDir, "client", String(profileId), "options.txt");
  if (!fs.existsSync(optionsPath)) return [];
  try {
    const line = fs.readFileSync(optionsPath, "utf-8").split(/\r?\n/).find(l => l.startsWith("resourcePacks:"));
    if (!line) return [];
    const arr = JSON.parse(line.slice("resourcePacks:".length));
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function writeEnabledResourcePacks(profileId, packs) {
  const optionsPath = path.join(dataDir, "client", String(profileId), "options.txt");
  let lines = [];
  if (fs.existsSync(optionsPath)) lines = fs.readFileSync(optionsPath, "utf-8").split(/\r?\n/);
  const serialized = "resourcePacks:" + JSON.stringify(packs);
  const idx = lines.findIndex(l => l.startsWith("resourcePacks:"));
  if (idx >= 0) lines[idx] = serialized; else lines.push(serialized);
  fs.mkdirSync(path.dirname(optionsPath), { recursive: true });
  fs.writeFileSync(optionsPath, lines.join("\n"));
}

ipcMain.handle("get-enabled-resourcepacks", async (event, { profileId }) => {
  return readEnabledResourcePacks(profileId);
});

ipcMain.handle("set-resourcepack-enabled", async (event, { profileId, filename, enabled }) => {
  try {
    let packs = readEnabledResourcePacks(profileId);
    const entry = "file/" + filename;
    packs = packs.filter(p => p !== entry);
    if (enabled) packs.push(entry);
    writeEnabledResourcePacks(profileId, packs);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Update a mod/pack in place: download the new file, then remove the old one.
ipcMain.handle("update-instance-mod", async (event, { profileId, tab, oldFilename, fileUrl }) => {
  try {
    const dir = path.join(dataDir, "client", String(profileId), tab);
    fs.mkdirSync(dir, { recursive: true });
    const newName = decodeURIComponent(path.basename(new URL(fileUrl).pathname));
    const dest = path.join(dir, newName);
    await downloadFile(fileUrl, dest);

    // Remove the old file unless the update happens to share its name.
    const oldPath = path.join(dir, oldFilename);
    if (path.basename(oldPath) !== newName && fs.existsSync(oldPath)) {
      try { fs.unlinkSync(oldPath); } catch { /* ignore */ }
    }
    // Carry over enabled/disabled state for resource packs.
    if (tab === "resourcepacks") {
      const packs = readEnabledResourcePacks(profileId);
      if (packs.includes("file/" + oldFilename)) {
        writeEnabledResourcePacks(profileId, packs.map(p => p === "file/" + oldFilename ? "file/" + newName : p));
      }
    }
    return { success: true, filename: newName };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Instance version changes + the ".toupdate" system.
//
// When an instance's game version changes, every mod/plugin is checked for a
// compatible release on the new version. If one exists it's downloaded in
// place; if none does (yet), the file is renamed to "<name>.toupdate" and set
// aside. Each time the instance is opened we re-scan the ".toupdate" files and
// pull a now-compatible version if one has since been published. Only mods and
// plugins are touched — the rest (resource/data packs, shaders) rarely break
// across versions.
// ─────────────────────────────────────────────────────────────────────────

const TOUPDATE_SUFFIX = ".toupdate";
const VERSIONED_TABS = ["mods", "plugins"];

// Resolve a file's Modrinth project id straight from its hash (independent of
// the per-tab index cache, so it works for renamed .toupdate files too).
async function modrinthProjectIdForFile(fullPath) {
  try {
    const sha1 = computeSHA1(fullPath);
    const res = await fetch("https://api.modrinth.com/v2/version_files", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": LAUNCHER_UA },
      body: JSON.stringify({ hashes: [sha1], algorithm: "sha1" })
    });
    if (!res.ok) return null;
    const map = await res.json();
    return map[sha1]?.project_id || null;
  } catch { return null; }
}

// Newest Modrinth version of a project that's compatible with gameVersion (and
// the loader for mods). Returns { url, versionNumber, dependencies } or null.
async function findCompatibleModVersion(projectId, gameVersion, loader, requireLoader) {
  try {
    const params = new URLSearchParams();
    params.set("game_versions", JSON.stringify([gameVersion]));
    if (requireLoader && loader) params.set("loaders", JSON.stringify([loader === "vanilla" ? "minecraft" : loader]));
    const vr = await fetch(`https://api.modrinth.com/v2/project/${projectId}/version?${params.toString()}`, { headers: { "User-Agent": LAUNCHER_UA } });
    if (!vr.ok) return null;
    const versions = await vr.json();
    const newest = (Array.isArray(versions) ? versions : []).sort((a, b) => new Date(b.date_published) - new Date(a.date_published))[0];
    if (!newest) return null;
    const file = (newest.files || []).find(f => f.primary) || (newest.files || [])[0];
    return file ? { url: file.url, versionNumber: newest.version_number || null, dependencies: newest.dependencies || [] } : null;
  } catch { return null; }
}

// Ensure every REQUIRED dependency of a candidate version also has a compatible
// release for the target version/loader — so we don't update a mod into a
// dependency-missing crash. Unknown/looping deps are treated as satisfied.
async function requiredDepsSatisfiable(dependencies, gameVersion, loader, requireLoader, seen = new Set()) {
  const required = (dependencies || []).filter(d => d.dependency_type === "required" && d.project_id);
  for (const d of required) {
    if (seen.has(d.project_id)) continue;
    seen.add(d.project_id);
    const dv = await findCompatibleModVersion(d.project_id, gameVersion, loader, requireLoader);
    if (!dv) return false;
    // Recurse one level into the dependency's own required deps.
    if (!(await requiredDepsSatisfiable(dv.dependencies, gameVersion, loader, requireLoader, seen))) return false;
  }
  return true;
}

// Migrate all mods/plugins of an instance to gameVersion. Incompatible files
// are set aside as ".toupdate".
async function migrateContentToVersion(profileId, gameVersion, loader) {
  const report = { updated: [], deferred: [], unchanged: [] };
  for (const tab of VERSIONED_TABS) {
    const dir = path.join(dataDir, "client", String(profileId), tab);
    if (!fs.existsSync(dir)) continue;
    const requireLoader = tab === "mods";
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const filename of files) {
      if (filename.endsWith(TOUPDATE_SUFFIX)) continue;              // handled by the scan
      if (!/\.jar(\.disabled)?$/i.test(filename)) continue;          // only jars
      const fullPath = path.join(dir, filename);
      const projectId = await modrinthProjectIdForFile(fullPath);
      if (!projectId) { report.unchanged.push(filename); continue; } // unknown → leave alone
      const compat = await findCompatibleModVersion(projectId, gameVersion, loader, requireLoader);
      // Only update once the mod AND all its required dependencies have a
      // compatible release — otherwise defer to avoid a missing-dep crash.
      const depsOk = compat ? await requiredDepsSatisfiable(compat.dependencies, gameVersion, loader, requireLoader) : false;
      if (compat && depsOk) {
        try {
          const newName = decodeURIComponent(path.basename(new URL(compat.url).pathname));
          await downloadFile(compat.url, path.join(dir, newName));
          if (newName !== filename) { try { fs.unlinkSync(fullPath); } catch { /* ignore */ } }
          report.updated.push({ from: filename, to: newName });
        } catch { report.unchanged.push(filename); }
      } else {
        // No compatible release (or deps not ready) yet → set aside for later.
        try { fs.renameSync(fullPath, fullPath + TOUPDATE_SUFFIX); report.deferred.push(filename); }
        catch { report.unchanged.push(filename); }
      }
    }
  }
  return report;
}

// Re-check every ".toupdate" file for a now-compatible release. Runs cheaply on
// instance open.
async function scanToUpdate(profileId, gameVersion, loader) {
  const report = { installed: [], stillWaiting: [] };
  for (const tab of VERSIONED_TABS) {
    const dir = path.join(dataDir, "client", String(profileId), tab);
    if (!fs.existsSync(dir)) continue;
    const requireLoader = tab === "mods";
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const filename of files) {
      if (!filename.endsWith(TOUPDATE_SUFFIX)) continue;
      const fullPath = path.join(dir, filename);
      const projectId = await modrinthProjectIdForFile(fullPath);
      if (!projectId) { report.stillWaiting.push(filename); continue; }
      const compat = await findCompatibleModVersion(projectId, gameVersion, loader, requireLoader);
      const depsOk = compat ? await requiredDepsSatisfiable(compat.dependencies, gameVersion, loader, requireLoader) : false;
      if (compat && depsOk) {
        try {
          const newName = decodeURIComponent(path.basename(new URL(compat.url).pathname));
          await downloadFile(compat.url, path.join(dir, newName));
          try { fs.unlinkSync(fullPath); } catch { /* ignore */ }
          report.installed.push({ from: filename, to: newName });
        } catch { report.stillWaiting.push(filename); }
      } else {
        report.stillWaiting.push(filename);
      }
    }
  }
  return report;
}

// Change an instance's game version and migrate its mods/plugins.
ipcMain.handle("change-instance-version", async (event, { profileId, newVersion }) => {
  try {
    const profiles = await loadProfiles();
    const idx = profiles.findIndex(p => String(p.id) === String(profileId));
    if (idx === -1) return { success: false, error: "Instance not found" };
    if (!newVersion) return { success: false, error: "No version given" };
    const loader = profiles[idx].loader;
    if (profiles[idx].version === newVersion) return { success: true, report: null, unchanged: true };
    profiles[idx].version = newVersion;
    saveProfiles(profiles);
    const report = await migrateContentToVersion(profileId, newVersion, loader);
    event.reply?.("profiles-updated", profiles);
    return { success: true, report };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Scan an instance's ".toupdate" files for newly-available compatible versions.
ipcMain.handle("scan-instance-toupdate", async (event, { profileId }) => {
  try {
    const profiles = await loadProfiles();
    const profile = profiles.find(p => String(p.id) === String(profileId));
    if (!profile) return { success: false, error: "Instance not found" };
    const report = await scanToUpdate(profileId, profile.version, profile.loader);
    return { success: true, report };
  } catch (err) {
    return { success: false, error: err.message };
  }
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

  const filename = decodeURIComponent(path.basename(fileUrl));

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

const heartbeatIntervals = {};
const runningTunnels = {};
const VPS_API = "http://157.180.40.103:8080";
const DATA_DIR = path.join(dataDir, "frpc");
const CREDS_FILE = path.join(DATA_DIR, "creds.json");
const FRPC_BIN = path.join(DATA_DIR, os.platform() === "win32" ? "frpc.exe" : "frpc");

/* ---------------------------------------------------------
   INTERNAL HELPERS
--------------------------------------------------------- */
function startHeartbeat(identifier) {
  // már fut → ne indítsuk újra
  if (heartbeatIntervals[identifier]) return;

  heartbeatIntervals[identifier] = setInterval(async () => {
    try {
      await apiRequest(VPS_API + "/tunnelHeartbeat", { identifier });
      devtoolsLog("Heartbeat sent for " + identifier);
    } catch (err) {
      devtoolsLog("Heartbeat failed for " + identifier + ": " + err.message);
    }
  }, 10_000); // 10 sec
}
function stopHeartbeat(identifier) {
  if (heartbeatIntervals[identifier]) {
    clearInterval(heartbeatIntervals[identifier]);
    delete heartbeatIntervals[identifier];
  }
}
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
  const frpProcess = spawn(FRPC_BIN, ["-c", iniPath], { stdio: "inherit", windowsHide: true });

  // Track the running process
  runningTunnels[tunnela.identifier] = frpProcess;
  startHeartbeat(tunnel)
  // Remove from map on exit
  frpProcess.on("exit", (code) => {
    devtoolsLog(`Tunnel ${tunnela.identifier} exited with code ${code}`);
    stopHeartbeat(tunnel)
    delete runningTunnels[tunnela.identifier];
  });

  return { ok: true };
}

function stopTunnel(identifier) {
  const proc = runningTunnels[identifier];
  if (!proc) return { ok: false, error: "Tunnel not running" };
  stopHeartbeat(identifier)
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
  devtoolsLog(res)
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

// log out
async function logout() {
  const creds = loadCreds();
  if (!creds) return { ok: false, error: "not_logged_in" };

  // Just remove local creds, no API calls
  try {
    if (fs.existsSync(CREDS_FILE)) {
      fs.unlinkSync(CREDS_FILE);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: "logout_failed", details: err.message };
  }
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

ipcMain.handle("frpc:logout", async () => {
  return await logout();
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

// Throttle token refreshes: refreshing on every call was slow and got the
// account rate-limited by Mojang.
let lastAuthRefreshAt = 0;
async function authHeaders() {
  const id = storage.get("selectedPlayerId", null);
  const players = await loadPlayers();
  let obj = players.find(item => String(item.id) === String(id));
  if (!obj) throw new Error("No account selected");

  if (Date.now() - lastAuthRefreshAt > 10 * 60 * 1000) {
    try {
      const refreshed = await refreshPlayer(obj);
      if (refreshed?.auth?.access_token) {
        obj = refreshed;
        const idx = players.findIndex(p => String(p.id) === String(id));
        if (idx !== -1) { players[idx] = obj; savePlayers(players); }
        lastAuthRefreshAt = Date.now();
      }
    } catch (e) {
      devtoolsLog("authHeaders refresh failed, using existing token:", e?.message || e);
    }
  }

  const token = obj?.auth?.access_token;
  if (!token) throw new Error("This account has no valid session — please sign in again");
  ACCESS_TOKEN = token;
  return {
    "Authorization": "Bearer " + token,
    "Content-Type": "application/json"
  };
}
const texturesDir = path.join(dataDir, "textures");
const skinsJsonPath = path.join(texturesDir, "skins.json");
const capesJsonPath = path.join(texturesDir, "capes.json");
// Separate file for the user's saved skin library (kept apart from the Mojang
// profile skins cache that mc:getProfile manages).
const skinLibraryPath = path.join(texturesDir, "skinlibrary.json");

// Hash a skin by its DECODED pixels, so two PNGs with identical pixels (but
// different byte encodings) are treated as the same skin.
async function skinPixelHash(base64) {
  const raw = String(base64).replace(/^data:image\/\w+;base64,/, "");
  try {
    const buf = Buffer.from(raw, "base64");
    const px = await sharp(buf).ensureAlpha().raw().toBuffer();
    return crypto.createHash("sha1").update(px).digest("hex");
  } catch {
    return crypto.createHash("sha1").update(raw).digest("hex");
  }
}

// ------------------------
// Helper: load JSON
async function loadJSON(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return [];
  }
}

// Helper: save JSON
async function saveJSON(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

// Helper: Limit simultaneous file operations to prevent EMFILE error
const MAX_CONCURRENT_DOWNLOADS = 10;
let activeDownloads = 0;
const downloadQueue = [];

function runNextDownload() {
  if (downloadQueue.length === 0) return;
  if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS) return;

  const job = downloadQueue.shift();
  activeDownloads++;

  job()
    .catch(() => {})
    .finally(() => {
      activeDownloads--;
      runNextDownload();
    });
}

// ------------------------
// 1️⃣ Skin törlése
ipcMain.handle("skin:delete", async (event, skinHash) => {
  const skins = await loadJSON(skinsJsonPath);
  const index = skins.findIndex(s => s.hash === skinHash);
  if (index === -1) return false;

  const skin = skins[index];

  // Törlés fájlból
  try { await fs.unlink(skin.file); } catch { }

  skins.splice(index, 1);
  await saveJSON(skinsJsonPath, skins);
  return true;
});

// ------------------------
// 2️⃣ Új skin létrehozása (URL vagy local)
ipcMain.handle("skin:add", async (event, options) => {
  // options: { url: string, localFile?: string }
  await fs.mkdir(texturesDir, { recursive: true });

  let filePath;
  if (options.url) {
    const hash = crypto.createHash("sha256").update(options.url).digest("hex");
    filePath = path.join(texturesDir, `${hash}.png`);
    try {
      await fs.access(filePath);
    } catch {
      await downloadFile(options.url, filePath);
    }
  } else if (options.localFile) {
    const buffer = await fs.readFile(options.localFile);
    const hash = crypto.createHash("sha256").update(buffer).digest("hex");
    filePath = path.join(texturesDir, `${hash}.png`);
    await fs.writeFile(filePath, buffer);
  } else {
    throw new Error("No url or localFile provided");
  }

  const hash = await hashImage(filePath);
  const skins = await loadJSON(skinsJsonPath);
  skins.push({ url: options.url || null, file: filePath, hash });
  await saveJSON(skinsJsonPath, skins);

  return { file: filePath, hash };
});

// ------------------------
// 3️⃣ Cape letöltés (Mojang API, fallback a textures mappából)
ipcMain.handle("capes:fetch", async (event, accessToken) => {
  await fs.mkdir(texturesDir, { recursive: true });

  let capes = [];
  try {
    const res = await fetch("https://api.minecraftservices.com/minecraft/profile", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error("Mojang API error");
    const data = await res.json();
    capes = data.capes ?? [];

    for (const cape of capes) {
      const filePath = path.join(texturesDir, `${cape.id}.png`);
      try { await fs.access(filePath); } catch {
        await downloadFile(cape.url, filePath);
      }
      cape.localFile = filePath;
    }

    await saveJSON(capesJsonPath, capes);
  } catch (err) {
    console.warn("Mojang API failed, fallback to textures folder", err);
    capes = await loadJSON(capesJsonPath);
  }

  return capes;
});


// SSIM compare függvény
async function ssimCompare(file1, file2) {
  try {
    const i1 = await sharp(file1).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const i2 = await sharp(file2).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

    const { data: data1, info: info1 } = i1;
    const { data: data2, info: info2 } = i2;

    if (info1.width !== info2.width || info1.height !== info2.height) return 0;

    const result = ssim(
      { data: data1, width: info1.width, height: info1.height },
      { data: data2, width: info2.width, height: info2.height }
    );

    return result.mssim;
  } catch (err) {
    console.error("SSIM decode error:", err);
    return 0;
  }
}

ipcMain.handle("mc:getProfile", async () => {
  const now = Date.now();
  const id = storage.get("selectedPlayerId", null);
  
  if (profileCache.has(id)) {
    const entry = profileCache.get(id);
    if (now - entry.timestamp < PROFILE_CACHE_TTL) {
      return entry.data;
    }
  }

  // 1️⃣ Get selected player
  const players = await loadPlayers();
  let obj1 = players.find(item => item.id === id);
  if (!obj1) return { skins: [], capes: [] };
  
  if (obj1.type === "microsoft") {
    // Only refresh if token is actually close to expiring (check internal msmc logic or assume TTL)
    // We already have a 5-minute profile cache, but let's be even more careful with the session.
    try {
      // Check if we need a refresh based on a simple heuristic to avoid 429
      const lastRefresh = obj1.lastRefresh || 0;
      if (Date.now() - lastRefresh > 1000 * 60 * 30) { // Only refresh every 30 mins
        obj1 = await refreshPlayer(obj1);
        obj1.lastRefresh = Date.now();
        // Save the updated lastRefresh back to players.json
        const allPlayers = await loadPlayers();
        const pIdx = allPlayers.findIndex(p => p.id === obj1.id);
        if (pIdx !== -1) {
          allPlayers[pIdx] = obj1;
          savePlayers(allPlayers);
        }
      }
    } catch (e) {
      if (e.response?.status === 429) {
        console.warn("Too many requests during player refresh, using existing token");
      } else {
        throw e;
      }
    }
  }

  const accessToken = obj1?.auth?.access_token || null;
  const skinsDir = path.join(dataDir, "textures");
  const skinsJsonPath = path.join(skinsDir, "skins.json");

  // 2️⃣ Create folder if missing
  await fsp.mkdir(skinsDir, { recursive: true });

  let data = { skins: [], capes: [] };

  if (accessToken) {
    // 3️⃣ Fetch Mojang profile
    try {
      const response = await fetch("https://api.minecraftservices.com/minecraft/profile", {
        method: "GET",
        headers: { "Authorization": `Bearer ${accessToken}` }
      });

      if (response.ok) {
        data = await response.json();
      }
    } catch (e) {
      devtoolsLog("Failed to fetch Mojang profile:", e);
    }
  }

  // Ensure arrays exist
  data.skins ??= [];
  data.capes ??= [];

  // 4️⃣ Download Mojang skins locally and convert to base64
  for (const skin of data.skins) {
    const hash = skin.textureKey || skin.id;
    const filePath = path.join(skinsDir, `${hash}.png`);
    try {
      await fsp.access(filePath);
    } catch {
      const img = await fetch(skin.url);
      if (img.ok) {
        const buffer = Buffer.from(await img.arrayBuffer());
        await fsp.writeFile(filePath, buffer);
      }
    }
    try {
      const buffer = await fsp.readFile(filePath);
      skin.base64 = buffer.toString('base64');
    } catch (e) {}
    skin.localFile = filePath;
  }

  // Capes base64
  for (const cape of data.capes) {
    const filePath = path.join(skinsDir, `cape_${cape.id}.png`);
    try {
      await fsp.access(filePath);
    } catch {
      const img = await fetch(cape.url);
      if (img.ok) {
        const buffer = Buffer.from(await img.arrayBuffer());
        await fsp.writeFile(filePath, buffer);
      }
    }
    try {
      const buffer = await fsp.readFile(filePath);
      cape.base64 = buffer.toString('base64');
    } catch (e) {}
  }

  // 5️⃣ Return final structure
  const result = {
    id: data.id,
    name: data.name,
    skins: data.skins,
    capes: data.capes,
    profileActions: data.profileActions || {}
  };

  profileCache.set(id, { data: result, timestamp: now });
  return result;
});

async function hashImage(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buffer = await res.arrayBuffer();
    return crypto.createHash("sha256").update(Buffer.from(buffer)).digest("hex");
  } catch (e) {
    return null;
  }
}

// ---- APPLY SKIN ----
async function downloadSkin(url) {
  return new Promise((resolve, reject) => {
    const tempPath = path.join(os.tmpdir(), 'mc-skin.png');
    const file = fs.createWriteStream(tempPath);

    const options = {
      headers: { 'User-Agent': 'RedstoneLauncher-SkinDownloader' }
    };

    const client = url.startsWith("https") ? https : http;
    client.get(url, options, res => {
      if (res.statusCode !== 200) {
        return reject(new Error(`Failed to download skin, status code ${res.statusCode}`));
      }

      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(tempPath)));
    }).on('error', reject);
  });
}

ipcMain.handle("mc:applySkin", async (event, skin) => {
  const headers = await authHeaders(); 
  // IMPORTANT: Remove Content-Type header so fetch can set it automatically with the correct FormData boundary
  delete headers["Content-Type"];

  // Download remote PNG first
  const skinPath = await downloadSkin(skin.url);
  const skinBuffer = await fs.promises.readFile(skinPath);

  const form = new FormData();
  // Mojang expects 'variant' and 'file'. Variant can be 'classic' or 'slim'.
  form.append('variant', (skin.variant || 'classic').toLowerCase());
  form.append('file', new Blob([skinBuffer], { type: 'image/png' }), 'skin.png');

  const res = await fetch("https://api.minecraftservices.com/minecraft/profile/skins", {
    method: 'POST',
    headers: headers,
    body: form
  });

  if (!res.ok) throw new Error(await res.text());
  return true;
});

// ---- APPLY CAPE ----
ipcMain.handle("mc:applyCape", async (event, capeId) => {
  console.log(capeId)
  const body = { capeId };
  let headers = await authHeaders();

  const res = await fetch("https://api.minecraftservices.com/minecraft/profile/capes/active", {
    method: "PUT",
    headers,
    body: JSON.stringify(body)
  });

  if (!res.ok) throw new Error(await res.text());
  return true;
});

// Turn any thrown value / error response into a clean string message so the
// renderer never shows "[object Object]".
async function cleanHttpError(res) {
  let body = "";
  try { body = await res.text(); } catch { /* ignore */ }
  try { const j = JSON.parse(body); body = j.errorMessage || j.error || j.message || body; } catch { /* keep text */ }
  if (res.status === 429) return "Minecraft is rate-limiting skin changes — wait a moment and try again";
  return `Minecraft returned HTTP ${res.status}${body ? ": " + body : ""}`;
}

// ---- UPLOAD a local skin file (base64 PNG) -> applies to Mojang ----
ipcMain.handle("mc:uploadSkin", async (event, { base64, variant }) => {
  try {
    const headers = await authHeaders();
    delete headers["Content-Type"]; // let fetch set the multipart boundary
    const buffer = Buffer.from(String(base64).replace(/^data:image\/\w+;base64,/, ""), "base64");
    const form = new FormData();
    form.append("variant", (variant || "classic").toLowerCase());
    form.append("file", new Blob([buffer], { type: "image/png" }), "skin.png");
    const res = await fetch("https://api.minecraftservices.com/minecraft/profile/skins", {
      method: "POST", headers, body: form
    });
    if (!res.ok) throw new Error(await cleanHttpError(res));
    profileCache.clear(); // active skin changed
    return true;
  } catch (err) {
    throw new Error(err && err.message ? err.message : String(err));
  }
});

// ---- RESET skin to the account's default ----
ipcMain.handle("mc:resetSkin", async () => {
  try {
    const headers = await authHeaders();
    const res = await fetch("https://api.minecraftservices.com/minecraft/profile/skins/active", {
      method: "DELETE", headers
    });
    if (!res.ok) throw new Error(await cleanHttpError(res));
    profileCache.clear();
    return true;
  } catch (err) {
    throw new Error(err && err.message ? err.message : String(err));
  }
});

// ---- DISABLE (remove) the active cape ----
ipcMain.handle("mc:disableCape", async () => {
  try {
    const headers = await authHeaders();
    const res = await fetch("https://api.minecraftservices.com/minecraft/profile/capes/active", {
      method: "DELETE", headers
    });
    if (!res.ok) throw new Error(await cleanHttpError(res));
    profileCache.clear();
    return true;
  } catch (err) {
    throw new Error(err && err.message ? err.message : String(err));
  }
});

// ---- DEFAULT SKINS ----
// Extract the vanilla default player skins straight from the latest client jar
// (the resources.download.minecraft.net URLs derived from file hashes don't
// serve jar contents). Returns [{ name, model, base64 }]; cached per version.
ipcMain.handle("mc:getDefaultSkins", async () => {
  const cacheFile = path.join(texturesDir, "defaultskins.json");
  let latest = null;
  try {
    const manifest = await (await fetch("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json")).json();
    latest = manifest?.latest?.release || null;

    if (fs.existsSync(cacheFile)) {
      try {
        const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
        if (cached.version === latest && Array.isArray(cached.skins) && cached.skins.length) return cached.skins;
      } catch { /* rebuild */ }
    }

    const ver = manifest.versions.find(v => v.id === latest);
    const vj = await (await fetch(ver.url)).json();
    const jarUrl = vj.downloads.client.url;
    const jarBuf = Buffer.from(await (await fetch(jarUrl)).arrayBuffer());
    const zip = new AdmZip(jarBuf);

    const skins = [];
    for (const e of zip.getEntries()) {
      const p = e.entryName;
      if (!p.startsWith("assets/minecraft/textures/entity/player/") || !p.endsWith(".png")) continue;
      const parts = p.split("/");
      const model = parts[parts.length - 2];        // wide | slim
      const name = parts[parts.length - 1].replace(/\.png$/, "");
      if (model !== "wide" && model !== "slim") continue;
      skins.push({ name, model, base64: e.getData().toString("base64") });
    }
    // Sort by name then model for a stable gallery order.
    skins.sort((a, b) => a.name.localeCompare(b.name) || a.model.localeCompare(b.model));

    fs.mkdirSync(texturesDir, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({ version: latest, skins }));
    return skins;
  } catch (err) {
    devtoolsLog("Failed to get default skins:", err);
    // Serve a stale cache if we have one.
    if (fs.existsSync(cacheFile)) {
      try { return JSON.parse(fs.readFileSync(cacheFile, "utf8")).skins || []; } catch { /* ignore */ }
    }
    return [];
  }
});

// ---- LOCAL SKIN LIBRARY (per account uuid) ----
// So a player's previously-used skins persist even if their active skin is
// changed elsewhere. Deduped by decoded-pixel hash.
function loadSkinLib() {
  try { return JSON.parse(fs.readFileSync(skinLibraryPath, "utf8")) || {}; } catch { return {}; }
}
function saveSkinLib(obj) {
  fs.mkdirSync(texturesDir, { recursive: true });
  fs.writeFileSync(skinLibraryPath, JSON.stringify(obj));
}

ipcMain.handle("skins:list", (event, { uuid }) => {
  return loadSkinLib()[uuid] || [];
});

// Add a skin to the library WITHOUT touching Mojang. No-op (returns existing)
// if a pixel-identical skin is already saved.
ipcMain.handle("skins:add", async (event, { uuid, base64, variant, name }) => {
  const b = String(base64 || "").replace(/^data:image\/\w+;base64,/, "");
  if (!b || !uuid) return loadSkinLib()[uuid] || [];
  const pixelHash = await skinPixelHash(b);
  const lib = loadSkinLib();
  const arr = lib[uuid] || [];
  const existing = arr.find(s => s.pixelHash === pixelHash);
  if (existing) {
    // Update the name if a nicer one was provided.
    if (name && existing.name !== name) { existing.name = name; lib[uuid] = arr; saveSkinLib(lib); }
    return arr;
  }
  arr.unshift({ id: Date.now(), pixelHash, name: name || "Skin", base64: b, variant: (variant || "classic"), addedAt: Date.now() });
  lib[uuid] = arr;
  saveSkinLib(lib);
  return arr;
});

ipcMain.handle("skins:remove", (event, { uuid, id }) => {
  const lib = loadSkinLib();
  lib[uuid] = (lib[uuid] || []).filter(s => String(s.id) !== String(id));
  saveSkinLib(lib);
  return lib[uuid];
});

ipcMain.handle("skins:rename", (event, { uuid, id, name }) => {
  const lib = loadSkinLib();
  const arr = lib[uuid] || [];
  const s = arr.find(x => String(x.id) === String(id));
  if (s && name) { s.name = name; lib[uuid] = arr; saveSkinLib(lib); }
  return arr;
});

// Pixel hash for arbitrary base64 (used to detect if the active Mojang skin
// matches a library entry, regardless of PNG encoding).
ipcMain.handle("skins:pixelHash", async (event, { base64 }) => {
  if (!base64) return null;
  return await skinPixelHash(base64);
});

updateDiscordPresenceToggle();
