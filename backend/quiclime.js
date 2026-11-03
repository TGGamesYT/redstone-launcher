// The "quiclime" protocol, as e4mc's relays speak it.
//
// e4mc (by vgskye) shares a LAN world over the internet without port
// forwarding: the host dials a relay, the relay hands back a public hostname,
// and players connecting to that hostname have their Minecraft TCP session
// carried back down the same connection. This module is the wire format of
// that conversation; the transport that carries it is in e4mc-tunnel.js.
//
// Written against the relay's own source (vgskye/e4mc-quiclime, branch `kity`:
// src/proto.rs, src/netty.rs, Apache-2.0 OR MIT) and the mod's client
// (vgskye/e4mc-minecraft-architectury, MIT). Nothing here is a copy of either
// -- it is the protocol those describe, written out in JavaScript, so the
// launcher can be another host on the same relays rather than shelling out to
// a mod.
//
// ── The shape of it ─────────────────────────────────────────────────────────
//
//   transport   raw QUIC, ALPN "quiclime", ordinary certificate checks
//   control     the FIRST bidirectional stream the host opens
//   a player    a bidirectional stream the RELAY opens, one per connection
//
// On the control stream the host writes, back to back and without waiting:
//
//   probe_capabilities          what this relay can do
//   request_domain_assignment   please give me a hostname
//
// and the relay answers `domain_assignment_complete` with the hostname. Each
// player then arrives as a new stream whose first bytes are the Minecraft
// handshake packet the player sent, after which it is raw bytes in both
// directions -- so a stream is simply spliced onto a TCP socket to the local
// game.
//
// ── The one asymmetry worth knowing ─────────────────────────────────────────
//
// The host's messages are length-prefixed with a varint. The relay's are
// length-prefixed with ONE RAW BYTE. That is not a varint, and it is not
// signed: a 200-byte reply is the byte 0xC8. Both existing clients get this
// wrong in the same place -- one reads the byte as signed, the other reads it
// as a varint, and either way a reply of 128 bytes or more is misread. Short
// replies are all they ever see in practice, so it has never mattered. This
// reads it as what it is, which is strictly more correct and interoperates
// either way.
const MAX_SERVERBOUND = 8192;     // the relay refuses anything longer
const ALPN = "quiclime";

// Where to ask which relay to use. The mod asks this and is told a host and a
// port; it falls back to a fixed one when told not to use the broker.
const BROKER_URL = "https://broker.e4mc.link/getBestRelay";
const FALLBACK_RELAY = { host: "test.e4mc.link", port: 25575 };

// What the host can say, and what the relay can say back. The relay tags its
// JSON with `kind` and names the variants in snake_case.
const SERVERBOUND = {
  PROBE: "probe_capabilities",
  REQUEST_DOMAIN: "request_domain_assignment",
  REGISTER_TICKET: "dialtone_register_ticket",
};
const CLIENTBOUND = {
  UNKNOWN: "unknown_message",
  CAPABILITIES: "has_capabilities",
  DOMAIN: "domain_assignment_complete",
  BROADCAST: "request_message_broadcast",
  TICKET_REGISTERED: "ticket_registered",
};

// ── Varints ────────────────────────────────────────────────────────────────
//
// Minecraft's own: seven bits of payload per byte, low group first, the high
// bit meaning "another byte follows", five bytes at the most. The relay reads
// them into a signed 32-bit integer and so does this.

function encodeVarInt(value) {
  let v = value | 0;
  const out = [];
  for (let i = 0; i < 5; i++) {
    if ((v & ~0x7f) === 0) { out.push(v & 0xff); return Buffer.from(out); }
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;                       // unsigned, so a high bit does not sign-extend
  }
  throw new Error("Varint too long");
}

/**
 * Read a varint at `offset`. Returns { value, size }, or null when the buffer
 * does not hold all of it yet -- which is the normal case on a stream, not an
 * error.
 */
function readVarInt(buf, offset = 0) {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (offset + i >= buf.length) return null;
    const part = buf[offset + i];
    value |= (part & 0x7f) << (7 * i);
    if ((part & 0x80) === 0) return { value: value | 0, size: i + 1 };
  }
  throw new Error("Varint is invalid");
}

// ── The control stream ─────────────────────────────────────────────────────

/** A message for the relay: varint length, then the JSON. */
function encodeControl(message) {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  if (json.length > MAX_SERVERBOUND) throw new Error("Control message too long");
  return Buffer.concat([encodeVarInt(json.length), json]);
}

const probe = () => encodeControl({ kind: SERVERBOUND.PROBE });
const requestDomain = () => encodeControl({ kind: SERVERBOUND.REQUEST_DOMAIN });
const registerTicket = (ticket) => encodeControl({ kind: SERVERBOUND.REGISTER_TICKET, ticket: String(ticket) });

