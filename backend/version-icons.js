/**
 * Which block or item stands for a Minecraft version.
 *
 * A manually created instance used to get the generic launcher icon whatever
 * version it was. Instead its default should say which version it is, the way
 * the wiki's version pages do: the block or item that version is remembered
 * for, drawn as an isometric render.
 *
 * The mapping is data, not code — versions.json in this repository, fetched at
 * runtime so the list can grow without shipping a launcher build:
 *
 *   { "26.2": "block/sulfur", "1.21.11": "item/diamond_nautilus_armor", … }
 *
 * The rules around it:
 *
 *   - An entry applies to every LATER version until another entry takes over,
 *     so 1.21.10 (not listed) uses 1.21.9's.
 *   - Unless the entry is much older than the version being resolved. A
 *     release half a year on from the newest listed entry is from a different
 *     era, and showing that era's block for it is worse than showing nothing
 *     in particular, so it gets the plain release icon instead.
 *   - A snapshot gets the snapshot icon. It is not a version anyone is
 *     remembering a block for.
 *   - A version older than the first entry gets the old launcher icon. So do
 *     versions before 1.8, which have no model system to render from at all.
 *
 * Ordering is by version number rather than by release date, so an entry for a
 * version that is not out yet (versions.json currently names 26.4, which the
 * manifest has only as snapshots) still sits in the right place. Release dates
 * are used for the staleness rule, which is the one thing that genuinely needs
 * them, and the rule simply does not fire when a date is unknown.
 */
import fs from 'fs';
import path from 'path';

const fsp = fs.promises;

const VERSIONS_JSON_URL =
  'https://raw.githubusercontent.com/TGGamesYT/redstone-launcher/main/versions.json';
const MANIFEST_URL = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json';

// Re-read the list this often. It changes when a Minecraft version ships, so
// once a day is far more often than it needs.
const LIST_TTL = 24 * 60 * 60 * 1000;
// How far behind the version being resolved the newest listed entry may be
// before its block stops being a fair answer. Half a year, as asked.
export const STALE_AFTER_MS = 183 * 24 * 60 * 60 * 1000;
// Models and blockstates arrived in 1.8. Below that there is nothing to render.
const FIRST_MODELLED = '1.8';

let DATA_DIR = null;
let LOG = () => { };
export function configure({ dataDir, log } = {}) {
  if (dataDir) DATA_DIR = dataDir;
  if (log) LOG = log;
}
const cacheFile = () => path.join(DATA_DIR, 'cache', 'versions.json');

// ── Version numbers ─────────────────────────────────────────────────────────
// Compares the numeric part and nothing else: "1.21.9" < "1.21.11" < "26.1".
// A suffix ("-pre2", "-rc1", "w14a") is ignored here; isRelease decides whether
// the id is a release at all, and that is the only place a suffix matters.
export function versionParts(v) {
  const m = String(v || '').match(/^\d+(\.\d+)*/);
  return (m ? m[0] : '').split('.').filter(s => s !== '').map(Number);
}
export function compareVersions(a, b) {
  const x = versionParts(a), y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i] || 0, q = y[i] || 0;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}
// A release id is numbers and dots and nothing else. Mojang's manifest agrees
// almost always, but not quite — it files 1.5 under "snapshot" — so the shape
// of the id is the deciding test and the manifest only confirms it.
export function looksLikeRelease(v) {
  return /^\d+(\.\d+)*$/.test(String(v || '').trim());
}

// ── The list ────────────────────────────────────────────────────────────────
let _list = null;          // { at, entries: [{ version, kind, name, model }] }

function parseList(json) {
  const entries = [];
  for (const [version, model] of Object.entries(json || {})) {
    const m = /^(block|item)\/(.+)$/.exec(String(model || '').trim());
    if (!m) { LOG(`version icons: ignoring "${version}": "${model}" is not block/… or item/…`); continue; }
    entries.push({ version, kind: m[1], name: m[2], model: `${m[1]}/${m[2]}` });
  }
  // Oldest first, so "the newest entry at or before this version" is a scan
  // from the end.
  entries.sort((a, b) => compareVersions(a.version, b.version));
  return entries;
}

export async function versionList({ force = false } = {}) {
  if (!force && _list && Date.now() - _list.at < LIST_TTL) return _list.entries;
  // A cached copy first, so a launcher with no connection still gets icons.
  let cached = null;
  try { cached = JSON.parse(await fsp.readFile(cacheFile(), 'utf8')); } catch { /* none yet */ }
  try {
    const r = await fetch(VERSIONS_JSON_URL);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const json = await r.json();
    const entries = parseList(json);
    if (!entries.length) throw new Error('the list is empty');
    _list = { at: Date.now(), entries };
    try {
      await fsp.mkdir(path.dirname(cacheFile()), { recursive: true });
      await fsp.writeFile(cacheFile(), JSON.stringify(json));
    } catch { /* the cache is a bonus */ }
    return entries;
  } catch (err) {
    LOG(`version icons: could not fetch the list (${err && err.message})`);
    if (cached) {
      const entries = parseList(cached);
      // Not timestamped as fresh: a stale list should be retried, just not
      // before it has been useful once.
      if (entries.length) { _list = { at: Date.now() - LIST_TTL / 2, entries }; return entries; }
    }
    return [];
  }
}

