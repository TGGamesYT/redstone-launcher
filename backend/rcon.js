// RCON: talking to a server the launcher does not hold the pipes to.
//
// A server started by the launcher has been talked to through its stdin. That
// only works while the launcher is the parent, which is exactly what has to
// stop being true for a server to outlive the launcher -- a detached process
// has nobody holding its stdin, and a pipe to a process whose parent has gone
// is a broken pipe.
//
// RCON is the game's own answer: a TCP port, a password, and a command. It is
// enabled per server in server.properties, with a password the launcher
// generates and keeps in the server's own serverinfo.json, so nothing has to
// be typed and nothing is shared between servers.
//
// The protocol is small enough to write out. Every packet is
//
//   int32  length     bytes after this field
//   int32  id         echoed back, so a reply can be matched to its request
//   int32  type       3 login, 2 command, 0 a reply
//   bytes  body       the command or the reply, NUL-terminated
//   byte   0          and one more NUL
//
// all little-endian. A failed login replies with id -1, which is the only
// thing in it that is not obvious.
import net from "net";
import crypto from "crypto";

const LOGIN = 3, COMMAND = 2, REPLY = 0;

export const newPassword = () => crypto.randomBytes(12).toString("base64url");

function packet(id, type, body) {
  const payload = Buffer.from(String(body), "utf8");
  const buf = Buffer.alloc(14 + payload.length);
  buf.writeInt32LE(10 + payload.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  payload.copy(buf, 12);
  // The two trailing NULs are already zero from the alloc.
  return buf;
}

/**
 * Open a connection, log in, and resolve with { send, close }.
 *
 *   send(cmd) -> Promise<string>   the server's reply, which may be empty
 *   close()                        nothing is kept open on the server's side
 *
 * Rejects if the port is not listening, the password is wrong, or the login
 * does not answer within `timeout` ms.
 */
export function connect({ host = "127.0.0.1", port, password, timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!port) return reject(new Error("No RCON port"));
    const sock = net.connect({ host, port });
    let held = Buffer.alloc(0);
    let nextId = 1;
    const waiting = new Map();          // id -> { resolve, reject, parts }
    let loggedIn = false;
    let dead = null;

    const fail = (err) => {
      if (dead) return;
      dead = err;
      for (const w of waiting.values()) w.reject(err);
      waiting.clear();
      try { sock.destroy(); } catch { /* already gone */ }
      if (!loggedIn) reject(err);
    };

    const timer = setTimeout(() => fail(new Error("RCON did not answer")), timeout);

    sock.on("error", (e) => fail(e));
    sock.on("close", () => { clearTimeout(timer); fail(new Error("RCON closed the connection")); });

    sock.on("data", (chunk) => {
      held = Buffer.concat([held, chunk]);
      // One packet at a time, and only once all of it has arrived: a reply to
      // a command like "list" can be split across several reads.
      while (held.length >= 4) {
        const len = held.readInt32LE(0);
        if (len < 10 || held.length < 4 + len) break;
        const id = held.readInt32LE(4);
        const type = held.readInt32LE(8);
        const body = held.slice(12, 4 + len - 2).toString("utf8");
        held = held.slice(4 + len);

        if (!loggedIn) {
          clearTimeout(timer);
          // A failed login answers with id -1 and nothing else to go on.
          if (id === -1) { fail(new Error("The RCON password was refused")); return; }
          loggedIn = true;
          resolve({ send, close });
          continue;
        }
        if (type !== REPLY) continue;
        const w = waiting.get(id);
        if (w) { waiting.delete(id); w.resolve(body); }
      }
    });

    sock.on("connect", () => { try { sock.write(packet(0, LOGIN, password || "")); } catch (e) { fail(e); } });

    function send(cmd) {
      return new Promise((ok, no) => {
        if (dead) return no(dead);
        const id = nextId++;
        waiting.set(id, { resolve: ok, reject: no });
        // A command that is never answered must not hang the caller forever.
        setTimeout(() => {
          if (waiting.delete(id)) ok("");
        }, timeout);
        try { sock.write(packet(id, COMMAND, cmd)); } catch (e) { waiting.delete(id); no(e); }
      });
    }

    function close() {
      dead = dead || new Error("closed");
      try { sock.end(); } catch { /* already gone */ }
    }
  });
}

/**
 * server.properties with RCON switched on, and which port and password it was
 * given. Pure text in, text out, so the one thing that decides whether the
 * launcher can reach a server at all can be checked without a server.
 *
 * A port and a password already in the file are kept -- a server that has been
 * talked to before must not get a new password out from under a launcher that
 * remembers the old one. Without one, the port is derived from the game's so
 * two servers on one computer do not collide, and the password is generated.
 *
 * rcon.ip is pinned to the loopback: this is the launcher talking to a server
 * on the same computer, and an RCON port open to the network is a way in.
 */
export function rconProps(text, { port, password } = {}) {
  let out = String(text == null ? "" : text);
  const key = (k) => k.replace(/\./g, "\\.");
  const read = (k) => {
    const m = new RegExp(`^${key(k)}\\s*=\\s*(.*)$`, "m").exec(out);
    return m ? m[1].trim() : null;
  };
  const write = (k, v) => {
    const re = new RegExp(`^${key(k)}\\s*=.*$`, "m");
    if (re.test(out)) out = out.replace(re, `${k}=${v}`);
    else out = (out && !out.endsWith("\n") ? out + "\n" : out) + `${k}=${v}\n`;
  };

  const gamePort = Number(read("server-port")) || 25565;
  const usePort = Number(port) || Number(read("rcon.port")) || (gamePort + 10);
  const usePassword = password || read("rcon.password") || newPassword();

  write("enable-rcon", "true");
  write("rcon.port", String(usePort));
  write("rcon.password", usePassword);
  if (!read("rcon.ip")) write("rcon.ip", "127.0.0.1");
  return { text: out, port: usePort, password: usePassword };
}

/** One command, on a connection opened and closed around it. */
export async function once(opts, cmd) {
  const c = await connect(opts);
  try { return await c.send(cmd); }
  finally { c.close(); }
}

export default { connect, once, newPassword, rconProps };
