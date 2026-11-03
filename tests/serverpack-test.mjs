// What a server actually hands a player.
//
// A server sends one resource pack, so the launcher merges the list of them
// into one zip. Everything about that merge is invisible from the launcher --
// it ends up in a player's log, on another machine, as a flood of
// "Exception loading blockstate definition" and "Missing block model" with
// nothing to say where it came from. So the merge is checked here, with real
// zips, for the three ways it could produce a pack the game cannot read.
import AdmZip from "adm-zip";
import { mergePacks, readPack, wrapperPrefix, packFormat } from "../backend/serverpack.js";

let bad = 0;
const fail = (what, why) => { bad++; console.log(`FAIL ${what}\n       ${why}`); };
const ok = (what, note) => console.log(`ok   ${what}${note ? "  — " + note : ""}`);
const check = (what, got, want, note) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) ok(what, note); else fail(what, `got  ${a}\n       want ${b}`);
};

const mcmeta = (format, description) =>
  JSON.stringify({ pack: { pack_format: format, description } });

/** A zip, from a plain map of path -> text. */
function zipOf(files) {
  const z = new AdmZip();
  for (const [name, text] of Object.entries(files)) z.addFile(name, Buffer.from(text));
  return z.toBuffer();
}
const entriesOf = (buf) => new AdmZip(buf).getEntries().filter(e => !e.isDirectory).map(e => e.entryName).sort();
const textIn = (buf, name) => {
  const e = new AdmZip(buf).getEntry(name);
  return e ? e.getData().toString("utf8") : null;
};

// ── a pack zipped from its folder ──
//
// Right-clicking the folder and choosing "compress" puts everything one level
// down. Merged as it stands, not one file of it is where the game looks --
// while the blockstates of the packs under it still point at the models that
// pack was there to provide.
{
  const wrapped = zipOf({
    "My Pack/pack.mcmeta": mcmeta(15, "wrapped"),
    "My Pack/assets/minecraft/blockstates/stone.json": "{}",
    "My Pack/assets/minecraft/models/block/stone.json": "{}",
  });
  check("a folder-zipped pack is recognised as one",
    wrapperPrefix(entriesOf(wrapped)), "My Pack/",
    "by what is under it, not by being alone in the zip");

  const merged = mergePacks([{ name: "wrapped.zip", buf: wrapped }]);
  check("and its files are put where the game looks",
    entriesOf(merged.buf),
    ["assets/minecraft/blockstates/stone.json", "assets/minecraft/models/block/stone.json", "pack.mcmeta"]);
  check("and it says so", merged.notes.length, 1, merged.notes[0]);
}

// A readme beside the pack folder must not make it unrecognisable, and two
// pack folders in one zip must not be guessed between.
{
  const withReadme = entriesOf(zipOf({
    "My Pack/pack.mcmeta": mcmeta(15, "x"),
    "My Pack/assets/minecraft/sounds.json": "{}",
    "README.txt": "hello",
  }));
  check("a readme beside the folder changes nothing", wrapperPrefix(withReadme), "My Pack/");

  const two = entriesOf(zipOf({
    "A/pack.mcmeta": mcmeta(15, "a"),
    "B/pack.mcmeta": mcmeta(15, "b"),
  }));
  check("two packs in one zip are not guessed between", wrapperPrefix(two), "",
    "there is no telling which was meant");
}

// ── what is not part of a pack ──
{
  const noisy = zipOf({
    "pack.mcmeta": mcmeta(15, "noisy"),
    "pack.png": "PNG",
    "assets/minecraft/textures/block/dirt.png": "PNG",
    "overlays/1_21/assets/minecraft/textures/block/dirt.png": "PNG",
    "README.md": "read me",
    "__MACOSX/._pack.mcmeta": "junk",
    "src/MyPack.java": "class MyPack {}",
  });
  const merged = mergePacks([{ name: "noisy.zip", buf: noisy }]);
  check("only what belongs in a pack is merged",
    entriesOf(merged.buf),
    ["assets/minecraft/textures/block/dirt.png", "overlays/1_21/assets/minecraft/textures/block/dirt.png",
      "pack.mcmeta", "pack.png"],
    "overlays are part of a pack; a readme, a __MACOSX folder and the author's source are not");
}

// A zip that is not a pack at all is left out and named, rather than being
// merged into nothing.
{
  const notAPack = zipOf({ "assets/minecraft/textures/block/dirt.png": "PNG" });
  check("a zip with no pack.mcmeta is not a pack", readPack(notAPack), null);

  const real = zipOf({ "pack.mcmeta": mcmeta(15, "real"), "assets/minecraft/x.json": "{}" });
  const merged = mergePacks([{ name: "notapack.zip", buf: notAPack }, { name: "real.zip", buf: real }]);
  check("and the rest still merge", merged.used, ["real.zip"]);
  check("and it is named", /notapack\.zip/.test(merged.notes.join(" ")), true, merged.notes[0]);

  check("and nothing usable at all merges to nothing",
    mergePacks([{ name: "notapack.zip", buf: notAPack }]), null);
  check("a file that is not a zip is handled", readPack(Buffer.from("not a zip at all")), null);
}

