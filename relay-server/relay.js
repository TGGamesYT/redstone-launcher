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

// The relay must never die from one bad connection (a client force-disconnecting
// on app close, an old/incompatible client speaking a different protocol, a
// Cloudflare hiccup, …). Log and keep serving everyone else.
process.on("uncaughtException", (err) => { try { log("[uncaught]", err && err.stack || err); } catch { /* ignore */ } });
process.on("unhandledRejection", (err) => { try { log("[unhandled]", err && err.stack || err); } catch { /* ignore */ } });

// ───────────────────────── control mux protocol ─────────────────────────
// HTTP (13): a host registers its resource pack for public hosting. Packs are
// served on the SAME public port as Minecraft (25565) — a Minecraft handshake
// never begins with an HTTP method, so we can tell the two apart from the first
// bytes and route by the token in the request URL. No extra port to open.
const T = { HELLO: 1, CHALLENGE: 2, AUTH: 3, WELCOME: 4, ERROR: 5, OPEN: 6, DATA: 7, CLOSE: 8, PING: 9, PONG: 10, DIRECT: 11, DOMAINS: 12, HTTP: 13 };

// URL token (the "random safety token" in the pack path) -> the host serving it.
const packRoutes = new Map();

// Cloudflare DNS (optional). When a host reports a working UPnP public endpoint,
// we point <sub>.redstonemc.net straight at the host's IP so players connect
// DIRECTLY (no relay hop, no latency penalty). Without it, the wildcard record
// keeps *.redstonemc.net on the VPS and the relay tunnel carries the traffic.
const CF = {
  token: process.env.CF_API_TOKEN || "",
  get enabled() { return !!this.token; },
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
// Zones (domains) the token can use — cached briefly. Paginates so all domains
// show up (a token with All-Zones DNS edit lists every zone).
let cfZonesCache = null, cfZonesAt = 0;
async function cfListZones() {
  if (!CF.enabled) return [];
  if (cfZonesCache && Date.now() - cfZonesAt < 120000) return cfZonesCache;
  const zones = [];
  for (let page = 1; page <= 10; page++) {
    const res = await cfRequest("GET", `/zones?per_page=50&page=${page}`);
    if (!res || res.success === false) {
      log("Cloudflare /zones failed — token likely needs 'Zone:Read'. Response:", JSON.stringify(res?.errors || res));
      break;
    }
    for (const z of (res.result || [])) zones.push({ id: z.id, name: z.name });
    const ti = res.result_info;
    if (!ti || page >= (ti.total_pages || 1)) break;
  }
  cfZonesCache = zones; cfZonesAt = Date.now();
  log("Cloudflare zones available:", zones.map(z => z.name).join(", ") || "(none)");
  return cfZonesCache;
}
async function cfZoneIdFor(domain) {
  return (await cfListZones()).find(z => z.name === domain)?.id || null;
}
// Point a full hostname's A record at an IP (in whichever zone owns it).
async function cfPointDirect(fullHost, domain, ip) {
  const zoneId = await cfZoneIdFor(domain);
  if (!zoneId) return null;
  const existing = await cfRequest("GET", `/zones/${zoneId}/dns_records?type=A&name=${encodeURIComponent(fullHost)}`);
  for (const r of (existing?.result || [])) { try { await cfRequest("DELETE", `/zones/${zoneId}/dns_records/${r.id}`); } catch { /* ignore */ } }
  const res = await cfRequest("POST", `/zones/${zoneId}/dns_records`, { type: "A", name: fullHost, content: ip, ttl: 60, proxied: false });
  return res?.result?.id ? { id: res.result.id, zoneId } : null;
}
async function cfRemoveDirect(rec) { if (!rec) return; try { await cfRequest("DELETE", `/zones/${rec.zoneId}/dns_records/${rec.id}`); } catch { /* ignore */ } }
function encodeFrame(type, streamId, payload) {
  const len = payload ? payload.length : 0;
  const buf = Buffer.allocUnsafe(9 + len);
  buf.writeUInt8(type, 0); buf.writeUInt32BE(streamId >>> 0, 1); buf.writeUInt32BE(len, 5);
  if (len) payload.copy(buf, 9);
  return buf;
}
function createDecoder(onFrame, onError) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 9) {
      const len = buf.readUInt32BE(5);
      // A garbage length (e.g. an old/incompatible client, or something speaking
      // the wrong protocol at the control port) would otherwise buffer forever /
      // OOM. No legitimate control frame is anywhere near this big.
      if (len > 8 * 1024 * 1024) { if (onError) onError(new Error("oversized frame")); return; }
      if (buf.length < 9 + len) break;
      try {
        const r = onFrame(buf.readUInt8(0), buf.readUInt32BE(1), Buffer.from(buf.subarray(9, 9 + len)));
        if (r && typeof r.then === "function") r.catch((e) => { if (onError) onError(e); });
      } catch (e) { if (onError) onError(e); return; }
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

// Full hostname the client connected to (strips Forge's \0FML\0 handshake tag).
// Hosts are keyed by this so we can route multiple domains, not just the primary.
function hostFromAddress(address) {
  return (address || "").split("\0")[0].toLowerCase().trim();
}

// ───────────────────────── offline placeholder ──────────────────────────
// Load the server-list favicon lazily + cache by mtime so you can drop in / swap
// the Velocity server-icon.png without restarting. Minecraft only accepts a
// 64×64 PNG data URI, so we validate the PNG signature.
let _iconCache = { mtime: 0, data: null };
function offlineIcon() {
  try {
    if (!fs.existsSync(OFFLINE_ICON)) return null;
    const st = fs.statSync(OFFLINE_ICON);
    if (st.mtimeMs !== _iconCache.mtime) {
      const buf = fs.readFileSync(OFFLINE_ICON);
      const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
      _iconCache = { mtime: st.mtimeMs, data: isPng ? "data:image/png;base64," + buf.toString("base64") : null };
      if (!isPng) log("offline icon is not a PNG, ignoring:", OFFLINE_ICON);
    }
    return _iconCache.data;
  } catch { return null; }
}

function statusJson(kind) {
  // Mirrors the old Velocity MOTDs:
  //   <dark_red>This server doesn't exist<newline><red>redstone-launcher.com
  //   <dark_red>This server is offline<newline><red>redstone-launcher.com
  const line1 = kind === "offline" ? "This server is offline" : "This server doesn't exist";
  const description = {
    text: "", extra: [
      { text: line1, color: "dark_red" },
      { text: "\n" },
      { text: "redstone-launcher.com", color: "red" },
    ],
  };
  const obj = { version: { name: "Redstone Launcher", protocol: -1 }, players: { max: 0, online: 0, sample: [] }, description };
  const icon = offlineIcon();
  if (icon) obj.favicon = icon;
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

// full hostname -> { send, streams, nextStream }
const hosts = new Map();

// Non-admins may only claim <username>.DOMAIN or <label>.<username>.DOMAIN. The
// `username` here is the Mojang-VERIFIED profile name (never client-supplied).
function nonAdminSubAllowed(requested, username) {
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

const secureContext = tls.createSecureContext(tlsOptions);
// The control-channel handler, run on a TLS socket (see the demuxing listener
// below — the same port also serves plain-HTTP resource-pack requests).
function handleControl(sock) {
  // CRITICAL for latency: disable Nagle so muxed game packets aren't buffered.
  try { sock.setNoDelay(true); } catch { /* ignore */ }
  const state = { authed: false, host: null, domain: DOMAIN, streams: new Map(), nextStream: 1, serverId: null, want: null, wantDomain: DOMAIN, localPort: null, queryDomains: false };
  const send = (type, streamId, payload) => { try { sock.write(encodeFrame(type, streamId, payload)); } catch { /* ignore */ } };

  const decode = createDecoder(async (type, streamId, payload) => {
    if (type === T.HELLO) {
      let info = {}; try { info = JSON.parse(payload.toString()); } catch { /* ignore */ }
      state.want = String(info.subdomain || "").toLowerCase().trim();
      state.wantDomain = String(info.domain || DOMAIN).toLowerCase().trim();
      state.localPort = info.localPort;
      state.queryDomains = !!info.queryDomains;
      state.serverId = crypto.randomBytes(16).toString("hex");
      send(T.CHALLENGE, 0, Buffer.from(JSON.stringify({ serverId: state.serverId })));
      return;
    }
    if (type === T.AUTH) {
      let info = {}; try { info = JSON.parse(payload.toString()); } catch { /* ignore */ }
      // SECURITY: identity is established ONLY by Mojang's hasJoined for the
      // per-connection random serverId. The resulting profile.id is the sole
      // source of truth — nothing the client sends (uuid, "isAdmin", …) is
      // trusted. A modified app cannot forge another account's session.
      const profile = await hasJoined(info.username || "", state.serverId || "");
      if (!profile || !profile.id) { send(T.ERROR, 0, Buffer.from(JSON.stringify({ message: "Premium verification failed" }))); return sock.destroy(); }
      const uuid = String(profile.id).replace(/-/g, "").toLowerCase();
      const isAdmin = adminUuids.has(uuid);

      // Admin-only: just querying which domains they may use (for the dropdown).
      if (state.queryDomains) {
        const domains = isAdmin ? (CF.enabled ? [...new Set([DOMAIN, ...(await cfListZones()).map(z => z.name)])] : [DOMAIN]) : [];
        send(T.DOMAINS, 0, Buffer.from(JSON.stringify({ isAdmin, domains })));
        return sock.destroy();
      }

      const domain = state.wantDomain || DOMAIN;
      // Validate the claim against the VERIFIED identity.
      if (isAdmin) {
        const zones = CF.enabled ? (await cfListZones()).map(z => z.name) : [];
        if (domain !== DOMAIN && !zones.includes(domain)) {
          send(T.ERROR, 0, Buffer.from(JSON.stringify({ message: "That domain isn't managed by this relay" }))); return sock.destroy();
        }
      } else {
        if (domain !== DOMAIN || !nonAdminSubAllowed(state.want, profile.name)) {
          send(T.ERROR, 0, Buffer.from(JSON.stringify({ message: `You can only use <name>.${profile.name}.${DOMAIN} or ${profile.name}.${DOMAIN}` }))); return sock.destroy();
        }
      }
      const fullHost = state.want ? `${state.want}.${domain}` : domain;
      if (hosts.has(fullHost)) { send(T.ERROR, 0, Buffer.from(JSON.stringify({ message: "That address is already in use right now" }))); return sock.destroy(); }
      state.authed = true; state.host = fullHost; state.domain = domain;
      hosts.set(fullHost, { send, streams: state.streams, nextStream: () => state.nextStream++ });
      recentSubs[fullHost] = Date.now(); saveState();
      log("registered", fullHost, "->", profile.name, isAdmin ? "(admin)" : "");
      send(T.WELCOME, 0, Buffer.from(JSON.stringify({ address: fullHost, port: MC_PORT })));
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
      if (info.ip && CF.enabled && state.host) {
        cfPointDirect(state.host, state.domain, info.ip).then(rec => { state.cfRecord = rec; if (rec) log("direct DNS", `${state.host} -> ${info.ip}`); }).catch(e => log("cf error", e.message));
      }
    }
    else if (type === T.HTTP) {
      // Register this host's pack under its URL token; served on the shared
      // HTTP_PORT. Re-registering with a new token replaces the old one.
      let info = {}; try { info = JSON.parse(payload.toString()); } catch { /* ignore */ }
      if (info.token) {
        if (state.packToken && state.packToken !== info.token) packRoutes.delete(state.packToken);
        state.packToken = info.token;
        state.httpLocalPort = info.localHttpPort;
        packRoutes.set(info.token, { state, send, localHttpPort: info.localHttpPort });
        log("pack route", String(info.token).slice(0, 8), "->", state.host, ":" + info.localHttpPort);
      }
      // Packs are served on the control port (separate from Minecraft's 25565).
      send(T.HTTP, 0, Buffer.from(JSON.stringify({ port: CONTROL_PORT })));
    }
  }, (e) => { log("[control frame]", e && e.message); try { sock.destroy(); } catch { /* ignore */ } });

  sock.on("data", decode);
  sock.on("close", () => {
    try {
      if (state.host && hosts.get(state.host)?.send === send) { hosts.delete(state.host); recentSubs[state.host] = Date.now(); saveState(); log("unregistered", state.host); }
      if (state.cfRecord) cfRemoveDirect(state.cfRecord); // restore wildcard -> VPS
      if (state.packToken) packRoutes.delete(state.packToken);
      for (const p of state.streams.values()) { try { p.destroy(); } catch { /* ignore */ } }
    } catch (e) { log("[close]", e.message); }
  });
  sock.on("error", () => {});
}

// Read a resource-pack HTTP request off a plain connection, then route it.
function servePackHttpConn(conn) {
  let acc = Buffer.alloc(0), done = false;
  const onData = (chunk) => {
    if (done) return;
    acc = acc.length ? Buffer.concat([acc, chunk]) : chunk;
    const nl = acc.indexOf(0x0a); // end of the HTTP request line
    if (nl < 0) { if (acc.length > 16384) { try { conn.destroy(); } catch { /* ignore */ } } return; }
    done = true; conn.removeListener("data", onData);
    servePackHttp(conn, acc);
  };
  conn.on("data", onData);
  conn.on("error", () => { /* ignore */ });
}

// The control port serves BOTH the TLS control channel AND plain-HTTP resource
// packs. Peek the first byte: 0x16 is a TLS handshake (control); an HTTP verb is
// a pack request. Nothing touches the public Minecraft port (25565).
const control = net.createServer((raw) => {
  try { raw.setNoDelay(true); } catch { /* ignore */ }
  raw.once("readable", () => {
    const chunk = raw.read(1);
    if (!chunk) { try { raw.destroy(); } catch { /* ignore */ } return; }
    raw.unshift(chunk); // put the peeked byte back for the real handler
    if (chunk[0] === 0x16) {
      const tlsSock = new tls.TLSSocket(raw, { isServer: true, secureContext });
      tlsSock.on("error", () => { try { tlsSock.destroy(); } catch { /* ignore */ } });
      handleControl(tlsSock);
    } else if (chunk[0] >= 0x41 && chunk[0] <= 0x5a) { // ASCII 'A'–'Z' → HTTP method
      servePackHttpConn(raw);
    } else {
      try { raw.destroy(); } catch { /* ignore */ }
    }
  });
  raw.on("error", () => { /* ignore */ });
});
control.listen(CONTROL_PORT, () => log(`control TLS + pack HTTP on :${CONTROL_PORT}`));

// Serve a resource-pack HTTP request (arriving on the control port). Reads the
// token from the URL (/<player>/<token>/<pack>.zip), finds the host that
// registered it, and muxes the raw connection to that host's local pack server.
function servePackHttp(conn, acc) {
  const nl = acc.indexOf(0x0a);
  const line = acc.toString("latin1", 0, nl < 0 ? acc.length : nl);
  const m = line.match(/^[A-Z]+\s+\/[^/\s]+\/([^/\s]+)\//);
  const route = m && packRoutes.get(m[1]);
  if (!route) {
    const body = "Not found";
    try { conn.end(`HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`); } catch { /* ignore */ }
    return;
  }
  const st = route.state;
  const streamId = (st.nextStream++) >>> 0 || 1;
  st.streams.set(streamId, conn);
  route.send(T.OPEN, streamId, Buffer.from(JSON.stringify({ port: route.localHttpPort })));
  route.send(T.DATA, streamId, acc); // replay the request bytes we peeked
  conn.on("data", (d) => route.send(T.DATA, streamId, d));
  conn.on("close", () => { if (st.streams.delete(streamId)) route.send(T.CLOSE, streamId, null); });
  conn.on("error", () => { /* ignore */ });
}

// ───────────────────────── public MC port ───────────────────────────────
const mc = net.createServer((client) => {
  try { client.setNoDelay(true); } catch { /* ignore */ } // no Nagle → low latency
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

    const fullHost = hostFromAddress(hs.address);
    const host = hosts.get(fullHost);
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
      const recent = recentSubs[fullHost] && (Date.now() - recentSubs[fullHost] < RECENT_MS);
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
