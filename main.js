const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain } = require('electron');
const { Client, Authenticator } = require('minecraft-launcher-core'); // has Authenticator too

// Path for profiles.json
const profilesPath = path.join(__dirname, 'profiles.json');

// Ensure profiles.json exists
if (!fs.existsSync(profilesPath)) {
  fs.writeFileSync(profilesPath, JSON.stringify([]));
}

// Load profiles
function loadProfiles() {
  return JSON.parse(fs.readFileSync(profilesPath));
}

// Save profiles
function saveProfiles(profiles) {
  fs.writeFileSync(profilesPath, JSON.stringify(profiles, null, 2));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  win.loadFile('frontend/index.html');
}

/* ─────────────── Profile System ─────────────── */

// Create profile
ipcMain.on('create-profile', (event, profile) => {
  const profiles = loadProfiles();

  const newProfile = {
    id: Date.now(), // unique ID
    name: profile.name,
    cracked: profile.cracked, // true = cracked
    username: profile.username || "Player",
    version: profile.version || "1.20.1",
    auth: profile.auth || null // only used for premium
  };

  profiles.push(newProfile);
  saveProfiles(profiles);

  event.reply('profiles-updated', profiles);
});

// Get all profiles
ipcMain.on('get-profiles', (event) => {
  const profiles = loadProfiles();
  event.reply('profiles-list', profiles);
});

// Launch profile
ipcMain.on('launch-profile', async (event, profileId) => {
  const profiles = loadProfiles();
  const profile = profiles.find(p => p.id === profileId);

  if (!profile) {
    event.reply('launch-error', `Profile with id ${profileId} not found`);
    return;
  }

  const launcher = new Client();
  let auth;

  if (profile.cracked) {
    // Cracked auth
    auth = {
      name: profile.username,
      uuid: "0",
      access_token: "0"
    };
  } else {
    // Premium auth (placeholder: real Microsoft OAuth flow needed)
    try {
      auth = await Authenticator.getAuth(profile.auth?.email, profile.auth?.password);
    } catch (err) {
      console.error("Authentication failed:", err);
      event.reply('launch-error', "Authentication failed for premium account");
      return;
    }
  }

  // Ensure root directory exists
  const rootDir = path.join(__dirname, 'minecraft', String(profile.id));
  fs.mkdirSync(rootDir, { recursive: true });

  launcher.launch({
    authorization: auth,
    root: rootDir,
    version: {
      number: profile.version,
      type: versionToType(profile.version)
    },
    memory: {
      max: "4G",
      min: "1G"
    }
  });

  launcher.on('debug', (msg) => event.reply('launcher-log', msg));
  launcher.on('data', (msg) => event.reply('launcher-log', msg));
  launcher.on('error', (err) => event.reply('launcher-log', "ERROR: " + err.message));
});

/* ─────────────── Helpers ─────────────── */

function versionToType(version) {
  return version.includes('.') ? "release" : "snapshot";
}

app.whenReady().then(createWindow);