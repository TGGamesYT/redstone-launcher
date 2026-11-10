// Launcher-side client for the Redstone Relay. Connects over TLS, proves
// ownership of a premium account via Mojang's join/hasJoined challenge, claims a
// subdomain, and pipes each inbound player stream to a local Minecraft port.
import net from "net";
import tls from "tls";
import https from "https";

const T = { HELLO: 1, CHALLENGE: 2, AUTH: 3, WELCOME: 4, ERROR: 5, OPEN: 6, DATA: 7, CLOSE: 8, PING: 9, PONG: 10, DIRECT: 11, DOMAINS: 12, HTTP: 13, SYNC: 14, SYNC_DATA: 15, SEEN: 16, SEEN_DATA: 17, SUGGEST: 18, SUGGEST_DATA: 19, ADMIN: 20, ADMIN_DATA: 21, THEME: 22, THEME_DATA: 23, ALIAS: 24, ALIAS_DATA: 25, CLOUD: 26, CLOUD_DATA: 27 };

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

// Ask the relay whether an account is an admin and which domains it may use.
// Resolves { isAdmin, domains }. Does a full Mojang challenge (no registration).
export function queryRelay({ host, controlPort, account, rejectUnauthorized = true }) {
  return new Promise((resolve, reject) => {
    let done = false;
    const sock = tls.connect({ host, port: controlPort, servername: host, rejectUnauthorized }, () =>
      sock.write(encodeFrame(T.HELLO, 0, Buffer.from(JSON.stringify({ queryDomains: true })))));
    const send = (t, s, p) => { try { sock.write(encodeFrame(t, s, p)); } catch { /* ignore */ } };
    const decode = createDecoder(async (type, streamId, payload) => {
      if (type === T.CHALLENGE) {
        let info = {}; try { info = JSON.parse(payload.toString()); } catch { /* ignore */ }
        const ok = await mojangJoin(account.accessToken, account.uuid, info.serverId);
        if (!ok) { done = true; reject(new Error("Could not verify your Minecraft account")); try { sock.end(); } catch { /* ignore */ } return; }
        send(T.AUTH, 0, Buffer.from(JSON.stringify({ username: account.name })));
      } else if (type === T.DOMAINS) {
        done = true; let info = {}; try { info = JSON.parse(payload.toString()); } catch { /* ignore */ }
        resolve({ isAdmin: !!info.isAdmin, domains: info.domains || [] });
        try { sock.end(); } catch { /* ignore */ }
      } else if (type === T.ERROR) {
        let m = "relay error"; try { m = JSON.parse(payload.toString()).message; } catch { /* ignore */ }
        if (!done) { done = true; reject(new Error(m)); }
      }
    });
    sock.on("data", decode);
    sock.on("error", (e) => { if (!done) { done = true; reject(e); } });
    sock.setTimeout(20000, () => { if (!done) { done = true; sock.destroy(); reject(new Error("Relay timed out")); } });
  });
}

// Read or write this account's own stored data on the relay. Same shape as
// queryRelay: connect, prove the account with Mojang's join/hasJoined
// challenge, do one thing, disconnect. The relay keys the blob by the UUID it
// verified on this connection, so an account can only touch its own.
//   op: "get" | "put"   kind: "skins"
export function syncRelay({ host, controlPort, account, op = "get", kind = "skins", data = null, rejectUnauthorized = true }) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, v) => { if (done) return; done = true; fn(v); try { sock.end(); } catch { /* ignore */ } };
    const sock = tls.connect({ host, port: controlPort, servername: host, rejectUnauthorized }, () =>
      sock.write(encodeFrame(T.HELLO, 0, Buffer.from(JSON.stringify({ sync: true })))));
    const send = (t, s2, p) => { try { sock.write(encodeFrame(t, s2, p)); } catch { /* ignore */ } };
    const decode = createDecoder(async (type, streamId, payload) => {
      if (type === T.CHALLENGE) {
        let info = {}; try { info = JSON.parse(payload.toString()); } catch { /* ignore */ }
        const ok = await mojangJoin(account.accessToken, account.uuid, info.serverId);
        if (!ok) return finish(reject, new Error("Could not verify your Minecraft account"));
        send(T.AUTH, 0, Buffer.from(JSON.stringify({ username: account.name })));
      } else if (type === T.WELCOME) {
        send(T.SYNC, 0, Buffer.from(JSON.stringify({ op, kind, data })));
      } else if (type === T.SYNC_DATA) {
        let info = {}; try { info = JSON.parse(payload.toString()); } catch { /* ignore */ }
        finish(resolve, info);
      } else if (type === T.ERROR) {
        let m = "relay error"; try { m = JSON.parse(payload.toString()).message; } catch { /* ignore */ }
        finish(reject, new Error(m));
      }
    });
    sock.on("data", decode);
    sock.on("error", (e) => { if (!done) { done = true; reject(e); } });
    sock.setTimeout(30000, () => { if (!done) { done = true; sock.destroy(); reject(new Error("Relay timed out")); } });
  });
}

