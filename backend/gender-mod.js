// Wildfire's Female Gender Mod, as seen from outside the game.
//
// An easter egg: when an instance that has the mod in it is running, or ran in
// the last ten minutes, the player renders in the launcher wear what the mod
// is set to in that instance -- the same shape, from the same part of the
// skin, moving the same way. frontend/gender-render.js draws it; this reads
// what the mod saved.
//
// The mod keeps each player's settings in the instance's config folder, one
// file per player, named by their uuid:
//
//   config/FemaleGenderMod/<uuid>.json   (4.x and later)
//   config/WildfireGender/<uuid>.json    (older)
//
// and has written two shapes of file over the years, which it still reads
// both of: nested ("breasts": { "offset": [x, y, z], "size", ... }) and flat
// ("bust_size", "breasts_xOffset", ...). Both are read here, with the mod's
// own defaults and limits for anything missing or out of range.
//
// The mod is https://github.com/FemaleGenderMod/FemaleGenderMod (LGPL-3.0).
// Nothing of it is shipped or run here: its settings file is read, and its
// rendering is reproduced in frontend/gender-render.js.
import fs from "fs";
import path from "path";

export const MOD_ID = "wildfire_gender";
export const CONFIG_DIRS = ["FemaleGenderMod", "WildfireGender"];

const clamp = (v, lo, hi, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
};
const bool = (v, dflt) => (typeof v === "boolean" ? v : dflt);

// The mod's own defaults, from its ConfigKeys.
const DEFAULT_UVS = {
  skin: {
    left: { east: [24, 21, 27, 26], west: [16, 21, 20, 26], down: [20, 17, 24, 21], up: [20, 25, 24, 27], north: [20, 21, 24, 26] },
    right: { east: [28, 21, 32, 26], west: [21, 21, 24, 26], down: [24, 17, 28, 21], up: [24, 25, 28, 27], north: [24, 21, 28, 26] },
  },
  overlay: {
    left: { east: [0, 0, 0, 0], west: [17, 37, 20, 42], down: [20, 34, 24, 37], up: [20, 41, 24, 44], north: [20, 37, 24, 42] },
    right: { east: [28, 37, 31, 42], west: [0, 0, 0, 0], down: [24, 34, 28, 37], up: [24, 41, 28, 44], north: [24, 37, 28, 42] },
  },
};
const DIRECTIONS = ["east", "west", "down", "up", "north"];

/** "female", 0 (the old numbering: FEMALE, MALE, OTHER), and so on. */
function readGender(v) {
  if (typeof v === "number") return ["female", "male", "other"][((v % 3) + 3) % 3];
  const s = String(v || "").toLowerCase();
  return ["female", "male", "other"].includes(s) ? s : "male";
}

/** One face's UVs: [x1, y1, x2, y2] or { x1, y1, x2, y2 }. */
function readQuad(q) {
  if (Array.isArray(q) && q.length === 4 && q.every(n => Number.isFinite(Number(n)))) return q.map(Number);
  if (q && typeof q === "object" && ["x1", "y1", "x2", "y2"].every(k => Number.isFinite(Number(q[k])))) {
    return [Number(q.x1), Number(q.y1), Number(q.x2), Number(q.y2)];
  }
  return undefined;
}

// A layout the file names is used as the file has it: a face it leaves out
// is no face at all, which is what the mod does with it too. A layout the
// file does not name is the default.
function readLayout(saved, dflt) {
  if (!saved || typeof saved !== "object") return { ...dflt };
  const out = {};
  for (const d of DIRECTIONS) {
    const q = readQuad(saved[d]);
    out[d] = q === undefined ? null : q;
  }
  return out;
}

/**
 * A settings file, in whichever shape it was written, as one plain object.
 * Anything missing or out of range is the mod's default, as it would be in
 * the game.
 */
export function readGenderConfig(raw) {
  const j = raw && typeof raw === "object" ? raw : {};
  const nested = j.breasts && typeof j.breasts === "object" ? j.breasts : null;
  const phys = nested && nested.physics && typeof nested.physics === "object" ? nested.physics : null;
  const off = nested && Array.isArray(nested.offset) ? nested.offset : null;

  const breasts = {
    x: clamp(off ? off[0] : j.breasts_xOffset, -1, 1, 0),
    y: clamp(off ? off[1] : j.breasts_yOffset, -1, 1, 0),
    z: clamp(off ? off[2] : j.breasts_zOffset, -1, 0, 0),
    size: clamp(nested ? nested.size : j.bust_size, 0, 0.8, 0.6),
    cleavage: clamp(nested ? nested.cleavage : j.breasts_cleavage, 0, 0.1, 0),
    physics: {
      enabled: bool(phys ? phys.enabled : j.breast_physics, true),
      uniboob: bool(phys ? phys.uniboob : j.breasts_uniboob, true),
      bounce: clamp(phys ? phys.bounce_multiplier : j.bounce_multiplier, 0, 0.5, 0.333),
      floppiness: clamp(phys ? phys.floppiness : j.floppy_multiplier, 0.25, 1, 0.75),
    },
  };

  const uvsNested = j.uvs && typeof j.uvs === "object" ? j.uvs : null;
  const pick = (layer, side, legacyKey) => readLayout(
    uvsNested ? (uvsNested[layer] || {})[side] : j[legacyKey],
    DEFAULT_UVS[layer][side]);
  const uvs = {
    skin: { left: pick("skin", "left", "leftBreastUVLayout"), right: pick("skin", "right", "rightBreastUVLayout") },
    overlay: { left: pick("overlay", "left", "leftBreastOverlayUVLayout"), right: pick("overlay", "right", "rightBreastOverlayUVLayout") },
  };

  const gender = readGender(j.gender);
  return {
    gender,
    // MALE is the one that "cannot have breasts" in the mod; the others can.
    shows: gender !== "male",
    breasts,
    uvs,
    showInArmor: bool(j.show_in_armor, true),
  };
}

const undash = (u) => String(u || "").replace(/-/g, "").toLowerCase();

/**
 * Every player's settings in one instance folder, by uuid without dashes:
 * { uuid: { config, at, file } }. Where both folders have one for the same
 * player, the newer file wins -- it is the one the mod last wrote.
 */
export function readInstanceConfigs(instanceDir) {
  const out = {};
  for (const sub of CONFIG_DIRS) {
    const dir = path.join(instanceDir, "config", sub);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      const m = /^([0-9a-f-]{32,36})\.json$/i.exec(n);
      if (!m) continue;
      const file = path.join(dir, n);
      let at = 0, raw = null;
      try { at = fs.statSync(file).mtimeMs; raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
      const id = undash(m[1]);
      if (out[id] && out[id].at >= at) continue;
      out[id] = { config: readGenderConfig(raw), at, file };
    }
  }
  return out;
}

/** Whether a jar's name says it is the mod, before anything has to be opened. */
export function looksLikeGenderModJar(name) {
  return /\.jar$/i.test(name) && /(female[\s._-]*gender|wildfire[\s._-]*gender|wildfire_gender)/i.test(name);
}

export default { MOD_ID, CONFIG_DIRS, readGenderConfig, readInstanceConfigs, looksLikeGenderModJar };
