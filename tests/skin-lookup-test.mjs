// Every premium account turning into Steve, all at once.
//
// What was reported: the launcher opened and every signed-in account's skin
// was a default, while the friends panel's heads were fine. The log said why
// four times over:
//
//     head: no profile for 20bbb23e2f2246bab201c6bd435b445b: profile 429
//
// 429 is Mojang saying "you asked too often". It was being treated as an
// answer about the player rather than about the asking, so the launcher drew
// the default skin -- which is also exactly what an account with no custom
// skin looks like, so nothing on screen could say which it was.
//
// Three things made it happen, and all three are checked here:
//
//   1. the uuid-to-texture mapping lived only in memory, so every start knew
//      nothing and asked Mojang about every account at once;
//   2. nothing stopped the same uuid being asked about twice at the same
//      time -- the log shows one of them asked three times;
//   3. a failed lookup became a default skin and was then left alone.
//
// The real functions are lifted out of main.js, because a reimplementation
// here would agree with whatever this file assumed.
import fs from "fs";
import os from "os";
import path from "path";
import { liftModule } from "./lib/lift.mjs";

let bad = 0;
const check = (what, got, want, note) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${note ? "  — " + note : ""}`
    + (ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`));
};

const WANTED = [
  "HEAD_PROFILE_TTL", "HEAD_FAIL_TTL", "HEAD_PROFILE_KEEP",
  "_headProfile", "_headUuid", "_headFail",
  "_headFresh", "_headCooling", "_headCool",
  "HEAD_PROFILE_FILE", "_headProfileDirty", "loadHeadProfiles", "saveHeadProfiles",
  "_headSaveSoon", "headProfilesChanged",
  "_headGuessed", "_headRetrySoon", "headWasGuessed", "retryGuessedHeads",
  "MOJANG_GAP", "_mojangInFlight", "_mojangNext", "askMojang",
  "headTextureForUuid",
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rl-skin-"));
const mod = await liftModule(WANTED, {
  file: "skinlookup",
  prelude: 'import fs from "fs";\nimport path from "path";\n'
    + `export const texturesDir = ${JSON.stringify(tmp)};\n`
    + "export const logged = [];\n"
    + "const devtoolsLog = (...a) => logged.push(a.join(' '));\n"
    + "export const broadcasts = [];\n"
    + "const sendEverywhere = (ch) => broadcasts.push(ch);\n"
    // `app.on('will-quit', …)` at the top of the slice: a stand-in, so the
    // real line is exercised rather than edited out.
    + "const app = { on: () => {} };\n",
});

// What Mojang answers, swapped per case, and how many times it was asked.
let asked = [];
let answer = () => ({ status: 200, body: null });
globalThis.fetch = async (url) => {
  asked.push(String(url));
  const a = answer(String(url));
  return {
    ok: a.status >= 200 && a.status < 300,
    status: a.status,
    json: async () => JSON.parse(a.body),
    text: async () => a.body,
  };
};

const HASH = "292009a4925b58f02c77dadc3ecef07ea4c7472f64e0fdc32ce5522489362680";
const UUID = "069a79f444e94726a5befca90e38aaf5";
const profileBody = (hash, slim) => JSON.stringify({
  id: UUID, name: "Someone",
  properties: [{
    name: "textures",
    value: Buffer.from(JSON.stringify({
      textures: { SKIN: { url: "https://textures.minecraft.net/texture/" + hash, metadata: slim ? { model: "slim" } : undefined } },
    }), "utf8").toString("base64"),
  }],
});

const clear = () => {
  mod._headProfile.clear();
  mod._headFail.clear();
  mod._headGuessed.clear();
  mod._mojangInFlight.clear();
  asked = [];
  mod.logged.length = 0;
  mod.broadcasts.length = 0;
};

// ── the ordinary answer ───────────────────────────────────────────────────
{
  clear();
  answer = () => ({ status: 200, body: profileBody(HASH, false) });
  const r = await mod.headTextureForUuid(UUID);
  check("a profile is read for its texture", [r && r.hash, r && r.slim], [HASH, false]);
  check("and asked for once", asked.length, 1);
}

// ── the same player, asked for three times at once ────────────────────────
//
// Which is what the log shows: 20bbb23e… three times in a row. Every head on
// a page wants the same few accounts, and each one used to be its own
// request -- all counting against a limit that is about the profile, not
// about the page.
{
  clear();
  answer = () => ({ status: 200, body: profileBody(HASH, false) });
  const three = await Promise.all([
    mod.headTextureForUuid(UUID),
    mod.headTextureForUuid(UUID),
    mod.headTextureForUuid(UUID),
  ]);
  check("three asks at once are one request", asked.length, 1,
    "the log showed the same uuid asked for three times, and that is how a rate limit is reached");
  check("and all three get the answer", three.map(r => r && r.hash), [HASH, HASH, HASH]);
}

// ── 429 ───────────────────────────────────────────────────────────────────
{
  clear();
  answer = () => ({ status: 429, body: "" });
  const r = await mod.headTextureForUuid(UUID);
  check("being rate-limited is not an answer about the player", r, null,
    "it has to be distinguishable from 'this player has no skin', which is what it was drawn as");
  check("and it says so rather than claiming there is no profile",
    mod.logged.some(l => /rate-limiting/.test(l)), true);
  // A minute, not ten: the long cool-down is for a real failure. Ten minutes
  // of every account looking wrong because of one busy moment is the bug.
  const until = mod._headFail.get("p:" + UUID) - Date.now();
  check("the wait is a minute, not the ten a real failure gets",
    [until > 50000, until < 70000], [true, true]);
}

// With something already known, a 429 keeps it.
{
  clear();
  mod._headProfile.set(UUID, { hash: HASH, slim: false, cape: null, at: Date.now() - mod.HEAD_PROFILE_TTL - 1000 });
  answer = () => ({ status: 429, body: "" });
  const r = await mod.headTextureForUuid(UUID);
  check("and what was known before is kept rather than thrown away",
    r && r.hash, HASH,
    "a skin from yesterday is enormously better than a Steve");
}

// ── across a restart ──────────────────────────────────────────────────────
//
// The one that made it happen to everybody at once. Every skin PNG is
// already cached on disk by its hash; the only thing that was not was which
// hash belongs to which player, so a cold start knew nothing at all.
{
  clear();
  answer = () => ({ status: 200, body: profileBody(HASH, true) });
  await mod.headTextureForUuid(UUID);
  mod.saveHeadProfiles();
  // `saveHeadProfiles` only writes when something marked it dirty, which is
  // what the lookup above should have done.
  check("what Mojang said is written down", fs.existsSync(mod.HEAD_PROFILE_FILE()), true,
    "every start used to begin knowing nothing, and ask about every account at once");

  // A new launcher: nothing in memory, the file on disk.
  mod._headProfile.clear();
  mod.loadHeadProfiles();
  asked = [];
  const r = await mod.headTextureForUuid(UUID);
  check("and read back on the next start", [r && r.hash, r && r.slim], [HASH, true]);
  check("without asking Mojang anything at all", asked.length, 0);
}

// Something remembered too long ago is not kept for ever.
{
  clear();
  fs.writeFileSync(mod.HEAD_PROFILE_FILE(), JSON.stringify({
    [UUID]: { hash: HASH, slim: false, at: Date.now() - mod.HEAD_PROFILE_KEEP - 1000 },
    "ffffffffffffffffffffffffffffffff": { hash: HASH, slim: false, at: Date.now() },
  }));
  mod.loadHeadProfiles();
  check("a mapping from long enough ago is dropped",
    [mod._headProfile.has(UUID), mod._headProfile.has("ffffffffffffffffffffffffffffffff")],
    [false, true]);
}

// ── coming back with the real one ─────────────────────────────────────────
//
// When there is nothing known and Mojang will not answer, a default is all
// there is to draw. What must not happen is settling on it.
{
  clear();
  mod.headWasGuessed(UUID);
  check("an account drawn as a default it was not sure of is remembered",
    mod._headGuessed.has(UUID), true);

  answer = () => ({ status: 200, body: profileBody(HASH, false) });
  await mod.retryGuessedHeads();
  check("and asked about again once Mojang will answer",
    [mod._headGuessed.has(UUID), asked.length], [false, 1]);
  check("then every window is told, so the Steve turns back into the player",
    mod.broadcasts, ["heads-changed"]);
}

// Still nothing: it stays on the list and nobody is told anything.
{
  clear();
  mod.headWasGuessed(UUID);
  answer = () => ({ status: 429, body: "" });
  await mod.retryGuessedHeads();
  check("one that still cannot be had stays on the list",
    [mod._headGuessed.has(UUID), mod.broadcasts], [true, []],
    "and no window is woken for nothing");
}

// ── and the requests are spread out ───────────────────────────────────────
{
  clear();
  answer = () => ({ status: 200, body: profileBody(HASH, false) });
  const t0 = Date.now();
  await Promise.all(["a", "b", "c", "d"].map((c) => mod.headTextureForUuid(c.repeat(32))));
  const took = Date.now() - t0;
  check("four different players do not all go out at once",
    [asked.length, took >= mod.MOJANG_GAP * 2], [4, true],
    `took ${took}ms for four, spaced ${mod.MOJANG_GAP}ms apart`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
