/**
 * Minecraft block and item models, read out of whatever an instance actually
 * has — its resource packs, its mods, and the client jar — and flattened into
 * something a renderer can draw without knowing anything about Minecraft's
 * model format.
 *
 * Nothing here renders. The output of flattenModel() is a plain description
 * (boxes, per-face textures, per-face UVs) that frontend/blockrender.js turns
 * into an isometric PNG. The split is deliberate: reading zips and walking
 * parent chains is a Node job, and drawing textured boxes is a WebGL job, and
 * the renderer process already has three.js loaded.
 *
 * The three things worth knowing about the format:
 *
 *   - A model is a chain. `parent` points at another model, and the chain ends
 *     at one that declares `elements` (the boxes) — or at `builtin/generated`,
 *     which means "this is a flat item sprite, stack its layer textures".
 *     `textures` entries merge down the chain, child over parent, and a value
 *     of "#name" is a reference to another entry in the merged map.
 *   - Textures are addressed by id ("minecraft:block/stone"), not by path, and
 *     an id with no namespace means minecraft. An animated texture is a
 *     vertical strip of square frames, so a still picture of one is its top
 *     square.
 *   - Which model a BLOCK uses is a second lookup: blockstates/<name>.json maps
 *     each state ("axis=y", "facing=north,half=top", or "" for a block with one
 *     state) to a model plus an x/y rotation.
 *
 * Sources are stacked in the order the game stacks them — enabled resource
 * packs first, in their own order, then mods, then the jar — so a pack or a mod
 * that replaces a model wins, which is what makes "support per instance modded
 * / resourcepacked models" fall out rather than being a special case.
 */
import fs from 'fs';
import path from 'path';
import unzipper from 'unzipper';
import { Readable } from 'stream';

const fsp = fs.promises;

let DATA_DIR = null;
let LOG = () => { };
export function configure({ dataDir, log } = {}) {
  if (dataDir) DATA_DIR = dataDir;
  if (log) LOG = log;
}

// ── Where a downloaded client jar is kept ───────────────────────────────────
// The default-skins build downloads the latest release's jar anyway; keeping it
// means the icon renderer has one to read without downloading it twice.
export function jarCacheDir() { return path.join(DATA_DIR, 'cache', 'jars'); }
export function cachedJarPath(version) {
  return path.join(jarCacheDir(), `${String(version).replace(/[^\w.\-]/g, '_')}.jar`);
}

// ── Sources ─────────────────────────────────────────────────────────────────
// A source answers two questions: "do you have this asset path" and "what asset
// paths do you have". Both are needed — flattening walks specific paths, and the
// picker's grid needs the whole list.

function zipSourceFromDirectory(label, kind, dir) {
  const files = new Map();
  for (const e of (dir.files || [])) {
    if (e.type === 'Directory') continue;
    files.set(e.path.replace(/\\/g, '/'), e);
  }
  return {
    label, kind,
    async get(assetPath) {
      const e = files.get(assetPath);
      if (!e) return null;
      try { return await e.buffer(); } catch { return null; }
    },
    list() { return [...files.keys()]; },
  };
}

export async function zipSource(label, kind, file) {
  let dir;
  try { dir = await unzipper.Open.file(file); } catch (err) {
    LOG(`model assets: could not open ${label}: ${err && err.message}`);
    return null;
  }
  return zipSourceFromDirectory(label, kind, dir);
}

