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
    w.files.map(f => f.path).sort(), ["level.dat", "playerdata/uuid.dat", "region/r.0.0.mca"]);
  const size = w.files.reduce((n, f) => n + Buffer.from(f.gzip, "base64").length, 0);
  check("and it is compressed, because a region file is mostly air",
    size < w.raw / 4, true, `${w.raw} bytes down to ${size}`);

  const to = fs.mkdtempSync(path.join(os.tmpdir(), "world-"));
  pack.unpackWorld({ world: w, dir: to });
  check("and it comes back exactly",
    [fs.readFileSync(path.join(to, "level.dat"), "utf8"),
      fs.readFileSync(path.join(to, "region/r.0.0.mca")).length],
    ["LEVEL", 40000]);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(to, { recursive: true, force: true });
}
{
  const to = fs.mkdtempSync(path.join(os.tmpdir(), "world-"));
  check("and a world cannot write outside its folder either",
    /writes? outside its folder/.test(await threw(() => pack.unpackWorld({
      world: { pack: pack.PACK_VERSION, kind: "world", files: [{ path: "../escaped", gzip: zlib.gzipSync(Buffer.from("x")).toString("base64") }] },
      dir: to,
    })) || ""), true);
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
