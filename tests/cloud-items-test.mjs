// What is allowed to leave this computer.
//
// The transport is encrypted with two halves and the Drive folder is of no
// use without both, but none of that helps if the wrong thing is put into
// it in the first place. Two in particular:
//
//   cloudGoogle      the Google refresh token. Syncing the settings with it
//                    in them puts the key to the Drive inside the Drive.
//   themeSigningKey  the private half of the key a shared theme is signed
//                    with. Whoever holds it can sign a theme as you.
//
// So this checks the leaving-out, by name and by shape, and checks it in
// both directions -- a tampered Drive folder must not be able to set this
// computer's Java path either.
import items from "../backend/cloud-items.js";

let bad = 0;
const ok = (what, note) => console.log(`ok   ${what}${note ? "  — " + note : ""}`);
const fail = (what, why) => { bad++; console.log(`FAIL ${what}\n       ${why}`); };
const check = (what, got, want, note) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) ok(what, note); else fail(what, `got  ${a}\n       want ${b}`);
};

const store = (obj) => {
  const o = { ...obj };
  return { store: o, get: (k, d) => (k in o ? o[k] : d), set: (k, v) => { o[k] = v; }, all: () => o };
};

// ── the settings ──
const EVERYTHING = {
  gridView: true, greeting: "hello",
  // the look, which is a decision rather than a preference
  baseColor: "#b30c0c", font: "Pixel", borderRadius: 25,
  homeLayout: [{ id: "a", x: 0, y: 0, w: 100, h: 3 }],
  background: { mode: "image", image: { file: "C:/pics/wall.png" } },
  appIcon: { kind: "theme", mergeBlock: true },
  // things that must not go
  cloudGoogle: { refreshToken: "1//0gTheRefreshToken", email: "me@example.com" },
  themeSigningKey: "-----BEGIN PRIVATE KEY-----\nMIGH...\n-----END PRIVATE KEY-----",
  cloudDeviceId: "ab".repeat(16),
  cloudAgreed: { settings: { version: 3 } },
  cloudKinds: { settings: true },
  javaPath: "C:/Program Files/Java/bin/java.exe",
  ramInstancesMax: 32768,
  relayVerifyTls: false,
  pendingUpdate: { version: "9.9.9" },
};

const sent = items.settingsFor(store(EVERYTHING));
check("the Google refresh token never leaves this computer",
  JSON.stringify(sent).includes("1//0gTheRefreshToken"), false,
  "syncing it would put the key to the Drive inside the Drive");
check("and neither does the key that signs a theme as you",
  JSON.stringify(sent).includes("BEGIN PRIVATE KEY"), false);
check("nor does anything else that is about this computer",
  ["cloudDeviceId", "cloudAgreed", "cloudKinds", "javaPath", "ramInstancesMax",
    "relayVerifyTls", "pendingUpdate"].filter(k => k in sent), []);
check("but the things that ARE yours do go",
  Object.keys(sent).sort(), ["greeting", "gridView"],
  "a setting added later and forgotten should sync, not silently not sync");
check("and the look the launcher is wearing is not one of them",
  ["baseColor", "font", "borderRadius", "homeLayout", "background", "appIcon"].filter(k => k in sent), [],
  "a sync that repaints a launcher somebody is looking at has decided something; "
  + "saved themes sync as themes, and which one is worn stays each computer's own");

// ── and by shape, for the one nobody remembers to add to the list ──
for (const [key, value] of [
  ["modrinthToken", "abc"],
  ["someApiKey", "xyz"],
  ["userPassword", "hunter2"],
  ["curseforge_secret", "s"],
  ["myRefreshThing", "r"],
  ["futureCredential", "c"],
  ["somethingOpaque", "x".repeat(200)],
]) {
  check(`a setting called ${key} is left out even though nobody listed it`,
    key in items.settingsFor(store({ [key]: value })), false);
}
check("while an ordinary long-ish setting still goes",
  "greetingText" in items.settingsFor(store({ greetingText: "Good evening, and welcome back to the launcher" })),
  true,
  "the shape test is blunt on purpose, but not so blunt that prose is a secret");

// ── coming back the other way ──
{
  const s = store({ baseColor: "#000000", gridView: false, javaPath: "/usr/bin/java", relayVerifyTls: true });
  const r = items.applySettings(s, {
    gridView: true,
    baseColor: "#ff0000",
    // A Drive folder somebody has got at.
    javaPath: "/tmp/evil",
    relayVerifyTls: false,
    themeSigningKey: "theirs",
    cloudGoogle: { refreshToken: "theirs" },
  });
  check("what comes back changes what it should", s.get("gridView"), true);
  check("but not the colours of a launcher somebody is looking at",
    s.get("baseColor"), "#000000",
    "the look is left out in both directions, so an older computer still sending it cannot apply it either");
  check("and a tampered folder cannot point this computer at another Java",
    s.get("javaPath"), "/usr/bin/java",
    "the same list applies coming in; nothing outside what we would have sent is taken");
  check("nor turn off checking the relay's certificate", s.get("relayVerifyTls"), true);
  check("nor hand it a signing key or a Google token",
    [s.get("themeSigningKey", null), s.get("cloudGoogle", null)], [null, null]);
  check("and it says what it did change", r.changed, ["gridView"]);
}

