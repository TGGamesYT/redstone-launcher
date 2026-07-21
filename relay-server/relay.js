#!/usr/bin/env node
// Redstone Relay — a reverse-TCP tunnel ("ICE"-style NAT traversal) so servers
// hosted from the Redstone Launcher are joinable over the internet WITHOUT the
// host having to port-forward or enable UPnP.
//
// How it works
// ------------
//   1. The host (the launcher) opens ONE TLS control connection to CONTROL_PORT
//      and authenticates with a token.
//   2. The relay allocates a fresh, unique public TCP port for that host and
//      starts listening on it. It replies "join at <DOMAIN>:<port>".
//   3. Every player that connects to that public port becomes a multiplexed
//      stream carried over the host's control connection; the host dials its own
//      local Minecraft server (127.0.0.1:<localPort>) and pipes bytes back.
//
// All launcher<->relay traffic is TLS-encrypted and token-authenticated. Players
// use a vanilla Minecraft client and connect straight to <DOMAIN>:<port> — they
// don't need the launcher or anything special.
//
// Deploy: see README.md (TLS cert for your domain, open the public port RANGE in
// the VPS firewall, run under systemd/pm2).

import net from "net";
import tls from "tls";
import fs from "fs";

const CONTROL_PORT = parseInt(process.env.RELAY_CONTROL_PORT || "47238", 10);
const DOMAIN = process.env.RELAY_DOMAIN || "redstonemc.net";
const PORT_MIN = parseInt(process.env.RELAY_PORT_MIN || "40000", 10);
const PORT_MAX = parseInt(process.env.RELAY_PORT_MAX || "60000", 10);
// Comma-separated list of accepted tokens. If empty, the relay runs OPEN (any
// launcher may connect) — fine for personal use, but set tokens to lock it down.
const TOKENS = (process.env.RELAY_TOKENS || "").split(",").map(s => s.trim()).filter(Boolean);
// Default to the standard certbot / Let's Encrypt location for the domain.
const TLS_KEY = process.env.RELAY_TLS_KEY || `/etc/letsencrypt/live/${DOMAIN}/privkey.pem`;
const TLS_CERT = process.env.RELAY_TLS_CERT || `/etc/letsencrypt/live/${DOMAIN}/fullchain.pem`;
const MAX_HOSTS = parseInt(process.env.RELAY_MAX_HOSTS || "200", 10);

// Frame types (control-connection multiplexing protocol).
const T = { HELLO: 1, WELCOME: 2, OPEN: 3, DATA: 4, CLOSE: 5, ERROR: 6, PING: 7, PONG: 8 };

function log(...a) { console.log(new Date().toISOString(), ...a); }

// --- Frame codec: [u8 type][u32 streamId][u32 len][payload...] ---
function encodeFrame(type, streamId, payload) {
  const len = payload ? payload.length : 0;
  const buf = Buffer.allocUnsafe(9 + len);
  buf.writeUInt8(type, 0);
  buf.writeUInt32BE(streamId >>> 0, 1);
  buf.writeUInt32BE(len, 5);
  if (len) payload.copy(buf, 9);
  return buf;
}
// Stateful decoder: feeds complete frames (payload copied out) to onFrame.
function createDecoder(onFrame) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 9) {
      const len = buf.readUInt32BE(5);
      if (buf.length < 9 + len) break;
      const type = buf.readUInt8(0);
      const streamId = buf.readUInt32BE(1);
      const payload = Buffer.from(buf.subarray(9, 9 + len)); // copy — buf gets sliced
      onFrame(type, streamId, payload);
      buf = buf.subarray(9 + len);
    }
  };
}

// Grab a random free public port in [PORT_MIN, PORT_MAX].
function pickPort() {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const tryOne = () => {
      if (++attempts > 60) return reject(new Error("no free public port available"));
      const p = PORT_MIN + Math.floor(Math.random() * (PORT_MAX - PORT_MIN + 1));
      const tester = net.createServer();
      tester.once("error", () => { try { tester.close(); } catch { /* ignore */ } tryOne(); });
      tester.once("listening", () => tester.close(() => resolve(p)));
      tester.listen(p, "0.0.0.0");
    };
    tryOne();
  });
}

