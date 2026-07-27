#!/usr/bin/env node
// Redstone Relay — full ICE-style NAT traversal for the Redstone Launcher.
//
// One public Minecraft port (default 25565) serves EVERY shared server/world.
// The relay reads each incoming client's Minecraft handshake, takes the
// hostname it connected to (<sub>.redstonemc.net) and routes the connection to
// whichever launcher has registered that subdomain over an authenticated TLS
// control channel. Unknown/offline subdomains get a friendly placeholder in the
// server list instead of a raw connection error.
//
// Hosts prove ownership of a premium Minecraft account with Mojang's
// hasJoined challenge, and may only claim <username>.redstonemc.net or
// <name>.<username>.redstonemc.net (admins listed in admins.json can claim any).
//
// UFW-friendly: only the public MC port + the control port need to be open.
// See README.md for deployment (certbot, systemd, nginx notes).

import net from "net";
import tls from "tls";
import fs from "fs";
import https from "https";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONTROL_PORT = parseInt(process.env.RELAY_CONTROL_PORT || "47238", 10);
const MC_PORT = parseInt(process.env.RELAY_MC_PORT || "25565", 10);
const DOMAIN = process.env.RELAY_DOMAIN || "redstonemc.net";
const TLS_KEY = process.env.RELAY_TLS_KEY || `/etc/letsencrypt/live/${DOMAIN}/privkey.pem`;
const TLS_CERT = process.env.RELAY_TLS_CERT || `/etc/letsencrypt/live/${DOMAIN}/fullchain.pem`;
const OFFLINE_ICON = process.env.RELAY_OFFLINE_ICON || path.join(__dirname, "offline-icon.png");
const ADMINS_FILE = process.env.RELAY_ADMINS || path.join(__dirname, "admins.json");
const STATE_FILE = process.env.RELAY_STATE || path.join(__dirname, "relay-state.json");
const RECENT_MS = 30 * 24 * 60 * 60 * 1000; // "used in the last month"

function log(...a) { console.log(new Date().toISOString(), ...a); }

// ───────────────────────── control mux protocol ─────────────────────────
const T = { HELLO: 1, CHALLENGE: 2, AUTH: 3, WELCOME: 4, ERROR: 5, OPEN: 6, DATA: 7, CLOSE: 8, PING: 9, PONG: 10, DIRECT: 11 };

// Cloudflare DNS (optional). When a host reports a working UPnP public endpoint,
// we point <sub>.redstonemc.net straight at the host's IP so players connect
// DIRECTLY (no relay hop, no latency penalty). Without it, the wildcard record
// keeps *.redstonemc.net on the VPS and the relay tunnel carries the traffic.
const CF = {
  token: process.env.CF_API_TOKEN || "",
  zone: process.env.CF_ZONE_ID || "",
  get enabled() { return !!(this.token && this.zone); },
};
function cfRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      host: "api.cloudflare.com", path: "/client/v4" + apiPath, method,
      headers: { "Authorization": `Bearer ${CF.token}`, "Content-Type": "application/json", ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}) },
    }, (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } }); });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
async function cfPointDirect(sub, ip) {
  const name = `${sub}.${DOMAIN}`;
  const existing = await cfRequest("GET", `/zones/${CF.zone}/dns_records?type=A&name=${encodeURIComponent(name)}`);
  for (const r of (existing?.result || [])) { try { await cfRequest("DELETE", `/zones/${CF.zone}/dns_records/${r.id}`); } catch { /* ignore */ } }
  const res = await cfRequest("POST", `/zones/${CF.zone}/dns_records`, { type: "A", name, content: ip, ttl: 60, proxied: false });
  return res?.result?.id || null;
}
async function cfRemoveDirect(id) { try { await cfRequest("DELETE", `/zones/${CF.zone}/dns_records/${id}`); } catch { /* ignore */ } }
function encodeFrame(type, streamId, payload) {
  const len = payload ? payload.length : 0;
  const buf = Buffer.allocUnsafe(9 + len);
  buf.writeUInt8(type, 0); buf.writeUInt32BE(streamId >>> 0, 1); buf.writeUInt32BE(len, 5);
  if (len) payload.copy(buf, 9);
  return buf;
}
function createDecoder(onFrame) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 9) {
      const len = buf.readUInt32BE(5);
      if (buf.length < 9 + len) break;
      onFrame(buf.readUInt8(0), buf.readUInt32BE(1), Buffer.from(buf.subarray(9, 9 + len)));
      buf = buf.subarray(9 + len);
    }
  };
}

