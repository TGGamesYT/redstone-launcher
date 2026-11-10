// Can a modified launcher read somebody else's synced data?
//
// The launcher is open source, so anybody can build one that prints every
// secret it is given. The question is what that gets them. This file is the
// answer, checked rather than argued.
//
// What a modified launcher CAN do: sign in with its own Minecraft account
// and its own Google account, and print the key half the relay hands it.
//
// What that half is: HMAC(relay's key, that account's own UUID). Not the
// relay's key -- the output of it. So it opens that account's data and
// nothing else, and it says nothing about anybody else's, because HMAC
// cannot be run backwards to recover the key it was made with.
//
// The attack the design actually has to stop is therefore:
//
//   attacker gets at a victim's Drive folder -- shared, or the Google
//   account compromised -- and then needs the victim's half. The relay will
//   only derive one for the account Mojang verified on that connection, and
//   nothing in the request says which account that is.
//
// Which is what is checked below.
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import cc from "../backend/cloud-crypto.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let bad = 0;
const ok = (what, note) => console.log(`ok   ${what}${note ? "  — " + note : ""}`);
const fail = (what, why) => { bad++; console.log(`FAIL ${what}\n       ${why}`); };
const check = (what, got, want, note) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) ok(what, note); else fail(what, `got  ${a}\n       want ${b}`);
};

// The real handler out of the relay, with the two things it reaches for
// stubbed: the stored config, and the log.
const src = fs.readFileSync(path.join(ROOT, "relay-server", "relay.js"), "utf8");
const from = src.indexOf("function cloudRelayKey()");
const to = src.indexOf("function handleAdmin");
if (from < 0 || to < 0) { console.log("FAIL could not find handleCloud in relay.js"); process.exit(1); }

const RELAY_KEY = crypto.randomBytes(32).toString("hex");
const store = { cloudKey: RELAY_KEY, googleClientId: "id.apps.googleusercontent.com", googleClientSecret: "shh" };
const handleCloud = new Function("crypto", "config", "log", `
  ${src.slice(from, to)}
  return handleCloud;
`)(crypto, { get: (k) => store[k], set: (v) => Object.assign(store, v) }, () => { });

const VICTIM = "20bbb23e2f2246bab201c6bd435b445b";
const ATTACKER = "f06d927ed6cf48b8ba61588866b610c0";

// ── the half is the account's, not the relay's ──
const victimHalf = handleCloud({ op: "secret" }, { uuid: VICTIM }).half;
const attackerHalf = handleCloud({ op: "secret" }, { uuid: ATTACKER }).half;

check("two accounts are given different halves", victimHalf === attackerHalf, false);
check("and the same account always the same one",
  handleCloud({ op: "secret" }, { uuid: VICTIM }).half, victimHalf,
  "derived rather than stored, so there is no table of them to lose");
check("neither half IS the relay's key",
  [victimHalf === RELAY_KEY, attackerHalf === RELAY_KEY], [false, false],
  "what leaves is the output of an HMAC, which cannot be run backwards to the key");

// ── a modified launcher cannot ask for somebody else's ──
//
// This is the whole of it. Every shape of request that could name another
// account, against a connection Mojang verified as the attacker.
for (const [what, req] of [
  ["a uuid in the request", { op: "secret", uuid: VICTIM }],
  ["a username", { op: "secret", username: "TGdoesCode" }],
  ["a `who` of its own", { op: "secret", who: { uuid: VICTIM } }],
  ["an account object", { op: "secret", account: { uuid: VICTIM } }],
  ["all of them at once", { op: "secret", uuid: VICTIM, username: "TGdoesCode", who: { uuid: VICTIM } }],
]) {
  check(`${what} does not get the victim's half`,
    handleCloud(req, { uuid: ATTACKER }).half, attackerHalf,
    "the uuid comes from the connection Mojang verified, and the request is not consulted");
}

// ── and the half it does get opens nothing of the victim's ──
//
// The attacker is assumed to have the victim's whole Drive folder: the
// encrypted accounts file AND the key.json half out of it.
const victimDriveHalf = cc.newDriveHalf();
const sealed = cc.seal({
  relayHalf: victimHalf, driveHalf: victimDriveHalf, kind: "accounts",
  plaintext: JSON.stringify([{ id: "p1", refresh: "the-victims-minecraft-token" }]),
});
let opened = null, why = null;
try {
  opened = cc.open({ relayHalf: attackerHalf, driveHalf: victimDriveHalf, kind: "accounts", sealed }).toString();
} catch (e) { why = e.message; }
check("the victim's whole Drive folder, plus the attacker's own half, opens nothing",
  [opened, /could not be opened/.test(why || "")], [null, true],
  "having the folder is not enough, and the relay will not hand over the other half for an account it did not verify");

// And it really was readable with the right one, so the test above is not
// passing because the ciphertext is broken.
check("while the victim's own half opens it",
  JSON.parse(cc.open({ relayHalf: victimHalf, driveHalf: victimDriveHalf, kind: "accounts", sealed }).toString())[0].refresh,
  "the-victims-minecraft-token");

// ── guessing the relay's key from a half ──
//
// Not a proof -- that is what HMAC-SHA256 is for -- but a check that the
// half is a full-width output rather than something truncated into a
// guessable space.
check("a half is a full 256 bits",
  /^[0-9a-f]{64}$/.test(victimHalf), true);

// ── an account that cannot be verified gets nothing ──
for (const [what, who] of [
  ["no account at all", {}],
  ["an empty uuid", { uuid: "" }],
  ["something that is not a uuid", { uuid: "TGdoesCode" }],
  ["a uuid with dashes, which hasJoined never returns", { uuid: "20bbb23e-2f22-46ba-b201-c6bd435b445b" }],
]) {
  const r = handleCloud({ op: "secret" }, who);
  check(`${what} is refused`, [r.ok, !!r.half], [false, false]);
}

// ── what IS worth harvesting from a modified launcher ──
//
// The Google client. Any signed-in account can ask for it, so a modified
// launcher can print it -- and Google's own position is that an installed
// app's "secret" is not confidential, because every copy of every desktop
// app carries one. What it would let somebody do is put the launcher's name
// on a consent screen of their own, which is a phishing concern rather than
// a way into anybody's data. It is kept on the relay so it can be changed
// without a release, which is the mitigation that matters.
const cfg = handleCloud({ op: "config" }, { uuid: ATTACKER });
check("the Google client is handed to any verified account",
  [cfg.ok, cfg.clientId], [true, "id.apps.googleusercontent.com"],
  "it has to be: every launcher needs it to sign in at all");
check("and it is settable on the relay, so it can be rotated without a release",
  /googleClientId/.test(fs.readFileSync(path.join(ROOT, "relay-server", "config.js"), "utf8")), true);

// ── nothing else is reachable on that channel ──
for (const op of ["key", "relayKey", "dump", "", "admin", "settings.list"]) {
  check(`there is no \`${op || "(empty)"}\` op`,
    handleCloud({ op }, { uuid: ATTACKER }).ok, false);
}

// ── and an offline account cannot sync at all ──
//
// There is no hasJoined for one, so there is no verified uuid, so there is
// no half -- the launcher refuses before it gets this far.
check("the launcher will not even ask for a half without a verified account",
  /selectedAccountIsOffline\(\)\) return null/.test(fs.readFileSync(path.join(ROOT, "backend", "main.js"), "utf8")),
  true,
  "an offline account has nothing Mojang can vouch for");

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
