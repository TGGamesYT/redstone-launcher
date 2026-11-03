// Merging a server's resource packs into the one zip it hands to players.
//
// A server sends exactly one pack, so the launcher's list of them has to
// become one zip. That merge was a loop that copied every entry of every zip
// into a new one, newest last, and it has three ways of producing something
// the game cannot read -- all three of which show up as the same thing in a
// player's log: a flood of
//
//   Exception loading blockstate definition: 'minecraft:…' …
//   Missing block model: minecraft:…
//
// and, often enough, the game falling over during the resource reload that
// follows.
//
//   1. A pack somebody zipped by right-clicking the FOLDER has everything one
//      level down -- `MyPack/assets/…` rather than `assets/…`. Copied in as
//      it stands, none of it is where the game looks, so the merged pack is
//      missing exactly the files that pack was there to provide while the
//      blockstates of the packs under it still point at them.
//   2. Anything else in the zip -- a readme, a `__MACOSX` folder, the
//      author's project files -- went in too.
//   3. The zip was built with the current time on every entry, so merging the
//      same packs twice gave two different files with two different SHA-1s.
//      The server tells players a hash; the game stores what it downloads
//      UNDER that hash and trusts it afterwards. A hash that changes every
//      time the pack is rebuilt is a cache that fills with copies, and a
//      download that raced a rebuild is a file filed under a hash that is not
//      its own -- which is the one thing the game never re-checks.
//
// So: each zip is read as a pack rather than as a bag of files, the entries
// that are not part of one are left out, and the result is deterministic --
// the same packs in the same order always merge to the same bytes.
//
// Nothing here touches the disk or Electron, so it can be tested with zips
// built in memory, which is what tests/serverpack-test.mjs does.
import AdmZip from "adm-zip";
import crypto from "crypto";

// What belongs in a resource pack, at its root.
//
//   assets/      the pack itself
//   overlays/    a pack carrying more than one format's files (1.20.2+)
//   pack.mcmeta  what it says it is -- without this it is not a pack at all
//   pack.png     its picture in the list
const PACK_ROOT = /^(assets|overlays)\//;
const PACK_FILES = new Set(["pack.mcmeta", "pack.png"]);

const isPackPath = (name) => PACK_ROOT.test(name) || PACK_FILES.has(name);

/**
 * The prefix to take off this zip's entries, if it has one.
 *
 * A pack zipped from its folder is `MyPack/pack.mcmeta`, `MyPack/assets/…`.
 * That is one directory holding the whole pack, and it is recognised by what
 * is under it -- a pack.mcmeta -- rather than by being alone in the zip,
 * because the same zips tend to carry a readme beside it.
 *
 * Returns "" when the pack is already at the root.
 */
export function wrapperPrefix(names) {
  if (names.some((n) => n === "pack.mcmeta")) return "";
  const candidates = new Set();
  for (const n of names) {
    const m = /^([^/]+)\/pack\.mcmeta$/.exec(n);
    if (m) candidates.add(m[1] + "/");
  }
  // Exactly one, or there is no telling which is the pack.
  return candidates.size === 1 ? [...candidates][0] : "";
}

/**
 * One pack's entries, keyed by where they belong in a pack.
 *
 * `null` when the zip holds no pack at all, so the caller can say which file
 * it was rather than quietly merging nothing.
 */
export function readPack(buf) {
  let entries;
  try { entries = new AdmZip(buf).getEntries(); }
  catch { return null; }
  const names = entries.filter((e) => !e.isDirectory).map((e) => e.entryName);
  const prefix = wrapperPrefix(names);
  const files = new Map();
  let skipped = 0;
  for (const e of entries) {
    if (e.isDirectory) continue;
    let name = e.entryName;
    if (prefix) {
      if (!name.startsWith(prefix)) { skipped++; continue; }
      name = name.slice(prefix.length);
    }
    if (!isPackPath(name)) { skipped++; continue; }
    try { files.set(name, e.getData()); } catch { skipped++; }
  }
  if (!files.has("pack.mcmeta")) return null;
  return { files, prefix, skipped };
}

/** What a pack says it is built for, or null when it does not say. */
export function packFormat(mcmeta) {
  try {
    const j = JSON.parse(String(mcmeta));
    const p = j && j.pack;
    if (!p) return null;
    const n = Number(p.pack_format);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

/**
 * Merge packs into one, highest priority first.
 *
 * `packs` is [{ name, buf }] in the order the server lists them, which is the
 * order a player would see them in: the first wins where two of them provide
 * the same file.
 *
 * Returns { buf, sha1, notes, used } -- or null when nothing usable was
 * given. `notes` is for the server's console: what was left out and why, so a
 * pack that does nothing says so instead of being a mystery.
 */
export function mergePacks(packs) {
  const files = new Map();
  const notes = [];
  const used = [];
  const formats = new Map();

  // Lowest priority first, so the ones above overwrite them.
  for (let i = packs.length - 1; i >= 0; i--) {
    const { name, buf } = packs[i];
    const pack = readPack(buf);
    if (!pack) {
      notes.push(`${name} is not a resource pack (no pack.mcmeta in it), so it was left out.`);
      continue;
    }
    if (pack.prefix) {
      notes.push(`${name} has its files inside a "${pack.prefix.slice(0, -1)}" folder; they were taken out of it.`);
    }
    for (const [entry, data] of pack.files) files.set(entry, data);
    used.unshift(name);
    const fmt = packFormat(pack.files.get("pack.mcmeta"));
    if (fmt != null) formats.set(name, fmt);
  }

  if (!files.size) return null;

  // Packs built for different versions of the game do not stop being merged
  // -- that is the owner's business and sometimes deliberate -- but it is the
  // likeliest reason for a pack that loads with errors, so it is said.
  const distinct = new Set(formats.values());
  if (distinct.size > 1) {
    notes.push("These packs are built for different versions of the game ("
      + [...formats].map(([n, f]) => `${n}: pack_format ${f}`).join(", ")
      + "). The game will complain about whichever does not match it.");
  }

  // Deterministic: sorted names, and one fixed timestamp rather than now.
  // The same packs always merge to the same bytes, so the hash the server
  // hands out only changes when the packs do.
  const out = new AdmZip();
  const FIXED = new Date(Date.UTC(2020, 0, 1, 0, 0, 0));
  for (const entry of [...files.keys()].sort()) {
    out.addFile(entry, files.get(entry));
  }
  for (const e of out.getEntries()) {
    e.header.time = FIXED;
    // Written by a zip library on whatever machine the launcher is on; left
    // as it is, the "made by" and attribute bytes differ between platforms.
    e.attr = 0;
  }
  const buf = out.toBuffer();
  return { buf, sha1: crypto.createHash("sha1").update(buf).digest("hex"), notes, used };
}

export default { mergePacks, readPack, wrapperPrefix, packFormat };
