// Taking animations out of a Blockbench rig, a few at a time.
//
// One rig cannot always be the right one for every animation: a wave wants
// the arm's pivot at the shoulder and a lean wants it at the waist, which is
// two models of the same player. So the converter does not only turn a whole
// file into the launcher's clips and replace what was there -- it can be
// asked for particular animations out of a particular rig, and add them to
// what is already there, so a set can be built up out of several models.
//
// Run against the real tool, on real .bbmodel files written here.
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOOL = path.join(ROOT, "bbmodelconvert.js");

let bad = 0;
const fail = (what, why) => { bad++; console.log(`FAIL ${what}\n       ${why}`); };
const ok = (what, note) => console.log(`ok   ${what}${note ? "  — " + note : ""}`);
const check = (what, got, want, note) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) ok(what, note); else fail(what, `got  ${a}\n       want ${b}`);
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "rl-bb-"));
const OUT = path.join(TMP, "skin-clips.json");

/** A .bbmodel with the named animations in it, each moving one arm. */
function rig(file, names, { pivot = [0, 0, 0] } = {}) {
  const model = {
    meta: { format_version: "4.5", model_format: "free" },
    groups: [{ name: "rightArm", uuid: "arm-uuid", origin: pivot, children: [] }],
    animations: names.map((name, i) => ({
      uuid: `anim-${i}`,
      name,
      loop: "once",
      length: 1 + i,
      animators: {
        "arm-uuid": {
          name: "rightArm",
          keyframes: [
            { channel: "rotation", time: 0, interpolation: "linear", data_points: [{ x: 0, y: 0, z: 0 }] },
            { channel: "rotation", time: 0.5, interpolation: "linear", data_points: [{ x: 45 + i, y: 0, z: pivot[1] }] },
          ],
        },
      },
    })),
  };
  const at = path.join(TMP, file);
  fs.writeFileSync(at, JSON.stringify(model));
  return at;
}

const run = (...args) => {
  try {
    return { out: execFileSync(process.execPath, [TOOL, ...args], { encoding: "utf8", cwd: TMP }), code: 0 };
  } catch (e) {
    return { out: String(e.stdout || "") + String(e.stderr || ""), code: e.status == null ? 1 : e.status };
  }
};
const read = () => JSON.parse(fs.readFileSync(OUT, "utf8"));

const shoulder = rig("shoulder.bbmodel", ["wave", "point", "animation.idle"], { pivot: [-5, 22, 0] });
const waist = rig("waist.bbmodel", ["wave", "lean"], { pivot: [0, 12, 0] });

// ── saying what is in one ──
{
  const r = run("--list", shoulder);
  check("--list says what is in a rig and writes nothing",
    [/wave/.test(r.out), /point/.test(r.out), fs.existsSync(OUT)], [true, true, false]);
  check("and the namespace is off the names, so they are what you would type",
    /\bidle\b/.test(r.out) && !/animation\.idle/.test(r.out), true,
    "Blockbench calls it animation.idle; the launcher calls it idle");
}

// ── a few of them, kept ──
{
  const r = run("export", shoulder, "wave", "-o", OUT);
  check("export takes just the one asked for", r.code, 0, r.out.trim().split("\n").pop());
  check("and only that one is in the file", Object.keys(read().clips), ["wave"]);

  run("export", shoulder, "point", "-o", OUT);
  check("a second export adds to it rather than replacing it",
    Object.keys(read().clips).sort(), ["point", "wave"],
    "which is the whole point: a set built up out of several rigs");
}

// ── the same animation out of a different rig ──
{
  const before = read().clips.wave;
  run("export", waist, "wave=wave_low", "-o", OUT);
  const now = read();
  check("the same name can be taken from another rig under a new name",
    Object.keys(now.clips).sort(), ["point", "wave", "wave_low"]);
  check("and the first one is untouched",
    JSON.stringify(now.clips.wave), JSON.stringify(before),
    "a rig with its pivots moved for one animation must not disturb the others");
  check("each clip says which rig it came from",
    [now.sources.wave.file, now.sources.wave_low.file, now.sources.wave_low.animation],
    ["shoulder.bbmodel", "waist.bbmodel", "wave"]);

  // Without renaming, the same name replaces -- which is how a clip is
  // re-exported after the rig has been fixed.
  run("export", waist, "wave", "-o", OUT);
  check("and without a new name it replaces the one that was there",
    read().sources.wave.file, "waist.bbmodel");
}

// ── taking one back out ──
{
  run("remove", "point", "-o", OUT);
  const now = read();
  check("remove takes a clip out", Object.keys(now.clips).sort(), ["wave", "wave_low"]);
  check("and forgets where it came from", now.sources.point, undefined);
}

// ── asking for something that is not there ──
{
  const r = run("export", shoulder, "backflip", "-o", OUT);
  check("asking for an animation a rig does not have is an error, and says what it has",
    [r.code !== 0, /backflip/.test(r.out), /wave/.test(r.out)], [true, true, true]);
  check("and nothing is written", Object.keys(read().clips).sort(), ["wave", "wave_low"],
    "a mistyped name must not empty the file");
}

// ── handedness travels with the clip ──
//
// One rig may be authored the Bedrock way and the next not, so a set built
// out of several cannot have one answer for all of them.
{
  run("export", shoulder, "point", "-o", OUT);
  run("export", waist, "lean", "--flip", "-o", OUT);
  const now = read();
  check("each clip records how its rig was authored",
    [now.clips.point.flipYZ, now.clips.lean.flipYZ], [false, true]);
  check("and the renderer reads it per clip",
    /flipFor\(clip\)/.test(fs.readFileSync(path.join(ROOT, "frontend/skin-animations.js"), "utf8")), true);
}

// ── the whole file, which is what the plain command does ──
{
  const all = path.join(TMP, "all.json");
  const r = run(shoulder, "-o", all);
  check("naming a rig and nothing else converts all of it", r.code, 0);
  check("and replaces what was there",
    Object.keys(JSON.parse(fs.readFileSync(all, "utf8")).clips).sort(), ["idle", "point", "wave"]);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
