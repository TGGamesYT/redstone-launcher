// Sharing a world through e4mc's relays.
//
// The launcher's own relay and e4mc's do the same job by different means. Both
// end with a hostname players can type in; what differs is who carries the
// traffic and what the launcher has to run to do it.
//
//   the launcher's own   a TLS control connection from relayClient.js, which
//                        this process holds itself, to a relay the owner runs
//   e4mc's               raw QUIC, which Electron cannot speak at all, so a
//                        small program does it and reports back
//
// Why a separate program: Node ships QUIC as a build-time option that is off
// in every release build, so there is no `node:quic` to use however many flags
// are passed, and Chromium's WebTransport only offers HTTP/3's ALPN, which
// e4mc's relay will not accept. See sidecar/quiclime.
//
// This module is the launcher's side of that: find which relay to dial, start
// the program, read what it says, and hand back the hostname. Nothing here
// knows the wire format -- backend/quiclime.js has that, and the sidecar
// implements it.
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import quiclime from "./quiclime.js";

// Electron, if there is one. Asked for at the moment it is needed rather than
// imported at the top, so this module loads -- and can be tested -- in plain
// Node, where there is no app object at all.
function electronApp() {
  try { return createRequire(import.meta.url)("electron").app || null; }
  catch { return null; }
}

// Where the built sidecar might be. Running from a checkout it is in the Rust
// target directory; packaged it sits beside the app's other resources. Both
// are tried rather than one being assumed, so a developer and an installed
// copy both work without a setting.
function sidecarPath() {
  const exe = process.platform === "win32" ? "quiclime.exe" : "quiclime";
  const places = [];
  try { places.push(path.join(process.resourcesPath || "", "sidecar", exe)); } catch { /* not packaged */ }
  try { places.push(path.join(process.resourcesPath || "", exe)); } catch { /* not packaged */ }
  try {
    const root = electronApp()?.getAppPath() || process.cwd();
    places.push(path.join(root, "sidecar", "quiclime", "target", "release", exe));
    places.push(path.join(root, "sidecar", "quiclime", "target", "debug", exe));
    places.push(path.join(root, "sidecar", exe));
  } catch { /* nowhere else to look */ }
  for (const p of places) {
    if (!p) continue;
    try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return null;
}

/** Whether sharing through e4mc is possible on this install at all. */
function available() {
  return !!sidecarPath();
}

/**
 * Which relay to dial.
 *
 * e4mc has a broker whose whole job is answering that, so it is asked rather
 * than a relay being picked here -- it knows which of theirs is closest and
 * which are up. Its answer is checked before being dialled, and there is a
 * fixed relay to fall back on when it cannot be reached, which is what the mod
 * does too.
 */
async function pickRelay({ timeoutMs = 8000 } = {}) {
  const stop = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
  try {
    const res = await fetch(quiclime.BROKER_URL, {
      headers: { accept: "application/json" },
      signal: stop,
    });
    if (!res.ok) throw new Error(`the broker said HTTP ${res.status}`);
    const relay = quiclime.relayFromBroker(await res.json());
    return { ...relay, from: "broker" };
  } catch (err) {
    return { ...quiclime.FALLBACK_RELAY, id: null, from: "fallback", why: String(err && err.message || err) };
  }
}

/**
 * Share whatever is listening on `localPort` through e4mc.
 *
 * Resolves once a hostname has been assigned -- which is the point at which
 * there is something to tell anybody -- with
 *
 *   { domain, relay, address, close() }
 *
 * `onEvent` is called for everything the sidecar reports, including after the
 * promise has resolved: players arriving, the relay's own broadcasts, and the
 * connection ending. Rejects when no hostname arrives, with what went wrong.
 */
function share({ localPort, relay, onEvent, readyTimeoutMs = 25000, exe: given } = {}) {
  return new Promise((resolve, reject) => {
    // `exe` is only for tests, which stand in a script that prints canned
    // lines where the real program goes.
    const exe = given || sidecarPath();
    if (!exe) {
      reject(new Error("The part of the launcher that talks to e4mc is not installed in this copy."));
      return;
    }
    if (!localPort) { reject(new Error("There is no local port to share")); return; }
    if (!relay || !relay.host || !relay.port) { reject(new Error("No e4mc relay to dial")); return; }

    const say = (event) => { try { if (onEvent) onEvent(event); } catch { /* a listener's problem */ } };

    const child = spawn(exe, [
      "--relay", `${relay.host}:${relay.port}`,
      "--local-port", String(localPort),
    ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

    let settled = false;
    let held = "";
    const problems = [];

    // One JSON object per line, and nothing else is written there, so a line
    // that does not parse is a bug worth hearing about rather than noise.
    const onLine = (line) => {
      const text = line.trim();
      if (!text) return;
      let event;
      try { event = JSON.parse(text); }
      catch { problems.push(text); return; }
      say(event);
      if (event.type === "domain" && event.domain && !settled) {
        settled = true;
        resolve({
          domain: event.domain,
          relay,
          // e4mc hands out a plain hostname on the default port, so that is
          // the whole of the address.
          address: event.domain,
          close,
        });
      }
      if (event.type === "error" && !settled) {
        settled = true;
        reject(new Error(event.error || "e4mc could not be reached"));
        close();
      }
    };

    child.stdout.on("data", (chunk) => {
      held += chunk.toString("utf8");
      const lines = held.split(/\r?\n/);
      held = lines.pop();
      for (const l of lines) onLine(l);
    });
    // The sidecar's own logging. Kept for a failure message rather than
    // thrown away, and never parsed as an event.
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (text) problems.push(text);
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(new Error(`The e4mc helper would not start: ${err.message}`));
    });

    // `close`, not `exit`: exit fires as soon as the process is gone, which
    // can be before its stderr has been drained -- so the reason it failed
    // was not yet in hand at the moment the failure was reported. close waits
    // for the streams.
    child.on("close", (code) => {
      say({ type: "stopped", code });
      if (settled) return;
      settled = true;
      const why = problems.slice(-3).join(" / ");
      reject(new Error(`The e4mc helper stopped${code ? ` (code ${code})` : ""}${why ? `: ${why}` : ""}`));
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("e4mc did not assign a hostname in time"));
      close();
    }, readyTimeoutMs);
    if (timer.unref) timer.unref();

    function close() {
      clearTimeout(timer);
      // Closing its stdin is how it is asked to stop -- that is what it
      // watches -- and killing it is the backstop.
      try { child.stdin.end(); } catch { /* already gone */ }
      setTimeout(() => { try { child.kill(); } catch { /* already gone */ } }, 1500).unref?.();
    }
  });
}

