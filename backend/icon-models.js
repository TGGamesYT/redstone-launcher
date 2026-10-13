/**
 * The block, item and entity models an instance can offer as an icon.
 *
 * This is the plumbing between the readers — model-assets.js for blocks and
 * items, entity-models.js for entities, version-icons.js for "which block
 * stands for this version" — and the picker in the renderer that draws them.
 * It owns one thing of its own: where the assets come from.
 *
 * Sources stack the way the game stacks them, so a pack or a mod that replaces
 * a model wins:
 *
 *   enabled resource packs (in their own order) > other packs > mods > the jar
 *
 * The jar is whichever copy is cheapest: one an instance already downloaded,
 * then the one the default-skins build keeps, and only then the CDN, read with
 * range requests so a model costs a few hundred kilobytes rather than 30 MB.
 *
 * Textures come from the same stack, except below 1.14, where the 1.13 jar
 * supplies them — one download giving every old version the pre-1.14 art, with
 * the version's own jar behind it for anything 1.13 renamed.
 */
import fs from 'fs';
import path from 'path';
import * as MA from './model-assets.js';
import * as VI from './version-icons.js';
import { EntityModels } from './entity-models.js';
import { parseMappings, identityMappings } from './mc-mappings.js';

const fsp = fs.promises;

// The jar whose textures every pre-1.14 version borrows.
const LEGACY_TEXTURE_VERSION = '1.13.2';
const FLATTENING = '1.14';          // where textures/blocks became textures/block
// A stack is a few megabytes of index; a handful is plenty.
const STACK_CACHE_MAX = 6;
const STACK_TTL = 10 * 60 * 1000;

let DEPS = null;
export function configure(deps) {
  DEPS = deps;
  MA.configure({ dataDir: deps.dataDir, log: deps.log, recolor: deps.recolor });
  VI.configure({ dataDir: deps.dataDir, log: deps.log });
}
const log = (...a) => { try { DEPS.log(...a); } catch { } };

// ── Where a jar can be found ────────────────────────────────────────────────
const _jarSources = new Map();
export async function jarSource(version) {
  const v = String(version || '').trim();
  if (!v) return null;
  if (_jarSources.has(v)) return _jarSources.get(v);
  const p = (async () => {
    // 1. A copy an instance already downloaded.
    try {
      const local = DEPS.findClientJar(v);
      if (local) return await MA.zipSource(`${v} jar`, 'jar', local);
    } catch { /* keep looking */ }
    // 2. The one kept when the default skins were built.
    try {
      const cached = MA.cachedJarPath(v);
      if (fs.existsSync(cached)) return await MA.zipSource(`${v} jar`, 'jar', cached);
    } catch { /* keep looking */ }
    // 3. Mojang's, read in place.
    try {
      const manifest = await VI.manifestIndex();
      const meta = manifest.by.get(v);
      if (!meta) return null;
      const vj = await (await fetch(meta.url)).json();
      const url = vj && vj.downloads && vj.downloads.client && vj.downloads.client.url;
      if (!url) return null;
      return await MA.remoteZipSource(`${v} jar`, 'jar', url);
    } catch (err) {
      log(`icon models: no jar for ${v}: ${err && err.message}`);
      return null;
    }
  })();
  _jarSources.set(v, p);
  return p;
}

// ── An instance's own packs and mods ────────────────────────────────────────
async function instanceSources(profileId) {
  if (profileId == null) return [];
  const root = DEPS.instanceRoot(profileId);
  const out = [];
  const list = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } };

  const enabled = new Set((DEPS.enabledResourcePacks(profileId) || [])
    .map(p => String(p).replace(/^file\//, '')));
  const packsDir = path.join(root, 'resourcepacks');
  const packs = [];
  for (const e of list(packsDir)) {
    const full = path.join(packsDir, e.name);
    if (e.isDirectory()) packs.push({ full, name: e.name, dir: true, on: enabled.has(e.name) });
    else if (/\.zip$/i.test(e.name)) packs.push({ full, name: e.name, dir: false, on: enabled.has(e.name) });
  }
  // Enabled first: that is the pack the game is actually drawing with.
  packs.sort((a, b) => (a.on === b.on ? 0 : a.on ? -1 : 1));
  for (const p of packs) {
    const s = p.dir ? MA.dirSource(p.name, 'pack', p.full) : await MA.zipSource(p.name, 'pack', p.full);
    if (s) out.push(s);
  }
  for (const e of list(path.join(root, 'mods'))) {
    if (!e.isFile() || !/\.jar$/i.test(e.name)) continue;   // .disabled skipped
    const s = await MA.zipSource(e.name, 'mod', path.join(root, 'mods', e.name));
    if (s) out.push(s);
  }
  return out;
}

// ── The stack for an instance (or for a bare version) ───────────────────────
// `overrides` decides whether this instance's packs and mods are allowed to
// REPLACE what the jar has.
//
// With them in front, which is how the game draws, a resource pack's stone is
// the stone you see. That is right for an icon of the instance, and wrong for
// an icon of the game: somebody picking a block out of the catalogue mostly
// means the block, not whatever the pack they installed last week did to it.
// So it is a switch, off by default, and with it off the jar goes FIRST --
// the packs and the mods are still there, behind it, so a modded block is
// still found and still drawn with the mod's own textures. Only the things
// vanilla also has stop being overridden.
const _stacks = new Map();
export async function stackFor({ profileId = null, version, overrides = true } = {}) {
  const key = `${profileId == null ? '-' : profileId}|${version || '-'}|${overrides ? 'o' : '-'}`;
  const hit = _stacks.get(key);
  if (hit && Date.now() - hit.at < STACK_TTL) return hit.value;

  const value = await (async () => {
    const jar = await jarSource(version);
    const own = await instanceSources(profileId);
    const sources = (overrides ? [...own, jar] : [jar, ...own]).filter(Boolean);
    if (!sources.length) return null;
    const models = MA.makeStack(sources);

    // Pre-1.14 reads its textures out of the 1.13 jar, with the version's own
    // behind it for anything 1.13 renamed. Both are aliased so a model asking
    // for "blocks/stone" finds "block/stone".
    let textures = models;
    if (version && !atLeast(version, FLATTENING)) {
      const legacy = await jarSource(LEGACY_TEXTURE_VERSION);
      const borrowed = [MA.legacyTextureAlias(legacy), MA.legacyTextureAlias(jar)];
      textures = MA.makeStack((overrides ? [...own, ...borrowed] : [...borrowed, ...own]).filter(Boolean));
    }
    return { models, textures, index: MA.indexStack(models), version, profileId, overrides };
  })();

  if (_stacks.size >= STACK_CACHE_MAX) _stacks.delete(_stacks.keys().next().value);
  _stacks.set(key, { at: Date.now(), value });
  return value;
}
export function dropStacks() { _stacks.clear(); _jarSources.clear(); _entities.clear(); }

const atLeast = (v, target) => VI.compareVersions(v, target) >= 0;

// ── Entities ────────────────────────────────────────────────────────────────
const _entities = new Map();
async function entityModelsFor(version) {
  if (_entities.has(version)) return _entities.get(version);
  const p = (async () => {
    const jar = await jarSource(version);
    if (!jar) return null;
    const names = jar.list();
    let maps;
    if (names.some(n => n.startsWith('net/minecraft/client/model/'))) {
      // 26.1 and later ship the client deobfuscated; there is nothing to map.
      maps = identityMappings(names);
    } else {
      const text = await mappingsText(version);
      if (!text) return null;
      maps = parseMappings(text);
    }
    const em = new EntityModels({ stack: MA.makeStack([jar]), maps, log });
    return { em, jar };
  })();
  _entities.set(version, p);
  return p;
}

async function mappingsText(version) {
  const file = path.join(DEPS.dataDir, 'cache', 'mappings', `${String(version).replace(/[^\w.\-]/g, '_')}.txt`);
  try { return await fsp.readFile(file, 'utf8'); } catch { /* fetch it */ }
  try {
    const manifest = await VI.manifestIndex();
    const meta = manifest.by.get(version);
    if (!meta) return null;
    const vj = await (await fetch(meta.url)).json();
    const url = vj?.downloads?.client_mappings?.url;
    if (!url) return null;
    const text = await (await fetch(url)).text();
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, text);
    } catch { /* the cache is a bonus */ }
    return text;
  } catch (err) {
    log(`icon models: no mappings for ${version}: ${err && err.message}`);
    return null;
  }
}

// ── What the renderer needs to draw something ───────────────────────────────
async function textureSpecs(stack, flat, measure) {
  return MA.resolveModelTextures(stack, flat, { measure });
}

// The blockstate an id belongs to. A bare id -- "minecraft:anvil" -- is one
// already. A path that names the block folder outright, "block/dried_ghast",
// looks like a model and is one, but the model is only the template the
// blockstate's variants fill in: its textures are all `#north`, and which
// picture `#north` is depends on the state. Where a blockstate goes by that
// name it IS the block, and that is what carries the textures, the turn and
// the states. The leftovers that are only ever a piece of something --
// block/oak_stairs_inner, block/cube_all -- have no blockstate of their own,
// so the lookup comes back empty and they stay the models they are.
const blockIdOf = (id) => {
  const { ns, name } = MA.splitId(id);
  return /(^|\/)block\//.test(`/${name}`) ? `${ns}:${name.replace(/^.*\bblock\//, '')}` : id;
};