/**
 * Has this account used Redstone Launcher, and when?
 *
 * The relay is the only thing that can answer it — this computer has no way of
 * knowing about anybody else's. Answers { "<uuid>": { first, last, name } |
 * null }, with an entry for every uuid asked about.
 *
 * Signing in with the asking account's own Mojang session is what gets the
 * connection; the answer is about public accounts, so there is nothing of
 * anybody's to leak.
 */
export function seenRelay({ host, controlPort, account, uuids, rejectUnauthorized = true }) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, v) => { if (done) return; done = true; fn(v); try { sock.end(); } catch { /* ignore */ } };
    const sock = tls.connect({ host, port: controlPort, servername: host, rejectUnauthorized }, () =>
      sock.write(encodeFrame(T.HELLO, 0, Buffer.from(JSON.stringify({ sync: true })))));
    const send = (t, s2, p) => { try { sock.write(encodeFrame(t, s2, p)); } catch { /* ignore */ } };
    const decode = createDecoder(async (type, streamId, payload) => {
      if (type === T.CHALLENGE) {
        let info = {}; try { info = JSON.parse(payload.toString()); } catch { /* ignore */ }
        const ok = await mojangJoin(account.accessToken, account.uuid, info.serverId);
        if (!ok) return finish(reject, new Error("Could not verify your Minecraft account"));
        send(T.AUTH, 0, Buffer.from(JSON.stringify({ username: account.name })));
      } else if (type === T.WELCOME) {
        send(T.SEEN, 0, Buffer.from(JSON.stringify({ uuids })));
      } else if (type === T.SEEN_DATA) {
        let info = {}; try { info = JSON.parse(payload.toString()); } catch { /* ignore */ }
        finish(resolve, (info && info.users) || {});
      } else if (type === T.ERROR) {
        let m = "relay error"; try { m = JSON.parse(payload.toString()).message; } catch { /* ignore */ }
        finish(reject, new Error(m));
      }
    });
    sock.on("data", decode);
    sock.on("error", (e) => { if (!done) { done = true; reject(e); } });
    sock.setTimeout(20000, () => { if (!done) { done = true; sock.destroy(); reject(new Error("Relay timed out")); } });
  });
}

/**
 * One request, one answer, over a verified connection.
 *
 * `ask`/`reply` are the frame types to send and wait for; `req` is the JSON
 * the relay's handler for them takes. The account is proved with Mojang's
 * hasJoined before anything is sent, so the relay always knows who asked.
 */
function askRelay({ host, controlPort, account, req, ask, reply, rejectUnauthorized = true }) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, v) => { if (done) return; done = true; fn(v); try { sock.end(); } catch { /* ignore */ } };
    const sock = tls.connect({ host, port: controlPort, servername: host, rejectUnauthorized }, () =>
      sock.write(encodeFrame(T.HELLO, 0, Buffer.from(JSON.stringify({ sync: true })))));
    const send = (t, s2, p) => { try { sock.write(encodeFrame(t, s2, p)); } catch { /* ignore */ } };
    const decode = createDecoder(async (type, streamId, payload) => {
      if (type === T.CHALLENGE) {
        let info = {}; try { info = JSON.parse(payload.toString()); } catch { /* ignore */ }
        const ok = await mojangJoin(account.accessToken, account.uuid, info.serverId);
        if (!ok) return finish(reject, new Error("Could not verify your Minecraft account"));
        send(T.AUTH, 0, Buffer.from(JSON.stringify({ username: account.name })));
      } else if (type === T.WELCOME) {
        send(ask, 0, Buffer.from(JSON.stringify(req || {})));
      } else if (type === reply) {
        let info = {}; try { info = JSON.parse(payload.toString()); } catch { /* ignore */ }
        finish(resolve, info);
      } else if (type === T.ERROR) {
        let m = "relay error"; try { m = JSON.parse(payload.toString()).message; } catch { /* ignore */ }
        finish(reject, new Error(m));
      }
    });
    sock.on("data", decode);
    sock.on("error", (e) => { if (!done) { done = true; reject(e); } });
    sock.setTimeout(30000, () => { if (!done) { done = true; sock.destroy(); reject(new Error("Relay timed out")); } });
  });
}

