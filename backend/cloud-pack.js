// An instance, small enough to keep in a cloud.
//
// A modpack is mostly other people's files. A 400 MB instance is 395 MB of
// mods that are sitting on Modrinth and CurseForge already and 5 MB of the
// part that is actually yours -- the config you tuned, the options you set,
// which mods you turned off. Uploading the lot would be slow, would fill a
// Drive, and would put somebody else's jars in your cloud storage for no
// reason.
//
// So this is a description, not a copy. For every file it asks: can this be
// got again?
//
//   yes, by hash     record the hash and where from. Modrinth answers for a
//                    sha1 and CurseForge for its own fingerprint, so a mod
//                    from either is a line of JSON rather than a megabyte.
//   no, but small    carry the bytes, compressed. Config files, options.txt,
//                    a server list -- the part that is yours.
//   no, and large    record what is known about it and say it was left out,
//                    rather than silently producing a pack that rebuilds
//                    into something different from what was packed.
//
// That last case is the one that matters. An exporter that quietly drops
// what it cannot handle produces a pack that LOOKS complete, and the person
// finds out on another computer, which is the worst possible moment.
//
// This is the same idea as a .mrpack, which also records Modrinth downloads
// and bundles an overrides folder. It is not the same format, because a
// .mrpack cannot say "this one is a CurseForge file" -- and half of what
// people actually have is.
import crypto from "crypto";
import fs from "fs";
import path from "path";
import zlib from "zlib";
import AdmZip from "adm-zip";
import { fingerprintOf } from "./cf-fingerprint.js";

export const PACK_VERSION = 1;

// Folders whose contents are other people's files, worth recording by hash.
export const BY_HASH = ["mods", "resourcepacks", "shaderpacks", "datapacks", "plugins"];
// Folders that are yours, worth carrying.
export const CARRIED = ["config", "defaultconfigs", "kubejs", "scripts", "emotes"];
// Loose files in the instance root that are yours.
export const CARRIED_FILES = ["options.txt", "servers.dat", "optionsof.txt", "optionsshaders.txt"];
// Never: saves are synced separately and on purpose, and the rest is either
// the game itself or this computer's business.
export const NEVER = ["saves", "logs", "crash-reports", "screenshots", "versions",
  "assets", "libraries", "natives", ".fabric", ".mixin.out", "realms-persistence.json"];

/** Anything bigger than this is not carried, only recorded. */
export const CARRY_LIMIT = 1 * 1024 * 1024;
/** And a pack refuses to grow past this, rather than filling somebody's Drive. */
export const PACK_LIMIT = 48 * 1024 * 1024;

const sha1 = (b) => crypto.createHash("sha1").update(b).digest("hex");
const sha512 = (b) => crypto.createHash("sha512").update(b).digest("hex");

/** Every file under `dir`, as paths relative to it, depth first and sorted. */
function walk(dir, base = dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full).split(path.sep).join("/");
    if (e.isDirectory()) walk(full, base, out);
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

const topOf = (rel) => rel.split("/")[0];

/**
 * Describe an instance.
 *
 * `profile` is the launcher's own record of it. `dir` is where its files
 * are. `known(rel, hashes)` may say what a file is -- the launcher has a
 * cache of hash lookups already, and using it saves asking the internet
 * about files it has asked about before.
 */