// ── Mojang's manifest, for release dates and types ──────────────────────────
let _manifest = null;
export async function manifestIndex() {
  if (_manifest) return _manifest;
  try {
    const r = await fetch(MANIFEST_URL);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const by = new Map();
    for (const v of (j.versions || [])) {
      by.set(v.id, { id: v.id, type: v.type, url: v.url, at: Date.parse(v.releaseTime) || null });
    }
    _manifest = { by, latest: j.latest || {} };
  } catch (err) {
    LOG(`version icons: no version manifest (${err && err.message})`);
    _manifest = { by: new Map(), latest: {} };
  }
  return _manifest;
}

/**
 * Resolve a version to what its icon should be.
 *
 * Answers one of:
 *   { kind: 'model', model: 'block/sulfur', from: '26.2', ... }
 *   { kind: 'snapshot' }   — a snapshot, pre-release or release candidate
 *   { kind: 'release' }    — a release with no entry close enough to it
 *   { kind: 'legacy' }     — older than the first entry, or before 1.8
 * plus `reason`, which is there to be shown in a tooltip or a log rather than
 * guessed at.
 */
export async function resolveVersionIcon(version) {
  const v = String(version || '').trim();
  if (!v) return { kind: 'legacy', reason: 'no version given' };

  const [entries, manifest] = await Promise.all([versionList(), manifestIndex()]);
  const meta = manifest.by.get(v) || null;

  // Anything that is not plainly numbered is a snapshot, a pre-release or a
  // release candidate. The manifest can also say so for an id that looks
  // numbered but is not a release.
  if (!looksLikeRelease(v)) return { kind: 'snapshot', reason: `${v} is not a release` };

  if (compareVersions(v, FIRST_MODELLED) < 0) {
    return { kind: 'legacy', reason: `${v} is older than ${FIRST_MODELLED}, which is where block models start` };
  }

  if (!entries.length) return { kind: 'release', reason: 'no version list available' };

  // The newest entry at or before this version.
  let pick = null;
  for (const e of entries) {
    if (compareVersions(e.version, v) <= 0) pick = e; else break;
  }
  if (!pick) {
    return { kind: 'legacy', reason: `${v} is older than the first listed version (${entries[0].version})` };
  }

  // The staleness guard, which needs both dates and simply does not fire
  // without them.
  const pickMeta = manifest.by.get(pick.version);
  if (meta && meta.at && pickMeta && pickMeta.at) {
    const gap = meta.at - pickMeta.at;
    if (gap > STALE_AFTER_MS) {
      const days = Math.round(gap / (24 * 60 * 60 * 1000));
      return {
        kind: 'release',
        reason: `the newest listed version (${pick.version}) came out ${days} days before ${v}`,
        staleFrom: pick.version,
      };
    }
  }

  return {
    kind: 'model',
    model: pick.model,
    modelKind: pick.kind,
    name: pick.name,
    from: pick.version,
    exact: pick.version === v,
    reason: pick.version === v ? `${v} is listed` : `${v} carries forward from ${pick.version}`,
  };
}

/**
 * The versions a picker needs, in one answer.
 *
 *   releases    every release, newest first, with its date
 *   snapshots   every snapshot, pre-release and release candidate, newest first
 *   latest      Mojang's own { release, snapshot }
 *   next        the newest version named in versions.json — which may be one
 *               that is not out yet (the list is written ahead of a release),
 *               and is what the "latest snapshot" card borrows its icon from
 *
 * Ordering is by release date, because that is what the manifest is sorted by
 * and what "newest" means to somebody picking one.
 */
export async function pickerVersions() {
  const [entries, manifest] = await Promise.all([versionList(), manifestIndex()]);
  const releases = [], snapshots = [];
  for (const v of manifest.by.values()) {
    (v.type === 'release' ? releases : snapshots).push({ id: v.id, at: v.at, type: v.type });
  }
  const byDate = (a, b) => (b.at || 0) - (a.at || 0);
  releases.sort(byDate);
  snapshots.sort(byDate);
  return {
    releases, snapshots,
    latest: manifest.latest || {},
    next: entries.length ? entries[entries.length - 1].version : null,
  };
}
