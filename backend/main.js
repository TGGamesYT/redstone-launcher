process.noDeprecation = true;
let ALLOW_CRACKED_TESTING = false;

import path from 'path';
import https from 'https';
import http from 'http';
import zlib from "zlib";
import fs from 'fs';
const fsp = fs.promises;
import { ssim } from "ssim.js";
import sharp from "sharp";
import { shell, app, BrowserWindow, ipcMain, dialog, utilityProcess } from 'electron';
import { vanilla, fabric, quilt, forge, neoforge } from 'tomate-loaders';
import { getLaunchConfig, resolveNeoForgeVersion, resolveForgeVersion, neoPrefix, compareVersions as loaderCompareVersions } from './loader-versions.js';
import { Client } from 'minecraft-launcher-core';
import { Auth } from 'msmc';
import serverManager from './serverManager.js';
import upnp from './upnp.js';
import relayClient from './relayClient.js';
import fileManager from './fileManager.js';
import remod from './remod.js';
import { convertSkinPixels, slimFromPixels } from './skin-model.js';
import shortcuts from './shortcuts.js';
import AdmZip from 'adm-zip';
import Store from 'electron-store';
import { exec, execSync, spawn } from "child_process";
import crypto from "crypto";
import nbt from "prismarine-nbt";
import RPC from "discord-rpc";
import os from 'os';
import net from 'net';
import dns from 'dns';
import xml2js from "xml2js";
import unzipper from "unzipper";
import QRCode from "qrcode";
import { pathToFileURL } from 'url';
import { createRequire } from 'module';
import { screenSkinPixels } from './skinFilter.js';
import * as iconModels from './icon-models.js';

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

/**
 * Take the secrets out of a line before anyone can read it.
 *
 * The game is started with the account's access token and xuid on the command
 * line, and minecraft-launcher-core prints that command line. So the log a
 * player is looking at — and the log they paste into a bug report or a Discord
 * channel when something goes wrong — contained a live Minecraft session token
 * for their account.
 *
 * Censored at the point the line enters the log rather than on the way out, so
 * there is no copy anywhere that still has it: not in the in-memory buffer, not
 * in what the window is sent, not in a file written from either.
 */
const SECRET_PATTERNS = [
  // --accessToken <jwt>, --uuid, --xuid, --clientId and their = forms.
  [/(--(?:accessToken|access_token|xuid|clientId|session)[=\s]+)(\S+)/gi, (m, a) => a + '****'],
  // "access_token":"...", accessToken: '...' — in JSON and in object dumps.
  [/(["']?(?:access_?token|refresh_?token|xuid|client_?token|id_?token|bearer)["']?\s*[:=]\s*["']?)([A-Za-z0-9._\-+/=]{8,})/gi, (m, a) => a + '****'],
  // Authorization: Bearer <jwt>
  [/(Authorization\s*:\s*Bearer\s+)(\S+)/gi, (m, a) => a + '****'],
  // A bare JWT anywhere else. Three base64url runs separated by dots, long
  // enough that it cannot be ordinary text.
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '****'],
];
function censorSecrets(text) {
  let out = String(text);
  for (const [re, to] of SECRET_PATTERNS) out = out.replace(re, to);
  return out;
}

function broadcastLog(profileId, msg) {
  if (!instanceLogs.has(profileId)) {
    instanceLogs.set(profileId, []);
  }
  const text = censorSecrets(typeof msg === 'string' ? msg.replace(/\r?\n$/, '') : String(msg));
  const logs = instanceLogs.get(profileId);
  logs.push(text);
  if (logs.length > 2000) logs.shift(); // Keep last 2000 lines

  if (!pendingLogs.has(profileId)) pendingLogs.set(profileId, []);
  pendingLogs.get(profileId).push(text);
  scheduleLogFlush();

  detectLanOpen(profileId, text);
}

// When a running instance is opened to LAN, the game prints a SYSTEM chat line
// with the port. The wording varies by version, e.g.:
//   [System] [CHAT] This world is now open to LAN. The port number is [6767]
//   [System] [CHAT] Local game hosted on port [56400]
//   [CHAT] Local game hosted on port 61181
// We surface the port so the instance can be shared over the relay. We require a
// [CHAT] line WITHOUT a "<player>" marker so we don't trigger on someone typing
// a lookalike message.
const lanPorts = new Map(); // profileId -> port
function detectLanOpen(profileId, text) {
  try {
    if (!/\[CHAT\]/i.test(text)) return;
    if (/<[^>]{1,32}>/.test(text)) return; // player chat has <Name>
    if (!/(open to LAN|hosted on port|port number is)/i.test(text)) return;
    const m = text.match(/(?:on port|port number is)\s*\[?\s*(\d{2,5})\b/i);
    if (!m) return;
    const port = parseInt(m[1], 10);
    if (!port) return;
    lanPorts.set(String(profileId), port);
    if (mainWindow && mainWindow.webContents && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('instance-lan-detected', { profileId: String(profileId), port });
    }
  } catch { /* ignore */ }
}
ipcMain.handle("instance:lan-port", (event, { profileId }) => ({ port: lanPorts.get(String(profileId)) || null }));

// Human-readable label for minecraft-launcher-core progress phases.
// What a phase is actually doing. mclc walks every asset and every library on
// every launch and only downloads the ones that are missing or wrong, so
// "Downloading assets" was what it said while it was checking four thousand
// files it already had -- which is what "it downloads everything every time"
// looked like from the outside. A real download says so through its own
// download-status events.
function progressLabel(type) {
  switch (type) {
    case 'assets': return 'Checking assets';
    case 'assets-copy': return 'Copying assets';
    case 'natives': return 'Extracting natives';
    case 'classes':
    case 'classes-maven-custom': return 'Checking libraries';
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
// The newest frame per instance, kept so a page that opens PART WAY through a
// launch can say what is happening. A renderer only hears the frames that are
// sent while it exists, and every navigation is a new renderer.
const latestProgress = new Map();      // profileId -> the last frame sent
const PROGRESS_MIN_GAP = 80;           // ms between rate-limited frames
function sendProgressNow(profileId, progress) {
  lastProgressSent.set(profileId, Date.now());
  if (progress.done) latestProgress.delete(String(profileId));
  else latestProgress.set(String(profileId), progress);
  if (mainWindow && mainWindow.webContents && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('launch-progress', { profileId, ...progress });
  }
  // A shortcut launch has no launcher window, only the little progress card.
  if (launchSplash && !launchSplash.isDestroyed()) {
    launchSplash.webContents.send('launch-progress', { profileId, ...progress });
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
  // NOTE: we intentionally KEEP instanceLogs after an instance stops, so the Logs
  // tab still shows the whole session (including the crash/exit) once it's closed.
  // The logs are cleared at the START of the next launch (see launchProfileCore).
  if (pid) {
    const key = `${id}-${pid}`;
    if (runningInstances.has(key)) {
      runningInstances.delete(key);
      devtoolsLog(`[Tracker] Stopped instance ${id} (PID ${pid})`);
    }
  } else {
    for (const [key, data] of runningInstances.entries()) {
      if (data.id === id) {
        runningInstances.delete(key);
        devtoolsLog(`[Tracker] Stopped instance ${id} (PID ${data.pid})`);
      }
    }
  }
  persistRunningInstances();
}

// Called whenever an instance exits: refresh presence and, if the launcher
// window is already closed and nothing is left running, quit.
// A non-zero exit means the game died rather than being closed. Gather what
// there is to say about it — the exit code, the tail of the session log, and
// the crash report Minecraft writes if it got far enough — and hand it to the
// UI, which was previously silent about crashes entirely.
// Pull the crash out of a log when no crash-report file was written — which is
// the usual case for loader failures, since FML dies before Minecraft's own
// crash handler is in place. Without this the modal falls back to the last few
// hundred lines, which is "all the logs" as far as anyone reading it is
// concerned. Returns null when nothing in the log looks like a failure, and the
// tail is then genuinely the best we have.
function extractCrashFromLog(lines) {
  if (!Array.isArray(lines) || !lines.length) return null;
  const text = lines.map(l => String(l == null ? "" : l));

  // 1. Some crashes print the whole report into the log as well as (or instead
  //    of) writing the file. That block is exactly what we want, verbatim.
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i].includes("---- Minecraft Crash Report ----")) {
      return { text: text.slice(i).join("\n"), kind: "log-report" };
    }
  }

  // 2. Otherwise find the last stack trace and show it with a little of the
  //    context above it, which is usually the line naming the mod at fault.
  const isThrow = (l) =>
    /^\s*(Exception in thread|Caused by:)/.test(l) ||
    /(^|\s)(java|javax|net|com|org|io|cpw)\.[\w.$]*(Exception|Error)(:|\s|$)/.test(l) ||
    /\b[A-Za-z_$][\w$]*(Exception|Error):/.test(l);
  let start = -1;
  for (let i = text.length - 1; i >= 0; i--) {
    if (isThrow(text[i])) { start = i; break; }
  }
  if (start < 0) return null;
  // Walk back over any "Caused by:" chain so the original cause is included.
  while (start > 0 && /^\s*(Caused by:|\s*at |\.\.\. \d+ more)/.test(text[start - 1])) start--;
  const from = Math.max(0, start - 12);
  return { text: text.slice(from).join("\n"), kind: "log-trace" };
}

// What an exit code means, where it means anything.
//
// A JVM that dies on a bad memory access does not write a Minecraft crash
// report and does not print a Java stack trace -- there is no Java left to
// print one. All that reaches the launcher is a number, and "it exited with
// code 3221225477" is not something anybody can act on. These are the codes
// that come up, in the form Windows and POSIX actually report them.
const EXIT_MEANING = new Map([
  [3221225477, "Access violation (0xC0000005) — the game read or wrote memory it does not own. Almost always a graphics driver or a native library rather than the game itself."],
  [-1073741819, "Access violation (0xC0000005) — the game read or wrote memory it does not own. Almost always a graphics driver or a native library rather than the game itself."],
  [3221225781, "A DLL it needs is missing (0xC0000135)."],
  [-1073741515, "A DLL it needs is missing (0xC0000135)."],
  [3221225725, "Stack overflow (0xC00000FD)."],
  [-1073741571, "Stack overflow (0xC00000FD)."],
  [3221226505, "Buffer overrun, caught by Windows (0xC0000409)."],
  [-1073740791, "Buffer overrun, caught by Windows (0xC0000409)."],
  [3221225786, "Interrupted (0xC000013A) — Ctrl+C, or the console it was started from closed."],
  [-1073741510, "Interrupted (0xC000013A) — Ctrl+C, or the console it was started from closed."],
  [1, "The game stopped itself. The log usually says why."],
  [137, "Killed — out of memory, most likely."],
  [139, "Segmentation fault — the game read or wrote memory it does not own."],
  [134, "Aborted by the JVM."],
]);

// The JVM's own crash file. When the virtual machine dies on a bad memory
// access it writes hs_err_pid<n>.log next to the game, and the top of that
// file names the signal, the thread and -- the line that matters -- the
// "Problematic frame", which is the library that actually fell over. That is
// the detail the vanilla launcher shows and this one did not.
function findJvmCrash(dir, sinceMs) {
  const out = [];
  const look = (where) => {
    let names = [];
    try { names = fs.readdirSync(where); } catch { return; }
    for (const n of names) {
      if (!/^hs_err_pid\d+\.log$/i.test(n)) continue;
      try {
        const full = path.join(where, n);
        const st = fs.statSync(full);
        if (Date.now() - st.mtimeMs < sinceMs) out.push({ full, t: st.mtimeMs });
      } catch { /* gone already */ }
    }
  };
  look(dir);
  look(path.join(dir, "crash-reports"));
  out.sort((a, b) => b.t - a.t);
  return out[0] || null;
}

// The part of an hs_err log worth reading: everything down to the end of the
// register dump is mostly noise, but the header, the problematic frame and
// the Java frames above it are the answer.
function trimJvmCrash(text) {
  const lines = String(text).split(/\r?\n/);
  const stop = lines.findIndex(l => /^---------------  P R O C E S S  ---------------/.test(l));
  const head = lines.slice(0, stop > 0 ? stop : Math.min(lines.length, 120));
  return head.join("\n").slice(0, 60000);
}

function reportInstanceCrash(profileId, cfg, code) {
  // 0 is a clean quit; 143/130 are SIGTERM/SIGINT, i.e. the user stopping it.
  if (code === 0 || code === null || code === undefined) return;
  if (code === 143 || code === 130) return;
  try {
    const dir = path.join(dataDir, "client", String(profileId));
    // broadcastLog keys by whatever it was handed, which isn't always a string.
    const lines = instanceLogs.get(profileId) || instanceLogs.get(String(profileId)) || [];
    const tail = lines.slice(-400);

    // The newest crash report, if one was written for this session.
    let report = null, reportPath = null, reportKind = null;
    try {
      const crashDir = path.join(dir, "crash-reports");
      if (fs.existsSync(crashDir)) {
        const newest = fs.readdirSync(crashDir)
          .filter(f => f.endsWith(".txt"))
          .map(f => ({ f, t: fs.statSync(path.join(crashDir, f)).mtimeMs }))
          .sort((a, b) => b.t - a.t)[0];
        // Only this session's — an old report would be misleading.
        if (newest && Date.now() - newest.t < 10 * 60 * 1000) {
          reportPath = path.join(crashDir, newest.f);
          report = fs.readFileSync(reportPath, "utf8").slice(0, 60000);
          reportKind = "file";
        }
      }
    } catch { /* no report is fine */ }

    // No Minecraft report. A JVM that died on a bad memory access never got
    // the chance to write one -- but it wrote its OWN, which names the
    // library that fell over.
    if (!report) {
      const jvm = findJvmCrash(dir, 10 * 60 * 1000);
      if (jvm) {
        try {
          report = trimJvmCrash(fs.readFileSync(jvm.full, "utf8"));
          reportKind = "jvm";
          reportPath = jvm.full;
        } catch { /* unreadable; fall through to the log */ }
      }
    }

    // Still nothing — most loader crashes never get that far. Dig the failure
    // out of the log rather than handing the whole tail over.
    if (!report) {
      const found = extractCrashFromLog(lines);
      if (found) { report = found.text.slice(-60000); reportKind = found.kind; }
    }

    const payload = {
      profileId: String(profileId),
      name: (cfg && cfg.name) || String(profileId),
      code,
      meaning: EXIT_MEANING.get(Number(code)) || null,
      tail,
      report,
      reportKind,
      reportPath,
      at: Date.now(),
    };
    for (const w of BrowserWindow.getAllWindows()) {
      try { if (!w.isDestroyed()) w.webContents.send("instance-crashed", payload); } catch { /* gone */ }
    }
  } catch (err) {
    devtoolsLog("failed to report crash:", err);
  }
}

function onInstanceExited(profileId) {
  // Clear any LAN-share state and close the relay tunnel for this instance.
  lanPorts.delete(String(profileId));
  const relayKey = `instance-${profileId}`;
  const s = activeRelays.get(relayKey);
  if (s) { try { s.close(); } catch { /* ignore */ } activeRelays.delete(relayKey); }
  if (mainWindow && mainWindow.webContents && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('instance-lan-closed', { profileId: String(profileId) });
  }
  updateGamePresence();
  // Harvest whatever this session changed while it is fresh. servers.dat is
  // saved by renaming a temp file over it, in every version from 1.6 to today,
  // so the instance's copy is ALWAYS detached from the shared one by the time
  // the game exits — syncing only before the next launch would leave the other
  // instances stale until then. (options.txt is written in place, so it
  // propagates through the link on its own and this is just a no-op for it.)
  applyConfigSync().catch(() => { /* non-fatal */ });
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
        // Keep the logs so the Logs tab still shows the finished session.
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

// Baseline settings. On a brand-new install the store is empty, and handing the
// renderer an empty object made applyTheme() blow up on undefined colours (which
// aborted sidebar.js, so pages half-loaded and theme changes looked unsaved).
// These are seeded once and always merged into what the renderer receives.
const DEFAULT_SETTINGS = {
  ramInstancesMin: 2048,
  ramInstancesMax: 4096,
  ramServersMin: 2048,
  ramServersMax: 4096,
  baseColor: "#b30c0c",
  secondaryColor: "#ff4d4d",
  thirdColor: "#d92d2d",
  textColor: "#ffffff",
  font: "Pixel",
  borderRadius: 0,
  autoUpdates: true,
  discordPresence: true,
  autoThird: true,
  gridView: false,
  gradientEnabled: false,
  gradientColors: ["#ff4d4d", "#b30c0c"],
  gradientAngle: 180,
  // What is behind the launcher. `theme` is the shaded panel the app has
  // always had; the rest are the four the Background section offers. The
  // gradient keys above are kept so a save made before this still works, and
  // are migrated into here on first read.
  background: {
    mode: "theme",
    color: "#121212",
    gradient: { colors: ["#ff4d4d", "#b30c0c"], angle: 180 },
    image: { file: null, fit: "cover" },
    block: { id: null, name: null, url: null, size: 64 },
  },
  predefinedThemeSync: false,
  syncOptions: false,
  syncServers: false,
};
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
  if (!settings.has(k)) settings.set(k, v);
}
// A save from before the Background section had a gradient toggle and nothing
// else. Carry it across once, so turning the gradient on long ago still shows
// a gradient rather than quietly reverting to the plain panel.
(() => {
  const bg = settings.get("background");
  if (bg && bg.migrated) return;
  const next = { ...DEFAULT_SETTINGS.background, ...(bg || {}), migrated: true };
  if (settings.get("gradientEnabled")) {
    next.mode = "gradient";
    next.gradient = {
      colors: settings.get("gradientColors") || DEFAULT_SETTINGS.background.gradient.colors,
      angle: settings.get("gradientAngle") ?? 180,
    };
  }
  settings.set("background", next);
})();
const sortStore = new Store({ name: "instance-sorting" });
if (!sortStore.has("sortMode")) sortStore.set("sortMode", "created-desc");
if (!sortStore.has("customOrder")) sortStore.set("customOrder", []);

const dataDir = path.join(app.getPath('userData'));
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

// The order the accounts are listed in, as dragged. By ID rather than by
// index: the list on screen can be a render behind what is on disk, and an
// account the drag never knew about must not be dropped because of it.
ipcMain.handle("players:reorder", (event, { order }) => {
  try {
    const players = loadPlayers();
    const want = (order || []).map(String);
    const byId = new Map(players.map(p => [String(p.id), p]));
    const out = [];
    for (const id of want) { const p = byId.get(id); if (p) { out.push(p); byId.delete(id); } }
    for (const p of players) if (byId.has(String(p.id))) out.push(p);   // anything not named, kept
    savePlayers(out);
    for (const w of BrowserWindow.getAllWindows()) {
      try { if (!w.isDestroyed()) w.webContents.send("players-updated", out); } catch { /* gone */ }
    }
    return { success: true };
  } catch (err) { return { success: false, error: err.message }; }
});
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
  // Developer tools are gated behind the "Developer mode" setting: block the
  // F12 / Ctrl+Shift+I shortcuts unless it's on (and toggle them when it is).
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const key = String(input.key || "");
    const combo = input.control && input.shift && key.toLowerCase() === "i";
    if (combo || key === "F12") {
      event.preventDefault();
      if (settings.get("devMode", false)) win.webContents.toggleDevTools();
    }
  });
  // Belt-and-suspenders: if devtools get opened some other way while dev mode is
  // off, close them again.
  win.webContents.on("devtools-opened", () => {
    if (!settings.get("devMode", false)) { try { win.webContents.closeDevTools(); } catch { /* ignore */ } }
  });
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

// ── Deep-link protocol (desktop shortcuts) ──
const DEEPLINK_SCHEME = 'redstonelauncher';
try {
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(DEEPLINK_SCHEME, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(DEEPLINK_SCHEME);
  }
} catch { /* ignore */ }
let pendingDeepLink = null;
function findDeepLink(argv) { return (argv || []).find(a => typeof a === 'string' && a.startsWith(DEEPLINK_SCHEME + '://')) || null; }

// Perform a shortcut's action: navigate the window to the right page with query
// params; the page's own code starts the server / launches the instance.
function dispatchDeepLink(url) {
  if (!url) return;
  try {
    const u = new URL(url); // redstonelauncher://server?name=… | ://instance?id=…&mode=…
    const kind = u.hostname;
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    const load = () => {
      if (kind === 'server') {
        mainWindow.loadFile('frontend/server.html', { search: `?srv=${encodeURIComponent(u.searchParams.get('name') || '')}&action=start` });
      } else if (kind === 'instance') {
        const p = new URLSearchParams(u.search);
        p.set('i', u.searchParams.get('id') || '');
        p.set('shortcut', '1');
        mainWindow.loadFile('frontend/instances.html', { search: '?' + p.toString() });
      }
    };
    if (mainWindow.webContents.isLoading()) mainWindow.webContents.once('did-finish-load', load); else load();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  } catch (e) { console.error('[DeepLink] bad url', url, e.message); }
}

// Compare two Minecraft versions ("1.20.1" >= "1.20").
function mcVersionAtLeast(version, target) {
  const parse = (v) => (String(v).match(/^\d+(\.\d+)*/)?.[0] || "").split(".").filter(s => s !== "").map(Number);
  const a = parse(version), b = parse(target);
  if (!a.length) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return true;
}

// ── Shortcut launch progress ──
// A shortcut launch opens no launcher window, so downloading assets and starting
// the JVM used to be minutes of nothing happening at all. This small frameless
// card sits on screen for that time and follows the same launch-progress events
// the instances page uses.
let launchSplash = null;
function openLaunchSplash(info) {
  try {
    launchSplash = new BrowserWindow({
      width: 400, height: 150,
      frame: false, transparent: true, resizable: false, maximizable: false,
      minimizable: false, alwaysOnTop: true, skipTaskbar: false, show: false,
      icon: path.join(iconPath),
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    launchSplash.loadFile("frontend/launch-splash.html");
    launchSplash.once("ready-to-show", () => {
      if (!launchSplash || launchSplash.isDestroyed()) return;
      launchSplash.show();
      launchSplash.webContents.send("splash-init", { ...info, theme: { ...DEFAULT_SETTINGS, ...settings.store } });
    });
    launchSplash.on("closed", () => { launchSplash = null; });
  } catch (e) {
    devtoolsLog("launch splash failed: " + e.message);
    launchSplash = null;
  }
}
function closeLaunchSplash(delay = 0) {
  const w = launchSplash;
  launchSplash = null;
  if (!w || w.isDestroyed()) return;
  setTimeout(() => { try { if (!w.isDestroyed()) w.close(); } catch { /* ignore */ } }, delay);
}

// Launch a Minecraft client from an instance deep link WITHOUT opening the
// launcher window — used when a desktop shortcut is clicked while the app is
// not already running. Resolves once the game process has spawned (or failed).
async function launchInstanceFromDeepLink(url) {
  try {
    const u = new URL(url);
    const p = u.searchParams;
    const profiles = await loadProfiles();
    const profile = profiles.find(pr => String(pr.id) === String(p.get("id")));
    if (!profile) return { error: "Profile not found" };
    // Use the shortcut's chosen account if it still exists, else the selected one.
    const players = loadPlayers();
    let playerId = p.get("account");
    if (!playerId || !players.find(pl => String(pl.id) === String(playerId))) {
      playerId = storage.get("selectedPlayerId", null);
    }
    if (!playerId) return { error: "No account selected" };
    // Something on screen from here on — everything after this point can take
    // minutes (downloading the version, assets, the loader, then the JVM start).
    openLaunchSplash({
      name: profile.name || "Minecraft",
      version: [profile.loader && profile.loader !== "vanilla" ? profile.loader : "", profile.version].filter(Boolean).join(" "),
      icon: profile.icon || null,
    });
    const args = { profileId: profile.id, playerId };
    const mode = p.get("mode") || "start";
    if (mode === "world" && p.get("world")) {
      args.quickPlay = { type: "singleplayer", identifier: p.get("world") };
    } else if (mode === "server" && p.get("server")) {
      const t = mcVersionAtLeast(profile.version, "1.20") ? "multiplayer" : "legacy";
      args.quickPlay = { type: t, identifier: p.get("server") };
    }
    // Extra launch args are independent of the action (advanced option).
    if (p.get("args")) args.shortcutArgs = p.get("args");
    return await launchProfileCore(args);
  } catch (e) { return { error: e.message }; }
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
  process.exit(0);
} else {
  app.on('second-instance', (event, argv) => {
    const link = findDeepLink(argv);
    if (link) { dispatchDeepLink(link); return; }
    // If the window was closed while games kept running, relaunching brings it
    // back instead of starting a second copy.
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else if (!adminMode) {
      createWindow();
    }
  });
  // macOS delivers deep links via open-url.
  app.on('open-url', (event, url) => { event.preventDefault(); if (mainWindow) dispatchDeepLink(url); else pendingDeepLink = url; });

  app.whenReady().then(async () => {
    if (adminMode) {
      createAdminWindow();
      return;
    }

    // Apply any update staged on a previous run BEFORE opening the window, so
    // updates never interrupt an active session.
    const applied = await maybeApplyStagedUpdate();
    if (applied) return; // installer launched; app is quitting

    // Deep link the app was launched with (Windows/Linux argv, or macOS open-url).
    const initialLink = pendingDeepLink || findDeepLink(process.argv);
    pendingDeepLink = null;

    // Cold-start via an INSTANCE shortcut: just launch the client (and auto-join
    // the world/server) without ever opening the launcher window, then quit once
    // the game has spawned. Only opening the window when the app was already
    // running is handled by the second-instance / open-url paths.
    let headless = false;
    if (initialLink) {
      try { headless = new URL(initialLink).hostname === "instance"; } catch { /* ignore */ }
    }
    if (headless) {
      const r = await launchInstanceFromDeepLink(initialLink);
      if (r && r.error) {
        // Leave the failure on screen long enough to read — with no launcher
        // window there is nowhere else for it to go.
        if (launchSplash && !launchSplash.isDestroyed()) launchSplash.webContents.send("splash-error", r.error);
        closeLaunchSplash(6000);
        setTimeout(() => { if (!mainWindow || mainWindow.isDestroyed()) app.quit(); }, 6500);
        return;
      }
      // Give the detached JVM a moment to fully spawn, then exit the launcher.
      closeLaunchSplash(r && r.pid ? 3500 : 500);
      setTimeout(() => { if (!mainWindow || mainWindow.isDestroyed()) app.quit(); }, r && r.pid ? 4000 : 500);
      return;
    }

    if (!mainWindow) createWindow();

    // Resume watching any configured dev-mod build folders.
    try { startAllDevWatchers(); } catch (e) { devtoolsLog("dev-mod watchers:", e.message); }

    if (initialLink) dispatchDeepLink(initialLink);

    // Re-detect games still running from a previous launcher session.
    restoreRunningInstances();

    // Keep "latest release/snapshot" instances on the newest version while the
    // launcher is open, instead of only when their page is opened.
    setTimeout(() => { autoUpdateTrackedInstances().catch(() => {}); }, 8000);
    setInterval(() => { autoUpdateTrackedInstances().catch(() => {}); }, 15 * 60 * 1000);

    // Keep auto-updating shortcut icons (e.g. server icons) fresh.
    refreshShortcutIcons().catch(() => {});

    // The nine default player skins, out of the client jar. They are needed by
    // every head an account without a skin has, and by the skins page's default
    // gallery, so build them once here rather than making the first page that
    // wants one wait for a client jar to download. Cached per Minecraft
    // release, so this is a no-op on every run but the first.
    buildDefaultSkins().catch(err => devtoolsLog("default skins:", err && err.message));

    // Throw away the per-size head files an older build left behind.
    pruneSizedHeads().catch(err => devtoolsLog("head cache:", err && err.message));

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
  const text = censorSecrets(args.map(arg => {
    if (arg instanceof Error) return arg.stack || arg.message;
    if (typeof arg === 'object') {
      try { return JSON.stringify(arg); } catch(e) { return String(arg); }
    }
    return String(arg);
  }).join(' '));

  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send("devtools-log", text);
  }
  // The same line to the terminal, censored the same way: an auth failure
  // dumps the whole response body, token and all.
  console.log(text);
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
  // Always hand back a COMPLETE settings object — a missing colour/font here
  // used to throw in the renderer's applyTheme() and break the whole page.
  return { ...DEFAULT_SETTINGS, ...settings.store };
});

ipcMain.handle('get-setting', (event, key) => {
  return settings.get(key, DEFAULT_SETTINGS[key]);
});

ipcMain.handle('set-setting', (event, key, value) => {
  settings.set(key, value);
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
// Refreshing an account is a three-request chain (Xbox Live, XSTS, then
// Mojang's login_with_xbox), and Mojang rate-limits the last one hard — HTTP
// 429 after not very many. Every caller used to throttle this differently, or
// not at all: authHeaders had a 10-minute gate shared across ALL accounts,
// getSkinsAndCapes had its own 30-minute per-player one, and authHeadersFor and
// accountCredsByIdFresh had none. Opening a few pages fired a chain each time
// and locked the account out. One throttle now lives here, where the work is,
// so every entry point gets it.
const REFRESH_MIN_GAP = 15 * 60 * 1000;
// A chain that failed shouldn't be retried straight away either, and a 429
// means back off properly.
const REFRESH_RETRY_GAP = 60 * 1000;
const REFRESH_RATELIMIT_GAP = 10 * 60 * 1000;
const _refreshAt = new Map();        // account id -> when a refresh last SUCCEEDED
const _refreshCooldown = new Map();  // account id -> don't even try before this
const _refreshInFlight = new Map();  // account id -> the chain currently running

const _refreshKey = (player) => String((player && (player.id ?? player.auth?.uuid)) ?? "default");

// An offline account is a username and nothing else: no Microsoft sign-in, no
// tokens, nothing to refresh. Putting one through the chain below found no
// refresh token, decided the grant was dead, and marked the account as needing
// a sign-in — so the players page sat there telling people their OFFLINE
// accounts had expired sign-ins and to sign in again, which they cannot do and
// would not help if they could.
const isOfflineAccount = (p) => !!p && (p.type === "cracked" || p.offline === true);

async function refreshPlayer(player, opts = {}) {
  if (isOfflineAccount(player)) {
    // Clear the flag if an earlier version of this set it.
    if (player.needsReauth) { delete player.needsReauth; persistPlayer(player); }
    return player;
  }
  const key = _refreshKey(player);
  // The persisted stamp matters too, or restarting the launcher would refresh
  // every account again immediately.
  const last = Math.max(_refreshAt.get(key) || 0, Number(player.lastRefresh) || 0);
  const hasToken = !!(player.auth && player.auth.access_token && player.auth.access_token !== "0");
  if (!opts.force && hasToken && Date.now() - last < REFRESH_MIN_GAP) return player;

  // A chain that just failed gets a cooldown of its own, tracked separately
  // from the last success: an account with no usable token yet would otherwise
  // sail past the check above and retry on every single call — which is exactly
  // how a 429 turns into a storm of further 429s.
  if (!opts.force && Date.now() < (_refreshCooldown.get(key) || 0)) {
    if (hasToken) return player;
    throw new Error("Sign-in is rate-limited right now — try again shortly");
  }

  // Two pages asking at the same moment must not start two chains.
  const pending = _refreshInFlight.get(key);
  if (pending) return pending;

  const run = (async () => {
    try {
      // No refresh token at all means there is nothing to refresh with — msmc
      // would read refresh_token off undefined and throw a TypeError that says
      // nothing useful. Fail with the real reason instead.
      if (!player.refresh) {
        const e = new Error("This account has no refresh token — please sign in again");
        e.needsReauth = true;
        throw e;
      }
      // QR / device-code accounts use the login.live.com (MBI_SSL, "t=") path,
      // which msmc can't refresh — handle them with the manual chain.
      if (player.authKind === "live") {
        const tok = await refreshLiveToken(player.refresh);
        player.auth = await completeLiveLogin(tok.access_token, player.auth?.client_token);
        player.refresh = tok.refresh_token || player.refresh;
      } else {
        const authManager = new Auth("login");
        const xboxManager = await authManager.refresh(player.refresh);
        const token = await xboxManager.getMinecraft();
        player.auth = token.mclc();
        if (token.parent && token.parent.msToken) player.refresh = token.parent.msToken;
      }
      player.lastRefresh = Date.now();
      _refreshAt.set(key, player.lastRefresh);
      _refreshCooldown.delete(key);
      // It worked, so whatever was wrong before isn't any more.
      if (player.needsReauth) { delete player.needsReauth; persistPlayer(player); }
      return player;
    } catch (err) {
      const msg = String(err && (err.message ?? err));
      const rateLimited = err?.response?.status === 429 || msg.includes("429");
      // Some failures are temporary (rate limits, no network). These are not:
      // the grant is gone and no amount of retrying brings it back, so say so
      // instead of quietly carrying on with a dead token and letting every
      // call fail with a 401 nobody can explain.
      const dead = err.needsReauth
        || /invalid_grant|must sign in again|grant is expired|reading 'refresh_token'/i.test(msg);
      if (dead) {
        err.needsReauth = true;
        player.needsReauth = true;
        persistPlayer(player);
        notifyReauthNeeded(player);
      }
      _refreshCooldown.set(key, Date.now() + (rateLimited ? REFRESH_RATELIMIT_GAP : REFRESH_RETRY_GAP));
      devtoolsLog("Failed to refresh player:", err);
      throw err;
    } finally {
      _refreshInFlight.delete(key);
    }
  })();
  _refreshInFlight.set(key, run);
  return run;
}

// Write a changed account back to disk without disturbing the others.
function persistPlayer(player) {
  try {
    const players = loadPlayers();
    const i = players.findIndex(p => String(p.id) === String(player.id));
    if (i === -1) return;
    players[i] = { ...players[i], ...player };
    savePlayers(players);
    for (const w of BrowserWindow.getAllWindows()) {
      try { if (!w.isDestroyed()) w.webContents.send("players-updated", players); } catch { /* gone */ }
    }
  } catch (err) { devtoolsLog("could not persist the account:", err && err.message); }
}

// Tell the user once, rather than letting everything quietly 401.
const _reauthTold = new Set();
function notifyReauthNeeded(player) {
  const key = String(player && player.id);
  if (_reauthTold.has(key)) return;
  _reauthTold.add(key);
  const name = (player && (player.username || (player.auth && player.auth.name))) || "An account";
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      if (!w.isDestroyed()) w.webContents.send("account-needs-signin", { id: player.id, name });
    } catch { /* gone */ }
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
// Seed terms for the skin browser when no search is typed. MineSkin has no
// popularity sort and its unfiltered feed is unnamed junk, so we seed with a
// popular term — rotated per request so the default view isn't always the same
// handful of skins.
const DEFAULT_BROWSE_TERMS = ["popular", "aesthetic", "boy", "girl", "anime", "knight", "ninja", "cute", "cool", "dark", "hoodie", "gamer"];
const pickBrowseTerm = () => DEFAULT_BROWSE_TERMS[Math.floor(Math.random() * DEFAULT_BROWSE_TERMS.length)];
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
// Promise-based variant for callers that need the list inline (e.g. the desktop
// shortcut account picker). Returns { id, username, name, type } per player.
ipcMain.handle('list-players', () => loadPlayers().map(p => ({
  id: p.id, username: p.username, name: p.auth?.name || p.username, type: p.type,
})));

/* ─────────────── Game Profiles ─────────────── */

// Create game profile
ipcMain.on('create-profile', async (event, profile) => {
  const profiles = await loadProfiles();

  const newProfile = {
    id: getUniqueFolderName(profile.name),
    name: profile.name,
    version: profile.version || "1.20.1",
    loader: profile.loader || "vanilla",
    loaderVersion: profile.loaderVersion || "",
    // No icon means no icon. The pages fall back to the one shipped with the
    // launcher (frontend/defaults.js); storing a URL here instead meant every
    // instance made this way carried a remote address around forever.
    icon: profile.icon || null,
    alwaysUpdate: !!profile.alwaysUpdate,
    autoUpdateVersion: !!profile.alwaysUpdate,
    launchArgs: profile.launchArgs || "",
    ramMin: profile.ramMin || null,
    ramMax: profile.ramMax || null,
    created: Date.now(),
    lastUsed: Date.now()
  };

  profiles.push(newProfile);
  saveProfiles(profiles);

  event.reply('profiles-updated', profiles);
  event.reply('profile-created', newProfile);
});

// What the new-instance flow calls an instance when nobody types a name:
// "Fabric 1.21.9". The labels have to match pickFinalize's.
const LOADER_LABEL = { vanilla: 'Vanilla', fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', quilt: 'Quilt' };
const loaderLabel = (p) => {
  const loader = String((p && p.loader) || 'vanilla').toLowerCase();
  return LOADER_LABEL[loader] || (p && p.loader) || 'Vanilla';
};

// Write `word` the way `sample` was written: "vaniLLA" -> "fabrIC". Position
// by position for as far as the sample goes, and after that however it ended,
// so a longer replacement carries on in the same vein.
function matchCase(sample, word) {
  const src = String(sample), out = [];
  let last = /[A-Z]/.test(src.slice(-1)) ;
  for (let i = 0; i < word.length; i++) {
    const c = word[i];
    if (i < src.length) {
      const s = src[i];
      if (/[a-z]/.test(s)) { out.push(c.toLowerCase()); last = false; continue; }
      if (/[A-Z]/.test(s)) { out.push(c.toUpperCase()); last = true; continue; }
    }
    out.push(last ? c.toUpperCase() : c.toLowerCase());
  }
  return out.join("");
}

const escapeRe = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Rename an instance to keep up with what it runs.
//
// An instance called "Fabric 1.21.9" is named after its loader and its
// version, and so is "my 1.21 instance" and "vaniLLA instance" -- the name
// just has other words around it. Whichever of the two changed is swapped out
// wherever it appears, in the case it was written in. A name with neither in
// it is left exactly as it is, because then it is not about either.
function renamedForChange(before, after) {
  let name = String(after.name || "");
  if (!name) return name;

  if (String(before.version || "") !== String(after.version || "") && before.version) {
    // Bounded, or the "1.21" of an instance on 1.21 would rewrite the middle
    // of "1.21.9" in its own name.
    const re = new RegExp(`(?<![\\w.])${escapeRe(before.version)}(?![\\w.])`, "g");
    name = name.replace(re, String(after.version || ""));
  }

  const wasLoader = loaderLabel(before), nowLoader = loaderLabel(after);
  if (wasLoader.toLowerCase() !== nowLoader.toLowerCase()) {
    const re = new RegExp(`\\b${escapeRe(wasLoader)}\\b`, "gi");
    name = name.replace(re, (hit) => {
      // However it was written. Spelt the usual way, the replacement is spelt
      // the usual way too -- "Fabric" becomes "NeoForge", not "Neoforge" --
      // and all-lower or all-upper carry across whole. Anything else is
      // somebody's own capitalisation, so it is traced letter by letter:
      // "vaniLLA" becomes "fabrIC".
      if (hit === wasLoader) return nowLoader;
      if (hit === hit.toLowerCase()) return nowLoader.toLowerCase();
      if (hit === hit.toUpperCase()) return nowLoader.toUpperCase();
      return matchCase(hit, nowLoader);
    });
  }
  return name;
}

ipcMain.on('edit-profile', async (event, updatedProfile) => {
  try {
    // The raw file, read at the moment of writing. This used to take a
    // SORTED copy from loadProfiles(), hold it across an await, merge into
    // that copy and save the whole array back -- so when two edits were in
    // flight at once, whichever finished last put its stale snapshot back
    // over the other. The edit dialog does exactly that: it sends this and
    // then changes the version, and since this message carries no version
    // field its snapshot still held the OLD one. That is why changing an
    // instance's version put itself back instantly. Saving the sorted copy
    // also wrote whatever sort was on display over the user's own order.
    let raw;
    try { raw = JSON.parse(fs.readFileSync(profilesPath, "utf8")); } catch { raw = null; }
    if (!Array.isArray(raw)) { event.reply('edit-profile-error', 'Failed to load profiles'); return; }
    const index = raw.findIndex(p => String(p.id) === String(updatedProfile.id));
    if (index === -1) {
      devtoolsLog('edit-profile-error', `Profile with id ${updatedProfile.id} not found`);
      event.reply('edit-profile-error', `Profile with id ${updatedProfile.id} not found`);
      return;
    }
    const before = raw[index];
    const after = { ...before, ...updatedProfile };
    // An instance named after what it runs should keep saying what it
    // runs. Not only "Fabric 1.21.9": "my 1.21 instance" too. Skipped when
    // a name is being typed in this same edit -- that one is theirs.
    if (after.name === before.name) after.name = renamedForChange(before, after);
    raw[index] = after;

    saveProfiles(raw);
    event.reply('profiles-updated', await loadProfiles());
  } catch (err) {
    devtoolsLog('Failed to load profiles for edit:', err);
    event.reply('edit-profile-error', 'Failed to load profiles');
  }
});

// Drop every trace of an instance that lives outside its own folder. Called on
// delete so a later instance that lands on the same derived id starts clean.
function forgetInstanceState(id) {
  const key = String(id);
  for (const k of [id, key]) {
    try { instanceLogs.delete(k); } catch { /* not there */ }
    try { lanPorts.delete(k); } catch { /* not there */ }
    try { runningInstances.delete(k); } catch { /* not there */ }
  }
  // The mod index and hash caches, which live outside the instance folder.
  try {
    const meta = metaDir("client", key);
    if (fs.existsSync(meta)) fs.rmSync(meta, { recursive: true, force: true });
  } catch (err) {
    devtoolsLog("Failed to clear instance metadata:", err);
  }
}

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

  // Everything else keyed by this id. Instance ids are derived from the
  // instance NAME, so deleting an instance and then adding another with the
  // same name reuses the id — and anything left behind under it surfaces on
  // the new instance. That is why a fresh import was showing the deleted
  // instance's logs: instanceLogs is deliberately kept after a game exits so
  // the Logs tab still works, and nothing was clearing it on delete.
  forgetInstanceState(id);

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
    // Legacy (pre-1.20) server join is done with plain --server/--port game
    // args (see launchProfileCore) rather than the library's quickPlay path.
    const legacyServer = quickplaybool ? quickplayip : null;

    const rootDir = path.join(dataDir, 'client', String(profile.id));
    fs.mkdirSync(rootDir, { recursive: true });

    const launcher = new Client();
    attachLauncherEvents(launcher, profileId);
    // Our own resolution, not tomate-loaders': it drops the loaderVersion a
    // modpack pins, and picks the oldest rather than the newest Forge/NeoForge
    // build. See loader-versions.js.
    const launcherConfig = await withRetry(() => getLaunchConfig({
      loader: profile.loader,
      gameVersion: profile.version,
      rootPath: rootDir,
      loaderVersion: profile.loaderVersion || "",
    }, (line) => broadcastLog(profileId, line)), { label: "Preparing launch", profileId });
    let opts = {
      ...launcherConfig,
      authorization: auth,
      memory: { max: "4G", min: "1G" },
      overrides: {
        // Detached so the game keeps running if the launcher is closed.
        detached: true
      },
      quickPlay: null
    }
    if (legacyServer) {
      const str = String(legacyServer).trim();
      const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(str);
      const host = m ? m[1] : str;
      const port = m && m[2] ? m[2] : "25565";
      opts.customLaunchArgs = ["--server", host, "--port", port];
    }
    // Same as the normal launch path: swap the offline account's skin into the
    // instance's folder resource pack right before the game starts.
    if (player.type === "cracked") {
      const entry = loadCrackedSkins()[String(player.id)];
      if (entry && entry.base64) applyCrackedSkinToInstance(profileId, profile.version, entry.base64);
      else removeCrackedSkinFromInstance(profileId);
    }
    const childProcess = await withRetry(() => launcher.launch(opts), { tries: 2, label: "Launching", profileId });

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

// Both pack formats name the loader AND pin the build it needs; only the name
// was being read. Dropping the build left every imported pack on whatever the
// launcher defaults to -- the oldest release of that loader -- so a pack whose
// mods want neoforge 21.1.2xx launched on 21.1.1 and every one of them failed
// its dependency range.
//
// Modrinth puts it in `dependencies`: { "neoforge": "21.1.180", ... }
function loaderFromMrpackDeps(deps) {
  deps = deps || {};
  const order = [["fabric-loader", "fabric"], ["quilt-loader", "quilt"], ["forge", "forge"], ["neoforge", "neoforge"]];
  for (const [key, name] of order) {
    if (deps[key]) return { loader: name, loaderVersion: String(deps[key]) };
  }
  return { loader: "vanilla", loaderVersion: "" };
}

// CurseForge writes one id: "neoforge-21.1.180", "fabric-0.16.9", and older
// forge packs embed the game version too: "forge-1.20.1-47.2.0".
function loaderFromCurseId(id, mcVersion) {
  const raw = String(id || "").trim();
  const dash = raw.indexOf("-");
  if (dash <= 0) return { loader: raw || "vanilla", loaderVersion: "" };
  const loader = raw.slice(0, dash);
  let loaderVersion = raw.slice(dash + 1);
  if (mcVersion && loaderVersion.startsWith(mcVersion + "-")) loaderVersion = loaderVersion.slice(mcVersion.length + 1);
  return { loader, loaderVersion };
}

// The icon for a pack, as a data: URL — not bare base64, since it goes straight
// into an <img src>. Checks the handful of places a pack may carry one, then
// falls back to fetching the project icon from the browser listing.
const MIME_BY_EXT = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

// A modpack's icon on Modrinth, found by the name in its own index. Only an
// EXACT name match counts: "the pack called this" is a fair guess, "a pack
// whose description mentions this" is not, and putting a stranger's artwork on
// someone's instance is worse than leaving it plain.
async function modrinthPackIconByName(name) {
  const q = String(name || "").trim();
  if (q.length < 3) return null;
  try {
    const url = "https://api.modrinth.com/v2/search?limit=5"
      + "&facets=" + encodeURIComponent('[["project_type:modpack"]]')
      + "&query=" + encodeURIComponent(q);
    const res = await fetch(url, { headers: { "User-Agent": LAUNCHER_UA } });
    if (!res.ok) return null;
    const j = await res.json();
    const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
    const hit = (j.hits || []).find(h => norm(h.title) === norm(q));
    return (hit && hit.icon_url) || null;
  } catch {
    return null;
  }
}
async function packIcon(zip, iconUrl, packName) {
  const inZip = ["icon.png", "overrides/icon.png", "overrides/pack.png", "pack.png",
    "client-overrides/icon.png"];
  for (const name of inZip) {
    try {
      const e = zip.getEntry(name);
      if (e) return "data:image/png;base64," + e.getData().toString("base64");
    } catch { /* try the next one */ }
  }
  // Importing a .mrpack FILE gives no iconUrl — there is no browser listing to
  // take one from — and the format does not require an icon inside the zip, so
  // a pack imported from disk came out with the generic launcher icon however
  // well known the pack is. Look it up by name instead.
  if (!iconUrl && packName) iconUrl = await modrinthPackIconByName(packName);
  if (!iconUrl) return null;
  // Inlined rather than stored as a URL so the instance still has its icon
  // offline, and doesn't break if the project is later taken down.
  try {
    const res = await fetch(iconUrl);
    if (!res.ok) return String(iconUrl);
    const buf = Buffer.from(await res.arrayBuffer());
    // 256KB is plenty for a 96px icon; anything bigger stays a plain URL
    // rather than bloating profiles.json.
    if (buf.length > 256 * 1024) return String(iconUrl);
    const ext = (String(iconUrl).split("?")[0].split(".").pop() || "png").toLowerCase();
    const mime = res.headers.get("content-type") || MIME_BY_EXT[ext] || "image/png";
    if (!/^image\//.test(mime)) return String(iconUrl);
    return `data:${mime.split(";")[0]};base64,` + buf.toString("base64");
  } catch {
    // Couldn't fetch it — the URL still renders once there's a connection.
    return String(iconUrl);
  }
}

async function mrpackFromUrl(url) {
  const tmpFile = path.join(os.tmpdir(), `tmp-${Date.now()}.mrpack`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download mrpack: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(tmpFile, buffer);
  return mrpack(tmpFile); // call your existing mrpack() function
}

// hooks.onCreated(profile) fires as soon as the instance EXISTS -- before any
// mod is downloaded -- so a caller can open its page and watch the rest happen
// instead of staring at nothing for minutes. hooks.onExtract(done, total) covers
// unpacking the overrides; onProgress(done, total, path) covers the downloads.
async function mrpack(mrpackPath, onProgress, hooks) {
  hooks = hooks || {};
  const zip = new AdmZip(mrpackPath);

  const indexEntry = zip.getEntry("modrinth.index.json");
  if (!indexEntry) return { success: false, error: "modrinth.index.json not found in .mrpack" };
  const indexJson = JSON.parse(indexEntry.getData().toString("utf8"));

  // Determine loader and Minecraft version
  const deps = indexJson.dependencies || {};
  const { loader, loaderVersion } = loaderFromMrpackDeps(deps);
  const mcVersion = deps["minecraft"] || "1.20.1";

  // Unique instance id/folder derived from the pack name.
  const profileId = getUniqueFolderName(indexJson.name || "Imported Profile");

  // Create instance folder
  const profilesDir = path.join(dataDir, "client");
  if (!fs.existsSync(profilesDir)) fs.mkdirSync(profilesDir, { recursive: true });
  const profileFolder = path.join(profilesDir, `${profileId}`);
  fs.mkdirSync(profileFolder, { recursive: true });

  // Give the instance the pack's own icon from the moment it appears. Most
  // .mrpack files ship NO icon at all -- the format doesn't require one, and
  // Modrinth's exporter doesn't add one -- so looking only for a root icon.png
  // meant every pack installed from the browser came out with the default
  // icon. Try the places packs do put one, then fall back to the project icon
  // the caller was already showing in the browser.
  let icon = await packIcon(zip, hooks.iconUrl, indexJson.name);

  const newProfile = {
    id: profileId,
    name: indexJson.name || "Imported Profile",
    version: mcVersion,
    loader,
    loaderVersion,
    icon,
    // The pack's OWN icon, kept apart from `icon` so it is still there after
    // somebody has changed the instance's. The icon picker offers it under
    // "This version", the same as a mod's or a resource pack's -- an instance
    // made from a pack had no way back to the pack's own picture.
    modpackIcon: icon || null,
    modpackName: indexJson.name || null,
    modpack: true,
    installing: true,
    created: Date.now(),
    lastUsed: Date.now()
  };

  // Save it FIRST: the instance is now real (and marked as still installing), so
  // its page can be opened immediately.
  {
    const profiles = await loadProfiles();
    profiles.push(newProfile);
    saveProfiles(profiles);
  }
  if (typeof hooks.onCreated === "function") { try { hooks.onCreated(newProfile); } catch { /* caller's problem */ } }

  // Clear the installing flag (or record that it failed) on the STORED copy —
  // the array has been re-read and rewritten by other handlers in between.
  const finishProfile = async (patch) => {
    const profiles = await loadProfiles();
    const p = profiles.find(x => String(x.id) === String(profileId));
    if (!p) return;
    delete p.installing;
    Object.assign(p, patch || {});
    saveProfiles(profiles);
  };

  try {
    // Record every file the pack places (path -> sha1) so a later "update
    // modpack" can diff against it and tell user edits from pack changes.
    const packFiles = {};

    // Handle overrides inside the .mrpack (everything except modrinth.index.json)
    const entries = zip.getEntries().filter(e => !e.isDirectory);
    let exDone = 0;
    entries.forEach(entry => {
      exDone++;
      const relativePath = mrpackRelPath(entry.entryName);
      if (relativePath) {
        const data = entry.getData();
        const entryPath = path.join(profileFolder, relativePath);
        const entryDir = path.dirname(entryPath);
        if (!fs.existsSync(entryDir)) fs.mkdirSync(entryDir, { recursive: true });
        fs.writeFileSync(entryPath, data);
        packFiles[relativePath.split(path.sep).join("/")] = sha1OfBuffer(data);
      }
      if (typeof hooks.onExtract === "function") hooks.onExtract(exDone, entries.length);
    });

    // Download files listed in indexJson.files
    const dlList = indexJson.files || [];
    let dlDone = 0;
    if (typeof onProgress === "function") onProgress(0, dlList.length, "");
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

    writeModpackMeta(profileFolder, { name: newProfile.name, files: packFiles });
    await finishProfile();
    devtoolsLog(profileId)

    delete newProfile.installing;
    return { success: true, profile: newProfile };
  } catch (err) {
    // The instance is already in the list, so say so rather than leaving it
    // sitting there claiming to still be installing.
    await finishProfile({ installFailed: String(err && err.message || err) });
    return { success: false, error: String(err && err.message || err), profile: newProfile };
  }
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
    const { loader, loaderVersion } = loaderFromMrpackDeps(deps);
    const profiles = await loadProfiles();
    const idx = profiles.findIndex(p => String(p.id) === String(profileId));
    if (idx !== -1) {
      if (deps["minecraft"]) profiles[idx].version = deps["minecraft"];
      profiles[idx].loader = loader;
      if (loaderVersion) profiles[idx].loaderVersion = loaderVersion;
      profiles[idx].modpack = true;
      saveProfiles(profiles);
      event.reply?.("profiles-updated", profiles);
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// CurseForge's CDN path is derived from the file id: 5101365 lives at
// /files/5101/365/<fileName>. Worth knowing, because the API's download-url
// endpoint answers null whenever a mod author has opted out of third-party
// distribution — and the proxy turns that into a 500, which is what "got a 500
// and shows Unavailable" in the mod browser actually was. The CDN itself still
// serves the file; only the API's convenience endpoint refuses to name it.
function curseCdnUrl(fileID, fileName) {
  const id = String(fileID || "").replace(/\D/g, "");
  if (id.length < 5 || !fileName) return null;
  const head = id.slice(0, 4);
  // Leading zeros are stripped in the second segment ("0365" -> "365").
  const tail = String(Number(id.slice(4)));
  return `https://edge.forgecdn.net/files/${head}/${tail}/${encodeURIComponent(fileName)}`;
}

async function getDownloadUrl(projectID, fileID, fileName) {
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
    // Fall back to the derived CDN URL. Verify it before handing it back, so a
    // guess that doesn't exist is reported as missing rather than downloaded
    // as an HTML error page.
    const guess = curseCdnUrl(fileID, fileName);
    if (!guess) return null;
    try {
      const head = await fetch(guess, { method: "HEAD" });
      if (head.ok) {
        devtoolsLog(`Using the derived CDN URL for ${projectID}/${fileID}`);
        return guess;
      }
    } catch { /* no luck; fall through */ }
    return null;
  }
}

// One place for the renderer to ask, instead of three copies of the same fetch
// to the proxy with no fallback and no error to show the user.
ipcMain.handle("curseforge:downloadUrl", async (event, { projectID, fileID, fileName }) => {
  const url = await getDownloadUrl(projectID, fileID, fileName);
  if (url) return { success: true, url };
  return {
    success: false,
    // The overwhelmingly common cause, and one the user can act on.
    error: "CurseForge won't hand out a download link for this file — the author has usually disabled third-party downloads. Get it from the CurseForge website instead.",
  };
});

// Pick an image and hand back a data: URL. The wrap-an-image mode opens its file
// dialog straight after the page loads, and Chromium blocks a programmatic
// click() on an <input type="file"> without a user gesture -- which left the mode
// sitting there empty. A main-process dialog has no such requirement.
ipcMain.handle("pick-image", async (event, opts) => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: (opts && opts.title) || "Choose an image",
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }],
      properties: ["openFile"],
    });
    if (canceled || !filePaths.length) return { canceled: true };
    const p = filePaths[0];
    const buf = fs.readFileSync(p);
    if (buf.length > 32 * 1024 * 1024) return { error: "That image is too big." };
    const ext = path.extname(p).toLowerCase();
    const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
      : ext === ".webp" ? "image/webp" : ext === ".gif" ? "image/gif"
        : ext === ".bmp" ? "image/bmp" : "image/png";
    return { dataUrl: `data:${mime};base64,` + buf.toString("base64"), name: path.basename(p) };
  } catch (e) { return { error: e.message }; }
});

// A picture to put behind the launcher. Copied into the launcher's own folder
// rather than referred to where it sits: a background that vanishes because
// the file was moved, renamed or cleared out of Downloads is worse than no
// background at all. The copy keeps one name, so choosing another picture
// replaces it instead of filling the folder up.
ipcMain.handle("bg:pickImage", async () => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: "Choose a background picture",
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"] }],
      properties: ["openFile"],
    });
    if (canceled || !filePaths.length) return { canceled: true };
    const src = filePaths[0];
    const st = fs.statSync(src);
    if (st.size > 64 * 1024 * 1024) return { error: "That picture is too big (over 64 MB)." };
    const ext = (path.extname(src) || ".png").toLowerCase();
    const dir = path.join(dataDir, "background");
    fs.mkdirSync(dir, { recursive: true });
    // Any older copy goes, whatever it was called.
    for (const f of fs.readdirSync(dir)) {
      if (/^wallpaper\./i.test(f)) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* fine */ } }
    }
    const dest = path.join(dir, "wallpaper" + ext);
    fs.copyFileSync(src, dest);
    return { file: dest, url: pathToFileURL(dest).href, name: path.basename(src) };
  } catch (e) { return { error: e.message }; }
});

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

async function curseforgeImport(zipPath, onProgress, hooks) {
  hooks = hooks || {};
  const zip = new AdmZip(zipPath);

  const manifestEntry = zip.getEntry("manifest.json");
  if (!manifestEntry)
    return { success: false, error: "manifest.json not found in zip" };
  const manifest = JSON.parse(manifestEntry.getData().toString("utf8"));

  // Loader & Minecraft version
  const mcVersion = manifest.minecraft.version;
  const primaryLoader = (manifest.minecraft.modLoaders || []).find(l => l.primary)
    || (manifest.minecraft.modLoaders || [])[0];
  const { loader, loaderVersion } = loaderFromCurseId(primaryLoader && primaryLoader.id, mcVersion);

  // Create profile folder
  const profileId = getUniqueFolderName(manifest.name);
  const profilesDir = path.join(dataDir, "client");
  if (!fs.existsSync(profilesDir)) fs.mkdirSync(profilesDir, { recursive: true });
  const profileFolder = path.join(profilesDir, `${profileId}`);
  fs.mkdirSync(profileFolder);

  // CurseForge packs rarely carry an icon, so the same fallback chain as a
  // .mrpack applies: whatever is in the archive, else the project icon the
  // caller was showing, else the pack looked up by its own name.
  const icon = await packIcon(zip, hooks.iconUrl, manifest.name);

  const newProfile = {
    id: profileId,
    name: manifest.name || "Imported CurseForge Pack",
    version: mcVersion,
    loader,
    loaderVersion,
    icon,
    // See the .mrpack installer: the pack's own icon, kept so the picker can
    // offer it after the instance's has been changed.
    modpackIcon: icon || null,
    modpackName: manifest.name || null,
    modpack: true,
    // Which kind of pack it came from. The "update modpack" flow reads a
    // .mrpack and diffs it against the file list one leaves behind, neither
    // of which a CurseForge pack has, so it is not offered for these.
    packSource: "curseforge",
    installing: true,
    created: Date.now(),
    lastUsed: Date.now(),
  };

  // Saved FIRST, the same as a .mrpack: downloading a pack's mods takes
  // minutes, and the instance being real from the start is what lets its page
  // open straight away and show the progress.
  {
    const profiles = await loadProfiles();
    profiles.push(newProfile);
    saveProfiles(profiles);
  }
  if (typeof hooks.onCreated === "function") { try { hooks.onCreated(newProfile); } catch { /* caller's problem */ } }

  const finishProfile = async (patch) => {
    const profiles = await loadProfiles();
    const p = profiles.find(x => String(x.id) === String(profileId));
    if (!p) return;
    delete p.installing;
    Object.assign(p, patch || {});
    saveProfiles(profiles);
  };

  try {
    // Extract overrides/
    const overrides = zip.getEntries().filter(e => !e.isDirectory && e.entryName.startsWith("overrides/"));
    let exDone = 0;
    overrides.forEach(entry => {
      const relativePath = entry.entryName.replace(/^overrides\//, "");
      exDone++;
      if (!relativePath) return;
      const outPath = path.join(profileFolder, relativePath);
      const outDir = path.dirname(outPath);
      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(outPath, entry.getData());
      if (typeof hooks.onExtract === "function") hooks.onExtract(exDone, overrides.length);
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

        // Step 3: Get download URL. The pack manifest only names ids, so dig the
        // file name out of the mod info for the CDN fallback to have something
        // to build a path from.
        const known = (modInfo.latestFiles || []).find(f => String(f.id) === String(fileObj.fileID));
        const url = await getDownloadUrl(fileObj.projectID, fileObj.fileID, known && known.fileName);
        if (!url) throw new Error("CurseForge would not hand out a download link for this file");
        const fileName = path.basename(url.split("?")[0]);
        const dest = path.join(targetFolder, fileName);

        // Step 4: Download
        await downloadFile(url, dest);
        devtoolsLog(`[ok] Installed ${fileName} to ${subFolder}`);
      } catch (err) {
        devtoolsLog(`[fail] Failed to fetch mod ${fileObj.projectID}/${fileObj.fileID}:`, err);
      }
      cfDone++;
      if (typeof onProgress === "function") onProgress(cfDone, cfList.length, `mod ${cfDone}/${cfList.length}`);
    }

    await finishProfile();
    delete newProfile.installing;
    return { success: true, profile: newProfile };
  } catch (err) {
    // The instance is already in the list, so say so rather than leaving it
    // sitting there claiming to still be installing.
    await finishProfile({ installFailed: String(err && err.message || err) });
    return { success: false, error: String(err && err.message || err), profile: newProfile };
  }
}

// Which Java a Minecraft version asks for.
async function javaMajorForMinecraft(mcVersion) {
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
  return javaVersion;
}

async function getJavaForMinecraft(mcVersion) {
  return getJavaByMajor(await javaMajorForMinecraft(mcVersion), { label: `Minecraft ${mcVersion}` });
}

// Where a bundled Java was unpacked, given the binary inside it.
const javaHomeOf = (bin) => path.dirname(path.dirname(bin));
const hasJavac = (home) => fs.existsSync(path.join(home, "bin", process.platform === "win32" ? "javac.exe" : "javac"));

// A Java of a particular major version: the user's own, the system's, one
// already downloaded, or a fresh download from Adoptium.
//
// `needJdk` is for compiling rather than running -- a Gradle build needs
// javac, and the download below prefers a JRE, which has none. A JDK is kept
// under its own folder so it can sit beside an already-downloaded JRE of the
// same version instead of one overwriting the other.
async function getJavaByMajor(javaVersion, { needJdk = false, label = "" } = {}) {
  const want = needJdk ? "jdk" : "jre";
  const forWhat = label ? ` for ${label}` : "";

  // 5️⃣ Check custom Java path from settings
  const customJava = settings.get('customJavaPath');
  if (customJava && fs.existsSync(customJava)) {
    if (checkJavaVersion(customJava, javaVersion) && (!needJdk || hasJavac(javaHomeOf(customJava)))) {
      return customJava;
    } else {
      devtoolsLog(`[Java] Custom Java path ${customJava} is not compatible with version ${javaVersion}`);
    }
  }

  // 6️⃣ Check system Java
  const systemJava = findSystemJava(javaVersion);
  if (systemJava && (!needJdk || hasJavac(javaHomeOf(systemJava)))) {
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

  // 8️⃣ Check if we already have extracted Java in our runtimes folder.
  // A build wants a console-less launch for the game but a real `java` for
  // Gradle, which writes to stdout.
  const installPath = path.join(JAVA_DIR, `${javaVersion}_${osName}_${arch}${needJdk ? "_jdk" : ""}`);
  const exe = platform === "win32" ? (needJdk ? "bin/java.exe" : "bin/javaw.exe") : "bin/java";
  const javaBin = path.join(installPath, exe);
  if (fs.existsSync(javaBin) && (!needJdk || hasJavac(installPath))) {
    devtoolsLog(`[Java] Found existing bundled Java ${javaVersion} at ${javaBin}`);
    return javaBin;
  }

  // 9️⃣ If no Java found and auto-download is disabled, stop
  if (settings.get('autoDownloadJava', true) === false) {
    throw new Error(`No compatible Java ${javaVersion} found on your system, and auto-download is disabled in settings.`);
  }

  // 🔟 Fetch Adoptium API JSON. Try GA first, then early-access; and JRE first,
  // then JDK — so a brand-new major (e.g. Java 25 before a JRE/GA build exists)
  // still resolves instead of falling back to an incompatible system Java.
  const fetchAdoptium = (url) => new Promise((resolve) => {
    https.get(url, (res) => {
      let data = ""; res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
      res.on("error", () => resolve(null));
    }).on("error", () => resolve(null));
  });
  let downloadUrl = null;
  outer:
  for (const releaseType of ["ga", "ea"]) {
    // A JDK first when javac is wanted, since a JRE has none.
    for (const imageType of (needJdk ? ["jdk"] : ["jre", "jdk"])) {
      const url = `https://api.adoptium.net/v3/assets/latest/${javaVersion}/hotspot?architecture=${arch}&os=${osName}&image_type=${imageType}&release_type=${releaseType}`;
      const apiData = await fetchAdoptium(url);
      const link = Array.isArray(apiData) && apiData[0]?.binary?.package?.link;
      if (link) { downloadUrl = link; devtoolsLog(`[Java] Using Adoptium ${imageType}/${releaseType} for Java ${javaVersion}`); break outer; }
    }
  }
  if (!downloadUrl) {
    throw new Error(`Could not find a downloadable Java ${javaVersion} build (Adoptium had no ga/ea jre/jdk).`);
  }

  const tmpZip = path.join(os.tmpdir(), `java${javaVersion}${needJdk ? "jdk" : ""}.zip`);

  // 10️⃣ Download
  devtoolsLog(`Downloading Java ${javaVersion} (${want})${forWhat} from Adoptium...`);
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

// Is this error a transient network/server hiccup worth retrying? (e.g. a 502
// from a metadata CDN, a dropped connection, a timeout.)
function isTransientError(err) {
  const msg = String(err && err.message || err || "");
  if (/\b(429|500|502|503|504)\b/.test(msg)) return true;
  if (/status code (429|5\d\d)/i.test(msg)) return true;
  return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|socket hang up|network|timed? ?out|fetch failed/i.test(msg);
}
// Retry a flaky async op a few times with exponential backoff, but only for
// transient failures (real errors fail fast).
async function withRetry(fn, { tries = 3, base = 800, label = "op", profileId = null } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      if (attempt >= tries || !isTransientError(err)) throw err;
      const delay = base * Math.pow(2, attempt - 1);
      if (profileId) broadcastLog(profileId, `[WARN] ${label} failed (${err.message}); retrying in ${Math.round(delay / 1000)}s... (${attempt}/${tries - 1})`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// Launch profile
// `again` is "Run again": a deliberate second copy of an instance that is
// already up. Minecraft itself is happy to run twice over one game directory
// -- that is what a second launcher window does -- so the guard below is a
// guard against ACCIDENTS, not a rule, and asking for it explicitly skips it.
// The double-click guard is not skipped: that one is never deliberate.
async function launchProfileCore({ profileId, playerId, quickplaybool, quickplayip, quickPlay, shortcutArgs, again }) {
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
  if (isRunning && !again) {
    broadcastLog(profileId, "[WARN] This profile is already running. Please close it first.");
    return;
  }
  if (isRunning && again) broadcastLog(profileId, "[INFO] Starting another copy of this instance.");

  launchingProfiles.set(profileId, now);
  instanceLogs.delete(profileId); // fresh console for this launch (previous session was kept until now)
  // Pick up any dev-mod builds produced while the launcher wasn't watching.
  try { await syncDevMods("instance", profileId); } catch { /* non-fatal */ }
  // Pick up anything edited elsewhere, and relink this instance's servers.dat,
  // which its last session detached by renaming over it. Also runs when a game
  // exits, so the other instances don't stay stale until their next launch.
  try { await applyConfigSync(); } catch { /* non-fatal */ }
  // Let the game follow the links this instance has, which since 1.20 it
  // otherwise skips without saying why.
  try {
    const { targets } = writeAllowedSymlinks(profileId);
    if (targets.length) broadcastLog(profileId, `[INFO] Allowing ${targets.length} symlink target${targets.length === 1 ? "" : "s"}: ${targets.join(", ")}`);
  } catch { /* non-fatal */ }

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
    // legacy quickplaybool/quickplayip pair. For pre-1.20 ("legacy") we join
    // with plain --server/--port game args ourselves rather than going through
    // the library's quickPlay path — that keeps behaviour identical to a vanilla
    // launcher and avoids any quickPlay argument leaking onto old versions.
    let quickplay = null;
    let legacyServer = null;
    if (quickPlay && quickPlay.type && quickPlay.identifier) {
      if (quickPlay.type === 'legacy') legacyServer = quickPlay.identifier;
      else quickplay = quickPlay;
    } else if (quickplaybool) {
      legacyServer = quickplayip;
    }

    const rootDir = path.join(dataDir, 'client', String(profile.id));
    fs.mkdirSync(rootDir, { recursive: true });
    const javaPath = await getJavaForMinecraft(profile.version);
    devtoolsLog("Java ready at:", javaPath);

    // Per-instance custom JVM args (Instance Settings → Java & Launch), plus any
    // extra args baked into a desktop shortcut for this launch.
    const extraArgs = [(profileForRam.launchArgs || ""), (shortcutArgs || "")]
      .join(" ").trim();
    const customArgs = extraArgs ? extraArgs.split(/\s+/).filter(Boolean) : [];
    // Legacy (pre-1.20) server join: pass the classic game args directly.
    let customLaunchArgs = [];
    if (legacyServer) {
      const str = String(legacyServer).trim();
      const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(str);
      const host = m ? m[1] : str;
      const port = m && m[2] ? m[2] : "25565";
      customLaunchArgs = ["--server", host, "--port", port];
    }

    // Offline accounts can't upload a skin to Mojang, so their chosen skin is
    // applied as a resource pack overriding the vanilla player textures. This is
    // the ONLY place the pack is written: an instance gets whatever skin the
    // account has right now, swapped in just before the game starts. By this point
    // the instance's client jar is downloaded, so it can say which pack_format and
    // which texture layout this version wants.
    if (player.type === "cracked") {
      const entry = loadCrackedSkins()[String(player.id)];
      if (entry && entry.base64) {
        broadcastLog(profileId, "[skin] Applying the offline account skin...");
        const r = applyCrackedSkinToInstance(profileId, profile.version, entry.base64);
        if (!r.success) broadcastLog(profileId, "[WARN] Couldn't apply the offline skin: " + r.error);
      } else {
        removeCrackedSkinFromInstance(profileId);
      }
    }

    // Do the actual (heavy, CPU-bound) launch in a utility process so the app's
    // main event loop — and therefore the whole UI — stays responsive.
    const { pid } = await launchViaWorker(profileId, {
      loader: profile.loader, gameVersion: profile.version, loaderVersion: profile.loaderVersion || "",
      rootPath: rootDir, auth, memory: { max: maxRam, min: minRam }, javaPath,
      assetRoot: path.join(dataDir, 'assets'), quickPlay: quickplay,
      customArgs, customLaunchArgs, name: profile.name,
    });

    launchingProfiles.delete(profileId);
    return { pid };
  } catch (err) {
    launchingProfiles.delete(profileId);
    broadcastLog(profileId, "[ERROR] " + err.message);
    return { error: err.message };
  }
}

// Fork the launcher worker, relay its log/progress events, resolve when the game
// process has spawned, and track its exit. The game is detached so it survives
// the worker (and the launcher) closing.
// The launch worker for each profile currently starting up, so a launch can be
// called off. Preparing a launch downloads assets, libraries and the loader
// installer, which on a big modpack is minutes of work with no way out of it
// short of quitting the launcher.
const launchWorkers = new Map(); // profileId -> utilityProcess

function cancelLaunch(profileId) {
  const key = String(profileId);
  const worker = launchWorkers.get(key);
  if (!worker) return false;
  launchWorkers.delete(key);
  try { worker.kill(); } catch { /* already gone */ }
  // launchingProfiles is keyed by whatever the caller passed, so clear both.
  launchingProfiles.delete(key);
  launchingProfiles.delete(profileId);
  broadcastProgress(key, { done: true, label: "Cancelled" });
  broadcastLog(key, "[INFO] Launch cancelled");
  return true;
}

ipcMain.handle("cancel-launch", (event, { profileId }) => ({ success: cancelLaunch(profileId) }));

// Which instances are PREPARING a launch -- downloading assets, libraries, a
// loader installer. Asked for because the page that shows the Cancel button
// is rebuilt whenever you leave it and come back, and it had nowhere to read
// that from: it started at "Play" every time and only noticed once the game
// itself was running, which on a big modpack is minutes later.
// It also carries what each one is DOING, so the status bar can say
// "Checking assets 1200/4000" on a page that was opened mid-launch rather
// than waiting for the next frame to arrive.
ipcMain.handle("get-launching-instances", () =>
  [...launchWorkers.keys()].map(id => {
    const p = latestProgress.get(String(id)) || null;
    const meta = instanceMeta.get(id) || instanceMeta.get(String(id)) || null;
    return {
      id,
      name: (meta && meta.name) || null,
      label: (p && p.label) || "Getting ready",
      current: p ? p.current : null,
      total: p ? p.total : null,
      bytes: !!(p && p.bytes),
      fileName: (p && p.fileName) || null,
    };
  }));

// ── Symlinked resource packs the game refuses to load ───────────────────────
//
// Since 1.20 pre-release 7 Minecraft validates every symbolic link it meets
// under the game directory against an allow-list and silently skips what is
// not on it:
//
//     [Render thread/WARN]: Ignoring potential pack entry: Failed to validate
//     '...\resourcepacks\epicmc'. Found forbidden symlinks: ...
//
// The list is `allowed_symlinks.txt` in the game directory, one rule a line:
// `[prefix]<path>`, `[regex]<pattern>` or `[glob]<pattern>`, and a line with
// no tag means prefix. Two details decide whether this works at all: the
// rules are matched against where a link POINTS, not where it sits, and the
// target has to be the resolved path -- a target reached through another link
// does not match its unresolved spelling.
//
// A blanket `[regex].+` is what most of the advice online suggests and it is
// one line, but it gives the game leave to follow a link to anywhere on the
// disk, which is the entire thing the check was added to stop. One prefix per
// real target is the narrow version, and a prefix covers the folder's
// contents too, which a symlinked pack folder needs.
//
// Whatever the user put in the file themselves is kept: our rules live
// between two marker comments and only that block is rewritten. A file the
// game cannot parse disables every symlink, so a target that cannot be
// resolved -- or whose path contains a newline -- is left out rather than
// written in a form that would break the rest.
const SYMLINK_MARK_START = "# --- Redstone Launcher: targets of this instance's links ---";
const SYMLINK_MARK_END = "# --- end Redstone Launcher ---";
// A pack can be a linked folder, and a link can sit one level in (inside
// resourcepacks/, say), so each of these is looked at one level deep.
const SYMLINK_SCAN = ["resourcepacks", "shaderpacks", "mods", "saves", "config", "shaders"];

function instanceLinkTargets(root) {
  const found = new Set();
  const look = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      // Node reports a Windows junction as a symbolic link too, which is what
      // most tools make when they "link" a folder there.
      if (e.isSymbolicLink()) {
        try {
          const real = fs.realpathSync(full);
          if (real && path.isAbsolute(real) && !/[\r\n]/.test(real)) found.add(real);
        } catch { /* a broken link has no target worth allowing */ }
      } else if (e.isDirectory() && depth > 0) look(full, depth - 1);
    }
  };
  look(root, 0);                                   // links directly in the instance folder
  for (const sub of SYMLINK_SCAN) look(path.join(root, sub), 1);
  return [...found].sort();
}

function writeAllowedSymlinks(profileId) {
  const root = path.join(dataDir, "client", String(profileId));
  const file = path.join(root, "allowed_symlinks.txt");
  const targets = instanceLinkTargets(root);

  // Everything outside our block is the user's and is put back untouched.
  const kept = [];
  try {
    let inside = false;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (line.trim() === SYMLINK_MARK_START) { inside = true; continue; }
      if (line.trim() === SYMLINK_MARK_END) { inside = false; continue; }
      if (!inside) kept.push(line);
    }
    while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  } catch { /* no file yet */ }

  if (!targets.length) {
    // Nothing to allow. A file holding only our own block is removed so it
    // does not sit there claiming to allow things; one the user has written
    // in is left exactly as it is.
    try { if (!kept.length && fs.existsSync(file)) fs.unlinkSync(file); } catch { /* fine */ }
    if (kept.length) { try { fs.writeFileSync(file, kept.join("\n") + "\n"); } catch { /* fine */ } }
    return { targets };
  }

  const lines = [...kept, SYMLINK_MARK_START, ...targets.map(t => `[prefix]${t}`), SYMLINK_MARK_END];
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return { targets };
}

function launchViaWorker(profileId, cfg) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = utilityProcess.fork(path.join(app.getAppPath(), 'backend', 'launcher-worker.js'), [], { serviceName: 'mc-launch' });
    } catch (e) { reject(e); return; }
    launchWorkers.set(String(profileId), worker);
    let settled = false;
    // Two different things report downloads, and they used to be written to
    // the same bar: `progress` counts tasks finished out of a known total
    // (1200 assets of 4000), while `download-status` reports the bytes of one
    // single file. With four thousand assets in flight the bar was taking
    // 30%, then one .ogg's 34%, then 30% again -- jumping back and forth for
    // the whole download. So while a counted task is running the bar is the
    // counter and nothing else; the file being fetched only names itself in
    // the label. Per-file bytes drive the bar only when there is no counter
    // to beat them, which is exactly the one-big-file case (the client jar,
    // a loader installer) where they are what you want to watch.
    let counted = null;
    const sendCounted = (fileName) => broadcastProgress(profileId, {
      stage: counted.type, current: counted.current, total: counted.total,
      label: progressLabel(counted.type), fileName: fileName || null,
    });
    worker.on('message', (m) => {
      if (!m) return;
      switch (m.type) {
        case 'log':
        case 'gamelog':
          broadcastLog(profileId, m.line); break;
        case 'progress': {
          const p = m.p || {};
          const many = Number(p.total) > 1;
          // A counter that has run out is finished; let the next single-file
          // download speak for itself again.
          if (many && p.task < p.total) {
            // mclc restarts the count for each stage, and within a stage it
            // only ever goes up. Never let it go down.
            if (!counted || counted.type !== p.type || p.task >= counted.current) counted = { type: p.type, current: p.task, total: p.total };
            sendCounted();
          } else {
            counted = null;
            broadcastProgress(profileId, { stage: p.type, current: p.task, total: p.total, label: progressLabel(p.type) });
          }
          break;
        }
        case 'dl':
          if (counted) { sendCounted(m.s.name); break; }
          broadcastProgress(profileId, { stage: m.s.type, fileName: m.s.name, current: m.s.current, total: m.s.total, bytes: true, label: 'Downloading files' }); break;
        case 'spawned':
          settled = true;
          // Past the point of cancelling: the game itself is up now, and the
          // Stop button takes over from here.
          launchWorkers.delete(String(profileId));
          broadcastProgress(profileId, { done: true, label: 'Starting Minecraft' });
          instanceMeta.set(profileId, { name: cfg.name, version: cfg.gameVersion });
          startInstance(profileId, m.pid);
          updateGamePresence();
          broadcastLog(profileId, `[INFO] Launched Minecraft instance "${profileId}" (PID ${m.pid})`);
          resolve({ pid: m.pid });
          break;
        case 'exit':
          stopInstance(profileId, m.pid);
          onInstanceExited(profileId);
          broadcastProgress(profileId, { done: true });
          broadcastLog(profileId, `[INFO] Instance "${profileId}" exited with code ${m.code}`);
          reportInstanceCrash(profileId, cfg, m.code);
          try { worker.kill(); } catch { /* ignore */ }
          break;
        case 'error':
          if (!settled) { settled = true; reject(new Error(m.error)); }
          try { worker.kill(); } catch { /* ignore */ }
          break;
      }
    });
    worker.on('exit', () => {
      const wasCancelled = !launchWorkers.has(String(profileId));
      launchWorkers.delete(String(profileId));
      if (!settled) {
        settled = true;
        // cancelLaunch() removes the entry before killing the worker, so an
        // exit with no entry left is a cancellation rather than a failure.
        reject(new Error(wasCancelled ? 'Launch cancelled' : 'Launch worker stopped unexpectedly'));
      }
    });
    worker.postMessage({ type: 'launch', cfg });
  });
}
ipcMain.on('launch-profile', (event, args) => { launchProfileCore(args); });

//shi

ipcMain.handle("make-server", async (event, params) => {
  // Forge/NeoForge run an installer with Java, so resolve the right JDK first.
  let java = "java";
  try { if (params && params.version) java = await getJavaForMinecraft(params.version); } catch { /* fall back to system java */ }
  return await serverManager.makeServer(params, java);
});

// Create a desktop shortcut for a server or instance. icon is an optional
// data:/http(s) PNG URL (instance/server/world/custom).
async function iconUrlToPng(icon) {
  if (!icon) return null;
  try {
    if (icon.startsWith("data:")) return Buffer.from(icon.split(",")[1], "base64");
    if (/^https?:/.test(icon)) {
      const res = await fetch(icon);
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      return null;
    }
    // A path relative to the launcher's own frontend — which is what the
    // default icon is now. Without this a shortcut for an instance that never
    // got its own icon came out with no icon at all.
    if (!path.isAbsolute(icon)) {
      const f = path.join(app.getAppPath(), "frontend", icon);
      if (fs.existsSync(f)) return fs.readFileSync(f);
    }
  } catch { /* ignore */ }
  return null;
}
ipcMain.handle("create-shortcut", async (event, { kind, id, name, action, icon, iconSource }) => {
  try {
    const pngBuffer = await iconUrlToPng(icon);
    const r = shortcuts.createShortcut({ kind, id, name, action, pngBuffer });
    // Remember shortcuts whose icon tracks a live source (e.g. an instance
    // server's icon) so we can rewrite the icon file when the source changes.
    if (iconSource && r.iconPath) {
      const reg = loadShortcutRegistry();
      reg.push({ path: r.path, iconPath: r.iconPath, kind, iconSource });
      saveShortcutRegistry(reg);
    }
    return { success: true, path: r.path };
  } catch (err) { console.error("[Shortcut] failed:", err); return { success: false, error: err.message }; }
});

// ── Auto-updating shortcut icons ──
// Registry of shortcuts whose icon mirrors a live source. Persisted in userData.
function shortcutRegistryPath() { return path.join(app.getPath("userData"), "shortcut-registry.json"); }
function loadShortcutRegistry() {
  try { return JSON.parse(fs.readFileSync(shortcutRegistryPath(), "utf-8")) || []; } catch { return []; }
}
function saveShortcutRegistry(reg) {
  try { fs.writeFileSync(shortcutRegistryPath(), JSON.stringify(reg, null, 2)); } catch { /* ignore */ }
}
// Resolve the current PNG for a shortcut's icon source.
async function pngForIconSource(src) {
  try {
    if (src.type === "instance-server") {
      const list = await readServersList(src.profileId);
      const s = (list || []).find(x => (x.ip || "").trim() === String(src.ip).trim());
      if (s && s.icon) return Buffer.from(String(s.icon).replace(/^data:image\/\w+;base64,/, ""), "base64");
    }
  } catch { /* ignore */ }
  return null;
}
// Rewrite every registered shortcut icon from its current source. Drops entries
// whose shortcut file no longer exists. Best-effort, called on startup and after
// an instance server is edited.
async function refreshShortcutIcons() {
  const reg = loadShortcutRegistry();
  if (!reg.length) return;
  let changed = false;
  const kept = [];
  for (const entry of reg) {
    if (!entry.path || !fs.existsSync(entry.path)) { changed = true; continue; } // shortcut deleted
    kept.push(entry);
    const png = await pngForIconSource(entry.iconSource || {});
    if (png) shortcuts.rewriteIcon(entry.iconPath, png);
  }
  if (changed) saveShortcutRegistry(kept);
}

ipcMain.handle("edit-server", async (event, { name, ...changes }) => {
  try {
    let java = "java";
    try { if (changes.version) java = await getJavaForMinecraft(changes.version); } catch { /* system java */ }
    return await serverManager.editServer(name, changes, java);
  }
  catch (err) { return { success: false, error: err.message }; }
});

// Resolve the correct Java for a server's MC version (downloads if needed),
// falling back to system java. Fixes crashes like a 26.x/Fabric server needing
// Java 25 while the system only has 23.
async function resolveServerJava(id) {
  try {
    const info = serverManager.getServerInfo(id);
    if (info && info.version) return await getJavaForMinecraft(info.version);
  } catch (e) { console.warn("[Server] Java resolve failed, using system java:", e.message); }
  return "java";
}

ipcMain.handle("start-server", async (event, id) => {
  const java = await resolveServerJava(id);
  // Before launch, (re)merge + host this server's resource packs so
  // server.properties reflects the current pack list. Uses the relay tunnel if
  // the server is already shared, else the LAN IP. Best-effort.
  try { await ensureServerPack(id); } catch (e) { console.warn("[Server] pack setup failed:", e.message); }
  return serverManager.startServer(id, settings, java);
});

ipcMain.handle("stop-server", (event, id) => {
  return serverManager.stopServer(id);
});

ipcMain.handle("restart-server", async (event, id) => {
  const java = await resolveServerJava(id);
  return serverManager.restartServer(id, settings, java);
});

// EULA state (prompt on first launch instead of silently accepting).
ipcMain.handle("server-eula:get", (event, id) => {
  try {
    const p = path.join(dataDir, "servers", String(id), "eula.txt");
    if (!fs.existsSync(p)) return { accepted: false };
    return { accepted: /eula\s*=\s*true/i.test(fs.readFileSync(p, "utf8")) };
  } catch { return { accepted: false }; }
});
ipcMain.handle("server-eula:accept", (event, id) => {
  try {
    const dir = path.join(dataDir, "servers", String(id));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "eula.txt"), "eula=true\n");
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
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

// File-manager roots. Servers live under servers/<name>, instances under
// client/<id>. Both browsers share fileManager (zip/gz aware).
const serverRoot = (name) => path.join(dataDir, "servers", String(name));
const clientRoot = (id) => path.join(dataDir, "client", String(id));

ipcMain.handle("server-fs:list", (event, { name, path: rel }) => fileManager.listFiles(serverRoot(name), rel));
ipcMain.handle("server-fs:read", (event, { name, path: rel }) => fileManager.readFile(serverRoot(name), rel));
ipcMain.handle("server-fs:write", (event, { name, path: rel, text }) => fileManager.writeFile(serverRoot(name), rel, text));
ipcMain.handle("server-fs:delete", (event, { name, path: rel }) => fileManager.deleteFile(serverRoot(name), rel));

ipcMain.handle("server-fs:mkdir", (event, { name, path: rel, folder }) => fileManager.newFolder(serverRoot(name), rel, folder));
ipcMain.handle("server-fs:newfile", (event, { name, path: rel, file }) => fileManager.newFile(serverRoot(name), rel, file));
ipcMain.handle("server-fs:copy", (event, { name, path: rel }) => fileManager.copyEntry(serverRoot(name), rel));

// Instance (client) file manager — same backend, rooted at the instance folder.
ipcMain.handle("client-fs:list", (event, { id, path: rel }) => fileManager.listFiles(clientRoot(id), rel));
ipcMain.handle("client-fs:read", (event, { id, path: rel }) => fileManager.readFile(clientRoot(id), rel));
ipcMain.handle("client-fs:write", (event, { id, path: rel, text }) => fileManager.writeFile(clientRoot(id), rel, text));
ipcMain.handle("client-fs:delete", (event, { id, path: rel }) => fileManager.deleteFile(clientRoot(id), rel));
ipcMain.handle("client-fs:mkdir", (event, { id, path: rel, folder }) => fileManager.newFolder(clientRoot(id), rel, folder));
ipcMain.handle("client-fs:newfile", (event, { id, path: rel, file }) => fileManager.newFile(clientRoot(id), rel, file));
ipcMain.handle("client-fs:copy", (event, { id, path: rel }) => fileManager.copyEntry(clientRoot(id), rel));

// NBT (.dat) editing, shared by both browsers. Parse to editable JSON and write
// it back as proper NBT (handles gzip'd files like level.dat too).
async function readNbtAt(root, rel) {
  const p = fileManager.safePath(root, rel);
  if (!p || !fs.existsSync(p)) return { error: "Not found" };
  try {
    const buf = fs.readFileSync(p);
    const gzip = buf.length > 1 && buf[0] === 0x1f && buf[1] === 0x8b;
    const parsed = await nbt.parse(buf); // auto-detects compression + endianness
    return { json: JSON.stringify(parsed.parsed, null, 2), gzip, type: parsed.type };
  } catch (e) { return { error: e.message }; }
}
function writeNbtAt(root, rel, json, gzip, type) {
  const p = fileManager.safePath(root, rel);
  if (!p) return { error: "Invalid path" };
  try {
    const value = JSON.parse(json);
    let out = nbt.writeUncompressed(value, type || "big");
    if (gzip) out = zlib.gzipSync(out);
    fs.writeFileSync(p, out);
    return { success: true };
  } catch (e) { return { error: e.message }; }
}
ipcMain.handle("server-fs:read-nbt", (event, { name, path: rel }) => readNbtAt(serverRoot(name), rel));
ipcMain.handle("server-fs:write-nbt", (event, { name, path: rel, json, gzip, type }) => writeNbtAt(serverRoot(name), rel, json, gzip, type));
ipcMain.handle("client-fs:read-nbt", (event, { id, path: rel }) => readNbtAt(clientRoot(id), rel));
ipcMain.handle("client-fs:write-nbt", (event, { id, path: rel, json, gzip, type }) => writeNbtAt(clientRoot(id), rel, json, gzip, type));

// ── Remod: editing an installed mod jar or resource pack ───────────────────
//
// A mod's declared name, description, version, authors and icon live inside
// the archive, in whichever manifest its loader reads, so changing them means
// unpacking it, editing that manifest and packing it back up in exactly the
// same shape. The unpacked copy sits in a workspace under remod/ until Save,
// which is also what "Edit assets" browses: the file browser is pointed at
// the workspace through its own channel, so it needs no new code at all.
// Zip work for Remod, run in a utilityProcess. AdmZip is synchronous and a
// mod of any size took five to ten seconds to unpack, with every window in
// the launcher frozen for the whole of it.
function remodJob(job) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = utilityProcess.fork(
        path.join(app.getAppPath(), "backend", "remod-worker.js"),
        [], { serviceName: "remod-zip" });
    } catch (err) { reject(err); return; }
    let settled = false;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      try { worker.kill(); } catch { /* already gone */ }
      fn(v);
    };
    // A jar that will not open should not hold the dialog open forever.
    const timer = setTimeout(() => done(reject, new Error("that file took too long to open")), 2 * 60 * 1000);
    worker.on("message", (m) => {
      clearTimeout(timer);
      if (m && m.ok) done(resolve, m);
      else done(reject, new Error((m && m.error) || "the worker said nothing useful"));
    });
    worker.on("exit", (code) => {
      clearTimeout(timer);
      done(reject, new Error(`the remod worker exited (${code})`));
    });
    worker.postMessage(job);
  });
}

const remodRoot = () => path.join(dataDir, "remod");
const remodSessions = new Map();   // ticket -> { dir, archive, format, type, id, tab, filename }
const remodDir = (ticket) => {
  const s = remodSessions.get(String(ticket));
  return s ? path.join(s.dir, "files") : path.join(remodRoot(), "__none__");
};

// Where an installed mod / pack / shader lives, for either kind of target.
function contentPath(type, id, tab, filename) {
  const dir = type === "server"
    ? path.join(dataDir, "servers", String(id), tab || "mods")
    : path.join(dataDir, "client", String(id), tab || "mods");
  const full = path.join(dir, filename || "");
  // A crafted filename must not reach out of the folder.
  if (!filename || path.dirname(full) !== dir) return null;
  return full;
}

ipcMain.handle("remod:open", async (event, { type, id, tab, filename }) => {
  try {
    const archive = contentPath(type, id, tab, filename);
    if (!archive || !fs.existsSync(archive)) return { error: "That file is no longer there" };
    const ticket = crypto.randomUUID();
    const dir = path.join(remodRoot(), ticket);
    const files = path.join(dir, "files");
    const { dirs } = await remodJob({ type: "unpack", archive, dest: files });
    const found = remod.detectFormat(files);
    const info = remod.readFields(files, found);
    const icon = remod.readIcon(files, found);
    remodSessions.set(ticket, { dir, archive, format: found, type, id, tab, filename, dirs });
    return {
      ticket, filename,
      // Not every archive declares anything: a shader pack is a zip of glsl
      // and there is no manifest to edit. Renaming it and editing its files
      // still works, so it opens anyway, just without the fields.
      kind: (found && found.kind) || "file",
      format: (found && found.id) || null,
      manifest: (found && found.file) || null,
      fields: info.fields, supports: info.supports,
      // What it says it needs: dependencies, incompatibilities and version
      // ranges, in one shape whatever manifest they came out of.
      requires: remod.readRequirements(files, found),
      icon: icon ? icon.dataUrl : null, iconPath: icon ? icon.path : null,
    };
  } catch (e) { return { error: e.message }; }
});

ipcMain.handle("remod:set-icon", async (event, { ticket, dataUrl }) => {
  const s = remodSessions.get(String(ticket));
  if (!s) return { error: "That edit is no longer open" };
  try {
    const b64 = String(dataUrl || "").replace(/^data:image\/[\w+.-]+;base64,/, "");
    if (!b64) return { error: "No picture" };
    // Through sharp, so whatever the picker hands over (a jpeg, a cropped
    // canvas) lands in the archive as the PNG every manifest expects.
    const png = await sharp(Buffer.from(b64, "base64")).png().toBuffer();
    const r = remod.writeIcon(path.join(s.dir, "files"), s.format, png);
    if (r && r.error) return r;
    const icon = remod.readIcon(path.join(s.dir, "files"), s.format);
    return { success: true, path: r.path, icon: icon ? icon.dataUrl : null };
  } catch (e) { return { error: e.message }; }
});

// Write the fields back, re-zip in the same structure, and put the archive
// where it belongs — under a new name if one was asked for.
ipcMain.handle("remod:save", async (event, { ticket, fields, requires, filename }) => {
  const s = remodSessions.get(String(ticket));
  if (!s) return { error: "That edit is no longer open" };
  const files = path.join(s.dir, "files");
  let notes = [];
  try {
    if (fields && Object.keys(fields).length) {
      const r = remod.writeFields(files, s.format, fields);
      if (r && r.error) return r;
    }
    if (requires) {
      const r = remod.writeRequirements(files, s.format, requires);
      if (r && r.error) return r;
      // Not every manifest can say every kind of requirement, and what had to
      // be written differently is worth saying rather than quietly doing.
      notes = (r && r.notes) || [];
    }
    // A rename keeps whatever .disabled suffix the file had: that suffix is
    // how the launcher stores "switched off", not part of the name.
    const wasOff = /\.disabled$/i.test(s.filename);
    let want = String(filename || s.filename).replace(/\.disabled$/i, "").trim();
    if (!want || /[\\/]/.test(want) || want === "." || want === "..") return { error: "That is not a file name" };
    const dest = contentPath(s.type, s.id, s.tab, want + (wasOff ? ".disabled" : ""));
    if (!dest) return { error: "That is not a file name" };
    if (dest !== s.archive && fs.existsSync(dest)) return { error: "There is already a file called that" };

    await remodJob({ type: "repack", dir: files, archive: s.archive, dirs: s.dirs });
    let finalName = s.filename;
    if (dest !== s.archive) {
      fs.renameSync(s.archive, dest);
      finalName = path.basename(dest);
      // options.txt lists an enabled resource pack by file name, so a rename
      // that did not reach it would switch the pack off.
      if (s.type !== "server" && s.tab === "resourcepacks") {
        const was = "file/" + s.filename, now = "file/" + finalName;
        const packs = readEnabledResourcePacks(s.id);
        if (packs.includes(was)) writeEnabledResourcePacks(s.id, packs.map(p => (p === was ? now : p)));
      }
    }
    fs.rmSync(s.dir, { recursive: true, force: true });
    remodSessions.delete(String(ticket));
    return { success: true, filename: finalName, notes };
  } catch (e) { return { error: e.message }; }
});

ipcMain.handle("remod:cancel", (event, { ticket }) => {
  const s = remodSessions.get(String(ticket));
  if (!s) return { success: true };
  try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch { /* ignore */ }
  remodSessions.delete(String(ticket));
  return { success: true };
});

ipcMain.handle("remod:open-folder", (event, { ticket, sub }) => {
  const s = remodSessions.get(String(ticket));
  if (!s) return { error: "That edit is no longer open" };
  const p = fileManager.safePath(path.join(s.dir, "files"), sub || "");
  if (p) shell.openPath(p);
  return { success: true };
});

// The same file-browser backend as an instance's Files tab, rooted at the
// workspace instead.
ipcMain.handle("remod-fs:list", (event, { id, path: rel }) => fileManager.listFiles(remodDir(id), rel));
ipcMain.handle("remod-fs:read", (event, { id, path: rel }) => fileManager.readFile(remodDir(id), rel));
ipcMain.handle("remod-fs:write", (event, { id, path: rel, text }) => fileManager.writeFile(remodDir(id), rel, text));
ipcMain.handle("remod-fs:delete", (event, { id, path: rel }) => fileManager.deleteFile(remodDir(id), rel));
ipcMain.handle("remod-fs:mkdir", (event, { id, path: rel, folder }) => fileManager.newFolder(remodDir(id), rel, folder));
ipcMain.handle("remod-fs:newfile", (event, { id, path: rel, file }) => fileManager.newFile(remodDir(id), rel, file));
ipcMain.handle("remod-fs:copy", (event, { id, path: rel }) => fileManager.copyEntry(remodDir(id), rel));
ipcMain.handle("remod-fs:read-nbt", (event, { id, path: rel }) => readNbtAt(remodDir(id), rel));
ipcMain.handle("remod-fs:write-nbt", (event, { id, path: rel, json, gzip, type }) => writeNbtAt(remodDir(id), rel, json, gzip, type));

// ── Server resource packs (ordered) + merge-and-host through the relay ──
// A server keeps an ordered list of .zip packs in servers/<name>/resourcepacks.
// Before the server is shared, they're merged into ONE pack, hosted by a tiny
// local HTTP server, and exposed publicly through the relay's HTTP tunnel — so
// server.properties can point at http://redstonemc.net:<port>/<player>/<token>/
// <pack>.zip with a matching sha1. Nothing is stored on the relay.
function packDir(name) { return path.join(serverRoot(name), "resourcepacks"); }
// Launcher bookkeeping lives in the meta dir, not in the server folder itself.
function packCfgPath(name) {
  const p = path.join(metaDir("servers", name), "resourcepack-config.json");
  migrateMeta(path.join(serverRoot(name), "resourcepack-config.json"), p);
  return p;
}
function loadPackCfg(name) {
  try { const c = JSON.parse(fs.readFileSync(packCfgPath(name), "utf8")); return { order: c.order || [], required: !!c.required, disabled: c.disabled || [] }; }
  catch { return { order: [], required: false, disabled: [] }; }
}
function savePackCfg(name, cfg) { try { const p = packCfgPath(name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(cfg)); } catch { /* ignore */ } }
// Ordered, existing .zip packs (order file first, then any not yet listed).
function packList(name) {
  const dir = packDir(name);
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => /\.zip$/i.test(f)); } catch { }
  const cfg = loadPackCfg(name);
  const ordered = (cfg.order || []).filter(f => files.includes(f));
  files.forEach(f => { if (!ordered.includes(f)) ordered.push(f); });
  // Persist any newly-discovered packs into the order.
  if (JSON.stringify(ordered) !== JSON.stringify(cfg.order)) { cfg.order = ordered; savePackCfg(name, cfg); }
  return ordered.map(f => ({ filename: f, enabled: !(cfg.disabled || []).includes(f) }));
}
// Merge the enabled packs (top of the list = highest priority) into one zip.
function buildMergedPack(name) {
  const dir = packDir(name);
  const enabled = packList(name).filter(p => p.enabled).map(p => p.filename);
  if (!enabled.length) return null;
  const merged = new AdmZip();
  const seen = new Map();
  // Iterate lowest→highest priority so the top pack's files overwrite the rest.
  for (let i = enabled.length - 1; i >= 0; i--) {
    try { const z = new AdmZip(path.join(dir, enabled[i])); for (const e of z.getEntries()) { if (!e.isDirectory) seen.set(e.entryName, e.getData()); } } catch { /* skip bad zip */ }
  }
  if (!seen.size) return null;
  for (const [entryName, data] of seen) merged.addFile(entryName, data);
  const buf = merged.toBuffer();
  const sha1 = crypto.createHash("sha1").update(buf).digest("hex");
  return { buf, sha1 };
}
// name -> { server, port, token, player, packName, sha1 }
const packHttp = new Map();
function stopPackHttp(name) { const h = packHttp.get(name); if (h) { try { h.server.close(); } catch { } packHttp.delete(name); } }
function startPackHttp(name, player) {
  const merged = buildMergedPack(name);
  if (!merged) { stopPackHttp(name); return null; }
  stopPackHttp(name);
  return new Promise((resolve) => {
    const token = crypto.randomBytes(9).toString("hex");
    const packName = (String(name).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "pack");
    const playerSeg = (String(player || "host").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "host");
    const wantPath = `/${playerSeg}/${token}/${packName}.zip`;
    const server = http.createServer((req, res) => {
      // Only the exact tokenised path serves the zip; anything else 404s.
      const url = (req.url || "").split("?")[0];
      if (url !== wantPath) { res.writeHead(404); res.end("Not found"); return; }
      res.writeHead(200, { "Content-Type": "application/zip", "Content-Length": merged.buf.length });
      res.end(merged.buf);
    });
    server.on("error", () => resolve(null));
    server.listen(0, "0.0.0.0", () => {
      const port = server.address().port;
      packHttp.set(name, { server, port, token, player: playerSeg, packName, sha1: merged.sha1, wantPath });
      resolve({ port, token, sha1: merged.sha1, wantPath });
    });
  });
}
function lanIp() {
  const ifs = os.networkInterfaces();
  for (const list of Object.values(ifs)) for (const i of list || []) if (i.family === "IPv4" && !i.internal) return i.address;
  return "127.0.0.1";
}
// Rewrite server.properties' resource-pack lines (or clear them).
function setServerRpProps(name, url, sha1, required) {
  const p = path.join(serverRoot(name), "server.properties");
  let lines = [];
  try { if (fs.existsSync(p)) lines = fs.readFileSync(p, "utf8").split(/\r?\n/); } catch { }
  const drop = ["resource-pack=", "resource-pack-sha1=", "require-resource-pack="];
  lines = lines.filter(l => !drop.some(d => l.startsWith(d)));
  if (url) {
    lines.push(`resource-pack=${url}`);
    if (sha1) lines.push(`resource-pack-sha1=${sha1}`);
    lines.push(`require-resource-pack=${required ? "true" : "false"}`);
  }
  try { fs.mkdirSync(serverRoot(name), { recursive: true }); fs.writeFileSync(p, lines.filter(l => l !== "").join("\n") + "\n"); } catch { /* ignore */ }
}
// Merge + host + expose a server's packs, then point server.properties at them.
// Uses the relay's HTTP tunnel when the server is shared, else the LAN IP.
async function ensureServerPack(name, player) {
  const cfg = loadPackCfg(name);
  const merged = buildMergedPack(name);
  if (!merged) { stopPackHttp(name); setServerRpProps(name, null); return null; }
  const relay = activeRelays.get(name);
  const info = await startPackHttp(name, player || (relay && relay.packPlayer));
  if (!info) return null;
  let base;
  if (relay && typeof relay.openHttp === "function") {
    // Register this build's token with the relay; it returns the one shared
    // public HTTP port. (Re-registers each build since the token changes.)
    let publicPort = null;
    try { publicPort = await relay.openHttp(info.port, info.token); } catch { publicPort = null; }
    if (publicPort) base = `http://${RELAY_DEFAULTS.host}:${publicPort}`;
  }
  if (!base) base = `http://${lanIp()}:${info.port}`;
  const url = `${base}${info.wantPath}`;
  setServerRpProps(name, url, info.sha1, cfg.required);
  return { url, sha1: info.sha1, required: cfg.required };
}

// ── Server resource-pack management IPCs (used by the server detail tab) ──
ipcMain.handle("server-rp:list", (event, { name }) => {
  const cfg = loadPackCfg(name);
  return { packs: packList(name), required: cfg.required };
});
ipcMain.handle("server-rp:add", async (event, { name }) => {
  const r = await dialog.showOpenDialog({ title: "Add resource packs", filters: [{ name: "Resource packs", extensions: ["zip"] }], properties: ["openFile", "multiSelections"] });
  if (r.canceled || !r.filePaths.length) return { success: false, canceled: true };
  const dir = packDir(name); fs.mkdirSync(dir, { recursive: true });
  const cfg = loadPackCfg(name);
  for (const src of r.filePaths) {
    const base = path.basename(src);
    let dest = path.join(dir, base), i = 1;
    while (fs.existsSync(dest) && path.resolve(dest) !== path.resolve(src)) { dest = path.join(dir, base.replace(/\.zip$/i, "") + "-" + i++ + ".zip"); }
    try { fs.copyFileSync(src, dest); if (!cfg.order.includes(path.basename(dest))) cfg.order.push(path.basename(dest)); } catch { }
  }
  savePackCfg(name, cfg);
  return { success: true, packs: packList(name) };
});
ipcMain.handle("server-rp:remove", (event, { name, filename }) => {
  try { fs.unlinkSync(path.join(packDir(name), filename)); } catch { }
  const cfg = loadPackCfg(name);
  cfg.order = cfg.order.filter(f => f !== filename);
  cfg.disabled = (cfg.disabled || []).filter(f => f !== filename);
  savePackCfg(name, cfg);
  return { success: true, packs: packList(name) };
});
ipcMain.handle("server-rp:reorder", (event, { name, order }) => {
  const cfg = loadPackCfg(name); cfg.order = order; savePackCfg(name, cfg);
  return { success: true, packs: packList(name) };
});
ipcMain.handle("server-rp:setEnabled", (event, { name, filename, enabled }) => {
  const cfg = loadPackCfg(name); cfg.disabled = (cfg.disabled || []).filter(f => f !== filename);
  if (!enabled) cfg.disabled.push(filename);
  savePackCfg(name, cfg);
  return { success: true, packs: packList(name) };
});
ipcMain.handle("server-rp:setRequired", (event, { name, required }) => {
  const cfg = loadPackCfg(name); cfg.required = !!required; savePackCfg(name, cfg);
  return { success: true };
});
// Force a rebuild/host now (e.g. after edits) — returns the public URL if shared.
ipcMain.handle("server-rp:apply", async (event, { name }) => {
  try { const r = await ensureServerPack(name); return { success: true, ...(r || {}) }; }
  catch (e) { return { success: false, error: e.message }; }
});

// ── Redstone Relay (NAT traversal without port-forwarding) ──
// The launcher opens a TLS tunnel to the relay on the VPS; the relay assigns a
// unique public port and players join at redstonemc.net:<port>.
const RELAY_DEFAULTS = {
  host: process.env.REDSTONE_RELAY_HOST || "redstonemc.net",
  controlPort: parseInt(process.env.REDSTONE_RELAY_PORT || "47238", 10),
};
// key -> { address, port, close }. key is a server name or `instance-<id>`.
const activeRelays = new Map();
const DOMAIN_BASE = process.env.REDSTONE_RELAY_HOST || "redstonemc.net";

// Premium (Microsoft) accounts usable for relay auth. Admin status is NOT
// decided here — the relay derives it from the Mojang-verified UUID, so a
// modified launcher can't fake it.
function premiumAccounts() {
  return loadPlayers()
    .filter(p => p.type === "microsoft" && p.auth && p.auth.access_token && p.auth.access_token !== "0")
    .map(p => ({ id: p.id, name: p.auth.name || p.username, uuid: p.auth.uuid }));
}
function accountCredsById(accountId) {
  const players = loadPlayers();
  const p = players.find(x => x.id === accountId && x.type === "microsoft") || players.find(x => x.type === "microsoft" && x.auth?.access_token && x.auth.access_token !== "0");
  return p ? { accessToken: p.auth.access_token, uuid: p.auth.uuid, name: p.auth.name || p.username } : null;
}
// Same as accountCredsById but refreshes the Microsoft token first (and persists
// it). Mojang's join/hasJoined challenge rejects stale access tokens, so the
// relay auth fails unless we hand it a freshly-minted token.
async function accountCredsByIdFresh(accountId) {
  const players = loadPlayers();
  const p = players.find(x => x.id === accountId && x.type === "microsoft") || players.find(x => x.type === "microsoft" && x.auth?.access_token && x.auth.access_token !== "0");
  if (!p) return null;
  try {
    await refreshPlayer(p);
    savePlayers(players);
  } catch (err) {
    console.warn("[Relay] token refresh failed, trying existing token:", err.message);
  }
  return p.auth ? { accessToken: p.auth.access_token, uuid: p.auth.uuid, name: p.auth.name || p.username } : null;
}
ipcMain.handle("relay:accounts", () => premiumAccounts());

// Ask the relay whether this account is an admin + which domains it may use (for
// the share modal's styling). The relay is the sole authority.
ipcMain.handle("relay:adminInfo", async (event, { accountId }) => {
  try {
    const account = await accountCredsByIdFresh(accountId);
    if (!account) return { isAdmin: false, domains: [] };
    const rejectUnauthorized = settings.get("relayVerifyTls", true) !== false;
    return await relayClient.queryRelay({ host: RELAY_DEFAULTS.host, controlPort: RELAY_DEFAULTS.controlPort, account, rejectUnauthorized });
  } catch (err) { return { isAdmin: false, domains: [], error: err.message }; }
});
ipcMain.handle("relay:domain", () => DOMAIN_BASE);

// ── Skin library sync ───────────────────────────────────────────────────────
// The skin library is a local file, so it never followed an account between
// computers. The relay already proves who you are — Mojang's join/hasJoined
// challenge against a per-connection serverId, with the resulting profile id as
// the only identity it trusts — so it can keep a per-account blob, and that is
// what this stores the library in.
//
// Merge rather than overwrite: both sides are keyed by pixel hash, so two
// machines that each added skins while offline end up with both sets instead of
// whichever synced last. A skin deleted on one machine comes back from the
// other, which is the right trade for a library — losing one is worse.
// Two copies of one library into one.
//
// A skin is the same skin as another when it has the same id -- which is what
// editing one keeps -- and failing that when it has the same pixels. Matching
// on pixels ALONE is what made editing a skin that was in the cloud look like
// it had made a second one: the edit changed the pixels, so the copy on the
// relay no longer matched it and came back down as a stranger.
//
// `deleted` is { key: whenDeleted }, keyed by pixels and by id. Either side's
// skin that was deleted after it was last touched is gone and stays gone; one
// added or edited since has a newer timestamp and wins.
function mergeSkinLists(mine, theirs, deleted) {
  const gone = deleted || {};
  const out = [];
  const byId = new Map();
  const byHash = new Map();
  const touched = (s) => Math.max(s.updatedAt || 0, s.addedAt || 0);

  const buried = (s) => {
    for (const key of [s.pixelHash, s.id != null ? `id:${s.id}` : null]) {
      if (key && gone[key] && Number(gone[key]) >= touched(s)) return true;
    }
    return false;
  };

  // Ours first, so local names and ordering win for anything on both sides.
  for (const s of [...(mine || []), ...(theirs || [])]) {
    // A record with no picture in it is not a skin, whichever side it came
    // from. See isSkinRecord.
    if (!isSkinRecord(s) || buried(s)) continue;
    const idKey = s.id != null ? `id:${s.id}` : null;
    const have = (idKey && byId.get(idKey)) || (s.pixelHash && byHash.get(s.pixelHash)) || null;
    if (have) {
      // The same skin twice. Keep whichever was touched last -- that is the
      // edit -- and whichever of the two knows where it lives on Mojang.
      if (touched(s) > touched(have.skin)) {
        const mojang = have.skin.mojangUrl ? { mojangUrl: have.skin.mojangUrl, mojangAt: have.skin.mojangAt } : {};
        have.skin = { ...mojang, ...s };
        out[have.at] = have.skin;
        if (s.pixelHash) byHash.set(s.pixelHash, have);
      } else if (!have.skin.mojangUrl && s.mojangUrl) {
        have.skin.mojangUrl = s.mojangUrl;
        have.skin.mojangAt = s.mojangAt;
      }
      continue;
    }
    const slot = { skin: { ...s }, at: out.length };
    out.push(slot.skin);
    if (idKey) byId.set(idKey, slot);
    if (s.pixelHash) byHash.set(s.pixelHash, slot);
  }
  return out.filter(Boolean).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
}

// Null rather than a throw when there is nobody to sync for: an offline-only
// account isn't a failure, it just has no Mojang library to carry anywhere, and
// treating it as one would put the backoff on for ten minutes every time.
// Whether the selected account is an offline one. Offline accounts have no
// Mojang session, so they cannot authenticate to the relay and nothing of
// theirs is ever synced or stored in the cloud — their skin library lives on
// this machine and nowhere else.
function selectedAccountIsOffline() {
  try {
    const id = storage.get("selectedPlayerId", null);
    const players = loadPlayers();
    const p = players.find(x => String(x.id) === String(id)) || players[0];
    return !!p && isOfflineAccount(p);
  } catch { return false; }
}

async function relayAccountForSync() {
  if (selectedAccountIsOffline()) return null;
  const id = storage.get("selectedPlayerId", null);
  return (await accountCredsByIdFresh(id)) || null;
}

// ── Suggestions ────────────────────────────────────────────────────────────
// Sent to the relay through a connection whose account Mojang has verified, so
// a suggestion always has a real person behind it and that person can be told
// what happened to theirs. A premium account is therefore required, which is
// the same thing as saying "the relay will not take it otherwise".
async function suggestCall(req) {
  const account = await relayAccountForSync();
  if (!account) {
    return { ok: false, error: "Sign in with a Microsoft account to send a suggestion." };
  }
  const rejectUnauthorized = settings.get("relayVerifyTls", true) !== false;
  try {
    return await relayClient.suggestRelay({
      host: RELAY_DEFAULTS.host, controlPort: RELAY_DEFAULTS.controlPort,
      account, rejectUnauthorized, req,
    });
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

ipcMain.handle("suggest:submit", async (event, { title, body } = {}) =>
  suggestCall({ op: "submit", title, body }));
ipcMain.handle("suggest:mine", async () => suggestCall({ op: "mine" }));

// ── The admin panel ────────────────────────────────────────────────────────
// Opened by typing viewAdmin("…") into devtools. Nothing about what is in it
// lives here: the window asks the relay for its panels and draws them, so a
// panel added to the relay turns up without a launcher release.
//
// The password is never stored — it is typed, passed through to the relay with
// every call, and held only in the admin window's memory while it is open.
async function adminCall(req) {
  const account = await relayAccountForSync();
  if (!account) {
    return { ok: false, error: "Sign in with a Microsoft account first." };
  }
  const rejectUnauthorized = settings.get("relayVerifyTls", true) !== false;
  try {
    return await relayClient.adminRelay({
      host: RELAY_DEFAULTS.host, controlPort: RELAY_DEFAULTS.controlPort,
      account, rejectUnauthorized, req,
    });
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

ipcMain.handle("admin:call", async (event, { password, op, args } = {}) =>
  adminCall({ ...(args && typeof args === "object" ? args : {}), op, password }));

let adminPanelWindow = null;
// Checks the password before anything opens, so a wrong one is a message in
// the console rather than an empty window.
ipcMain.handle("admin:open", async (event, { password, panel } = {}) => {
  const r = await adminCall({ op: "panels", password });
  if (!r || !r.ok) {
    return { ok: false, error: (r && r.error === "no") ? "That password is not right." : (r && r.error) || "Could not reach the relay." };
  }
  if (adminPanelWindow && !adminPanelWindow.isDestroyed()) {
    adminPanelWindow.focus();
    adminPanelWindow.webContents.send("admin:session", { password, panels: r.panels || [], panel: panel || null });
    return { ok: true, panels: (r.panels || []).length };
  }
  const win = new BrowserWindow({
    width: 1100, height: 760, minWidth: 820, minHeight: 520,
    icon: path.join(iconPath),
    frame: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  adminPanelWindow = win;
  win.on("closed", () => { adminPanelWindow = null; });
  win.webContents.on("before-input-event", (e, input) => {
    if (input.type === "keyDown" && (input.key === "F12"
      || (input.control && input.shift && String(input.key).toLowerCase() === "i"))) {
      e.preventDefault();
      win.webContents.toggleDevTools();
    }
  });
  win.webContents.once("did-finish-load", () => {
    win.webContents.send("admin:session", { password, panels: r.panels || [], panel: panel || null });
  });
  win.loadFile("frontend/adminpanel.html");
  return { ok: true, panels: (r.panels || []).length };
});

// The admin window's own titlebar buttons. It is not the main window, so
// close-app/min-app/max-app would be the wrong thing: act on the sender's.
ipcMain.on("admin:window", (event, what) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (what === "min") win.minimize();
  else if (what === "max") win.isMaximized() ? win.unmaximize() : win.maximize();
  else if (what === "close") win.close();
});

// Which of these accounts have used Redstone Launcher, and when.
//
// Only the relay can answer this — nothing on this computer knows about
// anybody else's — so it needs a signed-in Microsoft account to make the
// connection with. The answer is about public accounts, so there is nothing
// private being handed over in either direction.
//
// Cached for a while: a friends list is looked at often and the answer changes
// at most once a session.
const _seenCache = new Map();          // uuid -> { at, value }
const SEEN_TTL = 30 * 60 * 1000;
ipcMain.handle("friends:seen", async (event, { uuids } = {}) => {
  const want = (Array.isArray(uuids) ? uuids : [])
    .map(u => String(u || "").replace(/-/g, "").toLowerCase())
    .filter(u => /^[0-9a-f]{32}$/.test(u));
  if (!want.length) return { success: true, users: {} };

  const now = Date.now();
  const users = {};
  const missing = [];
  for (const u of want) {
    const hit = _seenCache.get(u);
    if (hit && now - hit.at < SEEN_TTL) users[u] = hit.value;
    else missing.push(u);
  }
  if (!missing.length) return { success: true, users };

  try {
    const account = await relayAccountForSync();
    if (!account) return { success: true, users, partial: true, reason: "no Microsoft account signed in" };
    const rejectUnauthorized = settings.get("relayVerifyTls", true) !== false;
    const got = await relayClient.seenRelay({
      host: RELAY_DEFAULTS.host, controlPort: RELAY_DEFAULTS.controlPort,
      account, rejectUnauthorized, uuids: missing.slice(0, 50),
    });
    for (const [u, v] of Object.entries(got || {})) {
      _seenCache.set(u, { at: now, value: v });
      users[u] = v;
    }
    return { success: true, users };
  } catch (err) {
    devtoolsLog("friends: could not ask the relay who has used the launcher:", err && err.message);
    return { success: true, users, partial: true, reason: String(err && err.message || err) };
  }
});

// Pull, merge, save, push back. One call keeps both ends in step.
async function syncSkinLibraryNow() {
  const account = await relayAccountForSync();
  if (!account) return { success: false, skipped: true, reason: "no Microsoft account signed in" };
  const uuid = String(account.uuid || "").replace(/-/g, "");
  const rejectUnauthorized = settings.get("relayVerifyTls", true) !== false;
  const opts = { host: RELAY_DEFAULTS.host, controlPort: RELAY_DEFAULTS.controlPort, account, rejectUnauthorized };

  const remote = await relayClient.syncRelay({ ...opts, op: "get", kind: "skins" });
  const lib = loadSkinLib();
  // This account's OWN bucket, never the local pool: pooling is a view for this
  // machine, and pushing the pool would copy every account's skins into this
  // one's cloud library.
  const mine = lib[uuid] || [];
  const theirs = (remote && remote.data && Array.isArray(remote.data.skins)) ? remote.data.skins : [];
  // Deletions travel both ways too, and the later record of a given skin
  // wins -- so deleting on one computer removes it on the others, and
  // re-adding it afterwards is not undone by the old tombstone.
  const theirMarks = (remote && remote.data && remote.data.deleted && typeof remote.data.deleted === "object")
    ? remote.data.deleted : {};
  const marks = { ...theirMarks };
  for (const [k, at] of Object.entries(tombstonesFor(lib, uuid))) {
    if (!marks[k] || Number(at) > Number(marks[k])) marks[k] = Number(at);
  }
  const merged = mergeSkinLists(mine, theirs, marks);

  lib[uuid] = merged;
  setTombstones(lib, uuid, marks);
  saveSkinLib(lib);

  // ONLY skins that are on Mojang's servers leave this computer. A skin you
  // uploaded is already public and permanent — its texture URL is content
  // addressed and never expires — so carrying it between your computers tells
  // nobody anything they couldn't already fetch. A local draft is a private
  // file on your disk, and stays one.
  const uploaded = merged.filter(s => s && s.mojangUrl);
  await relayClient.syncRelay({
    ...opts, op: "put", kind: "skins",
    data: { skins: uploaded, deleted: tombstonesFor(lib, uuid) },
  });
  return {
    success: true,
    local: mine.length, remote: theirs.length,
    total: merged.length, shared: uploaded.length,
    deleted: Object.keys(tombstonesFor(lib, uuid)).length,
  };
}

ipcMain.handle("skins:cloudSync", async (event, opts) => {
  // A background pull respects the backoff; an explicit ask ignores it.
  if (!(opts && opts.force) && Date.now() < _syncBlockedUntil) {
    return { success: false, skipped: true };
  }
  try {
    const r = await syncSkinLibraryNow();
    if (r && r.success) _syncBlockedUntil = 0;
    return r;
  } catch (err) {
    _syncBlockedUntil = Date.now() + SYNC_BACKOFF_MS;
    return { success: false, error: String(err && err.message || err) };
  }
});

// Share one skin library across the accounts on THIS machine. Separate from
// the relay sync above, which carries one account's library between computers:
// this is local, and the two compose — pooling decides what the page shows,
// the relay sync still only ever pushes and pulls the signed-in account's own
// skins, so turning pooling on can't leak one account's library into another's
// cloud copy.
ipcMain.handle("skins:poolEnabled", () => poolingSkins());
ipcMain.handle("skins:poolSetEnabled", (event, { on }) => {
  settings.set(POOL_SKINS_SETTING, !!on);
  const lib = loadSkinLib();
  // Turning it off drops the pooled ordering; each account's own order is
  // untouched and comes straight back.
  if (!on && lib[POOL_ORDER_KEY]) { delete lib[POOL_ORDER_KEY]; saveSkinLib(lib); }
  const accounts = Object.keys(lib).filter(u => u !== POOL_ORDER_KEY && Array.isArray(lib[u]));
  return {
    success: true,
    enabled: !!on,
    accounts: accounts.length,
    total: on ? pooledSkinList(lib).length : 0,
  };
});

// Called after the library changes. There is no setting: a skin that is on
// Mojang's servers follows the account that uploaded it, always. Quiet, because
// syncing is a convenience and a relay that is down must never get in the way
// of using the launcher.
let _syncTimer = null;
// After a failure, stop trying for a while. Without this an unreachable relay
// would be dialled again on every single library change.
let _syncBlockedUntil = 0;
const SYNC_BACKOFF_MS = 10 * 60 * 1000;

function scheduleSkinSync() {
  // Nothing an offline account does goes to the cloud. Without this, adding a
  // skin to an offline account's library would still start a relay handshake
  // it cannot complete, fail, and put the sync into its ten-minute backoff —
  // so a premium account on the same machine would then stop syncing too.
  if (selectedAccountIsOffline()) return;
  if (Date.now() < _syncBlockedUntil) return;
  clearTimeout(_syncTimer);
  // Coalesce a burst of changes (adding several skins at once) into one push.
  _syncTimer = setTimeout(() => {
    syncSkinLibraryNow().catch(err => {
      _syncBlockedUntil = Date.now() + SYNC_BACKOFF_MS;
      devtoolsLog("skin sync failed, pausing for 10 minutes:", err && err.message);
    });
  }, 4000);
}

// Sanitize a label for use as a subdomain component.
function subLabel(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40); }

// Open an ICE relay tunnel. Requires a verified premium account and a subdomain
// under <username>.redstonemc.net (admins can use anything).
ipcMain.handle("relay:open", async (event, { key, name, localPort, subdomain, domain, accountId }) => {
  const k = key || name;
  try {
    if (activeRelays.has(k)) {
      const s = activeRelays.get(k);
      return { success: true, address: s.shownAddr || s.address, port: s.port, already: true };
    }
    if (!localPort && name) { try { localPort = serverManager.getServerPort(name); } catch { /* ignore */ } }
    if (!localPort) return { success: false, error: "No local port to share" };

    const account = await accountCredsByIdFresh(accountId);
    if (!account) return { success: false, error: "Sharing over the internet needs a premium Minecraft account. Add one in the Login page first." };

    const sub = subdomain || subLabel(account.name);
    const rejectUnauthorized = settings.get("relayVerifyTls", true) !== false;

    // ICE gathers every candidate FIRST: try a UPnP port-mapping so we can hand
    // the relay a direct public endpoint. When that works, the relay points DNS
    // straight at the host and game traffic bypasses the relay hop entirely; the
    // relay tunnel then only serves as a fallback. Best-effort.
    let directIp = null, directAddress = null;
    try {
      const up = await upnp.openPort(Number(localPort), "TCP", "Redstone Launcher");
      if (up && up.success && up.externalIP) { directIp = up.externalIP; directAddress = Number(localPort) === 25565 ? up.externalIP : `${up.externalIP}:${localPort}`; }
    } catch (e) { console.warn("[Relay] UPnP candidate unavailable:", e.message); }

    const session = await relayClient.openRelay({
      host: RELAY_DEFAULTS.host, controlPort: RELAY_DEFAULTS.controlPort,
      subdomain: sub, domain: domain || DOMAIN_BASE, localPort, account, directIp, rejectUnauthorized,
    });

    if (!session.address || !session.port) { try { session.close(); } catch { /* ignore */ } return { success: false, error: "The relay didn't return a join address (is the relay server running?)" }; }
    // Minecraft's default port (25565) is implied — don't show it.
    const shownAddr = session.port === 25565 ? session.address : `${session.address}:${session.port}`;
    activeRelays.set(k, { ...session, shownAddr, directAddress, localPort, upnpMapped: !!directIp, packPlayer: subLabel(account.name) });
    // If this is a server with managed resource packs, merge + host them through
    // the relay's HTTP tunnel and point server.properties at the public URL.
    let resourcePack = null;
    if (name && k === name) {
      try { resourcePack = await ensureServerPack(name, subLabel(account.name)); } catch (e) { console.warn("[Relay] pack host failed:", e.message); }
    }
    return { success: true, address: shownAddr, port: session.port, directAddress, resourcePack };
  } catch (err) {
    console.error("[Relay] open failed:", err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("relay:close", async (event, { key, name }) => {
  const k = key || name;
  const s = activeRelays.get(k);
  if (s) {
    try { s.close(); } catch { /* ignore */ }
    if (s.upnpMapped) { try { await upnp.closePort(Number(s.localPort)); } catch { /* ignore */ } }
    activeRelays.delete(k);
    // Tear down the pack host + drop the (now-dead) public URL from the server.
    if (name && k === name) { stopPackHttp(name); setServerRpProps(name, null); }
  }
  return { success: true };
});

ipcMain.handle("relay:status", async (event, { key, name }) => {
  const k = key || name;
  const s = activeRelays.get(k);
  return s ? { active: true, address: s.shownAddr || s.address, port: s.port, directAddress: s.directAddress || null } : { active: false };
});

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

    // Server-side resource packs are now managed as an ordered, merged list
    // (hosted through the relay), so register the download in the pack order
    // rather than pointing server.properties straight at the Modrinth URL.
    if (server && projectType === "resourcepack") {
      try { const cfg = loadPackCfg(id); if (!cfg.order.includes(fileName)) { cfg.order.push(fileName); savePackCfg(id, cfg); } } catch { /* ignore */ }
    }

    return { success: true, path: dest };
  } catch (err) {
    devtoolsLog("Failed to download file:", err);
    return { success: false, error: err.message };
  }
});

// ---------------- Modpack install, watchable while it runs ------------------
// Installing a pack used to be a single await that returned minutes later with
// nothing on screen in between. The renderer now hands over a ticket, gets an
// answer straight away, and follows the install through "modpack-install"
// events -- which carry the instance id the moment the instance exists, so its
// page can open and show the rest of the work happening.
const modpackInstalls = new Map();   // ticket -> latest state

function mpSend(state) {
  modpackInstalls.set(state.ticket, state);
  for (const w of BrowserWindow.getAllWindows()) {
    try { if (!w.isDestroyed()) w.webContents.send("modpack-install", state); } catch { /* window went away */ }
  }
}
// saveProfiles() only writes the file; the renderers hear about changes through
// whichever handler made them. An install runs outside any handler, so it has to
// tell every window itself.
async function broadcastProfilesNow() {
  try { broadcastProfiles(await loadProfiles()); } catch { /* nothing to broadcast */ }
}

const MP_PHASE_LABELS = {
  download: "Downloading the modpack",
  extract: "Extracting",
  mods: "Downloading mods",
  done: "Installed",
  error: "Install failed",
};

// Which importer a downloaded pack needs. A .mrpack has modrinth.index.json
// at its root and a CurseForge pack has manifest.json; nothing else is a pack
// this launcher can install, and assuming .mrpack was what made a CurseForge
// download fail with "modrinth.index.json not found".
function packImporter(zipPath) {
  try {
    const names = new AdmZip(zipPath).getEntries().map(e => e.entryName);
    if (names.includes("manifest.json") && !names.includes("modrinth.index.json")) return curseforgeImport;
  } catch { /* let the importer give the real reason */ }
  return mrpack;
}

async function runModpackInstall({ ticket, url, name, iconUrl }) {
  const st = {
    ticket, name: name || "Modpack", phase: "download",
    done: 0, total: 0, detail: "", profileId: null, error: null, finished: false,
  };
  const emit = (patch) => {
    Object.assign(st, patch || {}, { ticket });
    mpSend(st);
    // Also drive the ordinary launch/download progress bar — the one the
    // sidebar, the instance page and the toolbar already show for everything
    // else. Installing a pack had its own separate bar for no good reason.
    if (st.profileId) {
      if (st.finished) broadcastProgress(st.profileId, { done: true, label: MP_PHASE_LABELS[st.phase] || "Ready" });
      else broadcastProgress(st.profileId, {
        label: MP_PHASE_LABELS[st.phase] || "Installing",
        current: st.done, total: st.total,
      });
    }
  };
  emit({});
  try {
    const tmpPath = path.join(app.getPath("temp"), `mp-${Date.now()}.mrpack`);
    await downloadFile(url, tmpPath);
    emit({ phase: "extract", done: 0, total: 0, detail: "" });

    // Which kind of pack is it? Both are zips, and a CurseForge download is
    // just as likely to arrive here as a .mrpack now that the new-instance
    // search offers both sites. Decided by what is inside rather than by the
    // file name, which for CurseForge is a .zip either way.
    const importer = packImporter(tmpPath);
    const res = await importer(
      tmpPath,
      (done, total, rel) => emit({ phase: "mods", done, total, detail: rel }),
      {
        iconUrl: iconUrl || null,
        onCreated: (profile) => { emit({ profileId: profile.id, name: profile.name }); broadcastProfilesNow(); },
        onExtract: (done, total) => emit({ phase: "extract", done, total }),
      }
    );
    if (!res || !res.success) throw new Error((res && res.error) || "Install failed");
    emit({ phase: "done", finished: true, profileId: res.profile.id, name: res.profile.name, detail: "" });
    await broadcastProfilesNow();
    return res;
  } catch (err) {
    emit({ phase: "error", finished: true, error: String(err && err.message || err) });
    await broadcastProfilesNow();
    return { success: false, error: String(err && err.message || err) };
  } finally {
    // Keep the final state around briefly so a page that opens late still sees
    // how it ended, then stop holding on to it.
    setTimeout(() => modpackInstalls.delete(ticket), 5 * 60 * 1000);
  }
}

// Install a pack as a SERVER instead of a client instance: same archive, but
// the files land in a server directory, the server jar/loader is provisioned
// for the pack's Minecraft + loader version, and client-only overrides are
// skipped. Returns once the server exists; mods keep downloading behind it.
// "Pack", "Pack (2)", "Pack (3)"… Server folders are named after the server, so
// installing the same pack twice would otherwise overwrite the first one.
function uniqueServerName(base) {
  const clean = String(base || "Modpack").replace(/[\\/:*?"<>|]/g, "_").trim() || "Modpack";
  let taken = new Set();
  try { taken = new Set((serverManager.getServers() || []).map(s => String(s.name))); } catch { /* none yet */ }
  try {
    const dir = path.join(dataDir, "servers");
    if (fs.existsSync(dir)) fs.readdirSync(dir).forEach(n => taken.add(n));
  } catch { /* directory listing is a bonus */ }
  if (!taken.has(clean)) return clean;
  for (let i = 2; i < 500; i++) if (!taken.has(`${clean} (${i})`)) return `${clean} (${i})`;
  return `${clean} ${Date.now()}`;
}

async function runModpackServerInstall({ ticket, url, name, iconUrl }) {
  const st = {
    ticket, name: name || "Modpack", phase: "download", kind: "server",
    done: 0, total: 0, detail: "", serverName: null, profileId: null, error: null, finished: false,
  };
  const emit = (patch) => { Object.assign(st, patch || {}, { ticket }); mpSend(st); };
  emit({});
  try {
    const tmpPath = path.join(app.getPath("temp"), `mp-srv-${Date.now()}.mrpack`);
    await downloadFile(url, tmpPath);
    emit({ phase: "extract" });

    const zip = new AdmZip(tmpPath);
    const indexEntry = zip.getEntry("modrinth.index.json");
    if (!indexEntry) throw new Error("modrinth.index.json not found in .mrpack");
    const index = JSON.parse(indexEntry.getData().toString("utf8"));
    const deps = index.dependencies || {};
    const { loader, loaderVersion } = loaderFromMrpackDeps(deps);
    const mcVersion = deps["minecraft"] || "1.20.1";

    // A server can't run a client-only loader; vanilla is the honest fallback.
    const serverType = ["forge", "neoforge", "fabric", "quilt"].includes(loader) ? loader : "vanilla";
    // Server directories are keyed by name, so a second install of the same
    // pack must not land on top of the first.
    const srvName = uniqueServerName(index.name || name || "Modpack");

    let java = "java";
    try { java = await getJavaForMinecraft(mcVersion); } catch { /* system java */ }

    const icon = await packIcon(zip, iconUrl);

    const srv = await serverManager.makeServer({
      name: srvName, version: mcVersion, type: serverType,
      loaderVersion: loaderVersion || "", icon: icon || "",
    }, java);
    emit({ serverName: srv.name || srvName, name: index.name || st.name });

    // Overrides: server-overrides/ wins over the shared overrides/, and
    // client-overrides/ has no business on a server.
    const dir = srv.dir || path.join(dataDir, "servers", srvName);
    const relFor = (entryName) => {
      if (entryName === "modrinth.index.json" || entryName === "icon.png") return null;
      if (entryName.startsWith("client-overrides/")) return null;
      if (entryName.startsWith("server-overrides/")) return entryName.slice("server-overrides/".length) || null;
      if (entryName.startsWith("overrides/")) return entryName.slice("overrides/".length) || null;
      return entryName;
    };
    const entries = zip.getEntries().filter(e => !e.isDirectory);
    let exDone = 0;
    for (const e of entries) {
      exDone++;
      const rel = relFor(e.entryName);
      if (rel) {
        const out = path.join(dir, rel);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, e.getData());
      }
      emit({ phase: "extract", done: exDone, total: entries.length });
    }

    // Only the files this pack marks as server-side.
    const files = (index.files || []).filter(f => {
      const env = f.env || {};
      return env.server !== "unsupported";
    });
    emit({ phase: "mods", done: 0, total: files.length, detail: "" });
    let dlDone = 0;
    for (const f of files) {
      const out = path.join(dir, String(f.path).replace(/\//g, path.sep));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      try { await downloadFile(f.downloads[0], out); } catch { /* one bad mod shouldn't kill the install */ }
      dlDone++;
      emit({ phase: "mods", done: dlDone, total: files.length, detail: String(f.path).replace(/\\/g, "/") });
    }

    emit({ phase: "done", finished: true, detail: "" });
    return { success: true, serverName: srv.name || srvName };
  } catch (err) {
    emit({ phase: "error", finished: true, error: String(err && err.message || err) });
    return { success: false, error: String(err && err.message || err) };
  } finally {
    setTimeout(() => modpackInstalls.delete(ticket), 5 * 60 * 1000);
  }
}

// Kick off an install and return immediately — the caller follows the events.
// What a modpack would put in an instance, WITHOUT downloading the pack.
//
// The mod list lives in the archive's index, which is a few kilobytes at the
// front of a file that is often hundreds of megabytes. The launcher already
// reads a zip over HTTP by ranges, for a version's jar, so the same reader
// fetches the central directory and that one entry and nothing else.
//
// A Modrinth pack names every file it installs. A CurseForge one lists
// project and file ids only -- no names without a lookup each -- so that one
// answers with a count and says so.
const _packPreview = new Map();

// Turn a pack's file list into mods with real names and icons: one bulk
// request for every project in it rather than one per mod. Best effort -- a
// pack still lists what it installs if Modrinth cannot be reached, just by
// file name.
async function nameModsFromModrinth(mods) {
  const ids = [...new Set(mods.map(m => m.projectId).filter(Boolean))];
  if (!ids.length) return;
  try {
    const res = await fetch(`https://api.modrinth.com/v2/projects?ids=${encodeURIComponent(JSON.stringify(ids))}`,
      { headers: { "User-Agent": LAUNCHER_UA } });
    if (!res.ok) return;
    const projects = await res.json();
    const by = new Map();
    for (const p of (Array.isArray(projects) ? projects : [])) by.set(p.id, p);
    for (const m of mods) {
      const p = m.projectId && by.get(m.projectId);
      if (!p) continue;
      if (p.title) m.name = p.title;
      if (p.icon_url) m.icon = p.icon_url;
      if (p.project_type) m.kind = p.project_type === "mod" ? "mod"
        : p.project_type === "resourcepack" ? "resource pack"
          : p.project_type === "shader" ? "shader pack" : p.project_type;
    }
  } catch { /* names from the file paths will do */ }
}
ipcMain.handle("modpack:preview", async (event, { url }) => {
  const key = String(url || "");
  if (!key) return { error: "no pack" };
  if (_packPreview.has(key)) return _packPreview.get(key);
  const answer = await (async () => {
    try {
      const src = await iconModels.modelAssets.remoteZipSource("modpack", "pack", key);
      if (!src) return { error: "that pack could not be opened" };
      // A raw source answers with bytes; json() belongs to a stack.
      const readJson = async (name) => {
        const buf = await src.get(name);
        if (!buf) return null;
        try { return JSON.parse(buf.toString("utf8")); } catch { return null; }
      };
      const index = await readJson("modrinth.index.json");
      if (index) {
        const mods = (index.files || []).map(f => {
          const p = String(f.path || "");
          // Every download a Modrinth pack lists is a CDN path that carries
          // the project's own id: .../data/<projectId>/versions/<id>/<file>.
          // That is what turns a file name into a mod with a title and an
          // icon, below, without having to look anything up by hash.
          const cdn = (f.downloads || []).map(String)
            .map(u => /\/data\/([A-Za-z0-9]+)\/versions\//.exec(u))
            .find(Boolean);
          return {
            path: p,
            projectId: cdn ? cdn[1] : null,
            // Until the lookup fills it in: the file's own name, tidied.
            name: p.split("/").pop().replace(/\.(jar|zip)$/i, "").replace(/[_-]/g, " ").trim(),
            kind: /^mods\//.test(p) ? "mod" : /^resourcepacks\//.test(p) ? "resource pack"
              : /^shaderpacks\//.test(p) ? "shader pack" : "file",
            size: f.fileSize || 0,
          };
        });
        await nameModsFromModrinth(mods);
        return { name: index.name || null, packVersion: index.versionId || null, mods };
      }
      const manifest = await readJson("manifest.json");
      if (manifest) {
        // CurseForge: ids, not names.
        return {
          name: manifest.name || null, packVersion: manifest.version || null,
          mods: [], unnamed: (manifest.files || []).length,
        };
      }
      return { error: "that pack has no index in it" };
    } catch (err) { return { error: String((err && err.message) || err) }; }
  })();
  _packPreview.set(key, answer);
  return answer;
});

ipcMain.handle("modpack:install", (event, { url, ticket, name, as, iconUrl }) => {
  if (!url || !ticket) return { success: false, error: "missing url or ticket" };
  if (modpackInstalls.has(ticket)) return { success: true, already: true };
  if (as === "server") runModpackServerInstall({ ticket, url, name, iconUrl });
  else runModpackInstall({ ticket, url, name, iconUrl });
  return { success: true, as: as === "server" ? "server" : "instance" };
});
// For a page that loads after some progress has already gone by.
ipcMain.handle("modpack:installState", (event, { ticket }) => modpackInstalls.get(ticket) || null);

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
      // "Still the default" is now an absent icon, but instances made before
      // that stored the old remote URL, so both count.
      const LEGACY_DEFAULT = "https://tggamesyt.dev/assets/redstone_launcher_defaulticon.png";
      const isDefault = !profiles[idx].icon || profiles[idx].icon === LEGACY_DEFAULT;
      if (iconUrl && isDefault) profiles[idx].icon = iconUrl;
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

// What an export can contain. Each entry is a top-level folder (or a set of
// root files) in the instance, so the picker maps one-to-one onto what actually
// gets written.
const EXPORT_PARTS = {
  mods: { dirs: ["mods"], label: "Mods" },
  resourcepacks: { dirs: ["resourcepacks"], label: "Resource packs" },
  shaderpacks: { dirs: ["shaderpacks"], label: "Shader packs" },
  config: { dirs: ["config", "defaultconfigs"], label: "Config" },
  saves: { dirs: ["saves"], label: "Worlds" },
  screenshots: { dirs: ["screenshots"], label: "Screenshots" },
  options: { files: ["options.txt", "optionsof.txt", "optionsshaders.txt", "servers.dat"], label: "Game options & server list" },
};
// Never worth shipping: caches, the game itself, and per-machine state.
const EXPORT_NEVER_FILES = new Set(["usercache.json", "command_history.txt", "debug-profile.json", "realms_persistence.json", "realms_presistence.json", "launcher_profiles.json"]);

// The real version from package.json, so the About section can't drift out of
// step with what's actually installed.
ipcMain.handle("get-app-version", () => app.getVersion());

ipcMain.handle("export:parts", () =>
  Object.entries(EXPORT_PARTS).map(([key, v]) => ({ key, label: v.label })));

// Where an export should go by default, and a folder picker for changing it.
ipcMain.handle("export:defaultDir", () => {
  try { return app.getPath("downloads"); } catch { return app.getPath("home"); }
});
ipcMain.handle("export:pickDir", async () => {
  try {
    const r = await dialog.showOpenDialog({ title: "Where should the export be saved?", properties: ["openDirectory", "createDirectory"] });
    if (r.canceled || !r.filePaths.length) return null;
    return r.filePaths[0];
  } catch { return null; }
});

// Collect the files an export should contain, honouring the include options.
// Only the selected parts are walked, so nothing has to be excluded afterwards.
async function collectInstanceFiles(instanceFolder, include) {
  const results = [];
  const wanted = Array.isArray(include) && include.length ? include : Object.keys(EXPORT_PARTS);

  async function walk(dir, base) {
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = path.relative(base, full).replace(/\\/g, "/");
      if (e.isDirectory()) { await walk(full, base); continue; }
      if (!e.isFile()) continue;                                  // skip symlinks/sockets
      if (EXPORT_NEVER_FILES.has(e.name.toLowerCase())) continue;
      results.push({ full, rel });
    }
  }

  for (const key of wanted) {
    const part = EXPORT_PARTS[key];
    if (!part) continue;
    for (const d of (part.dirs || [])) {
      const full = path.join(instanceFolder, d);
      if (fs.existsSync(full) && fs.statSync(full).isDirectory()) await walk(full, instanceFolder);
    }
    for (const f of (part.files || [])) {
      const full = path.join(instanceFolder, f);
      if (fs.existsSync(full) && fs.statSync(full).isFile()) results.push({ full, rel: f });
    }
  }
  // A folder can appear under two parts (it can't, today, but a future one might).
  const seen = new Set();
  return results.filter(r => (seen.has(r.rel) ? false : (seen.add(r.rel), true)));
}

// Pick a free filename in `dir`, so exporting twice doesn't silently overwrite.
function freeExportPath(dir, base, ext) {
  const safe = String(base || "pack")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/_+/g, "_")          // a run of replaced characters reads better as one
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "")        // Windows rejects a trailing dot or space
    .slice(0, 80)                 // keep the whole path well inside MAX_PATH
    .replace(/[. ]+$/, "")        // ...and the slice can leave one behind
    || "pack";
  // CON, PRN, AUX, NUL, COM1-9, LPT1-9 are device names on Windows: a file can't
  // be called one even with an extension.
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(safe) ? safe + "_" : safe;
  let dest = path.join(dir, reserved + ext), i = 1;
  while (fs.existsSync(dest)) dest = path.join(dir, `${reserved} (${i++})${ext}`);
  return dest;
}

// The loader id CurseForge manifests expect, e.g. "fabric-0.15.11".
function curseLoaderId(profile) {
  const v = profile.loaderVersion || "";
  switch (profile.loader) {
    case "fabric": return "fabric-" + (v || "0.0.0");
    case "quilt": return "quilt-" + (v || "0.0.0");
    case "forge": return "forge-" + (v || "0.0.0");
    case "neoforge": return "neoforge-" + (v || "0.0.0");
    default: return null;
  }
}

/**
 * Export an instance as a Modrinth .mrpack or a CurseForge .zip.
 * opts: { profileId, format: "modrinth"|"curseforge", include: string[], destDir }
 * Returns { success, path } or { success: false, error }.
 */
ipcMain.handle("export-instance", async (event, opts) => {
  const { profileId, format = "modrinth", include, destDir } = opts || {};
  const report = (label, done, total) => { try { event.sender.send("export-progress", { label, done, total }); } catch { /* window gone */ } };
  try {
    if (!profileId) throw new Error("Missing profile id");
    if (format !== "modrinth" && format !== "curseforge") throw new Error("Unknown export format: " + format);

    const profilesFile = path.join(dataDir, "profiles.json");
    if (!fs.existsSync(profilesFile)) throw new Error("profiles.json not found");
    const profiles = JSON.parse(fs.readFileSync(profilesFile, "utf8"));
    // Profile ids can be strings (e.g. "sulfur"), so compare as strings.
    const profile = profiles.find(p => String(p.id) === String(profileId));
    if (!profile) throw new Error("Profile not found");

    const instanceFolder = path.join(dataDir, "client", String(profile.id));
    if (!fs.existsSync(instanceFolder)) throw new Error("Instance folder not found");

    // Default to Downloads rather than dropping the file inside the launcher's
    // own data folder, where nobody would think to look for it.
    let outDir = destDir && String(destDir).trim();
    if (!outDir) { try { outDir = app.getPath("downloads"); } catch { outDir = app.getPath("home"); } }
    try { await fsp.mkdir(outDir, { recursive: true }); }
    catch (e) { throw new Error(`Can't use that folder: ${e.message}`); }

    report("Collecting files", 0, 1);
    const files = await collectInstanceFiles(instanceFolder, include);
    if (!files.length) throw new Error("Nothing selected to export.");

    const zip = new AdmZip();
    const linked = [];        // resolved to a download the pack format can reference
    const overrides = [];     // shipped inside the zip
    let done = 0;

    for (const f of files) {
      report("Checking " + path.basename(f.rel), done++, files.length);
      const buffer = await fsp.readFile(f.full);
      const relPath = f.rel.replace(/\\/g, "/");
      const isMod = /^mods\//i.test(relPath);
      let resolved = null;

      // Only mods are worth looking up: a pack index can reference them by
      // download, and everything else is config the user actually changed.
      if (isMod && /\.jar$/i.test(relPath)) {
        if (format === "modrinth") {
          const { sha1, sha512 } = computeHashes(buffer);
          const hit = await lookupModrinthByHash(sha512, sha1);
          if (hit && hit.url) resolved = { kind: "modrinth", url: hit.url, sha1, sha512, size: buffer.length };
        } else {
          const hit = await lookupCurseByFile(f.full);
          if (hit) resolved = { kind: "curseforge", projectID: hit.projectID, fileID: hit.fileID };
        }
      }

      if (resolved) linked.push({ relPath, resolved });
      else overrides.push({ relPath, buffer });
    }

    report("Writing the pack", files.length, files.length);
    if (format === "modrinth") {
      const indexJson = {
        formatVersion: 1,
        game: "minecraft",
        versionId: String(profile.version || "1.0.0"),
        name: profile.name || `Instance ${profile.id}`,
        files: linked.map(l => ({
          path: l.relPath,
          hashes: { sha1: l.resolved.sha1, sha512: l.resolved.sha512 },
          env: { client: "required", server: "unsupported" },
          downloads: [l.resolved.url],
          fileSize: l.resolved.size,
        })),
        dependencies: { minecraft: profile.version || "1.20.1" },
      };
      const loaderKey = { fabric: "fabric-loader", quilt: "quilt-loader", forge: "forge", neoforge: "neoforge" }[profile.loader];
      if (loaderKey) indexJson.dependencies[loaderKey] = profile.loaderVersion || "*";
      zip.addFile("modrinth.index.json", Buffer.from(JSON.stringify(indexJson, null, 2), "utf8"));
    } else {
      const loaderId = curseLoaderId(profile);
      const manifest = {
        minecraft: {
          version: profile.version || "1.20.1",
          modLoaders: loaderId ? [{ id: loaderId, primary: true }] : [],
        },
        manifestType: "minecraftModpack",
        manifestVersion: 1,
        name: profile.name || `Instance ${profile.id}`,
        version: "1.0.0",
        author: "",
        files: linked.map(l => ({ projectID: l.resolved.projectID, fileID: l.resolved.fileID, required: true })),
        overrides: "overrides",
      };
      zip.addFile("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2), "utf8"));
      // CurseForge shows this in its importer; harmless if ignored.
      zip.addFile("modlist.html", Buffer.from(
        "<ul>" + linked.map(l => `<li>${path.basename(l.relPath)}</li>`).join("") + "</ul>", "utf8"));
    }

    for (const f of overrides) zip.addFile(path.posix.join("overrides", f.relPath), f.buffer);

    const ext = format === "modrinth" ? ".mrpack" : ".zip";
    const dest = freeExportPath(outDir, profile.name || `instance-${profile.id}`, ext);
    // Only the write itself can really tell us whether the folder is usable --
    // a permission pre-check is racy, and passes outright for a privileged user.
    try { zip.writeZip(dest); }
    catch (e) {
      if (e && (e.code === "EACCES" || e.code === "EPERM")) throw new Error("That folder can't be written to. Pick another one.");
      if (e && e.code === "ENOSPC") throw new Error("There isn't enough space on that drive.");
      throw e;
    }
    devtoolsLog("[export] wrote", dest, `(${linked.length} linked, ${overrides.length} bundled)`);
    return { success: true, path: dest, linked: linked.length, bundled: overrides.length };
  } catch (err) {
    devtoolsLog("[export] failed:", err);
    return { success: false, error: err.message || String(err) };
  }
});

// Resolve a jar to a CurseForge project/file via its fingerprint, so the
// manifest can reference it instead of bundling the jar.
async function lookupCurseByFile(fullPath) {
  try {
    const fp = await getFingerprint(fullPath);
    if (!fp) return null;
    const r = await fetch(`${WORKER_URL}/fingerprints`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fingerprints: [fp] }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    const m = (data.data?.exactMatches || [])[0];
    if (!m || !m.id || !m.file?.id) return null;
    return { projectID: m.id, fileID: m.file.id };
  } catch { return null; }
}

/* ─────────────── dihhcord ─────────────── */
// Keep a single launcher-start timestamp so the elapsed timer in the Discord
// activity doesn't reset every time we update the presence text.
const discordLauncherStart = Date.now();
// Remember the last requested presence so it can be (re)applied the moment we
// (re)connect, instead of resetting to the default.
let lastActivity = { details: "In launcher", state: "Idle" };
// What the UI (renderer pages) last asked for — used only when no game is running.
let lastUiActivity = { details: "In launcher", state: "Idle" };

// Is Discord actually running? discord-rpc talks over an IPC socket/named pipe,
// and calling login() when Discord is closed just throws "Could not connect".
// Checking for the endpoint first keeps that error out of the logs entirely.
function discordIpcAvailable() {
  const isIpc = (n) => /^discord-ipc-\d+$/.test(n);
  try {
    if (process.platform === "win32") {
      // Named pipes are enumerable through the pipe filesystem.
      return fs.readdirSync("\\\\.\\pipe\\").some(isIpc);
    }
    const base = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || process.env.TEMP || "/tmp";
    // Flatpak/Snap builds put their socket in a sandboxed subdirectory.
    const dirs = [
      base,
      path.join(base, "app", "com.discordapp.Discord"),
      path.join(base, "snap.discord"),
      path.join(base, ".flatpak", "dev.vencord.Vesktop", "xdg-run"),
    ];
    for (const d of dirs) {
      try { if (fs.readdirSync(d).some(isIpc)) return true; } catch { /* try the next one */ }
    }
    return false;
  } catch { return false; }
}

let discordRetryTimer = null;
function scheduleDiscordRetry() {
  if (discordRetryTimer) return;
  // Discord may be started after the launcher — re-check quietly now and then.
  discordRetryTimer = setInterval(() => {
    if (!settings.get('discordPresence', true) || rpc) { clearInterval(discordRetryTimer); discordRetryTimer = null; return; }
    if (discordIpcAvailable()) { clearInterval(discordRetryTimer); discordRetryTimer = null; startDiscordPresence(); }
  }, 60 * 1000);
  if (discordRetryTimer.unref) discordRetryTimer.unref();
}

function startDiscordPresence() {
  shouldconnect = settings.get('discordPresence', true);
  if (!shouldconnect) return;        // user disabled it
  if (rpc) return;                   // already connecting or connected
  if (!discordIpcAvailable()) {      // Discord isn't running — don't even try
    devtoolsLog('[Discord RPC] Discord not running; will retry later.');
    scheduleDiscordRetry();
    return;
  }

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
    // Discord can quit between the check above and the connect — that's expected,
    // so log it quietly and try again later rather than surfacing a stack trace.
    devtoolsLog('[Discord RPC] Not connected:', (err && err.message) || err);
    if (rpc === client) { rpc = null; rpcConnected = false; }
    scheduleDiscordRetry();
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

// The newest NeoForge build FOR A GIVEN Minecraft version. This used to take
// the newest build in the whole repository regardless of the game version,
// which on a 1.21.1 instance meant offering a build for an entirely different
// Minecraft release.
async function getNeoForgeLatestVersion(minecraftVersion) {
  const latest = await resolveNeoForgeVersion(minecraftVersion || "1.21.1", "");
  return `neoforge-${latest}`;
}

// The builds an instance may pin for a loader, newest first. Fabric and Quilt
// are read straight from their own APIs by the renderer; Forge and NeoForge go
// through here because they come from Maven metadata that needs parsing and
// numeric sorting.
ipcMain.handle("loader:versions", async (event, { loader, gameVersion }) => {
  try {
    const kind = String(loader || "").toLowerCase();
    if (kind !== "forge" && kind !== "neoforge") return { success: true, versions: [] };
    const base = kind === "neoforge"
      ? "https://maven.neoforged.net/releases/net/neoforged/neoforge"
      : "https://maven.minecraftforge.net/net/minecraftforge/forge";
    const res = await fetch(`${base}/maven-metadata.xml`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const all = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map(m => m[1]);
    let list;
    if (kind === "neoforge") {
      const prefix = neoPrefix(gameVersion);
      list = prefix ? all.filter(v => v.startsWith(prefix) && !v.includes("-beta")) : [];
      list.sort(loaderCompareVersions);
    } else {
      const p = String(gameVersion || "") + "-";
      list = all.filter(v => v.startsWith(p));
      list.sort((a, b) => loaderCompareVersions(a.slice(p.length), b.slice(p.length)));
      // Forge's Maven versions carry the game version; the instance stores just
      // the Forge part.
      list = list.map(v => v.slice(p.length));
    }
    return { success: true, versions: list.reverse() };
  } catch (err) {
    return { success: false, error: String(err && err.message || err), versions: [] };
  }
});

// ── Which loaders actually have a build for a version ───────────────────────
//
// Every loader was offered for every version, and the first anyone heard
// otherwise was the launch failing with "no build supports this version" --
// after the instance had been made, named and had mods put in it. The
// creation flow and the edit dialog ask here instead.
//
// A loader whose check cannot be reached is reported as `null`, not `false`.
// Hiding Fabric because a request timed out would be a worse bug than the one
// being fixed, so an unknown answer still gets offered.
const _loaderSupport = new Map();                  // gameVersion -> { at, loaders }
const _mavenCache = new Map();                     // url -> { at, versions }
const LOADER_SUPPORT_TTL = 30 * 60 * 1000;

async function mavenVersionList(url) {
  const seen = _mavenCache.get(url);
  if (seen && Date.now() - seen.at < LOADER_SUPPORT_TTL) return seen.versions;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map(m => m[1]);
  _mavenCache.set(url, { at: Date.now(), versions });
  return versions;
}

// Fabric and Quilt both answer "which loaders can run this game version" with
// a list that is empty when the answer is none.
async function metaListHasAny(url) {
  const res = await fetch(url);
  if (res.status === 400 || res.status === 404) return false;   // a version they have never heard of
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) && data.length > 0;
}

async function loadersForVersion(gameVersion) {
  const v = String(gameVersion || "");
  if (!v) return { vanilla: true };
  const seen = _loaderSupport.get(v);
  if (seen && Date.now() - seen.at < LOADER_SUPPORT_TTL) return seen.loaders;

  const ask = async (fn) => { try { return await fn(); } catch { return null; } };
  const [fabric, quilt, forge, neoforge] = await Promise.all([
    ask(() => metaListHasAny(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(v)}`)),
    ask(() => metaListHasAny(`https://meta.quiltmc.org/v3/versions/loader/${encodeURIComponent(v)}`)),
    ask(async () => (await mavenVersionList("https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml"))
      .some(x => x.startsWith(`${v}-`))),
    ask(async () => {
      const prefix = neoPrefix(v);
      if (!prefix) return false;                   // NeoForge starts at 1.20.2
      return (await mavenVersionList("https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml"))
        .some(x => x.startsWith(prefix) && !x.includes("-beta"));
    }),
  ]);
  const loaders = { vanilla: true, fabric, quilt, forge, neoforge };
  // Only worth remembering an answer that was actually reached.
  if ([fabric, quilt, forge, neoforge].every(x => x !== null)) _loaderSupport.set(v, { at: Date.now(), loaders });
  return loaders;
}

ipcMain.handle("loader:supported", async (event, { gameVersion } = {}) => {
  try {
    const loaders = await loadersForVersion(gameVersion);
    // What to offer: anything that said yes, plus anything that could not be
    // asked. `modded` is false only when every loader definitely said no, so
    // the creation flow can skip the loader step outright.
    const offer = Object.keys(loaders).filter(k => loaders[k] !== false);
    const modded = offer.some(k => k !== "vanilla");
    return { success: true, loaders, offer, modded };
  } catch (err) {
    return { success: false, error: String(err && err.message || err), loaders: null, offer: null, modded: true };
  }
});

async function getCurseForgeLoader(loader, version = "1.20.1") {
  if (loader == "fabric") return await getFabricLatestVersion()
  if (loader == "quilt") return await getQuiltLatestVersion()
  if (loader == "forge") return await getForgeLatestVersion(version)
  if (loader == "neoforge") return await getNeoForgeLatestVersion(version)
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
// Launcher-created bookkeeping (the mod index + the legacy hash cache) must NOT
// live inside mods/ (or any content folder) — those are for the actual content.
// They go in a per-target metadata dir instead, and any pre-existing copies are
// migrated out on first access.
function metaDir(kind, id) { return path.join(dataDir, "meta", kind, String(id)); }
function tabMetaFile(kind, id, tab, base) { return path.join(metaDir(kind, id), `${tab}.${base}`); }
function migrateMeta(oldPath, newPath) {
  try {
    if (fs.existsSync(oldPath)) {
      if (!fs.existsSync(newPath)) { fs.mkdirSync(path.dirname(newPath), { recursive: true }); fs.renameSync(oldPath, newPath); }
      else { try { fs.unlinkSync(oldPath); } catch { /* ignore */ } } // stale in-folder copy
    }
  } catch { /* best effort */ }
}

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
  const cacheFile = tabMetaFile("client", profileId, tab, "mods.json");
  migrateMeta(path.join(basePath, "mods.json"), cacheFile);

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
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
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

// A mod's own icon, as declared in its metadata. Fabric's "icon" is either a
// path or a { "<size>": "<path>" } map; Forge/NeoForge call it logoFile.
function fabricIconPath(icon) {
  if (typeof icon === "string") return icon;
  if (icon && typeof icon === "object") {
    // Biggest declared size wins - it gets scaled into a small cell anyway.
    const best = Object.keys(icon).map(Number).filter(n => !Number.isNaN(n)).sort((a, b) => b - a)[0];
    if (best != null) return icon[String(best)];
    const first = Object.values(icon)[0];
    if (typeof first === "string") return first;
  }
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
        return { name: q.metadata?.name || q.id || null, version: q.version || null, authors: jarAuthorsToString(q.metadata?.contributors), icon: fabricIconPath(q.metadata?.icon) };
      }
      return { name: j.name || j.id || null, version: j.version || null, authors: jarAuthorsToString(j.authors), icon: fabricIconPath(j.icon) };
    }
    const toml = zip.getEntry("META-INF/mods.toml") || zip.getEntry("META-INF/neoforge.mods.toml");
    if (toml) {
      const t = zip.readAsText(toml);
      const name = (t.match(/displayName\s*=\s*["'](.*?)["']/) || [])[1] || null;
      let version = (t.match(/\bversion\s*=\s*["'](.*?)["']/) || [])[1] || null;
      const authors = (t.match(/authors\s*=\s*["'](.*?)["']/) || [])[1] || null;
      const icon = (t.match(/logoFile\s*=\s*["'](.*?)["']/) || [])[1] || null;
      if (version && version.includes("${")) {
        const mf = zip.getEntry("META-INF/MANIFEST.MF");
        if (mf) {
          const mv = (zip.readAsText(mf).match(/Implementation-Version:\s*(.*)/) || [])[1];
          if (mv) version = mv.trim();
        }
      }
      return { name, version, authors, icon };
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

// Pull the icon out of a jar / pack zip and cache it beside the tab's index, so
// mods that aren't on Modrinth or CurseForge still show their own icon instead of
// a blank square. Returns the cached file's name, or null.
// The icon stays on disk rather than being inlined into the list: a big modpack
// would otherwise push megabytes of base64 through IPC on every refresh.
const JAR_ICON_FALLBACKS = ["icon.png", "pack.png", "logo.png", "mod_logo.png", "assets/icon.png"];
function extractJarIcon(jarPath, declared, outDir, key) {
  if (!key) return null;
  const outName = key + ".png";
  const abs = path.join(outDir, outName);
  try {
    if (fs.existsSync(abs)) return outName;
    const zip = new AdmZip(jarPath);
    const get = (n) => {
      if (!n || typeof n !== "string") return null;
      const e = zip.getEntry(String(n).replace(/^[./]+/, ""));
      return e && !e.isDirectory ? e : null;
    };
    let entry = get(declared);
    if (!entry) for (const n of JAR_ICON_FALLBACKS) { entry = get(n); if (entry) break; }
    // Fabric mods usually keep it at assets/<modid>/icon.png, and the mod id
    // isn't known for a jar with no readable metadata at all.
    if (!entry) entry = zip.getEntries().find(e => !e.isDirectory && /^assets\/[^/]+\/(icon|logo)\.png$/i.test(e.entryName)) || null;
    if (!entry) return null;
    const buf = entry.getData();
    if (!buf || !buf.length || buf.length > 2 * 1024 * 1024) return null;
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(abs, buf);
    return outName;
  } catch { return null; }
}

// Read a local image back as a data: URL. Content lists hand out file paths
// (cheap); anything that has to EMBED an icon - a server's serverinfo.json, a
// desktop shortcut - asks for the data URL of the one icon actually chosen.
// A small thumbnail of an image on disk. The icon picker was putting full-size
// screenshots (2-8 MB, often 4K) into 56px cells, which made opening it crawl.
const _iconThumbCache = new Map();
// ── Importing from other launchers ──────────────────────────────────────────
// Every one of these keeps its instances in a directory of per-instance folders
// with a small metadata file naming the Minecraft version and mod loader. The
// shapes differ; what they have in common is enough to build an instance from.
function launcherSearchRoots() {
  const home = app.getPath("home");
  const appData = process.platform === "win32"
    ? (process.env.APPDATA || path.join(home, "AppData", "Roaming"))
    : process.platform === "darwin"
      ? path.join(home, "Library", "Application Support")
      : path.join(home, ".local", "share");
  const cfg = process.platform === "linux" ? path.join(home, ".config") : appData;
  return { home, appData, cfg };
}

// ── The Modrinth App's database ─────────────────────────────────────────────
// Everything the Modrinth App knows -- instances, accounts, saved skins -- is
// in one SQLite file, app.db, and that file is NOT under the instances folder.
// From modrinth/code (packages/app-lib/src/state/db.rs and state/dirs.rs):
//
//   settings_dir = $THESEUS_CONFIG_DIR or dirs::data_dir()/<app identifier>
//   app.db       = settings_dir/app.db
//   instances    = (settings.custom_dir or settings_dir)/profiles
//
// and the app identifier is "ModrinthApp" (apps/app/tauri.conf.json). The
// instances folder is a *setting*, so anchoring the search on it -- which is
// what this used to do -- finds nothing at all whenever the user moved it, or
// whenever they have accounts and skins but no instances yet. Anchor on the
// database instead, and ask the database where the instances went.
function modrinthAppRoots() {
  const { home, appData } = launcherSearchRoots();
  const ids = ["ModrinthApp", "com.modrinth.theseus", "ModrinthAppDev"];
  const bases = [
    appData,
    path.join(home, ".local", "share"),
    path.join(home, ".var", "app", "com.modrinth.ModrinthApp", "data"),
    path.join(home, ".var", "app", "com.modrinth.ModrinthApp", "config"),
    path.join(home, "snap", "modrinth-app", "current", ".local", "share"),
    process.platform === "darwin" ? path.join(home, "Library", "Application Support") : null,
  ].filter(Boolean);
  const out = [];
  if (process.env.THESEUS_CONFIG_DIR) out.push(process.env.THESEUS_CONFIG_DIR);
  for (const b of bases) for (const id of ids) out.push(path.join(b, id));
  return out;
}

function modrinthDbPath() {
  for (const root of modrinthAppRoots()) {
    for (const n of ["app.db", "theseus.db", "data.db"]) {
      const p = path.join(root, n);
      try { if (fs.existsSync(p) && fs.statSync(p).size > 0) return p; } catch { /* next */ }
    }
  }
  return null;
}

// Open a read-only snapshot of the Modrinth App database and hand it to `fn`.
//
// The copy matters twice over. The app may be running and holding its own lock,
// and -- the part that was silently losing data -- the database is in WAL mode
// (db.rs: .journal_mode(SqliteJournalMode::Wal)). In WAL mode recent commits
// live in app.db-wal until a checkpoint folds them in, so copying app.db alone
// can hand back a database that is missing the newest accounts and skins, or,
// if it has never been checkpointed, everything. Copy the sidecars too.
function withModrinthDb(label, fn) {
  const dbPath = modrinthDbPath();
  if (!dbPath) return null;

  // node:sqlite is built in from Node 22, which Electron 41 ships, but guard
  // it: this file is ESM, so the require has to be built, and an older runtime
  // simply won't have the module.
  let DatabaseSync;
  try { ({ DatabaseSync } = createRequire(import.meta.url)("node:sqlite")); }
  catch { return null; }

  const tmp = path.join(app.getPath("temp"), `mr-${label}-${Date.now()}-${process.pid}.db`);
  const copies = [tmp];
  try {
    fs.copyFileSync(dbPath, tmp);
    for (const ext of ["-wal", "-shm"]) {
      try {
        if (fs.existsSync(dbPath + ext)) { fs.copyFileSync(dbPath + ext, tmp + ext); copies.push(tmp + ext); }
      } catch { /* without it we just see the last checkpoint */ }
    }
    // Not readOnly: replaying the WAL into the snapshot is a write, and a
    // read-only handle would refuse it and show stale rows instead. The
    // snapshot is a throwaway copy, so writing to it costs nothing.
    const db = new DatabaseSync(tmp);
    try { return fn(db); }
    finally { try { db.close(); } catch { /* ignore */ } }
  } catch (err) {
    devtoolsLog(`Could not read the Modrinth App database (${label}):`, err && err.message);
    return null;
  } finally {
    for (const f of [...copies, tmp + "-wal", tmp + "-shm"]) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }
}

const tableExistsIn = (db, name) => {
  try {
    return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
  } catch { return false; }
};
const columnsOf = (db, table) => {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name); }
  catch { return []; }
};

// Where the Modrinth App actually keeps its instances: settings.custom_dir if
// the user moved them, otherwise beside the database.
function modrinthInstancesDirs() {
  const dbPath = modrinthDbPath();
  const out = [];
  if (dbPath) {
    const custom = withModrinthDb("dir", (db) => {
      if (!tableExistsIn(db, "settings")) return null;
      if (!columnsOf(db, "settings").includes("custom_dir")) return null;
      const r = db.prepare("SELECT custom_dir FROM settings WHERE custom_dir IS NOT NULL").get();
      return r && r.custom_dir ? String(r.custom_dir) : null;
    });
    if (custom) out.push(path.join(custom, "profiles"));
    out.push(path.join(path.dirname(dbPath), "profiles"));
  }
  return out.filter(p => { try { return fs.existsSync(p); } catch { return false; } });
}

function knownLauncherPaths() {
  const { home, appData, cfg } = launcherSearchRoots();
  const many = (...xs) => xs.filter(Boolean);
  return {
    modrinth: many(
      // What the database says first -- it is the only answer that survives
      // the user moving their instances folder.
      ...modrinthInstancesDirs(),
      path.join(appData, "com.modrinth.theseus", "profiles"),
      path.join(appData, "ModrinthApp", "profiles"),
      path.join(home, ".local", "share", "ModrinthApp", "profiles"),
      path.join(home, ".local", "share", "com.modrinth.theseus", "profiles"),
      // Flatpak and Snap keep an app's home somewhere else entirely.
      path.join(home, ".var", "app", "com.modrinth.ModrinthApp", "data", "ModrinthApp", "profiles"),
      path.join(home, ".var", "app", "com.modrinth.ModrinthApp", "config", "ModrinthApp", "profiles"),
      path.join(home, "snap", "modrinth-app", "current", ".local", "share", "ModrinthApp", "profiles"),
      process.platform === "darwin" ? path.join(home, "Library", "Application Support", "ModrinthApp", "profiles") : null,
      process.platform === "darwin" ? path.join(home, "Library", "Application Support", "com.modrinth.theseus", "profiles") : null,
    ),
    curseforge: many(
      path.join(home, "curseforge", "minecraft", "Instances"),
      path.join(home, "Documents", "curseforge", "minecraft", "Instances"),
      path.join(appData, "CurseForge", "minecraft", "Instances"),
    ),
    prism: many(
      path.join(appData, "PrismLauncher", "instances"),
      path.join(cfg, "PrismLauncher", "instances"),
      path.join(home, ".local", "share", "PrismLauncher", "instances"),
    ),
    multimc: many(
      path.join(home, "MultiMC", "instances"),
      path.join(appData, "MultiMC", "instances"),
      path.join(home, ".local", "share", "multimc", "instances"),
    ),
    vanilla: many(
      process.platform === "win32" ? path.join(appData, ".minecraft") : null,
      process.platform === "darwin" ? path.join(home, "Library", "Application Support", "minecraft") : null,
      process.platform === "linux" ? path.join(home, ".minecraft") : null,
    ),
    lunar: lunarRoots(),
  };
}

// ── Lunar Client ────────────────────────────────────────────────────────────
// Lunar keeps everything under a single .lunarclient folder in the user's home
// directory on every platform (its own support pages give
// %USERPROFILE%\.lunarclient and ~/.lunarclient), with the client jars in
// offline/ and the signed-in accounts in settings/game/accounts.json. Some
// Windows installs put it under %APPDATA% instead, and the Flatpak build keeps
// its own home, so all of those are tried.
//
// It is not a launcher with instance folders: one Minecraft directory serves
// every version, which is why this is handled separately from the scanners
// that walk a folder of instances.
function lunarRoots() {
  const { home, appData } = launcherSearchRoots();
  return [
    path.join(home, ".lunarclient"),
    path.join(appData, ".lunarclient"),
    path.join(home, ".var", "app", "com.lunarclient.LunarClient", "data", ".lunarclient"),
    path.join(home, ".var", "app", "com.lunarclient.LunarClient", ".lunarclient"),
  ].filter((p, i, a) => a.indexOf(p) === i);
}

const lunarRoot = () => lunarRoots().find(p => { try { return fs.existsSync(p); } catch { return false; } }) || null;

// Which Minecraft directory Lunar actually plays out of. By default it is the
// vanilla one — Lunar does not keep its own saves, servers or resource packs —
// but the launcher lets that be changed per version, so a game directory
// sitting inside .lunarclient wins if there is one.
function lunarGameDirs() {
  const out = [];
  const root = lunarRoot();
  const looksPlayed = (d) => {
    try {
      return ["saves", "servers.dat", "options.txt", "resourcepacks", "config"]
        .some(n => fs.existsSync(path.join(d, n)));
    } catch { return false; }
  };
  if (root) {
    for (const sub of ["minecraft", ".minecraft", "game"]) {
      const d = path.join(root, sub);
      if (fs.existsSync(d) && looksPlayed(d)) out.push(d);
    }
  }
  const vanilla = lunarVanillaDirs().find(p => p && fs.existsSync(p) && looksPlayed(p));
  if (vanilla) out.push(vanilla);
  return out;
}

// The vanilla .minecraft candidates, without going through knownLauncherPaths()
// — which calls lunarRoots() and would recurse.
function lunarVanillaDirs() {
  const { home, appData } = launcherSearchRoots();
  return [
    process.platform === "win32" ? path.join(appData, ".minecraft") : null,
    process.platform === "darwin" ? path.join(home, "Library", "Application Support", "minecraft") : null,
    process.platform === "linux" ? path.join(home, ".minecraft") : null,
  ].filter(Boolean);
}

// Lunar's mod profiles. These are named sets of Lunar's own mod settings and
// live in <gameDir>/config/lunar/profile_manager.json, each entry carrying the
// folder `name` and the `displayName` the launcher shows. They share one game
// directory, so they are names for an instance rather than separate ones.
function lunarProfileNames(gameDir) {
  const f = path.join(gameDir, "config", "lunar", "profile_manager.json");
  try {
    if (!fs.existsSync(f)) return [];
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    const list = Array.isArray(j) ? j : (j.profiles || j.profileList || []);
    return list
      .map(p => (p && (p.displayName || p.name)) || null)
      .filter(Boolean);
  } catch { return []; }
}

// The Minecraft versions Lunar has actually downloaded. offline/ holds one
// folder per client branch — some are versions ("1.8", "1.21"), and "multiver"
// is the combined build that is not a version at all, so only the ones that
// parse as a Minecraft version are offered.
function lunarVersions(root) {
  const dir = path.join(root, "offline");
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); }
  catch { return []; }
  const out = [];
  for (const n of names) {
    const m = String(n).match(/^(\d+\.\d+(?:\.\d+)?)$/);
    if (m) out.push(m[1]);
  }
  return out.sort(loaderCompareVersions);
}

// What there is to import from Lunar: one entry per Minecraft version it has
// downloaded, all playing out of the same directory. If none of the folder
// names parse as a version (Lunar has moved most of its builds into a single
// "multiver" one), the directory still knows what it last ran, so fall back to
// the same sniffing every other unknown launcher gets.
function lunarInstances() {
  const root = lunarRoot();
  if (!root) return [];
  const gameDirs = lunarGameDirs();
  if (!gameDirs.length) return [];
  const gameDir = gameDirs[0];

  const profiles = lunarProfileNames(gameDir);
  const label = profiles.length === 1 ? ` (${profiles[0]})` : "";
  const out = [];

  for (const version of lunarVersions(root)) {
    out.push({
      kind: "lunar", dir: gameDir, gameDir,
      icon: null,
      name: `Lunar Client ${version}${label}`,
      version, loader: "vanilla", loaderVersion: "",
      versionFrom: "lunar",
    });
  }
  if (!out.length) {
    const sniffed = sniffInstanceVersion(gameDir);
    out.push({
      kind: "lunar", dir: gameDir, gameDir,
      icon: null,
      name: `Lunar Client${label}`,
      version: sniffed && sniffed.version,
      loader: "vanilla", loaderVersion: "",
      versionUnknown: !(sniffed && sniffed.version),
      versionFrom: sniffed ? sniffed.from : null,
    });
  }
  return out;
}

// Prism/MultiMC record the loader as a "component" list in mmc-pack.json.
function readMmcPack(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, "mmc-pack.json"), "utf8"));
    const comps = j.components || [];
    const find = (uid) => comps.find(c => c.uid === uid);
    const mc = find("net.minecraft");
    const map = {
      "net.minecraftforge": "forge",
      "net.neoforged": "neoforge",
      "net.fabricmc.fabric-loader": "fabric",
      "org.quiltmc.quilt-loader": "quilt",
    };
    let loader = "vanilla", loaderVersion = "";
    for (const [uid, name] of Object.entries(map)) {
      const c = find(uid);
      if (c) { loader = name; loaderVersion = c.version || ""; break; }
    }
    return { version: mc && mc.version, loader, loaderVersion };
  } catch { return null; }
}

function readIniName(file) {
  try {
    const txt = fs.readFileSync(file, "utf8");
    const m = txt.match(/^name=(.*)$/m);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

// The Modrinth App's profile metadata, out of its SQLite database.
//
// Older versions wrote a profile.json into each instance folder; current ones
// keep everything in app.db, so without this the importer finds a pile of
// folders it can say nothing about. Every failure is non-fatal — if the schema
// has moved on, the caller falls back to whatever the folders themselves
// reveal.
function modrinthDbProfiles(_profilesRoot) {
  return withModrinthDb("scan", (db) => readProfileRows(db));
}

// Read the Modrinth App's instance list out of its database.
//
// This is NOT guesswork: it follows modrinth/code (packages/app-lib/migrations).
// The schema was reorganised, so there are two shapes to handle.
//
//   Before 20260611 "instances-content-foundation":
//     profiles(path, name, icon_path, game_version, mod_loader, mod_loader_version)
//
//   After it:
//     instances(id, path, applied_content_set_id, name, icon_path, ...)
//     instance_content_sets(id, instance_id, game_version, loader, loader_version, ...)
//   — the version and loader moved OUT of the instance row entirely, into the
//     content set the instance currently has applied. Reading only the instance
//     row therefore finds a name and nothing else, which is exactly why the
//     version and loader kept coming back missing or wrong.
//
// `path` is relative to the app's instances dir (api/instance/paths.rs joins it
// onto instances_dir()), so it is the folder name — which is how the scanner
// keys these.
function readProfileRows(db) {
  const tableExists = (name) => !!db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
  ).get(name);

  let rows = [];
  if (tableExists("instances") && tableExists("instance_content_sets")) {
    rows = db.prepare(`
      SELECT i.path AS path, i.name AS name, i.icon_path AS icon_path,
             cs.game_version AS game_version,
             cs.loader AS loader,
             cs.loader_version AS loader_version
      FROM instances i
      LEFT JOIN instance_content_sets cs ON cs.id = i.applied_content_set_id
    `).all();
    // An instance with no applied content set still has a name and an icon;
    // take whatever content set it does have rather than reporting nothing.
    const missing = rows.filter(r => !r.game_version).map(r => r.path);
    if (missing.length) {
      const fallback = db.prepare(`
        SELECT i.path AS path, cs.game_version AS game_version,
               cs.loader AS loader, cs.loader_version AS loader_version
        FROM instances i
        JOIN instance_content_sets cs ON cs.instance_id = i.id
        ORDER BY cs.modified DESC
      `).all();
      const byPath = new Map();
      for (const f of fallback) if (!byPath.has(f.path)) byPath.set(f.path, f);
      rows = rows.map(r => r.game_version ? r : { ...r, ...(byPath.get(r.path) || {}) });
    }
  } else if (tableExists("profiles")) {
    rows = db.prepare(`
      SELECT path, name, icon_path,
             game_version,
             mod_loader AS loader,
             mod_loader_version AS loader_version
      FROM profiles
    `).all();
  } else {
    return null;
  }

  const out = {};
  for (const row of rows) {
    const key = String(row.path || "");
    if (!key) continue;
    const entry = {
      name: row.name || null,
      version: row.game_version || null,
      loader: String(row.loader || "vanilla").toLowerCase(),
      loaderVersion: row.loader_version || "",
      iconPath: row.icon_path || null,
    };
    // Keyed both by the stored path and by its last segment, since the scanner
    // walks folder names.
    out[key] = entry;
    out[path.basename(key)] = entry;
  }
  return Object.keys(out).length ? out : null;
}

function scanLauncher(kind, root, dbProfiles) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return out; }

  for (const d of dirs) {
    const dir = path.join(root, d.name);
    try {
      if (kind === "prism" || kind === "multimc") {
        const pack = readMmcPack(dir);
        if (!pack || !pack.version) continue;
        // The playable files live in .minecraft (Prism) or minecraft (MultiMC).
        const sub = ["minecraft", ".minecraft"].map(s => path.join(dir, s)).find(p => fs.existsSync(p));
        out.push({
          kind, dir, gameDir: sub || dir,
          icon: mmcIcon(dir, root),
          name: readIniName(path.join(dir, "instance.cfg")) || d.name,
          version: pack.version, loader: pack.loader, loaderVersion: pack.loaderVersion,
        });
      } else if (kind === "curseforge") {
        const f = path.join(dir, "minecraftinstance.json");
        if (!fs.existsSync(f)) continue;
        const j = JSON.parse(fs.readFileSync(f, "utf8"));
        const mc = j.baseModLoader || {};
        const { loader, loaderVersion } = loaderFromCurseId(mc.name, j.gameVersion);
        out.push({
          kind, dir,
          icon: curseforgeIcon(dir), gameDir: dir,
          name: j.name || d.name,
          version: j.gameVersion || mc.minecraftVersion,
          loader: loader || "vanilla", loaderVersion: loaderVersion || "",
        });
      } else if (kind === "modrinth") {
        // Older Theseus wrote a profile.json beside the instance files; current
        // versions keep all of that in a central SQLite database instead, which
        // is why nothing was being found here. Read the file when it exists,
        // and otherwise take what the database said (looked up once, above).
        const f = ["profile.json", "instance.json"].map(n => path.join(dir, n)).find(p => fs.existsSync(p));
        if (f) {
          const j = JSON.parse(fs.readFileSync(f, "utf8"));
          const meta = j.metadata || j;
          const lv = meta.loader_version || {};
          out.push({
            kind, dir, gameDir: dir,
            icon: modrinthIcon(j.icon_path || meta.icon_path, dir),
            name: meta.name || j.name || d.name,
            version: meta.game_version || j.game_version,
            loader: (meta.loader || "vanilla").toLowerCase(),
            loaderVersion: lv.id || lv.version || "",
          });
          continue;
        }
        const fromDb = (dbProfiles && (dbProfiles[d.name] || dbProfiles[dir])) || null;
        const looksLikeAnInstance = ["mods", "config", "saves", "options.txt", "resourcepacks"]
          .some(n => fs.existsSync(path.join(dir, n)));
        if (!fromDb && !looksLikeAnInstance) continue;
        // No database row either? The instance still knows what it is — its own
        // log says which Minecraft and which loader it last ran, and any world
        // records the version that wrote it. Giving up here is what produced a
        // list of instances that couldn't be selected.
        const sniffed = (fromDb && fromDb.version) ? null : sniffInstanceVersion(dir);
        const version = (fromDb && fromDb.version) || (sniffed && sniffed.version) || null;
        // The loader is worked out separately from the version: the database
        // may answer one and not the other, and the log line that gives the
        // version only names the loader for Fabric-family launches. A modpack
        // coming through as "vanilla" is wrong in a way that breaks the
        // imported instance, so fall back to reading the files.
        let loader = (fromDb && fromDb.loader) || (sniffed && sniffed.loader) || null;
        if (!loader || loader === "vanilla") loader = sniffInstanceLoader(dir) || loader || "vanilla";
        out.push({
          kind, dir, gameDir: dir,
          icon: modrinthIcon(fromDb && fromDb.iconPath, dir),
          name: (fromDb && fromDb.name) || d.name,
          version,
          loader,
          loaderVersion: (fromDb && fromDb.loaderVersion) || (sniffed && sniffed.loaderVersion) || "",
          versionUnknown: !version,
          versionFrom: sniffed ? sniffed.from : (fromDb ? "database" : null),
        });
      }
    } catch { /* an unreadable instance is skipped, not fatal */ }
  }
  // Keep the ones whose version we could not work out; the import modal
  // asks for it rather than pretending the instance isn't there.
  return out.filter(i => i.version || i.versionUnknown);
}

// ── Instance icons from other launchers ─────────────────────────────────────
// Every launcher keeps these somewhere different, and none of them in the
// instance folder under a predictable name — which is why none were coming
// through. Each case below follows what that launcher actually does.
const ICON_EXTS = ["", ".png", ".jpg", ".jpeg", ".webp"];

function iconFileToDataUrl(file) {
  try {
    if (!file || !fs.existsSync(file)) return null;
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 2 * 1024 * 1024) return null;
    const ext = path.extname(file).toLowerCase();
    const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
      : ext === ".webp" ? "image/webp" : "image/png";
    return `data:${mime};base64,` + fs.readFileSync(file).toString("base64");
  } catch { return null; }
}

// Try a path with and without the usual extensions — Prism's iconKey sometimes
// carries one and sometimes doesn't.
function iconFromBase(base) {
  for (const ext of ICON_EXTS) {
    const d = iconFileToDataUrl(base + ext);
    if (d) return d;
  }
  return null;
}

// Prism / MultiMC: instance.cfg names an iconKey, and the file lives in the
// launcher's shared icons folder (mmc.rs: mmc_base_path.join("icons").join(key)).
// The built-in keys have no file of their own, so fall back to anything the
// instance itself carries.
function mmcIcon(instanceDir, instancesRoot) {
  let key = null;
  try {
    const txt = fs.readFileSync(path.join(instanceDir, "instance.cfg"), "utf8");
    const m = txt.match(/^iconKey=(.*)$/m);
    if (m) key = m[1].trim();
  } catch { /* no cfg */ }
  if (key && key !== "default") {
    const base = path.dirname(instancesRoot);   // instances/ sits beside icons/
    const d = iconFromBase(path.join(base, "icons", key));
    if (d) return d;
  }
  for (const rel of ["icon.png", ".minecraft/icon.png", "minecraft/icon.png"]) {
    const d = iconFileToDataUrl(path.join(instanceDir, rel));
    if (d) return d;
  }
  return null;
}

// CurseForge writes minecraftinstance.json next to the game files; the pack art
// is a URL on their CDN rather than a local file.
function curseforgeIcon(instanceDir) {
  try {
    const f = path.join(instanceDir, "minecraftinstance.json");
    if (!fs.existsSync(f)) return null;
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    const url = (j.installedModpack && (j.installedModpack.thumbnailUrl
      || (j.installedModpack.addonID && j.installedModpack.iconUrl)))
      || j.thumbnailUrl || null;
    return url || null;
  } catch { return null; }
}

// The vanilla launcher stores the icon ON the profile: either a data URL for a
// custom one, or the name of a built-in block (which has no file to read).
function vanillaIcon(p) {
  const icon = p && p.icon;
  if (typeof icon === "string" && icon.startsWith("data:image/")) return icon;
  return null;
}

// The Modrinth App records an icon_path in its database.
function modrinthIcon(iconPath, instanceDir) {
  if (!iconPath) return null;
  const direct = iconFileToDataUrl(iconPath);
  if (direct) return direct;
  // Some rows store it relative to the instance.
  return iconFileToDataUrl(path.join(instanceDir, iconPath));
}

function sniffInstanceLoader(dir) {
  // 1. Marks the loader itself leaves in the instance folder.
  const marks = [
    [".fabric", "fabric"],
    ["quilt", "quilt"],
    ["config/fabric", "fabric"],
  ];
  for (const [rel, loader] of marks) {
    try { if (fs.existsSync(path.join(dir, rel))) return loader; } catch { /* next */ }
  }

  // 2. What the mods themselves say. One jar is enough, but check a few in
  //    case the first is a resource-only pack with no metadata.
  const modsDir = path.join(dir, "mods");
  let jars = [];
  try {
    jars = fs.readdirSync(modsDir).filter(f => /\.jar$/i.test(f)).slice(0, 8);
  } catch { return null; }

  const votes = { fabric: 0, quilt: 0, neoforge: 0, forge: 0 };
  for (const j of jars) {
    try {
      const zip = new AdmZip(path.join(modsDir, j));
      // neoforge.mods.toml is NeoForge-only; mods.toml is Forge's (and
      // NeoForge still ships one for compatibility, so check the specific
      // file first).
      if (zip.getEntry("META-INF/neoforge.mods.toml")) votes.neoforge++;
      else if (zip.getEntry("META-INF/mods.toml")) votes.forge++;
      if (zip.getEntry("quilt.mod.json")) votes.quilt++;
      else if (zip.getEntry("fabric.mod.json")) votes.fabric++;
    } catch { /* unreadable jar */ }
  }
  const best = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 0 ? best[0] : null;
}

// Work out an instance's Minecraft version from the instance itself, for
// launchers that don't record it anywhere we can read. Cheapest first.
function sniffInstanceVersion(dir) {
  // 1. The game writes what it is into the first lines of its own log.
  for (const rel of ["logs/latest.log", "logs/debug.log"]) {
    try {
      const f = path.join(dir, rel);
      if (!fs.existsSync(f)) continue;
      const head = fs.readFileSync(f, "utf8").slice(0, 20000);
      // "Loading Minecraft 1.20.1 with Fabric Loader 0.16.14"
      let m = /Loading Minecraft (\S+) with (\w+) Loader (\S+)/i.exec(head);
      if (m) return { version: m[1], loader: m[2].toLowerCase(), loaderVersion: m[3], from: "log" };
      // "Minecraft Version: 1.20.1" / "--version, 1.20.1"
      m = /Minecraft Version: (\S+)/i.exec(head) || /--version,\s*(\S+?),/.exec(head);
      if (m) return { version: m[1], from: "log" };
    } catch { /* unreadable: try the next source */ }
  }
  // 2. Any world records the exact version that last wrote it.
  try {
    const saves = path.join(dir, "saves");
    if (fs.existsSync(saves)) {
      for (const w of fs.readdirSync(saves).slice(0, 12)) {
        const lvl = path.join(saves, w, "level.dat");
        if (!fs.existsSync(lvl)) continue;
        const buf = fs.readFileSync(lvl);
        // Read the Name string out of the Version compound without a full NBT
        // parse: level.dat is gzipped, so inflate and scan.
        let raw;
        try { raw = zlib.gunzipSync(buf); } catch { raw = buf; }
        const txt = raw.toString("latin1");
        const i = txt.indexOf("Name");
        if (i < 0) continue;
        const m = /(\d+\.\d+(?:\.\d+)?|\d{2}w\d{2}[a-z])/.exec(txt.slice(i, i + 64));
        if (m) return { version: m[1], from: "world" };
      }
    }
  } catch { /* ignore */ }
  return null;
}

// ── The vanilla launcher's installations ────────────────────────────────────
// `lastVersionId` is the name of a folder under versions/, NOT a Minecraft
// version. It is "1.20.1" for a plain install but
// "fabric-loader-0.16.14-1.20.1", "1.12.2-forge-14.23.5.2860",
// "1.19.2-forge-43.1.1", "neoforge-21.1.169" or
// "vivecraft-1.19.2-jrbudda-VR-2-b8" for anything modded. Importing that string
// as the Minecraft version produced an instance that could not launch.
//
// The version's own JSON answers this properly: `inheritsFrom` is the real
// Minecraft version, and the libraries say which loader it is. The id is only
// parsed when that file is missing.
function loaderFromVersionJson(json) {
  const libs = (json.libraries || []).map(l => String(l.name || ""));
  const find = (prefix) => libs.find(n => n.startsWith(prefix));
  const verOf = (n) => (n ? String(n).split(":")[2] || "" : "");
  let hit;
  if ((hit = find("net.fabricmc:fabric-loader"))) return { loader: "fabric", loaderVersion: verOf(hit) };
  if ((hit = find("org.quiltmc:quilt-loader"))) return { loader: "quilt", loaderVersion: verOf(hit) };
  if ((hit = find("net.neoforged:neoforge")) || (hit = find("net.neoforged.fancymodloader"))) {
    return { loader: "neoforge", loaderVersion: verOf(hit) };
  }
  if ((hit = find("net.minecraftforge:forge")) || (hit = find("net.minecraftforge:fmlloader"))) {
    // Forge's maven version is "<mc>-<forge>"; the instance stores the Forge part.
    const v = verOf(hit);
    const dash = v.indexOf("-");
    return { loader: "forge", loaderVersion: dash > 0 ? v.slice(dash + 1) : v };
  }
  return { loader: "vanilla", loaderVersion: "" };
}

// A Minecraft version number: 1.20.1, 1.21, 24w14a, 1.21-rc1, 25w03b…
const MC_VERSION_RE = /(\d+\.\d+(?:\.\d+)?(?:-(?:pre|rc)\d+)?|\d{2}w\d{2}[a-z])/;

function parseVanillaVersionId(id) {
  const raw = String(id || "");
  // "fabric-loader-<loader>-<mc>" / "quilt-loader-<loader>-<mc>"
  let m = /^(fabric|quilt)-loader-(.+?)-(.+)$/.exec(raw);
  if (m) return { version: m[3], loader: m[1], loaderVersion: m[2] };
  // "<mc>-forge-<forge>" and the older "<mc>-forge<mc>-<forge>"
  m = /^(.+?)-forge-?(.*)$/i.exec(raw);
  if (m && MC_VERSION_RE.test(m[1])) {
    return { version: m[1], loader: "forge", loaderVersion: (m[2] || "").replace(/^.*?-/, "") || m[2] || "" };
  }
  // "neoforge-21.1.169" — the id carries no Minecraft version at all, so this
  // one really does need the version JSON; 21.1.x means 1.21.1.
  m = /^neoforge-(\d+)\.(\d+)\./.exec(raw);
  if (m) return { version: `1.${m[1]}.${m[2]}`, loader: "neoforge", loaderVersion: raw.slice("neoforge-".length) };
  // Anything else with a version in it — vivecraft, optifine, a custom build.
  const any = MC_VERSION_RE.exec(raw);
  if (any && any[1] !== raw) return { version: any[1], loader: "vanilla", loaderVersion: "", approximate: true };
  return { version: raw, loader: "vanilla", loaderVersion: "" };
}

function readVanillaVersion(root, id) {
  const file = path.join(root, "versions", String(id), `${id}.json`);
  try {
    if (fs.existsSync(file)) {
      const j = JSON.parse(fs.readFileSync(file, "utf8"));
      const { loader, loaderVersion } = loaderFromVersionJson(j);
      // inheritsFrom is set on every modded version; a plain one IS the version.
      const version = j.inheritsFrom || j.id || id;
      if (MC_VERSION_RE.test(version)) return { version, loader, loaderVersion, jarId: id };
    }
  } catch { /* fall through to parsing the id */ }
  return { ...parseVanillaVersionId(id), jarId: id };
}

async function vanillaProfiles(root) {
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(root, "launcher_profiles.json"), "utf8")); }
  catch { return []; }

  // "Latest Release" and "Latest Snapshot" are real installations people use —
  // they were being dropped, which is why snapshot installs never appeared.
  let latest = null;
  const needLatest = Object.values(j.profiles || {}).some(p => /^latest-/.test(String(p.lastVersionId || "")));
  if (needLatest) {
    try {
      const r = await fetch("https://launchermeta.mojang.com/mc/game/version_manifest_v2.json");
      if (r.ok) latest = (await r.json()).latest || null;
    } catch { /* offline: those rows are skipped below */ }
  }

  const out = [];
  for (const [id, p] of Object.entries(j.profiles || {})) {
    const vid = String(p.lastVersionId || "");
    if (!vid) continue;
    let info;
    if (/^latest-/.test(vid)) {
      const want = vid === "latest-snapshot" ? (latest && latest.snapshot) : (latest && latest.release);
      if (!want) continue;   // couldn't resolve it
      info = { version: want, loader: "vanilla", loaderVersion: "", jarId: want };
    } else {
      info = readVanillaVersion(root, vid);
    }
    // An unnamed installation falls back to the key of the profiles object,
    // which is a 32-character hash. Describe it instead.
    const auto = vid === "latest-release" ? "Latest Release"
      : vid === "latest-snapshot" ? "Latest Snapshot"
        : `${info.loader !== "vanilla" ? titleOfLoader(info.loader) + " " : ""}${info.version}`;
    out.push({
      kind: "vanilla",
      dir: root,
      gameDir: p.gameDir || root,
      icon: vanillaIcon(p),
      name: (p.name || "").trim() || auto,
      version: info.version,
      loader: info.loader,
      loaderVersion: info.loaderVersion || "",
      // So the import can bring the version folder across rather than making
      // the launcher download what is already on this machine.
      versionId: info.jarId,
      versionRoot: root,
      approximate: !!info.approximate,
    });
  }
  return out.filter(p => p.version);
}

const titleOfLoader = (l) => ({ fabric: "Fabric", quilt: "Quilt", forge: "Forge", neoforge: "NeoForge" })[l] || "";

// What's on this machine. Nothing is copied here — this only looks.
ipcMain.handle("import:scan", async () => {
  const paths = knownLauncherPaths();
  const found = {};
  for (const [kind, roots] of Object.entries(paths)) {
    if (kind === "vanilla") {
      const root = roots.find(r => r && fs.existsSync(r));
      if (!root) continue;
      // The vanilla launcher has profiles, not instance folders.
      const profiles = await vanillaProfiles(root);
      if (profiles.length) found.vanilla = { root, instances: profiles };
      continue;
    }
    if (kind === "lunar") {
      // Lunar has no instance folders either: one Minecraft directory serves
      // every version it has downloaded.
      const root = lunarRoot();
      if (!root) continue;
      const list = lunarInstances();
      if (list.length) found.lunar = { root, instances: list };
      continue;
    }
    for (const root of roots) {
      // The Modrinth App keeps its metadata in a database beside the profiles
      // folder rather than in each instance.
      const dbProfiles = kind === "modrinth" ? modrinthDbProfiles(root) : null;
      const list = scanLauncher(kind, root, dbProfiles);
      if (list.length) { found[kind] = { root, instances: list }; break; }
    }
  }
  return found;
});

// ── Accounts from other launchers ───────────────────────────────────────────
// Signing in again for every launcher you have installed is busywork when the
// tokens are already sitting on disk. Prism/MultiMC and the vanilla launcher
// keep them in plain JSON; the Modrinth App keeps them in its database.
//
// A refresh token is what actually matters — an access token is good for an
// hour, a refresh token keeps the account signed in — so an account without
// one is still offered, but marked, because it will need a real sign-in soon.
function accountsFromPrism(root) {
  const file = path.join(root, "accounts.json");
  if (!fs.existsSync(file)) return [];
  let j;
  try { j = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return []; }
  const out = [];
  for (const a of j.accounts || []) {
    const profile = a.profile || {};
    if (!profile.name) continue;
    const msa = a.msa || {};
    const ygg = a.ygg || {};
    out.push({
      source: "prism",
      username: profile.name,
      uuid: profile.id || null,
      accessToken: ygg.token || msa.access_token || null,
      refreshToken: msa.refresh_token || null,
      offline: String(a.type || "").toLowerCase() === "offline",
    });
  }
  return out;
}

// The Minecraft launcher's launcher_accounts.json, and Lunar Client's
// settings/game/accounts.json, are the same shape: an `accounts` map keyed by
// local id, each entry carrying `accessToken`, `localId` and a
// `minecraftProfile` of { id, name }. Lunar reuses Mojang's launcher format,
// so one reader covers both.
function accountsFromLauncherJson(file, source) {
  if (!fs.existsSync(file)) return [];
  let j;
  try { j = JSON.parse(fs.readFileSync(file, "utf8")); } catch (err) {
    devtoolsLog(`Could not read ${source} accounts:`, err && err.message);
    return [];
  }
  const out = [];
  for (const a of Object.values(j.accounts || {})) {
    const profile = a.minecraftProfile || {};
    const name = profile.name || a.username;
    if (!name) continue;
    // Lunar stores offline ("cracked") accounts in the same file, and marks
    // them by giving the access token the account's own UUID instead of a real
    // one. A token that is just a UUID is not a session.
    const token = a.accessToken || null;
    const tokenIsUuid = !!token && /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(token);
    out.push({
      source,
      username: name,
      uuid: profile.id || a.localId || null,
      accessToken: tokenIsUuid ? null : token,
      // Neither launcher keeps a refresh token here — the Minecraft launcher
      // puts its one in the OS credential store — so there is nothing to carry
      // over and the account will need signing in again.
      refreshToken: null,
      offline: tokenIsUuid || !token,
    });
  }
  devtoolsLog(`${source} accounts: ${out.length} found in ${path.basename(file)}`);
  return out;
}

function accountsFromVanilla(root) {
  return accountsFromLauncherJson(path.join(root, "launcher_accounts.json"), "vanilla");
}

function accountsFromLunar(root) {
  return accountsFromLauncherJson(path.join(root, "settings", "game", "accounts.json"), "lunar");
}

// minecraft_users(uuid, active, username, access_token, refresh_token, expires)
// — straight out of packages/app-lib/migrations. The column names are still
// probed rather than assumed, so a rename does not take the whole scan down.
function accountsFromModrinth() {
  return withModrinthDb("acc", (db) => {
    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('minecraft_users','users','accounts')"
    ).get();
    if (!table) { devtoolsLog("Modrinth App database has no accounts table"); return []; }
    const cols = columnsOf(db, table.name);
    const pick = (...w) => w.find(x => cols.includes(x)) || null;
    const cName = pick("username", "name");
    const cUuid = pick("uuid", "id");
    const cAccess = pick("access_token", "accessToken", "token");
    const cRefresh = pick("refresh_token", "refreshToken");
    if (!cName) { devtoolsLog(`Modrinth App ${table.name} has no username column:`, cols.join(",")); return []; }
    const rows = db.prepare(`SELECT * FROM ${table.name}`).all();
    devtoolsLog(`Modrinth App ${table.name}: ${rows.length} row(s)`);
    return rows.map(r => ({
      source: "modrinth",
      username: r[cName],
      uuid: cUuid ? r[cUuid] : null,
      accessToken: cAccess ? r[cAccess] : null,
      refreshToken: cRefresh ? r[cRefresh] : null,
      offline: false,
    })).filter(a => a.username);
  }) || [];
}

// The account the skin library belongs to right now.
async function currentAccountUuid() {
  try {
    const id = storage.get("selectedPlayerId", null);
    const players = await loadPlayers();
    const p = players.find(x => String(x.id) === String(id)) || players[0];
    if (!p) return null;
    return String((p.auth && p.auth.uuid) || p.uuid || p.id || "").replace(/-/g, "") || null;
  } catch { return null; }
}

// Same bookkeeping as the skins:add handler, callable from inside the main
// process rather than only over IPC.
async function addSkinToLibrary(uuid, { base64, variant, name }) {
  const b = String(base64 || "").replace(/^data:image\/\w+;base64,/, "");
  if (!b || !uuid) return false;
  const pixelHash = await skinPixelHash(b);
  const lib = loadSkinLib();
  const arr = lib[uuid] || [];
  if (arr.some(x => x.pixelHash === pixelHash)) return false;   // already there
  arr.unshift({
    id: Date.now() + arr.length, pixelHash, name: name || "Skin", base64: b,
    variant: variant || "classic", addedAt: Date.now(), editorType: "advanced",
    creatorState: null, layerState: null,
  });
  lib[uuid] = arr;
  saveSkinLib(lib);
  scheduleSkinSync();
  return true;
}

// ── Skins from other launchers ──────────────────────────────────────────────
// Most launchers keep a local skin library, and re-adding every skin by hand
// after importing the account is exactly the kind of busywork importing is
// supposed to remove.
//
// None of them keeps those skins as loose PNG files, which is why scanning for
// loose PNG files found nothing:
//
//   Modrinth App  — PNG blobs in app.db (custom_minecraft_skin_textures.texture,
//                   joined to custom_minecraft_skins for the model variant)
//   Minecraft     — base64 data URLs in .minecraft/launcher_custom_skins.json
//   Prism/MultiMC — no skin library at all
//
// Loose-PNG scanning is kept as a last resort for anything that does write
// files, but it is no longer the only thing tried.
function skinsFromDir(dir, source, limit = 200) {
  const out = [];
  if (!dir || !fs.existsSync(dir)) return out;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const n of names.slice(0, limit)) {
    if (!/\.png$/i.test(n)) continue;
    const f = path.join(dir, n);
    try {
      const st = fs.statSync(f);
      // A skin is 64x64 (or the old 64x32) and tiny. Anything big is a
      // screenshot or a cached avatar sheet that wandered in.
      if (!st.isFile() || st.size > 200 * 1024) continue;
      const buf = fs.readFileSync(f);
      if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50) continue;
      // PNG dimensions live at bytes 16..24.
      const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
      if (w !== 64 || (h !== 64 && h !== 32)) continue;
      out.push({
        source,
        name: n.replace(/\.png$/i, ""),
        base64: buf.toString("base64"),
      });
    } catch { /* skip this file */ }
  }
  return out;
}

// The Modrinth App's saved skins. The texture is a PNG blob in the database --
// see packages/app-lib/migrations/20250413162050_skin-selector.sql:
//
//   custom_minecraft_skin_textures(texture_key TEXT PRIMARY KEY, texture BLOB)
//   custom_minecraft_skins(minecraft_user_uuid, texture_key, variant, cape_id,
//                          display_order)
//
// `variant` is 'CLASSIC' | 'SLIM' | 'UNKNOWN' and there is no name column, so
// the skins are named by the account they belong to. display_order only exists
// from migration 20260609, hence the probe.
function skinsFromModrinthDb() {
  return withModrinthDb("skins", (db) => {
    if (!tableExistsIn(db, "custom_minecraft_skin_textures")) {
      devtoolsLog("Modrinth App database has no saved-skin tables");
      return [];
    }
    const hasJoin = tableExistsIn(db, "custom_minecraft_skins");
    const hasOrder = hasJoin && columnsOf(db, "custom_minecraft_skins").includes("display_order");
    const names = new Map();
    if (tableExistsIn(db, "minecraft_users")) {
      try {
        for (const u of db.prepare("SELECT uuid, username FROM minecraft_users").all()) {
          names.set(String(u.uuid).replace(/-/g, "").toLowerCase(), u.username);
        }
      } catch { /* names are a nicety */ }
    }

    let rows;
    if (hasJoin) {
      rows = db.prepare(`
        SELECT t.texture AS texture, s.variant AS variant,
               s.minecraft_user_uuid AS uuid
        FROM custom_minecraft_skins s
        JOIN custom_minecraft_skin_textures t ON t.texture_key = s.texture_key
        ORDER BY ${hasOrder ? "s.display_order ASC, " : ""}s.rowid ASC`).all();
    } else {
      // The textures table on its own still holds every skin's pixels.
      rows = db.prepare("SELECT texture FROM custom_minecraft_skin_textures").all();
    }
    devtoolsLog(`Modrinth App saved skins: ${rows.length} row(s)`);

    const out = [];
    for (const r of rows) {
      const buf = Buffer.isBuffer(r.texture) ? r.texture
        : r.texture instanceof Uint8Array ? Buffer.from(r.texture) : null;
      if (!buf || buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50) continue;
      const who = names.get(String(r.uuid || "").replace(/-/g, "").toLowerCase());
      out.push({
        source: "modrinth",
        name: who ? `${who}'s skin` : "Modrinth skin",
        base64: buf.toString("base64"),
        variant: String(r.variant || "").toUpperCase() === "SLIM" ? "slim" : "classic",
      });
    }
    return out;
  }) || [];
}

// The Minecraft launcher's own skin library: launcher_custom_skins.json in
// .minecraft, holding each saved skin as a data: URL under customSkins.
function skinsFromVanillaJson(root) {
  const file = path.join(root, "launcher_custom_skins.json");
  let j;
  try {
    if (!fs.existsSync(file)) return [];
    j = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    devtoolsLog("Could not read launcher_custom_skins.json:", err && err.message);
    return [];
  }
  const entries = Object.values(j.customSkins || j.skins || {});
  devtoolsLog(`Minecraft launcher saved skins: ${entries.length} entry/entries`);
  const out = [];
  for (const s of entries) {
    const url = s && (s.skinImage || s.image || s.texture);
    const m = typeof url === "string" && url.match(/^data:image\/\w+;base64,(.+)$/s);
    if (!m) continue;
    out.push({
      source: "vanilla",
      name: s.name || "Minecraft skin",
      base64: m[1],
      variant: s.slim || String(s.modelType || s.variant || "").toLowerCase() === "slim"
        ? "slim" : "classic",
    });
  }
  return out;
}

ipcMain.handle("import:skins", async () => {
  const paths = knownLauncherPaths();
  const firstExisting = (roots) => (roots || []).find(r => r && fs.existsSync(r)) || null;
  const found = [];

  // The Modrinth App keeps its saved skins in app.db, not on disk.
  found.push(...skinsFromModrinthDb());

  const vanilla = firstExisting(paths.vanilla);
  if (vanilla) {
    found.push(...skinsFromVanillaJson(vanilla));
    // Older launcher builds, and anything that drops a PNG in by hand.
    found.push(...skinsFromDir(path.join(vanilla, "skins"), "vanilla"));
    found.push(...skinsFromDir(path.join(vanilla, "assets", "skins"), "vanilla"));
  }
  // Prism and MultiMC have no skin library, but respect one if it is there.
  for (const kind of ["prism", "multimc"]) {
    const root = firstExisting(paths[kind]);
    if (root) found.push(...skinsFromDir(path.join(path.dirname(root), "skins"), kind));
  }

  // Two launchers often hold the same skin; key by pixels so it only appears
  // once. Skins already in the library are still returned, marked, so the
  // importer can say "3 already here" instead of "none found".
  const uuid = (await currentAccountUuid()) || null;
  const mine = uuid ? (loadSkinLib()[uuid] || []) : [];
  const haveHashes = new Set(mine.map(x => x.pixelHash).filter(Boolean));
  const seen = new Set();
  const out = [];
  for (const sk of found) {
    let hash = null;
    try { hash = await skinPixelHash(sk.base64); } catch { /* keep it anyway */ }
    const key = hash || sk.base64.slice(0, 64);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...sk, pixelHash: hash, already: !!(hash && haveHashes.has(hash)) });
  }
  devtoolsLog(`Importable skins: ${out.length} (${out.filter(s => s.already).length} already in the library)`);
  return out;
});

// Add chosen skins to the current account's library.
ipcMain.handle("import:skinsAdd", async (event, { skins }) => {
  try {
    const uuid = await currentAccountUuid();
    if (!uuid) return { success: false, error: "no account selected" };
    let added = 0;
    for (const sk of skins || []) {
      if (!sk || !sk.base64) continue;
      await addSkinToLibrary(uuid, {
        base64: "data:image/png;base64," + sk.base64,
        variant: sk.variant || "classic",
        name: sk.name || "Imported skin",
      });
      added++;
    }
    return { success: true, added };
  } catch (err) {
    return { success: false, error: String(err && err.message || err) };
  }
});

// What accounts are sitting in the other launchers on this machine. Nothing is
// written; this only looks. Accounts already in this launcher are marked so the
// modal can skip them by default.
ipcMain.handle("import:accounts", async () => {
  const paths = knownLauncherPaths();
  const firstExisting = (roots) => (roots || []).find(r => r && fs.existsSync(r)) || null;
  const found = [];

  for (const kind of ["prism", "multimc"]) {
    const root = firstExisting(paths[kind]);
    // accounts.json sits beside the instances folder, not inside it.
    if (root) found.push(...accountsFromPrism(path.dirname(root)));
  }
  const vanillaRoot = firstExisting(paths.vanilla);
  if (vanillaRoot) found.push(...accountsFromVanilla(vanillaRoot));
  const lunarDir = lunarRoot();
  if (lunarDir) found.push(...accountsFromLunar(lunarDir));
  // Not gated on an instances folder existing: the accounts are in app.db, and
  // somebody can perfectly well have signed in without making an instance.
  found.push(...accountsFromModrinth());

  const mine = loadPlayers();
  const seen = new Set();
  // Accounts already in this launcher are returned, marked, rather than
  // dropped — otherwise "none found" is what you see when detection worked
  // perfectly and simply had nothing new to offer.
  const out = found.filter(a => {
    const key = String(a.username).toLowerCase();
    if (seen.has(key)) return false;   // the same account in two launchers
    seen.add(key);
    return true;
  }).map(a => ({
    ...a,
    already: mine.some(p => String(p.username || "").toLowerCase() === String(a.username).toLowerCase()),
  }));
  devtoolsLog(`Importable accounts: ${out.length} (${out.filter(a => a.already).length} already signed in here)`);
  return out;
});

// Bring chosen accounts in. A refresh token is stored the same way this
// launcher's own sign-in stores one, so the usual refresh path takes over from
// here and the account stays signed in.
ipcMain.handle("import:accountsAdd", async (event, { accounts }) => {
  try {
    const players = loadPlayers();
    let added = 0;
    for (const a of accounts || []) {
      if (!a || !a.username) continue;
      if (players.some(p => String(p.username || "").toLowerCase() === String(a.username).toLowerCase())) continue;
      const id = Date.now() + added;
      if (a.offline || (!a.accessToken && !a.refreshToken)) {
        players.push({ id, type: "cracked", username: a.username });
      } else {
        players.push({
          id,
          type: "microsoft",
          authKind: "live",
          username: a.username,
          auth: {
            name: a.username,
            uuid: String(a.uuid || "").replace(/-/g, ""),
            access_token: a.accessToken || "0",
            client_token: null,
            user_properties: "{}",
            meta: { type: "msa", demo: false },
          },
          refresh: a.refreshToken || "",
          // Force a refresh on first use rather than trusting an access token
          // of unknown age.
          lastRefresh: 0,
          importedFrom: a.source,
        });
      }
      added++;
    }
    savePlayers(players);
    for (const w of BrowserWindow.getAllWindows()) {
      try { if (!w.isDestroyed()) w.webContents.send("players-updated", players); } catch { /* gone */ }
    }
    return { success: true, added };
  } catch (err) {
    return { success: false, error: String(err && err.message || err) };
  }
});

// Copy one of those in as a Redstone instance. The game files are copied, not
// moved or linked, so the other launcher keeps working exactly as it did.
ipcMain.handle("import:instance", async (event, { entry }) => {
  try {
    if (!entry || !entry.gameDir) return { success: false, error: "incomplete instance" };
    if (!entry.version) return { success: false, error: "this instance doesn't say which Minecraft version it is — set one and try again" };
    const profileId = getUniqueFolderName(entry.name || "Imported");
    const dest = path.join(dataDir, "client", String(profileId));
    fs.mkdirSync(dest, { recursive: true });

    // Only what belongs to an instance — not the shared caches, which are big
    // and which this launcher manages itself.
    const SKIP = new Set(["assets", "libraries", "versions", "logs", "crash-reports", "webcache", "webcache2", ".fabric", "natives"]);
    const copyDir = (from, to) => {
      for (const e of fs.readdirSync(from, { withFileTypes: true })) {
        if (SKIP.has(e.name.toLowerCase())) continue;
        const src = path.join(from, e.name), dst = path.join(to, e.name);
        if (e.isDirectory()) { fs.mkdirSync(dst, { recursive: true }); copyDir(src, dst); }
        else if (e.isFile()) { try { fs.copyFileSync(src, dst); } catch { /* skip locked files */ } }
      }
    };
    copyDir(entry.gameDir, dest);

    // Bring the base Minecraft version across when the source launcher already
    // has it. versions/ is in SKIP above because the other launchers' loader
    // folders are laid out differently and this launcher provisions its own —
    // but the plain <mc>/<mc>.jar is the same file everywhere, so copying it
    // saves re-downloading what is already on this machine.
    try {
      const srcVersions = path.join(entry.versionRoot || entry.dir, "versions");
      const mc = String(entry.version);
      const from = path.join(srcVersions, mc);
      if (fs.existsSync(path.join(from, `${mc}.jar`))) {
        const to = path.join(dest, "versions", mc);
        fs.mkdirSync(to, { recursive: true });
        for (const n of [`${mc}.jar`, `${mc}.json`]) {
          const f = path.join(from, n);
          if (fs.existsSync(f)) fs.copyFileSync(f, path.join(to, n));
        }
      }
    } catch (err) {
      devtoolsLog("Couldn't copy the version jar across:", err && err.message);
    }

    // An icon, if the source launcher kept one.
    // The scan already resolved this launcher's own icon for the instance;
    // prefer it over guessing at a file in the folder.
    let icon = entry.icon || null;
    outer: for (const base of icon ? [] : [entry.gameDir, entry.dir]) {
      if (!base) continue;
      for (const n of ["icon.png", "instance.png", "pack.png"]) {
        const p = path.join(base, n);
        if (fs.existsSync(p)) {
          try { icon = "data:image/png;base64," + fs.readFileSync(p).toString("base64"); } catch { }
          if (icon) break outer;
        }
      }
    }

    const profiles = await loadProfiles();
    profiles.push({
      id: profileId,
      name: entry.name || String(profileId),
      version: entry.version,
      loader: entry.loader || "vanilla",
      loaderVersion: entry.loaderVersion || "",
      icon,
      importedFrom: entry.kind,
      created: Date.now(),
      lastUsed: Date.now(),
    });
    saveProfiles(profiles);
    broadcastProfiles(profiles);
    return { success: true, profileId };
  } catch (err) {
    return { success: false, error: String(err && err.message || err) };
  }
});

// ── A small cache on disk, for the answers the picker asks for every time ──
// The picker is opened over and over and used to rebuild everything from
// scratch each time: two requests to the wiki for a banner, six 1024px
// panorama faces resized, every mod jar in the instance opened, every
// screenshot re-thumbnailed. None of that changes between opens, so none of it
// should happen twice.
function iconCacheDir(bucket) { return path.join(dataDir, "cache", bucket); }
function iconCacheFile(bucket, key, ext) {
  const safe = String(key).replace(/[^\w.\-]/g, "_").slice(0, 160);
  return path.join(iconCacheDir(bucket), safe + ext);
}
async function iconCacheRead(bucket, key, ext) {
  try { return await fsp.readFile(iconCacheFile(bucket, key, ext)); } catch { return null; }
}
async function iconCacheWrite(bucket, key, ext, buf) {
  try {
    const f = iconCacheFile(bucket, key, ext);
    await fsp.mkdir(path.dirname(f), { recursive: true });
    await fsp.writeFile(f, buf);
  } catch { /* a cache that cannot be written is still only a cache */ }
}

ipcMain.handle("icon:thumb", async (event, { filePath, size }) => {
  try {
    const p = path.resolve(String(filePath || ""));
    if (!p.startsWith(dataDir)) return null;
    const px = Math.max(32, Math.min(512, Number(size) || 96));
    const st = fs.statSync(p);
    const key = `${p}:${px}:${st.mtimeMs}:${st.size}`;
    if (_iconThumbCache.has(key)) return _iconThumbCache.get(key);
    const onDisk = await iconCacheRead("icon-thumbs", key, ".png");
    if (onDisk) {
      const url = "data:image/png;base64," + onDisk.toString("base64");
      _iconThumbCache.set(key, url);
      return url;
    }
    const buf = await sharp(p).resize(px, px, { fit: "cover", position: "centre" }).png().toBuffer();
    const out = "data:image/png;base64," + buf.toString("base64");
    iconCacheWrite("icon-thumbs", key, ".png", buf);
    // A few hundred small thumbs is nothing; an unbounded map isn't.
    if (_iconThumbCache.size > 400) _iconThumbCache.clear();
    _iconThumbCache.set(key, out);
    return out;
  } catch { return null; }
});

// The wiki publishes a banner per version at a predictable path, but the shape
// of that path varies and plenty of versions have no banner at all. Try each
// shape in turn, and say so honestly when there is nothing.
const _bannerMemo = new Map();
ipcMain.handle("icon:versionBanner", async (event, { version }) => {
  const v = String(version || "").trim();
  if (!v) return null;
  if (_bannerMemo.has(v)) return _bannerMemo.get(v);
  // A version's banner is published once and never changes, so once it has
  // been fetched it never needs fetching again — not on the next open, not
  // after a restart.
  const cached = await iconCacheRead("version-banners", v, ".bin");
  if (cached) {
    const nl = cached.indexOf(10);
    const ct = cached.subarray(0, nl).toString("utf8");
    const out = { url: null, dataUrl: `data:${ct};base64,` + cached.subarray(nl + 1).toString("base64") };
    _bannerMemo.set(v, out);
    return out;
  }
  // A release's banner is "<version>_banner.png"; a snapshot's is the plain
  // "<id>.jpg" its wiki page leads with (25w31a.jpg, 26.3-pre1.jpg,
  // 26.3-rc1.jpg). Both are tried, because the id alone does not always say
  // which kind it is.
  const candidates = [
    `${v}_banner.png`, `${v}_banner.jpg`, `${v}.jpg`, `${v}.png`,
  ];
  for (const name of candidates) {
    const url = `https://minecraft.wiki/images/${encodeURIComponent(name)}`;
    try {
      const r = await fetch(url, { headers: { "User-Agent": LAUNCHER_UA } });
      if (!r.ok) continue;
      const ct = r.headers.get("content-type") || "";
      if (!ct.startsWith("image/")) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      await iconCacheWrite("version-banners", v, ".bin",
        Buffer.concat([Buffer.from(ct.split(";")[0] + "\n", "utf8"), buf]));
      const out = { url, dataUrl: `data:${ct};base64,` + buf.toString("base64") };
      _bannerMemo.set(v, out);
      return out;
    } catch { /* try the next extension */ }
  }
  // Remember that there ISN'T one too; plenty of versions have no banner and
  // asking the wiki twice per open for all of them is the slow part.
  _bannerMemo.set(v, null);
  return null;
});

// The six panorama faces from a version's client jar. Only offered for versions
// that are already installed somewhere — fetching a 40 MB jar to crop an icon
// out of it would not be a fair trade.
// The six panorama faces for a version.
//
// NOT from the client jar. In modern versions the jar's
// assets/minecraft/textures/gui/title/background/panorama_*.png are 1x1
// PLACEHOLDERS — 69 bytes each, a single grey pixel — which is precisely why
// this came out as a grey box with nothing logged: the files were found and
// decoded perfectly, they were just one grey pixel stretched across the canvas.
// The real images (600-950 KB each) are hashed assets, listed in the version's
// asset index and stored under assets/objects/<2>/<hash>.
//
// Older versions really do keep them in the jar, so that is still the fallback
// — but only when what is in there is a real image.
const PANORAMA_ASSET_PREFIX = "minecraft/textures/gui/title/background/panorama_";

function assetObjectPath(hash) {
  return path.join(dataDir, "assets", "objects", String(hash).slice(0, 2), String(hash));
}

// Fetch the panorama straight from Mojang when it isn't on disk. The assets are
// content-addressed and public, so this is the same data the game would
// download; it is cached into the launcher's own asset store so it is only
// fetched once.
const MOJANG_RESOURCES = "https://resources.download.minecraft.net";
let _versionManifestCache = null;

async function mojangVersionJson(version) {
  if (!_versionManifestCache) {
    const r = await fetch("https://launchermeta.mojang.com/mc/game/version_manifest_v2.json");
    if (!r.ok) throw new Error(`version manifest: HTTP ${r.status}`);
    _versionManifestCache = await r.json();
  }
  const entry = (_versionManifestCache.versions || []).find(v => v.id === version);
  if (!entry) throw new Error(`Mojang has no version called ${version}`);
  const vr = await fetch(entry.url);
  if (!vr.ok) throw new Error(`version json: HTTP ${vr.status}`);
  return vr.json();
}

async function fetchPanoramaFromMojang(version) {
  const vjson = await mojangVersionJson(version);
  const ai = vjson.assetIndex;
  if (!ai || !ai.url) throw new Error(`${version} has no asset index`);
  const ir = await fetch(ai.url);
  if (!ir.ok) throw new Error(`asset index: HTTP ${ir.status}`);
  const objects = (await ir.json()).objects || {};

  // Cache the index too, so the local path finds it next time.
  try {
    const idxDir = path.join(dataDir, "assets", "indexes");
    fs.mkdirSync(idxDir, { recursive: true });
    fs.writeFileSync(path.join(idxDir, `${ai.id}.json`), JSON.stringify({ objects }));
  } catch { /* caching is a bonus */ }

  // Before 1.13 the panorama was not an asset at all -- it was in the jar --
  // so an index with no entry for it is not a failure, it is an older
  // version, and the jar is where to look.
  if (!objects[`${PANORAMA_ASSET_PREFIX}0.png`]) {
    const fromJar = await iconModels.panoramaFromFiles({ version });
    if (fromJar) return fromJar;
    throw new Error(`${version} has no panorama, in its assets or its jar`);
  }

  const out = [];
  for (let i = 0; i < 6; i++) {
    const rec = objects[`${PANORAMA_ASSET_PREFIX}${i}.png`];
    if (!rec || !rec.hash) throw new Error(`${version}'s asset index has no panorama_${i}`);
    const dest = assetObjectPath(rec.hash);
    if (fs.existsSync(dest)) { out.push(fs.readFileSync(dest)); continue; }
    const two = String(rec.hash).slice(0, 2);
    const r = await fetch(`${MOJANG_RESOURCES}/${two}/${rec.hash}`);
    if (!r.ok) throw new Error(`panorama_${i}: HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
    } catch { /* not cacheable, still usable */ }
    out.push(buf);
  }
  // The overlay, if this version has one. Missing is fine — 1.12 and earlier
  // have no overlay at all.
  try {
    const rec = objects[`${PANORAMA_ASSET_PREFIX}overlay.png`];
    if (rec && rec.hash) {
      const dest = assetObjectPath(rec.hash);
      if (fs.existsSync(dest)) out.overlay = fs.readFileSync(dest);
      else {
        const two = String(rec.hash).slice(0, 2);
        const r = await fetch(`${MOJANG_RESOURCES}/${two}/${rec.hash}`);
        if (r.ok) {
          const buf = Buffer.from(await r.arrayBuffer());
          out.overlay = buf;
          try { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, buf); } catch { }
        }
      }
    }
  } catch { /* the panorama is still usable without it */ }
  return out;
}

// The asset index this version uses, from whichever instance has it installed.
function findAssetIndexFor(version) {
  const indexesDir = path.join(dataDir, "assets", "indexes");
  const tryIndex = (id) => {
    if (!id) return null;
    const p = path.join(indexesDir, `${id}.json`);
    return fs.existsSync(p) ? p : null;
  };
  // An instance's version json names the asset index it uses. A modded
  // instance keeps its loader version under another name, so look at every
  // version folder, not just one matching the version id.
  const clientDir = path.join(dataDir, "client");
  if (fs.existsSync(clientDir)) {
    for (const id of fs.readdirSync(clientDir)) {
      const versDir = path.join(clientDir, id, "versions");
      let names = [];
      try { names = fs.readdirSync(versDir); } catch { continue; }
      for (const name of names) {
        // Both <name>/<name>.json and the plain <version>.json inside it.
        for (const file of [`${name}.json`, `${version}.json`]) {
          const vjson = path.join(versDir, name, file);
          try {
            if (!fs.existsSync(vjson)) continue;
            const j = JSON.parse(fs.readFileSync(vjson, "utf8"));
            // Only this version's (or the one it inherits from).
            if (j.id !== version && j.inheritsFrom !== version) continue;
            const hit = tryIndex((j.assetIndex && j.assetIndex.id) || j.assets);
            if (hit) return hit;
          } catch { /* next */ }
        }
      }
    }
  }
  // Failing that, the index is usually named after the version's major line
  // (1.21.1 -> "1.21"), and a single index covers many versions.
  const m = /^(\d+\.\d+)/.exec(String(version));
  return tryIndex(version) || (m && tryIndex(m[1])) || null;
}

function findClientJar(version) {
  const clientDir = path.join(dataDir, "client");
  if (!fs.existsSync(clientDir)) return null;
  for (const id of fs.readdirSync(clientDir)) {
    const p = path.join(clientDir, id, "versions", String(version), `${version}.jar`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// A PNG's dimensions live at bytes 16..24. Used to tell a real face from the
// 1x1 placeholder the jar ships.
function pngSize(buf) {
  try {
    if (!buf || buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50) return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } catch { return null; }
}

// Every path a panorama's six faces are known to live at inside a jar or a
// resource pack. The first one is where modern versions keep them; the other
// two are where older ones did, and a pack written against an older version
// still uses its layout.
const PANORAMA_BASES = [
  "assets/minecraft/textures/gui/title/background/",
  "assets/minecraft/textures/gui/title/background/panorama/",
  "assets/minecraft/textures/gui/background/",
];
// All six, or nothing. Five faces and a hole is not a panorama, and a 1x1 is
// the placeholder some jars ship rather than a face.
//
// The OVERLAY is a picture in its own right, though -- the vignette the title
// screen lays over the panorama -- and a pack that replaces only that still
// has something worth taking an icon from. It cannot be looked around, having
// no cube behind it, so it comes back as faces: [] with the overlay set, and
// whoever offers it shows it as the flat picture it is.
const usableFace = (data) => {
  const size = pngSize(data);
  return !!(size && size.width >= 16 && size.height >= 16);
};

// The still image the title screen lays OVER the panorama — a soft vignette
// that is part of how the background looks in game. It is stretched across the
// whole view rather than tiled, and it lives beside the six faces, so a pack
// that replaces the panorama usually replaces this too.
const OVERLAY_NAME = "panorama_overlay.png";

// A pack that was extracted into a folder rather than left as a zip.
function panoramaFromDir(root) {
  for (const base of PANORAMA_BASES) {
    const found = [];
    for (let i = 0; i < 6; i++) {
      try {
        const f = path.join(root, ...base.split("/").filter(Boolean), `panorama_${i}.png`);
        if (!fs.existsSync(f)) break;
        const data = fs.readFileSync(f);
        if (!usableFace(data)) break;
        found.push(data);
      } catch { break; }
    }
    let overlay = null;
    try {
      const f = path.join(root, ...base.split("/").filter(Boolean), OVERLAY_NAME);
      if (fs.existsSync(f)) { const b = fs.readFileSync(f); if (usableFace(b)) overlay = b; }
    } catch { /* no overlay */ }
    if (found.length !== 6) {
      if (!overlay) continue;
      const only = [];
      only.overlay = overlay;
      return only;
    }
    found.overlay = overlay;
    return found;
  }
  return null;
}

// A zip or jar, read through unzipper rather than AdmZip on purpose: AdmZip
// pulls the whole archive into memory to get at its index, and this runs over
// every mod in an instance. unzipper reads the central directory alone, so a
// 40MB jar with no panorama in it costs a few reads instead of 40MB.
async function panoramaFromArchive(file) {
  let dir = null;
  try { dir = await unzipper.Open.file(file); } catch { return null; }
  const byPath = new Map();
  for (const e of (dir.files || [])) byPath.set(e.path.replace(/\\/g, "/"), e);
  for (const base of PANORAMA_BASES) {
    const entries = [];
    for (let i = 0; i < 6; i++) {
      const e = byPath.get(`${base}panorama_${i}.png`);
      if (!e) break;
      entries.push(e);
    }
    let overlay = null;
    const ov = byPath.get(`${base}${OVERLAY_NAME}`);
    if (ov) {
      try { const b = await ov.buffer(); if (usableFace(b)) overlay = b; } catch { /* no overlay */ }
    }
    const found = [];
    if (entries.length === 6) {
      for (const e of entries) {
        let data = null;
        try { data = await e.buffer(); } catch { break; }
        if (!usableFace(data)) break;
        found.push(data);
      }
    }
    if (found.length !== 6) {
      if (!overlay) continue;
      const only = [];
      only.overlay = overlay;
      return only;
    }
    found.overlay = overlay;
    return found;
  }
  return null;
}

// Six face buffers -> six data URLs, downscaled. A face is 1024x1024 and six of
// those as base64 is tens of megabytes over IPC for a picture that ends up
// 220px tall.
async function panoramaToDataUrls(faces) {
  const out = [];
  out.overlay = faces.overlay
    ? "data:image/png;base64," + faces.overlay.toString("base64")
    : null;
  for (const raw of faces) {
    let buf = raw;
    try {
      buf = await sharp(raw).resize(512, 512, { fit: "fill" }).png({ compressionLevel: 9 }).toBuffer();
    } catch (e) {
      devtoolsLog("panorama: could not resize a face:", e && e.message);
    }
    out.push("data:image/png;base64," + buf.toString("base64"));
  }
  return out;
}

// Panoramas that a resource pack or a mod in this instance replaces the title
// screen's with. A pack that changes the panorama is one of the first things
// anyone would want their instance's icon taken from, and the picker only
// offered the vanilla one.
//
// Enabled resource packs come first, because that is what the title screen
// actually shows — then the rest of the packs, then mods. Capped, since this
// opens every archive in the instance.
const PANORAMA_SCAN_LIMIT = 150;
const PANORAMA_RESULT_LIMIT = 6;
// Opening every mod and pack in an instance is the slowest thing the picker
// does. The answer only changes when those folders do, so it is kept against a
// signature of their contents rather than redone on every open.
const _packPanoMemo = new Map();
function packFolderSignature(root) {
  const parts = [];
  for (const sub of ["resourcepacks", "mods"]) {
    const dir = path.join(root, sub);
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      try {
        const st = fs.statSync(path.join(dir, e.name));
        parts.push(`${sub}/${e.name}:${Math.round(st.mtimeMs)}:${st.size}`);
      } catch { parts.push(`${sub}/${e.name}`); }
    }
  }
  // options.txt decides which packs are ON, which decides the order.
  try {
    const st = fs.statSync(path.join(root, "options.txt"));
    parts.push(`options:${Math.round(st.mtimeMs)}`);
  } catch { /* none yet */ }
  return parts.sort().join("|");
}

ipcMain.handle("icon:packPanoramas", async (event, { profileId } = {}) => {
  if (profileId == null) return { panoramas: [] };
  const root = path.join(dataDir, "client", String(profileId));
  const sig = packFolderSignature(root);
  const seen = _packPanoMemo.get(String(profileId));
  if (seen && seen.sig === sig) return seen.value;
  const list = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } };

  const enabled = new Set(
    readEnabledResourcePacks(profileId).map(p => String(p).replace(/^file\//, ""))
  );
  const packsDir = path.join(root, "resourcepacks");
  const modsDir = path.join(root, "mods");

  // { file, name, kind, dir, on } — ordered so the most likely answer is first
  // and the cap bites the least interesting entries.
  const candidates = [];
  for (const e of list(packsDir)) {
    const full = path.join(packsDir, e.name);
    if (e.isDirectory()) candidates.push({ full, name: e.name, kind: "pack", isDir: true, on: enabled.has(e.name) });
    else if (/\.zip$/i.test(e.name)) candidates.push({ full, name: e.name, kind: "pack", isDir: false, on: enabled.has(e.name) });
  }
  for (const e of list(modsDir)) {
    if (!e.isFile() || !/\.jar$/i.test(e.name)) continue;   // .disabled is skipped by this
    candidates.push({ full: path.join(modsDir, e.name), name: e.name, kind: "mod", isDir: false, on: false });
  }
  candidates.sort((a, b) => {
    if (a.on !== b.on) return a.on ? -1 : 1;
    if (a.kind !== b.kind) return a.kind === "pack" ? -1 : 1;
    return 0;
  });

  const panoramas = [];
  let scanned = 0;
  for (const c of candidates) {
    if (panoramas.length >= PANORAMA_RESULT_LIMIT) break;
    if (scanned++ >= PANORAMA_SCAN_LIMIT) break;
    let faces = null;
    try {
      faces = c.isDir ? panoramaFromDir(c.full) : await panoramaFromArchive(c.full);
    } catch (e) {
      devtoolsLog(`panorama: could not read ${c.name}:`, e && e.message);
    }
    if (!faces) continue;
    try {
      const urls = await panoramaToDataUrls(faces);
      panoramas.push({
        name: c.name.replace(/\.(zip|jar)$/i, ""),
        kind: c.kind,
        enabled: c.on,
        faces: urls,
        // Nothing to look around in an overlay on its own: the picture it
        // offers IS the overlay, and the picker takes it straight to the
        // cropper rather than into the panorama viewer.
        overlayOnly: urls.length < 6,
        forward: urls.length === 6 ? urls[0] : (urls.overlay || null),
        overlay: urls.overlay || null,
      });
    } catch (e) {
      devtoolsLog(`panorama: could not prepare ${c.name}:`, e && e.message);
    }
  }
  const value = { panoramas, scanned, truncated: scanned >= PANORAMA_SCAN_LIMIT };
  if (_packPanoMemo.size > 12) _packPanoMemo.clear();
  _packPanoMemo.set(String(profileId), { sig, value });
  return value;
});

const _panoMemo = new Map();
ipcMain.handle("icon:versionPanorama", async (event, { version }) => {
  try {
    const v = String(version || "").trim();
    if (!v) return { error: "no version given" };
    if (_panoMemo.has(v)) return _panoMemo.get(v);
    // Six 1024px faces resized to 512 is the better part of a second, every
    // time the picker is opened. The result is the same every time.
    try {
      const cached = await iconCacheRead("version-panoramas", v, ".json");
      if (cached) {
        const out = JSON.parse(cached.toString("utf8"));
        _panoMemo.set(v, out);
        return out;
      }
    } catch { /* fall through and build it */ }

    let faces = null;

    // 1. The asset store, which is where these actually live now.
    const idxFile = findAssetIndexFor(v);
    if (idxFile) {
      try {
        const objects = JSON.parse(fs.readFileSync(idxFile, "utf8")).objects || {};
        const bufs = [];
        for (let i = 0; i < 6; i++) {
          const rec = objects[`${PANORAMA_ASSET_PREFIX}${i}.png`];
          if (!rec || !rec.hash) break;
          const f = assetObjectPath(rec.hash);
          if (!fs.existsSync(f)) break;
          bufs.push(fs.readFileSync(f));
        }
        if (bufs.length === 6) {
          faces = bufs;
          // The still image laid over the panorama lives in the asset store
          // beside the faces.
          const ov = objects[`${PANORAMA_ASSET_PREFIX}overlay.png`];
          if (ov && ov.hash) {
            const f = assetObjectPath(ov.hash);
            if (fs.existsSync(f)) { try { faces.overlay = fs.readFileSync(f); } catch { } }
          }
        } else devtoolsLog(`panorama: ${v} asset index has ${bufs.length}/6 faces downloaded`);
      } catch (e) {
        devtoolsLog("panorama: could not read the asset index:", e && e.message);
      }
    }

    // 2. Older versions keep real images in the jar. No jar is not an answer,
    //    it just means nothing local to read — which is what step 3 is for.
    //    This used to return "not downloaded in any instance yet" here and so
    //    never reached the download at all, contradicting the comment below it.
    if (!faces) {
      const jarPath = findClientJar(v);
      if (jarPath) faces = await panoramaFromArchive(jarPath);
    }

    // 3. Not on disk anywhere: fetch it. These are public, content-addressed
    //    assets — the same bytes the game downloads — and they are cached into
    //    the launcher's own asset store so this happens once per version.
    if (!faces) {
      try {
        faces = await fetchPanoramaFromMojang(v);
      } catch (e) {
        devtoolsLog("panorama: could not download it:", e && e.message);
        return { error: `Couldn't get ${v}'s panorama: ${e && e.message}` };
      }
    }

    const out = await panoramaToDataUrls(faces);
    // Face 0 is the one the title screen starts on, i.e. "facing forward".
    // With no faces at all -- a pack or a version that ships only the overlay
    // -- the overlay is the picture there is.
    const answer = {
      faces: [...out],
      forward: out.length === 6 ? out[0] : (out.overlay || null),
      overlay: out.overlay || null,
    };
    if (!answer.forward) return { error: `${v} has no panorama` };
    _panoMemo.set(v, answer);
    iconCacheWrite("version-panoramas", v, ".json", Buffer.from(JSON.stringify(answer), "utf8"));
    return answer;
  } catch (err) {
    devtoolsLog("panorama failed:", err && err.message);
    return { error: String(err && err.message || err) };
  }
});

ipcMain.handle("icon:dataUrl", async (event, { filePath }) => {
  try {
    const p = path.resolve(String(filePath || ""));
    if (!p.startsWith(dataDir)) return null;   // only ever our own cache / instances
    const buf = fs.readFileSync(p);
    if (buf.length > 4 * 1024 * 1024) return null;
    const ext = path.extname(p).toLowerCase();
    const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
    return `data:${mime};base64,` + buf.toString("base64");
  } catch { return null; }
});

// Every picture a mod (or pack, or modpack) has on Modrinth / CurseForge.
//
// A mod's icon in the launcher is whichever one of these the indexer happened
// to pick, but the project usually has more: a banner, screenshots, artwork.
// The icon picker offers the lot rather than that one.
//
// Kept for a while in memory: the pictures of a published project change
// about never, and this is asked again every time the picker is opened.
const _projectImages = new Map();          // "m:id" / "c:id" -> { at, images }
const PROJECT_IMAGES_TTL = 6 * 60 * 60 * 1000;

async function modrinthProjectImages(id) {
  const r = await fetch(`https://api.modrinth.com/v2/project/${encodeURIComponent(id)}`,
    { headers: { "User-Agent": LAUNCHER_UA } });
  if (!r.ok) return [];
  const p = await r.json();
  const out = [];
  if (p.icon_url) out.push({ url: p.icon_url, kind: "icon", title: "Modrinth icon", source: "modrinth" });
  for (const g of (p.gallery || [])) {
    if (!g || !g.url) continue;
    out.push({
      // Modrinth has no banner as such: the featured gallery image is the one
      // shown across the top of the page, which is the same thing.
      url: g.url, kind: g.featured ? "banner" : "gallery",
      title: g.title || (g.featured ? "Featured image" : "Gallery"), source: "modrinth",
    });
  }
  return out;
}

async function curseProjectImages(id) {
  const r = await fetch(`${WORKER_URL}/mods?modId=${encodeURIComponent(id)}`,
    { headers: { Accept: "application/json" } });
  if (!r.ok) return [];
  const p = (await r.json()).data || {};
  const out = [];
  if (p.logo && p.logo.url) out.push({ url: p.logo.url, kind: "icon", title: "CurseForge logo", source: "curseforge" });
  for (const s of (p.screenshots || [])) {
    if (!s || !s.url) continue;
    out.push({ url: s.url, kind: "gallery", title: s.title || "Screenshot", source: "curseforge" });
  }
  return out;
}

ipcMain.handle("project:images", async (event, { modrinthId, curseId } = {}) => {
  const want = [];
  if (modrinthId) want.push(["m:" + modrinthId, () => modrinthProjectImages(modrinthId)]);
  if (curseId) want.push(["c:" + curseId, () => curseProjectImages(curseId)]);
  const images = [];
  for (const [key, get] of want) {
    const held = _projectImages.get(key);
    if (held && Date.now() - held.at < PROJECT_IMAGES_TTL) { images.push(...held.images); continue; }
    let got = [];
    try { got = await get(); } catch (err) { devtoolsLog("project images failed:", String(err && err.message || err)); }
    _projectImages.set(key, { at: Date.now(), images: got });
    images.push(...got);
  }
  // The same picture can be both the Modrinth icon and the CurseForge logo.
  const seen = new Set();
  return { images: images.filter(i => !seen.has(i.url) && seen.add(i.url)) };
});

// ── Block, item and entity models as icons ─────────────────────────────────
// The reading lives in backend/icon-models.js and the drawing in
// frontend/blockrender.js; this is the wiring between them. The handlers hand
// the renderer a description — boxes, textures, UVs — rather than a picture,
// because the only place with a GPU is the renderer process.
iconModels.configure({
  dataDir,
  log: devtoolsLog,
  findClientJar,
  instanceRoot: (profileId) => path.join(dataDir, "client", String(profileId)),
  enabledResourcePacks: readEnabledResourcePacks,
  // How colourful a texture is, which is what decides whether a face with a
  // `tintindex` really wants tinting. See model-assets.js.
  //
  // The TYPICAL pixel, not the average one. A texture meant to be tinted is
  // drawn in greys, but a few of its pixels need not be: jungle leaves have a
  // handful of bright ones and average 0.075, which is more colour than pale
  // oak leaves' 0.060 -- and jungle leaves are tinted where pale oak ones are
  // not. By the median they are 0.007 against 0.060, which is the right way
  // round and a wide gap.
  measureSaturation: async (buf) => {
    try {
      const { data } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const sats = [];
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 200) continue;
        const mx = Math.max(data[i], data[i + 1], data[i + 2]);
        const mn = Math.min(data[i], data[i + 1], data[i + 2]);
        sats.push(mx ? (mx - mn) / mx : 0);
      }
      if (!sats.length) return 0;
      sats.sort((a, b) => a - b);
      return sats[sats.length >> 1];
    } catch { return null; }
  },
  // How much of an image is painted at all, 0..1. An overlay is drawn ON a
  // mob and is mostly empty -- an iron golem's cracks, a creeper's charge --
  // where another skin for it covers the same ground as the first. Nothing in
  // the names tells the two apart reliably, but this does.
  measureAlpha: async (buf) => {
    try {
      const { data } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      let on = 0, n = 0;
      for (let i = 3; i < data.length; i += 4) { n++; if (data[i] > 8) on++; }
      return n ? on / n : 0;
    } catch { return null; }
  },
  // One pixel out of an image, for reading a biome colour off the game's own
  // colormaps rather than hard-coding what green looks like.
  samplePixel: async (buf, x, y) => {
    try {
      const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const px = Math.max(0, Math.min(info.width - 1, Math.round(x)));
      const py = Math.max(0, Math.min(info.height - 1, Math.round(y)));
      const i = (py * info.width + px) * 4;
      return [data[i], data[i + 1], data[i + 2]];
    } catch { return null; }
  },
  // One palette swapped for another, which is how the game builds the armour
  // trims: the mask's greys are looked up in `key` and come back out as the
  // colour at the same place in `to`. A colour that is not in the key is left
  // alone, and alpha is the mask's throughout. See model-assets.js.
  recolor: async (maskBuf, keyBuf, toBuf) => {
    const raw = async (b) => {
      const { data, info } = await sharp(b).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return { data, info };
    };
    const [mask, key, to] = await Promise.all([raw(maskBuf), raw(keyBuf), raw(toBuf)]);
    const map = new Map();
    const n = Math.min(key.data.length, to.data.length) / 4;
    for (let i = 0; i < n; i++) {
      const k = i * 4;
      map.set((key.data[k] << 16) | (key.data[k + 1] << 8) | key.data[k + 2],
        [to.data[k], to.data[k + 1], to.data[k + 2]]);
    }
    const out = Buffer.from(mask.data);
    for (let i = 0; i < out.length; i += 4) {
      const hit = map.get((out[i] << 16) | (out[i + 1] << 8) | out[i + 2]);
      if (hit) { out[i] = hit[0]; out[i + 1] = hit[1]; out[i + 2] = hit[2]; }
    }
    return await sharp(out, { raw: { width: mask.info.width, height: mask.info.height, channels: 4 } })
      .png().toBuffer();
  },
});

ipcMain.handle("model:list", async (event, opts = {}) => {
  try { return await iconModels.listModels(opts); }
  catch (err) { return { items: [], total: 0, error: String(err && err.message || err) }; }
});
ipcMain.handle("model:describe", async (event, opts = {}) => {
  try { return await iconModels.describeModel(opts); }
  catch (err) { return { error: String(err && err.message || err) }; }
});
// Flat face textures of full blocks, for tiling one behind the launcher.
// The background is not any one instance's, so with no version named it is
// read from the newest release.
ipcMain.handle("model:blockFaces", async (event, opts = {}) => {
  try {
    let version = opts.version;
    if (!version) {
      const manifest = await getVersionManifest();
      version = manifest && manifest.latest && manifest.latest.release;
      if (!version) return { items: [], total: 0, error: "No Minecraft version could be read yet" };
    }
    return await iconModels.listBlockFaces({ ...opts, version });
  } catch (err) { return { items: [], total: 0, error: String(err && err.message || err) }; }
});
ipcMain.handle("model:states", async (event, opts = {}) => {
  try { return await iconModels.modelStates(opts); }
  catch { return []; }
});
ipcMain.handle("model:entity", async (event, opts = {}) => {
  try { return await iconModels.describeEntity(opts); }
  catch (err) { return { error: String(err && err.message || err) }; }
});
ipcMain.handle("icon:versionIcon", async (event, opts = {}) => {
  try { return await iconModels.versionIcon(opts); }
  catch (err) { return { kind: "release", reason: String(err && err.message || err) }; }
});
// Everything the version picker needs to draw itself: the releases, the
// snapshots, and which version the "latest snapshot" card should borrow its
// icon from.
ipcMain.handle("icon:pickerVersions", async () => {
  try { return await iconModels.versionIcons.pickerVersions(); }
  catch (err) {
    devtoolsLog("picker versions failed:", String(err && err.message || err));
    return { releases: [], snapshots: [], latest: {}, next: null };
  }
});
ipcMain.handle("icon:storeVersionIcon", async (event, opts = {}) => {
  try { return await iconModels.storeVersionIcon(opts); }
  catch { return { success: false }; }
});
// Thumbnails the renderer drew, kept so the picker does not have to draw the
// same grid again every time it is opened.
ipcMain.handle("model:thumbs", async (event, { keys } = {}) => {
  try { return await iconModels.thumbMany({ keys }); }
  catch { return {}; }
});
ipcMain.handle("model:thumbPut", async (event, opts = {}) => {
  try { return await iconModels.thumbPut(opts); }
  catch { return { success: false }; }
});

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

// Names, versions, authors and icons for a server's jars. The server mods tab
// only had raw filenames; this gives it the same cards the instances tab has,
// falling back to the icon inside the jar when the mod isn't on Modrinth or
// CurseForge (which is all this reads - it never goes to the network).
// Which of a server's mods have a newer build. Instances resolve this through
// their persisted index; servers have no such index, so ask Modrinth directly —
// /v2/version_files/update takes every file hash at once and answers with the
// newest version of each for a given loader and game version, which is one
// request for the whole folder.
ipcMain.handle("server-mods:updates", async (event, { name, dir }) => {
  try {
    const folder = path.join(serverRoot(name), dir || "mods");
    if (!fs.existsSync(folder)) return {};
    const info = serverManager.getServerInfo(name) || {};
    const gameVersion = info.version;
    const loader = String(info.type || "").toLowerCase();
    if (!gameVersion || !["forge", "neoforge", "fabric", "quilt"].includes(loader)) return {};

    const files = fs.readdirSync(folder).filter(f => /\.jar(\.disabled)?$/i.test(f));
    if (!files.length) return {};
    const byHash = new Map();
    for (const f of files) {
      try { byHash.set(computeSHA1(path.join(folder, f)), f); } catch { /* unreadable */ }
    }
    if (!byHash.size) return {};

    const res = await fetch("https://api.modrinth.com/v2/version_files/update", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": LAUNCHER_UA },
      body: JSON.stringify({
        hashes: [...byHash.keys()],
        algorithm: "sha1",
        loaders: [loader],
        game_versions: [gameVersion],
      }),
    });
    if (!res.ok) return {};
    const out = {};
    const data = await res.json();
    for (const [hash, version] of Object.entries(data || {})) {
      const filename = byHash.get(hash);
      if (!filename || !version) continue;
      const file = (version.files || []).find(f => f.primary) || (version.files || [])[0];
      // The endpoint answers with the newest matching version, which for an
      // up-to-date mod is the one already installed.
      if (!file || !file.hashes || file.hashes.sha1 === hash) continue;
      // The version id comes along so the changelog can be fetched on demand
      // rather than pulled down for every mod nobody looks at.
      out[filename] = { available: true, url: file.url, latestNumber: version.version_number || null, versionId: version.id || null };
    }
    return out;
  } catch (err) {
    devtoolsLog("server mod update check failed:", err);
    return {};
  }
});

// Swap one server mod for a newer build: the new jar comes down beside the old
// one, and the old is only removed once it has actually landed.
ipcMain.handle("server-mods:update", async (event, { name, dir, filename, url }) => {
  try {
    if (!filename || !url) return { success: false, error: "missing filename or url" };
    const folder = path.join(serverRoot(name), dir || "mods");
    const target = path.join(folder, path.basename(new URL(url).pathname));
    if (path.resolve(target) !== path.join(folder, path.basename(target))) {
      return { success: false, error: "bad target path" };
    }
    await downloadFile(url, target);
    if (!fs.existsSync(target) || fs.statSync(target).size === 0) {
      return { success: false, error: "download produced no file" };
    }
    const old = path.join(folder, filename);
    // Don't delete the old one if the "new" file IS it.
    if (path.resolve(old) !== path.resolve(target) && fs.existsSync(old)) {
      try { fs.unlinkSync(old); } catch { /* leave it; the new one is in place */ }
    }
    return { success: true, filename: path.basename(target) };
  } catch (err) {
    return { success: false, error: String(err && err.message || err) };
  }
});

ipcMain.handle("server-mods:info", async (event, { name, dir }) => {
  const sub = dir === "plugins" ? "plugins" : "mods";
  const base = path.join(serverRoot(name), sub);
  const iconsDir = path.join(metaDir("servers", name), `${sub}.icons`);
  const out = {};
  let files = [];
  try { files = fs.readdirSync(base, { withFileTypes: true }); } catch { return out; }
  let since = 0;
  for (const d of files) {
    if (d.isDirectory() || !/\.jar(\.disabled)?$/i.test(d.name)) continue;
    // Reading jars is synchronous and adds up over a big pack, so let the event
    // loop breathe - the whole app shares this process.
    if (++since >= 4) { since = 0; await new Promise(r => setImmediate(r)); }
    const full = path.join(base, d.name);
    try {
      const meta = readJarMeta(full);
      const st = fs.statSync(full);
      const key = crypto.createHash("sha1").update(`${d.name}:${st.size}:${st.mtimeMs}`).digest("hex");
      const iconFile = extractJarIcon(full, meta.icon, iconsDir, key);
      out[d.name] = {
        name: meta.name || null, version: meta.version || null, author: meta.authors || null,
        icon: iconFile ? pathToFileURL(path.join(iconsDir, iconFile)).href : null,
        iconPath: iconFile ? path.join(iconsDir, iconFile) : null,
      };
    } catch { /* unreadable jar - the filename still shows */ }
  }
  // Forget icons for jars that are gone.
  try {
    const keep = new Set(Object.values(out).map(v => v.iconPath && path.basename(v.iconPath)).filter(Boolean));
    for (const f of fs.readdirSync(iconsDir)) if (!keep.has(f)) fs.unlinkSync(path.join(iconsDir, f));
  } catch { /* no cache dir yet */ }
  return out;
});

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

  const MOD_INDEX_VERSION = 4; // bump to force a rebuild when the entry shape changes
  const indexFile = tabMetaFile("client", profileId, tab, "modindex.json");
  // Icons pulled out of jars / pack zips live beside the index.
  const iconsDir = path.join(path.dirname(indexFile), `${tab}.icons`);
  migrateMeta(path.join(basePath, MOD_INDEX_FILE), indexFile);
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

  // Hashing + jar parsing is synchronous and can be heavy for a big modpack, so
  // yield the event loop every few files — otherwise the whole app freezes while
  // this runs on the main process.
  let _since = 0;
  for (const d of files) {
    if (++_since >= 4) { _since = 0; await new Promise(r => setImmediate(r)); }
    const filename = d.name;
    const fullPath = path.join(basePath, filename);

    if (d.isDirectory()) {
      // A folder IS a pack for resourcepacks/shaderpacks. In a mods folder it's
      // a loader's working directory, not something to list.
      if (tab !== "resourcepacks" && tab !== "shaderpacks") continue;
      const description = tab === "resourcepacks" ? readPackDescription(fullPath, true) : null;
      const enabled = enabledPacks ? enabledPacks.includes("file/" + filename) : true;
      // A folder pack keeps its icon right there as pack.png.
      let icon = null;
      try { const pp = path.join(fullPath, "pack.png"); if (fs.existsSync(pp)) icon = pathToFileURL(pp).href; } catch { /* ignore */ }
      results.push({ name: filename, filename, icon, iconPath: icon ? path.join(fullPath, "pack.png") : null, path: fullPath, details: "(folder)", description, version: null, author: null, disabled: !enabled, enabled, isFolder: true });
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
      // The file's own icon, used when neither Modrinth nor CurseForge knows it.
      entry.iconFile = /\.(jar|zip)(\.disabled)?$/i.test(filename)
        ? extractJarIcon(fullPath, entry.jar && entry.jar.icon, iconsDir, entry.sha1)
        : null;
      index.entries[filename] = entry;
    }
    if (!entry.modrinth) needLookup.push({ filename, sha1: entry.sha1 });

    const enabled = (tab === "resourcepacks")
      ? (enabledPacks ? enabledPacks.includes("file/" + filename) : true)
      : !disabled;

    results.push({ _filename: filename, path: fullPath, enabled, disabled: !enabled, isFolder: false });
  }

  // Everything above came off the disk: names, versions, authors and the icons
  // inside the jars. Push that to the renderer now -- the Modrinth/CurseForge
  // lookups below need the network, and waiting for them meant a big modpack
  // showed nothing at all for several seconds.
  try {
    const early = results.map(r => {
      if (!r._filename) return { ...r };
      const e = index.entries[r._filename] || {};
      const jar = e.jar || {};
      const cleanName = r._filename.replace(/\.disabled$/i, "");
      const ownIcon = e.iconFile ? path.join(iconsDir, e.iconFile) : null;
      // The index already remembers which Modrinth/CurseForge project a file
      // is -- it is keyed by the file's sha1, which cannot change under us --
      // so use it HERE rather than only in the full pass below. Leaving it out
      // meant every mod was drawn first with its jar icon and no update
      // button, then redrawn moments later with the project artwork and the
      // button, as though the launcher had forgotten and gone to look again.
      const m = e.modrinth, cf = e.curse;
      const known = m || cf;
      return {
        ...r,
        filename: r._filename,
        name: (m && m.title) || (cf && cf.title) || jar.name || cleanName,
        icon: (m && m.icon) || (cf && cf.icon) || (ownIcon ? pathToFileURL(ownIcon).href : null),
        iconPath: ownIcon,
        version: (m && m.versionNumber) || jar.version || null,
        author: jar.authors || null,
        details: [(m && m.versionNumber) || jar.version, jar.authors].filter(Boolean).join("  •  ") || cleanName,
        source: m ? "modrinth" : cf ? "curseforge" : null,
        projectId: (m && m.projectId) || (cf && cf.projectId) || null,
        // Only the files we have never matched are still "pending" — the rest
        // are already as complete as the second pass will make them.
        pending: !known,
      };
    });
    early.forEach(r => delete r._filename);
    event.sender.send("instance-content-partial", { profileId, tab, results: early });
  } catch { /* the full result below is what actually matters */ }

  // Drop index entries for files that have been removed, and the icons cached
  // for them, so the cache doesn't grow forever as mods come and go.
  const present = new Set(files.map(f => f.name));
  for (const k of Object.keys(index.entries)) if (!present.has(k)) delete index.entries[k];
  try {
    const keep = new Set(Object.values(index.entries).map(e => e && e.iconFile).filter(Boolean));
    for (const f of fs.readdirSync(iconsDir)) if (!keep.has(f)) fs.unlinkSync(path.join(iconsDir, f));
  } catch { /* no cache dir yet */ }

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
          // The version id comes along so the changelog can be fetched on
          // demand rather than pulled down for every mod nobody looks at.
          e.update = { checkedAt: now, available: true, url: file?.url || null, latestNumber: newest.version_number || null, versionId: newest.id || null };
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
    // Modrinth / CurseForge art first; otherwise the icon inside the file itself.
    const ownIcon = e?.iconFile ? path.join(iconsDir, e.iconFile) : null;
    r.icon = (m && m.icon) || (cf && cf.icon) || (ownIcon ? pathToFileURL(ownIcon).href : null);
    // Absolute path to the icon when it's a local file, for anything that needs
    // to read the bytes (the icon picker) rather than just display it.
    r.iconPath = ownIcon;
    r.version = (m && m.versionNumber) || jar.version || null;
    r.author = (m && m.author) || jar.authors || null;
    r.projectId = (m && m.projectId) || null;
    r.curseId = (cf && cf.projectId) || null;
    r.projectType = m ? "modrinth" : (cf ? "curseforge" : null);
    r.updateAvailable = !!(e?.update?.available);
    r.updateUrl = e?.update?.url || null;
    r.latestVersion = e?.update?.latestNumber || null;
    r.updateVersionId = e?.update?.versionId || null;
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

  try { fs.mkdirSync(path.dirname(indexFile), { recursive: true }); fs.writeFileSync(indexFile, JSON.stringify(index)); } catch { /* best effort */ }
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

// The smallest servers.dat there can be is nineteen bytes: a compound holding
// an empty list. Anything shorter is not a short server list, it is a file that
// was never finished -- a zero-byte one is what an interrupted write leaves
// behind, and the game itself is happy with no file at all.
//
// It matters because of how the NBT reader fails: a zero-byte buffer comes back
// as `PartialReadError: Read error for undefined : undefined` from inside the
// protocol compiler, with fifteen frames of stack and no mention of which file
// it was reading -- printed afresh every time anything looks at the list, which
// is on opening an instance, on syncing and on listing servers.
const SERVERS_DAT_MIN = 19;
// One complaint per file rather than one per read.
const _serversDatBad = new Set();

async function parseServersDat(filePath) {
  let buf = null;
  try { buf = fs.readFileSync(filePath); } catch { return []; }
  if (buf.length < SERVERS_DAT_MIN) return [];       // never written, not corrupt
  try {
    const simplified = nbt.simplify((await nbt.parse(buf)).parsed);
    _serversDatBad.delete(filePath);
    return Array.isArray(simplified.servers) ? simplified.servers : [];
  } catch (err) {
    if (!_serversDatBad.has(filePath)) {
      _serversDatBad.add(filePath);
      devtoolsLog(`servers.dat at ${filePath} could not be read (${err && err.message}); `
        + "treating it as an empty list");
    }
    return [];
  }
}

async function readServersList(profileId) {
  return parseServersDat(serversDatPath(profileId));
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

// ── Shared config syncing ───────────────────────────────────────────────────
// One canonical options.txt / servers.dat under the launcher's data directory,
// hard-linked into every instance that hasn't opted out, so a keybind or a
// saved server set up in one instance is there in all of them. Instances that
// own servers of their own -- a Modrinth server instance, a modpack that ships
// a server list -- are merged instead of linked, because a link would throw
// their own entries away.
const sharedCfgDir = () => path.join(dataDir, "shared-config");
const sharedCfgPath = (file) => path.join(sharedCfgDir(), file);
const instanceFile = (profileId, file) => path.join(dataDir, "client", String(profileId), file);

function syncEnabled(kind) { return !!settings.get(kind === "servers" ? "syncServers" : "syncOptions"); }

// A merged instance is one with servers of its own that a plain link would
// destroy. Only servers.dat is ever merged; options.txt has no such notion.
const ownsServers = (p) => !!(p && (p.modpack || p.serverProjectId || p.serverAddress));

function sameFile(a, b) {
  try {
    const sa = fs.statSync(a), sb = fs.statSync(b);
    return sa.ino === sb.ino && sa.dev === sb.dev;
  } catch { return false; }
}

// Hard-link `target` to `shared`.
//
// Whether a link survives the game writing to it depends on HOW the game
// writes. Checked against the client jars for 1.6.4, 1.7.10, 1.12.2, 1.16.5,
// 1.20.1, 26.2 and 26.3-rc-2, and it is consistent across all of them:
//
//   options.txt  new FileOutputStream(optionsFile) (FileWriter before 1.12) --
//                open(O_TRUNC), writes through the link, inode kept. The link
//                NEVER breaks, and an edit is live in every instance at once.
//   servers.dat  a temp file renamed over the target -- _tmp + File.renameTo up
//                to 1.12, Util.safeReplaceFile from 1.16, createTempFile +
//                safeReplaceOrMoveFile now. A rename repoints the path at a NEW
//                inode, so the link breaks on EVERY save, every version.
//
// Hence this: a target that is no longer the shared inode, and newer than it,
// has content the shared copy has not seen, so it wins and becomes the shared
// content before the link is remade. Falls back to copying where links aren't
// possible (a different volume, a filesystem without them).
function relinkToShared(target, shared) {
  try {
    if (sameFile(target, shared)) return "linked";
    if (fs.existsSync(target)) {
      const t = fs.statSync(target), s = fs.existsSync(shared) ? fs.statSync(shared) : null;
      if (!s || t.mtimeMs > s.mtimeMs) {
        fs.mkdirSync(path.dirname(shared), { recursive: true });
        fs.copyFileSync(target, shared);
      }
      fs.unlinkSync(target);
    }
    if (!fs.existsSync(shared)) return "no-source";
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try { fs.linkSync(shared, target); return "linked"; }
    catch { fs.copyFileSync(shared, target); return "copied"; }
  } catch (err) {
    devtoolsLog("Config sync: could not link", target, err);
    return "failed";
  }
}

const serverKey = (s) => `${String(s.ip || "").trim().toLowerCase()}|${String(s.name || "").trim()}`;

const readServersFrom = (filePath) => parseServersDat(filePath);
// Everything that actually gets written, so an unchanged list can be left
// alone. Rewriting matters more than it looks: the write below is atomic
// (temp + rename), and a rename REPLACES the file's inode — which severs every
// hard link pointing at it. Rewriting the shared file unconditionally therefore
// broke and remade every instance's link on every single sync.
const serversSignature = (list) => JSON.stringify((list || []).map(s => [
  String(s.name ?? ""), String(s.ip ?? ""), String(s.icon ?? ""), Number(s.acceptTextures ?? 1) ? 1 : 0,
]));

async function writeServersIfChanged(filePath, list) {
  if (fs.existsSync(filePath)) {
    const current = await readServersFrom(filePath);
    if (serversSignature(current) === serversSignature(list)) return false;
  }
  writeServersTo(filePath, list);
  return true;
}

function writeServersTo(filePath, list) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const serverCompounds = list.map(s => {
    const value = {};
    value.name = { type: "string", value: String(s.name ?? "") };
    value.ip = { type: "string", value: String(s.ip ?? "") };
    if (s.icon != null && s.icon !== "") value.icon = { type: "string", value: String(s.icon) };
    value.acceptTextures = { type: "byte", value: Number(s.acceptTextures ?? 1) ? 1 : 0 };
    return value;
  });
  const buffer = nbt.writeUncompressed({
    type: "compound", name: "",
    value: { servers: { type: "list", value: { type: "compound", value: serverCompounds } } },
  });
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, buffer);
  fs.renameSync(tmp, filePath);
}

// Merge an instance that owns servers. Its own entries keep their place (a
// server instance's address on top, a modpack's list at the bottom) and the
// shared list fills in around them. Anything in the file that is neither shared
// nor a recorded own entry -- a server added here, or one of its own entries
// after being edited -- is promoted INTO the shared list, which is what makes
// editing a pack's server "add it to the saved config too".
async function mergeServersFor(profile, sharedList) {
  const file = instanceFile(profile.id, "servers.dat");
  const current = await readServersFrom(file);
  const recordedOwn = Array.isArray(profile.ownServers) ? profile.ownServers : null;
  const sharedKeys = new Set(sharedList.map(serverKey));

  // First run: whatever is in there now is this instance's own list.
  const ownKeys = new Set((recordedOwn || current).map(serverKey));
  // What the shared list last put into this file. An entry from that set which
  // is no longer shared was deleted from another instance — dropping it is the
  // point. Without this it looks like a local addition and gets promoted back,
  // so a server could never be deleted while a merged instance existed.
  const lastShared = new Set(Array.isArray(profile.syncedServers) ? profile.syncedServers : []);

  const promoted = [];
  for (const s of current) {
    const k = serverKey(s);
    if (sharedKeys.has(k) || ownKeys.has(k) || lastShared.has(k)) continue;
    promoted.push(s);
    sharedKeys.add(k);
  }
  const nextShared = sharedList.concat(promoted);

  // Keep the instance's own entries as they currently read, in file order.
  const own = current.filter(s => ownKeys.has(serverKey(s)));
  const ownSet = new Set(own.map(serverKey));
  const rest = nextShared.filter(s => !ownSet.has(serverKey(s)));
  const isServerInstance = !!(profile.serverProjectId || profile.serverAddress);
  const merged = isServerInstance ? own.concat(rest) : rest.concat(own);

  await writeServersIfChanged(file, merged);
  return { shared: nextShared, own, syncedKeys: rest.map(serverKey) };
}

// Bring every instance into line. Safe to call repeatedly — it is how edits
// made inside one instance reach the others.
async function applyConfigSync() {
  const doOptions = syncEnabled("options"), doServers = syncEnabled("servers");
  if (!doOptions && !doServers) return { success: true, skipped: true };

  const profiles = await loadProfiles();
  fs.mkdirSync(sharedCfgDir(), { recursive: true });
  let dirty = false;

  if (doOptions) {
    const shared = sharedCfgPath("options.txt");
    for (const p of profiles) {
      if (p.noSyncOptions || p.installing) continue;
      relinkToShared(instanceFile(p.id, "options.txt"), shared);
    }
  }

  if (doServers) {
    const shared = sharedCfgPath("servers.dat");
    let sharedList = await readServersFrom(shared);

    // servers.dat is saved by renaming a temp file over it in every version
    // checked (see relinkToShared), so a linked instance that has run the game
    // is ALWAYS detached, sitting on an edit the shared copy has never seen.
    // Adopt it BEFORE anything rewrites the shared file: that instance's file
    // WAS the shared file, so its content is the shared content. This is the
    // normal path, not a fallback. Newest wins if two of them differ, which is
    // the honest answer for two sessions that both edited their server list.
    let newest = null;
    const sharedAt = fs.existsSync(shared) ? fs.statSync(shared).mtimeMs : 0;
    for (const p of profiles) {
      if (p.noSyncServers || p.installing || ownsServers(p)) continue;
      const f = instanceFile(p.id, "servers.dat");
      if (!fs.existsSync(f) || sameFile(f, shared)) continue;
      const m = fs.statSync(f).mtimeMs;
      if (m > sharedAt && (!newest || m > newest.m)) newest = { f, m };
    }
    if (newest) sharedList = await readServersFrom(newest.f);

    // Merged instances next: they can contribute new entries to the shared
    // list, and the linked ones should get those too.
    for (const p of profiles) {
      if (p.noSyncServers || p.installing || !ownsServers(p)) continue;
      const res = await mergeServersFor(p, sharedList);
      sharedList = res.shared;
      const ownRecord = res.own.map(s => ({ name: s.name, ip: s.ip }));
      if (JSON.stringify(p.ownServers || null) !== JSON.stringify(ownRecord)) { p.ownServers = ownRecord; dirty = true; }
    }
    await writeServersIfChanged(shared, sharedList);

    for (const p of profiles) {
      if (p.noSyncServers || p.installing || ownsServers(p)) continue;
      relinkToShared(instanceFile(p.id, "servers.dat"), shared);
    }
    // The merged files were written before the promotions from LATER instances
    // were known, so give them the finished list.
    for (const p of profiles) {
      if (p.noSyncServers || p.installing || !ownsServers(p)) continue;
      const res = await mergeServersFor(p, sharedList);
      if (JSON.stringify(p.syncedServers || null) !== JSON.stringify(res.syncedKeys)) { p.syncedServers = res.syncedKeys; dirty = true; }
    }
  }

  if (dirty) saveProfiles(profiles);
  return { success: true };
}

// Turning a toggle on: seed the shared copy from the instance the user picked,
// then bring everything into line with it.
ipcMain.handle("sync:enable", async (event, { kind, sourceId }) => {
  try {
    const file = kind === "servers" ? "servers.dat" : "options.txt";
    const src = instanceFile(sourceId, file);
    fs.mkdirSync(sharedCfgDir(), { recursive: true });
    if (fs.existsSync(src)) fs.copyFileSync(src, sharedCfgPath(file));
    else if (kind === "servers") writeServersTo(sharedCfgPath(file), []);
    else fs.writeFileSync(sharedCfgPath(file), "");
    settings.set(kind === "servers" ? "syncServers" : "syncOptions", true);
    await applyConfigSync();
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err && err.message || err) };
  }
});

// Turning it off leaves every instance with its own real copy of what it had,
// rather than a link that would keep changing underneath it.
ipcMain.handle("sync:disable", async (event, { kind }) => {
  try {
    const file = kind === "servers" ? "servers.dat" : "options.txt";
    const shared = sharedCfgPath(file);
    const profiles = await loadProfiles();
    for (const p of profiles) {
      const target = instanceFile(p.id, file);
      if (!sameFile(target, shared)) continue;
      fs.unlinkSync(target);
      fs.copyFileSync(shared, target);
    }
    settings.set(kind === "servers" ? "syncServers" : "syncOptions", false);
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err && err.message || err) };
  }
});

ipcMain.handle("sync:apply", () => applyConfigSync());

// Every saved server across every instance, for the merge picker. Entries that
// appear in more than one instance are flagged so the UI can leave the repeats
// unticked by default — the usual case is the same server saved in five
// instances, and ticking all five would just add it five times.
ipcMain.handle("sync:allServers", async () => {
  const profiles = await loadProfiles();
  const seen = new Map();   // key -> entry
  for (const p of profiles) {
    let list = [];
    try { list = await readServersFrom(instanceFile(p.id, "servers.dat")); } catch { continue; }
    for (const s of list) {
      const key = serverKey(s);
      const existing = seen.get(key);
      if (existing) { existing.count++; existing.from.push(p.name || String(p.id)); continue; }
      seen.set(key, {
        key, name: s.name || "", ip: s.ip || "", icon: s.icon || null,
        acceptTextures: s.acceptTextures ?? 1,
        count: 1, from: [p.name || String(p.id)],
      });
    }
  }
  // Group by ADDRESS, not by name+address. The same server saved under
  // different names in different instances is still one server, and listing it
  // three times asked the user to notice that themselves. Each group carries
  // every name it was saved under so one can be picked.
  const byIp = new Map();
  for (const e of seen.values()) {
    const ip = String(e.ip || "").trim().toLowerCase();
    const g = byIp.get(ip);
    if (g) {
      g.names.push({ name: e.name, count: e.count, from: e.from });
      g.count += e.count;
      for (const f of e.from) if (!g.from.includes(f)) g.from.push(f);
      if (!g.icon && e.icon) g.icon = e.icon;
    } else {
      byIp.set(ip, {
        key: ip, ip: e.ip, icon: e.icon, acceptTextures: e.acceptTextures,
        names: [{ name: e.name, count: e.count, from: e.from }],
        count: e.count, from: e.from.slice(),
      });
    }
  }
  return [...byIp.values()].map(g => {
    // Most-used name first, so the default pick is the one most instances agree
    // on; the rest are offered beside it.
    g.names.sort((a, b) => b.count - a.count || String(a.name).localeCompare(String(b.name)));
    g.name = (g.names[0] && g.names[0].name) || g.ip;
    // How many INSTANCES have this address, which is what "saved in several
    // instances" should mean now that names are merged.
    g.count = g.from.length;
    return g;
  }).sort((a, b) => b.count - a.count || String(a.name).localeCompare(String(b.name)));
});

// Turn server syncing on from a hand-picked list rather than one instance's file.
ipcMain.handle("sync:enableMerged", async (event, { servers }) => {
  try {
    fs.mkdirSync(sharedCfgDir(), { recursive: true });
    const list = (servers || []).map(s => ({
      name: s.name, ip: s.ip, icon: s.icon || undefined,
      acceptTextures: s.acceptTextures ?? 1,
    }));
    writeServersTo(sharedCfgPath("servers.dat"), list);
    settings.set("syncServers", true);
    await applyConfigSync();
    return { success: true, count: list.length };
  } catch (err) {
    return { success: false, error: String(err && err.message || err) };
  }
});

// Per-instance opt-out. Opting back in relinks it; opting out gives it its own
// copy of whatever it was sharing.
ipcMain.handle("sync:setInstance", async (event, { profileId, kind, enabled }) => {
  try {
    const flag = kind === "servers" ? "noSyncServers" : "noSyncOptions";
    const file = kind === "servers" ? "servers.dat" : "options.txt";
    const profiles = await loadProfiles();
    const p = profiles.find(x => String(x.id) === String(profileId));
    if (!p) return { success: false, error: "no such instance" };
    if (enabled) delete p[flag]; else p[flag] = true;
    saveProfiles(profiles);
    if (!enabled) {
      const target = instanceFile(profileId, file), shared = sharedCfgPath(file);
      if (sameFile(target, shared)) { fs.unlinkSync(target); fs.copyFileSync(shared, target); }
    } else {
      await applyConfigSync();
    }
    broadcastProfiles(profiles);
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err && err.message || err) };
  }
});

ipcMain.handle("sync:status", async (event, { profileId } = {}) => {
  const out = { options: syncEnabled("options"), servers: syncEnabled("servers") };
  if (profileId != null) {
    const p = (await loadProfiles()).find(x => String(x.id) === String(profileId));
    out.instance = p ? {
      options: !p.noSyncOptions,
      servers: !p.noSyncServers,
      // A merged instance keeps its own servers on top of the shared ones.
      merged: ownsServers(p),
    } : null;
  }
  return out;
});

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
  // Keep any desktop shortcut that mirrors this server's icon in sync.
  refreshShortcutIcons().catch(() => {});
  return { success: true };
});

// Remember a favicon a ping just produced, the way the game remembers it.
//
// servers.dat has an `icon` field, and Minecraft fills it in when it pings a
// server in the multiplayer list. The launcher pinged too but kept the favicon
// on screen only, so a server you had added and pinged here still had no icon
// stored — and the icon picker, which reads servers.dat, had nothing to offer
// for it.
//
// Writes are queued per instance. readServersList awaits, so two servers
// finishing their pings at the same time would otherwise both read the old
// list and the second write would lose the first one's icon.
const _serversWriteQueue = new Map();   // profileId -> tail of the write chain
function queueServersWrite(profileId, fn) {
  const key = String(profileId);
  const prev = _serversWriteQueue.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  _serversWriteQueue.set(key, next.then(() => { }, () => { }));
  return next;
}
ipcMain.handle("remember-server-icon", async (event, { profileId, ip, icon }) => {
  const ic = normalizeServerIcon(icon);
  if (!ic || !ip || profileId == null) return { success: false };
  return queueServersWrite(profileId, async () => {
    try {
      const list = await readServersList(profileId);
      // By address, not by index: the list can have been reordered between the
      // ping going out and the answer coming back.
      const hit = list.find(s => String(s.ip || "").trim() === String(ip).trim());
      if (!hit) return { success: false, error: "no such server" };
      if (hit.icon) return { success: false, error: "already has an icon" };
      hit.icon = ic;
      await writeServersList(profileId, list);
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err && err.message || err) };
    }
  });
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
// Split "host", "host:port" (leaves bracketed IPv6 alone) into { host, port }.
function splitHostPort(addr) {
  const s = String(addr || "").trim();
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(s);
  const host = m ? m[1].replace(/^\[|\]$/g, "") : s;
  const port = m && m[2] ? parseInt(m[2], 10) : 25565;
  return { host, port };
}
// Is this a local / private-network address api.mcsrvstat.us can't reach?
function isLocalAddress(host) {
  const h = String(host || "").toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".localhost")) return true;
  if (h === "127.0.0.1" || h.startsWith("127.")) return true;
  if (h === "0.0.0.0" || h === "::1") return true;
  if (h.startsWith("10.") || h.startsWith("192.168.")) return true;
  const m = /^172\.(\d+)\./.exec(h); if (m) { const o = +m[1]; if (o >= 16 && o <= 31) return true; }
  if (/^169\.254\./.test(h)) return true; // link-local
  return false;
}

// ── Minecraft Server List Ping (SLP) — used for LAN/localhost servers that a
// public status API can't reach. Speaks the modern handshake+status protocol.
function pingMinecraft(host, port, timeout = 4000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port }, () => {
      // VarInt encoder.
      const varint = (n) => { const b = []; n >>>= 0; do { let t = n & 0x7f; n >>>= 7; if (n) t |= 0x80; b.push(t); } while (n); return Buffer.from(b); };
      const str = (s) => { const d = Buffer.from(s, "utf8"); return Buffer.concat([varint(d.length), d]); };
      const packet = (id, payload) => { const body = Buffer.concat([varint(id), payload]); return Buffer.concat([varint(body.length), body]); };
      const portBuf = Buffer.alloc(2); portBuf.writeUInt16BE(port & 0xffff, 0);
      const handshake = packet(0x00, Buffer.concat([varint(765), str(host), portBuf, varint(1)])); // 765≈1.20.5 proto; server ignores exact value for status
      sock.write(Buffer.concat([handshake, packet(0x00, Buffer.alloc(0))])); // + status request
    });
    sock.setTimeout(timeout);
    let buf = Buffer.alloc(0);
    const done = (v) => { try { sock.destroy(); } catch { } resolve(v); };
    // Streaming VarInt reader.
    const readVarInt = (b, off) => { let res = 0, shift = 0, pos = off; while (pos < b.length) { const byte = b[pos++]; res |= (byte & 0x7f) << shift; if (!(byte & 0x80)) return { value: res >>> 0, size: pos - off }; shift += 7; if (shift > 35) break; } return null; };
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const lenR = readVarInt(buf, 0); if (!lenR) return;
      if (buf.length < lenR.size + lenR.value) return; // wait for the full packet
      let off = lenR.size;
      const idR = readVarInt(buf, off); if (!idR) return done({ online: false }); off += idR.size;
      const strLen = readVarInt(buf, off); if (!strLen) return done({ online: false }); off += strLen.size;
      const json = buf.subarray(off, off + strLen.value).toString("utf8");
      try { done({ online: true, raw: JSON.parse(json) }); }
      catch { done({ online: false }); }
    });
    sock.on("timeout", () => done({ online: false }));
    sock.on("error", () => done({ online: false }));
  });
}

ipcMain.handle("get-server-status", async (event, { ip }) => {
  if (!ip) return { online: false };
  let { host, port } = splitHostPort(ip);
  const hadExplicitPort = /:\d+$/.test(String(ip).trim());
  const isIpLiteral = /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":");

  // Resolve a Minecraft SRV record for public hostnames with no explicit port so
  // we can reach the actual host:port directly (many networks publish these).
  if (!hadExplicitPort && !isLocalAddress(host) && !isIpLiteral) {
    try {
      const rec = await dns.promises.resolveSrv(`_minecraft._tcp.${host}`);
      if (rec && rec.length) { host = rec[0].name; port = rec[0].port; }
    } catch { /* no SRV — use host:25565 */ }
  }

  // Talk to the server DIRECTLY (Server List Ping) — no third party in the
  // middle. This returns the real MOTD component, so gradient/per-character
  // colours survive instead of being collapsed by a status API.
  try {
    const r = await pingMinecraft(host, port);
    if (r.online) {
      const d = r.raw || {};
      return {
        online: true,
        motd: d.description != null ? d.description : null, // chat component or legacy string
        players: d.players ? { online: d.players.online, max: d.players.max } : null,
        version: d.version && d.version.name ? d.version.name : null,
        icon: d.favicon || null, // already a data: URL
      };
    }
  } catch { /* fall through to the public API */ }

  // Local servers can't be reached any other way — if the direct ping failed
  // they're simply offline.
  if (isLocalAddress(host)) return { online: false };

  // Fallback for public servers a direct ping couldn't reach (odd NAT/proxy,
  // ping disabled, etc.). The API can't render gradients but is a safety net.
  try {
    const res = await fetch(`https://api.mcsrvstat.us/3/${encodeURIComponent(ip)}`, {
      headers: { "User-Agent": LAUNCHER_UA }
    });
    const d = await res.json();
    const motdRaw = d.motd?.raw ? d.motd.raw.join("\n").trim() : null;
    const motdClean = d.motd?.clean ? d.motd.clean.join("\n").trim() : null;
    return {
      online: !!d.online,
      motd: motdRaw || motdClean || null,
      players: d.players ? { online: d.players.online, max: d.players.max } : null,
      version: d.version || null,
      icon: d.icon || null
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

// A Modrinth version's changelog, for the "these will be updated" list. Only
// fetched for the row actually opened, and kept for the rest of the run: a
// published changelog does not change.
const _changelogs = new Map();
ipcMain.handle("modrinth:changelog", async (event, { versionId }) => {
  const id = String(versionId || "");
  if (!id) return { error: "No version" };
  if (_changelogs.has(id)) return _changelogs.get(id);
  try {
    const res = await fetch(`https://api.modrinth.com/v2/version/${encodeURIComponent(id)}`, { headers: { "User-Agent": LAUNCHER_UA } });
    if (!res.ok) return { error: `Modrinth answered ${res.status}` };
    const v = await res.json();
    const out = {
      changelog: v.changelog || "",
      name: v.name || v.version_number || "",
      versionNumber: v.version_number || "",
      datePublished: v.date_published || null,
    };
    _changelogs.set(id, out);
    return out;
  } catch (e) { return { error: e.message }; }
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

// Delete a mod/pack/shader file from an instance (and drop it from options.txt
// if it's an enabled resource pack).
ipcMain.handle("delete-instance-mod", async (event, { profileId, tab, filename }) => {
  try {
    const dir = path.join(dataDir, "client", String(profileId), tab);
    const full = path.join(dir, filename);
    // Guard against path traversal via a crafted filename.
    if (path.dirname(full) !== dir) return { success: false, error: "Invalid filename" };
    if (fs.existsSync(full)) fs.unlinkSync(full);
    if (tab === "resourcepacks") {
      const packs = readEnabledResourcePacks(profileId).filter(p => p !== "file/" + filename);
      writeEnabledResourcePacks(profileId, packs);
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Dev mods: watch a mod project's build-output folder and hot-swap the freshly
// built jar into an instance/server whenever a new compatible build appears —
// so you can iterate on your own mod without reinstalling each time.
const devModsPath = path.join(dataDir, "devmods.json");
function loadDevModsStore() { try { return JSON.parse(fs.readFileSync(devModsPath, "utf8")); } catch { return {}; } }
function saveDevModsStore(o) { try { fs.writeFileSync(devModsPath, JSON.stringify(o, null, 2)); } catch { /* ignore */ } }
const devModKey = (type, id) => `${type}:${id}`;

function devModTarget(type, id) {
  if (type === "server") {
    let info = null; try { info = serverManager.getServerInfo(id); } catch { /* ignore */ }
    return { modsDir: path.join(dataDir, "servers", String(id), "mods"), loader: String((info && info.type) || "").toLowerCase() };
  }
  // Read the profiles file directly (synchronously) — loadProfiles() is async
  // (returns a Promise), so .find on it would throw. Order doesn't matter here.
  let p = null;
  try { const arr = JSON.parse(fs.readFileSync(profilesPath, "utf8")); if (Array.isArray(arr)) p = arr.find(x => String(x.id) === String(id)); } catch { /* ignore */ }
  return { modsDir: path.join(dataDir, "client", String(id), "mods"), loader: String((p && p.loader) || "").toLowerCase() };
}

// A jar's declared mod id + loader(s), read from its manifest (Fabric/Quilt/
// Forge/NeoForge/legacy). Returns null if it isn't a recognizable mod jar.
function readJarModInfo(jarPath) {
  try {
    const zip = new AdmZip(jarPath);
    const get = (n) => { const e = zip.getEntry(n); return e ? e.getData().toString("utf8") : null; };
    const fmj = get("fabric.mod.json");
    if (fmj) { try { const j = JSON.parse(fmj); if (j.id) return { id: j.id, loaders: ["fabric", "quilt"] }; } catch { /* ignore */ } }
    const qmj = get("quilt.mod.json");
    if (qmj) { try { const j = JSON.parse(qmj); const id = (j.quilt_loader && j.quilt_loader.id) || j.id; if (id) return { id, loaders: ["quilt", "fabric"] }; } catch { /* ignore */ } }
    const neo = get("META-INF/neoforge.mods.toml");
    const forge = get("META-INF/mods.toml");
    const toml = neo || forge;
    if (toml) { const m = toml.match(/modId\s*=\s*["']([^"']+)["']/); if (m) return { id: m[1], loaders: neo ? ["neoforge"] : ["forge", "neoforge"] }; }
    const mci = get("mcmod.info");
    if (mci) { try { const a = JSON.parse(mci); const m = Array.isArray(a) ? a[0] : (a.modList && a.modList[0]); if (m && m.modid) return { id: m.modid, loaders: ["forge"] }; } catch { /* ignore */ } }
  } catch { /* ignore */ }
  return null;
}

// Newest real build jar in a folder (ignores -sources/-dev/-javadoc artifacts).
function newestJar(folder) {
  try {
    const files = fs.readdirSync(folder)
      .filter(f => /\.jar$/i.test(f) && !/-(sources|dev|javadoc|slim)\.jar$/i.test(f))
      .map(f => ({ f, m: fs.statSync(path.join(folder, f)).mtimeMs })).sort((a, b) => b.m - a.m);
    return files.length ? path.join(folder, files[0].f) : null;
  } catch { return null; }
}

// A build writes the jar in place, so the watcher can fire (and the debounce can
// elapse) while Gradle is still writing it -- which is how a truncated,
// unopenable jar ended up in the instance. Wait until the file stops changing
// AND parses as a zip before touching it.
function fileSignature(file) {
  try { const st = fs.statSync(file); return st.size + ":" + st.mtimeMs; } catch { return null; }
}
function looksLikeCompleteJar(file) {
  try {
    // A partial jar has no readable central directory, so this throws.
    const entries = new AdmZip(file).getEntries();
    return Array.isArray(entries) && entries.length > 0;
  } catch { return false; }
}
async function waitForStableJar(file, { tries = 40, interval = 150 } = {}) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    const sig = fileSignature(file);
    if (sig === null) return false;                       // vanished mid-build
    if (sig === last && !sig.startsWith("0:") && looksLikeCompleteJar(file)) return true;
    last = sig;
    await new Promise(r => setTimeout(r, interval));
  }
  return false;   // still churning after ~6s: leave the old jar in place
}

// Clear out whatever copy of this mod is already in the folder, and say
// whether it was switched OFF.
//
// A dev mod is disabled the way every other mod is: its jar is renamed with a
// `.disabled` suffix. The swap used to delete whatever it found and write the
// enabled name back, so turning a dev mod off lasted exactly until the next
// build, refresh or launch — which is what "disabling a dev mod doesn't
// disable it, it just gets the new one and puts it in the enabled place"
// means. The build that goes in keeps the state the one coming out had.
function clearDevModJars(modsDir, destName, modId, info) {
  let found = 0, off = 0;
  for (const f of fs.readdirSync(modsDir)) {
    if (!/\.jar(\.disabled)?$/i.test(f)) continue;
    const full = path.join(modsDir, f);
    // The dev filename, or any jar declaring the same mod id. Read the file
    // where it actually is: stripping `.disabled` first asked about a path
    // that does not exist, so a disabled jar's id never matched.
    let mine = f.replace(/\.disabled$/i, "") === destName;
    if (!mine) {
      const ex = readJarModInfo(full);
      mine = !!(ex && (ex.id === modId || (info && ex.id === info.id)));
    }
    if (!mine) continue;
    found++;
    if (/\.disabled$/i.test(f)) off++;
    try { fs.unlinkSync(full); } catch { /* ignore */ }
  }
  // Every copy of it has to be off for the mod to be off: one enabled jar of
  // it means the mod is on.
  return found > 0 && off === found;
}

// Copy the newest matching build into the target's mods folder, replacing any
// existing jar that declares the same mod id. `pinnedJar` (set by "pick a
// build") wins over the newest, so a deliberate choice survives a refresh.
async function swapDevMod(type, id, modId, folder, pinnedJar) {
  try {
    let jar = null;
    if (pinnedJar) {
      const pinned = path.join(folder, pinnedJar);
      if (fs.existsSync(pinned)) jar = pinned;
    }
    if (!jar) jar = newestJar(folder);
    if (!jar) return { success: false, error: "No built jar in that folder yet" };
    if (!await waitForStableJar(jar)) return { success: false, error: "The jar is still being written" };
    const info = readJarModInfo(jar);
    const tgt = devModTarget(type, id);
    // Only hard-fail on a clear loader mismatch. A missing manifest or a differing
    // declared id is fine — we trust the registered mod id (some dev builds have no
    // manifest yet, or the id was entered manually).
    if (info && info.loaders && tgt.loader && !info.loaders.includes(tgt.loader)) return { success: false, error: `Built for ${info.loaders.join("/")}, not ${tgt.loader}` };
    fs.mkdirSync(tgt.modsDir, { recursive: true });
    // Replace any existing jar of the same mod id (matched by the built jar's
    // detected id OR our own dev filename) — but it's fine if none exists.
    const destName = `${modId}-dev.jar`;
    const off = clearDevModJars(tgt.modsDir, destName, modId, info);
    const dest = destName + (off ? ".disabled" : "");
    // Taken BEFORE the copy: a build that is still being written would be
    // stamped as whatever it happened to be mid-write otherwise, and the next
    // catch-up would think the finished one was already in.
    const from = buildStamp(jar);
    fs.copyFileSync(jar, path.join(tgt.modsDir, dest));
    return { success: true, jar: path.basename(jar), dest, disabled: off, from };
  } catch (e) { return { success: false, error: e.message }; }
}

// ── What folder the user actually picked ─────────────────────────────────────
//
// A dev mod used to be registered by its build-output folder and nothing
// else, so you had to know to pick `build/libs` and nothing above it. Any of
// the three is now accepted: the project root, its `build` folder, or
// `build/libs` itself. The jars are read from whichever of them has them, and
// the project root is kept separately, because that is what a rebuild runs in.
const GRADLE_MARKERS = ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "gradlew", "gradlew.bat"];
const isGradleProject = (dir) => {
  try { return GRADLE_MARKERS.some(f => fs.existsSync(path.join(dir, f))); } catch { return false; }
};
// The project this folder belongs to, looked for at it and above it. A
// multi-project build puts a subproject's jars in `<sub>/build/libs`, and
// `gradlew` lives at the top, so the top is what gets run.
function gradleRootFor(dir) {
  let cur = null;
  try { cur = path.resolve(dir); } catch { return null; }
  let found = null;
  for (let i = 0; i < 8; i++) {
    if (isGradleProject(cur)) found = cur;
    // Keep going up: a wrapper at the top beats a build file in a subproject.
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
    if (found && !isGradleProject(cur)) break;
  }
  return found;
}

function resolveDevModFolder(picked) {
  if (!picked) return { jarDir: null, root: null };
  const candidates = [picked, path.join(picked, "libs"), path.join(picked, "build", "libs")];
  let jarDir = candidates.find(d => newestJar(d)) || null;
  if (!jarDir) {
    // Nothing built yet, which is fine -- it can be built from here. Guess
    // where the jars will land from what the folder looks like.
    if (isGradleProject(picked)) jarDir = path.join(picked, "build", "libs");
    else if (fs.existsSync(path.join(picked, "libs"))) jarDir = path.join(picked, "libs");
    else jarDir = picked;
  }
  return { jarDir, root: gradleRootFor(jarDir) };
}

// ── Building a dev mod from the launcher ─────────────────────────────────────
//
// Which Java the project wants, read from the build script. Gradle will not
// run at all on the wrong major -- and it is the project's requirement, not
// the game's, so the instance's Java is the wrong answer.
const MC_JAVA = [[[1, 20, 5], 21], [[1, 18, 0], 17], [[1, 17, 0], 16]];
function javaForMinecraftVersion(v) {
  const parts = String(v || "").split(".").map(n => parseInt(n, 10) || 0);
  for (const [at, major] of MC_JAVA) {
    for (let i = 0; i < 3; i++) {
      if ((parts[i] || 0) > (at[i] || 0)) return major;
      if ((parts[i] || 0) < (at[i] || 0)) break;
      if (i === 2) return major;
    }
  }
  return 8;
}
function requiredJavaForProject(root) {
  const read = (f) => { try { return fs.readFileSync(path.join(root, f), "utf8"); } catch { return ""; } };
  const scripts = read("build.gradle") + "\n" + read("build.gradle.kts");
  // The toolchain is the modern and most explicit statement of it.
  let m = scripts.match(/JavaLanguageVersion\.of\(\s*(\d+)\s*\)/);
  if (m) return parseInt(m[1], 10);
  // JavaVersion.VERSION_21, and VERSION_1_8 for the old numbering.
  m = scripts.match(/JavaVersion\.VERSION_1_(\d+)/);
  if (m) return parseInt(m[1], 10);
  m = scripts.match(/JavaVersion\.VERSION_(\d+)/);
  if (m) return parseInt(m[1], 10);
  m = scripts.match(/(?:source|target)Compatibility\s*=?\s*["']?(?:1\.)?(\d+)["']?/);
  if (m) return parseInt(m[1], 10);
  m = scripts.match(/release(?:\.set\(|\s*=\s*)\s*(\d+)/);
  if (m) return parseInt(m[1], 10);
  // Nothing said: go by the Minecraft version it builds against, which every
  // mod template puts in gradle.properties.
  const props = read("gradle.properties");
  m = props.match(/^\s*minecraft_version\s*=\s*(\S+)/m) || props.match(/^\s*minecraft\s*=\s*(\S+)/m);
  if (m) return javaForMinecraftVersion(m[1]);
  return 17;
}

const devBuilds = new Map();                 // key -> { child, lines }
function devBuildKey(type, id, folder) { return `${type}:${id}:${folder}`; }

// Run the project's own Gradle, on the Java it asks for, taken from the
// launcher's own downloads rather than whatever happens to be on PATH.
async function buildDevMod({ type, id, folder, root, onLine }) {
  const projectRoot = root || gradleRootFor(folder);
  if (!projectRoot) return { success: false, error: "No Gradle project above that folder" };

  const major = requiredJavaForProject(projectRoot);
  let javaBin;
  try { javaBin = await getJavaByMajor(major, { needJdk: true, label: `building ${path.basename(projectRoot)}` }); }
  catch (e) { return { success: false, error: `Java ${major} is needed to build this and could not be prepared: ${e.message}` }; }
  const home = javaHomeOf(javaBin);

  const isWin = process.platform === "win32";
  const wrapper = path.join(projectRoot, isWin ? "gradlew.bat" : "gradlew");
  let cmd, args;
  if (fs.existsSync(wrapper)) {
    // A wrapper checked out of git on a Unix box often arrives without its
    // executable bit, and then nothing will run it.
    if (!isWin) { try { fs.chmodSync(wrapper, 0o755); } catch { /* it may not be ours */ } }
    cmd = wrapper;
    args = [];
  } else {
    cmd = isWin ? "gradle.bat" : "gradle";
    args = [];
  }
  // `build` without the tests: a mod's tests are rarely set up and a failing
  // one should not stop the jar being produced.
  args.push("build", "-x", "test", `-Dorg.gradle.java.home=${home}`, "--console=plain");

  const lines = [];
  const say = (line) => { lines.push(line); if (onLine) { try { onLine(line); } catch { /* ignore */ } } };
  say(`> ${path.basename(cmd)} ${args.join(" ")}`);
  say(`  in ${projectRoot}`);
  say(`  with Java ${major} at ${home}`);

  const key = devBuildKey(type, id, folder);
  const out = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: projectRoot,
        env: { ...process.env, JAVA_HOME: home, GRADLE_OPTS: "-Dorg.gradle.daemon=false" },
        windowsHide: true,
        shell: isWin,              // gradlew.bat is a batch file
      });
    } catch (e) { resolve({ success: false, error: e.message }); return; }
    devBuilds.set(key, { child, lines });
    let rest = "";
    const feed = (buf) => {
      rest += buf.toString();
      const parts = rest.split(/\r?\n/);
      rest = parts.pop();
      parts.forEach(say);
    };
    child.stdout && child.stdout.on("data", feed);
    child.stderr && child.stderr.on("data", feed);
    child.on("error", (e) => {
      say(`! ${e.message}`);
      resolve({
        success: false,
        error: e.code === "ENOENT"
          ? "No gradlew in the project and no gradle on the PATH"
          : e.message,
      });
    });
    child.on("close", (code) => {
      if (rest) say(rest);
      resolve(code === 0
        ? { success: true }
        : { success: false, error: `Gradle exited with ${code}` });
    });
  });
  devBuilds.delete(key);
  return { ...out, lines, java: major, root: projectRoot };
}

const devWatchers = new Map(); // key -> [ { watcher, timer } ]
function stopDevWatch(type, id) {
  const k = devModKey(type, id);
  (devWatchers.get(k) || []).forEach(w => { try { w.watcher.close(); } catch { /* ignore */ } clearTimeout(w.timer); });
  devWatchers.delete(k);
}
function startDevWatch(type, id) {
  stopDevWatch(type, id);
  const entry = loadDevModsStore()[devModKey(type, id)];
  if (!entry || !entry.enabled || !Array.isArray(entry.mods)) return;
  const ws = [];
  entry.mods.forEach(m => {
    if (!m.folder || !fs.existsSync(m.folder)) return;
    const w = { watcher: null, timer: null };
    try {
      w.watcher = fs.watch(m.folder, { persistent: false }, (ev, fn) => {
        if (fn && !/\.jar$/i.test(fn)) return;
        clearTimeout(w.timer);
        w.timer = setTimeout(async () => {
          // Re-read the entry: the pinned build may have changed since the
          // watcher was set up.
          const cur = ((loadDevModsStore()[devModKey(type, id)] || {}).mods || []).find(x => x.folder === m.folder) || m;
          const r = await swapDevMod(type, id, m.modId, m.folder, cur.pinnedJar);
          if (r.success) rememberDevBuild(type, id, m.folder, r.from);
          if (r.success && type === "instance") broadcastLog(id, `[dev-mod] swapped ${m.modId} -> ${r.jar}`);
          else if (r.success) devtoolsLog(`[dev-mod] ${type} ${id}: swapped ${m.modId} -> ${r.jar}`);
        }, 700); // debounce — a build writes several files
      });
      ws.push(w);
    } catch { /* unwatchable */ }
  });
  devWatchers.set(devModKey(type, id), ws);
}
// Bring every registered dev mod up to the newest build in its folder. The file
// watcher only sees changes while the launcher is RUNNING, so a mod rebuilt while
// it was closed would otherwise stay stale — this catches up at startup and again
// right before each launch.
// What a build was when it was last copied in, so the catch-up can tell
// whether there is anything to do. Comparing the two FILES instead cannot:
// a copy has the same size by definition, and its timestamp is the moment it
// was made, which for a small jar can be the same millisecond the build was
// written -- so a rebuild would read as already in place.
const buildStamp = (file) => {
  try { const st = fs.statSync(file); return `${path.basename(file)}|${st.size}|${Math.round(st.mtimeMs)}`; }
  catch { return null; }
};

// Is this build already where it belongs? Only when it is the one that was
// copied, unchanged since, and the copy is still in the instance. A rebuild,
// a different jar pinned, or a mod deleted out of the instance all fail that
// and get copied again.
function devModInPlace(type, id, modId, src, had) {
  if (!had) return false;
  const now = buildStamp(src);
  if (!now || now !== had) return false;
  const dir = devModTarget(type, id).modsDir;
  const dest = path.join(dir, `${modId}-dev.jar`);
  return fs.existsSync(dest) || fs.existsSync(dest + ".disabled");
}

async function syncDevMods(type, id) {
  const entry = loadDevModsStore()[devModKey(type, id)];
  if (!entry || !entry.enabled || !Array.isArray(entry.mods)) return;
  for (const m of entry.mods) {
    if (!m.folder || !m.modId) continue;
    try {
      // The catch-up runs at startup AND before every launch, and it used to
      // copy the jar again whatever had happened -- which meant waiting for
      // the file to settle first, up to six seconds a mod, for nothing.
      const src = (m.pinnedJar && fs.existsSync(path.join(m.folder, m.pinnedJar)))
        ? path.join(m.folder, m.pinnedJar)
        : newestJar(m.folder);
      if (src && devModInPlace(type, id, m.modId, src, m.builtFrom)) continue;
      const r = await swapDevMod(type, id, m.modId, m.folder, m.pinnedJar);
      if (r && r.success) {
        devtoolsLog(`[dev-mod] ${type} ${id}: caught up ${m.modId} -> ${r.jar}`);
        rememberDevBuild(type, id, m.folder, r.from);
      }
    } catch (e) { devtoolsLog("[dev-mod] catch-up failed:", e.message); }
  }
}

// Note which build is in the instance now, so the next catch-up can tell
// there is nothing to do.
function rememberDevBuild(type, id, folder, stamp) {
  if (!stamp) return;
  try {
    const store = loadDevModsStore(); const k = devModKey(type, id);
    const m = store[k] && Array.isArray(store[k].mods) ? store[k].mods.find(x => x.folder === folder) : null;
    if (!m || m.builtFrom === stamp) return;
    m.builtFrom = stamp;
    saveDevModsStore(store);
  } catch { /* a note that cannot be written only costs one extra copy */ }
}
function startAllDevWatchers() {
  const store = loadDevModsStore();
  Object.keys(store).forEach(k => {
    const [type, ...rest] = k.split(":"); const id = rest.join(":");
    if (store[k] && store[k].enabled) { syncDevMods(type, id).catch(() => { }); startDevWatch(type, id); }
  });
}

ipcMain.handle("devmod:get", (event, { type, id }) => loadDevModsStore()[devModKey(type, id)] || { enabled: false, mods: [] });
ipcMain.handle("devmod:setEnabled", (event, { type, id, enabled }) => {
  const store = loadDevModsStore(); const k = devModKey(type, id);
  store[k] = store[k] || { enabled: false, mods: [] };
  store[k].enabled = !!enabled;
  saveDevModsStore(store); startDevWatch(type, id);
  return { success: true, ...store[k] };
});
ipcMain.handle("devmod:pickFolder", async () => {
  const r = await dialog.showOpenDialog({
    title: "Select the mod's project folder, its build folder, or build/libs",
    properties: ["openDirectory"],
  });
  if (r.canceled || !r.filePaths.length) return { canceled: true };
  return devModFolderInfo(r.filePaths[0]);
});

// What a picked folder is: where its jars are, what project it belongs to,
// what mod it builds, and whether it can be built from here.
function devModFolderInfo(picked) {
  const { jarDir, root } = resolveDevModFolder(picked);
  const jar = jarDir ? newestJar(jarDir) : null;
  const info = jar ? readJarModInfo(jar) : null;
  return {
    picked,
    folder: jarDir,
    root,
    modId: (info && info.id) || null,
    jar: jar ? path.basename(jar) : null,
    buildable: !!root,
    java: root ? requiredJavaForProject(root) : null,
  };
}
ipcMain.handle("devmod:inspect", (event, { folder } = {}) => devModFolderInfo(folder));

// Every dev mod registered anywhere, for the "add a dev mod" dialog -- the
// usual case is the same handful of projects being added to one instance
// after another, and typing the path again each time is the slow way.
// A folder that has gone is reported as such rather than offered.
ipcMain.handle("devmod:known", (event, { type, id } = {}) => {
  const store = loadDevModsStore();
  const here = new Set(((store[devModKey(type, id)] || {}).mods || []).map(m => m.folder));
  const seen = new Map();
  for (const [k, entry] of Object.entries(store)) {
    for (const m of (entry && entry.mods) || []) {
      if (!m || !m.folder) continue;
      const was = seen.get(m.folder);
      const row = was || {
        folder: m.folder, modId: m.modId, root: m.root || gradleRootFor(m.folder),
        exists: fs.existsSync(m.folder), usedBy: [], added: here.has(m.folder),
      };
      if (!was) seen.set(m.folder, row);
      // Where else it is in use, by name, so it is recognisable.
      const [t, ...rest] = k.split(":");
      row.usedBy.push({ type: t, id: rest.join(":"), name: instanceDisplayName(t, rest.join(":")) });
    }
  }
  const all = [...seen.values()];
  for (const r of all) {
    const jar = r.exists ? newestJar(r.folder) : null;
    r.jar = jar ? path.basename(jar) : null;
    r.builtAt = jar ? (() => { try { return fs.statSync(jar).mtimeMs; } catch { return null; } })() : null;
    // "Still a valid mod": the folder is there and has a jar that reads as a
    // mod, or it is a project that can be built into one.
    r.valid = !!(r.exists && (jar || gradleRootFor(r.folder)));
    r.buildable = !!(r.root && isGradleProject(r.root));
  }
  // The ones already in this instance last, the newest build first.
  all.sort((a, b) => (a.added === b.added ? (b.builtAt || 0) - (a.builtAt || 0) : a.added ? 1 : -1));
  return { success: true, mods: all };
});

// An instance's or server's name, for saying where a dev mod is already used.
function instanceDisplayName(type, id) {
  try {
    if (type === "server") {
      const info = serverManager.getServerInfo(id);
      return (info && info.name) || String(id);
    }
    const arr = JSON.parse(fs.readFileSync(profilesPath, "utf8"));
    const p = Array.isArray(arr) ? arr.find(x => String(x.id) === String(id)) : null;
    return (p && p.name) || String(id);
  } catch { return String(id); }
}

ipcMain.handle("devmod:add", async (event, { type, id, folder, modId, root }) => {
  if (!folder) return { success: false, error: "A folder is required" };
  // Accept the project root, its build folder, or build/libs -- whichever was
  // handed over, work out which is which.
  const resolved = resolveDevModFolder(folder);
  const jarDir = resolved.jarDir || folder;
  const projectRoot = root || resolved.root || null;
  // The mod id can be read off the built jar, so it is only required when
  // there is no jar to read it from.
  let useId = modId;
  if (!useId) {
    const jar = newestJar(jarDir);
    const info = jar ? readJarModInfo(jar) : null;
    useId = (info && info.id) || null;
  }
  if (!useId) return { success: false, error: "No built jar to read the mod id from — build it first, or type the id in" };

  const store = loadDevModsStore(); const k = devModKey(type, id);
  store[k] = store[k] || { enabled: true, mods: [] };
  store[k].enabled = true;
  store[k].mods = (store[k].mods || []).filter(m => m.folder !== jarDir);
  store[k].mods.push({ folder: jarDir, modId: useId, root: projectRoot });
  saveDevModsStore(store);
  // Awaited, not fired off: the jar has to be IN the folder before this
  // returns, or the mods list reloads just too early to see it -- which is
  // why a newly added dev mod only showed up after pressing Refresh.
  const swap = await swapDevMod(type, id, useId, jarDir);
  if (swap && swap.success) rememberDevBuild(type, id, jarDir, swap.from);
  startDevWatch(type, id);
  if (swap && swap.success) announceModsChanged(type, id);
  return { success: true, mods: store[k].mods, modId: useId, folder: jarDir, root: projectRoot, swap };
});

// Tell the windows showing this instance's mods that the folder changed, so a
// dev mod appears as soon as it is added instead of on the next Refresh.
function announceModsChanged(type, id) {
  const msg = { type, id: String(id) };
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send("mods-changed", msg); } catch { /* window going away */ }
  }
}

// Build a registered dev mod with its own Gradle, streaming the output so a
// failure can be read rather than guessed at.
ipcMain.handle("devmod:build", async (event, { type, id, folder } = {}) => {
  const store = loadDevModsStore();
  const entry = store[devModKey(type, id)] || {};
  const m = (entry.mods || []).find(x => x.folder === folder);
  const root = (m && m.root) || gradleRootFor(folder);
  if (!root) return { success: false, error: "No Gradle project above that folder" };
  if (devBuilds.has(devBuildKey(type, id, folder))) return { success: false, error: "That mod is already building" };

  const send = (line) => { try { event.sender.send("devmod:buildLog", { type, id, folder, line }); } catch { /* window gone */ } };
  const r = await buildDevMod({ type, id, folder, root, onLine: send });
  if (!r.success) return r;

  // Put the fresh build in. The watcher would get there too, but only if
  // this instance has dev mods switched on and is being watched.
  const swap = await swapDevMod(type, id, m ? m.modId : null, folder, m && m.pinnedJar);
  if (swap && swap.success) {
    rememberDevBuild(type, id, folder, swap.from);
    announceModsChanged(type, id);
  }
  return { ...r, swap };
});
// List the buildable jars in a folder (for the "change version" picker), newest first.
ipcMain.handle("devmod:listJars", (event, { folder }) => {
  try {
    return fs.readdirSync(folder)
      .filter(f => /\.jar$/i.test(f) && !/-(sources|dev|javadoc|slim)\.jar$/i.test(f))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(folder, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch { return []; }
});
// Swap to a SPECIFIC jar from the folder (rather than the newest).
ipcMain.handle("devmod:swapTo", (event, { type, id, modId, folder, jar }) => {
  try {
    const src = path.join(folder, jar);
    if (!fs.existsSync(src)) return { error: "That jar no longer exists" };
    const tgt = devModTarget(type, id);
    fs.mkdirSync(tgt.modsDir, { recursive: true });
    const destName = `${modId}-dev.jar`;
    const info = readJarModInfo(src);
    // Picking a build is not the same as switching the mod back on.
    const off = clearDevModJars(tgt.modsDir, destName, modId, info);
    const dest = destName + (off ? ".disabled" : "");
    const from = buildStamp(src);
    fs.copyFileSync(src, path.join(tgt.modsDir, dest));
    // Remember the choice, or the next rebuild/refresh/startup would put the
    // newest jar back and the pick would look like it never happened -- and
    // which build is in, so the next catch-up knows there is nothing to do.
    const store = loadDevModsStore(); const k = devModKey(type, id);
    if (store[k] && Array.isArray(store[k].mods)) {
      const m = store[k].mods.find(x => x.folder === folder);
      if (m) { m.pinnedJar = jar; m.builtFrom = from; saveDevModsStore(store); }
    }
    return { success: true, dest, pinnedJar: jar, disabled: off };
  } catch (e) { return { error: e.message }; }
});

// Go back to tracking whatever the newest build is.
ipcMain.handle("devmod:unpin", async (event, { type, id, folder }) => {
  const store = loadDevModsStore(); const k = devModKey(type, id);
  const m = store[k] && Array.isArray(store[k].mods) ? store[k].mods.find(x => x.folder === folder) : null;
  if (!m) return { error: "Not registered" };
  delete m.pinnedJar;
  saveDevModsStore(store);
  const r = await swapDevMod(type, id, m.modId, m.folder);
  if (r && r.success) rememberDevBuild(type, id, m.folder, r.from);
  return r && r.success ? { success: true, dest: r.dest } : { error: (r && r.error) || "Swap failed" };
});
ipcMain.handle("devmod:remove", (event, { type, id, folder }) => {
  const store = loadDevModsStore(); const k = devModKey(type, id);
  if (store[k]) { store[k].mods = (store[k].mods || []).filter(m => m.folder !== folder); saveDevModsStore(store); startDevWatch(type, id); }
  return { success: true, mods: (store[k] && store[k].mods) || [] };
});

// Deobfuscation maps for a Fabric/Quilt MC version: intermediary names
// (class_1234 / method_5678 / field_9012) → readable Yarn names, so crash logs
// read like a dev environment instead of raw intermediary. Cached to disk.
ipcMain.handle("deobf:get", async (event, mcVersion) => {
  try {
    if (!mcVersion) return { error: "no version" };
    const cacheFile = path.join(dataDir, `deobf-${String(mcVersion).replace(/[^0-9a-zA-Z.\-]/g, "_")}.json`);
    if (fs.existsSync(cacheFile)) { try { return JSON.parse(fs.readFileSync(cacheFile, "utf8")); } catch { /* rebuild */ } }
    const list = await (await fetch(`https://meta.fabricmc.net/v2/versions/yarn/${encodeURIComponent(mcVersion)}`)).json();
    if (!Array.isArray(list) || !list.length) return { error: "No Yarn mappings for " + mcVersion };
    const ver = list[0].version; // newest build
    const jarBuf = Buffer.from(await (await fetch(`https://maven.fabricmc.net/net/fabricmc/yarn/${ver}/yarn-${ver}-v2.jar`)).arrayBuffer());
    const entry = new AdmZip(jarBuf).getEntry("mappings/mappings.tiny");
    if (!entry) return { error: "mappings.tiny missing" };
    const text = entry.getData().toString("utf8");
    const classes = {}, methods = {}, fields = {};
    for (const line of text.split("\n")) {
      if (line.startsWith("c\t")) { const p = line.split("\t"); const i = (p[1] || "").split("/").pop(); const n = (p[2] || "").split("/").pop(); if (i && n && i !== n) classes[i] = n; }
      else if (line.startsWith("\tm\t")) { const p = line.split("\t"); if (p[3] && p[4] && p[3] !== p[4]) methods[p[3]] = p[4]; }
      else if (line.startsWith("\tf\t")) { const p = line.split("\t"); if (p[3] && p[4] && p[3] !== p[4]) fields[p[3]] = p[4]; }
    }
    const out = { classes, methods, fields, yarn: ver };
    try { fs.writeFileSync(cacheFile, JSON.stringify(out)); } catch { /* ignore */ }
    return out;
  } catch (e) { return { error: e.message }; }
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
// ── Auto-update instances that track "latest release" / "latest snapshot" ─────
// These have to follow Mojang's newest version as soon as it appears, not only
// when their detail page happens to be opened (which left them filed under the
// old version in the list / version filter).
let _mcManifestCache = null, _mcManifestAt = 0;
async function getVersionManifest() {
  if (_mcManifestCache && Date.now() - _mcManifestAt < 5 * 60 * 1000) return _mcManifestCache;
  try {
    const j = await (await fetch("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json")).json();
    if (j && j.latest && Array.isArray(j.versions)) { _mcManifestCache = j; _mcManifestAt = Date.now(); }
  } catch { /* offline — keep whatever we had */ }
  return _mcManifestCache;
}

function broadcastProfiles(profiles) {
  for (const w of BrowserWindow.getAllWindows()) {
    try { if (!w.isDestroyed()) w.webContents.send("profiles-updated", profiles); } catch { /* ignore */ }
  }
}

let _autoUpdatingVersions = false;
async function autoUpdateTrackedInstances() {
  if (_autoUpdatingVersions) return;
  _autoUpdatingVersions = true;
  try {
    const manifest = await getVersionManifest();
    if (!manifest) return;
    const byId = new Map(manifest.versions.map(v => [v.id, v]));
    // Read the raw file (not loadProfiles(), which returns a SORTED copy — saving
    // that back would rewrite the user's custom order).
    let raw;
    try { raw = JSON.parse(fs.readFileSync(profilesPath, "utf8")); } catch { return; }
    if (!Array.isArray(raw)) return;

    const changed = [];
    for (const p of raw) {
      if (!(p.autoUpdateVersion ?? p.alwaysUpdate)) continue;
      if (isInstanceRunning(p.id)) continue;          // never swap under a running game
      const cur = byId.get(p.version);
      // Snapshot-tracking instances follow snapshots; everything else follows releases.
      const target = (cur && cur.type === "release") ? manifest.latest.release : manifest.latest.snapshot;
      const tgt = target ? byId.get(target) : null;
      if (!cur || !tgt || target === p.version) continue;
      if (new Date(tgt.releaseTime) <= new Date(cur.releaseTime)) continue;  // only ever move forward
      p.version = target;
      changed.push({ id: p.id, version: target, loader: p.loader });
    }
    if (!changed.length) return;

    saveProfiles(raw);
    broadcastProfiles(await loadProfiles());   // list + version filter update immediately
    for (const c of changed) {
      devtoolsLog(`[auto-update] instance ${c.id} -> ${c.version}`);
      try { await migrateContentToVersion(c.id, c.version, c.loader); }
      catch (e) { devtoolsLog(`[auto-update] migrating ${c.id} failed: ${e.message}`); }
    }
    broadcastProfiles(await loadProfiles());
  } finally { _autoUpdatingVersions = false; }
}

// Which version an instance that follows the latest would be moved to, or
// null when it does not follow anything (or the manifest cannot be had).
async function trackedVersionFor(profile) {
  if (!(profile.autoUpdateVersion ?? profile.alwaysUpdate)) return null;
  const manifest = await getVersionManifest().catch(() => null);
  if (!manifest) return null;
  const cur = manifest.versions.find(v => v.id === profile.version);
  // Snapshot-tracking instances follow snapshots; everything else releases.
  return (cur && cur.type === "release") ? manifest.latest.release : manifest.latest.snapshot;
}

ipcMain.handle("change-instance-version", async (event, { profileId, newVersion }) => {
  try {
    if (!newVersion) return { success: false, error: "No version given" };
    // The raw file, not loadProfiles(), which hands back a SORTED copy —
    // saving that back writes the current sort into the user's own order.
    let raw;
    try { raw = JSON.parse(fs.readFileSync(profilesPath, "utf8")); } catch { raw = null; }
    if (!Array.isArray(raw)) return { success: false, error: "Instances could not be read" };
    const idx = raw.findIndex(p => String(p.id) === String(profileId));
    if (idx === -1) return { success: false, error: "Instance not found" };
    const loader = raw[idx].loader;
    if (raw[idx].version === newVersion) return { success: true, report: null, unchanged: true };

    // An instance set to follow the latest version was having a hand-picked
    // version put straight back by the next sweep, which only ever moves
    // forward and so always lands on the latest again. Choosing a version by
    // hand is the clearer instruction of the two, so it wins and the
    // following is switched off — unless the choice IS what it would have
    // followed to anyway, in which case there is nothing to disagree about.
    let stoppedTracking = false;
    if (raw[idx].autoUpdateVersion ?? raw[idx].alwaysUpdate) {
      const tracked = await trackedVersionFor(raw[idx]);
      if (tracked !== newVersion) {
        raw[idx].autoUpdateVersion = false;
        if ("alwaysUpdate" in raw[idx]) raw[idx].alwaysUpdate = false;
        stoppedTracking = true;
      }
    }

    const before = { ...raw[idx] };
    raw[idx].version = newVersion;
    // An instance named after what it runs follows the change here too. This
    // only happened on the edit-profile path, which never carries the
    // version, so "my 1.21 instance" kept saying 1.21 on every other route
    // into a version change -- the version dropdown included.
    raw[idx].name = renamedForChange(before, raw[idx]);
    saveProfiles(raw);
    const report = await migrateContentToVersion(profileId, newVersion, loader);
    const sorted = await loadProfiles();
    event.reply?.("profiles-updated", sorted);
    broadcastProfiles(sorted);                 // the toggle moved; every window needs to see it
    return { success: true, report, stoppedTracking };
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

// (The throttle these two used to keep lives in refreshPlayer now — the gate
// here was shared across every account, so refreshing one blocked the rest.)
// Auth headers for a SPECIFIC account (used by cape redemption, which lets the
// user pick which premium account receives the cape). Falls back to the selected
// account when no id is given.
async function authHeadersFor(id) {
  const players = await loadPlayers();
  let obj = players.find(item => String(item.id) === String(id));
  if (!obj) throw new Error("Account not found");
  try {
    const refreshed = await refreshPlayer(obj);
    if (refreshed?.auth?.access_token) {
      obj = refreshed;
      const idx = players.findIndex(p => String(p.id) === String(id));
      if (idx !== -1) { players[idx] = obj; savePlayers(players); }
    }
  } catch { /* use existing token */ }
  const token = obj?.auth?.access_token;
  if (obj.needsReauth) throw new Error("This account's sign-in has expired — sign in again to use it");
  if (!token || token === "0") throw new Error("This account has no valid session — please sign in again");
  return { "Authorization": "Bearer " + token, "Content-Type": "application/json" };
}

async function authHeaders() {
  const id = storage.get("selectedPlayerId", null);
  const players = await loadPlayers();
  let obj = players.find(item => String(item.id) === String(id));
  if (!obj) throw new Error("No account selected");

  try {
    const refreshed = await refreshPlayer(obj);
    if (refreshed?.auth?.access_token) {
      obj = refreshed;
      const idx = players.findIndex(p => String(p.id) === String(id));
      if (idx !== -1) { players[idx] = obj; savePlayers(players); }
    }
  } catch (e) {
    devtoolsLog("authHeaders refresh failed, using existing token:", e?.message || e);
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

// Move a skin's pixels between the wide and slim models. Returns base64 of
// the converted PNG, or null when there is nothing to do (a 64x32 skin has no
// slim form, and an unreadable one is better left alone than mangled).
async function convertSkinBase64(base64, to) {
  const raw = String(base64 || "").replace(/^data:image\/\w+;base64,/, "");
  if (!raw) return null;
  try {
    const { data, info } = await sharp(Buffer.from(raw, "base64"))
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const out = convertSkinPixels(data, info.width, info.height, to);
    if (!out) return null;
    const png = await sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } })
      .png().toBuffer();
    return png.toString("base64");
  } catch { return null; }
}

// A skin whose pixels have changed is not the picture that was uploaded to
// Mojang any more. Texture ids are permanent and content addressed, so the old
// image is still up there -- but this skin is no longer it, and saying
// otherwise would point the cloud badge at a picture that is not on the card.
function forgetMojangUpload(lib, uuid, skin, wasHash) {
  delete skin.mojangUrl;
  delete skin.mojangAt;
  if (wasHash && wasHash !== skin.pixelHash) {
    setTombstones(lib, uuid, { ...tombstonesFor(lib, uuid), [wasHash]: Date.now() });
  }
}

// ── Grouping a skin library by what the skins actually look like ────────────
// A library collects variations: the same skin with a different jacket, the
// same character with and without a hat layer. Those arrive at whatever times
// they happened to be added, so they end up scattered down the grid. Comparing
// the decoded pixels puts them back together.
//
// The comparison is "how many pixels are the same", which is what you would
// count by eye. A pixel that is transparent in both counts as agreement; a
// pixel opaque in one and not the other does not.
const SIM_THRESHOLD = 0.82;   // 82% of pixels identical => a variation
const _simPixelCache = new Map();   // pixelHash -> Uint8Array(64*64*4)
const SIM_CACHE_MAX = 400;

// Decode a skin to a fixed 64x64 RGBA buffer. Legacy 64x32 skins are padded so
// every buffer is the same length and can be compared index for index.
async function skinPixels(base64, key) {
  if (key && _simPixelCache.has(key)) return _simPixelCache.get(key);
  const raw = String(base64 || "").replace(/^data:image\/\w+;base64,/, "");
  if (!raw) return null;
  let px = null;
  try {
    const img = sharp(Buffer.from(raw, "base64")).ensureAlpha();
    const meta = await img.metadata();
    if (meta.width !== 64) return null;      // not a skin sheet
    const buf = meta.height === 64
      ? await img.raw().toBuffer()
      : await img.extend({ bottom: 64 - (meta.height || 32), background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .raw().toBuffer();
    if (buf.length === 64 * 64 * 4) px = new Uint8Array(buf);
  } catch { return null; }
  if (px && key) {
    if (_simPixelCache.size >= SIM_CACHE_MAX) _simPixelCache.delete(_simPixelCache.keys().next().value);
    _simPixelCache.set(key, px);
  }
  return px;
}

// Fraction of pixels that are identical. `step` samples every Nth pixel, which
// is used as a cheap prefilter before the full pass.
function pixelAgreement(a, b, step = 1) {
  const n = 64 * 64;
  let same = 0, counted = 0;
  for (let i = 0; i < n; i += step) {
    const o = i * 4;
    const aa = a[o + 3], ba = b[o + 3];
    counted++;
    // Transparent in both is agreement -- most of a skin sheet's second layer
    // is empty, and calling that a match is what the eye does too.
    if (aa < 8 && ba < 8) { same++; continue; }
    if (aa < 8 || ba < 8) continue;
    if (a[o] === b[o] && a[o + 1] === b[o + 1] && a[o + 2] === b[o + 2]) same++;
  }
  return counted ? same / counted : 0;
}

// Order a skin list so variations of the same skin sit together.
//
// The result is a REFINEMENT of the order it was given, not a replacement: the
// first skin of each group keeps the position it already had, and its
// variations are pulled up behind it. A library nobody has reordered therefore
// groups itself, and a library somebody HAS reordered keeps their arrangement.
async function groupSkinsBySimilarity(skins) {
  const list = (skins || []).filter(Boolean);
  if (list.length < 3) return list.map((s, i) => ({ id: s.id, group: i }));

  const px = [];
  for (const s of list) px.push(await skinPixels(s.base64, s.pixelHash));

  // Union-find over "these two are variations of each other".
  const parent = list.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (i, j) => { const a = find(i), b = find(j); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); };

  for (let i = 0; i < list.length; i++) {
    if (!px[i]) continue;
    for (let j = i + 1; j < list.length; j++) {
      if (!px[j]) continue;
      if (find(i) === find(j)) continue;          // already in one group
      // Every 16th pixel first: 256 samples is enough to throw out two skins
      // that have nothing in common, and that is most pairs.
      if (pixelAgreement(px[i], px[j], 16) < SIM_THRESHOLD - 0.15) continue;
      if (pixelAgreement(px[i], px[j]) >= SIM_THRESHOLD) union(i, j);
    }
  }

  // Groups in the order their first member appears; members in their own order.
  const groups = new Map();
  list.forEach((_, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  });
  const out = [];
  let g = 0;
  for (const members of groups.values()) {
    for (const i of members) out.push({ id: list[i].id, group: g });
    g++;
  }
  return out;
}

// The display order for a library: id -> rank, plus which group each skin is
// in so the page can tell a pair of variations from two unrelated skins.
ipcMain.handle("skins:similarityOrder", async (event, { uuid }) => {
  try {
    const lib = loadSkinLib();
    const ranked = await groupSkinsBySimilarity(skinViewFor(lib, uuid));
    return ranked.map((r, i) => ({ id: r.id, rank: i, group: r.group }));
  } catch (err) {
    devtoolsLog("Could not group skins by similarity:", err && err.message);
    return [];
  }
});

// ── Player heads, drawn here rather than fetched from an avatar service ─────
// Every head in this launcher used to be an <img> pointed at minotar.net or
// mc-heads.net. Those services are rate limited, and when they throttle they do
// not fail — they answer 200 with a default Steve. So under load the accounts
// list, the sidebar and the friends panel quietly filled up with the WRONG
// faces, with nothing to tell you it had happened.
//
// A head is two 8x8 squares out of the skin sheet: the face at (8,8) and the
// hat layer at (40,8) on top of it. That composite, at 8x8, IS the head — it
// is cached once per skin and drawn at whatever size by the page, unsmoothed.
// Mojang serves the skin itself from
// textures.minecraft.net, which is a CDN for immutable content rather than a
// per-request rendering service, so this does the compositing here and keeps
// the result. When a lookup genuinely fails the answer is the DEFAULT head,
// said to be the default — never somebody else's face.
const HEADS_DIR = path.join(texturesDir, "heads");
const FACE_RECT = { left: 8, top: 8, width: 8, height: 8 };
const HAT_RECT = { left: 40, top: 8, width: 8, height: 8 };
// The last resort, if the modern default skins cannot be had at all: Mojang's
// legacy Steve and Alex, verified to be 64x64 PNGs. Everything prefers the
// nine defaults pulled out of the client jar (Ari, Efe, Kai, Makena, Noor,
// Sunny, Zuri and the two old ones), which is what the skins page shows.
const DEFAULT_SKIN_TEXTURE = {
  classic: "1a4af718455d4aab528e7a61f86fa25e6a369d1768dcb13f7df319a713eb810b",
  slim: "83cee5ca6afcdb171285aa00e8049c297b2dbeba0efb8ff970a5677a1b644032",
};
const TEXTURES_BASE = "https://textures.minecraft.net/texture/";

const HEAD_PROFILE_TTL = 6 * 60 * 60 * 1000;   // a skin change shows up within this
const HEAD_FAIL_TTL = 10 * 60 * 1000;          // don't hammer a lookup that just failed
const _headProfile = new Map();   // uuid  -> { hash, slim, at }
const _headUuid = new Map();      // name  -> { uuid, at }  (null uuid = no such player)
const _headFail = new Map();      // key   -> when to try again
const _headRendered = new Map();  // content key -> data URL of the head texture
const HEAD_RENDER_MAX = 600;

const _headFresh = (e, ttl) => !!e && (Date.now() - e.at) < ttl;
const _headCooling = (k) => Date.now() < (_headFail.get(k) || 0);
const _headCool = (k) => _headFail.set(k, Date.now() + HEAD_FAIL_TTL);

// Which default skin a UUID gets. Identical to the rule the skins page uses
// when it shows an account's default, so the head and the render agree: Java's
// UUID.hashCode() over the 128-bit value, floor-modded by however many defaults
// there are. There are nine of them now, in two models each, not just Steve
// and Alex.
function defaultSkinForUuid(uuid, list) {
  if (!list || !list.length) return null;
  const hex = String(uuid || "").replace(/-/g, "");
  if (hex.length >= 32) {
    const hi = BigInt("0x" + hex.slice(0, 16));
    const lo = BigInt("0x" + hex.slice(16, 32));
    const mask = (1n << 64n) - 1n;
    const hilo = (hi ^ lo) & mask;
    const hash = Number(BigInt.asIntN(32, (hilo >> 32n) ^ hilo));
    return list[((hash % list.length) + list.length) % list.length];
  }
  // Not a uuid at all (an offline account that never got one): hash the string
  // so at least the same name always gets the same face.
  let h = 0;
  for (let i = 0; i < hex.length; i++) h = (h * 31 + hex.charCodeAt(i)) >>> 0;
  return list[h % list.length];
}

// The legacy pair, for when the modern list is not available yet.
function legacyDefaultModel(uuid) {
  const hex = String(uuid || "").replace(/-/g, "");
  if (hex.length !== 32) return "classic";
  let h = 0;
  for (let i = 0; i < 32; i += 8) h ^= parseInt(hex.slice(i, i + 8), 16) | 0;
  return (h & 1) ? "slim" : "classic";
}

// The nine default skins, straight out of the client jar. Building that list
// means downloading a client jar, which is far too much work to do because
// somebody opened a page with a 32px head on it — so this only ever reads the
// cache, and warms it in the background when there isn't one. Until it is
// there, heads fall back to the legacy pair.
// The list is built once, at startup (see app.whenReady), and cached per
// Minecraft release, so by the time anything draws a head it is simply there.
//
// Held in memory as well as on disk. It is about 200 KB of JSON and EVERY head
// without a skin needs it, so re-reading and re-parsing the file per head —
// which is what this used to do — was a synchronous chunk of work per face on
// a page that draws a dozen of them.
let _defaultSkinsCache = null;        // { version, skins, mtime }

function readDefaultSkinsCache() {
  const f = path.join(texturesDir, "defaultskins.json");
  let mtime = 0;
  try { mtime = fs.statSync(f).mtimeMs; } catch { return _defaultSkinsCache = null; }
  if (_defaultSkinsCache && _defaultSkinsCache.mtime === mtime) return _defaultSkinsCache;
  try {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    if (Array.isArray(j.skins) && j.skins.length) {
      return _defaultSkinsCache = { version: j.version || null, skins: j.skins, mtime };
    }
  } catch { /* the legacy pair covers the first run */ }
  return _defaultSkinsCache = null;
}

function cachedDefaultSkins() {
  const c = readDefaultSkinsCache();
  return c ? c.skins : null;
}

// An offline account's Minecraft identity. A server in offline mode computes it
// from the name — UUID.nameUUIDFromBytes(("OfflinePlayer:" + name) in UTF-8),
// an MD5 forced into a version 3 UUID — so that is the id the player actually
// has in game, and the one their default skin should be chosen from. Without
// this an offline account was keyed by a launcher-internal string, and the face
// on the accounts page and the default on the skins page disagreed.
function offlineUuid(name) {
  const md5 = crypto.createHash("md5").update("OfflinePlayer:" + String(name || ""), "utf8").digest();
  md5[6] = (md5[6] & 0x0f) | 0x30;   // version 3
  md5[8] = (md5[8] & 0x3f) | 0x80;   // IETF variant
  return md5.toString("hex");
}

// The identity to pick a default skin by: the real uuid for a premium account,
// the offline one for an account that only has a name.
function skinIdentity({ uuid, name, offline }) {
  const id = String(uuid || "").replace(/-/g, "");
  if (id.length === 32) return id;
  if (offline && name) return offlineUuid(name);
  return id || "";
}

// Which default skin an account gets, as data. ONE implementation, so the head
// on the accounts page, the sidebar, and the skins page's "reset to default"
// preview can never disagree about what an account's default looks like.
function defaultSkinFor({ uuid, name, offline }) {
  const list = cachedDefaultSkins();
  const id = skinIdentity({ uuid, name, offline });
  if (list && list.length) {
    const pick = defaultSkinForUuid(id, list);
    if (pick && pick.base64) return { name: pick.name, model: pick.model, base64: pick.base64 };
  }
  return null;
}

ipcMain.handle("mc:defaultSkinFor", async (event, opts = {}) => {
  const pick = defaultSkinFor(opts);
  if (pick) return pick;
  // First run, before the list has been built: the legacy pair still gives the
  // right ANSWER to "what does this account look like with no skin".
  try {
    const model = legacyDefaultModel(skinIdentity(opts));
    const png = await skinByTextureHash(DEFAULT_SKIN_TEXTURE[model]);
    return { name: model === "slim" ? "alex" : "steve", model: model === "slim" ? "slim" : "wide", base64: png.toString("base64") };
  } catch (err) {
    return { error: String(err && err.message || err) };
  }
});

// A skin PNG by its texture hash, kept on disk forever — the hash IS the
// content, so it can never go stale.
async function skinByTextureHash(hash) {
  const file = path.join(HEADS_DIR, `tex-${hash}.png`);
  try { return await fsp.readFile(file); } catch { /* not cached — fetch it */ }
  const res = await fetch(TEXTURES_BASE + hash);
  if (!res.ok) throw new Error(`textures.minecraft.net says ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50) throw new Error("not a PNG");
  try {
    await fsp.mkdir(HEADS_DIR, { recursive: true });
    await fsp.writeFile(file, buf);
  } catch { /* the cache is optional */ }
  return buf;
}

// Face + hat, composited — and left at the size the skin sheet draws them.
//
// That is the whole point: a head is an 8x8 texture (16x16 on a 128px HD
// sheet, and so on). This used to enlarge it to whatever pixel size the caller
// happened to want and cache THAT, so the same player ended up with a 38x38, a
// 34x34, a 32x32 and a 24x24 file on disk — four copies of eight-by-eight
// pixels, blown up four different ways, none of them the texture. Now there is
// one file per skin, at the resolution the texture actually has, and the page
// scales it with image-rendering: pixelated. Growing an image in CSS costs
// nothing, and the result is identical to a nearest-neighbour resize here.
//
// The compositing stays its own pipeline. sharp runs composite after resize
// whichever order you call them in, so when this did resize, chaining the two
// pasted the 8x8 hat at its native size into the top-left corner of the
// already-enlarged face — 11% of a 24px head, 1.6% of a 64px one, exactly the
// mismatched square that showed up on every head with a hat. Nothing resizes
// here any more, but the hat is still composited on its own so that stays true
// if anything ever does.
async function headFromSkin(skinPng) {
  const src = sharp(skinPng).ensureAlpha();
  const meta = await src.metadata();
  const scale = (meta.width || 0) / 64;
  if (!scale || scale !== Math.floor(scale)) {
    throw new Error(`not a skin sheet (${meta.width}x${meta.height})`);
  }
  const at = (r) => ({
    left: r.left * scale, top: r.top * scale,
    width: r.width * scale, height: r.height * scale,
  });

  const face = await src.clone().extract(at(FACE_RECT)).png().toBuffer();
  let merged = face;
  // The hat layer is optional in practice — plenty of skins leave it empty —
  // and on a 64x32 sheet it is still inside the image, so this is safe either
  // way. A failure to read it just means a bare face.
  try {
    if (await hasUsableOverlay(skinPng, meta, scale)) {
      const hat = await sharp(skinPng).ensureAlpha().extract(at(HAT_RECT)).png().toBuffer();
      merged = await sharp(face).composite([{ input: hat, blend: "over" }]).png().toBuffer();
    }
  } catch { /* no hat layer */ }

  return merged;
}

// Old 64x32 skins left the whole second layer opaque, which is why Minecraft
// itself throws it away: ImageBufferDownload does setAreaTransparent(32,0,64,32)
// — "if that region has no transparency anywhere, clear it". Without the same
// rule, Notch's head (and every other skin of that vintage) renders as a solid
// block of whatever colour sits over the face.
//
// It applies to legacy sheets only. A modern 64x64 skin with a fully opaque
// overlay meant it.
async function hasUsableOverlay(skinPng, meta, scale) {
  if ((meta.height || 0) / scale !== 32) return true;      // not a legacy sheet
  const px = await sharp(skinPng).ensureAlpha()
    .extract({ left: 32 * scale, top: 0, width: 32 * scale, height: 32 * scale })
    .raw().toBuffer();
  for (let i = 3; i < px.length; i += 4) if (px[i] < 255) return true;
  return false;
}

// uuid -> the texture hash of the skin Mojang is serving for it.
async function headTextureForUuid(uuid) {
  const key = String(uuid || "").replace(/-/g, "");
  if (!key) return null;
  const hit = _headProfile.get(key);
  if (_headFresh(hit, HEAD_PROFILE_TTL)) return hit;
  if (_headCooling("p:" + key)) return hit || null;    // stale is better than wrong
  try {
    const res = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${key}`);
    if (!res.ok) throw new Error(`profile ${res.status}`);
    const prof = await res.json();
    const tex = (prof.properties || []).find(p => p.name === "textures");
    if (!tex) throw new Error("no textures property");
    const decoded = JSON.parse(Buffer.from(tex.value, "base64").toString("utf8"));
    const url = decoded?.textures?.SKIN?.url || "";
    const hash = url.split("/").pop() || null;
    const slim = decoded?.textures?.SKIN?.metadata?.model === "slim";
    const cape = decoded?.textures?.CAPE?.url || null;
    const entry = { hash, slim, cape, at: Date.now() };
    _headProfile.set(key, entry);
    return entry;
  } catch (err) {
    _headCool("p:" + key);
    devtoolsLog(`head: no profile for ${key}:`, err && err.message);
    return hit || null;
  }
}

async function headUuidForName(name) {
  const key = String(name || "").trim().toLowerCase();
  if (!key) return null;
  const hit = _headUuid.get(key);
  if (_headFresh(hit, HEAD_PROFILE_TTL)) return hit.uuid;
  if (_headCooling("n:" + key)) return hit ? hit.uuid : null;
  try {
    const res = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(key)}`);
    // 404 is a real answer: there is no such player, so remember that rather
    // than asking again every time the list redraws.
    if (res.status === 404 || res.status === 204) {
      _headUuid.set(key, { uuid: null, at: Date.now() });
      return null;
    }
    if (!res.ok) throw new Error(`names ${res.status}`);
    const j = await res.json();
    const uuid = j && j.id ? String(j.id) : null;
    // Mojang's spelling, not the caller's: "notch" should come back "Notch".
    _headUuid.set(key, { uuid, at: Date.now(), name: (j && j.name) || null });
    return uuid;
  } catch (err) {
    _headCool("n:" + key);
    devtoolsLog(`head: could not resolve "${key}":`, err && err.message);
    return hit ? hit.uuid : null;
  }
}

// A head out of a skin PNG already in hand. `id` keys the cache and must be a
// property of the CONTENT, so that changing an account's skin produces a
// different key and the old head cannot be served for the new skin. The size
// is deliberately NOT part of the key — one head texture per skin, drawn at
// whatever size by whoever asks.
// Every read and write here is async. A page can want twenty of these at once,
// and twenty synchronous round trips to the disk is twenty pauses of the whole
// main process — small each, plainly visible together.
async function renderHeadPng(png, id) {
  const cached = _headRendered.get(id);
  if (cached) return cached;
  const file = path.join(HEADS_DIR, `${id}.png`);
  try {
    const url = "data:image/png;base64," + (await fsp.readFile(file)).toString("base64");
    _headRendered.set(id, url);
    return url;
  } catch { /* not cached yet — render it */ }
  const out = await headFromSkin(png);
  const url = "data:image/png;base64," + out.toString("base64");
  try {
    await fsp.mkdir(HEADS_DIR, { recursive: true });
    await fsp.writeFile(file, out);
  } catch { /* the cache is optional */ }
  if (_headRendered.size >= HEAD_RENDER_MAX) _headRendered.delete(_headRendered.keys().next().value);
  _headRendered.set(id, url);
  return url;
}

// A texture hash IS a content key, so it needs no hashing of its own.
const renderHead = async (hash) => renderHeadPng(await skinByTextureHash(hash), hash);

// Heads used to be cached per pixel size, so an upgraded launcher starts with a
// directory full of "<id>-38.png", "<id>-34.png", "<id>-32.png", "<id>-24.png"
// files that nothing will ever read again. Delete them once, on startup.
//
// The pattern is specific on purpose: a head file is now "<id>.png" and a
// cached skin sheet is "tex-<hash>.png", and neither ends in a dash followed by
// digits, so nothing still in use can match. Anything that does not match is
// left strictly alone.
async function pruneSizedHeads() {
  let names;
  try { names = await fsp.readdir(HEADS_DIR); } catch { return; }   // nothing cached yet
  const sized = names.filter(n => /-\d+\.png$/.test(n));
  if (!sized.length) return;
  let gone = 0;
  for (const n of sized) {
    try { await fsp.unlink(path.join(HEADS_DIR, n)); gone++; } catch { /* already gone */ }
  }
  devtoolsLog(`head cache: dropped ${gone} per-size head file(s)`);
}
const contentKey = (buf) => "b" + crypto.createHash("sha1").update(buf).digest("hex").slice(0, 16);

// The default head for an account, by Minecraft's own rule over the nine
// defaults the skins page shows. Falls back to the legacy pair while the
// modern list is still being fetched.
async function defaultHead(who) {
  const pick = defaultSkinFor(who);
  if (pick) {
    const png = Buffer.from(pick.base64, "base64");
    return { url: await renderHeadPng(png, contentKey(png)), from: "default" };
  }
  const model = legacyDefaultModel(skinIdentity(who));
  return { url: await renderHead(DEFAULT_SKIN_TEXTURE[model]), from: "default" };
}

// The head for a player. `offline` skips Mojang entirely — an offline account
// is a username nobody owns, and showing the real owner's face for it would be
// a lie — but it does NOT mean no skin: an offline account can have one in this
// launcher, applied in game through a resource pack, and that is its face.
// Answers { url, from } where `from` is "skin", "offline-skin" or "default",
// so the caller can tell a real head from a stand-in.
//
// There is no size: the answer is the head TEXTURE, at its own resolution. A
// `size` is still accepted and ignored so older callers keep working.
async function playerHead({ name, uuid, offline, playerId }) {
  let id = String(uuid || "").replace(/-/g, "") || null;

  // The skin this launcher holds for an offline account wins over everything:
  // it is what that account looks like in game.
  if (playerId != null) {
    try {
      const entry = loadCrackedSkins()[String(playerId)];
      if (entry && entry.base64) {
        const png = Buffer.from(String(entry.base64).replace(/^data:image\/\w+;base64,/, ""), "base64");
        return { url: await renderHeadPng(png, contentKey(png)), from: "offline-skin" };
      }
    } catch (err) {
      devtoolsLog("head: could not read the offline skin:", err && err.message);
    }
  }

  try {
    if (!offline) {
      if (!id && name) id = await headUuidForName(name);
      if (id) {
        const prof = await headTextureForUuid(id);
        if (prof && prof.hash) {
          return { url: await renderHead(prof.hash), from: "skin" };
        }
      }
    }
  } catch (err) {
    devtoolsLog("head: falling back to the default:", err && err.message);
  }

  try {
    return await defaultHead({ uuid: id, name, offline });
  } catch (err) {
    devtoolsLog("head: even the default failed:", err && err.message);
    return { url: null, from: "none" };
  }
}

// The whole skin sheet for a player, from the same cached Mojang lookup the
// heads use. The render on the skins page used to ask an avatar service for
// this, which has the same problem: throttled, it answers 200 with a default
// skin and the page shows the wrong character without saying so.
ipcMain.handle("head:skin", async (event, { name, uuid, offline, playerId } = {}) => {
  let id = String(uuid || "").replace(/-/g, "") || null;
  if (playerId != null) {
    try {
      const entry = loadCrackedSkins()[String(playerId)];
      if (entry && entry.base64) {
        return {
          base64: String(entry.base64).replace(/^data:image\/\w+;base64,/, ""),
          slim: entry.variant === "slim",
          from: "offline-skin",
        };
      }
    } catch { /* fall through to the default */ }
  }
  try {
    if (!offline) {
      if (!id && name) id = await headUuidForName(name);
      if (id) {
        const prof = await headTextureForUuid(id);
        if (prof && prof.hash) {
          const png = await skinByTextureHash(prof.hash);
          // The cape too, when Mojang is serving one: a player's details page
          // shows them as they look, and for a lot of people the cape IS how
          // they look.
          return { base64: png.toString("base64"), slim: !!prof.slim, from: "skin", capeUrl: prof.cape || null };
        }
      }
    }
  } catch (err) {
    devtoolsLog("skin: falling back to the default:", err && err.message);
  }
  try {
    // The same nine defaults, picked the same way, as the head and the skins
    // page use — one implementation, in defaultSkinFor.
    const pick = defaultSkinFor({ uuid: id, name, offline });
    if (pick) return { base64: pick.base64, slim: pick.model === "slim", from: "default" };
    const model = legacyDefaultModel(skinIdentity({ uuid: id, name, offline }));
    const png = await skinByTextureHash(DEFAULT_SKIN_TEXTURE[model]);
    return { base64: png.toString("base64"), slim: model === "slim", from: "default" };
  } catch (err) {
    return { error: String(err && err.message || err) };
  }
});

// A username -> the account Mojang has for it, or nothing. Used by the
// friends panel's Add box, which looks a player up and shows them before it
// offers to send anybody a request.
ipcMain.handle("mc:profileByName", async (event, { name } = {}) => {
  const who = String(name || "").trim();
  if (!/^\w{1,16}$/.test(who)) return null;
  try {
    const uuid = await headUuidForName(who);
    if (!uuid) return null;
    // The canonical spelling, which is what should be shown back.
    const hit = _headUuid.get(who.toLowerCase());
    return { uuid, name: (hit && hit.name) || who };
  } catch { return null; }
});

ipcMain.handle("head:get", async (event, opts) => playerHead(opts || {}));
// Several at once, so a list of twenty accounts is one round trip rather than
// twenty. Each entry answers independently; one failure does not sink the rest.
ipcMain.handle("head:many", async (event, { players } = {}) => {
  const list = Array.isArray(players) ? players.slice(0, 200) : [];
  return Promise.all(list.map(async (p) => {
    try { return await playerHead(p || {}); }
    catch { return { url: null, from: "none" }; }
  }));
});

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

ipcMain.handle("mc:getProfile", async (event, opts) => {
  const now = Date.now();
  const id = storage.get("selectedPlayerId", null);
  const force = !!(opts && opts.force);

  if (!force && profileCache.has(id)) {
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
    // refreshPlayer decides whether a refresh is actually due; persist the
    // stamp it sets so the throttle survives a restart.
    try {
      const before = obj1.lastRefresh || 0;
      obj1 = await refreshPlayer(obj1);
      if ((obj1.lastRefresh || 0) !== before) {
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

  let fetched = false;
  if (accessToken) {
    // 3️⃣ Fetch Mojang profile
    try {
      const response = await fetch("https://api.minecraftservices.com/minecraft/profile", {
        method: "GET",
        headers: { "Authorization": `Bearer ${accessToken}` }
      });

      if (response.ok) {
        data = await response.json();
        fetched = true;
      } else {
        devtoolsLog("Mojang profile fetch returned HTTP", response.status);
      }
    } catch (e) {
      devtoolsLog("Failed to fetch Mojang profile:", e);
    }
  }

  // Mojang rate-limits this, and a 429 used to fall through as an empty
  // profile — which read on screen as "all your capes are gone". An expired
  // cache entry is a far better answer than nothing; it just isn't fresh.
  if (!fetched) {
    const stale = profileCache.get(id);
    if (stale && stale.data && ((stale.data.skins || []).length || (stale.data.capes || []).length)) {
      return { ...stale.data, stale: true };
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
  // The active cape just changed, so the cached profile is wrong. Resetting a
  // skin and disabling a cape both did this; applying one did not, which is
  // why the old cape stayed selected for the next five minutes.
  profileCache.clear();
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

// POST a skin to Mojang and hand back the texture URL it came to rest at. The
// upload response IS the updated profile, so the URL comes straight back — no
// second lookup, no waiting for it to propagate.
async function postSkinToMojang(base64, variant) {
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
  let url = null;
  try {
    const j = await res.json();
    const active = (j.skins || []).find(s => s.state === "ACTIVE") || (j.skins || [])[0];
    if (active && active.url) url = active.url;
  } catch { /* the upload still worked; we just don't know where it landed */ }
  return url;
}

// ---- UPLOAD a local skin file (base64 PNG) -> applies to Mojang ----
ipcMain.handle("mc:uploadSkin", async (event, { base64, variant }) => {
  try {
    const url = await postSkinToMojang(base64, variant);
    return { success: true, url };
  } catch (err) {
    throw new Error(err && err.message ? err.message : String(err));
  }
});

// ---- Put a skin ON Mojang's servers without keeping it applied ----
// There is no upload-without-applying endpoint, so this applies it, takes the
// texture URL out of the response, and then puts the previous skin back. The
// uploaded texture stays reachable at its URL afterwards — Mojang's texture URLs
// are content-addressed and permanent — which is the whole point.
ipcMain.handle("mc:stashSkin", async (event, { uuid, id, base64, variant, restore }) => {
  try {
    const url = await postSkinToMojang(base64, variant);
    if (uuid && id && url) rememberMojangUrl(uuid, id, url);
    let restored = false;
    if (restore && restore.base64) {
      // Back to back uploads get rate-limited, so give Mojang a moment — and
      // keep trying when it says no. Giving up after one attempt is how an
      // upload ended up leaving the wrong skin on the account.
      let lastErr = null;
      for (const wait of [2500, 6000, 15000]) {
        await new Promise(r => setTimeout(r, wait));
        try {
          const backUrl = await postSkinToMojang(restore.base64, restore.variant);
          if (restore.uuid && restore.id && backUrl) rememberMojangUrl(restore.uuid, restore.id, backUrl);
          restored = true;
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          // Only a rate limit is worth waiting out; anything else won't improve.
          if (!/rate-limit|429/i.test(String(err && err.message || err))) break;
        }
      }
      if (!restored) {
        // The skin IS uploaded; we just couldn't switch back. Say so rather
        // than reporting the whole thing as a failure.
        return { success: true, url, restored: false, restoreError: String(lastErr && lastErr.message || lastErr) };
      }
    }
    return { success: true, url, restored };
  } catch (err) {
    return { success: false, error: String(err && err.message || err) };
  }
});

// Record where a library skin lives on Mojang's servers, so the cloud badge and
// a later player-skin lookup both know about it.
function rememberMojangUrl(uuid, id, url) {
  try {
    const lib = loadSkinLib();
    const hit = findSkinEntry(lib, uuid, id);
    if (!hit) return false;
    hit.skin.mojangUrl = url;
    hit.skin.mojangAt = Date.now();
    saveSkinLib(lib);
    // This is the moment a skin becomes shareable — it is on Mojang now — so
    // it is also the moment it should start following the account around.
    scheduleSkinSync();
    return true;
  } catch { return false; }
}
ipcMain.handle("skins:setMojangUrl", (event, { uuid, id, url }) => rememberMojangUrl(uuid, id, url));

// Which library skins are on Mojang's servers, asked of Mojang rather than
// guessed. The profile endpoint lists every skin the account has there (the
// active one and any it still keeps), so matching those against the library by
// decoded pixels is authoritative — and it stops the skin you are literally
// wearing from showing a crossed-out cloud just because this launcher wasn't
// the thing that uploaded it.
ipcMain.handle("skins:reconcileMojang", async (event, { uuid }) => {
  try {
    const lib = loadSkinLib();
    // With a shared library, a skin this account wears may be filed under
    // another one — match against the whole pool or its cloud badge stays
    // crossed out.
    const arr = skinViewFor(lib, uuid);
    if (!arr.length) return { matched: 0 };

    const headers = await authHeaders();
    const res = await fetch("https://api.minecraftservices.com/minecraft/profile", { headers });
    if (!res.ok) return { matched: 0, error: `HTTP ${res.status}` };
    const profile = await res.json();
    const remote = Array.isArray(profile.skins) ? profile.skins : [];
    if (!remote.length) return { matched: 0 };

    // Hash what Mojang is serving, so re-encoding on their side doesn't matter.
    const byHash = new Map();
    for (const s of remote) {
      if (!s.url) continue;
      try {
        const buf = Buffer.from(await (await fetch(s.url)).arrayBuffer());
        const h = await skinPixelHash(buf.toString("base64"));
        if (h && !byHash.has(h)) byHash.set(h, s.url);
      } catch { /* skip this one */ }
    }

    let matched = 0, changed = false;
    for (const s of arr) {
      const h = s.pixelHash || (s.base64 ? await skinPixelHash(s.base64) : null);
      const url = h && byHash.get(h);
      if (!url) continue;
      matched++;
      if (s.mojangUrl !== url) { s.mojangUrl = url; s.mojangAt = s.mojangAt || Date.now(); changed = true; }
    }
    // `arr` holds the live objects out of lib, so the edits above are already
    // in place — just persist.
    if (changed) { saveSkinLib(lib); scheduleSkinSync(); }
    return { matched };
  } catch (err) {
    return { matched: 0, error: String(err && err.message || err) };
  }
});

// Every skin the launcher knows to be on Mojang's servers, for a given account —
// what a player-skin lookup shows next to the live one.
ipcMain.handle("skins:mojangKnown", (event, { uuid }) => {
  const lib = loadSkinLib();
  const arr = skinViewFor(lib, uuid);
  return arr.filter(s => s.mojangUrl)
    .map(s => ({ id: s.id, name: s.name, variant: s.variant, url: s.mojangUrl, at: s.mojangAt || 0 }))
    .sort((a, b) => b.at - a.at);
});

// ── Minecraft friends ───────────────────────────────────────────────────────
// api.minecraftservices.com exposes the in-game friends list: /friends gives
// the list plus pending requests in both directions, and /presence does double
// duty — it reports YOUR status AND answers with every online friend's. There
// is no GET for presence, which is why reading the list means telling the
// service you are around.
//
// Everything here is per-account: the headers come from whichever account the
// page asked about, so switching account switches friends list.
async function mcFriendsRequest(accountId, endpoint, method = "GET", body = null) {
  const headers = await authHeadersFor(accountId);
  const res = await fetch(`https://api.minecraftservices.com${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

// The error shape is { details: { status, errorMessage }, errorMessage }.
function friendsError(r) {
  const d = (r && r.data) || {};
  return (d.details && d.details.errorMessage) || d.errorMessage
    || (typeof d === "string" && d) || `HTTP ${r && r.status}`;
}

ipcMain.handle("friends:list", async (event, { accountId }) => {
  try {
    const r = await mcFriendsRequest(accountId, "/friends");
    if (!r.ok) return { success: false, error: friendsError(r) };
    const d = r.data || {};
    return {
      success: true,
      friends: d.friends || [],
      incoming: d.incomingRequests || [],
      outgoing: d.outgoingRequests || [],
    };
  } catch (err) {
    return { success: false, error: String(err && err.message || err) };
  }
});

// Reporting presence is also how the online friends are read back.
ipcMain.handle("friends:presence", async (event, { accountId, status }) => {
  try {
    const r = await mcFriendsRequest(accountId, "/presence", "POST", { status: status || "ONLINE" });
    if (!r.ok) return { success: false, error: friendsError(r) };
    const list = (r.data && r.data.presence) || [];
    const byId = {};
    for (const p of list) {
      if (!p || !p.profileId) continue;
      byId[String(p.profileId).replace(/-/g, "")] = p.status || "ONLINE";
    }
    return { success: true, presence: byId };
  } catch (err) {
    return { success: false, error: String(err && err.message || err) };
  }
});

// type: "ADD" (also how a request is accepted) or "REMOVE" (also deny/cancel).
ipcMain.handle("friends:update", async (event, { accountId, player, type }) => {
  try {
    const who = String(player || "").trim();
    if (!who) return { success: false, error: "No player given" };
    // A UUID goes in profileId, a username in name.
    const payload = { updateType: type === "REMOVE" ? "REMOVE" : "ADD" };
    if (/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(who)) payload.profileId = who;
    else payload.name = who;
    const r = await mcFriendsRequest(accountId, "/friends", "PUT", payload);
    if (!r.ok) {
      const msg = friendsError(r);
      // Mojang reports a pending request in EITHER direction as
      // "already friends", which reads as nonsense on its own.
      const code = (r.data && r.data.details && r.data.details.status) || "";
      return {
        success: false,
        error: /ALREADY_FRIENDS/i.test(code)
          ? "Mojang says you are already friends — check your incoming and outgoing requests, a pending one either way counts."
          : msg,
      };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err && err.message || err) };
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
// ── Cracked (offline) account skins ──────────────────────────────────────────
// Offline accounts have no Mojang profile to upload a skin to, and the vanilla
// player textures are NOT hashed assets (the asset index only holds sounds, lang
// and icons) — they live inside the client jar at
//   assets/minecraft/textures/entity/player/<wide|slim>/<name>.png
// so the only way to change them is a resource pack that overrides those paths.
const crackedSkinsPath = path.join(dataDir, "crackedskins.json");
function loadCrackedSkins() { try { return JSON.parse(fs.readFileSync(crackedSkinsPath, "utf8")); } catch { return {}; } }
function saveCrackedSkins(o) { try { fs.writeFileSync(crackedSkinsPath, JSON.stringify(o, null, 2)); } catch { /* ignore */ } }

// The vanilla default skin names. Read from the instance's own client jar when
// possible so new defaults are picked up automatically; this is the fallback.
const DEFAULT_SKIN_NAMES = ["alex", "ari", "efe", "kai", "makena", "noor", "steve", "sunny", "zuri"];
const PLAYER_TEX_DIR = "assets/minecraft/textures/entity/player";
// Pre-1.19.3 there were only these two, directly under entity/.
const LEGACY_STEVE = "assets/minecraft/textures/entity/steve.png";
const LEGACY_ALEX = "assets/minecraft/textures/entity/alex.png";

function instanceClientJar(profileId, version) {
  return path.join(dataDir, "client", String(profileId), "versions", String(version), `${version}.jar`);
}

// Resource pack_format for versions whose client jar has NO version.json (1.12.2
// and older don't ship one). Anything from 1.19.3 on is read from the jar itself,
// so this table only has to cover the old range.
const LEGACY_PACK_FORMATS = [
  [/^1\.(6|7|8)(\.|$)/, 1],
  [/^1\.(9|10)(\.|$)/, 2],
  [/^1\.(11|12)(\.|$)/, 3],
  [/^1\.(13|14)(\.|$)/, 4],
  [/^1\.15(\.|$)/, 5], [/^1\.16\.[01]$/, 5], [/^1\.16$/, 5],
  [/^1\.16(\.|$)/, 6],
  [/^1\.17(\.|$)/, 7],
  [/^1\.18(\.|$)/, 8],
  [/^1\.19(\.|$)/, 9],
];
function legacyPackFormat(version) {
  for (const [re, fmt] of LEGACY_PACK_FORMATS) if (re.test(String(version || ""))) return fmt;
  return null;
}

// What the client jar tells us: the resource pack_format and which player-texture
// layout this version uses. Two layouts exist:
//   modern (1.19.3+): assets/minecraft/textures/entity/player/<wide|slim>/<name>.png
//   legacy:           assets/minecraft/textures/entity/{steve,alex}.png
// pack_version is {resource_major,resource_minor} on new versions, {resource} on
// older ones, and absent entirely on 1.12.2 and below.
function readPackInfoFromJar(jarPath) {
  const out = { major: null, minor: 0, names: null, legacy: false };
  try {
    if (!fs.existsSync(jarPath)) return out;
    const zip = new AdmZip(jarPath);
    const vEntry = zip.getEntry("version.json");
    if (vEntry) {
      const pv = (JSON.parse(vEntry.getData().toString("utf8")) || {}).pack_version;
      if (typeof pv === "number") out.major = pv;
      else if (pv && typeof pv === "object") {
        out.major = pv.resource_major ?? pv.resource ?? null;
        out.minor = pv.resource_minor ?? 0;
      }
    }
    const names = new Set();
    let sawLegacy = false;
    for (const e of zip.getEntries()) {
      const p = e.entryName;
      if (!p.endsWith(".png")) continue;
      if (p.startsWith(PLAYER_TEX_DIR + "/")) {
        const parts = p.split("/");
        const model = parts[parts.length - 2];
        if (model === "wide" || model === "slim") names.add(parts[parts.length - 1].replace(/\.png$/, ""));
      } else if (p === LEGACY_STEVE || p === LEGACY_ALEX) sawLegacy = true;
    }
    if (names.size) out.names = [...names];
    else if (sawLegacy) out.legacy = true;   // only the old two-file layout
  } catch { /* fall back to defaults */ }
  return out;
}

// The pack is a FOLDER, not a zip. Minecraft holds an open handle on a zipped
// resource pack for as long as it's loaded, so a zip can't be rewritten while the
// game is running; the individual PNGs inside a directory pack can be. Directory
// packs are listed in options.txt exactly like zipped ones, minus the extension.
const CRACKED_PACK_NAME = "redstone-skin";
const CRACKED_PACK_ENTRY = "file/" + CRACKED_PACK_NAME;
const crackedPackDir = (profileId) =>
  path.join(dataDir, "client", String(profileId), "resourcepacks", CRACKED_PACK_NAME);

// Build (or refresh) the offline-skin resource pack for an instance and enable it.
// Every default skin name is overridden, in BOTH the wide and slim folders, so the
// skin shows regardless of which default the game assigns this offline UUID.
function applyCrackedSkinToInstance(profileId, version, base64) {
  const raw = String(base64 || "").replace(/^data:image\/\w+;base64,/, "");
  if (!raw) return { success: false, error: "No skin data" };
  const dir = crackedPackDir(profileId);
  try {
    const info = readPackInfoFromJar(instanceClientJar(profileId, version));
    const major = info.major ?? legacyPackFormat(version) ?? 99;
    const minor = info.minor || 0;
    const png = Buffer.from(raw, "base64");

    // Modern clients read min_format/max_format (a [major, minor] pair or a bare
    // major); older ones only understand pack_format. Write all three so one pack
    // is accepted everywhere — unknown keys are simply ignored.
    const meta = {
      pack: {
        description: "Redstone Launcher — offline account skin",
        pack_format: major,
        min_format: [major, minor],
        max_format: major,
      },
    };

    // Which textures this version's layout needs. When the jar isn't around to
    // tell us, write BOTH layouts — the version that doesn't use one ignores it.
    const files = [];
    if (!info.legacy) {
      const names = info.names && info.names.length ? info.names : DEFAULT_SKIN_NAMES;
      for (const model of ["wide", "slim"]) for (const n of names) files.push(`${PLAYER_TEX_DIR}/${model}/${n}.png`);
    }
    if (info.legacy || !info.names) {
      // Pre-1.19.3: just the two files, wide=steve and slim=alex. Both are replaced
      // regardless of the chosen skin's model.
      files.push(LEGACY_STEVE, LEGACY_ALEX);
    }

    // Drop textures a previous version's layout left behind, so switching an
    // instance's game version doesn't leave stale overrides in the pack.
    const wanted = new Set(files);
    for (const stale of listPackTextures(dir)) {
      if (!wanted.has(stale)) { try { fs.unlinkSync(path.join(dir, stale)); } catch { /* ignore */ } }
    }

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "pack.mcmeta"), JSON.stringify(meta, null, 2));
    for (const rel of files) {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, png);
    }

    // An older build shipped this as a zip; it would sit alongside the folder and
    // win or lose at random, so clear it out.
    try {
      const oldZip = dir + ".zip";
      if (fs.existsSync(oldZip)) fs.unlinkSync(oldZip);
    } catch { /* ignore */ }

    // Enable it last so it wins over other packs.
    const packs = readEnabledResourcePacks(profileId)
      .filter(p => p !== CRACKED_PACK_ENTRY && p !== CRACKED_PACK_ENTRY + ".zip");
    packs.push(CRACKED_PACK_ENTRY);
    writeEnabledResourcePacks(profileId, packs);
    return { success: true, pack: CRACKED_PACK_NAME, format: major, textures: files.length };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// The .png paths currently in a folder pack, relative to its root.
function listPackTextures(dir) {
  const out = [];
  const walk = (rel) => {
    let entries = [];
    try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.name.endsWith(".png")) out.push(r);
    }
  };
  walk("");
  return out;
}

function removeCrackedSkinFromInstance(profileId) {
  try {
    fs.rmSync(crackedPackDir(profileId), { recursive: true, force: true });
    const oldZip = crackedPackDir(profileId) + ".zip";
    if (fs.existsSync(oldZip)) fs.unlinkSync(oldZip);
    writeEnabledResourcePacks(profileId, readEnabledResourcePacks(profileId)
      .filter(x => x !== CRACKED_PACK_ENTRY && x !== CRACKED_PACK_ENTRY + ".zip"));
  } catch { /* ignore */ }
}

ipcMain.handle("skins:getCracked", (event, { playerId }) => loadCrackedSkins()[String(playerId)] || null);

ipcMain.handle("skins:setCracked", async (event, { playerId, base64, variant, name, pixelHash }) => {
  try {
    const store = loadCrackedSkins();
    if (base64) store[String(playerId)] = { base64: String(base64).replace(/^data:image\/\w+;base64,/, ""), variant: variant || "classic", name: name || "Skin", pixelHash: pixelHash || null };
    else delete store[String(playerId)];
    saveCrackedSkins(store);
    // This account's face just changed, and it is drawn on the accounts page,
    // the sidebar and anywhere else a head appears. Those pages cache heads, so
    // tell them to drop what they have rather than leaving the old face up
    // until something else happens to redraw.
    for (const w of BrowserWindow.getAllWindows()) {
      try { if (!w.isDestroyed()) w.webContents.send("heads-changed", { playerId: String(playerId) }); }
      catch { /* window gone */ }
    }
    // Nothing is written to any instance here. The pack is refreshed at launch,
    // from the skin the account has at that moment — rewriting every instance now
    // would also mean writing into packs a running game is holding.
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
});

// Extract the vanilla default player skins straight from the latest client jar
// (the resources.download.minecraft.net URLs derived from file hashes don't
// serve jar contents). Returns [{ name, model, base64 }]; cached per version.
// The download and the unzip happen in a worker thread. AdmZip is synchronous,
// and a client jar is ~25 MB with around twenty thousand entries, so doing it
// here stopped every window for as long as it took — which is what the launcher
// did on its first run, right when it also wanted to draw its first heads.
//
// Only one build ever runs: a second caller gets the same promise rather than a
// second worker and a second 25 MB download.
let _buildingDefaultSkins = null;

function extractDefaultSkinsInWorker(jarUrl, version, keepAt) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = utilityProcess.fork(
        path.join(app.getAppPath(), "backend", "default-skins-worker.js"),
        [], { serviceName: "mc-default-skins" });
    } catch (err) { reject(err); return; }

    let settled = false;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      try { worker.kill(); } catch { /* already gone */ }
      fn(v);
    };
    // A 40 MB download on a bad connection should not hold a promise forever.
    const timer = setTimeout(() => done(reject, new Error("timed out")), 5 * 60 * 1000);
    worker.on("message", (m) => {
      clearTimeout(timer);
      if (m && m.ok) done(resolve, m);
      else done(reject, new Error((m && m.error) || "the worker said nothing useful"));
    });
    worker.on("exit", (code) => {
      clearTimeout(timer);
      done(reject, new Error(`default-skins worker exited (${code})`));
    });
    worker.postMessage({ type: "build", jarUrl, version, keepAt });
  });
}

async function buildDefaultSkins() {
  if (_buildingDefaultSkins) return _buildingDefaultSkins;
  const cacheFile = path.join(texturesDir, "defaultskins.json");
  _buildingDefaultSkins = (async () => {
    try {
      const manifest = await (await fetch("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json")).json();
      const latest = manifest?.latest?.release || null;

      const cached = readDefaultSkinsCache();
      if (cached && cached.version === latest && cached.skins.length) return cached.skins;

      const ver = manifest.versions.find(v => v.id === latest);
      const vj = await (await fetch(ver.url)).json();
      // The jar is kept rather than discarded: the version icons are rendered
      // from the block and item models in the same file, so this download
      // serves both and the icon code has a local jar for the latest release
      // from the first run onwards.
      const r = await extractDefaultSkinsInWorker(vj.downloads.client.url, latest, cachedJarPath(latest));
      const skins = (r && r.skins) || [];
      if (!skins.length) throw new Error("no player textures in the client jar");
      if (r && r.jar) devtoolsLog(`client jar: kept ${latest} at ${r.jar}`);

      await fsp.mkdir(texturesDir, { recursive: true });
      await fsp.writeFile(cacheFile, JSON.stringify({ version: latest, skins }));
      _defaultSkinsCache = { version: latest, skins, mtime: Date.now() };
      devtoolsLog(`default skins: built ${skins.length} from ${latest}`);
      return skins;
    } catch (err) {
      devtoolsLog("Failed to get default skins:", err && err.message);
      // A stale cache is still the right answer for every account.
      const cached = readDefaultSkinsCache();
      return (cached && cached.skins) || [];
    } finally {
      _buildingDefaultSkins = null;
    }
  })();
  return _buildingDefaultSkins;
}

ipcMain.handle("mc:getDefaultSkins", async () => buildDefaultSkins());

// ---- LOCAL SKIN LIBRARY (per account uuid) ----
// So a player's previously-used skins persist even if their active skin is
// changed elsewhere. Deduped by decoded-pixel hash.
// ── One shared skin library across the accounts on this machine ─────────────
// Off by default, each account keeps its own library. On, every account on this
// computer sees the same pool of skins — which is what people actually want
// when they have an alt: a skin is a skin, not a property of the account that
// happened to save it.
//
// The on-disk shape does NOT change: skins stay filed under the account that
// added them, so turning the setting off gives everyone their own library back
// exactly as it was. Pooling is a view over that, plus the ability to edit a
// skin that lives in somebody else's bucket.
//
// CAPES ARE NOT POOLED. They aren't ours to pool: a cape is granted to a Mojang
// account and only that account may wear it, so they stay per-account.
const POOL_SKINS_SETTING = "poolSkinsAcrossAccounts";
const poolingSkins = () => settings.get(POOL_SKINS_SETTING, false) === true;

// The display order of the pooled list, which spans accounts and so can't live
// in any one of them. Kept under a key no UUID can collide with.
const POOL_ORDER_KEY = "__pool_order__";

// Skins that were deleted, by the hash of their pixels, with when.
//
// Without these, deleting a skin that is in the cloud did nothing you could
// see for long: the next sync pulled the library back off the relay, found
// the skin missing locally, and helpfully put it back. A deletion has to
// travel the same way an addition does, so it is recorded here, merged with
// whatever the relay knows, and pushed back up -- which is also what makes
// the deletion reach the account's other computers.
//
// Kept under a key no UUID can collide with: { [uuid]: { [hash]: at } }.
const DELETED_KEY = "__deleted__";
// A tombstone is only needed for as long as some other copy of the library
// might still be carrying the skin. Half a year is far past that, and stops
// the list growing forever.
const TOMBSTONE_TTL = 183 * 24 * 60 * 60 * 1000;

const skinKey = (s) => (s && (s.pixelHash || `id:${s.id}`)) || null;

function tombstonesFor(lib, uuid) {
  const all = lib[DELETED_KEY];
  const mine = (all && typeof all === "object" && all[uuid]) || {};
  return (mine && typeof mine === "object") ? mine : {};
}
function setTombstones(lib, uuid, map) {
  if (!lib[DELETED_KEY] || typeof lib[DELETED_KEY] !== "object") lib[DELETED_KEY] = {};
  const cutoff = Date.now() - TOMBSTONE_TTL;
  const kept = {};
  for (const [k, at] of Object.entries(map || {})) if (Number(at) > cutoff) kept[k] = Number(at);
  lib[DELETED_KEY][uuid] = kept;
}

function pooledSkinList(lib) {
  const seen = new Set();
  const out = [];
  for (const [uuid, arr] of Object.entries(lib)) {
    if (!Array.isArray(arr)) continue;        // __pool_order__, __deleted__, ...
    for (const s of arr) {
      // The same skin saved by two accounts is one skin.
      const key = s.pixelHash || `id:${s.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
  }
  const order = Array.isArray(lib[POOL_ORDER_KEY]) ? lib[POOL_ORDER_KEY] : null;
  if (order && order.length) {
    const rank = new Map(order.map((id, i) => [String(id), i]));
    // Anything not in the stored order is new, and belongs at the front.
    out.sort((a, b) => {
      const ra = rank.has(String(a.id)) ? rank.get(String(a.id)) : -1;
      const rb = rank.has(String(b.id)) ? rank.get(String(b.id)) : -1;
      if (ra !== rb) return ra - rb;
      return (b.addedAt || 0) - (a.addedAt || 0);
    });
    return out;
  }
  return out.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
}

// What a handler should hand back after changing something: the pooled list
// when pooling, this account's own otherwise.
const skinViewFor = (lib, uuid) => poolingSkins() ? pooledSkinList(lib) : (lib[uuid] || []);

// Find a skin by id. With pooling on it may be filed under another account, so
// look there too — otherwise renaming a shared skin would silently do nothing.
function findSkinEntry(lib, uuid, id) {
  const inBucket = (u) => {
    if (u === POOL_ORDER_KEY) return null;
    const arr = lib[u];
    if (!Array.isArray(arr)) return null;
    const idx = arr.findIndex(s => String(s.id) === String(id));
    return idx >= 0 ? { uuid: u, arr, idx, skin: arr[idx] } : null;
  };
  const own = inBucket(uuid);
  if (own || !poolingSkins()) return own;
  for (const u of Object.keys(lib)) {
    const hit = inBucket(u);
    if (hit) return hit;
  }
  return null;
}

// Every account's skins as one flat list, for matching against Mojang.
function skinBucketsToScan(lib, uuid) {
  if (!poolingSkins()) return [uuid];
  return Object.keys(lib).filter(u => Array.isArray(lib[u]));
}

// A record in the library that is not a skin.
//
// The library is merged from this computer, from an account's other computers
// through the relay, and from older versions of this launcher, and nothing was
// checking that what came back actually held a picture. One that did not
// turned up on the skins page as a card called "undefined" with nothing in it
// -- and, having no id either, nothing could be done with it: renaming,
// applying and deleting all look the skin up by id and found nothing.
const isSkinRecord = (s) => !!(s && typeof s === "object"
  && typeof s.base64 === "string" && s.base64.length > 32);

// What a skin needs to be shown and acted on. An entry saved by an older
// version may have no id or no name; both are filled in rather than left for
// the page to print as "undefined".
function tidySkinRecord(s, i) {
  if (s.id != null && typeof s.name === "string" && s.name) return s;
  return {
    ...s,
    id: s.id != null ? s.id : `old-${s.pixelHash || i}-${s.addedAt || 0}`,
    name: (typeof s.name === "string" && s.name) ? s.name : "Skin",
  };
}

function loadSkinLib() {
  let obj;
  try { obj = JSON.parse(fs.readFileSync(skinLibraryPath, "utf8")) || {}; } catch { return {}; }
  // Repaired on the way in, and written back once, so the next sync pushes
  // the tidy list rather than carrying the junk around forever.
  let changed = false;
  for (const [k, v] of Object.entries(obj)) {
    // Only an account's own bucket. `__pool_order__` is a list of ids and
    // `__deleted__` a map of tombstones; neither holds skins, and filtering
    // the order as though it did would throw the whole pooled order away.
    if (!Array.isArray(v) || k === POOL_ORDER_KEY || k === DELETED_KEY) continue;
    const clean = v.filter(isSkinRecord).map(tidySkinRecord);
    if (clean.length !== v.length || clean.some((s, i) => s !== v[i])) {
      if (clean.length !== v.length) {
        devtoolsLog(`skins: dropped ${v.length - clean.length} entr${v.length - clean.length === 1 ? "y" : "ies"}`
          + ` from the library with no picture in them`);
      }
      obj[k] = clean;
      changed = true;
    }
  }
  if (changed) { try { saveSkinLib(obj); } catch { /* it is still right in memory */ } }
  return obj;
}
function saveSkinLib(obj) {
  fs.mkdirSync(texturesDir, { recursive: true });
  fs.writeFileSync(skinLibraryPath, JSON.stringify(obj));
}

ipcMain.handle("skins:list", (event, { uuid }) => {
  const lib = loadSkinLib();
  return skinViewFor(lib, uuid);
});

// Every saved skin across ALL accounts (for the editor's "copy faces → from
// library" picker, which spans other accounts too). Flat list; owner is a
// best-effort label only.
ipcMain.handle("skins:allLibrary", () => {
  const lib = loadSkinLib();
  const out = [];
  for (const arr of Object.values(lib)) {
    if (!Array.isArray(arr)) continue;
    arr.forEach(s => out.push({ id: s.id, name: s.name, base64: s.base64, variant: s.variant }));
  }
  return out;
});

// ── Starlight Skin Creator (lunareclipse.studio) ────────────────────────────
// A Bedrock-style dress-up skin creator. The info endpoint lists every cosmetic
// option; the create endpoint renders a 64×64 skin PNG from chosen options. Both
// are proxied through the main process so the renderer avoids CORS / tainted
// canvases, and the (large) option list is cached.
const STARLIGHT_BASE = "https://starlightskins.lunareclipse.studio";
let _starlightInfoCache = null;
async function _starlightInfo() {
  if (_starlightInfoCache) return _starlightInfoCache;
  const cacheFile = path.join(texturesDir, "starlight-info.json");
  try {
    const j = await (await fetch(`${STARLIGHT_BASE}/create-skin/info`)).json();
    _starlightInfoCache = j;
    try { fs.mkdirSync(texturesDir, { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(j)); } catch { }
    return j;
  } catch (e) {
    if (fs.existsSync(cacheFile)) { try { return (_starlightInfoCache = JSON.parse(fs.readFileSync(cacheFile, "utf8"))); } catch { } }
    return { error: e.message };
  }
}
ipcMain.handle("starlight:info", async () => _starlightInfo());
// path = "<base_texture>/<base_color>/<skinType>", query = { param: value, ... }.
ipcMain.handle("starlight:generate", async (event, { pathSeg, query }) => {
  try {
    const qs = new URLSearchParams(query || {}).toString();
    const url = `${STARLIGHT_BASE}/create-skin/${pathSeg}/${qs ? "?" + qs : ""}`;
    const res = await fetch(url);
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    return { base64: buf.toString("base64") };
  } catch (e) { return { error: e.message }; }
});

// Decode a Starlight skin code (positional base64 JSON array) and render it.
// Order matches the site's definedOptions; textures are stored as their id.
const STARLIGHT_CODE_ORDER = [
  "base_texture", "base_color", "skin_type", "eyes_alignment", "eyes_texture", "eyes_color", "eyes_color_secondary",
  "hair_style_texture", "hair_style_color", "face_item_texture", "face_item_color", "top_texture", "top_color",
  "top_designs_texture", "top_designs_color", "bottom_texture", "bottom_color", "footwear_texture", "footwear_color",
  "outerwear_texture", "outerwear_color", "eyebrow_texture", "eyebrow_color", "headwear_texture", "headwear_color",
  "mouth_alignment", "mouth_texture", "mouth_color", "facial_hair_texture", "facial_hair_color", "socks_texture", "socks_color",
  "gloves_texture", "gloves_color", "top_color_secondary", "outerwear_color_secondary", "bottom_color_secondary",
  "socks_color_secondary", "gloves_color_secondary", "footwear_color_secondary", "ears_texture", "ears_color",
  "ears_color_secondary", "base_color_secondary", "makeup_texture", "makeup_color", "makeup_color_secondary",
  "headwear_color_secondary", "hair_style_color_secondary", "hair_extension_front_texture", "hair_extension_back_texture",
  "hair_texture", "hair_pattern_texture", "face_item_color_secondary", "middlewear_texture", "middlewear_color", "middlewear_color_secondary",
];
ipcMain.handle("starlight:generateFromCode", async (event, { code }) => {
  // A skin code always renders to the same image, so cache the result on disk
  // next to the other skin textures. The "Create a skin" tile in the new-skin
  // modal shows one fixed code; without this it re-fetched it from Starlight on
  // every fresh profile, and the tile sat empty while it did.
  const cacheDir = path.join(texturesDir, "skincodes");
  const cacheFile = path.join(cacheDir, crypto.createHash("sha1").update(String(code || "")).digest("hex") + ".json");
  try {
    const hit = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    if (hit && hit.base64) return hit;
  } catch { /* not cached yet */ }
  try {
    const info = await _starlightInfo();
    if (!info || !info.cosmetics) return { error: "No cosmetics info" };
    let arr; try { arr = JSON.parse(Buffer.from(String(code || ""), "base64").toString("utf8")); } catch { return { error: "Bad code" }; }
    if (!Array.isArray(arr)) return { error: "Bad code" };
    const cos = info.cosmetics;
    const state = {};
    STARLIGHT_CODE_ORDER.forEach((k, i) => {
      const v = arr[i]; if (v === undefined) return;
      if (k === "skin_type") { const st = cos.skin_type || {}; const name = Object.keys(st).find(n => st[n].id === v); state[k] = name || (v === 2 ? "slim" : "wide"); }
      else if (k.endsWith("_texture")) { const list = cos[k + "s"] || {}; const name = Object.keys(list).find(n => list[n].id === v); state[k] = name || "none"; }
      else state[k] = v;
    });
    const bt = state.base_texture || "male", bc = state.base_color || "tan", st = state.skin_type || "wide";
    const pathSeg = `${encodeURIComponent(bt)}/${encodeURIComponent(bc)}/${encodeURIComponent(st)}`;
    const query = {};
    Object.keys(state).forEach(k => { if (k === "base_texture" || k === "base_color" || k === "skin_type") return; const v = state[k]; if (v != null && v !== "") query[k] = v; });
    const qs = new URLSearchParams(query).toString();
    const res = await fetch(`${STARLIGHT_BASE}/create-skin/${pathSeg}/${qs ? "?" + qs : ""}`);
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    const out = { base64: buf.toString("base64"), variant: st === "slim" ? "slim" : "classic" };
    try { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(out)); } catch { /* cache is best-effort */ }
    return out;
  } catch (e) { return { error: e.message }; }
});

// Resolve a Minecraft username → its current skin PNG (base64), done in the main
// process so there's no browser CORS/tainted-canvas problem. Used by the editor's
// "copy faces → from player name".
ipcMain.handle("skins:fetchByName", async (event, name) => {
  try {
    const uname = String(name || "").trim();
    if (!uname) return { error: "Empty name" };
    const pr = await (await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(uname)}`)).json();
    if (!pr || !pr.id) return { error: "Player not found" };
    const prof = await (await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${pr.id}`)).json();
    const tex = (prof.properties || []).find(p => p.name === "textures");
    if (!tex) return { error: "No textures for this player" };
    const decoded = JSON.parse(Buffer.from(tex.value, "base64").toString("utf8"));
    const url = decoded?.textures?.SKIN?.url;
    if (!url) return { error: "This player has no custom skin" };
    const slim = decoded?.textures?.SKIN?.metadata?.model === "slim";
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
    // The uuid comes back too: if this player is one of the launcher's own
    // accounts, the caller can show what it has saved for them alongside.
    return { base64: buf.toString("base64"), name: pr.name || uname, variant: slim ? "slim" : "classic", uuid: pr.id };
  } catch (e) { return { error: e.message }; }
});

// Download a skin PNG from any URL and return it as base64 (for the skin browser).
ipcMain.handle("skins:fetchUrl", async (event, { url }) => {
  try {
    if (!/^https?:\/\//i.test(String(url || ""))) return { error: "Bad URL" };
    const res = await fetch(url, { headers: { "User-Agent": LAUNCHER_UA } });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50) return { error: "Not a PNG" };
    // Report the arm model too — the caller can't tell, and MineSkin doesn't say.
    let variant = null;
    try {
      const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      variant = slimFromPixels(data, info.width, info.height) ? "slim" : "classic";
    } catch { /* fall back to whatever the caller assumed */ }
    return { base64: buf.toString("base64"), variant };
  } catch (e) { return { error: e.message }; }
});

// Browse a public skin library (MineSkin's gallery) — real JSON API. Returns a
// page of skins with their texture URL (rendered client-side).
// MineSkin is an upload mirror, not a curated gallery: nothing is moderated, and
// the results are full of hate symbols and slurs. There is no public skin API with
// real moderation to switch to, so names and search terms are filtered here.
// This catches what people NAME things, which is most of it — it cannot see the
// image, so it is a filter and not moderation. Word-boundary matched so ordinary
// names ("Assassin", "Scunthorpe") aren't caught by a substring.
const SKIN_BLOCK_WORDS = [
  // hate / extremism
  "nazi", "nazis", "hitler", "adolf", "swastika", "hakenkreuz", "ss officer", "schutzstaffel",
  "thirdreich", "third reich", "reich", "wehrmacht", "gestapo", "kkk", "klan", "confederate",
  "holocaust", "auschwitz", "genocide", "fascist", "fascism", "whitepower", "white power",
  "heilhitler", "heil hitler", "sieg heil", "1488", "aryan", "skinhead",
  // slurs (matched whole-word; deliberately explicit so they actually get caught)
  "nigger", "nigga", "niger", "n1gger", "n1gga", "negro", "faggot", "fag", "f4ggot",
  "tranny", "retard", "retarded", "chink", "spic", "kike", "wetback", "coon", "gypsy",
  "paki", "raghead", "towelhead", "beaner", "gook",
  // sexual / nudity
  "nude", "naked", "nsfw", "porn", "porno", "hentai", "sex", "sexy", "boobs", "tits",
  "titties", "nipple", "nipples", "penis", "dick", "cock", "vagina", "pussy", "cum",
  "orgasm", "masturbat", "fetish", "bdsm", "stripper", "hooker", "prostitute", "onlyfans",
  "rule34", "r34", "loli", "shota", "furry porn", "yiff",
  // self-harm / gore
  "suicide", "kill yourself", "kys", "selfharm", "self harm", "gore", "beheading",
];
// Substrings that are damning wherever they appear, so no word boundary is needed.
const SKIN_BLOCK_SUBSTRINGS = ["swastik", "hakenkreuz", "nazi", "hitler", "n1gg", "nigg", "hentai", "rule34"];

function skinTextBlocked(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return false;
  for (const sub of SKIN_BLOCK_SUBSTRINGS) if (t.includes(sub)) return true;
  // Split on anything that isn't a letter or digit so "Nazi_Skin", "nazi-2" and
  // "xXnaziXx" all break into words.
  const words = t.split(/[^a-z0-9]+/).filter(Boolean);
  const set = new Set(words);
  for (const w of SKIN_BLOCK_WORDS) {
    if (w.includes(" ")) { if (t.includes(w)) return true; }
    else if (set.has(w)) return true;
  }
  return false;
}

// A texture's URL is stable, so the pixel screen never needs to happen twice
// for the same skin. This keeps the last few hundred verdicts around.
const _skinScreenCache = new Map();
const SKIN_SCREEN_CACHE_MAX = 800;
function rememberScreenVerdict(url, verdict) {
  _skinScreenCache.delete(url);           // move-to-end for LRU eviction
  _skinScreenCache.set(url, verdict);
  if (_skinScreenCache.size > SKIN_SCREEN_CACHE_MAX) {
    const oldest = _skinScreenCache.keys().next().value;
    _skinScreenCache.delete(oldest);
  }
}

// Fetch a skin PNG and check whether the detector rejects its pixels. Returns
// null for OK, a reason string for reject, or "fetch" if the texture 404s and
// so has nothing to check (also worth dropping -- nothing will render either).
// Is this a 3px-armed (slim/Alex) skin? Read off the pixels, because
// MineSkin's LIST response carries no variant field at all (only
// uuid/shortId/name/texture/timestamp) and asking per skin would be a request
// each; every browsed skin was otherwise saved as wide. The test itself lives
// in skin-model.js, next to the conversion that has to agree with it.

// Screening decodes every texture anyway, so the variant comes along for free.
const _skinVariantCache = new Map();

async function screenSkinUrl(url) {
  if (_skinScreenCache.has(url)) return _skinScreenCache.get(url);
  try {
    const res = await fetch(url, { headers: { "User-Agent": LAUNCHER_UA } });
    if (!res.ok) { rememberScreenVerdict(url, "fetch"); return "fetch"; }
    const buf = Buffer.from(await res.arrayBuffer());
    const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    try { _skinVariantCache.set(url, slimFromPixels(data, info.width, info.height) ? "slim" : "classic"); } catch { /* not fatal */ }
    const verdict = screenSkinPixels(data, info.width, info.height);
    rememberScreenVerdict(url, verdict);
    return verdict;
  } catch { rememberScreenVerdict(url, null); return null; }   // can't judge -> pass
}

// One page from MineSkin, filtered by title AND pixel content. The pixel screen
// runs against every skin in the page in parallel; each check is ~3ms plus one
// HTTP fetch.
async function mineskinPage(filter, after) {
  const params = new URLSearchParams({ size: "36" });
  params.set("filter", filter);
  if (after) params.set("after", String(after));
  const res = await fetch(`https://api.mineskin.org/v2/skins?${params.toString()}`, { headers: { "User-Agent": LAUNCHER_UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const skins = Array.isArray(j.skins) ? j.skins : [];
  const named = skins.map(s => ({
    id: s.uuid || s.shortId,
    title: s.name || null,          // no ugly "Skin <hex>" fallback; UI fills it in
    // s.variant isn't in the list response; the real answer comes off the
    // pixels during screening below.
    model: s.variant === "slim" ? "slim" : "classic",
    skin: s.texture ? `https://textures.minecraft.net/texture/${s.texture}` : s.url,
  })).filter(s => s.skin && !skinTextBlocked(s.title));
  const verdicts = await Promise.all(named.map(s => screenSkinUrl(s.skin).catch(() => null)));
  const results = named.filter((_, i) => verdicts[i] == null)
    .map(s => ({ ...s, model: _skinVariantCache.get(s.skin) || s.model }));
  const nextAfter = (j.pagination && j.pagination.next && j.pagination.next.after) || null;
  return { results, after: nextAfter };
}

ipcMain.handle("skins:search", async (event, { query, after, seed }) => {
  try {
    // MineSkin's gallery: `filter` is the real keyword search, and pagination is
    // cursor-based (pagination.next.after), not page numbers. When there's no
    // query we seed with a broad popular term so the default view has named,
    // varied skins instead of the unnamed "latest uploads" firehose.
    const q = String(query || "").trim();
    // Don't go looking for the things we filter out.
    if (skinTextBlocked(q)) return { results: [], after: null, more: false, filtered: true };
    const filter = q || seed || pickBrowseTerm();

    // Filtering leaves holes, so keep pulling pages until there's a screenful.
    // Without this a page that was mostly blocked would look like "no results".
    const out = [];
    let cursor = after || null, pages = 0;
    do {
      const page = await mineskinPage(filter, cursor);
      out.push(...page.results);
      cursor = page.after;
      pages++;
    } while (cursor && out.length < 24 && pages < 5);

    return { results: out, after: cursor, more: !!cursor };
  } catch (e) { return { error: e.message, results: [] }; }
});

// Look up whether a saved multiplayer server (by IP) has a Modrinth "server"
// project page — Modrinth's minecraft_java_server projects carry the address the
// server is reachable at. Returns the matching search hit (for the detail page)
// or null. Prefers an exact address match, falling back to a hostname match.
ipcMain.handle("modrinth:findServerByIp", async (event, { ip }) => {
  try {
    const norm = (a) => String(a || "").trim().toLowerCase().replace(/\s+/g, "").replace(/:25565$/, "");
    const target = norm(ip); if (!target) return null;
    const host = target.split(":")[0];
    const facets = encodeURIComponent(JSON.stringify([["project_type:minecraft_java_server"]]));
    const url = `https://api.modrinth.com/v2/search?facets=${facets}&limit=20&query=${encodeURIComponent(host)}`;
    const r = await fetch(url, { headers: { "User-Agent": LAUNCHER_UA } });
    if (!r.ok) return null;
    const hits = ((await r.json()).hits) || [];
    let hostMatch = null;
    for (const h of hits) {
      const slug = h.slug || h.project_id;
      try {
        const full = await (await fetch(`https://api.modrinth.com/v3/project/${slug}`, { headers: { "User-Agent": LAUNCHER_UA } })).json();
        const addr = full && full.minecraft_java_server && full.minecraft_java_server.address;
        if (!addr) continue;
        const na = norm(addr);
        if (na === target) return h;                       // exact address match wins
        if (!hostMatch && na.split(":")[0] === host) hostMatch = h;
      } catch { /* skip this hit */ }
    }
    return hostMatch;
  } catch { return null; }
});

// Add a skin to the library WITHOUT touching Mojang. No-op (returns existing)
// if a pixel-identical skin is already saved.
ipcMain.handle("skins:add", async (event, { uuid, base64, variant, name, editorType, creatorState, layerState }) => {
  const b = String(base64 || "").replace(/^data:image\/\w+;base64,/, "");
  if (!b || !uuid) return skinViewFor(loadSkinLib(), uuid);
  const pixelHash = await skinPixelHash(b);
  const lib = loadSkinLib();
  const arr = lib[uuid] || [];
  // Already here? With a shared library that includes another account's copy —
  // adding it again would put the same picture in the list twice.
  let existing = arr.find(s => s.pixelHash === pixelHash);
  if (!existing && poolingSkins()) {
    for (const u of Object.keys(lib)) {
      if (u === POOL_ORDER_KEY || u === uuid || !Array.isArray(lib[u])) continue;
      const hit = lib[u].find(s => s.pixelHash === pixelHash);
      if (hit) { existing = hit; break; }
    }
  }
  if (existing) {
    // Update the name if a nicer one was provided.
    if (name && existing.name !== name) existing.name = name;
    if (editorType) existing.editorType = editorType;
    if (creatorState !== undefined) existing.creatorState = creatorState;
    if (layerState !== undefined) existing.layerState = layerState;
    lib[uuid] = arr; saveSkinLib(lib);
    return skinViewFor(lib, uuid);
  }
  const fresh = { id: Date.now(), pixelHash, name: name || "Skin", base64: b, variant: (variant || "classic"), addedAt: Date.now(), editorType: editorType || "advanced", creatorState: creatorState || null, layerState: layerState || null };
  arr.unshift(fresh);
  lib[uuid] = arr;
  // Adding back something that was deleted before takes the note of its
  // deletion with it, so nothing has to reason about which is newer.
  const marks = { ...tombstonesFor(lib, uuid) };
  if (marks[pixelHash] || marks[`id:${fresh.id}`]) {
    delete marks[pixelHash];
    delete marks[`id:${fresh.id}`];
    setTombstones(lib, uuid, marks);
  }
  saveSkinLib(lib);
  scheduleSkinSync();
  return skinViewFor(lib, uuid);
});

// Save a skin PNG (base64) into the user's Downloads folder.
ipcMain.handle("skins:download", (event, { base64, name }) => {
  try {
    const b = String(base64 || "").replace(/^data:image\/\w+;base64,/, "");
    if (!b) return { success: false, error: "No image" };
    const safe = String(name || "skin").replace(/[^a-z0-9_\-]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "skin";
    const dir = app.getPath("downloads");
    let dest = path.join(dir, safe + ".png"), i = 1;
    while (fs.existsSync(dest)) dest = path.join(dir, `${safe}-${i++}.png`);
    fs.writeFileSync(dest, Buffer.from(b, "base64"));
    return { success: true, path: dest };
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle("skins:remove", (event, { uuid, id }) => {
  const lib = loadSkinLib();
  // With a shared library the skin may be filed under another account.
  const hit = findSkinEntry(lib, uuid, id);
  if (hit) {
    hit.arr.splice(hit.idx, 1);
    // Remembered as deleted, under the bucket it was actually filed in, so
    // the next sync does not fetch it straight back off the relay -- and so
    // the deletion reaches this account's other computers.
    const now = Date.now();
    const marks = { ...tombstonesFor(lib, hit.uuid) };
    // Both the pixels and the id: another copy of the library may be holding
    // an older version of this skin, which has the same id but not the same
    // pixels, and that one is just as deleted.
    if (hit.skin && hit.skin.pixelHash) marks[hit.skin.pixelHash] = now;
    if (hit.skin && hit.skin.id != null) marks[`id:${hit.skin.id}`] = now;
    setTombstones(lib, hit.uuid, marks);
  }
  saveSkinLib(lib);
  scheduleSkinSync();
  return skinViewFor(lib, uuid);
});

// Reorder the library to match the order the renderer just drew. The renderer
// passes the ids in the new order; anything not named is left where it was
// (relative to itself) at the end -- so a card added mid-drag doesn't vanish.
ipcMain.handle("skins:reorder", (event, { uuid, order }) => {
  const lib = loadSkinLib();
  if (!Array.isArray(order) || !order.length) return skinViewFor(lib, uuid);
  // A pooled list spans accounts, so its order can't be stored inside any one
  // of them — it goes in a key of its own and the pooled view reads it back.
  if (poolingSkins()) {
    lib[POOL_ORDER_KEY] = order.map(String);
    saveSkinLib(lib);
    return pooledSkinList(lib);
  }
  const arr = lib[uuid] || [];
  const byId = new Map(arr.map(s => [String(s.id), s]));
  const ordered = [];
  for (const id of order) {
    const s = byId.get(String(id));
    if (s) { ordered.push(s); byId.delete(String(id)); }
  }
  for (const s of arr) if (byId.has(String(s.id))) ordered.push(s);   // preserve leftovers
  lib[uuid] = ordered;
  saveSkinLib(lib);
  scheduleSkinSync();
  return ordered;
});

// Capes are Mojang's, not ours -- they arrive in whatever order the profile
// endpoint feels like -- so a per-account display order is stored alongside
// the skin library.
const capeOrderPath = () => path.join(texturesDir, "capeorder.json");
function loadCapeOrders() { try { return JSON.parse(fs.readFileSync(capeOrderPath(), "utf8")) || {}; } catch { return {}; } }
function saveCapeOrders(o) { fs.mkdirSync(texturesDir, { recursive: true }); fs.writeFileSync(capeOrderPath(), JSON.stringify(o)); }
ipcMain.handle("capes:getOrder", (event, { uuid }) => (loadCapeOrders()[uuid] || []));
ipcMain.handle("capes:setOrder", (event, { uuid, order }) => {
  if (!uuid || !Array.isArray(order)) return;
  const all = loadCapeOrders();
  all[uuid] = order.map(String);
  saveCapeOrders(all);
});

ipcMain.handle("skins:rename", (event, { uuid, id, name }) => {
  const lib = loadSkinLib();
  const hit = findSkinEntry(lib, uuid, id);
  const s = hit && hit.skin;
  if (s && name) { s.name = name; saveSkinLib(lib); scheduleSkinSync(); }
  return skinViewFor(lib, uuid);
});

// Change a saved skin's arm style -- and CONVERT it, which is the whole job.
//
// The two models are not the same picture with a different label on it: a slim
// arm is three pixels across where a wide one is four, so the arm's faces sit
// at different places in the texture. Setting the label and leaving the pixels
// alone, which is what this used to do, left the arms unwrapped from the wrong
// parts of the image. The pixels move now; skin-model.js has the mapping and
// where it came from.
ipcMain.handle("skins:setVariant", async (event, { uuid, id, variant }) => {
  const lib = loadSkinLib();
  const hit = findSkinEntry(lib, uuid, id);
  const s = hit && hit.skin;
  if (!s) return skinViewFor(lib, uuid);
  const want = variant === "slim" ? "slim" : "classic";
  const was = s.variant === "slim" ? "slim" : "classic";
  if (want !== was && s.base64) {
    const converted = await convertSkinBase64(s.base64, want);
    // A 64x32 skin has no slim form, so only its label changes -- which is
    // also the one case where a label on its own is the right answer.
    if (converted) {
      const wasHash = s.pixelHash;
      s.base64 = converted;
      s.pixelHash = await skinPixelHash(converted);
      forgetMojangUpload(lib, hit.uuid, s, wasHash);
      s.updatedAt = Date.now();
    }
  }
  s.variant = want;
  saveSkinLib(lib);
  scheduleSkinSync();
  return skinViewFor(lib, uuid);
});

// The same conversion, for the skin editor: it holds a stack of layers and
// each one has to move, or the stack and the flattened image disagree.
ipcMain.handle("skins:convertModel", async (event, { base64, to }) => {
  const out = await convertSkinBase64(base64, to === "slim" ? "slim" : "classic");
  return out ? { base64: out } : { unchanged: true };
});

// Update an existing library skin in place (from the skin editor). Keeps the id
// so the same card is edited rather than a duplicate created.
ipcMain.handle("skins:update", async (event, { uuid, id, base64, variant, name, editorType, creatorState, layerState }) => {
  const lib = loadSkinLib();
  const hit = findSkinEntry(lib, uuid, id);
  if (!hit) return skinViewFor(lib, uuid);
  const s = hit.skin;
  if (base64) {
    const b = String(base64).replace(/^data:image\/\w+;base64,/, "");
    const was = s.pixelHash;
    s.base64 = b;
    s.pixelHash = await skinPixelHash(b);
    // The image changed, so what was on Mojang's servers is a different skin
    // from this one now, and the old image is not in the library any more --
    // it must not be fetched back off the relay as a skin of its own.
    if (was && was !== s.pixelHash) forgetMojangUpload(lib, hit.uuid, s, was);
  }
  if (variant) s.variant = variant;
  if (name) s.name = name;
  if (editorType) s.editorType = editorType;
  if (creatorState !== undefined) s.creatorState = creatorState;
  // The editor's layer stack, so re-opening the skin restores it.
  if (layerState !== undefined) s.layerState = layerState;
  s.updatedAt = Date.now();
  saveSkinLib(lib);
  scheduleSkinSync();
  return skinViewFor(lib, uuid);
});

// Pixel hash for arbitrary base64 (used to detect if the active Mojang skin
// matches a library entry, regardless of PNG encoding).
ipcMain.handle("skins:pixelHash", async (event, { base64 }) => {
  if (!base64) return null;
  return await skinPixelHash(base64);
});

updateDiscordPresenceToggle();