/**
 * One verified connection, asked many things.
 *
 * askRelay above connects, proves the account with Mojang, asks one thing
 * and hangs up. That is right for something asked once. The admin panel is
 * not that: it asks on every tab, and each ask was a fresh connection and so
 * a fresh Mojang join -- which Mojang rate-limits, so switching tabs quickly
 * ended in "Could not verify your Minecraft account". The account had not
 * stopped being valid; it had been asked about too often.
 *
 * So: connect once, verify once, and keep the connection while the panel is
 * open. The relay already works this way -- an authenticated sync connection
 * answers any number of frames -- it was only this side that hung up.
 *
 * Requests are run one at a time. A reply is matched by its frame type and
 * carries no request id, so two of the same kind in flight could not be told
 * apart; a queue is both correct and plenty for a panel somebody is clicking
 * around in.
 */
export function relaySession({
  host, controlPort, account, rejectUnauthorized = true, idleMs = 150000,
  // The one call being rate-limited, handed in so a test can count it.
  join = mojangJoin,
}) {
  let sock = null;
  let ready = null;        // the connect-and-verify promise, while it holds
  let inFlight = null;     // { reply, resolve, reject, timer }
  let queue = Promise.resolve();
  let idle = null;
  let closed = false;

  const stopIdle = () => { if (idle) { clearInterval(idle); idle = null; } };

  /**
   * Tear the connection down; the next ask builds a new one.
   *
   * `only` names the socket this is about. A socket that has already been
   * replaced still emits its close event, and without this that stale event
   * would destroy the connection that replaced it -- which looked, from the
   * outside, exactly like the relay hanging up at random.
   */
  function drop(err, only) {
    if (only && sock !== only) return;
    stopIdle();
    const s = sock;
    sock = null;
    ready = null;
    if (s) { try { s.destroy(); } catch { /* already gone */ } }
    if (inFlight) {
      const p = inFlight;
      inFlight = null;
      clearTimeout(p.timer);
      p.reject(err || new Error("The relay connection closed"));
    }
  }

  function connect() {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      let settled = false;
      const s = tls.connect({ host, port: controlPort, servername: host, rejectUnauthorized }, () => {
        try { s.write(encodeFrame(T.HELLO, 0, Buffer.from(JSON.stringify({ sync: true })))); }
        catch (e) { fail(e); }
      });
      sock = s;
      const fail = (e) => {
        if (settled && sock !== s) return;      // a socket we have already replaced
        const err = e instanceof Error ? e : new Error(String(e && e.message || e || "relay error"));
        if (!settled) { settled = true; reject(err); }
        drop(err, s);
      };
      const decode = createDecoder(async (type, streamId, payload) => {
        if (type === T.CHALLENGE) {
          let info = {}; try { info = JSON.parse(payload.toString()); } catch { /* ignore */ }
          let ok = false;
          try { ok = await join(account.accessToken, account.uuid, info.serverId); } catch { ok = false; }
          if (!ok) return fail(new Error("Could not verify your Minecraft account"));
          try { s.write(encodeFrame(T.AUTH, 0, Buffer.from(JSON.stringify({ username: account.name })))); }
          catch (e) { fail(e); }
          return;
        }
        if (type === T.WELCOME) {
          if (!settled) { settled = true; resolve(); }
          // Something has to cross the wire now and then, or a middlebox
          // between here and the relay decides nothing is happening.
          stopIdle();
          idle = setInterval(() => {
            try { s.write(encodeFrame(T.PING, 0, null)); } catch { /* the next ask reconnects */ }
          }, idleMs);
          if (idle.unref) idle.unref();
          return;
        }
        if (type === T.PONG) return;
        if (inFlight && type === inFlight.reply) {
          let info = {}; try { info = JSON.parse(payload.toString()); } catch { /* ignore */ }
          const p = inFlight;
          inFlight = null;
          clearTimeout(p.timer);
          p.resolve(info);
          return;
        }
        if (type === T.ERROR) {
          let m = "relay error"; try { m = JSON.parse(payload.toString()).message; } catch { /* ignore */ }
          // An error answering a request is that request's answer; the
          // connection is still good and the next tab must not have to
          // verify all over again.
          if (inFlight) {
            const p = inFlight;
            inFlight = null;
            clearTimeout(p.timer);
            // Marked, so ask() rethrows it rather than deciding the
            // connection is broken and verifying all over again. Getting a
            // password wrong must not cost a trip to Mojang.
            const e = new Error(m);
            e.fromRelay = true;
            p.reject(e);
            return;
          }
          fail(new Error(m));
        }
      });
      s.on("data", decode);
      s.on("error", fail);
      s.on("close", () => {
        if (!settled) fail(new Error("The relay closed the connection"));
        else drop(new Error("The relay closed the connection"), s);
      });
    });
    // A failed connect must not be remembered as the connection.
    ready.catch(() => { });
    return ready;
  }

  /** Ask one thing, waiting for anything already asked. */
  function ask(askType, replyType, req) {
    const run = async () => {
      if (closed) throw new Error("This relay session has been closed.");
      // One retry, and only for a connection that was already up: a socket
      // that died while nobody was using it is the ordinary case, and making
      // somebody see an error for it would be the same bug in a new place.
      for (let attempt = 0; attempt < 2; attempt++) {
        const had = !!sock;
        try {
          await connect();
          return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              if (inFlight && inFlight.timer === timer) drop(new Error("Relay timed out"));
            }, 30000);
            inFlight = { reply: replyType, resolve, reject, timer };
            try { sock.write(encodeFrame(askType, 0, Buffer.from(JSON.stringify(req || {})))); }
            catch (e) { clearTimeout(timer); inFlight = null; drop(e); reject(e); }
          });
        } catch (e) {
          // The relay answering "no" is the answer. Only a connection that
          // actually failed is worth dropping and trying again.
          if (e && e.fromRelay) throw e;
          drop();
          if (attempt || !had) throw e;
        }
      }
      throw new Error("Could not reach the relay.");
    };
    const mine = queue.then(run, run);
    queue = mine.catch(() => { });
    return mine;
  }

  return {
    ask,
    admin: (req) => ask(T.ADMIN, T.ADMIN_DATA, req),
    cloud: (req) => ask(T.CLOUD, T.CLOUD_DATA, req),
    get open() { return !!sock && !closed; },
    close() { closed = true; drop(new Error("This relay session has been closed.")); },
  };
}

