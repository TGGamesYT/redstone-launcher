// One verified connection, asked many things.
//
// The admin panel asks the relay on every tab. Each ask used to open its own
// TLS connection and so its own Mojang join, and Mojang rate-limits joins:
// switch tabs quickly and it came back "Could not verify your Minecraft
// account" -- which was never true of the account, only of how often it had
// been asked about.
//
// So what is checked here is the count. Not that it works -- askRelay worked
// too -- but that ten questions cost one verification.
import tls from "tls";
import { relaySession } from "../backend/relayClient.js";

let bad = 0;
const check = (what, got, want, note) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${note ? "  — " + note : ""}`
    + (ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`));
};

const T = { HELLO: 1, CHALLENGE: 2, AUTH: 3, WELCOME: 4, ERROR: 5, PING: 9, PONG: 10, ADMIN: 20, ADMIN_DATA: 21 };

function frame(type, streamId, payload) {
  const len = payload ? payload.length : 0;
  const buf = Buffer.allocUnsafe(9 + len);
  buf.writeUInt8(type, 0); buf.writeUInt32BE(streamId >>> 0, 1); buf.writeUInt32BE(len, 5);
  if (len) payload.copy(buf, 9);
  return buf;
}
function decoder(onFrame) {
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

/** A relay that counts how many times it made somebody verify. */
function fakeRelay({ onAdmin }) {
  const state = { verifications: 0, connections: 0, asks: 0, pings: 0, live: [] };
  const server = tls.createServer({
    key: KEY, cert: CERT,
  }, (sock) => {
    state.connections++;
    state.live.push(sock);
    let authed = false;
    const send = (t, p) => { try { sock.write(frame(t, 0, p)); } catch { /* gone */ } };
    sock.on("data", decoder((type, id, payload) => {
      if (type === T.HELLO) {
        // Exactly what the real relay does: challenge, then wait for AUTH.
        send(T.CHALLENGE, Buffer.from(JSON.stringify({ serverId: "abc" })));
        return;
      }
      if (type === T.AUTH) {
        state.verifications++;
        authed = true;
        send(T.WELCOME, Buffer.from(JSON.stringify({ sync: true })));
        return;
      }
      if (type === T.PING) { state.pings++; send(T.PONG, null); return; }
      if (type === T.ADMIN) {
        if (!authed) return send(T.ERROR, Buffer.from(JSON.stringify({ message: "not authed" })));
        state.asks++;
        let req = {}; try { req = JSON.parse(payload.toString()); } catch { /* ignore */ }
        const out = onAdmin ? onAdmin(req, state, sock) : { ok: true, echo: req.op };
        if (out === undefined) return;    // the handler is answering by itself
        send(T.ADMIN_DATA, Buffer.from(JSON.stringify(out)));
      }
    }));
    sock.on("error", () => { /* a client that hung up is not a failure */ });
  });
  return { server, state };
}

// A throwaway key and certificate, generated once for this run.
const { KEY, CERT } = await (async () => {
  const { execFileSync } = await import("child_process");
  const os = await import("os");
  const fs = await import("fs");
  const path = await import("path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relaytls-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"),
    "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
  const out = {
    KEY: fs.readFileSync(path.join(dir, "k.pem")),
    CERT: fs.readFileSync(path.join(dir, "c.pem")),
  };
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
})();

const ACCOUNT = { accessToken: "token", uuid: "0".repeat(32), name: "TGdoesCode" };

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

// Mojang's join is the call being rate-limited, so it is the one counted.
// Nothing here talks to Mojang; the point is how OFTEN it would have.
function counter() {
  const seen = [];
  return {
    seen,
    join: async (token, uuid, serverId) => { seen.push(serverId); return true; },
  };
}

/** A session wired to the fake relay, with its joins counted. */
function sessionTo(port, joins) {
  return relaySession({
    host: "127.0.0.1", controlPort: port, account: ACCOUNT,
    rejectUnauthorized: false, join: joins.join,
  });
}

// ── ten questions, one verification ──
{
  const { server, state } = fakeRelay({ onAdmin: (req) => ({ ok: true, op: req.op }) });
  const port = await listen(server);
  const joins = counter();
  const s = sessionTo(port, joins);

  const answers = [];
  for (const op of ["panels", "players", "bans", "suggestions", "settings", "hosts"]) {
    answers.push(await s.admin({ op }));
  }
  check("every tab gets its answer", answers.map(a => a.op),
    ["panels", "players", "bans", "suggestions", "settings", "hosts"]);
  check("over one connection, after one verification",
    [state.connections, joins.seen.length, state.asks], [1, 1, 6],
    "it was one of each per tab, and Mojang rate-limits the verification");

  s.close();
  server.close();
}

// ── switching tabs faster than the answers come back ──
//
// The case that actually broke: six clicks in a second. They must not race
// each other, and they must not each drag in a verification.
{
  const { server, state } = fakeRelay({
    onAdmin: (req, st, sock) => {
      // Answer slowly, so the next ask would overlap if anything let it.
      setTimeout(() => {
        try { sock.write(frame(T.ADMIN_DATA, 0, Buffer.from(JSON.stringify({ ok: true, op: req.op })))); }
        catch { /* gone */ }
      }, 30);
      return undefined;
    },
  });
  const port = await listen(server);
  const joins = counter();
  const s = sessionTo(port, joins);

  const ops = ["a", "b", "c", "d", "e", "f"];
  const all = await Promise.all(ops.map(op => s.admin({ op })));
  check("clicking six tabs at once answers each one, in order",
    all.map(a => a.op), ops,
    "replies are matched by frame type and carry no id, so two at once could not be told apart");
  check("and still costs one trip to Mojang",
    [state.connections, joins.seen.length], [1, 1]);

  s.close();
  server.close();
}

// ── an error is an answer, not a broken connection ──
{
  const { server, state } = fakeRelay({
    onAdmin: (req, st, sock) => {
      if (req.op === "bad") {
        sock.write(frame(T.ERROR, 0, Buffer.from(JSON.stringify({ message: "no" }))));
        return undefined;
      }
      return { ok: true, op: req.op };
    },
  });
  const port = await listen(server);
  const joins = counter();
  const s = sessionTo(port, joins);

  await s.admin({ op: "fine" });
  let said = null;
  try { await s.admin({ op: "bad" }); } catch (e) { said = e.message; }
  check("a refused request says why", said, "no");
  const after = await s.admin({ op: "fine again" });
  check("and the next one goes over the same connection", after.op, "fine again");
  check("so a wrong password does not cost a new verification",
    [state.connections, joins.seen.length], [1, 1],
    "re-verifying after every error is how somebody gets rate-limited by getting something wrong");

  s.close();
  server.close();
}

// ── a connection that went stale while nobody was using it ──
//
// The reason the retry exists. Somebody opens the panel, leaves it, comes
// back and clicks a tab. The socket died quietly in between -- a router, a
// relay restart -- and what must NOT happen is an error for something they
// did nothing wrong in.
{
  const { server, state } = fakeRelay({ onAdmin: (req) => ({ ok: true, op: req.op }) });
  const port = await listen(server);
  const joins = counter();
  const s = sessionTo(port, joins);

  await s.admin({ op: "before" });
  check("one connection so far", [state.connections, joins.seen.length], [1, 1]);

  // Killed from the relay's end, the way a restart does it, and the close
  // is allowed to reach the client before anybody clicks anything.
  for (const c of state.live) { try { c.destroy(); } catch { /* gone */ } }
  state.live.length = 0;
  await new Promise((r) => setTimeout(r, 120));

  const back = await s.admin({ op: "after" });
  check("coming back to a dead connection just works", back.op, "after",
    "the socket died while nobody was looking; that is not something to show somebody an error about");
  check("at the cost of one new connection, and no loop of them",
    [state.connections, joins.seen.length], [2, 2],
    "one retry, so a relay that is really gone fails once rather than hammering Mojang");

  s.close();
  server.close();
}

// ── a request that kills the connection every time ──
{
  const { server, state } = fakeRelay({
    onAdmin: (req, st, sock) => {
      if (req.op === "cut") { sock.destroy(); return undefined; }
      return { ok: true, op: req.op };
    },
  });
  const port = await listen(server);
  const joins = counter();
  const s = sessionTo(port, joins);

  await s.admin({ op: "first" });
  let died = null;
  try { await s.admin({ op: "cut" }); } catch (e) { died = e.message; }
  check("a connection that drops mid-request says so rather than hanging",
    typeof died === "string" && died.length > 0, true);
  check("after trying once more, and then giving up",
    [state.connections, joins.seen.length], [2, 2],
    "the retry cannot tell a stale socket from a request that kills one, so it tries exactly once");
  const back = await s.admin({ op: "again" });
  check("and the session is usable again afterwards", back.op, "again");

  s.close();
  server.close();
}

// ── closing it ──
{
  const { server } = fakeRelay({});
  const port = await listen(server);
  const joins = counter();
  const s = sessionTo(port, joins);
  await s.admin({ op: "x" });
  check("a session is open while it is used", s.open, true);
  s.close();
  check("and shut when it is closed", s.open, false);
  let after = null;
  try { await s.admin({ op: "y" }); } catch (e) { after = e.message; }
  check("asking a closed session is refused rather than quietly reopening it",
    /closed/.test(after || ""), true,
    "the window is gone; nothing should still be verified on its behalf");
  server.close();
}

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