let tlsOptions;
try {
  tlsOptions = { key: fs.readFileSync(TLS_KEY), cert: fs.readFileSync(TLS_CERT) };
} catch (e) {
  console.error(`\n[Redstone Relay] Could not read TLS certificate.\n  key : ${TLS_KEY}\n  cert: ${TLS_CERT}\n  (${e.code || e.message})\n\n` +
    `Get a free cert with certbot, e.g.:\n  sudo certbot certonly --standalone -d ${DOMAIN}\n` +
    `then it will live at /etc/letsencrypt/live/${DOMAIN}/ . Or point RELAY_TLS_KEY / RELAY_TLS_CERT at your own files.\n`);
  process.exit(1);
}
let hostCount = 0;

const server = tls.createServer(tlsOptions, (sock) => {
  const host = { authed: false, publicServer: null, streams: new Map(), nextStream: 1, port: null };
  const send = (type, streamId, payload) => { try { sock.write(encodeFrame(type, streamId, payload)); } catch { /* ignore */ } };

  const decode = createDecoder((type, streamId, payload) => {
    if (type === T.HELLO) {
      let info = {};
      try { info = JSON.parse(payload.toString()); } catch { /* ignore */ }
      if (TOKENS.length && !TOKENS.includes(info.token || "")) {
        send(T.ERROR, 0, Buffer.from(JSON.stringify({ message: "Authentication failed (bad token)" })));
        sock.destroy();
        return;
      }
      if (hostCount >= MAX_HOSTS) {
        send(T.ERROR, 0, Buffer.from(JSON.stringify({ message: "Relay is at capacity, try again later" })));
        sock.destroy();
        return;
      }
      host.authed = true;
      hostCount++;
      pickPort().then((port) => {
        host.port = port;
        // Public listener: each inbound player becomes a multiplexed stream.
        const pub = net.createServer((player) => {
          const streamId = host.nextStream++ >>> 0 || 1;
          host.streams.set(streamId, player);
          send(T.OPEN, streamId, null);
          player.on("data", (d) => send(T.DATA, streamId, d));
          player.on("close", () => {
            if (host.streams.delete(streamId)) send(T.CLOSE, streamId, null);
          });
          player.on("error", () => {});
        });
        pub.on("error", (e) => log("public listener error on", port, e.message));
        pub.listen(port, "0.0.0.0", () => {
          host.publicServer = pub;
          log("host authenticated; assigned public port", port);
          send(T.WELCOME, 0, Buffer.from(JSON.stringify({ host: DOMAIN, port })));
        });
      }).catch((e) => {
        send(T.ERROR, 0, Buffer.from(JSON.stringify({ message: e.message })));
        sock.destroy();
      });
      return;
    }

    if (!host.authed) { sock.destroy(); return; }

    if (type === T.DATA) {
      const player = host.streams.get(streamId);
      if (player) { try { player.write(payload); } catch { /* ignore */ } }
    } else if (type === T.CLOSE) {
      const player = host.streams.get(streamId);
      if (player) { host.streams.delete(streamId); try { player.end(); } catch { /* ignore */ } }
    } else if (type === T.PING) {
      send(T.PONG, 0, null);
    }
  });

  sock.on("data", decode);
  const cleanup = () => {
    if (host.authed) hostCount = Math.max(0, hostCount - 1);
    if (host.publicServer) { try { host.publicServer.close(); } catch { /* ignore */ } }
    for (const p of host.streams.values()) { try { p.destroy(); } catch { /* ignore */ } }
    host.streams.clear();
    if (host.port) log("host disconnected; freed public port", host.port);
  };
  sock.on("close", cleanup);
  sock.on("error", () => {});
});

server.on("error", (e) => { log("FATAL control server error:", e.message); process.exit(1); });
server.listen(CONTROL_PORT, () =>
  log(`Redstone Relay: control TLS on :${CONTROL_PORT}, public ports ${PORT_MIN}-${PORT_MAX}, domain ${DOMAIN}, auth ${TOKENS.length ? "on" : "OPEN"}`));