// A zip read over HTTP with range requests. A client jar is 25-40 MB and the
// handful of model and texture files wanted out of it come to a few hundred
// kilobytes, so downloading the whole thing to read six files is the wrong
// trade — unless it is going to be read a lot, which is what the disk cache is
// for.
export async function remoteZipSource(label, kind, url) {
  const source = {
    async size() {
      // A HEAD is enough for the length, and some CDNs answer a ranged GET
      // without one.
      const r = await fetch(url, { method: 'HEAD' });
      if (!r.ok) throw new Error(`HEAD ${url}: HTTP ${r.status}`);
      const len = Number(r.headers.get('content-length'));
      if (!len) throw new Error('no content-length');
      return len;
    },
    stream(offset, length) {
      // No length means "to the end of the file", which is what an open-ended
      // Range header says. unzipper only does that for the tail and the central
      // directory, both of which are at the end, so it stays a small read.
      const end = length ? offset + length - 1 : '';
      // unzipper wants a stream now and the bytes later.
      const out = new Readable({ read() { } });
      fetch(url, { headers: { range: `bytes=${offset}-${end}` } })
        .then(async (r) => {
          if (!r.ok && r.status !== 206 && r.status !== 200) {
            throw new Error(`range ${offset}-${end}: HTTP ${r.status}`);
          }
          out.push(Buffer.from(await r.arrayBuffer()));
          out.push(null);
        })
        .catch(err => out.destroy(err));
      return out;
    },
  };
  let dir;
  try { dir = await unzipper.Open.custom(source); } catch (err) {
    LOG(`model assets: could not open ${label} over HTTP: ${err && err.message}`);
    return null;
  }
  return zipSourceFromDirectory(label, kind, dir);
}

// A resource pack that was extracted into a folder rather than left zipped.
export function dirSource(label, kind, root) {
  let cache = null;
  const walk = (rel) => {
    const out = [];
    let entries = [];
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      const next = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) out.push(...walk(next));
      else out.push(next);
    }
    return out;
  };
  return {
    label, kind,
    async get(assetPath) {
      // No traversal out of the pack, however odd the id that got here.
      const p = path.resolve(root, ...assetPath.split('/'));
      if (!p.startsWith(path.resolve(root))) return null;
      try { return await fsp.readFile(p); } catch { return null; }
    },
    list() {
      if (!cache) cache = walk('');
      return cache;
    },
  };
}

/**
 * A source that also answers the pre-1.13 spelling of a texture path.
 *
 * 1.13 renamed the texture folders: textures/blocks -> textures/block and
 * textures/items -> textures/item. A 1.9 model asks for "blocks/prismarine",
 * so reading its textures out of the 1.13 jar — which is what gives every
 * pre-1.14 version the pre-1.14 art from one download — needs the old spelling
 * translated to the new one. The original path is tried first, so this never
 * changes what a jar of the right vintage answers.
 */
export function legacyTextureAlias(source) {
  if (!source) return null;
  const alias = (p) => p
    .replace('/textures/blocks/', '/textures/block/')
    .replace('/textures/items/', '/textures/item/');
  let names = null;
  return {
    label: source.label, kind: source.kind,
    async get(assetPath) {
      const hit = await source.get(assetPath);
      if (hit) return hit;
      const other = alias(assetPath);
      return other === assetPath ? null : source.get(other);
    },
    list() {
      if (names) return names;
      // Listed under BOTH spellings, so an index built over this source finds
      // what either vintage would ask for.
      const base = source.list();
      const extra = [];
      for (const p of base) {
        const back = p
          .replace('/textures/block/', '/textures/blocks/')
          .replace('/textures/item/', '/textures/items/');
        if (back !== p) extra.push(back);
      }
      names = base.concat(extra);
      return names;
    },
  };
}

// ── A stack of sources ──────────────────────────────────────────────────────
export function makeStack(sources) {
  const live = sources.filter(Boolean);
  const memo = new Map();
  return {
    sources: live,
    // First source that has it wins, which is the override order.
    async get(assetPath) {
      if (memo.has(assetPath)) return memo.get(assetPath);
      let found = null;
      for (const s of live) {
        const buf = await s.get(assetPath);
        if (buf) { found = { buf, from: s.label }; break; }
      }
      if (memo.size > 4000) memo.clear();
      memo.set(assetPath, found);
      return found;
    },
    async json(assetPath) {
      const hit = await this.get(assetPath);
      if (!hit) return null;
      try { return JSON.parse(hit.buf.toString('utf8')); } catch { return null; }
    },
  };
}

