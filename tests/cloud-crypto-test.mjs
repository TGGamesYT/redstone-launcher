// The two halves that keep synced data readable only by its owner.
//
// Cloud syncing puts things in somebody's Google Drive, and the signed-in
// Minecraft accounts among them are worth more than a password: a Microsoft
// refresh token cannot be changed after the fact, it IS the account.
//
// So the key is in two halves, in different places, belonging to different
// accounts: one derived by the relay from the Minecraft UUID and handed out
// only to a connection Mojang has verified as that account, one random and
// kept in the Drive folder itself. What is checked here is mostly that
// neither half is worth anything on its own, because that is the only claim
// the design actually makes.
import crypto from "crypto";
import c from "../backend/cloud-crypto.js";

let bad = 0;
const ok = (what, note) => console.log(`ok   ${what}${note ? "  — " + note : ""}`);
const fail = (what, why) => { bad++; console.log(`FAIL ${what}\n       ${why}`); };
const check = (what, got, want, note) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) ok(what, note); else fail(what, `got  ${a}\n       want ${b}`);
};
const threw = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

const RELAY = crypto.randomBytes(32).toString("hex");
const DRIVE = c.newDriveHalf();
const SECRET = JSON.stringify({ accounts: [{ name: "TGdoesCode", refresh: "a-real-refresh-token" }] });

// ── it works at all ──
const sealed = c.seal({ relayHalf: RELAY, driveHalf: DRIVE, kind: "accounts", plaintext: SECRET });
check("what goes in comes back out",
  c.open({ relayHalf: RELAY, driveHalf: DRIVE, kind: "accounts", sealed }).toString(), SECRET);
check("and what is on Drive is not the thing itself",
  sealed.includes(Buffer.from("a-real-refresh-token")), false,
  "the one check that matters for a file sitting in somebody's cloud storage");

// ── neither half alone ──
//
// This is the whole claim. Each of these is somebody who has got hold of
// exactly one of the two.
const otherRelay = crypto.randomBytes(32).toString("hex");
const otherDrive = c.newDriveHalf();
check("the Drive file alone opens nothing",
  !!threw(() => c.open({ relayHalf: otherRelay, driveHalf: DRIVE, kind: "accounts", sealed })), true,
  "whoever has the file still needs the relay to hand over the other half, and it only does that for the verified Minecraft account");
check("and the relay's half alone opens nothing",
  !!threw(() => c.open({ relayHalf: RELAY, driveHalf: otherDrive, kind: "accounts", sealed })), true,
  "a relay compromise is not a way into anybody's accounts");
check("nor does neither",
  !!threw(() => c.open({ relayHalf: otherRelay, driveHalf: otherDrive, kind: "accounts", sealed })), true);
check("and the failure never says WHICH half was wrong",
  [
    threw(() => c.open({ relayHalf: otherRelay, driveHalf: DRIVE, kind: "accounts", sealed })),
    threw(() => c.open({ relayHalf: RELAY, driveHalf: otherDrive, kind: "accounts", sealed })),
  ].reduce((a, b) => a === b),
  true,
  "otherwise holding one half lets you test guesses at the other");

// ── one key per kind ──
check("two kinds of thing get different keys from the same pair",
  c.keyFor({ relayHalf: RELAY, driveHalf: DRIVE, kind: "accounts" })
    .equals(c.keyFor({ relayHalf: RELAY, driveHalf: DRIVE, kind: "settings" })),
  false,
  "so a flaw that exposed the settings does not hand over the accounts");
check("and the same kind gets the same key every time",
  c.keyFor({ relayHalf: RELAY, driveHalf: DRIVE, kind: "accounts" })
    .equals(c.keyFor({ relayHalf: RELAY, driveHalf: DRIVE, kind: "accounts" })),
  true);
check("a key with nothing to say what it is for is refused",
  !!threw(() => c.keyFor({ relayHalf: RELAY, driveHalf: DRIVE })), true);

// ── a file cannot be moved into another slot ──
const settings = c.seal({ relayHalf: RELAY, driveHalf: DRIVE, kind: "settings", plaintext: "{}" });
check("asking for one kind and being handed another is refused, not decrypted",
  /is a settings file, not a accounts one/.test(
    threw(() => c.open({ relayHalf: RELAY, driveHalf: DRIVE, kind: "accounts", sealed: settings })) || ""),
  true,
  "so the settings file cannot be dropped in where the accounts file goes");
check("and a file says what it is without being opened",
  c.peek(sealed), { scheme: c.SCHEME, kind: "accounts" });

// ── and it notices being changed ──
for (const [what, edit] of [
  ["a flipped bit in the body", (b) => { const x = Buffer.from(b); x[x.length - 3] ^= 1; return x; }],
  ["a flipped bit in the nonce", (b) => { const x = Buffer.from(b); x[2 + x[0]] ^= 1; return x; }],
  ["a flipped bit in the tag", (b) => { const x = Buffer.from(b); x[1 + x[0] + 12] ^= 1; return x; }],
  ["the header rewritten to say something else", (b) => {
    const header = Buffer.from(JSON.stringify({ scheme: c.SCHEME, kind: "settings" }), "utf8");
    return Buffer.concat([Buffer.from([header.length]), header, b.subarray(1 + b[0])]);
  }],
  ["the end chopped off", (b) => b.subarray(0, b.length - 4)],
]) {
  check(`${what} is refused`,
    !!threw(() => c.open({ relayHalf: RELAY, driveHalf: DRIVE, sealed: edit(sealed) })), true);
}

// ── and nonsense in, nothing out ──
check("something that is not a synced file at all is refused",
  !!threw(() => c.open({ relayHalf: RELAY, driveHalf: DRIVE, sealed: Buffer.from("hello") })), true);
check("a half that is not a key is refused rather than stretched into one",
  ["", "hunter2", "not-hex", "a".repeat(63)].map(h =>
    !!threw(() => c.keyFor({ relayHalf: h, driveHalf: DRIVE, kind: "x" }))),
  [true, true, true, true],
  "quietly hashing a short string into a key is how a password ends up being the whole of the security");

// ── a new Drive half is a real one ──
const halves = new Set(Array.from({ length: 200 }, () => c.newDriveHalf()));
check("each Drive half is random and the right size",
  [halves.size, [...halves].every(h => /^[0-9a-f]{64}$/.test(h))], [200, true]);

// ── the same thing twice does not look the same ──
const again = c.seal({ relayHalf: RELAY, driveHalf: DRIVE, kind: "accounts", plaintext: SECRET });
check("sealing the same thing twice gives different bytes",
  sealed.equals(again), false,
  "a fresh nonce each time, so an onlooker cannot tell that nothing changed");

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
