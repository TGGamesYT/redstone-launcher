// What keeps synced data readable only by the person it belongs to.
//
// Cloud syncing puts things in the user's own Google Drive, and some of them
// -- the signed-in Minecraft accounts above all -- are worth a great deal to
// whoever gets hold of them. A Microsoft refresh token is not a password that
// can be changed after the fact; it is the account.
//
// So nothing readable is ever written to Drive, and the key is in two halves
// that live in different places and belong to different accounts:
//
//   the relay's half   derived from the Minecraft UUID under a key the relay
//                      keeps, and handed out ONLY to a connection that has
//                      proved that exact account with Mojang's hasJoined
//   the Drive's half   random, made once on the first computer that turns
//                      syncing on, and kept in the Drive folder itself
//
// Neither opens anything alone. Somebody who gets the Drive file has the
// second half and no way to the first without being able to sign in as that
// Minecraft account. Somebody who gets into the relay has the first half for
// everybody and no Drive to take the second from. Google has the second half
// and is not a Minecraft account. That is the whole point of splitting it,
// and it is why the halves must never be stored together -- in particular,
// the relay's half is never written to disk here.
//
// The halves are combined with HKDF rather than concatenated and hashed, so
// that one half being weaker or shorter than the other cannot weaken the
// result, and so each kind of thing gets a key of its own from the same pair.
import crypto from "crypto";

// Written into every encrypted file, so a later change of scheme can be told
// from this one rather than guessed at by length.
export const SCHEME = "rl-cloud-v1";

const KEY_BYTES = 32;          // AES-256
const NONCE_BYTES = 12;        // GCM's own size; anything else is a footgun
const TAG_BYTES = 16;

/** A new Drive half. Called once, on the first computer that syncs. */
export const newDriveHalf = () => crypto.randomBytes(32).toString("hex");

const asBytes = (half, what) => {
  const s = String(half || "").trim();
  if (!/^[0-9a-f]{64}$/i.test(s)) throw new Error(`The ${what} is not a key.`);
  return Buffer.from(s, "hex");
};

/**
 * The key one kind of thing is encrypted with.
 *
 * `kind` separates them: the accounts file and the settings file get
 * different keys from the same pair, so a flaw that exposed one does not
 * hand over the other.
 */
export function keyFor({ relayHalf, driveHalf, kind }) {
  if (!kind) throw new Error("Nothing says what this key is for.");
  // Both halves go into the input. HKDF's salt is the public, non-secret
  // part, so the kind goes there and in `info` -- never a half.
  const ikm = Buffer.concat([asBytes(relayHalf, "relay's key half"), asBytes(driveHalf, "Drive key half")]);
  const salt = Buffer.from(`${SCHEME}:${kind}`, "utf8");
  const info = Buffer.from(`${SCHEME}:key:${kind}`, "utf8");
  return Buffer.from(crypto.hkdfSync("sha256", ikm, salt, info, KEY_BYTES));
}

/**
 * Encrypt a thing for Drive.
 *
 * Returns a Buffer: a short readable header, then the nonce, then the
 * ciphertext and its tag. The header is there so that a file found on its own
 * says what it is rather than looking like noise -- and it is authenticated,
 * so it cannot be edited to make the file look like something else.
 */
export function seal({ relayHalf, driveHalf, kind, plaintext }) {
  const key = keyFor({ relayHalf, driveHalf, kind });
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const header = Buffer.from(JSON.stringify({ scheme: SCHEME, kind }), "utf8");
  if (header.length > 255) throw new Error("That kind of thing has too long a name.");
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  // The header is covered by the tag without being part of the ciphertext,
  // which is what additional authenticated data is for.
  cipher.setAAD(header);
  const body = Buffer.concat([
    cipher.update(Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), "utf8")),
    cipher.final(),
  ]);
  return Buffer.concat([
    Buffer.from([header.length]), header, nonce, cipher.getAuthTag(), body,
  ]);
}

/**
 * Open one again.
 *
 * Throws if either half is wrong, if the file has been edited, or if it is
 * not what was asked for. GCM means a wrong key and an edited file are the
 * same failure, which is the right answer to both.
 */
export function open({ relayHalf, driveHalf, kind, sealed }) {
  const buf = Buffer.isBuffer(sealed) ? sealed : Buffer.from(sealed);
  if (buf.length < 1 + NONCE_BYTES + TAG_BYTES) throw new Error("That is not a synced file.");
  const headerLen = buf[0];
  const at = 1 + headerLen;
  if (buf.length < at + NONCE_BYTES + TAG_BYTES) throw new Error("That is not a synced file.");
  const header = buf.subarray(1, at);
  let said;
  try { said = JSON.parse(header.toString("utf8")); } catch { throw new Error("That is not a synced file."); }
  if (said.scheme !== SCHEME) throw new Error(`This was written by a different version (${said.scheme}).`);
  // Asked for one thing and handed another: refuse rather than decrypt, so a
  // file cannot be moved into another slot and opened there.
  if (kind && said.kind !== kind) throw new Error(`That is a ${said.kind} file, not a ${kind} one.`);

  const nonce = buf.subarray(at, at + NONCE_BYTES);
  const tag = buf.subarray(at + NONCE_BYTES, at + NONCE_BYTES + TAG_BYTES);
  const body = buf.subarray(at + NONCE_BYTES + TAG_BYTES);
  const key = keyFor({ relayHalf, driveHalf, kind: said.kind });
  const d = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  d.setAAD(header);
  d.setAuthTag(tag);
  try {
    return Buffer.concat([d.update(body), d.final()]);
  } catch {
    // Deliberately the same message for a wrong key and a changed file.
    // Which of the two it was is not something the holder of one half should
    // be able to learn by trying.
    throw new Error("This could not be opened with the keys for this account.");
  }
}

/** What a sealed file says it is, without opening it. */
export function peek(sealed) {
  const buf = Buffer.isBuffer(sealed) ? sealed : Buffer.from(sealed);
  try {
    return JSON.parse(buf.subarray(1, 1 + buf[0]).toString("utf8"));
  } catch { return null; }
}

export default { SCHEME, newDriveHalf, keyFor, seal, open, peek };