// ── Ids ─────────────────────────────────────────────────────────────────────
// "stone" -> minecraft:stone. "minecraft:block/stone" stays as it is. A leading
// slash or a "builtin/" prefix is left for the caller to notice.
export function splitId(id) {
  const s = String(id || '').replace(/^\//, '');
  const i = s.indexOf(':');
  return i < 0 ? { ns: 'minecraft', name: s } : { ns: s.slice(0, i) || 'minecraft', name: s.slice(i + 1) };
}
export const modelPath = (id) => {
  const { ns, name } = splitId(id);
  return `assets/${ns}/models/${name}.json`;
};
export const texturePath = (id) => {
  const { ns, name } = splitId(id);
  return `assets/${ns}/textures/${name}.png`;
};
export const blockstatePath = (id) => {
  const { ns, name } = splitId(id);
  return `assets/${ns}/blockstates/${name}.json`;
};
// 1.21.4 moved item models behind a definition file: assets/<ns>/items/<name>
// .json, whose `model` is a tree that can select on a block state, a condition
// or a numeric range before it names an actual model.
export const itemDefPath = (id) => {
  const { ns, name } = splitId(id);
  return `assets/${ns}/items/${name}.json`;
};

// The first concrete model in an item definition's tree. Which branch a real
// game would take depends on the item stack in hand, and for a picture any of
// them is an answer, so this takes the first one depth-first. `minecraft:special`
// models are drawn by Java code with no geometry in the assets at all; their
// `base` is a model that carries the display transforms and nothing else, so it
// is reported as `special` rather than pretended to be renderable.
export function modelFromItemDef(def) {
  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return null;
    seen.add(node);
    const type = String(node.type || '').replace(/^minecraft:/, '');
    if (type === 'model' && node.model) return { model: node.model };
    if (type === 'special') return { special: true, base: node.base || null };
    // select / condition / range_dispatch / composite / bundle_selected_item…
    for (const key of ['cases', 'entries', 'models']) {
      for (const child of (Array.isArray(node[key]) ? node[key] : [])) {
        const hit = walk(child && child.model ? child.model : child);
        if (hit) return hit;
      }
    }
    for (const key of ['on_true', 'on_false', 'fallback', 'model']) {
      const hit = walk(node[key]);
      if (hit) return hit;
    }
    return null;
  };
  return walk(def && def.model) || null;
}

// ── Flattening a model ──────────────────────────────────────────────────────
const MAX_PARENTS = 16;   // a real chain is 2-4 deep; this is a loop guard

// Resolve "#ref" chains inside a merged texture map. A broken or circular
// reference resolves to null rather than looping.
function resolveTextureRefs(map) {
  const out = {};
  for (const key of Object.keys(map)) {
    let v = map[key], hops = 0;
    while (typeof v === 'string' && v.startsWith('#') && hops++ < MAX_PARENTS) v = map[v.slice(1)];
    out[key] = (typeof v === 'string' && !v.startsWith('#')) ? v : null;
  }
  return out;
}

/**
 * Walk a model's parent chain and merge it into one description.
 *
 * Returns { kind: 'elements' | 'layers' | 'unrenderable', elements, textures,
 *           layers, chain, guiLight }, where `textures` maps each key to a
 *           texture ID (not yet to pixels).
 */