/**
 * Suggestions: { op: 'submit', title, body } or { op: 'mine' }.
 *
 * Needs a premium account, which this connection proves, so a suggestion
 * always has a real person behind it and that person can be told what
 * happened to it.
 */
export function suggestRelay(opts) {
  return askRelay({ ...opts, ask: T.SUGGEST, reply: T.SUGGEST_DATA });
}

/**
 * Signing a theme for sharing: { op: 'sign', hash } or { op: 'key' }.
 *
 * The relay signs the author and the theme's hash together, and takes the
 * author from the connection it has already verified with Mojang -- never
 * from the request. That is what makes the name on a shared theme mean
 * something: the signature stops verifying if either the author or the theme
 * is changed, and only the relay can make a new one.
 */
export function themeRelay(opts) {
  return askRelay({ ...opts, ask: T.THEME, reply: T.THEME_DATA });
}

/**
 * Pointing a name of ours at somewhere else: { op: 'set', subdomain, host,
 * port } or { op: 'clear', subdomain }.
 *
 * The launcher can share a world through its own relay or through e4mc's. With
 * e4mc the tunnel is theirs and so is the hostname they assign -- but the name
 * a person hands to their friends should still be the launcher's own, so that
 * name is pointed at theirs. The relay owns the DNS for it, so the relay is
 * what does it, and the connection proves which account is asking so nobody
 * can point somebody else's name anywhere.
 */