/**
 * The relay's side of the control stream, fed whatever arrives.
 *
 *   const r = new ControlReader();
 *   for (const msg of r.push(chunk)) …     // each a parsed object
 *
 * One raw byte of length, then that many bytes of JSON. A frame split across
 * reads is held until the rest of it turns up.
 */
class ControlReader {
  constructor() { this.held = Buffer.alloc(0); }

  push(chunk) {
    this.held = this.held.length ? Buffer.concat([this.held, chunk]) : Buffer.from(chunk);
    const out = [];
    for (;;) {
      if (this.held.length < 1) break;
      const len = this.held[0];               // UNSIGNED: 0xC8 is 200, not -56
      if (this.held.length < 1 + len) break;  // the rest has not arrived
      const body = this.held.slice(1, 1 + len).toString("utf8");
      this.held = this.held.slice(1 + len);
      // A reply that is not JSON is the relay's problem, not a reason to stop
      // reading the stream: it is reported and skipped.
      try { out.push(JSON.parse(body)); }
      catch { out.push({ kind: "__unparseable", body }); }
    }
    return out;
  }
}

// ── The handshake a player's stream opens with ─────────────────────────────
//
// The relay reads the player's handshake packet off the TCP side and writes it
// onto the host's stream before splicing the two together, so a stream begins
// with one length-prefixed packet and is raw bytes after that. The launcher
// does not have to understand it -- the bytes go to the game either way -- but
// reading it is how a player's arrival can be reported, and which of the two
// states it is says whether this is somebody joining or the server list
// asking for a ping.

const STATE = { STATUS: 1, LOGIN: 2 };

function encodeHandshake({ protocolVersion, address, port, nextState }) {
  const addr = Buffer.from(String(address), "utf8");
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(Number(port) & 0xffff, 0);
  const body = Buffer.concat([
    encodeVarInt(0),                 // packet id: handshake
    encodeVarInt(Number(protocolVersion) | 0),
    encodeVarInt(addr.length), addr,
    portBuf,
    encodeVarInt(Number(nextState) | 0),
  ]);
  return Buffer.concat([encodeVarInt(body.length), body]);
}

/**
 * Read that packet back. Returns { handshake, size } once all of it is there,
 * or null while it is still arriving. Throws only when the bytes cannot be a
 * handshake at all.
 */
function decodeHandshake(buf) {
  const total = readVarInt(buf, 0);
  if (!total) return null;
  const end = total.size + total.value;
  if (total.value < 0 || buf.length < end) return null;

  let at = total.size;
  const take = () => {
    const v = readVarInt(buf, at);
    if (!v) throw new Error("Truncated handshake");
    at += v.size;
    return v.value;
  };
  const id = take();
  if (id !== 0) throw new Error("Not a handshake packet");
  const protocolVersion = take();
  const addrLen = take();
  if (addrLen < 0 || at + addrLen + 2 > end) throw new Error("Truncated handshake");
  // Forge tacks a marker onto the address it sends; the relay strips it, but a
  // host reading the address for itself should not be surprised by one.
  const address = buf.slice(at, at + addrLen).toString("utf8").replace(/\0FML[23]?\0$/, "");
  at += addrLen;
  const port = buf.readUInt16BE(at); at += 2;
  const nextState = take();
  return {
    handshake: { protocolVersion, address, port, nextState },
    size: end,
  };
}

// ── Which relay to use ─────────────────────────────────────────────────────

/**
 * What the broker said, checked. It answers { id, host, port }; anything
 * without a usable host and port is not something to dial.
 */
function relayFromBroker(body) {
  const o = typeof body === "string" ? JSON.parse(body) : body;
  const host = o && typeof o.host === "string" ? o.host.trim() : "";
  const port = Number(o && o.port);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("The broker did not name a relay to use");
  }
  return { id: (o.id == null ? null : String(o.id)), host, port };
}

export {
  ALPN, BROKER_URL, FALLBACK_RELAY, MAX_SERVERBOUND,
  SERVERBOUND, CLIENTBOUND, STATE,
  encodeVarInt, readVarInt,
  encodeControl, probe, requestDomain, registerTicket, ControlReader,
  encodeHandshake, decodeHandshake,
  relayFromBroker,
};

export default {
  ALPN, BROKER_URL, FALLBACK_RELAY, MAX_SERVERBOUND,
  SERVERBOUND, CLIENTBOUND, STATE,
  encodeVarInt, readVarInt,
  encodeControl, probe, requestDomain, registerTicket, ControlReader,
  encodeHandshake, decodeHandshake,
  relayFromBroker,
};