export async function flattenModelJson(stack, id) {
  const chain = [];
  const textures = {};
  let elements = null, guiLight = null, display = null, builtin = null;
  let cursor = id;

  for (let i = 0; i < MAX_PARENTS && cursor; i++) {
    const { ns, name } = splitId(cursor);
    // builtin/generated and builtin/entity are not files; they are markers.
    if (name.startsWith('builtin/')) { builtin = name.slice('builtin/'.length); break; }
    const json = await stack.json(modelPath(cursor));
    if (!json) { chain.push({ id: `${ns}:${name}`, missing: true }); break; }
    chain.push({ id: `${ns}:${name}` });
    // A child's entry wins, so only write what is not already set.
    for (const [k, v] of Object.entries(json.textures || {})) {
      if (!(k in textures)) textures[k] = v;
    }
    // Nearest definition wins outright — elements are not merged.
    if (!elements && Array.isArray(json.elements)) elements = json.elements;
    if (guiLight == null && json.gui_light) guiLight = json.gui_light;
    if (!display && json.display) display = json.display;
    cursor = json.parent || null;
  }

  const resolved = resolveTextureRefs(textures);

  // item/generated and its relatives are flat sprites: layer0 over layer1 over…
  const layerKeys = Object.keys(resolved).filter(k => /^layer\d+$/.test(k))
    .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
  if (!elements && layerKeys.length) {
    return {
      kind: 'layers',
      layers: layerKeys.map(k => resolved[k]).filter(Boolean),
      textures: resolved, chain, guiLight, display, builtin,
    };
  }
  if (!elements) {
    return { kind: 'unrenderable', textures: resolved, chain, guiLight, display, builtin };
  }
  return { kind: 'elements', elements, textures: resolved, chain, guiLight, display, builtin };
}

// A plain 16x16x16 box with one texture on every face: what a block looks like
// when the only thing the assets say about it is its particle colour.
const FULL_CUBE = [{
  from: [0, 0, 0], to: [16, 16, 16],
  faces: {
    down: { texture: '#all', cullface: 'down' },
    up: { texture: '#all', cullface: 'up' },
    north: { texture: '#all', cullface: 'north' },
    south: { texture: '#all', cullface: 'south' },
    west: { texture: '#all', cullface: 'west' },
    east: { texture: '#all', cullface: 'east' },
  },
}];

/**
 * flattenModelJson, plus a usable answer for the models that have no geometry.
 *
 * A fair few blocks are drawn by Java code rather than by their model — chests,
 * signs, beds, banners, and newer ones like the copper golem statue, whose model
 * file is literally `{"textures": {"particle": "minecraft:block/copper_block"}}`.
 * There is no geometry in the assets to find, so rather than giving up, those
 * are drawn as a plain cube of their particle texture, which is the colour the
 * game itself uses for them when it needs one. `approximated` says so, so a
 * caller can label it or prefer something else.
 */
export async function renderableModel(stack, id) {
  const flat = await flattenModelJson(stack, id);
  if (flat.kind === 'elements' || flat.kind === 'layers') return flat;
  const particle = flat.textures && flat.textures.particle;
  if (particle) {
    return {
      ...flat,
      kind: 'elements',
      approximated: true,
      elements: FULL_CUBE,
      textures: { ...flat.textures, all: particle },
    };
  }
  return flat;
}

// ── Textures ────────────────────────────────────────────────────────────────
// A PNG's size lives at bytes 16..24.
export function pngSize(buf) {
  try {
    if (!buf || buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50) return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } catch { return null; }
}

/**
 * Every texture a flattened model needs, as data URLs.
 *
 * An animated texture is a vertical strip of square frames (plus a .mcmeta
 * saying so), and a still picture of one is its FIRST frame — so the strip's
 * height is reported alongside it and the renderer takes the top square. Doing
 * the crop here would mean decoding and re-encoding every texture in the main
 * process; a UV scale in the renderer is free.
 */
export async function loadTextures(stack, ids) {
  const out = {};
  for (const id of new Set(ids.filter(Boolean))) {
    const hit = await stack.get(texturePath(id));
    if (!hit) { out[id] = null; continue; }
    const size = pngSize(hit.buf);
    if (!size || !size.width) { out[id] = null; continue; }
    // frames = 1 for an ordinary square texture.
    const frames = (size.height % size.width === 0) ? (size.height / size.width) : 1;
    out[id] = {
      url: 'data:image/png;base64,' + hit.buf.toString('base64'),
      width: size.width, height: size.height, frames,
      from: hit.from,
    };
  }
  return out;
}