export function aliasRelay(opts) {
  return askRelay({ ...opts, ask: T.ALIAS, reply: T.ALIAS_DATA });
}

/**
 * The admin panel: { op: 'panels', password } for the layout, then whatever
 * ops the panels that came back name. The relay decides what exists and what
 * it looks like; the launcher only draws it.
 */
export function adminRelay(opts) {
  return askRelay({ ...opts, ask: T.ADMIN, reply: T.ADMIN_DATA });
}

/**
 * Cloud syncing: { op: 'config' } for the Google OAuth client this relay was
 * set up with, or { op: 'secret' } for the relay's half of the key this
 * account's synced data is encrypted with.
 *
 * The relay never sees any of the data. What it provides is the half of the
 * key that is not in the Drive -- and only to a connection that has proved
 * that exact Minecraft account with Mojang, which is what stops the Drive
 * file being worth anything on its own.
 */
export function cloudRelay(opts) {
  return askRelay({ ...opts, ask: T.CLOUD, reply: T.CLOUD_DATA });
}

// Open a relay session. Resolves { address, port, close() }.
//   account: { accessToken, uuid, name }  (a verified premium account)
export function openRelay({ host, controlPort, subdomain, domain, localPort, account, directIp, rejectUnauthorized = true }) {
  return new Promise((resolve, reject) => {
    const streams = new Map();
    let settled = false, keepalive = null, httpResolver = null;

    const sock = tls.connect({ host, port: controlPort, servername: host, rejectUnauthorized }, () => {
      try { sock.setNoDelay(true); } catch { /* ignore */ } // no Nagle → low latency
      sock.write(encodeFrame(T.HELLO, 0, Buffer.from(JSON.stringify({ subdomain, domain, localPort }))));
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
        // If we have a public (UPnP) IP, ask the relay to point DNS directly at
        // us so players bypass the relay hop entirely.
        if (directIp) send(T.DIRECT, 0, Buffer.from(JSON.stringify({ ip: directIp, port: localPort })));
        keepalive = setInterval(() => send(T.PING, 0, null), 20000);
        resolve({
          address: info.address, port: info.port,
          close: () => { if (keepalive) clearInterval(keepalive); try { sock.end(); } catch { /* ignore */ } },
          // Register our local pack server (`localHttpPort`) under `token` for
          // public hosting; resolves the relay's shared HTTP port (or null).
          openHttp: (localHttpPort, token) => new Promise((res) => {
            httpResolver = res;
            send(T.HTTP, 0, Buffer.from(JSON.stringify({ localHttpPort, token })));
            setTimeout(() => { if (httpResolver) { httpResolver(null); httpResolver = null; } }, 15000);
          }),
        });
      } else if (type === T.HTTP) {
        let info = {}; try { info = JSON.parse(payload.toString()); } catch { /* ignore */ }
        if (httpResolver) { httpResolver(info.port || null); httpResolver = null; }
      } else if (type === T.ERROR) {
        let m = "relay error"; try { m = JSON.parse(payload.toString()).message; } catch { /* ignore */ }
        if (!settled) reject(new Error(m));
      } else if (type === T.OPEN) {
        // A muxed connection. HTTP-tunnel streams carry their local target port in
        // the OPEN payload; Minecraft streams (null payload) go to the MC port.
        let targetPort = localPort;
        if (payload && payload.length) { try { const o = JSON.parse(payload.toString()); if (o.port) targetPort = o.port; } catch { /* ignore */ } }
        const local = net.connect({ host: "127.0.0.1", port: targetPort });
        try { local.setNoDelay(true); } catch { /* ignore */ } // no Nagle → low latency
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

// Everything above, by name. `themeRelay` was left out of this list, so
// exporting a theme died on "relayClient.themeRelay is not a function" even
// though the function was right there -- main.js reaches these through the
// default import.
export default { openRelay, queryRelay, syncRelay, seenRelay, suggestRelay, themeRelay, aliasRelay, adminRelay, cloudRelay, relaySession };