export function packInstance({ profile, dir, known = () => null }) {
  const pack = {
    pack: PACK_VERSION,
    name: profile.name || "Instance",
    // What the instance IS. Without these the files mean nothing.
    minecraft: profile.version || null,
    loader: profile.loader || "vanilla",
    loaderVersion: profile.loaderVersion || "",
    icon: profile.icon || null,
    at: Date.now(),
    files: [],        // recorded, fetched again on the other side
    carried: [],      // { path, gzip: base64 }
    skipped: [],      // { path, size, why } -- said out loud, never silent
  };

  let carriedBytes = 0;
  for (const rel of walk(dir)) {
    const top = topOf(rel);
    if (NEVER.includes(top)) continue;
    // Anything starting with a dot at the root is a loader's or a tool's
    // working state, not the instance.
    if (top.startsWith(".")) continue;

    const full = path.join(dir, rel);
    let st;
    try { st = fs.statSync(full); } catch { continue; }

    const carryable = CARRIED.includes(top) || (rel === top && CARRIED_FILES.includes(rel));
    const hashable = BY_HASH.includes(top);
    if (!carryable && !hashable) continue;

    if (hashable) {
      const bytes = fs.readFileSync(full);
      const hashes = { sha1: sha1(bytes), sha512: sha512(bytes), fingerprint: fingerprintOf(bytes) };
      const said = known(rel, hashes) || {};
      pack.files.push({
        path: rel, size: st.size, ...hashes,
        // Where it can be got from, if anything knows. Both are optional:
        // the hashes alone are enough to ask Modrinth and CurseForge on the
        // other side, and that is the ordinary case.
        ...(said.url ? { url: said.url } : {}),
        ...(said.modrinth ? { modrinth: said.modrinth } : {}),
        ...(said.curseforge ? { curseforge: said.curseforge } : {}),
        // A mod turned off is part of how the instance is set up.
        ...(rel.endsWith(".disabled") ? { disabled: true } : {}),
      });
      continue;
    }

    if (st.size > CARRY_LIMIT) {
      pack.skipped.push({ path: rel, size: st.size, why: "too big to carry, and not something that can be fetched again" });
      continue;
    }
    if (carriedBytes + st.size > PACK_LIMIT) {
      pack.skipped.push({ path: rel, size: st.size, why: "the pack was already as large as it may get" });
      continue;
    }
    const gz = zlib.gzipSync(fs.readFileSync(full));
    carriedBytes += gz.length;
    pack.carried.push({ path: rel, gzip: gz.toString("base64") });
  }
  return pack;
}

/**
 * How big a pack says it is, and what it leaves out.
 *
 * So the page can say "this instance is 42 mods and 300 KB of config, and
 * three files will not come with it" BEFORE anything is uploaded.
 */
export function describePack(pack) {
  return {
    name: pack.name,
    minecraft: pack.minecraft,
    loader: pack.loader,
    files: pack.files.length,
    carried: pack.carried.length,
    carriedBytes: pack.carried.reduce((n, c) => n + Buffer.from(c.gzip, "base64").length, 0),
    recordedBytes: pack.files.reduce((n, f) => n + (f.size || 0), 0),
    skipped: pack.skipped,
  };
}

/**
 * Build an instance back out of a pack.
 *
 * `fetchFile(entry)` is asked for each recorded file and should resolve to
 * its bytes, or null if it could not be found. Resolving a hash to a
 * download is the launcher's job and not this file's -- it already knows
 * how to ask Modrinth and CurseForge.
 *
 * Nothing is written until every file has been found. A half-built instance
 * that launches and crashes is worse than one that was never built: the
 * first looks like the pack's fault and the second says what is missing.
 */
export async function unpackInstance({ pack, dir, fetchFile, onProgress }) {
  if (!pack || pack.pack !== PACK_VERSION) {
    throw new Error(`This pack was made by a different version (${pack && pack.pack}).`);
  }
  const got = [];
  const missing = [];
  let n = 0;
  for (const entry of pack.files) {
    if (onProgress) onProgress(++n, pack.files.length, entry.path);
    let bytes = null;
    try { bytes = await fetchFile(entry); } catch { bytes = null; }
    if (!bytes) { missing.push(entry); continue; }
    // What came back has to be what was packed. A hash that does not match
    // means somebody's mirror handed over something else, and writing it
    // into a mods folder is how that becomes a problem on launch instead.
    if (entry.sha1 && sha1(bytes) !== entry.sha1) {
      missing.push({ ...entry, why: "what came back was not the file that was packed" });
      continue;
    }
    got.push({ path: entry.path, bytes });
  }
  if (missing.length) {
    return { ok: false, missing, wrote: 0 };
  }

  fs.mkdirSync(dir, { recursive: true });
  const write = (rel, bytes) => {
    const full = path.join(dir, rel);
    // A path out of the pack is untrusted: it decides where bytes land.
    const inside = path.resolve(full);
    if (inside !== path.resolve(dir) && !inside.startsWith(path.resolve(dir) + path.sep)) {
      throw new Error(`This pack tries to write outside the instance (${rel}).`);
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, bytes);
  };
  for (const f of got) write(f.path, f.bytes);
  for (const c of pack.carried) write(c.path, zlib.gunzipSync(Buffer.from(c.gzip, "base64")));

  return {
    ok: true,
    wrote: got.length + pack.carried.length,
    profile: {
      name: pack.name, version: pack.minecraft,
      loader: pack.loader, loaderVersion: pack.loaderVersion,
      icon: pack.icon || null,
    },
    skipped: pack.skipped || [],
  };
}