// ── Blockstates ─────────────────────────────────────────────────────────────
/**
 * The models a block's states map to.
 *
 * `variants` is the common form: a map of state string -> model (or a weighted
 * list of models, of which the first is as good an answer as any for a still
 * picture). `multipart` is the other: a list of pieces, each applied when a
 * condition holds. For a picture, the pieces with NO condition are the ones
 * always present, and if every piece is conditional the first one is taken so
 * that something is shown.
 *
 * Returns [{ state, parts: [{ model, x, y, uvlock }] }].
 */
// Before 1.13 a blockstate named its model with no folder — "prismarine_rough",
// not "block/prismarine" — and the game put it under block/ for you. So a bare
// name here is a block model, and anything with a slash is already a path.
export function blockstateModelId(model) {
  const { ns, name } = splitId(model);
  return name.includes('/') ? `${ns}:${name}` : `${ns}:block/${name}`;
}

export async function blockStates(stack, blockId) {
  const json = await stack.json(blockstatePath(blockId));
  if (!json) return null;
  const one = (v) => {
    const pick = Array.isArray(v) ? v[0] : v;
    if (!pick || !pick.model) return null;
    return { model: blockstateModelId(pick.model), x: pick.x || 0, y: pick.y || 0, uvlock: !!pick.uvlock };
  };
  if (json.variants && typeof json.variants === 'object') {
    const out = [];
    for (const [state, v] of Object.entries(json.variants)) {
      const p = one(v);
      if (p) out.push({ state, parts: [p] });
    }
    return out.length ? out : null;
  }
  if (Array.isArray(json.multipart)) {
    const always = json.multipart.filter(p => !p.when).map(p => one(p.apply)).filter(Boolean);
    const parts = always.length ? always : [one(json.multipart[0].apply)].filter(Boolean);
    return parts.length ? [{ state: '', parts }] : null;
  }
  return null;
}

// ── Indexing what a stack holds ─────────────────────────────────────────────
const MODEL_RE = /^assets\/([a-z0-9_.-]+)\/models\/(block|item)\/(.+)\.json$/;
const STATE_RE = /^assets\/([a-z0-9_.-]+)\/blockstates\/(.+)\.json$/;
const ITEMDEF_RE = /^assets\/([a-z0-9_.-]+)\/items\/(.+)\.json$/;

/**
 * Every model and every blockstate the stack can offer, deduped so that the
 * highest-priority source's copy is the one listed.
 *
 * Models whose name says they are not meant to be looked at on their own are
 * left out: the template models under block/ that exist only to be inherited
 * from, and the item models that are only a parent.
 */
const TEMPLATE_RE = /(^|\/)(template_|_template$|cube$|cube_all$|cube_column$|cube_mirrored|orientable$|cross$|generated$|handheld|thin_block$|block$|air$)/;

export function indexStack(stack) {
  const models = new Map();     // "ns:block/stone" -> { id, ns, kind, name, from }
  const states = new Map();     // "ns:stone"       -> { id, ns, name, from }
  const items = new Map();      // "ns:stone"       -> { id, ns, name, from }
  // Lowest priority first, so a higher-priority source overwrites it.
  for (const s of [...stack.sources].reverse()) {
    let names = [];
    try { names = s.list(); } catch { continue; }
    for (const p of names) {
      const m = MODEL_RE.exec(p);
      if (m) {
        const id = `${m[1]}:${m[2]}/${m[3]}`;
        models.set(id, { id, ns: m[1], kind: m[2], name: m[3], from: s.label });
        continue;
      }
      const b = STATE_RE.exec(p);
      if (b) {
        const id = `${b[1]}:${b[2]}`;
        states.set(id, { id, ns: b[1], name: b[2], from: s.label });
        continue;
      }
      const d = ITEMDEF_RE.exec(p);
      if (d) {
        const id = `${d[1]}:${d[2]}`;
        items.set(id, { id, ns: d[1], name: d[2], from: s.label });
      }
    }
  }
  return { models, states, items };
}

export const looksLikeTemplate = (name) => TEMPLATE_RE.test(String(name || ''));