/**
 * Everything needed to point a name of our own at an e4mc hostname.
 *
 * e4mc gives out a hostname on the default port, but it does not have to: the
 * launcher asks DNS what the assigned name actually resolves to rather than
 * assuming. A `_minecraft._tcp` SRV record on their name is the case that
 * matters -- it is how a server is reached on a port nobody types -- and if
 * there is one it has to be carried across, or our name would point at the
 * right host on the wrong port.
 *
 * `resolver` is only for tests; left out, the system's DNS is used.
 */
async function resolveTarget(domain, resolver) {
  const dns = resolver || (await import("dns")).promises;
  const out = { domain, host: domain, port: 25565, srv: null, addresses: [] };
  try {
    const srv = await dns.resolveSrv(`_minecraft._tcp.${domain}`);
    const best = (srv || []).filter(r => r && r.name).sort((a, b) => (a.priority - b.priority) || (b.weight - a.weight))[0];
    if (best) {
      out.srv = { target: String(best.name).replace(/\.$/, ""), port: Number(best.port) || 25565 };
      out.host = out.srv.target;
      out.port = out.srv.port;
    }
  } catch { /* no SRV is the ordinary case */ }
  try {
    const a = await dns.resolve4(out.host);
    out.addresses = Array.isArray(a) ? a : [];
  } catch { /* a name with no A record of its own is still a name */ }
  return out;
}

export { available, sidecarPath, pickRelay, share, resolveTarget };
export default { available, sidecarPath, pickRelay, share, resolveTarget };