// ───────────────────────── Minecraft VarInt / handshake ─────────────────
function readVarInt(buf, offset) {
  let numRead = 0, result = 0, byte;
  do {
    if (offset + numRead >= buf.length) return null; // incomplete
    byte = buf[offset + numRead];
    result |= (byte & 0x7f) << (7 * numRead);
    numRead++;
    if (numRead > 5) throw new Error("VarInt too big");
  } while ((byte & 0x80) !== 0);
  return { value: result, size: numRead };
}
function writeVarInt(value) {
  const bytes = [];
  let v = value >>> 0;
  do { let b = v & 0x7f; v >>>= 7; if (v !== 0) b |= 0x80; bytes.push(b); } while (v !== 0);
  return Buffer.from(bytes);
}
function mcString(str) {
  const b = Buffer.from(str, "utf8");
  return Buffer.concat([writeVarInt(b.length), b]);
}
function mcPacket(id, payload) {
  const body = Buffer.concat([writeVarInt(id), payload]);
  return Buffer.concat([writeVarInt(body.length), body]);
}

// Parse the first (handshake) packet. Returns { address, nextState, consumed } or
// null if not enough bytes yet.
function parseHandshake(buf) {
  const lenVar = readVarInt(buf, 0);
  if (!lenVar) return null;
  const total = lenVar.size + lenVar.value;
  if (buf.length < total) return null;
  let off = lenVar.size;
  const pid = readVarInt(buf, off); off += pid.size;
  if (pid.value !== 0x00) return { unknown: true, consumed: total };
  const proto = readVarInt(buf, off); off += proto.size;
  const addrLen = readVarInt(buf, off); off += addrLen.size;
  const address = buf.toString("utf8", off, off + addrLen.value); off += addrLen.value;
  off += 2; // unsigned short port
  const nextState = readVarInt(buf, off); off += nextState.size;
  return { protocol: proto.value, address, nextState: nextState.value, consumed: total };
}

// <sub>.redstonemc.net  ->  "sub" (also strips Forge's \0FML\0 handshake tag).
function subdomainFromAddress(address) {
  let host = (address || "").split("\0")[0].toLowerCase().trim();
  if (host.endsWith("." + DOMAIN)) return host.slice(0, -("." + DOMAIN).length);
  if (host === DOMAIN) return "";
  return host; // direct-IP / unknown
}

// ───────────────────────── offline placeholder ──────────────────────────
let offlineIconData = null;
try { if (fs.existsSync(OFFLINE_ICON)) offlineIconData = "data:image/png;base64," + fs.readFileSync(OFFLINE_ICON).toString("base64"); } catch { /* ignore */ }

function statusJson(kind) {
  const description = kind === "offline"
    ? { text: "Offline\n", extra: [{ text: "redstone-launcher.com", color: "gray" }] }
    : { text: "This server doesn't exist\n", extra: [{ text: "redstone-launcher.com", color: "gray" }] };
  const obj = { version: { name: "Redstone", protocol: -1 }, players: { max: 0, online: 0, sample: [] }, description };
  if (offlineIconData) obj.favicon = offlineIconData;
  return JSON.stringify(obj);
}

// Serve a status/login placeholder to a client whose subdomain isn't live.
function servePlaceholder(sock, handshake, kind) {
  if (handshake.nextState === 1) {
    // Wait for the Status Request, reply with Status Response, then echo Ping.
    const decode = createMcReader((id, payload) => {
      if (id === 0x00) sock.write(mcPacket(0x00, mcString(statusJson(kind))));
      else if (id === 0x01) sock.write(mcPacket(0x01, payload)); // pong echoes the long
    });
    sock.on("data", decode);
  } else {
    // Login: send a Disconnect with a chat message, then close.
    const msg = kind === "offline"
      ? { text: "This server is offline right now.", color: "red" }
      : { text: "This server doesn't exist.", color: "red" };
    sock.write(mcPacket(0x00, mcString(JSON.stringify(msg))));
    setTimeout(() => { try { sock.end(); } catch { /* ignore */ } }, 100);
  }
}

