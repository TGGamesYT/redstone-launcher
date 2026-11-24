// A name of ours for an e4mc share: DNS only, never through our relay.
//
// The launcher picks which kind of record (Settings -> Advanced): SRV, CNAME
// or A, so each can be tried. The relay makes that record and nothing else --
// it does not carry the game. The real handleAlias is cut out of
// relay-server/relay.js with everything it reaches for stubbed.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(ROOT, "relay-server", "relay.js"), "utf8");
let bad = 0;
const check = (what, got, want, note) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${note ? "  — " + note : ""}`
    + (ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`));
};
const cut = (head) => {
  const i = src.indexOf(head);
  if (i < 0) { console.log(`FAIL no ${head} in relay.js`); process.exit(1); }
  return src.slice(i, src.indexOf("\n}\n", i) + 3);
};
const fn = (name) => cut(`function ${name}(`);
const asyncFn = (name) => cut(`async function ${name}(`);

const FORWARD_OK = new Function(src.match(/const FORWARD_OK = [^\n]+/)[0] + "\nreturn FORWARD_OK;")();
check("only e4mc's names may be pointed at by anybody",
  ["a.e4mc.link", "e4mc.link", "evil.com", "e4mc.link.evil.com", "xe4mc.link"].map(n => FORWARD_OK.test(n)),
  [true, true, false, false, false]);

const hostFromAddress = new Function(fn("hostFromAddress") + "\nreturn hostFromAddress;")();
check("a handshake's trailing dot is ignored when finding a share",
  hostFromAddress("Latest.TGdoesCode.redstonemc.net.\0FML3\0"), "latest.tgdoescode.redstonemc.net");

check("the relay no longer forwards players anywhere",
  [/forwards\.(set|get|has)\(/.test(src), /function rewriteHandshake/.test(src)], [false, false]);

// ── handleAlias, every mode ──
const make = (opts = {}) => {
  const calls = [];
  const said = [];
  const handleAlias = new Function("CF", "DOMAIN", "log", "FORWARD_OK", "cfClearAlias", "cfPointSrv", "cfPointAlias",
    "cfPointDirect", "cfListZones", "dns",
    [fn("subLabelSafe"), fn("nonAdminSubAllowed"), asyncFn("handleAlias")].join("\n") + "\nreturn handleAlias;")(
    { enabled: opts.token !== false }, "redstonemc.net", (...a) => said.push(a.join(" ")), FORWARD_OK,
    async (host, domain) => { calls.push(["clear", host, domain]); return { ok: true }; },
    async (host, domain, target, port) => { calls.push(["srv", host, target, port]); return { ok: true }; },
    async (host, domain, target, port) => { calls.push(["cname", host, target, port]); return { ok: true }; },
    async (host, domain, ip) => { calls.push(["a", host, ip]); return { id: "r1", zoneId: "z" }; },
    async () => [{ name: "redstonemc.net" }, { name: "other.net" }],
    { promises: { resolve4: async (n) => (n === "quick-fox.e4mc.link" ? ["203.0.113.7"] : []) } });
  return { handleAlias, calls, said };
};
const who = { uuid: "u1", name: "TGdoesCode" };
const share = (extra) => ({ op: "set", subdomain: "tgdoescode", host: "quick-fox.e4mc.link", port: 25565, name: "quick-fox.e4mc.link", ...extra });

{
  const t = make();
  const r = await t.handleAlias(share({ mode: "srv" }), who, false);
  check("SRV: the old records go, then _minecraft._tcp points at e4mc's name and port",
    [r.ok, r.host, t.calls], [true, "tgdoescode.redstonemc.net",
      [["clear", "tgdoescode.redstonemc.net", "redstonemc.net"], ["srv", "tgdoescode.redstonemc.net", "quick-fox.e4mc.link", 25565]]]);
  check("and the relay says which kind it made", t.said.some(l => /by SRV record/.test(l)), true);
}
{
  const t = make();
  const r = await t.handleAlias(share({ mode: "cname" }), who, false);
  check("CNAME: our name is a CNAME of e4mc's", [r.ok, t.calls[1]], [true, ["cname", "tgdoescode.redstonemc.net", "quick-fox.e4mc.link", 25565]]);
}
{
  const t = make();
  const r = await t.handleAlias(share({ mode: "a" }), who, false);
  check("A: our name points at the IP e4mc's name has now", [r.ok, t.calls[1]], [true, ["a", "tgdoescode.redstonemc.net", "203.0.113.7"]]);
}
{
  const t = make();
  const r = await t.handleAlias(share({ mode: "a", name: "nowhere.e4mc.link", host: "nowhere.e4mc.link" }), who, false);
  check("A for a name with no address is refused, and nothing is made", [r.ok, t.calls.filter(c => c[0] === "a").length], [false, 0]);
}
{
  const t = make({ token: false });
  const r = await t.handleAlias(share({ mode: "srv" }), who, false);
  check("with no Cloudflare token it says so, rather than anything else", [r.ok, /Cloudflare token/.test(r.error)], [false, true]);
}
{
  const t = make();
  const r = await t.handleAlias(share({ mode: "carrier-pigeon" }), who, false);
  check("an unknown mode is refused", r.ok, false);
}
{
  const t = make();
  const r = await t.handleAlias(share({ host: "example.com", name: "example.com" }), who, false);
  check("somewhere that is not e4mc is refused for a non-admin, and logged", [r.ok, t.said.some(l => /refused/.test(l))], [false, true]);
  const theirs = await t.handleAlias(share({ subdomain: "someoneelse" }), who, false);
  check("and so is somebody else's name", theirs.ok, false);
}
{
  const t = make();
  const admin = { uuid: "a1", name: "Admin" };
  const other = await t.handleAlias(share({ subdomain: "event", domain: "other.net" }), admin, true);
  check("an admin can use another domain the relay manages", [other.ok, other.host], [true, "event.other.net"]);
  const notMine = await t.handleAlias(share({ domain: "other.net" }), who, false);
  check("somebody who is not an admin cannot", notMine.ok, false);
  const unmanaged = await t.handleAlias(share({ subdomain: "event", domain: "nope.org" }), admin, true);
  check("nor can anybody use a domain the relay does not manage", unmanaged.ok, false);
}
{
  const t = make();
  const r = await t.handleAlias({ op: "clear", subdomain: "tgdoescode" }, who, false);
  check("clearing removes the records again", [r.ok, t.calls], [true, [["clear", "tgdoescode.redstonemc.net", "redstonemc.net"]]]);
}

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
