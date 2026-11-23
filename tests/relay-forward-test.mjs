// A name of ours sent on to e4mc: the player's handshake asked for our name,
// and e4mc routes by the name in the handshake, so it is rewritten on the way
// through. The real functions are cut out of relay-server/relay.js.
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
const fn = (name) => {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) { console.log(`FAIL no ${name} in relay.js`); process.exit(1); }
  // To the end of the function: the first line that is just "}".
  const j = src.indexOf("\n}\n", i);
  return src.slice(i, j + 3);
};
const { parseHandshake, rewriteHandshake, mcPacket, writeVarInt } = new Function(
  ["readVarInt", "writeVarInt", "mcPacket", "parseHandshake", "rewriteHandshake"].map(fn).join("\n")
  + "\nreturn { parseHandshake, rewriteHandshake, mcPacket, writeVarInt };")();
const FORWARD_OK = new Function(src.match(/const FORWARD_OK = [^\n]+/)[0] + "\nreturn FORWARD_OK;")();

const hello = (address, port = 25565, protocol = 767, next = 2) => {
  const a = Buffer.from(address, "utf8");
  const p = Buffer.alloc(2); p.writeUInt16BE(port, 0);
  return mcPacket(0x00, Buffer.concat([writeVarInt(protocol), writeVarInt(a.length), a, p, writeVarInt(next)]));
};

const hs = parseHandshake(hello("tg.redstonemc.net", 25565));
check("the player's handshake is read, port included", [hs.address, hs.port, hs.protocol, hs.nextState],
  ["tg.redstonemc.net", 25565, 767, 2]);
const out = parseHandshake(rewriteHandshake({ ...hs, port: 25566 }, "quick-fox.e4mc.link"));
check("and sent on asking for e4mc's name, everything else kept",
  [out.address, out.port, out.protocol, out.nextState], ["quick-fox.e4mc.link", 25566, 767, 2]);
const forge = parseHandshake(rewriteHandshake(parseHandshake(hello("tg.redstonemc.net\0FML3\0")), "quick-fox.e4mc.link"));
check("a Forge client's tag survives", forge.address, "quick-fox.e4mc.link\0FML3\0");
check("only e4mc's names may be forwarded to by anybody",
  ["a.e4mc.link", "e4mc.link", "evil.com", "e4mc.link.evil.com", "xe4mc.link"].map(n => FORWARD_OK.test(n)),
  [true, true, false, false, false]);

// ── asked to send a name on, with NO Cloudflare token ──
//
// The relay refused "no DNS credentials" before it ever reached the
// forwarding, which needs none. The real handleAlias, with everything it
// reaches for stubbed: no Cloudflare at all.
{
  const asyncFn = (name) => {
    const i = src.indexOf(`async function ${name}(`);
    return src.slice(i, src.indexOf("\n}\n", i) + 3);
  };
  const make = new Function("CF", "DOMAIN", "log", "forwards", "FORWARD_OK", "cfClearAlias",
    [fn("subLabelSafe"), fn("nonAdminSubAllowed"), asyncFn("handleAlias")].join("\n") + "\nreturn handleAlias;");
  const forwards = new Map();
  const said = [];
  const handleAlias = make({ enabled: false }, "redstonemc.net", (...a) => said.push(a.join(" ")), forwards, FORWARD_OK,
    async () => { throw new Error("Cloudflare was asked"); });
  const who = { uuid: "u1", name: "TGdoesCode" };
  const r = await handleAlias({ op: "set", subdomain: "tgdoescode", host: "relay-eu.e4mc.link", port: 25565, name: "quick-fox.e4mc.link" }, who, false);
  check("with no DNS credentials a share over e4mc still gets our name", [r.ok, r.host], [true, "tgdoescode.redstonemc.net"],
    r.error || "");
  check("and players for it are sent on to e4mc's name",
    forwards.get("tgdoescode.redstonemc.net") && forwards.get("tgdoescode.redstonemc.net").name, "quick-fox.e4mc.link");
  check("which the relay says in its log", said.some(l => /tgdoescode\.redstonemc\.net on to quick-fox/.test(l)), true);
  const no = await handleAlias({ op: "set", subdomain: "tgdoescode", host: "example.com", port: 25565 }, who, false);
  check("somewhere that is not e4mc is refused for a non-admin, and logged", [no.ok, said.some(l => /refused/.test(l))], [false, true]);
  const theirs = await handleAlias({ op: "set", subdomain: "someoneelse", host: "relay-eu.e4mc.link", name: "x.e4mc.link" }, who, false);
  check("and so is somebody else's name", theirs.ok, false);
  const cleared = await handleAlias({ op: "clear", subdomain: "tgdoescode" }, who, false);
  check("clearing it stops the forwarding", [cleared.ok, forwards.has("tgdoescode.redstonemc.net")], [true, false]);
}

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