// A length-prefixed Minecraft packet reader (post-handshake, uncompressed).
function createMcReader(onPacket) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      const lv = readVarInt(buf, 0);
      if (!lv || buf.length < lv.size + lv.value) break;
      const body = buf.subarray(lv.size, lv.size + lv.value);
      const idv = readVarInt(body, 0);
      onPacket(idv.value, Buffer.from(body.subarray(idv.size)));
      buf = buf.subarray(lv.size + lv.value);
    }
  };
}

// ───────────────────────── state / admins ───────────────────────────────
function loadJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
let adminUuids = new Set((loadJson(ADMINS_FILE, { uuids: [] }).uuids || []).map(u => String(u).replace(/-/g, "").toLowerCase()));
let recentSubs = loadJson(STATE_FILE, {}); // subdomain -> lastUsed ms
function saveState() { try { fs.writeFileSync(STATE_FILE, JSON.stringify(recentSubs)); } catch { /* ignore */ } }

// ───────────────────────── Mojang hasJoined auth ────────────────────────
function hasJoined(username, serverId) {
  return new Promise((resolve) => {
    const url = `https://sessionserver.mojang.com/session/minecraft/hasJoined?username=${encodeURIComponent(username)}&serverId=${encodeURIComponent(serverId)}`;
    https.get(url, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      let data = ""; res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    }).on("error", () => resolve(null));
  });
}

// subdomain -> { sock, send, streams, nextStream }
const hosts = new Map();

function subdomainAllowed(requested, username, uuid) {
  if (adminUuids.has(uuid)) return true;
  const u = username.toLowerCase();
  const labels = requested.split(".");
  return requested === u || (labels.length >= 2 && labels[labels.length - 1] === u);
}

// ───────────────────────── control server (TLS) ─────────────────────────
let tlsOptions;
try { tlsOptions = { key: fs.readFileSync(TLS_KEY), cert: fs.readFileSync(TLS_CERT) }; }
catch (e) {
  console.error(`\n[Redstone Relay] Could not read TLS cert.\n  key : ${TLS_KEY}\n  cert: ${TLS_CERT}\n  (${e.code || e.message})\n\nGet one with: sudo certbot certonly --standalone -d ${DOMAIN} -d '*.${DOMAIN}'\n`);
  process.exit(1);
}