// ── accounts ──
{
  const players = [{
    id: "p1", username: "TGdoesCode", type: "microsoft",
    auth: { access_token: "at", uuid: "20bb", name: "TGdoesCode" },
    refresh: "the-microsoft-refresh-token",
    needsReauth: true, lastRefresh: 1234,
  }];
  const out = items.accountsFor(players);
  check("an account goes with its tokens, because that is the point",
    [out[0].refresh, out[0].auth.access_token], ["the-microsoft-refresh-token", "at"],
    "safe only because of the two key halves; this is the file they protect");
  check("but not this computer's opinion of them",
    ["needsReauth", "lastRefresh"].filter(k => k in out[0]), [],
    "whether the token worked here is about here");
}
{
  // Merging, which is where a computer could lose an account.
  const local = [
    { id: "a", username: "One", refresh: "local-a", needsReauth: false },
    { id: "only-here", username: "Three", refresh: "local-c" },
  ];
  const incoming = [
    { id: "a", username: "One renamed", refresh: "drive-a" },
    { id: "b", username: "Two", refresh: "drive-b" },
  ];
  const m = items.mergeAccounts(local, incoming);
  check("an account only this computer has is kept",
    m.players.find(p => p.id === "only-here").refresh, "local-c",
    "syncing must not be a way to lose an account");
  check("an account only the Drive has is taken", m.added, ["b"]);
  check("and where both have one, a token that works here is not replaced",
    m.players.find(p => p.id === "a").refresh, "local-a",
    "the synced one may be older; this one is known to work");
  check("though the rest of the account still comes across",
    m.players.find(p => p.id === "a").username, "One renamed");
}
{
  // The case that is worth syncing for: this computer's token is dead.
  const m = items.mergeAccounts(
    [{ id: "a", username: "One", refresh: "stale", needsReauth: true }],
    [{ id: "a", username: "One", refresh: "fresh" }]);
  check("a token this computer knows is dead is replaced by the synced one",
    [m.players[0].refresh, m.players[0].needsReauth], ["fresh", undefined],
    "which is the whole reason to sync accounts");
}

// ── themes ──
{
  const m = items.mergeThemes(
    [{ name: "Mine", at: 2 }, { name: "Both", at: 5 }],
    [{ name: "Theirs", at: 1 }, { name: "Both", at: 9 }]);
  check("themes are merged, not replaced",
    m.themes.map(t => t.name).sort(), ["Both", "Mine", "Theirs"],
    "a computer's own themes are not thrown away by a sync");
  check("and the newer of two with the same name wins",
    m.themes.find(t => t.name === "Both").at, 9);
}

// ── skins ──
//
// The library is per-account, and the interesting part is the tombstones:
// without them a deletion cannot travel. Deleting a skin here and syncing
// would find it missing locally, decide the Drive's copy was the newer
// truth, and put it straight back -- a deletion that undoes itself, which is
// worse than one that does not happen.
{
  const skin = (hash, at) => ({ pixelHash: hash, addedAt: at, png: "data:" + hash });
  const m = items.mergeSkins(
    { a: [skin("one", 10), skin("two", 20)], b: [skin("mine", 5)], __pool_order__: ["one", "two"] },
    { a: [skin("two", 20), skin("three", 30)], c: [skin("theirs", 7)] });
  check("a skin only one computer has is kept, whichever computer that is",
    m.library.a.map(s => s.pixelHash).sort(), ["one", "three", "two"],
    "merged like the servers and the themes: syncing must not cost you a skin");
  check("and an account only one computer knows is kept whole",
    [m.library.b.length, m.library.c.length], [1, 1]);
  check("the same skin on both sides is one skin",
    m.library.a.filter(s => s.pixelHash === "two").length, 1,
    "the pixels are the identity; the same picture saved twice is not two skins");
  check("the order a pooled list is shown in survives",
    m.library.__pool_order__, ["one", "two"]);
  check("and what arrived is reported, so a sync can say what it did",
    m.added.includes("three"), true);
}
{
  const skin = (hash, at) => ({ pixelHash: hash, addedAt: at });
  // Deleted here at t=50, and the Drive still has it from t=10.
  const m = items.mergeSkins(
    { a: [], __deleted__: { a: { gone: 50 } } },
    { a: [skin("gone", 10), skin("kept", 10)] });
  check("a skin deleted here stays deleted when the Drive still has it",
    m.library.a.map(s => s.pixelHash), ["kept"],
    "without the tombstone the deletion undoes itself on the next sync");
  check("and the tombstone itself is kept, for the next computer to sync",
    m.library.__deleted__.a.gone, 50);
  // Deleted, then saved again deliberately. The newer save wins: a
  // tombstone is a record of one deletion, not a ban on the picture.
  const back = items.mergeSkins(
    { a: [], __deleted__: { a: { gone: 50 } } },
    { a: [skin("gone", 90)] });
  check("but saving it again afterwards brings it back",
    back.library.a.map(s => s.pixelHash), ["gone"],
    "a tombstone records a deletion, it does not ban the picture for ever");
}

// ── the list is readable where somebody will look for it ──
// Belt and braces: the two that matter most are caught by the shape test as
// well as by name, so forgetting one of them in the list is not the whole of
// the protection. Neither is caught by its NAME -- cloudGoogle says nothing
// and themeSigningKey is a private key with whitespace in it -- so this is
// about the values.
check("the Google token is caught even under a name that says nothing",
  items.looksSecret("somethingHarmless", EVERYTHING.cloudGoogle), true,
  "a secret nested one level down is the realistic future leak");
check("and a private key is caught however it is spelled",
  items.looksSecret("anything", EVERYTHING.themeSigningKey), true);
check("while an ordinary object still goes",
  items.looksSecret("homeLayout", EVERYTHING.homeLayout), false);

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
