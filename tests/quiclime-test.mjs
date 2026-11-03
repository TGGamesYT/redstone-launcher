// The quiclime wire format, against the relay's own rules.
//
// This is the part of talking to e4mc's relays that can be checked without a
// relay, and it is where the bugs live: a varint off by one byte, a length
// read as signed, a handshake packet whose prefix does not count what follows
// it. The transport that carries these bytes is QUIC and needs a relay at the
// other end; this does not.
//
// The rules being checked come from the relay's source (vgskye/e4mc-quiclime,
// src/netty.rs and src/proto.rs): varints are five bytes at most with the high
// bit as the continuation flag, the host's messages carry a varint length, the
// relay's carry ONE RAW BYTE of length, and a player's stream opens with a
// length-prefixed Minecraft handshake packet.
import {
  ALPN, BROKER_URL, FALLBACK_RELAY, SERVERBOUND, CLIENTBOUND, STATE,
  encodeVarInt, readVarInt, encodeControl, probe, requestDomain, registerTicket,
  ControlReader, encodeHandshake, decodeHandshake, relayFromBroker,
} from "../backend/quiclime.js";

let bad = 0;
const check = (label, got, want, note) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${note ? "  — " + note : ""}\n       got  ${JSON.stringify(got)}` + (ok ? "" : `\n       want ${JSON.stringify(want)}`));
};
const hex = (b) => Buffer.from(b).toString("hex");

// ── varints ──
check("the protocol string is the one the relay accepts", ALPN, "quiclime",
  "a different ALPN and the QUIC handshake is refused outright");

check("a small number is one byte", hex(encodeVarInt(0)), "00");
check("127 is still one byte", hex(encodeVarInt(127)), "7f",
  "the high bit is the continuation flag, so 127 is the last single byte");
check("128 needs two", hex(encodeVarInt(128)), "8001");
check("and 255", hex(encodeVarInt(255)), "ff01");
check("a big one takes five", hex(encodeVarInt(2147483647)), "ffffffff07");
check("-1 is five bytes of ones", hex(encodeVarInt(-1)), "ffffffff0f",
  "the relay reads into a signed 32-bit integer, so this is what it must see");

for (const n of [0, 1, 127, 128, 255, 300, 16383, 16384, 2097151, 2097152, 2147483647, -1, -2147483648]) {
  const r = readVarInt(encodeVarInt(n));
  if (!r || r.value !== n) { bad++; console.log(`FAIL varint round-trip for ${n}\n       got  ${JSON.stringify(r)}`); }
}
console.log("ok   every varint reads back as what was written");

check("a varint that has not all arrived is not an error",
  readVarInt(Buffer.from([0x80])), null,
  "on a stream that is simply the rest of it being on its way");
check("and one that never ends is", (() => {
  try { readVarInt(Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x01])); return "no throw"; }
  catch (e) { return e.message; }
})(), "Varint is invalid");

// ── the host's messages ──
check("a message to the relay is a varint length and then the JSON",
  (() => {
    const b = probe();
    const len = readVarInt(b, 0);
    const json = b.slice(len.size).toString("utf8");
    // The prefix has to be the byte length of what follows, or the relay
    // reads the next message's first bytes as the end of this one.
    return [len.value === Buffer.byteLength(json), json];
  })(),
  [true, '{"kind":"probe_capabilities"}'],
  "the kind is tagged, not wrapped");

check("the three the host can send are named as the relay names them",
  [JSON.parse(probe().slice(1).toString()).kind,
   JSON.parse(requestDomain().slice(1).toString()).kind,
   JSON.parse(registerTicket("v1_abc").slice(1).toString())],
  [SERVERBOUND.PROBE, SERVERBOUND.REQUEST_DOMAIN,
   { kind: "dialtone_register_ticket", ticket: "v1_abc" }],
  "snake_case, tagged with `kind` -- serde will not match anything else");

check("a message too long for the relay is refused here rather than there",
  (() => { try { encodeControl({ kind: "x", pad: "y".repeat(9000) }); return "no throw"; } catch (e) { return e.message; } })(),
  "Control message too long");

// ── the relay's replies ──
//
// ONE RAW BYTE of length. This is the asymmetry both existing clients get
// wrong -- one reads the byte as signed, the other as a varint -- and it is
// the whole reason this reader exists.
const reply = (obj) => {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  return Buffer.concat([Buffer.from([json.length]), json]);
};

{
  const r = new ControlReader();
  check("a reply is read back whole",
    r.push(reply({ kind: CLIENTBOUND.DOMAIN, domain: "abcde.e4mc.link" })),
    [{ kind: "domain_assignment_complete", domain: "abcde.e4mc.link" }]);
}
{
  const r = new ControlReader();
  const two = Buffer.concat([
    reply({ kind: CLIENTBOUND.CAPABILITIES, caps: ["dialtone_sidecar"] }),
    reply({ kind: CLIENTBOUND.DOMAIN, domain: "xyz.e4mc.link" }),
  ]);
  check("two in one read come back as two",
    r.push(two).map(m => m.kind),
    ["has_capabilities", "domain_assignment_complete"],
    "the host writes probe and request back to back, so the replies arrive together");
}
{
  // Split in the middle of the JSON, and again in front of the length byte.
  const r = new ControlReader();
  const whole = reply({ kind: CLIENTBOUND.DOMAIN, domain: "split.e4mc.link" });
  const first = r.push(whole.slice(0, 5));
  const second = r.push(whole.slice(5));
  check("a reply split across reads is held until the rest of it arrives",
    [first.length, second],
    [0, [{ kind: "domain_assignment_complete", domain: "split.e4mc.link" }]]);
}
{
  // The one that matters. A broadcast long enough to set the top bit of the
  // length byte: 200 bytes is 0xC8, which is -56 read signed and the start of
  // a two-byte varint read as a varint.
  const message = "x".repeat(200 - '{"kind":"request_message_broadcast","message":""}'.length);
  const frame = reply({ kind: CLIENTBOUND.BROADCAST, message });
  check("a reply of 128 bytes or more is a length, not a negative number",
    [frame[0], frame.length],
    [200, 201],
    "0xC8 is 200; read signed it is -56, and read as a varint it eats the next byte");
  const r = new ControlReader();
  const got = r.push(frame);
  check("and it is read back correctly",
    [got.length, got[0] && got[0].kind, got[0] && got[0].message.length],
    [1, "request_message_broadcast", message.length],
    "both existing clients misread this; the byte is unsigned");
}
{
  const r = new ControlReader();
  check("a reply that is not JSON does not stop the stream being read",
    r.push(Buffer.concat([
      Buffer.from([3]), Buffer.from("not"),
      reply({ kind: CLIENTBOUND.TICKET_REGISTERED }),
    ])).map(m => m.kind),
    ["__unparseable", "ticket_registered"]);
}

// ── a player's stream ──
{
  const want = { protocolVersion: 767, address: "abcde.e4mc.link", port: 25565, nextState: STATE.LOGIN };
  const buf = encodeHandshake(want);
  const total = readVarInt(buf, 0);
  check("the handshake's length prefix counts what follows it, and no more",
    [total.value, buf.length - total.size], [total.value, total.value],
    `${total.value} bytes after a ${total.size}-byte prefix`);
  check("the packet id is the handshake's", buf[total.size], 0);
  const got = decodeHandshake(buf);
  check("and it reads back as what was written", got.handshake, want);
  check("with the size it took, so the rest of the stream is raw bytes",
    got.size, buf.length);
}
{
  const buf = encodeHandshake({ protocolVersion: 47, address: "x.e4mc.link", port: 25565, nextState: STATE.STATUS });
  const trailing = Buffer.concat([buf, Buffer.from("raw minecraft bytes")]);
  const got = decodeHandshake(trailing);
  check("a handshake with the session already flowing behind it stops at its own end",
    [got.size, trailing.slice(got.size).toString()],
    [buf.length, "raw minecraft bytes"],
    "a player's stream is spliced onto the game socket from exactly there");
  check("and says this one is the server list asking, not somebody joining",
    got.handshake.nextState, STATE.STATUS);
}
check("a handshake still arriving is not an error", decodeHandshake(Buffer.from([0x20, 0x00])), null);
check("Forge's marker on the address is not part of the address",
  decodeHandshake(encodeHandshake({
    protocolVersion: 340, address: "abc.e4mc.link\0FML2\0", port: 25565, nextState: 2,
  })).handshake.address,
  "abc.e4mc.link",
  "Forge appends one of three of these; the relay strips them and so does this");
check("something that is not a handshake says so",
  (() => {
    try { decodeHandshake(Buffer.concat([encodeVarInt(2), Buffer.from([0x05, 0x00])])); return "no throw"; }
    catch (e) { return e.message; }
  })(),
  "Not a handshake packet");

// ── which relay ──
check("the broker is asked, and its answer is what gets dialled",
  [BROKER_URL, relayFromBroker({ id: "eu-1", host: "eu.e4mc.link", port: 25575 })],
  ["https://broker.e4mc.link/getBestRelay", { id: "eu-1", host: "eu.e4mc.link", port: 25575 }]);
check("a string answer is parsed too",
  relayFromBroker('{"id":7,"host":"na.e4mc.link","port":443}'),
  { id: "7", host: "na.e4mc.link", port: 443 });
for (const [label, body] of [
  ["no host", { port: 25575 }],
  ["no port", { host: "a.e4mc.link" }],
  ["a port that is not one", { host: "a.e4mc.link", port: 70000 }],
  ["nothing at all", {}],
]) {
  let threw = false;
  try { relayFromBroker(body); } catch { threw = true; }
  if (!threw) { bad++; console.log(`FAIL the broker answering with ${label} is not something to dial`); }
}
console.log("ok   an answer that names no relay is refused rather than dialled");
check("and there is a fixed one to fall back on", FALLBACK_RELAY,
  { host: "test.e4mc.link", port: 25575 });

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