const control = tls.createServer(tlsOptions, (sock) => {
  const state = { authed: false, sub: null, streams: new Map(), nextStream: 1, serverId: null, want: null, localPort: null };
  const send = (type, streamId, payload) => { try { sock.write(encodeFrame(type, streamId, payload)); } catch { /* ignore */ } };

  const decode = createDecoder(async (type, streamId, payload) => {
    if (type === T.HELLO) {
      let info = {}; try { info = JSON.parse(payload.toString()); } catch { /* ignore */ }
      state.want = String(info.subdomain || "").toLowerCase();
      state.localPort = info.localPort;
      state.serverId = crypto.randomBytes(16).toString("hex");
      send(T.CHALLENGE, 0, Buffer.from(JSON.stringify({ serverId: state.serverId })));
      return;
    }
    if (type === T.AUTH) {
      let info = {}; try { info = JSON.parse(payload.toString()); } catch { /* ignore */ }
      const profile = await hasJoined(info.username || "", state.serverId || "");
      if (!profile || !profile.id) { send(T.ERROR, 0, Buffer.from(JSON.stringify({ message: "Premium verification failed" }))); return sock.destroy(); }
      const uuid = String(profile.id).replace(/-/g, "").toLowerCase();
      if (info.uuid && String(info.uuid).replace(/-/g, "").toLowerCase() !== uuid) { send(T.ERROR, 0, Buffer.from(JSON.stringify({ message: "Account mismatch" }))); return sock.destroy(); }
      if (!subdomainAllowed(state.want, profile.name, uuid)) {
        send(T.ERROR, 0, Buffer.from(JSON.stringify({ message: `You can only use <name>.${profile.name}.${DOMAIN} or ${profile.name}.${DOMAIN}` }))); return sock.destroy();
      }
      if (hosts.has(state.want)) { send(T.ERROR, 0, Buffer.from(JSON.stringify({ message: "That address is already in use right now" }))); return sock.destroy(); }
      state.authed = true; state.sub = state.want;
      hosts.set(state.sub, { send, streams: state.streams, nextStream: () => state.nextStream++ });
      recentSubs[state.sub] = Date.now(); saveState();
      log("registered", `${state.sub}.${DOMAIN}`, "->", profile.name);
      send(T.WELCOME, 0, Buffer.from(JSON.stringify({ address: `${state.sub}.${DOMAIN}`, port: MC_PORT })));
      return;
    }
    if (!state.authed) return sock.destroy();
    if (type === T.DATA) { const p = state.streams.get(streamId); if (p) { try { p.write(payload); } catch { /* ignore */ } } }
    else if (type === T.CLOSE) { const p = state.streams.get(streamId); if (p) { state.streams.delete(streamId); try { p.end(); } catch { /* ignore */ } } }
    else if (type === T.PING) send(T.PONG, 0, null);
    else if (type === T.DIRECT) {
      // Host has a public (UPnP) endpoint — point DNS straight at it so players
      // connect directly instead of through the relay.
      let info = {}; try { info = JSON.parse(payload.toString()); } catch { /* ignore */ }
      if (info.ip && CF.enabled && state.sub) {
        cfPointDirect(state.sub, info.ip).then(id => { state.cfRecordId = id; if (id) log("direct DNS", `${state.sub}.${DOMAIN} -> ${info.ip}`); }).catch(e => log("cf error", e.message));
      }
    }
  });

  sock.on("data", decode);
  sock.on("close", () => {
    if (state.sub && hosts.get(state.sub)?.send === send) { hosts.delete(state.sub); recentSubs[state.sub] = Date.now(); saveState(); log("unregistered", state.sub); }
    if (state.cfRecordId) cfRemoveDirect(state.cfRecordId); // restore wildcard -> VPS
    for (const p of state.streams.values()) { try { p.destroy(); } catch { /* ignore */ } }
  });
  sock.on("error", () => {});
});
control.listen(CONTROL_PORT, () => log(`control TLS on :${CONTROL_PORT}`));

// ───────────────────────── public MC port ───────────────────────────────
const mc = net.createServer((client) => {
  let routed = false;
  let acc = Buffer.alloc(0);
  const onData = (chunk) => {
    if (routed) return;
    acc = Buffer.concat([acc, chunk]);
    let hs;
    try { hs = parseHandshake(acc); } catch { client.destroy(); return; }
    if (!hs) return; // wait for more bytes
    routed = true;
    client.removeListener("data", onData);
    if (hs.unknown) { client.destroy(); return; }

    const sub = subdomainFromAddress(hs.address);
    const host = hosts.get(sub);
    if (host) {
      // Live host — open a mux stream and replay the handshake + any extra bytes.
      const streamId = host.nextStream() >>> 0 || 1;
      host.streams.set(streamId, client);
      host.send(T.OPEN, streamId, null);
      host.send(T.DATA, streamId, acc); // includes the handshake we consumed
      client.on("data", (d) => host.send(T.DATA, streamId, d));
      client.on("close", () => { if (host.streams.delete(streamId)) host.send(T.CLOSE, streamId, null); });
      client.on("error", () => {});
    } else {
      // Not live: "offline" if used recently, else "doesn't exist".
      const recent = recentSubs[sub] && (Date.now() - recentSubs[sub] < RECENT_MS);
      servePlaceholder(client, hs, recent ? "offline" : "missing");
      // Re-feed any bytes that arrived after the handshake to the placeholder reader.
      const extra = acc.subarray(hs.consumed);
      if (extra.length) client.emit("data", extra);
    }
  };
  client.on("data", onData);
  client.on("error", () => {});
});
mc.listen(MC_PORT, () => log(`public Minecraft on :${MC_PORT} for *.${DOMAIN} (auth ${adminUuids.size} admins)`));
