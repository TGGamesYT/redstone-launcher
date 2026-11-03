// The launcher's side of sharing through e4mc.
//
// The wire format is checked in quiclime-test, and the QUIC transport by the
// sidecar's own Rust tests against a relay they stand up. What is left is this
// side of the pipe: reading what the sidecar says, deciding which relay to
// dial, and working out what a name of ours would have to point at.
//
// The last of those is the one with a trap in it. e4mc hands out a hostname on
// the default port -- but it does not have to, and if their name carries a
// `_minecraft._tcp` SRV record then pointing our name at the hostname alone
// sends players to the right machine on the wrong port. So DNS is asked rather
// than assumed, and that is what these check.
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { resolveTarget, share, sidecarPath, available } from "../backend/e4mc.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let bad = 0;
const check = (label, got, want, note) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${note ? "  — " + note : ""}\n       got  ${JSON.stringify(got)}` + (ok ? "" : `\n       want ${JSON.stringify(want)}`));
};

// ── what a name of ours would have to point at ──
const noSrv = {
  resolveSrv: async () => { throw Object.assign(new Error("ENODATA"), { code: "ENODATA" }); },
  resolve4: async () => ["203.0.113.7"],
};
check("a plain hostname is reached on the default port",
  await resolveTarget("abcde.e4mc.link", noSrv),
  { domain: "abcde.e4mc.link", host: "abcde.e4mc.link", port: 25565, srv: null, addresses: ["203.0.113.7"] },
  "no SRV record is the ordinary case, and nothing has to be copied");

const withSrv = {
  resolveSrv: async (name) => {
    if (name !== "_minecraft._tcp.abcde.e4mc.link") throw new Error("asked for the wrong name: " + name);
    return [{ name: "relay-eu.e4mc.link.", port: 30441, priority: 0, weight: 5 }];
  },
  resolve4: async () => ["198.51.100.4"],
};
check("a hostname with an SRV record is reached where the record says",
  await resolveTarget("abcde.e4mc.link", withSrv),
  {
    domain: "abcde.e4mc.link", host: "relay-eu.e4mc.link", port: 30441,
    srv: { target: "relay-eu.e4mc.link", port: 30441 }, addresses: ["198.51.100.4"],
  },
  "pointing our name at the hostname alone would be the right machine on the wrong port");

check("the trailing dot DNS puts on a name is not part of the name",
  (await resolveTarget("abcde.e4mc.link", withSrv)).srv.target,
  "relay-eu.e4mc.link",
  "it would be copied into our own record otherwise");

const manySrv = {
  resolveSrv: async () => ([
    { name: "far.e4mc.link", port: 1111, priority: 10, weight: 1 },
    { name: "near.e4mc.link", port: 2222, priority: 0, weight: 1 },
    { name: "alsonear.e4mc.link", port: 3333, priority: 0, weight: 9 },
  ]),
  resolve4: async () => [],
};
check("the record with the lowest priority wins, then the heaviest weight",
  (await resolveTarget("x.e4mc.link", manySrv)).srv,
  { target: "alsonear.e4mc.link", port: 3333 },
  "which is how a resolver picks, so it is how this picks");

check("a name that resolves to nothing at all is still a name",
  (await resolveTarget("gone.e4mc.link", {
    resolveSrv: async () => { throw new Error("nope"); },
    resolve4: async () => { throw new Error("nope"); },
  })).addresses,
  [],
  "the relay has only just been told about it; DNS may not have caught up");

// ── reading what the sidecar says ──
//
// A script standing in for it, printing the lines the real one would. The real
// program's own behaviour is covered by the Rust tests, which run it against
// an actual relay; what is under test here is this side of the pipe.
const OUT = path.join(ROOT, "node_modules", ".cache", "e4mc");
fs.mkdirSync(OUT, { recursive: true });
const stub = (name, body) => {
  const p = path.join(OUT, name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(p, 0o755);
  return p;
};

const relay = { host: "eu.e4mc.link", port: 25575, id: "eu-1" };

{
  const exe = stub("good.sh", `
echo '{"type":"connected","relay":"eu.e4mc.link:25575"}'
echo '{"type":"capabilities","caps":["dialtone_sidecar"]}'
echo '{"type":"domain","domain":"abcde.e4mc.link"}'
# then it would stay up carrying players
cat > /dev/null
`);
  const seen = [];
  const session = await share({ localPort: 25565, relay, exe, onEvent: (e) => seen.push(e.type) });
  check("a hostname being assigned is what resolves the share",
    [session.domain, session.address, session.relay.host],
    ["abcde.e4mc.link", "abcde.e4mc.link", "eu.e4mc.link"]);
  check("and everything it said on the way was passed on",
    seen, ["connected", "capabilities", "domain"],
    "the launcher shows the relay's own messages, so it has to hear them");
  session.close();
}

{
  const exe = stub("broken.sh", `echo '{"type":"error","error":"the relay refused the connection"}'`);
  let err = null;
  try { await share({ localPort: 25565, relay, exe }); } catch (e) { err = e.message; }
  check("an error it reports is the error the launcher gets", err,
    "the relay refused the connection",
    "rather than a timeout thirty seconds later");
}

{
  const exe = stub("silent.sh", `echo 'something that is not JSON' 1>&2; exit 3`);
  let err = null;
  try { await share({ localPort: 25565, relay, exe }); } catch (e) { err = e.message; }
  check("one that dies says so, with what it managed to complain about",
    [err.includes("code 3"), err.includes("something that is not JSON")],
    [true, true],
    "its stderr is kept for exactly this, never parsed as an event");
}

{
  const exe = stub("hang.sh", `cat > /dev/null`);
  const started = Date.now();
  let err = null;
  try { await share({ localPort: 25565, relay, exe, readyTimeoutMs: 400 }); } catch (e) { err = e.message; }
  check("one that never answers is given up on", err, "e4mc did not assign a hostname in time");
  check("and not waited on for ever", Date.now() - started < 4000, true);
}

{
  let err = null;
  try { await share({ relay, exe: stub("unused.sh", "true") }); } catch (e) { err = e.message; }
  check("sharing nothing is refused before anything is started", err,
    "There is no local port to share");
}
{
  let err = null;
  try { await share({ localPort: 25565, exe: stub("unused2.sh", "true") }); } catch (e) { err = e.message; }
  check("and so is dialling nowhere", err, "No e4mc relay to dial");
}

// ── and whether this copy can do it at all ──
check("the sidecar is looked for where a checkout and an install both put it",
  [typeof sidecarPath(), available() === !!sidecarPath()],
  [sidecarPath() === null ? "object" : "string", true],
  sidecarPath() ? `found at ${path.relative(ROOT, sidecarPath())}` : "not built in this tree");

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