// ── priority ──
{
  const top = zipOf({ "pack.mcmeta": mcmeta(15, "top"), "assets/minecraft/a.json": "top" });
  const under = zipOf({ "pack.mcmeta": mcmeta(15, "under"), "assets/minecraft/a.json": "under", "assets/minecraft/b.json": "under" });
  const merged = mergePacks([{ name: "top.zip", buf: top }, { name: "under.zip", buf: under }]);
  check("the top of the list wins a file both provide", textIn(merged.buf, "assets/minecraft/a.json"), "top");
  check("and what only the lower one has is kept", textIn(merged.buf, "assets/minecraft/b.json"), "under");
  check("including its pack.mcmeta", JSON.parse(textIn(merged.buf, "pack.mcmeta")).pack.description, "top");
  check("and both are listed as used", merged.used, ["top.zip", "under.zip"]);
}

// ── the same packs merge to the same bytes ──
//
// This is the one that matters most. The server tells players a SHA-1; the
// game stores what it downloads under that hash and never checks it again.
// A merge with the current time on every entry gives a different hash every
// time it runs -- so every rebuild is a fresh download for every player, and
// a download that raced a rebuild is a file filed under a hash that is not
// its own, which is a pack the game will load, broken, for ever.
{
  const a = zipOf({ "pack.mcmeta": mcmeta(15, "a"), "assets/minecraft/a.json": "a" });
  const b = zipOf({ "pack.mcmeta": mcmeta(15, "b"), "assets/minecraft/b.json": "b" });
  const once = mergePacks([{ name: "a.zip", buf: a }, { name: "b.zip", buf: b }]);
  const twice = mergePacks([{ name: "a.zip", buf: a }, { name: "b.zip", buf: b }]);
  check("merging the same packs twice gives the same bytes", once.sha1, twice.sha1, once.sha1.slice(0, 12) + "…");
  check("and really the same bytes", once.buf.equals(twice.buf), true);

  // Written down rather than only compared with itself.
  //
  // Two merges in the same run usually land in the same slot of a zip's
  // two-second clock, so comparing them to each other passes whether or not
  // the clock is in there at all -- which is exactly the bug. A hash from a
  // different day is the only thing that proves it is not.
  check("and the same bytes as on another day", once.sha1,
    "74cc6f21d7344c864df938eb96cf65cf567e118e",
    "a hash recorded once; a merge that depends on when it ran cannot match it");

  // Built from zips whose own entries carry different timestamps, which is
  // what two copies of the same pack off two machines look like.
  const sameAgain = new AdmZip();
  sameAgain.addFile("pack.mcmeta", Buffer.from(mcmeta(15, "a")));
  sameAgain.addFile("assets/minecraft/a.json", Buffer.from("a"));
  for (const e of sameAgain.getEntries()) e.header.time = new Date(Date.UTC(1999, 5, 5));
  const third = mergePacks([{ name: "a.zip", buf: sameAgain.toBuffer() }, { name: "b.zip", buf: b }]);
  check("and the packs' own timestamps do not change it", third.sha1, once.sha1);

  // Different contents must still be a different hash, or none of this means
  // anything.
  const c = zipOf({ "pack.mcmeta": mcmeta(15, "a"), "assets/minecraft/a.json": "changed" });
  const other = mergePacks([{ name: "a.zip", buf: c }, { name: "b.zip", buf: b }]);
  check("a changed pack is a different hash", other.sha1 !== once.sha1, true);
}

// ── packs for different versions ──
{
  const old = zipOf({ "pack.mcmeta": mcmeta(9, "old"), "assets/minecraft/a.json": "a" });
  const now = zipOf({ "pack.mcmeta": mcmeta(34, "now"), "assets/minecraft/b.json": "b" });
  check("packs built for different versions are flagged",
    /different versions/.test(mergePacks([{ name: "now.zip", buf: now }, { name: "old.zip", buf: old }]).notes.join(" ")),
    true,
    "the likeliest reason for a pack that loads with errors");
  check("and packs that agree are not",
    mergePacks([{ name: "a.zip", buf: now }, { name: "b.zip", buf: now }]).notes, []);
  check("what a pack says it is built for", packFormat(mcmeta(34, "x")), 34);
  check("and a pack.mcmeta that says nothing", packFormat("{}"), null);
}

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