/** A block or item model, ready to render. */
export async function describeModel({ profileId, version, id, state, variant, overrides }) {
  const st = await stackFor({ profileId, version, overrides });
  if (!st) return { error: 'no assets for this version yet' };

  let modelId = id, rotX = 0, rotY = 0, uvlock = false, chosen = null;
  let itemVariants = null, layerTints = null;
  const { ns, name } = MA.splitId(id);
  const explicitItem = /(^|:)items?\//.test(id) || /\/items?\//.test(id);
  // A path that names the block folder outright is a model, not a blockstate.
  const blockPath = /(^|:)block\//.test(id) || /\/block\//.test(id);
  const stateId = blockIdOf(id);

  // A bare id -- "minecraft:anvil" -- is a BLOCK, through its blockstate.
  // That is how the catalogue lists blocks; an item is listed with `item/` in
  // its id. The item definition used to be consulted first for any name
  // without a folder, and almost every block is also an item, so almost every
  // block was quietly handed its ITEM's model and none of its states. That is
  // why an anvil's facing, a creaking heart's state and an icicle's size did
  // nothing: the states were listed, the choice was passed in, and nothing
  // ever looked at it.
  const states = explicitItem ? null : await MA.blockStates(st.models, stateId);
  if (states && states.length) {
    const pick = state != null
      ? (states.find(s => s.state === state) || await MA.chooseState(st.models, states))
      : await MA.chooseState(st.models, states);
    chosen = pick;
    modelId = pick.parts[0].model;
    rotX = pick.parts[0].x || 0;
    rotY = pick.parts[0].y || 0;
    uvlock = !!pick.parts[0].uvlock;
  } else if (!blockPath) {
    // No blockstate, so it is an item -- and an item is a definition file
    // before it is a model: one clock is twelve models and one chestplate is
    // itself plus a trim for every material. The definition says which, and
    // all of them are offered.
    const bare = name.replace(/^items?\//, '');
    const def = await st.models.json(MA.itemDefPath(`${ns}:${bare}`));
    const all = def ? MA.modelsFromItemDef(def) : [];
    if (all.length) {
      itemVariants = all;
      const want = variant && all.find(v => v.model === variant);
      modelId = (want || all[0]).model;
      layerTints = (want || all[0]).tints || null;
    }
  }

  const flat = await MA.renderableModel(st.models, modelId);

  // A block the game draws with Java rather than with a model -- a chest, a
  // bell, a mob head -- has nothing in the assets but a particle texture, and
  // came out as a plain cube of it. The shape IS in the game, though: those
  // blocks are drawn by the same code that draws entities, and their models
  // are in the layer list beside the mobs'. So before settling for a cube,
  // look for the layer this block is drawn with.
  // ...or barely anything: a bell's model is the two-by-three nub it hangs
  // from, and the bell itself is drawn by the game. Where the model is a
  // fraction of a block and an entity layer exists, the entity IS the block.
  if (flat.approximated || flat.kind === 'unrenderable' || tinyModel(flat)) {
    const asEntity = await blockEntityModel({
      profileId, version, id: stateId, state: chosen ? chosen.state : state, variant, overrides,
    });
    if (asEntity) return asEntity;
  }

  // Two blocks that are one thing: a door, a tall flower, a bed. The game
  // keeps them as two block states, a lower and an upper, and drawing the
  // lower one on its own gives half a door. Where the chosen state names a
  // half, the other half is drawn above it.
  if (chosen && chosen.state) {
    const tall = await tallSibling(st, stateId, chosen);
    if (tall) {
      return {
        ...tall,
        approximated: false,
        model: modelId,
        state: chosen.state,
        rotX: 0, rotY: 0, uvlock: false,
        tint: await tintFor(st.textures, id),
        tintAll: false,
      };
    }
  }

  // More than one model in one block: a multipart blockstate, where a
  // mushroom block is six separate faces and a wall is a post plus its arms.
  // Each piece has its own turn, so the turns are baked into the pieces
  // rather than applied to the lot.
  if (chosen && chosen.parts && chosen.parts.length > 1) {
    const merged = await mergeParts(st, chosen.parts);
    if (merged) {
      return {
        ...merged,
        approximated: false,
        model: modelId,
        state: chosen.state || null,
        rotX: 0, rotY: 0, uvlock: false,
        tint: await tintFor(st.textures, id),
        tintAll: false,
      };
    }
  }

  if (flat.kind === 'unrenderable') return { error: `${modelId} has no geometry` };
  const withTex = await textureSpecs(st.textures, flat, DEPS.measureSaturation);

  return {
    kind: withTex.kind,
    elements: withTex.elements || null,
    layers: withTex.layers || null,
    textures: withTex.textures,
    approximated: !!withTex.approximated,
    model: modelId,
    state: chosen ? chosen.state : null,
    rotX, rotY, uvlock,
    // The other things this item can be: every trim on a chestplate, every
    // hand position on a clock.
    variants: itemVariants && itemVariants.length > 1
      ? itemVariants.map(v => ({ path: v.model, label: v.label || 'plain' }))
      : null,
    variantOf: itemVariants ? modelId : null,
    // The colour the game would paint the tinted faces, for this block.
    tint: await tintFor(st.textures, id),
    // ...and, for a flat item, one colour per layer, from its definition.
    layerTints,
    // Water has no model at all -- it is drawn by the fluid renderer, and all
    // that is in the jar is a particle texture. What stands in for it here is
    // a cube of that texture, which carries no tintindex because there is no
    // model to carry one, so it has to be told that the whole thing is
    // tinted or it comes out grey.
    tintAll: !!withTex.approximated && tintFamily(id) === 'water',
  };
}

// The other half of a two-block block, drawn above this one.
//
// The game writes it as two states that differ in one property: half=lower
// and half=upper for a door or a tall flower, part=foot and part=head for a
// bed. Nothing says they belong together except that -- so that is the test.
const HALVES = [['half', 'lower', 'upper'], ['part', 'foot', 'head']];

async function tallSibling(st, id, chosen) {
  const props = new Map(String(chosen.state).split(',').filter(Boolean)
    .map(p => { const i = p.indexOf('='); return [p.slice(0, i), p.slice(i + 1)]; }));
  const rule = HALVES.find(([k, low]) => props.get(k) === low);
  if (!rule) return null;
  const [key, , high] = rule;
  const states = await MA.blockStates(st.models, id);
  if (!states) return null;
  const want = [...props].map(([k, v]) => `${k}=${k === key ? high : v}`).sort().join(',');
  const other = states.find(s => String(s.state).split(',').sort().join(',') === want);
  if (!other || !other.parts || !other.parts[0]) return null;

  // An upper half that is nothing in the game is nothing here either. A
  // pitcher crop's top is a model with no geometry at all until stage 3 --
  // the plant is not tall yet -- and standing in a cube of its particle
  // texture, which is what any model without geometry falls back to, put a
  // block of soil in the air above the seedling.
  const upper = await MA.renderableModel(st.models, other.parts[0].model);
  if (!upper || upper.approximated || upper.kind !== 'elements') return null;

  const below = await mergeParts(st, chosen.parts);
  const above = await mergeParts(st, other.parts);
  if (!below || !above) return null;
  const textures = { ...below.textures };
  const shift = {};
  for (const [k, v] of Object.entries(above.textures)) { textures['u_' + k] = v; shift['#' + k] = '#u_' + k; }
  // Where the other half goes. A door's upper half is a block up; a bed's
  // head is a block along the way it faces.
  const FACING = { north: [0, 0, -16], south: [0, 0, 16], east: [16, 0, 0], west: [-16, 0, 0] };
  const step = key === 'part'
    ? (FACING[props.get('facing')] || [0, 0, -16])
    : [0, 16, 0];
  const up = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, step[0], step[1], step[2], 1];
  const raised = above.elements.map(el => ({
    ...el,
    transform: el.transform ? mulMat(up, el.transform) : up,
    faces: Object.fromEntries(Object.entries(el.faces).map(([d, f]) =>
      [d, { ...f, texture: shift[f.texture] || f.texture }])),
  }));
  return { kind: 'elements', elements: [...below.elements, ...raised], layers: null, textures };
}

// Column-major 4x4 multiply.
function mulMat(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let v = 0;
    for (let k = 0; k < 4; k++) v += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = v;
  }
  return o;
}

// Several models drawn as one block, each turned the way its piece says.
//
// A rotation in a blockstate turns the model about the middle of the block,
// so that is where the matrix turns it: in to the middle, turn, back out.
function rotateAbout(x, y) {
  const rx = (-x || 0) * Math.PI / 180, ry = (-y || 0) * Math.PI / 180;
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry);
  // Column-major: translate(8,8,8) * rotY * rotX * translate(-8,-8,-8)
  const r = [
    cy, sx * sy, -cx * sy, 0,
    0, cx, sx, 0,
    sy, -sx * cy, cx * cy, 0,
    0, 0, 0, 1,
  ];
  const t = [8, 8, 8];
  for (let i = 0; i < 3; i++) {
    r[12 + i] = t[i] - (r[i] * t[0] + r[4 + i] * t[1] + r[8 + i] * t[2]);
  }
  return r;
}

