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
  MA.configure({ dataDir: deps.dataDir, log: deps.log });
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
const _stacks = new Map();
export async function stackFor({ profileId = null, version } = {}) {
  const key = `${profileId == null ? '-' : profileId}|${version || '-'}`;
  const hit = _stacks.get(key);
  if (hit && Date.now() - hit.at < STACK_TTL) return hit.value;

  const value = await (async () => {
    const jar = await jarSource(version);
    const own = await instanceSources(profileId);
    const sources = [...own, jar].filter(Boolean);
    if (!sources.length) return null;
    const models = MA.makeStack(sources);

    // Pre-1.14 reads its textures out of the 1.13 jar, with the version's own
    // behind it for anything 1.13 renamed. Both are aliased so a model asking
    // for "blocks/stone" finds "block/stone".
    let textures = models;
    if (version && !atLeast(version, FLATTENING)) {
      const legacy = await jarSource(LEGACY_TEXTURE_VERSION);
      textures = MA.makeStack([
        ...own,
        MA.legacyTextureAlias(legacy),
        MA.legacyTextureAlias(jar),
      ].filter(Boolean));
    }
    return { models, textures, index: MA.indexStack(models), version, profileId };
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

/** A block or item model, ready to render. */
export async function describeModel({ profileId, version, id, state }) {
  const st = await stackFor({ profileId, version });
  if (!st) return { error: 'no assets for this version yet' };

  let modelId = id, rotX = 0, rotY = 0, uvlock = false, chosen = null;
  // "minecraft:stone" with no folder means a BLOCK, through its blockstate.
  if (!/\/(block|item)\//.test(id) && !/^[^:]*:?(block|item)\//.test(id)) {
    const states = await MA.blockStates(st.models, id);
    if (states && states.length) {
      const pick = state != null
        ? (states.find(s => s.state === state) || await MA.chooseState(st.models, states))
        : await MA.chooseState(st.models, states);
      chosen = pick;
      modelId = pick.parts[0].model;
      rotX = pick.parts[0].x || 0;
      rotY = pick.parts[0].y || 0;
      uvlock = !!pick.parts[0].uvlock;
    }
  }

  const flat = await MA.renderableModel(st.models, modelId);
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
  };
}

/** Every state a block has, for the picker's state chooser. */
export async function modelStates({ profileId, version, id }) {
  const st = await stackFor({ profileId, version });
  if (!st) return [];
  const states = await MA.blockStates(st.models, id);
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
export async function listModels({ profileId, version, query = '', kinds = null, limit = 200, offset = 0 }) {
  const st = await stackFor({ profileId, version });
  if (!st) return { items: [], total: 0 };
  const want = new Set(kinds && kinds.length ? kinds : ['block', 'item', 'entity']);
  const q = String(query || '').trim().toLowerCase();

  const items = [];
  if (want.has('block')) {
    for (const s of st.index.states.values()) {
      items.push({ kind: 'block', id: s.id, name: s.name, ns: s.ns, from: s.from });
    }
  }
  if (want.has('item')) {
    // Both spellings of an item: the model, and 1.21.4's definition file.
    const seen = new Set();
    for (const m of st.index.models.values()) {
      if (m.kind !== 'item') continue;
      if (MA.looksLikeTemplate(m.name)) continue;
      seen.add(`${m.ns}:${m.name}`);
      items.push({ kind: 'item', id: m.id, name: m.name, ns: m.ns, from: m.from });
    }
    for (const d of st.index.items.values()) {
      if (seen.has(`${d.ns}:${d.name}`)) continue;
      items.push({ kind: 'item', id: `${d.ns}:item/${d.name}`, name: d.name, ns: d.ns, from: d.from });
    }
  }
  if (want.has('entity')) {
    const ents = await entityLayers(version);
    for (const name of ents.keys()) {
      // `breeze/eyes` is not an entity, it is part of the breeze -- and it is
      // drawn with it now, so listing it separately was offering a mob's eyes
      // as a thing to pick.
      if (name.includes('/')) continue;
      items.push({ kind: 'entity', id: 'entity:' + name, name, ns: 'minecraft', from: 'client jar' });
    }
  }

  const match = q
    ? items.filter(it => it.name.toLowerCase().includes(q) || it.ns.toLowerCase().includes(q))
    : items;
  // Shortest name first for a query, so "stone" puts stone above
  // stone_brick_stairs; alphabetical otherwise.
  match.sort((a, b) => (q ? a.name.length - b.name.length : 0) || a.ns.localeCompare(b.ns) || a.name.localeCompare(b.name));
  return { items: match.slice(offset, offset + limit), total: match.length };
}

const _layerCache = new Map();
async function entityLayers(version) {
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

export async function describeEntity({ profileId, version, name, texture }) {
  const layers = await entityLayers(version);
  const L = layers.get(name);
  if (!L) return { error: `no entity layer called ${name}` };
  const st = await stackFor({ profileId, version });
  const tx = st ? st.textures : null;
  const tex0 = await entityTextureFile(tx, name, texture);
  if (!tex0) return { error: `no texture for ${name}` };

  const elements = L.elements.slice();
  const textures = { 0: { url: tex0.url, width: L.texWidth, height: L.texHeight, frames: 1 } };
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
  const parts = [...layers.keys()].filter(k => k.startsWith(name + '/'));
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
    const pt = await entityTextureFile(tx, key);
    textures[slot] = { url: (pt || tex0).url, width: part.texWidth, height: part.texHeight, frames: 1 };
    const ref = '#' + slot;
    slot++;
    for (const el of part.elements) {
      elements.push({ ...el, group: key, faces: Object.fromEntries(
        Object.entries(el.faces).map(([d, f]) => [d, { ...f, texture: ref }])) });
    }
  }

  // What it is made of, so whoever is looking at it can switch a part off
  // when the game would not have drawn it. There is no data here that says
  // which parts the game hides while a mob stands still -- an armadillo has
  // the ball it rolls into, an evoker has both sets of arms -- so rather than
  // guess, everything is drawn and the parts are named.
  const groups = [{ key: '', label: 'Body', n: L.elements.length }];
  for (const key of parts) {
    const n = elements.filter(el => el.group === key).length;
    if (n) groups.push({ key, label: key.slice(name.length + 1).replace(/[_/]+/g, ' '), n });
  }

  return {
    kind: 'elements', space: 'entity', elements, textures, rotY: 180,
    // Which skin this is wearing, and the others it could be: a cow is six
    // textures on one model, a cushion sixteen.
    texture: tex0.path,
    variants: (tex0.choices || []).map(c => ({ path: c.path, label: c.label })),
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
const words = (s) => String(s).toLowerCase().split(/[_/]+/).filter(Boolean);
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
async function entityTextureChoices(stack, name) {
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

    let score = -1;
    if (fname === stem) score = 100;
    else if (fname === squashed) score = 96;
    else if (sameWords(fname, stem)) score = 92;                 // guardian_elder
    else if (fw.length > bare.size && [...bare].every(w => fw.includes(w))) score = 70;  // cow_temperate
    // The folder is named after the entity even when the file is not:
    // `enderdragon/dragon.png`, which matches nothing by name at all.
    else if (folder === stem || folder === squashed) score = 50 - fw.length;
    if (score < 0) continue;

    // A sub-layer (breeze/eyes) wants the parent's texture with that word on
    // it; the parent itself wants the one without.
    const isOverlay = extra.some(w => OVERLAY_WORDS.has(w));
    if (sub) {
      const subWords = words(sub);
      if (!subWords.every(w => fw.includes(w))) continue;
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

    const label = extra.filter(w => w !== 'baby').join(' ') || fname.replace(/_/g, ' ');
    scored.push({ path: p, label, score });
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scored;
}

const asDataUrl = (buf) => 'data:image/png;base64,' + buf.toString('base64');

async function entityTextureFile(stack, name, wantPath) {
  if (!stack) return null;
  const take = async (p) => {
    const hit = await stack.get(p);
    return hit ? { url: asDataUrl(hit.buf), path: p } : null;
  };
  if (wantPath) {
    const got = await take(wantPath);
    if (got) return got;
  }
  const choices = await entityTextureChoices(stack, name);
  for (const c of choices) {
    const got = await take(c.path);
    if (got) return { ...got, choices };
  }
  return null;
}

async function entityTexture(stack, name) {
  const f = await entityTextureFile(stack, name);
  return f ? f.url : null;
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
