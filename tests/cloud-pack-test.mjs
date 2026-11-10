// An instance, small enough to keep in a cloud.
//
// A 400 MB instance is 395 MB of other people's mods, sitting on Modrinth
// and CurseForge already, and 5 MB of the part that is actually yours. So a
// pack is a description rather than a copy, and what is checked here is that
// the description is honest:
//
//   a mod is recorded and not carried, so the pack stays small;
//   the config IS carried, because nobody else has a copy of it;
//   anything that can be neither is SAID, not quietly dropped -- an exporter
//   that silently loses what it cannot handle makes a pack that looks
//   complete and fails on the other computer, which is the worst moment;
//   and nothing is written anywhere until everything has been found.
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import zlib from "zlib";
import AdmZip from "adm-zip";
import pack from "../backend/cloud-pack.js";
import { fingerprintOf } from "../backend/cf-fingerprint.js";

let bad = 0;
const ok = (what, note) => console.log(`ok   ${what}${note ? "  — " + note : ""}`);
const fail = (what, why) => { bad++; console.log(`FAIL ${what}\n       ${why}`); };
const check = (what, got, want, note) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) ok(what, note); else fail(what, `got  ${a}\n       want ${b}`);
};
const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };
const sha1 = (b) => crypto.createHash("sha1").update(b).digest("hex");

function instance(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inst-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, Buffer.isBuffer(body) ? body : Buffer.from(body));
  }
  return dir;
}

const PROFILE = { name: "1.21 Fabric", version: "1.21", loader: "fabric", loaderVersion: "0.16.5" };

