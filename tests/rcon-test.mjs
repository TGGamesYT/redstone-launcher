// RCON, against a server that speaks it.
//
// This is how the launcher talks to a server it did not start -- one left
// running when the launcher was closed has nobody holding its stdin. The
// protocol is written out by hand in backend/rcon.js, so it is worth proving
// against the thing on the other end rather than against itself: the fake
// server below reads the bytes the real game would read.
import net from "net";
import { connect, once, newPassword, rconProps } from "../backend/rcon.js";

let bad = 0;
const check = (label, got, want, note) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${note ? "  — " + note : ""}\n       got  ${JSON.stringify(got)}` + (ok ? "" : `\n       want ${JSON.stringify(want)}`));
};

const PASSWORD = "the-right-one";

// A stand-in for the game's RCON: the same framing, the same login rule (id -1
// on a wrong password), and an answer per command.
function fakeServer({ split = false } = {}) {
  const seen = [];
  const srv = net.createServer((sock) => {
    let held = Buffer.alloc(0);
    let authed = false;
    const reply = (id, type, body) => {
      const payload = Buffer.from(body, "utf8");
      const buf = Buffer.alloc(14 + payload.length);
      buf.writeInt32LE(10 + payload.length, 0);
      buf.writeInt32LE(id, 4);
      buf.writeInt32LE(type, 8);
      payload.copy(buf, 12);
      // Written in two halves when asked, because a real reply often is.
      if (split && buf.length > 6) {
        sock.write(buf.slice(0, 6));
        setTimeout(() => { try { sock.write(buf.slice(6)); } catch { /* gone */ } }, 15);
      } else {
        sock.write(buf);
      }
    };
    sock.on("data", (chunk) => {
      held = Buffer.concat([held, chunk]);
      while (held.length >= 4) {
        const len = held.readInt32LE(0);
        if (held.length < 4 + len) break;
        const id = held.readInt32LE(4);
        const type = held.readInt32LE(8);
        const body = held.slice(12, 4 + len - 2).toString("utf8");
        held = held.slice(4 + len);
        if (type === 3) {
          authed = body === PASSWORD;
          // The game answers a login with an empty packet; -1 means refused.
          reply(authed ? id : -1, 2, "");
        } else if (type === 2) {
          seen.push(body);
          reply(id, 0, body === "list" ? "There are 1 of a max of 20 players online: Steve" : `ran ${body}`);
        }
      }
    });
    sock.on("error", () => { /* the test closes sockets under it */ });
  });
  return new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok({ srv, port: srv.address().port, seen })));
}

// ── a good login, and commands ──
{
  const { srv, port, seen } = await fakeServer();
  const c = await connect({ port, password: PASSWORD });
  check("a command gets its own reply back", await c.send("list"),
    "There are 1 of a max of 20 players online: Steve");
  check("and another one gets another", await c.send("say hello"), "ran say hello");
  // Two at once: the ids are what keep the replies apart.
  const both = await Promise.all([c.send("one"), c.send("two")]);
  check("two commands in flight do not get each other's replies", both, ["ran one", "ran two"],
    "every packet carries the id it was asked with");
  check("the server saw exactly what was sent", seen, ["list", "say hello", "one", "two"]);
  c.close();
  srv.close();
}

// ── a reply that arrives in pieces ──
{
  const { srv, port } = await fakeServer({ split: true });
  const c = await connect({ port, password: PASSWORD });
  check("a reply split across reads is still one reply", await c.send("list"),
    "There are 1 of a max of 20 players online: Steve",
    "a packet is only read once all of it has arrived");
  c.close();
  srv.close();
}

// ── a wrong password ──
{
  const { srv, port } = await fakeServer();
  let err = null;
  try { await connect({ port, password: "not it" }); } catch (e) { err = e.message; }
  check("a refused password is an error, not a silent failure", err, "The RCON password was refused");
  srv.close();
}

// ── nothing listening ──
{
  let err = null;
  // Port 1 needs root to bind, so nothing of ours is on it.
  try { await once({ port: 1, password: PASSWORD, timeout: 800 }, "list"); } catch (e) { err = !!e; }
  check("a port with nothing on it fails rather than hanging", err, true);
}

// ── the password it generates ──
{
  const a = newPassword(), b = newPassword();
  check("a generated password is long enough and not the same twice",
    [a.length >= 16, a !== b, /^[A-Za-z0-9_-]+$/.test(a)], [true, true, true],
    "it goes into server.properties, so it may not need escaping");
}

// ── switching it on in server.properties ──
{
  const r = rconProps("server-port=25570\nmotd=A Minecraft Server\n", {});
  check("it is switched on, on a port of its own, bound to this computer",
    [r.port, r.text.includes("enable-rcon=true"), r.text.includes("rcon.port=25580"),
     r.text.includes("rcon.ip=127.0.0.1")],
    [25580, true, true, true],
    "the port follows the game's so two servers do not collide");
  check("and the rest of the file is left alone",
    r.text.startsWith("server-port=25570\nmotd=A Minecraft Server\n"), true);
  check("the password it wrote is the one it reports",
    r.text.includes(`rcon.password=${r.password}`), true);
}
{
  // The important one: a server that has been talked to before keeps the
  // password the launcher remembers, or it is locked out of its own server.
  const before = "enable-rcon=false\nrcon.port=30000\nrcon.password=keep-me\nrcon.ip=127.0.0.1\n";
  const r = rconProps(before, {});
  check("a port and password already there are kept", [r.port, r.password], [30000, "keep-me"]);
  check("and what was off is turned on in place",
    r.text, "enable-rcon=true\nrcon.port=30000\nrcon.password=keep-me\nrcon.ip=127.0.0.1\n",
    "rewritten where it stood, not appended a second time");
}
{
  const r = rconProps("", { port: 12345, password: "given" });
  check("and what the caller already knows wins over both",
    [r.port, r.password, r.text.split("\n").filter(Boolean)],
    [12345, "given", ["enable-rcon=true", "rcon.port=12345", "rcon.password=given", "rcon.ip=127.0.0.1"]]);
}
{
  const r = rconProps("motd=no newline at the end", {});
  check("a file with no trailing newline is not run into",
    r.text.split("\n")[0], "motd=no newline at the end");
}

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
