// Launcher-side client for the Redstone Relay (see relay-server/). Opens a TLS
// control connection, registers a local server port, and pipes each inbound
// player stream to 127.0.0.1:<localPort>. No port forwarding / UPnP needed.
import net from "net";
import tls from "tls";

const T = { HELLO: 1, WELCOME: 2, OPEN: 3, DATA: 4, CLOSE: 5, ERROR: 6, PING: 7, PONG: 8 };

function encodeFrame(type, streamId, payload) {
  const len = payload ? payload.length : 0;
  const buf = Buffer.allocUnsafe(9 + len);
  buf.writeUInt8(type, 0);
  buf.writeUInt32BE(streamId >>> 0, 1);
  buf.writeUInt32BE(len, 5);
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
      const type = buf.readUInt8(0);
      const streamId = buf.readUInt32BE(1);
      const payload = Buffer.from(buf.subarray(9, 9 + len));
      onFrame(type, streamId, payload);
      buf = buf.subarray(9 + len);
    }
  };
}

// Open a relay session for a local Minecraft server.
// Resolves { host, port, close() } once the relay assigns a public port.
export function openRelay({ host, controlPort, token, localPort, rejectUnauthorized = true }) {
  return new Promise((resolve, reject) => {
    const streams = new Map(); // streamId -> { socket, buffer:[], connected }
    let settled = false;
    let keepalive = null;

    const sock = tls.connect(
      { host, port: controlPort, servername: host, rejectUnauthorized },
      () => sock.write(encodeFrame(T.HELLO, 0, Buffer.from(JSON.stringify({ token, localPort }))))
    );
    const send = (type, streamId, payload) => { try { sock.write(encodeFrame(type, streamId, payload)); } catch { /* ignore */ } };

    const decode = createDecoder((type, streamId, payload) => {
      if (type === T.WELCOME) {
        let info = {};
        try { info = JSON.parse(payload.toString()); } catch { /* ignore */ }
        settled = true;
        keepalive = setInterval(() => send(T.PING, 0, null), 20000);
        resolve({
          host: info.host, port: info.port,
          close: () => { if (keepalive) clearInterval(keepalive); try { sock.end(); } catch { /* ignore */ } },
        });
      } else if (type === T.ERROR) {
        let m = "relay error";
        try { m = JSON.parse(payload.toString()).message; } catch { /* ignore */ }
        if (!settled) reject(new Error(m));
      } else if (type === T.OPEN) {
        // A player connected — dial the local Minecraft server for this stream.
        const local = net.connect({ host: "127.0.0.1", port: localPort });
        const st = { socket: local, buffer: [], connected: false };
        streams.set(streamId, st);
        local.on("connect", () => {
          st.connected = true;
          for (const b of st.buffer) { try { local.write(b); } catch { /* ignore */ } }
          st.buffer = [];
        });
        local.on("data", (d) => send(T.DATA, streamId, d));
        local.on("close", () => { if (streams.delete(streamId)) send(T.CLOSE, streamId, null); });
        local.on("error", () => { /* local server not up yet / gone */ });
      } else if (type === T.DATA) {
        const st = streams.get(streamId);
        if (st) { if (st.connected) { try { st.socket.write(payload); } catch { /* ignore */ } } else st.buffer.push(payload); }
      } else if (type === T.CLOSE) {
        const st = streams.get(streamId);
        if (st) { streams.delete(streamId); try { st.socket.end(); } catch { /* ignore */ } }
      }
      // PONG: ignored (keepalive ack).
    });

    sock.on("data", decode);
    sock.on("error", (e) => { if (!settled) reject(e); });
    sock.on("close", () => {
      if (keepalive) clearInterval(keepalive);
      for (const st of streams.values()) { try { st.socket.destroy(); } catch { /* ignore */ } }
      streams.clear();
    });
    sock.setTimeout(15000, () => { if (!settled) { sock.destroy(); reject(new Error("Relay connection timed out")); } });
  });
}

export default { openRelay };