async function mergeParts(st, parts) {
  const elements = [];
  const textures = {};
  let i = 0;
  for (const part of parts) {
    const flat = await MA.renderableModel(st.models, part.model);
    if (flat.kind !== 'elements' || !flat.elements) continue;
    const withTex = await textureSpecs(st.textures, flat, DEPS.measureSaturation);
    const pre = 'p' + (i++) + '_';
    for (const [k, v] of Object.entries(withTex.textures || {})) textures[pre + k] = v;
    const turn = (part.x || part.y) ? rotateAbout(part.x, part.y) : null;
    for (const el of withTex.elements) {
      elements.push({
        ...el,
        transform: turn,
        faces: Object.fromEntries(Object.entries(el.faces).map(([d, f]) =>
          [d, { ...f, texture: '#' + pre + String(f.texture || '').replace(/^#/, '') }])),
      });
    }
  }
  if (!elements.length) return null;
  return { kind: 'elements', elements, layers: null, textures };
}

// Is a block's own geometry so small that it cannot be the block? A bell is
// drawn by the game and all the assets have is the fitting it hangs from.
//
// Measured as surface area, not volume. A cross -- a flower, a sapling, a
// wither rose -- is two upright planes with no thickness at all, so by volume
// it is nothing and was being treated as a placeholder: a wither rose went
// looking for an entity layer, found the one called `wither` (its own words
// cover it), and came out as the boss. By area a bell's fitting is 2% of a
// block where a wither rose is 60%.
const TINY_AREA = 0.12;
function tinyModel(flat) {
  if (flat.kind !== 'elements' || !Array.isArray(flat.elements) || !flat.elements.length) return false;
  let a = 0;
  for (const el of flat.elements) {
    const d = [0, 1, 2].map(i => Math.abs(el.to[i] - el.from[i]));
    a += 2 * (d[0] * d[1] + d[1] * d[2] + d[0] * d[2]);
  }
  return a < 6 * 16 * 16 * TINY_AREA;
}

// Which entity layer draws this block, if one does.
//
// The names line up by word: `ender_chest` and `trapped_chest` are both the
// `chest` model, `zombie_head` is `zombie_head`, `potted_x` is not a block
// entity at all. The texture is then resolved against the BLOCK's name, so
// an ender chest comes out in chest/ender.png rather than the plain one.
async function blockEntityLayer(version, id) {
  const layers = await entityLayers(version);
  if (!layers || !layers.size) return null;
  const bare = String(id).split(':').pop().replace(/^block\//, '');
  if (layers.has(bare)) return bare;
  const w = words(bare);
  // The longest layer name made of this block's own words: `ender_chest`
  // matches `chest`, and `chest` beats nothing.
  // Something that is only ever its parts: a conduit is conduit/cage,
  // conduit/eye and conduit/shell, with no layer of its own.
  if ([...layers.keys()].some(k => k.startsWith(bare + '/'))) return bare;
  let best = null;
  for (const key of layers.keys()) {
    if (key.includes('/')) continue;
    const kw = words(key);
    if (!kw.length || !kw.every(x => w.includes(x))) continue;
    if (!best || kw.length > words(best).length) best = key;
  }
  if (best) return best;

  // A block the game draws from layers that are named for its PIECES rather
  // than for it: a bed is `bed_head` and `bed_foot`, a dragon head is
  // `dragon_skull`, a decorated pot is `decorated_pot_base` and
  // `decorated_pot_sides`. None of those is a name the block's own words
  // cover, so the test above finds nothing and a bed came out as a cube of
  // oak planks. A piece is the block's own words plus exactly one that names
  // part of a thing.
  let pick = null, pickWords = 0;
  for (const key of layers.keys()) {
    if (key.includes('/')) continue;
    const kw = words(key);
    if (kw.filter(x => PIECE_WORDS.has(x)).length !== 1) continue;
    const rest = kw.filter(x => !PIECE_WORDS.has(x));
    if (!rest.length || !rest.every(x => w.includes(x))) continue;
    if (rest.length > pickWords) { pickWords = rest.length; pick = key; }
  }
  return pick;
}
const PIECE_WORDS = new Set(['base', 'side', 'head', 'foot', 'top', 'bottom', 'lid', 'skull']);

async function blockEntityModel({ profileId, version, id, state, variant, overrides }) {
  let layerName = null;
  try { layerName = await blockEntityLayer(version, id); } catch { return null; }
  if (!layerName) return null;
  const bare = String(id).split(':').pop();
  // A block drawn by the game rather than from a model is listed as a BLOCK,
  // so its variants arrive through describeModel's `variant` -- which means a
  // texture here, and means a layer of its own where the variant names one.
  // Without this a chest's ender, trapped and copper sheets did nothing at
  // all: the choice was made, passed in and dropped.
  const want = variant && String(variant);
  // A chest's half-sheets belong to the double chest's model rather than the
  // single chest's, since half a chest is not a picture of anything.
  const asLayer = want && layerName === 'chest' && CHEST_HALF.test(want)
    ? 'double_chest_left' : layerName;
  const desc = await describeEntity({
    profileId, version, name: asLayer, texture: want || undefined, textureFor: bare, overrides,
  });
  if (!desc || desc.error) return null;
  return { ...desc, model: `entity:${layerName}`, state: state || null, fromEntity: layerName };
}

// ── What colour a tint is ───────────────────────────────────────────────────
//
// A face with a `tintindex` is drawn greyscale and coloured in by the game.
// WHICH colour is not in the model -- it comes from the block's entry in the
// game's own colour table -- but two of the three sources are in the jar, as
// the colormaps the game samples by biome: grass.png and foliage.png. Plains
// is the biome the wiki's renders use, and is where these are read.
//
// Water is the exception with no colormap: it is one number in the game.
const PLAINS = { x: 51, y: 173 };           // temperature 0.8, downfall 0.4
const WATER_TINT = [0x3F / 255, 0x76 / 255, 0xE4 / 255];
const LILY_TINT = [0x20 / 255, 0x80 / 255, 0x30 / 255];
const REDSTONE_TINT = [0xC8 / 255, 0x00 / 255, 0x00 / 255];

const _colormaps = new Map();
async function colormap(stack, which) {
  const key = which;
  if (_colormaps.has(key)) return _colormaps.get(key);
  const p = (async () => {
    const hit = await stack.get(`assets/minecraft/textures/colormap/${which}.png`);
    if (!hit || !DEPS.samplePixel) return null;
    try { return await DEPS.samplePixel(hit.buf, PLAINS.x, PLAINS.y); } catch { return null; }
  })();
  _colormaps.set(key, p);
  return p;
}

// Which of the game's colour tables this block is in, by what it is. The
// model cannot say -- every leaf block shares one model file -- and this is
// the same split the game makes.
function tintFamily(id) {
  const n = String(id || '').toLowerCase();
  if (/water|bubble_column/.test(n)) return 'water';
  if (/lily_pad/.test(n)) return 'lily';
  if (/redstone/.test(n)) return 'redstone';
  if (/leaves|vine/.test(n)) return 'foliage';
  return 'grass';
}

async function tintFor(stack, id) {
  const family = tintFamily(id);
  if (family === 'water') return WATER_TINT;
  if (family === 'lily') return LILY_TINT;
  if (family === 'redstone') return REDSTONE_TINT;
  const got = await colormap(stack, family === 'foliage' ? 'foliage' : 'grass');
  if (got) return got.map(v => v / 255);
  // The colormap could not be read: plains, as the wiki's renders use it.
  return family === 'foliage'
    ? [0x77 / 255, 0xAB / 255, 0x2F / 255]
    : [0x91 / 255, 0xBD / 255, 0x59 / 255];
}

/** Every state a block has, for the picker's state chooser. */
export async function modelStates({ profileId, version, id, overrides }) {
  const st = await stackFor({ profileId, version, overrides });
  if (!st) return [];
  const states = await MA.blockStates(st.models, blockIdOf(id));
  if (!states) return [];
  const best = await MA.chooseState(st.models, states);
  return states.map(s => ({
    state: s.state,
    model: s.parts[0].model,
    x: s.parts[0].x || 0, y: s.parts[0].y || 0, uvlock: !!s.parts[0].uvlock,
    preferred: s === best,
  }));
}

/**
 * The searchable catalogue: every block that has a blockstate, every item, and
 * every entity, from this instance's own assets.
 *
 * Blocks are listed by their blockstate rather than by their model, because
 * that is the thing with a name people know ("oak_stairs", not
 * "block/oak_stairs_inner"), and it is what carries the states.
 */
export async function listModels({
  profileId, version, query = '', kinds = null, limit = 200, offset = 0,
  vanilla = true, modded = true, overrides = false,
}) {
  const st = await stackFor({ profileId, version, overrides });
  if (!st) return { items: [], total: 0 };
  const want = new Set(kinds && kinds.length ? kinds : ['block', 'item', 'entity']);
  const q = String(query || '').trim().toLowerCase();

  // Where a thing came from. An instance with a hundred mods in it has tens of
  // thousands of blocks, and somebody looking for an oak door does not want to
  // wade through them -- or the other way about. The index remembers which
  // source each entry was found in, so the two can be asked for separately.
  const wanted = (entry) => ((entry && entry.source === 'jar') ? vanilla : modded);

  const items = [];
  if (want.has('block')) {
    for (const s of st.index.states.values()) {
      if (!wanted(s)) continue;
      items.push({ kind: 'block', id: s.id, name: s.name, ns: s.ns, from: s.from });
    }
  }
  if (want.has('item')) {
    // From 1.21.4 an item is a definition file, and the models beside it are
    // the pictures that file chooses between: a clock is twelve of them, a
    // chestplate is itself and a trim for every material. Listing the models
    // made every one of those its own search result -- "clock" found 65
    // things, "chestplate" 84 -- when they are already offered as variants of
    // the one item. So where there are definitions, the definitions ARE the
    // catalogue. Older versions have no definitions and list models, as before.
    const defs = [...st.index.items.values()];
    if (defs.length) {
      for (const d of defs) {
        if (!wanted(d)) continue;
        items.push({ kind: 'item', id: `${d.ns}:item/${d.name}`, name: d.name, ns: d.ns, from: d.from });
      }
    } else {
      for (const m of st.index.models.values()) {
        if (m.kind !== 'item' || !wanted(m)) continue;
        if (MA.looksLikeTemplate(m.name)) continue;
        items.push({ kind: 'item', id: m.id, name: m.name, ns: m.ns, from: m.from });
      }
    }
  }
  // Every entity model is read out of the client jar's own classes, so there
  // are no modded ones to list: with vanilla off there is nothing to show.
  if (want.has('entity') && vanilla) {
    const ents = await entityLayers(version);
    for (const name of ents.keys()) {
      // `breeze/eyes` is not an entity, it is part of the breeze -- and it is
      // drawn with it now, so listing it separately was offering a mob's eyes
      // as a thing to pick.
      if (name.includes('/')) continue;
      items.push({ kind: 'entity', id: 'entity:' + name, name, ns: 'minecraft', from: 'client jar' });
    }
  }

  // One thing, one entry.
  //
  // A bell was three: the block, the item you hold, and the shape the game
  // draws it with. They are the same bell, and only one of them carries its
  // states, so that is the one kept -- the block.
  //
  // So anything that shares a block's name goes, and that is deliberate even
  // where the two are drawn differently -- a bell in your hand is a flat
  // sprite, not the bell in the world. Two entries called "bell" is still two
  // entries called "bell", and the one worth having is the one you can turn,
  // set and adjust.
  {
    const blocks = new Set(items.filter(i => i.kind === 'block').map(i => `${i.ns}:${i.name}`));
    if (blocks.size) {
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it.kind !== 'block' && blocks.has(`${it.ns}:${it.name}`)) items.splice(i, 1);
      }
    }
  }

  // "ice ball" should find ice_ball: a name is words joined with underscores,
  // so a search is matched against it both as typed and with the spaces
  // closed up, and every word has to appear somewhere in the name.
  const terms = q ? q.split(/\s+/).filter(Boolean) : [];
  const matches = (it) => {
    const name = it.name.toLowerCase();
    const flat = name.replace(/[_/]+/g, '');
    const ns = it.ns.toLowerCase();
    if (name.includes(q) || flat.includes(q.replace(/[\s_]+/g, '')) || ns.includes(q)) return true;
    return terms.every(t => name.includes(t) || flat.includes(t));
  };
  const match = q ? items.filter(matches) : items;
  // Shortest name first for a query, so "stone" puts stone above
  // stone_brick_stairs; alphabetical otherwise.
  match.sort((a, b) => (q ? a.name.length - b.name.length : 0) || a.ns.localeCompare(b.ns) || a.name.localeCompare(b.name));
  return { items: match.slice(offset, offset + limit), total: match.length };
}

const _layerCache = new Map();
export async function entityLayers(version) {
  if (_layerCache.has(version)) return _layerCache.get(version);
  const p = (async () => {
    const got = await entityModelsFor(version);
    if (!got) return new Map();
    try { return await got.em.layers(); } catch (err) { log('icon models: ' + (err && err.message)); return new Map(); }
  })();
  _layerCache.set(version, p);
  return p;
}

/**
 * An entity layer, ready to render.
 *
 * A mob is often more than one layer. A drowned is its body plus a
 * `drowned/outer` overlay — a slightly larger copy of the same shape wearing a
 * texture that is mostly transparent, which is where its clothes and the
 * seaweed come from. Drawing only the body loses all of that and the mob comes
 * out looking flat and wrong. So any `<name>/outer` layer is drawn on top,
 * with its own texture, as a second set of elements.
 */
// when the entity actually has the gear, and nothing in the model data says
// which is which -- so a saddle would otherwise end up on every pig.

export async function describeEntity({ profileId, version, name, texture, textureFor, overrides }) {
  const both = await doubleChest({ profileId, version, name, texture, overrides })
    || await bedModel({ profileId, version, name, texture, textureFor, overrides })
    || await piecesModel({ profileId, version, name, texture, overrides });
  if (both) return both;
  const layers = await entityLayers(version);
  // A few things are only ever their parts: a conduit is its cage, its eye
  // and its shell, with no layer of its own to hang them on.
  const L = layers.get(name)
    || ([...layers.keys()].some(k => k.startsWith(name + '/'))
      ? { elements: [], texWidth: 64, texHeight: 64 }
      : null);
  if (!L) return { error: `no entity layer called ${name}` };
  const st = await stackFor({ profileId, version, overrides });
  const tx = st ? st.textures : null;
  // `textureFor` is the name to dress it in when that is not the layer's own:
  // an ender chest is the chest model wearing chest/ender.png.
  const tex0 = await entityTextureFile(tx, textureFor || name, texture, layers)
    || await entityTextureFile(tx, name, texture, layers);
  if (!tex0 && L.elements.length) return { error: `no texture for ${name}` };

  const parts = [...layers.keys()].filter(k => k.startsWith(name + '/'));

  // Which boxes belong to which layer of a shared mesh.
  //
  // One mesh is often registered several times over with a texture each -- a
  // breeze is itself, its wind and its eyes -- and every registration carries
  // every box. The flattener marks each box with whether the layer's texture
  // has room for its unwrap, and that is the answer: a wind box is unwrapped
  // against the wind's 128x128 sheet and runs off the 32x32 one the body and
  // the eyes use. Drawing it there sampled the body texture past its border,
  // which is where the breeze's slabs of grey came from.
  //
  // A box is only dropped from a layer when ANOTHER layer of the same mesh
  // does have room for it, though -- that is what makes it somebody else's
  // box rather than simply a sloppy unwrap. Models do overflow their own
  // texture where nobody looks: a decorated pot's top and bottom quads do,
  // and nothing else draws them, so they stay.
  const boxId = (el) => `${el.part || ''}|${(el.from || []).join(',')}|${(el.to || []).join(',')}`;
  const hosted = new Set();
  for (const key of [name, ...parts]) {
    const l = layers.get(key);
    if (!l) continue;
    for (const el of l.elements) if (el.fits !== false) hosted.add(boxId(el));
  }
  const mine = (el) => el.fits !== false || !hosted.has(boxId(el));

  const elements = L.elements.filter(mine);
  const overlayGroups = [];
  // Textures a layer of its own already wears, so they are not laid on twice.
  const wornPaths = new Set();
  const textures = {};
  if (tex0) textures[0] = { url: tex0.url, width: L.texWidth, height: L.texHeight, frames: 1 };
  let slot = 1;

  // Everything the mob is made of that the game registers as its own layer:
  // `drowned/outer` (its clothes and seaweed), `breeze/eyes`, `breeze/wind`,
  // `warden/heart`. Each is a second set of boxes with a texture of its own,
  // and without them the mob comes out flat and wrong -- or, worse, the parts
  // turn up in the list as entities of their own, which is what they looked
  // like before.
  //
  // Each part's texture is its own: an overlay is mostly transparent on
  // purpose (the stray's overlay is registered as a player-shaped humanoid,
  // and only the clothing shows because the rest samples empty texture), so
  // falling back to the body's texture would draw it solid.
  for (const key of parts) {
    const part = layers.get(key);
    if (!part) continue;
    // Its own texture, or the body's. A part normally has one of its own and
    // it matters that it does -- an overlay is mostly transparent on purpose,
    // and the stray's is registered as a whole player-shaped humanoid, so
    // drawing it with the body's texture would make it solid. But some parts
    // genuinely share: a slime's outer shell is the same cube, the same
    // texture, one size up.
    // Its own texture, or the body's: an overlay normally has one of its own
    // and it matters that it does, because it is mostly transparent on
    // purpose. Some parts genuinely share -- a slime's outer shell is the
    // same cube, the same texture, one size up.
    const pt = await entityTextureFile(tx, key, null, layers);
    if (!pt && !tex0) continue;
    if (pt) wornPaths.add(pt.path);
    textures[slot] = { url: (pt || tex0).url, width: part.texWidth, height: part.texHeight, frames: 1 };
    const ref = '#' + slot;
    slot++;
    // Something it only sometimes wears travels with the model but is not
    // drawn unless asked for -- see SOMETIMES.
    const sometimes = !worn(key.slice(name.length + 1).replace(/[_/]+/g, ' '));
    const glow = !!(pt && SWIRLS.test(pt.path));
    for (const el of part.elements.filter(mine)) {
      elements.push({
        ...el, group: key, ...(sometimes ? { over: true } : {}), ...(glow ? { glow: true } : {}),
        faces: Object.fromEntries(
          Object.entries(el.faces).map(([d, f]) => [d, { ...f, texture: ref }])),
      });
    }
  }

  // The ones that are drawn ON it rather than instead of it.
  //
  // An iron golem's three crackinesses and a creeper's charge were offered as
  // other skins for the mob, which is wrong twice over: they are not skins, and
  // picking one replaced the mob with a sheet of cracks on an invisible body.
  // They are overlays -- mostly empty textures laid over the same boxes -- and
  // telling them from a skin is a matter of looking: a skin covers roughly what
  // the first one covers, an overlay covers a fraction of it.
  //
  // So they become parts, switched off to begin with, because a golem is not
  // cracked and a creeper is not charged unless you say so.
  const skins = [];
  const baseCover = tex0 ? await textureCoverage(tx, tex0.path) : null;
  for (const c of ((tex0 && tex0.choices) || [])) {
    if (c.path === (tex0 && tex0.path)) { skins.push(c); continue; }
    if (wornPaths.has(c.path)) continue;   // a part of the mob already wears it
    const cover = await textureCoverage(tx, c.path);
    const thin = cover != null && baseCover != null && baseCover > 0.05
      && cover < baseCover * 0.45;
    if (!thin) { skins.push(c); continue; }
    const hit = await stackTexture(tx, c.path);
    if (!hit) { skins.push(c); continue; }
    const key = 'over:' + c.path;
    textures[slot] = { url: hit, width: L.texWidth, height: L.texHeight, frames: 1 };
    const ref = '#' + slot;
    slot++;
    const glow = SWIRLS.test(c.path);
    for (const el of L.elements.filter(mine)) {
      elements.push({
        ...el, group: key, over: true, ...(glow ? { glow: true } : {}),
        // A hair bigger, or it fights with the body it is lying on.
        from: el.from.map(v => v - OVERLAY_GROW),
        to: el.to.map(v => v + OVERLAY_GROW),
        faces: Object.fromEntries(
          Object.entries(el.faces).map(([d, f]) => [d, { ...f, texture: ref }])),
      });
    }
    overlayGroups.push({ key, label: c.label, off: true });
  }

  // A minecart's load is a block rather than a layer, so it is fetched and
  // placed rather than read off the model.
  const load = await minecartLoad({ profileId, version, name, slot, overrides });
  if (load) {
    elements.push(...load.elements);
    Object.assign(textures, load.textures);
    overlayGroups.push({ key: 'load', label: load.label });
  }

  // What it is made of, so whoever is looking at it can switch a part off
  // when the game would not have drawn it. There is no data here that says
  // which parts the game hides while a mob stands still -- an armadillo has
  // the ball it rolls into, an evoker has both sets of arms -- so rather than
  // guess, everything is drawn and the parts are named.
  const own = elements.filter(el => !el.group).length;
  const groups = own ? [{ key: '', label: 'Body', n: own }] : [];
  for (const key of parts) {
    const n = elements.filter(el => el.group === key).length;
    if (!n) continue;
    const label = key.slice(name.length + 1).replace(/[_/]+/g, ' ');
    groups.push({ key, label, n, ...(worn(label) ? {} : { off: true }) });
  }
  for (const g of overlayGroups) {
    const n = elements.filter(el => el.group === g.key).length;
    if (n) groups.push({ ...g, n });
  }

  // A chest and a bell are built in a block's own space rather than around a
  // mob's pivot, so they are centred the way a block model is -- and they do
  // not want the half turn that points a mob at the camera, because their
  // front already is the front. A chest turned through it showed its back.
  const inBlock = !!L.blockSpace;

  // The six minecarts are one mesh and one texture and differ only in what
  // they carry, so they are each other's variants rather than six identical
  // entries. Nothing else works that way, so nothing else is looked for.
  const family = CART_FAMILY.test(name)
    ? [...layers.keys()].filter(k => CART_FAMILY.test(k)).sort()
    : null;
  // A chest's `normal_left` and `normal_right` sheets are not two more chests:
  // they are the two halves of ONE double chest, and on a single chest they
  // drew a side that is not there. Each pair becomes one entry that draws the
  // double chest whole.
  const variants = family && family.length > 1
    ? family.map(k => ({
      path: tex0 ? tex0.path : null, label: k.replace(/_/g, ' '), layer: k, key: 'layer:' + k,
    }))
    : skins.flatMap(c => {
      const h = CHEST_HALF.exec(c.path);
      if (h && h[2] === 'right') return [];
      if (h && skins.some(o => o.path === `${h[1]}_right.png`)) {
        return [{
          path: c.path, label: `${c.label.replace(/\s*left$/, '')} double`.trim(),
          layer: 'double_chest_left', key: 'double:' + h[1],
        }];
      }
      return [{
        path: c.path, label: c.label, layer: c.layer || null,
        key: (c.layer ? c.layer + '|' : '') + c.path,
      }];
    });

  return {
    kind: 'elements', space: inBlock ? 'block' : 'entity', elements, textures,
    rotY: inBlock ? 0 : 180,
    // Which skin this is wearing, and the others it could be: a cow is six
    // textures on one model, a cushion sixteen.
    texture: tex0 ? tex0.path : null,
    layer: name,
    // Which entry of `variants` this one is. A texture is not enough on its
    // own: every minecart wears the same one.
    variantKey: (variants.find(v => (family ? v.layer === name : v.path === (tex0 && tex0.path)))
      || variants[0] || {}).key || null,
    // `layer` is set when this skin belongs to a model of its own -- a cold
    // cow is not quite a cow -- so that picking it brings that model too.
    variants,
    parts: groups.length > 1 ? groups : null,
  };
}

// ── Which texture goes on which entity ──────────────────────────────────────
//
// A layer is called `cow` and its texture is `entity/cow/cow_temperate.png`.
// It is called `ender_dragon` and its texture is
// `entity/enderdragon/dragon.png`. It is called `elder_guardian` and its
// texture is `entity/guardian/guardian_elder.png`. There is no rule that
// turns one into the other, which is why a pig, a cow, a cushion and the
// ender dragon simply did not appear: the old lookup wanted a file named
// exactly after the layer, found none, and the entry was dropped.
//
// So instead of guessing one path, every texture under entity/ is scored
// against the layer's name and the best one wins -- and the rest are handed
// back as the variants they are, because `cow` really is six textures and
// `cushion` is sixteen.
const TEX_ROOT = 'assets/minecraft/textures/entity/';
// Bits of a name that mean "this is drawn ON something", not "this is it".
const OVERLAY_WORDS = new Set([
  'overlay', 'outer', 'layer', 'eyes', 'armor', 'armour', 'beam', 'exploding',
  'fireball', 'wind', 'saddle', 'collar', 'decor', 'harness', 'ropes', 'glow',
  'shadow', 'melting', 'angry', 'invulnerable', 'charge',
]);
// A word, as the matcher compares them: singular. The layer is called
// `decorated_pot_sides` and its texture is `decorated_pot_side.png`, which
// matched nothing at all, so the pot came out as a few loose plates with no
// walls. Nothing else in the names turns on a plural, so one is simply not a
// difference. Only a trailing "s" after a letter, so "glass" stays "glass".
const stem1 = (w) => (/[a-z]{3}s$/.test(w) && !/ss$/.test(w) ? w.slice(0, -1) : w);
const words = (s) => String(s).toLowerCase().split(/[_/]+/).filter(Boolean).map(stem1);
// Words the game uses interchangeably between a layer's name and its texture's.
const SAME_AS = {
  outer: ['outer', 'overlay'],
  overlay: ['overlay', 'outer'],
  armor: ['armor', 'armour'],
  armour: ['armour', 'armor'],
};
const sameWords = (a, b) => {
  const A = new Set(words(a)), B = new Set(words(b));
  if (A.size !== B.size) return false;
  for (const w of A) if (!B.has(w)) return false;
  return true;
};

async function entityTexturePaths(stack) {
  const out = new Set();
  for (const s of stack.sources) {
    let names = [];
    try { names = s.list(); } catch { continue; }
    for (const n of names) {
      if (n.startsWith(TEX_ROOT) && n.endsWith('.png')) out.add(n);
    }
  }
  return [...out];
}

/**
 * Every texture that could belong to this layer, best first.
 *
 * Each one is { path, label }. The label is what a person would call that
 * variant -- "temperate", "red", "exploding" -- or the layer's own name when
 * there is only one.
 */
async function entityTextureChoices(stack, name, layers) {
  if (!stack) return [];
  const full = String(name);
  const base = full.split('/')[0];
  const sub = full.includes('/') ? full.split('/').slice(1).join('_') : null;
  const wantBaby = /_baby$/.test(base);
  const stem = base.replace(/_baby$/, '');
  const squashed = stem.replace(/_/g, '');
  const bare = new Set(words(stem));

  const paths = await entityTexturePaths(stack);
  const scored = [];
  for (const p of paths) {
    const file = p.slice(TEX_ROOT.length);
    const folder = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
    const fname = file.slice(file.lastIndexOf('/') + 1).replace(/\.png$/, '');
    const fw = words(fname);
    const extra = fw.filter(w => !bare.has(w));
    // The words as they are written, which is what a label should read as:
    // matching is done on stems, so "christmas" matches "christma", but a
    // label built from the stems said "christma".
    const spelt = String(fname).toLowerCase().split(/[_/]+/).filter(Boolean);

    let score = -1;
    if (fname === stem) score = 100;
    else if (fname === squashed) score = 96;
    else if (sameWords(fname, stem)) score = 92;                 // guardian_elder
    else if (fw.length > bare.size && [...bare].every(w => fw.includes(w))) score = 70;  // cow_temperate
    // The folder is named after the entity even when the file is not:
    // `enderdragon/dragon.png`, which matches nothing by name at all.
    else if (folder === stem || folder === squashed) score = 50 - fw.length;
    // Or the other way about: an ender chest is the chest model wearing
    // `chest/ender.png`, whose name is part of the block's.
    else if (fw.length && fw.every(w => bare.has(w))) score = 40 + fw.length;
    if (score < 0) continue;

    // A sub-layer (breeze/eyes) wants the parent's texture with that word on
    // it; the parent itself wants the one without.
    //
    // The word the layer uses and the word the file uses are not always the
    // same one: the game's `bogged/outer` and `stray/outer` are drawn with
    // bogged_overlay.png and stray_overlay.png. Where they mean the same
    // thing, either will do -- otherwise the overlay found no texture of its
    // own and wore the body's, which is why a bogged's clothes and its bones
    // were the same picture.
    const isOverlay = extra.some(w => OVERLAY_WORDS.has(w));
    if (sub) {
      const subWords = words(sub);
      if (!subWords.every(w => SAME_AS[w] ? SAME_AS[w].some(x => fw.includes(x)) : fw.includes(w))) continue;
      score += 30;
    } else if (isOverlay) {
      continue;                                  // not the entity's own skin
    }

    // Babies have their own texture, and only babies should get it.
    const isBaby = fw.includes('baby');
    if (isBaby !== wantBaby) continue;

    // The folder matters: `pig/pig_temperate.png` over `banner/piglin.png`.
    if (folder === stem || folder === squashed) score += 12;
    else if (words(folder).some(w => bare.has(w))) score += 6;
    // Vanilla's own default among a set of variants.
    if (extra.includes('temperate') || extra.includes('default') || extra.includes('normal')) score += 4;
    // Fewer extra words is closer to plain.
    score -= extra.filter(w => w !== 'baby').length;

    const label = spelt.filter((_, i) => !bare.has(fw[i]) && fw[i] !== 'baby').join(' ')
      || fname.replace(/_/g, ' ');
    scored.push({ path: p, label, score, folder, fname, fw });
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  if (!scored.length) return scored;

  // Which of these are actually OTHER SKINS for this thing.
  //
  // The scorer is deliberately generous, because the one texture a thing wears
  // can be named almost anything -- an ender dragon's is enderdragon/dragon.png
  // and an elder guardian's is guardian/guardian_elder.png -- and the best
  // guess being wrong means the thing does not render at all. Everything it
  // reached for, though, was then offered as a VARIANT, and most of what it
  // reaches for belongs to something else entirely: the ender dragon offered
  // the ender chest's texture, the armadillo a wolf's armour, the iron golem
  // every piece of iron equipment in the game, and a decorated pot a banner's.
  //
  // The best match is kept whatever it is -- it is the thing's skin, by
  // definition. Past that, three things disqualify a texture:
  const home = scored[0].folder;
  const mine = new Set(words(stem));
  const squash = (s) => String(s).replace(/[_/]+/g, '');
  const all = layers instanceof Map ? layers : new Map();
  const others = [...all.keys()].filter(n => n !== full && n !== base);
  const myBoxes = (all.get(full) || all.get(base) || { elements: [] }).elements.length;
  // Is that other layer the same thing in a different coat, or a different
  // thing that happens to share a word? A cold cow is a cow -- same model, one
  // box different at most -- while a llama's spit is a single box and an
  // evoker's fangs are a mouthful of them. Nothing in the names says which, so
  // the shapes are compared.
  const sameShape = (L) => {
    const n = (all.get(L) || { elements: [] }).elements.length;
    if (!n || !myBoxes) return false;
    return Math.abs(n - myBoxes) <= Math.max(2, Math.max(n, myBoxes) * 0.3);
  };
  const ownedBy = (fname) => others.find(L =>
    fname === L || squash(fname) === squash(L) || sameWords(fname, L)) || null;

  const kept = [];
  for (let i = 0; i < scored.length; i++) {
    const c = scored[i];
    if (i === 0) { kept.push(c); continue; }
    // Somebody else's folder. Textures for one thing live together, so one
    // from elsewhere is a near miss on the name, not another skin.
    if (c.folder !== home) continue;
    // Its name is part of this one's rather than an addition to it. A variant
    // says something EXTRA -- cow_cold, mooshroom_red -- where `ghast` beside
    // `happy_ghast` is simply the other mob.
    if (c.fw.length && c.fw.length < mine.size && c.fw.every(w => mine.has(w))) continue;
    // A layer of its own is named for it. If that layer is a different shape
    // it is a different thing, and the texture is its, not this one's: a
    // llama's spit, an evoker's fangs. If it is the same shape it is this
    // thing in another coat -- a cold cow, a warm chicken -- and it stays, but
    // tagged, because those models are NOT identical (a cold chicken has no
    // beak, a warm cow no horns) and picking it has to bring its own model.
    const owner = ownedBy(c.fname);
    if (owner && !sameShape(owner)) continue;
    kept.push(owner ? { ...c, layer: owner } : c);
  }
  return kept;
}

const asDataUrl = (buf) => 'data:image/png;base64,' + buf.toString('base64');


// How much of a texture is painted at all, 0..1, remembered per file. What it
// is for is at the call site: telling an overlay from another skin.
const _coverage = new Map();
async function textureCoverage(stack, p) {
  if (!stack || !p || !DEPS.measureAlpha) return null;
  if (_coverage.has(p)) return _coverage.get(p);
  const q = (async () => {
    const hit = await stack.get(p);
    if (!hit) return null;
    try { return await DEPS.measureAlpha(hit.buf); } catch { return null; }
  })();
  _coverage.set(p, q);
  return q;
}
async function stackTexture(stack, p) {
  const hit = stack && p ? await stack.get(p) : null;
  return hit ? asDataUrl(hit.buf) : null;
}
// How far an overlay is grown so it does not fight with the body underneath.
const OVERLAY_GROW = 0.02;

// ── What a minecart is carrying ─────────────────────────────────────────────
//
// A chest minecart's model is the plain cart: the chest in it is a BLOCK the
// game draws inside, from the entity's own block state rather than from any
// layer. So the cart came out empty and the six of them were six identical
// carts. The name says which block it is -- strip `_minecart` -- and the
// game's own placement is three quarters size, turned a quarter, sitting with
// its base on the cart's floor.
const MINECART_RE = /^(.+)_minecart$/;
const CART_FAMILY = /^([a-z0-9_]+_)?minecart$/;
const CART_SCALE = 0.75;
// Column-major 4x4s, the shape the renderer takes an element's transform in.
const m4 = {
  id: () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  mul: (a, b) => {
    const o = new Array(16).fill(0);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
    return o;
  },
  translate: (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1],
  scale: (s) => [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1],
  rot: (axis, rad) => {
    const c = Math.cos(rad), s = Math.sin(rad);
    if (axis === 'x') return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
    if (axis === 'z') return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];   // y
  },
  // A turn about a point rather than about the origin.
  about: (axis, rad, o) => m4.mul(m4.mul(m4.translate(o[0], o[1], o[2]), m4.rot(axis, rad)),
    m4.translate(-o[0], -o[1], -o[2])),
};

/**
 * The block a minecart carries, as elements in the cart's own space.
 *
 * The cart's boxes are the game's entity coordinates with the 6/16 the game
 * lifts the body by already taken off; the block is drawn in the entity's
 * coordinates outright. So the placement is the game's -- three quarters
 * size, a quarter turn, `(displayOffset - 8)/16` up -- with that 6 taken off
 * again, and an offset of 8, which is the one that stands the block on the
 * cart's floor.
 */
async function minecartLoad({ profileId, version, name, slot, overrides }) {
  const m = MINECART_RE.exec(String(name || ''));
  if (!m) return null;
  const block = await describeModel({ profileId, version, id: `minecraft:${m[1]}`, overrides });
  if (!block || block.error || block.kind !== 'elements' || !block.elements.length) return null;
  // Something drawn in a mob's own space would need its own placement; only a
  // block goes in a cart.
  if (block.space === 'entity') return null;

  const s = CART_SCALE;
  // q -> ( s*q.z - 8s, s*q.y - 6, -s*q.x + 8s ), which is the game's
  // scale, translate and quarter turn rolled into one.
  const place = [0, 0, -s, 0, 0, s, 0, 0, s, 0, 0, 0, -8 * s, -6, 8 * s, 1];
  // The state the block was chosen in carries a turn of its own, about the
  // middle of the block.
  const base = block.rotY || block.rotX
    ? m4.mul(m4.mul(place, m4.about('y', -(block.rotY || 0) * Math.PI / 180, [8, 8, 8])),
      m4.about('x', -(block.rotX || 0) * Math.PI / 180, [8, 8, 8]))
    : place;

  const textures = {};
  const key = (k) => `c${slot}_${k}`;
  for (const [k, v] of Object.entries(block.textures || {})) if (v) textures[key(k)] = v;
  const elements = [];
  for (const el of block.elements) {
    // An element with a turn of its own -- a hopper's spout, a cross -- keeps
    // it by having it folded into the matrix, since the renderer takes one or
    // the other and the matrix is the one that can say all of this.
    // A block entity -- the chest -- already carries a matrix per box, from
    // the part tree it hangs off; an ordinary element carries at most a turn.
    const own = Array.isArray(el.transform) && el.transform.length === 16
      ? el.transform
      : (el.rotation && el.rotation.axis && el.rotation.angle
        ? m4.about(el.rotation.axis, Number(el.rotation.angle) * Math.PI / 180,
          (el.rotation.origin || [8, 8, 8]).map(Number))
        : null);
    const { rotation, ...rest } = el;
    elements.push({
      ...rest,
      group: 'load',
      transform: own ? m4.mul(base, own) : base,
      faces: Object.fromEntries(Object.entries(el.faces || {}).map(([d, f]) => [d, {
        ...f, texture: '#' + key(String(f.texture || '').replace(/^#/, '')),
      }])),
    });
  }
  return { elements, textures, label: m[1].replace(/_/g, ' ') };
}

// ── A double chest ──────────────────────────────────────────────────────────
//
// A double chest is TWO block entities, each drawing its own half: the game
// has a `double_chest_left` model and a `double_chest_right` one, each fifteen
// wide and each with its lock against the edge it meets the other at, and it
// draws them in neighbouring blocks. Drawn alone, a half is a chest with a
// missing side and a lock in the corner, and neither half had a texture at all
// because the sheets are called `normal_left` and `normal_right`, which no
// rule turns `double_chest_left` into.
//
// So either half draws the whole thing: this half where it is, the other one a
// block along.
const DOUBLE_CHEST = /^double_chest_(left|right)$/;
const CHEST_HALF = /^(.*)_(left|right)\.png$/;

async function doubleChest({ profileId, version, name, texture, overrides }) {
  if (!DOUBLE_CHEST.test(String(name || ''))) return null;
  const layers = await entityLayers(version);
  const halves = { left: layers.get('double_chest_left'), right: layers.get('double_chest_right') };
  if (!halves.left || !halves.right) return null;
  const st = await stackFor({ profileId, version, overrides });
  const tx = st ? st.textures : null;
  if (!tx) return null;

  // The sheets a chest has, in pairs: `normal_left` goes with `normal_right`.
  const choices = await entityTextureChoices(tx, 'chest', layers);
  const pairs = [];
  for (const c of choices) {
    const m = CHEST_HALF.exec(c.path);
    if (!m || m[2] !== 'left') continue;
    if (choices.some(o => o.path === `${m[1]}_right.png`)) {
      pairs.push({ base: m[1], label: `${c.label.replace(/\s*left$/, '')} double`.trim() });
    }
  }
  if (!pairs.length) return null;
  const asked = texture && CHEST_HALF.exec(texture);
  const pick = (asked && pairs.find(p => p.base === asked[1])) || pairs[0];

  const sheets = {};
  for (const side of ['left', 'right']) {
    const hit = await stackTexture(tx, `${pick.base}_${side}.png`);
    if (!hit) return null;
    sheets[side] = hit;
  }

  const textures = {
    0: { url: sheets.right, width: halves.right.texWidth, height: halves.right.texHeight, frames: 1 },
    1: { url: sheets.left, width: halves.left.texWidth, height: halves.left.texHeight, frames: 1 },
  };
  // The right half sits in its own block and the left half in the next one
  // along, which is what makes the two fifteen-wide halves one thirty-wide
  // chest with the locks meeting in the middle.
  const over = m4.translate(16, 0, 0);
  const elements = [];
  for (const [side, slot, shift] of [['right', 0, null], ['left', 1, over]]) {
    for (const el of halves[side].elements) {
      elements.push({
        ...el,
        group: side,
        transform: shift ? m4.mul(shift, el.transform || m4.id()) : el.transform,
        faces: Object.fromEntries(
          Object.entries(el.faces || {}).map(([d, f]) => [d, { ...f, texture: '#' + slot }])),
      });
    }
  }

  return {
    kind: 'elements', space: 'block', elements, textures, rotY: 0,
    texture: `${pick.base}_left.png`,
    layer: name,
    variantKey: 'double:' + pick.base,
    variants: pairs.map(p => ({
      path: `${p.base}_left.png`, label: p.label, layer: name, key: 'double:' + p.base,
    })),
    parts: null,
  };
}

// ── A bed ───────────────────────────────────────────────────────────────────
//
// A bed is two block entities as well, `bed_head` and `bed_foot`, and the
// assets hold nothing for it at all -- `block/bed` is a particle texture and
// nothing else -- so it came out as a cube of oak planks.
//
// The two meshes are built lying on their backs: each is sixteen across,
// sixteen along and six deep, with its legs sticking out behind. The game
// stands them up with a quarter turn about X and lifts them nine sixteenths,
// which is exactly a bed's height, and draws the head in the block the foot
// faces. Both of those are here, with the head at -z, so the legs come out at
// the two far ends and the mattresses meet in the middle.
const BED_LAYER = /^bed_(head|foot)$/;
const BED_TEX = /^assets\/[a-z0-9_.-]+\/textures\/entity\/bed\/([a-z0-9_]+)\.png$/;

async function bedModel({ profileId, version, name, texture, textureFor, overrides }) {
  if (!BED_LAYER.test(String(name || ''))) return null;
  const layers = await entityLayers(version);
  const halves = { head: layers.get('bed_head'), foot: layers.get('bed_foot') };
  if (!halves.head || !halves.foot) return null;
  const st = await stackFor({ profileId, version, overrides });
  const tx = st ? st.textures : null;
  if (!tx) return null;

  // Every colour a bed comes in, which is every file in its folder.
  const sheets = [];
  for (const src of tx.sources || []) {
    let names = [];
    try { names = src.list(); } catch { continue; }
    for (const p of names) {
      const m = BED_TEX.exec(p);
      if (m && !sheets.some(c => c.path === p)) sheets.push({ path: p, label: m[1].replace(/_/g, ' ') });
    }
  }
  if (!sheets.length) return null;
  sheets.sort((a, b) => a.label.localeCompare(b.label));
  // The colour the block itself is -- `white_bed` is white -- or whichever was
  // asked for.
  const want = String(textureFor || '').replace(/_?bed$/, '');
  const pick = sheets.find(c => c.path === texture)
    || (want && sheets.find(c => c.label.replace(/ /g, '_') === want))
    || sheets.find(c => c.label === 'red') || sheets[0];
  const url = await stackTexture(tx, pick.path);
  if (!url) return null;

  // Stood up and lifted to a bed's own height; the head is the block along.
  const stand = m4.mul(m4.translate(0, 9, 0), m4.rot('x', Math.PI / 2));
  const place = { foot: stand, head: m4.mul(m4.translate(0, 0, -16), stand) };
  const elements = [];
  for (const side of ['foot', 'head']) {
    for (const el of halves[side].elements) {
      elements.push({
        ...el,
        group: side,
        transform: m4.mul(place[side], el.transform || m4.id()),
        faces: Object.fromEntries(
          Object.entries(el.faces || {}).map(([d, f]) => [d, { ...f, texture: '#0' }])),
      });
    }
  }

  return {
    kind: 'elements', space: 'block', elements, rotY: 0,
    textures: { 0: { url, width: halves.head.texWidth, height: halves.head.texHeight, frames: 1 } },
    texture: pick.path,
    layer: name,
    variantKey: pick.path,
    variants: sheets.map(c => ({ path: c.path, label: c.label, layer: name, key: c.path })),
    parts: null,
  };
}

// ── A block drawn from several pieces ───────────────────────────────────────
//
// A decorated pot is `decorated_pot_base` -- its neck, its lid and its floor
// -- and `decorated_pot_sides`, its four walls, each with a texture of its
// own. Neither is the pot: the base alone is two flat plates in the air.
// Where a block's layer is one of a set of siblings named for the pieces of
// one thing, all of them are drawn, in the one block they share.
//
// Not the bed: its two are a block APART, which is bedModel's job.
async function piecesModel({ profileId, version, name, texture, overrides }) {
  const key = String(name || '');
  const cut = key.lastIndexOf('_');
  if (cut < 1) return null;
  const stem = key.slice(0, cut);
  if (!PIECE_WORDS.has(stem1(key.slice(cut + 1)))) return null;
  if (BED_LAYER.test(key)) return null;

  const layers = await entityLayers(version);
  const siblings = [...layers.keys()].filter(k => !k.includes('/') && k.startsWith(stem + '_')
    && PIECE_WORDS.has(stem1(k.slice(stem.length + 1))));
  if (siblings.length < 2) return null;
  // They have to belong to the same block, which means the same space.
  if (!siblings.every(k => layers.get(k) && layers.get(k).blockSpace)) return null;

  const st = await stackFor({ profileId, version, overrides });
  const tx = st ? st.textures : null;
  if (!tx) return null;

  const elements = [];
  const textures = {};
  let slot = 0;
  for (const k of siblings.sort()) {
    const L = layers.get(k);
    const hit = await entityTextureFile(tx, k, k === key ? texture : null, layers);
    if (!hit) continue;
    textures[slot] = { url: hit.url, width: L.texWidth, height: L.texHeight, frames: 1 };
    const ref = '#' + slot;
    slot++;
    for (const el of L.elements) {
      elements.push({
        ...el, group: k.slice(stem.length + 1),
        faces: Object.fromEntries(
          Object.entries(el.faces || {}).map(([d, f]) => [d, { ...f, texture: ref }])),
      });
    }
  }
  if (!elements.length || slot < 2) return null;

  return {
    kind: 'elements', space: 'block', elements, textures, rotY: 0,
    texture: null, layer: name, variantKey: null, variants: [],
    parts: siblings.map(k => ({ key: k.slice(stem.length + 1), label: k.slice(stem.length + 1).replace(/_/g, ' '),
      n: elements.filter(e => e.group === k.slice(stem.length + 1)).length })).filter(g => g.n),
  };
}

// A mob's layers include things it is only sometimes wearing. A creeper's
// `armor` is the charge that a lightning strike leaves on it; a drowned's
// `outer` is its clothes and seaweed, which it always has. Both are extra
// layers over the same boxes and nothing in the data tells them apart -- what
// decides it in the game is a condition in Java, checked per frame.
//
// So this is a short, deliberate list rather than a mechanism, in the same
// spirit as the mobs whose rest pose is misleading: the words that mean "only
// under some condition". Anything not named here is taken to be part of the
// mob and is drawn. Being off is only a default; every one of them is a switch
// in the adjust dialog either way.
const SOMETIMES = new Set([
  'armor', 'armour', 'crackiness', 'charge', 'charged', 'powered', 'trim',
  'invulnerable', 'exploding', 'melting', 'angry', 'shadow', 'saddle',
  'harness', 'decor', 'ropes', 'carpet', 'chest',
]);
const worn = (label) => !String(label).split(/[\s_/]+/).some(w => SOMETIMES.has(w.toLowerCase()));

// The two sheets the game does not draw as a skin.
//
// A charged creeper's crackle and the wither's shield are the game's "energy
// swirl": the texture is scrolled across the mob and added to what is behind
// it, so it is a glow over the mob rather than paint on it. Neither sheet is
// unwrapped to the model at all -- wither_armor.png is a scatter of little
// skull faces over the whole square -- so drawing it as a skin put a skull on
// the wither's head and called it armour.
//
// The game has the same two and no more (its CreeperPowerLayer and
// WitherArmorLayer, the only two EnergySwirlLayers), and nothing in the assets
// separates them from an ordinary overlay, so they are named here as well.
const SWIRLS = /\/(creeper_armor|wither_armor)\.png$/;

async function entityTextureFile(stack, name, wantPath, layers) {
  if (!stack) return null;
  const take = async (p) => {
    const hit = await stack.get(p);
    return hit ? { url: asDataUrl(hit.buf), path: p } : null;
  };
  if (wantPath) {
    const got = await take(wantPath);
    if (got) return got;
  }
  const choices = await entityTextureChoices(stack, name, layers);
  for (const c of choices) {
    const got = await take(c.path);
    if (got) return { ...got, choices };
  }
  return null;
}


// ── The version's own icon ──────────────────────────────────────────────────
const iconCacheFile = (version) =>
  path.join(DEPS.dataDir, 'cache', 'version-icons', `${String(version).replace(/[^\w.\-]/g, '_')}.png`);

/**
 * What a version's default instance icon should be.
 *
 * Answers either a finished picture (`dataUrl`), when one has been rendered
 * before, or the model to draw and what to draw it with. The renderer sends
 * the result back through storeVersionIcon so the next instance created on
 * that version costs nothing.
 */
export async function versionIcon({ version, profileId = null }) {
  const r = await VI.resolveVersionIcon(version);
  if (r.kind !== 'model') return r;

  try {
    const cached = await fsp.readFile(iconCacheFile(version));
    return { ...r, dataUrl: 'data:image/png;base64,' + cached.toString('base64') };
  } catch { /* not rendered yet */ }

  const id = r.modelKind === 'item'
    ? `minecraft:item/${r.name}`
    : `minecraft:${r.name}`;
  const desc = await describeModel({ profileId, version, id });
  if (desc.error && r.modelKind === 'item') {
    // 1.21.4 moved item models behind a definition file; follow it.
    const st = await stackFor({ profileId, version });
    const def = st && await st.models.json(MA.itemDefPath(`minecraft:${r.name}`));
    const via = def && MA.modelFromItemDef(def);
    if (via && (via.model || via.base)) {
      const second = await describeModel({ profileId, version, id: via.model || via.base });
      if (!second.error) return { ...r, draw: second };
    }
  }
  if (desc.error) return { ...r, kind: 'release', reason: desc.error };
  return { ...r, draw: desc };
}

/**
 * The six panorama faces out of a version's own files.
 *
 * The usual place for these is the asset index, where they are hashed objects
 * downloaded from Mojang. Before 1.13 there was no such entry -- the faces
 * were in the jar -- which is why older versions reported "asset index has no
 * panorama_0" and showed nothing. The jar is where to look then.
 *
 * Modern jars DO have files at that path, but they are 1x1 grey placeholders
 * (69 bytes), so anything that small is not an answer.
 */
export async function panoramaFromFiles({ profileId, version }) {
  const st = await stackFor({ profileId, version, overrides: true });
  if (!st) return null;
  // The version's OWN files, not the texture stack: below 1.14 that stack
  // reads out of the 1.13 jar first, so every old version was handed 1.13's
  // title screen instead of its own. The borrow is there for blocks and items
  // that 1.13 renamed; the title screen's path never moved.
  const out = [];
  for (let i = 0; i < 6; i++) {
    const hit = await st.models.get(
      `assets/minecraft/textures/gui/title/background/panorama_${i}.png`);
    if (!hit) return null;
    const size = MA.pngSize(hit.buf);
    if (!size || size.width < 16 || size.height < 16) return null;   // a placeholder
    out.push(hit.buf);
  }
  return out.length === 6 ? out : null;
}

// ── Thumbnails ──────────────────────────────────────────────────────────────
// Rendering a grid of models costs a WebGL pass each, and the picker is opened
// over and over. The renderer hands back what it drew and gets it straight
// from disk next time, which is what stops the picker filling in slowly every
// single time it is opened.
const thumbFile = (key) =>
  path.join(DEPS.dataDir, 'cache', 'model-thumbs', String(key).replace(/[^\w.\-]/g, '_').slice(0, 180) + '.png');

export async function thumbGet({ key }) {
  try {
    const buf = await fsp.readFile(thumbFile(key));
    return 'data:image/png;base64,' + buf.toString('base64');
  } catch { return null; }
}
export async function thumbMany({ keys }) {
  const out = {};
  await Promise.all((keys || []).slice(0, 400).map(async (k) => { out[k] = await thumbGet({ key: k }); }));
  return out;
}
export async function thumbPut({ key, dataUrl }) {
  const m = /^data:image\/png;base64,(.+)$/.exec(String(dataUrl || ''));
  if (!m || !key) return { success: false };
  try {
    const f = thumbFile(key);
    await fsp.mkdir(path.dirname(f), { recursive: true });
    await fsp.writeFile(f, Buffer.from(m[1], 'base64'));
    return { success: true };
  } catch { return { success: false }; }
}

export async function storeVersionIcon({ version, dataUrl }) {
  const m = /^data:image\/png;base64,(.+)$/.exec(String(dataUrl || ''));
  if (!m) return { success: false };
  try {
    const f = iconCacheFile(version);
    await fsp.mkdir(path.dirname(f), { recursive: true });
    await fsp.writeFile(f, Buffer.from(m[1], 'base64'));
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err && err.message || err) };
  }
}

export { VI as versionIcons, MA as modelAssets };