// ── what goes where ──
{
  const dir = instance({
    "mods/sodium.jar": "SODIUM-JAR-BYTES",
    "mods/lithium.jar.disabled": "LITHIUM",
    "resourcepacks/faithful.zip": "PACK",
    "config/sodium-options.json": '{"quality":"high"}',
    "options.txt": "fov:90",
    "saves/My Base/level.dat": "A WHOLE WORLD",
    "logs/latest.log": "noise",
    "crash-reports/crash.txt": "noise",
    ".fabric/cache": "noise",
    "versions/1.21/1.21.jar": "THE GAME ITSELF",
  });
  const p = pack.packInstance({ profile: PROFILE, dir });

  check("mods and packs are recorded rather than carried",
    p.files.map(f => f.path).sort(),
    ["mods/lithium.jar.disabled", "mods/sodium.jar", "resourcepacks/faithful.zip"]);
  check("and the bytes of them are nowhere in the pack",
    JSON.stringify(p).includes(Buffer.from("SODIUM-JAR-BYTES").toString("base64")), false,
    "the whole point: somebody else's jars do not belong in your cloud storage");

  check("the part that is yours is carried",
    p.carried.map(c => c.path).sort(), ["config/sodium-options.json", "options.txt"]);

  check("the game itself, the logs and the noise are left out",
    p.files.concat(p.carried).some(f => /versions|logs|crash-reports|\.fabric/.test(f.path)), false);
  check("and so are the worlds, which are synced separately and on purpose",
    JSON.stringify(p).includes("A WHOLE WORLD"), false);

  check("a mod that is turned off is recorded as turned off",
    p.files.find(f => f.path.endsWith(".disabled")).disabled, true,
    "which mods you turned off is part of how the instance is set up");

  check("what the instance IS travels with it",
    [p.minecraft, p.loader, p.loaderVersion], ["1.21", "fabric", "0.16.5"],
    "without these the files mean nothing");

  // Every way of naming a file, so the other side can find it whichever
  // provider it came from.
  const sodium = p.files.find(f => f.path === "mods/sodium.jar");
  check("each recorded file carries every handle there is on it",
    [sodium.sha1, sodium.sha512.length, typeof sodium.fingerprint, sodium.size],
    [sha1(Buffer.from("SODIUM-JAR-BYTES")), 128, "number", 16],
    "Modrinth answers for a sha1 and CurseForge only for its own fingerprint");
  check("and the fingerprint is CurseForge's own",
    sodium.fingerprint, fingerprintOf(Buffer.from("SODIUM-JAR-BYTES")));
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── what the launcher already knows ──
{
  const dir = instance({ "mods/sodium.jar": "S" });
  const p = pack.packInstance({
    profile: PROFILE, dir,
    known: (rel, h) => (rel === "mods/sodium.jar"
      ? { modrinth: { project: "AANobbMI", version: "abc" }, url: "https://cdn.modrinth.com/x.jar" }
      : null),
  });
  check("where a file came from is recorded when anything knows",
    [p.files[0].modrinth.project, p.files[0].url],
    ["AANobbMI", "https://cdn.modrinth.com/x.jar"],
    "so the other side does not have to ask the internet about files this one already asked about");
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── what cannot go, said out loud ──
{
  const dir = instance({
    "config/huge.dat": Buffer.alloc(pack.CARRY_LIMIT + 1, 1),
    "config/small.json": "{}",
  });
  const p = pack.packInstance({ profile: PROFILE, dir });
  check("something too big to carry and impossible to fetch is reported",
    p.skipped.map(s => s.path), ["config/huge.dat"],
    "an exporter that quietly drops what it cannot handle makes a pack that looks complete");
  check("and it says why", /too big to carry/.test(p.skipped[0].why), true);
  check("while the rest still goes", p.carried.map(c => c.path), ["config/small.json"]);
  fs.rmSync(dir, { recursive: true, force: true });
}
{
  // And a pack refuses to grow without limit rather than filling a Drive.
  const files = {};
  for (let i = 0; i < 80; i++) files[`config/f${i}.bin`] = crypto.randomBytes(900 * 1024);
  const dir = instance(files);
  const p = pack.packInstance({ profile: PROFILE, dir });
  const size = p.carried.reduce((n, c) => n + Buffer.from(c.gzip, "base64").length, 0);
  check("a pack stops at its limit rather than filling somebody's Drive",
    [size <= pack.PACK_LIMIT, p.skipped.length > 0], [true, true],
    `${Math.round(size / 1048576)} MB carried, ${p.skipped.length} left out and listed`);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── and back again ──
{
  const dir = instance({
    "mods/sodium.jar": "SODIUM-JAR-BYTES",
    "config/sodium-options.json": '{"quality":"high"}',
    "options.txt": "fov:90",
  });
  const p = pack.packInstance({ profile: PROFILE, dir });
  fs.rmSync(dir, { recursive: true, force: true });

  const to = fs.mkdtempSync(path.join(os.tmpdir(), "out-"));
  const r = await pack.unpackInstance({
    pack: p, dir: to,
    fetchFile: async (e) => (e.path === "mods/sodium.jar" ? Buffer.from("SODIUM-JAR-BYTES") : null),
  });
  check("an instance comes back", [r.ok, r.wrote], [true, 3]);
  check("the mod is there, fetched again",
    fs.readFileSync(path.join(to, "mods/sodium.jar"), "utf8"), "SODIUM-JAR-BYTES");
  check("and the config, carried",
    fs.readFileSync(path.join(to, "config/sodium-options.json"), "utf8"), '{"quality":"high"}');
  check("with the instance's own details",
    [r.profile.version, r.profile.loader], ["1.21", "fabric"]);
  fs.rmSync(to, { recursive: true, force: true });
}

// ── nothing is written until everything is found ──
{
  const dir = instance({ "mods/a.jar": "A", "mods/b.jar": "B", "config/c.json": "{}" });
  const p = pack.packInstance({ profile: PROFILE, dir });
  fs.rmSync(dir, { recursive: true, force: true });

  const to = fs.mkdtempSync(path.join(os.tmpdir(), "out-"));
  const r = await pack.unpackInstance({
    pack: p, dir: to,
    fetchFile: async (e) => (e.path === "mods/a.jar" ? Buffer.from("A") : null),
  });
  check("a mod that cannot be found stops the whole thing",
    [r.ok, r.missing.map(m => m.path)], [false, ["mods/b.jar"]]);
  check("and NOTHING was written",
    fs.existsSync(path.join(to, "mods/a.jar")) || fs.existsSync(path.join(to, "config/c.json")), false,
    "a half-built instance that launches and crashes looks like the pack's fault; one that was never built says what is missing");
  fs.rmSync(to, { recursive: true, force: true });
}
{
  // Something else handed back under the right name.
  const dir = instance({ "mods/a.jar": "THE REAL ONE" });
  const p = pack.packInstance({ profile: PROFILE, dir });
  fs.rmSync(dir, { recursive: true, force: true });
  const to = fs.mkdtempSync(path.join(os.tmpdir(), "out-"));
  const r = await pack.unpackInstance({
    pack: p, dir: to, fetchFile: async () => Buffer.from("SOMETHING ELSE ENTIRELY"),
  });
  check("a file that is not what was packed is refused",
    [r.ok, /not the file that was packed/.test(r.missing[0].why || "")], [false, true],
    "a mirror handing over something else must not become a problem on launch");
  fs.rmSync(to, { recursive: true, force: true });
}

// ── a pack cannot write outside the instance ──
{
  const evil = {
    pack: pack.PACK_VERSION, name: "x", minecraft: "1.21", loader: "vanilla",
    files: [], skipped: [],
    carried: [{ path: "../../../../tmp/escaped.txt", gzip: zlib.gzipSync(Buffer.from("got out")).toString("base64") }],
  };
  const to = fs.mkdtempSync(path.join(os.tmpdir(), "out-"));
  check("a pack that tries to write outside the instance is refused",
    /writes? outside the instance/.test(await threw(() => pack.unpackInstance({ pack: evil, dir: to, fetchFile: async () => null })) || ""),
    true,
    "the paths in a pack decide where bytes land, and a pack can come from anywhere");
  fs.rmSync(to, { recursive: true, force: true });
}

// ── worlds, which are the other kind of thing entirely ──
{
  const dir = instance({
    "level.dat": "LEVEL",
    "region/r.0.0.mca": Buffer.alloc(40000, 0),
    "playerdata/uuid.dat": "PLAYER",
  });
  const w = pack.packWorld({ dir, name: "My Base" });
  check("every byte of a world goes, because none of it can be fetched",
    [w.files, w.bytes.subarray(0, 2).toString("latin1")], [3, "PK"],
    "and as a REAL zip, so it can be downloaded from the Drive and used by hand");
  check("it is compressed, because a region file is mostly air",
    w.bytes.length < w.raw / 4, true, `${w.raw} bytes down to ${w.bytes.length}`);

  const names = new AdmZip(w.bytes).getEntries().map(e => e.entryName).sort();
  check("with the world's own folder at the top, as a world zip has",
    names, ["My Base/level.dat", "My Base/playerdata/uuid.dat", "My Base/region/r.0.0.mca"],
    "which is what every launcher's import expects to find");

  const to = fs.mkdtempSync(path.join(os.tmpdir(), "world-"));
  pack.unpackWorld({ bytes: w.bytes, dir: to });
  check("and it comes back exactly",
    [fs.readFileSync(path.join(to, "level.dat"), "utf8"),
      fs.readFileSync(path.join(to, "region/r.0.0.mca")).length],
    ["LEVEL", 40000]);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(to, { recursive: true, force: true });
}
{
  // A world zip in the wild is sometimes the folder and sometimes the
  // contents. Refusing one of those would make "download it and put it
  // back" fail for no reason a person could act on.
  const flat = new AdmZip();
  flat.addFile("level.dat", Buffer.from("LEVEL"));
  flat.addFile("region/r.0.0.mca", Buffer.from("REGION"));
  const to = fs.mkdtempSync(path.join(os.tmpdir(), "world-"));
  pack.unpackWorld({ bytes: flat.toBuffer(), dir: to });
  check("a zip of the contents rather than the folder works too",
    fs.readFileSync(path.join(to, "level.dat"), "utf8"), "LEVEL");
  fs.rmSync(to, { recursive: true, force: true });
}
{
  // A zip with a path that climbs out of the folder. Built byte by byte,
  // because AdmZip quietly strips "../" when it WRITES one -- so a zip made
  // with it could never carry the attack, and a test that used one would be
  // testing the library rather than this code. An attacker writes the bytes.
  const storedZip = (name, body) => {
    const n = Buffer.from(name), d = Buffer.from(body);
    const crcTable = [...Array(256)].map((_, i) => {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      return c >>> 0;
    });
    let crc = 0xFFFFFFFF;
    for (const b of d) crc = crcTable[(crc ^ b) & 0xFF] ^ (crc >>> 8);
    crc = (crc ^ 0xFFFFFFFF) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(d.length, 18);
    local.writeUInt32LE(d.length, 22); local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(d.length, 20);
    central.writeUInt32LE(d.length, 24); central.writeUInt16LE(n.length, 28);
    const head = Buffer.concat([local, n, d]);
    const dir = Buffer.concat([central, n]);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
    end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(head.length, 16);
    return Buffer.concat([head, dir, end]);
  };

  const to = fs.mkdtempSync(path.join(os.tmpdir(), "world-"));
  for (const name of ["../escaped.txt", "a/../../escaped.txt", "/etc/escaped.txt", "..\\escaped.txt"]) {
    check(`a world zip holding ${JSON.stringify(name)} is refused`,
      /writes? outside its folder/.test(await threw(() => pack.unpackWorld({
        bytes: storedZip(name, "got out"), dir: to,
      })) || ""), true,
      "a zip can come from anywhere, including a Drive folder somebody else can write to");
  }
  check("and nothing was written when one was",
    fs.readdirSync(to), []);
  fs.rmSync(to, { recursive: true, force: true });
}

// ── what the page can say before anything is uploaded ──
{
  const dir = instance({ "mods/a.jar": "A".repeat(5000), "config/c.json": "{}", "config/big.dat": Buffer.alloc(pack.CARRY_LIMIT + 1) });
  const d = pack.describePack(pack.packInstance({ profile: PROFILE, dir }));
  check("a pack can be described before it is sent",
    [d.files, d.carried, d.recordedBytes, d.skipped.length], [1, 1, 5000, 1],
    "so the page can say what will and will not come with it");
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