// ── worlds ────────────────────────────────────────────────────────────────
//
// A world is the other kind of thing entirely: every byte of it is yours and
// none of it can be fetched from anywhere, so all of it goes.
//
// As a real .zip, not as a format of ours. Somebody who wants their world
// back should be able to open the Drive folder, download "My Base.zip" and
// drop it into saves/ -- without this launcher, and without this launcher
// still existing. It is also exactly what the launcher's own "Import .zip"
// already takes, and what every other launcher takes, so a world that has
// been synced is a world that can go anywhere.

/** A world folder, as a zip of it. */
export function packWorld({ dir, name }) {
  const zip = new AdmZip();
  let raw = 0;
  for (const rel of walk(dir)) {
    const bytes = fs.readFileSync(path.join(dir, rel));
    raw += bytes.length;
    // The world's own folder name at the top, which is what a Minecraft
    // world zip looks like and what an importer expects to find.
    zip.addFile(`${name}/${rel}`, bytes);
  }
  return { bytes: zip.toBuffer(), raw, files: walk(dir).length, name };
}

/**
 * A world zip, written out.
 *
 * Takes the launcher's own zips and anybody else's: a world zip in the wild
 * is sometimes the folder (`My Base/level.dat`) and sometimes the contents
 * (`level.dat`), and refusing one of those would make "download it and put
 * it back" fail for no reason a person could act on.
 */
export function unpackWorld({ bytes, dir }) {
  const zip = new AdmZip(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  const entries = zip.getEntries().filter(e => !e.isDirectory);
  if (!entries.length) throw new Error("That zip has nothing in it.");

  // Refused before anything is worked out from the names, not after. A path
  // with a `..` in it would otherwise reach the folder-stripping below,
  // which can turn "../escaped.txt" into "escaped.txt" and quietly put it
  // somewhere harmless -- safe by accident, which is not the same as safe,
  // and not what somebody reading this should have to reason about.
  for (const e of entries) {
    const name = e.entryName.replace(/\\/g, "/");
    if (name.startsWith("/") || /(^|\/)\.\.(\/|$)/.test(name) || /^[a-zA-Z]:/.test(name)) {
      throw new Error(`This world tries to write outside its folder (${e.entryName}).`);
    }
  }

  // If every path starts with the same folder, that folder IS the world and
  // is stripped; otherwise the zip is the world's contents already.
  const tops = new Set(entries.map(e => e.entryName.split("/")[0]));
  const strip = tops.size === 1 && entries.some(e => e.entryName.includes("/"))
    ? [...tops][0] + "/" : "";

  fs.mkdirSync(dir, { recursive: true });
  const root = path.resolve(dir);
  let wrote = 0;
  for (const e of entries) {
    const rel = strip && e.entryName.startsWith(strip) ? e.entryName.slice(strip.length) : e.entryName;
    if (!rel) continue;
    // A path out of a zip decides where bytes land, and a zip can come from
    // anywhere -- including a Drive folder somebody else can write to.
    const full = path.resolve(path.join(dir, rel));
    if (full !== root && !full.startsWith(root + path.sep)) {
      throw new Error(`This world tries to write outside its folder (${e.entryName}).`);
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, e.getData());
    wrote++;
  }
  return { ok: true, wrote };
}

export default {
  PACK_VERSION, BY_HASH, CARRIED, CARRIED_FILES, NEVER, CARRY_LIMIT, PACK_LIMIT,
  packInstance, unpackInstance, describePack, packWorld, unpackWorld,
};
