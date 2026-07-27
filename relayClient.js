// Launcher-side client for the Redstone Relay. Connects over TLS, proves
// ownership of a premium account via Mojang's join/hasJoined challenge, claims a
// subdomain, and pipes each inbound player stream to a local Minecraft port.
import net from "net";
import tls from "tls";
import https from "https";

const T = { HELLO: 1, CHALLENGE: 2, AUTH: 3, WELCOME: 4, ERROR: 5, OPEN: 6, DATA: 7, CLOSE: 8, PING: 9, PONG: 10 };

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

// Client half of the Mojang "join" handshake: tells the session server we intend
// to join a server identified by `serverId`; the relay then verifies via
// hasJoined. Resolves true on the expected 204.
function mojangJoin(accessToken, uuid, serverId) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ accessToken, selectedProfile: String(uuid).replace(/-/g, ""), serverId });
    const req = https.request({
      host: "sessionserver.mojang.com", path: "/session/minecraft/join", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode === 204 || res.statusCode === 200)); });
    req.on("error", () => resolve(false));
    req.write(body); req.end();
  });
}

// Open a relay session. Resolves { address, port, close() }.
//   account: { accessToken, uuid, name }  (a verified premium account)
export function openRelay({ host, controlPort, subdomain, localPort, account, rejectUnauthorized = true }) {
  return new Promise((resolve, reject) => {
    const streams = new Map();
    let settled = false, keepalive = null;

    const sock = tls.connect({ host, port: controlPort, servername: host, rejectUnauthorized }, () => {
      sock.write(encodeFrame(T.HELLO, 0, Buffer.from(JSON.stringify({ subdomain, localPort }))));
    });
    const send = (type, streamId, payload) => { try { sock.write(encodeFrame(type, streamId, payload)); } catch { /* ignore */ } };

    const decode = createDecoder(async (type, streamId, payload) => {
      if (type === T.CHALLENGE) {
        let info = {}; try { info = JSON.parse(payload.toString()); } catch { /* ignore */ }
        const ok = await mojangJoin(account.accessToken, account.uuid, info.serverId);
        if (!ok) { if (!settled) reject(new Error("Could not verify your Minecraft account with Mojang")); try { sock.end(); } catch { /* ignore */ } return; }
        send(T.AUTH, 0, Buffer.from(JSON.stringify({ username: account.name, uuid: account.uuid })));
      } else if (type === T.WELCOME) {
        let info = {}; try { info = JSON.parse(payload.toString()); } catch { /* ignore */ }
        if (!info.address || !info.port) { if (!settled) reject(new Error("Relay did not assign an address")); try { sock.end(); } catch { /* ignore */ } return; }
        settled = true;
        keepalive = setInterval(() => send(T.PING, 0, null), 20000);
        resolve({ address: info.address, port: info.port, close: () => { if (keepalive) clearInterval(keepalive); try { sock.end(); } catch { /* ignore */ } } });
      } else if (type === T.ERROR) {
        let m = "relay error"; try { m = JSON.parse(payload.toString()).message; } catch { /* ignore */ }
        if (!settled) reject(new Error(m));
      } else if (type === T.OPEN) {
        const local = net.connect({ host: "127.0.0.1", port: localPort });
        const st = { socket: local, buffer: [], connected: false };
        streams.set(streamId, st);
        local.on("connect", () => { st.connected = true; for (const b of st.buffer) { try { local.write(b); } catch { /* ignore */ } } st.buffer = []; });
        local.on("data", (d) => send(T.DATA, streamId, d));
        local.on("close", () => { if (streams.delete(streamId)) send(T.CLOSE, streamId, null); });
        local.on("error", () => {});
      } else if (type === T.DATA) {
        const st = streams.get(streamId);
        if (st) { if (st.connected) { try { st.socket.write(payload); } catch { /* ignore */ } } else st.buffer.push(payload); }
      } else if (type === T.CLOSE) {
        const st = streams.get(streamId);
        if (st) { streams.delete(streamId); try { st.socket.end(); } catch { /* ignore */ } }
      }
    });

    sock.on("data", decode);
    sock.on("error", (e) => { if (!settled) reject(e); });
    sock.on("close", () => { if (keepalive) clearInterval(keepalive); for (const st of streams.values()) { try { st.socket.destroy(); } catch { /* ignore */ } } streams.clear(); });
    sock.setTimeout(20000, () => { if (!settled) { sock.destroy(); reject(new Error("Relay connection timed out")); } });
  });
}

export default { openRelay };
