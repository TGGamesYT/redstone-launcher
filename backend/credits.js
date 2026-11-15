// Who made the launcher, for the credits in Settings.
//
// Four sections:
//
//   - the founders, whose Minecraft uuids are written down here once (looked
//     up from their names when this was written) so their heads can be drawn
//     and their CURRENT Minecraft names shown, falling back to the names they
//     go by;
//   - everyone who has contributed to the launcher's repository, and
//   - everyone who has contributed to the website's, each ordered by how much
//     they added, most first -- GitHub's own per-author statistics;
//   - everything else, from credits.json in the launcher's repository, so a
//     credit can be added without a launcher release.
//
// Everything fetched is kept on disk for a day. GitHub allows sixty
// unauthenticated requests an hour from one address, and opening a dialog is
// not a reason to spend them.
import fs from "fs";
import path from "path";

export const FOUNDERS = [
  { uuid: "20bbb23e2f2246bab201c6bd435b445b", name: "TGdoesCode" },
  { uuid: "52af5540dd184ad99acb50eb11531180", name: "Muavees" },
];

export const REPOS = {
  launcher: "TGGamesYT/redstone-launcher",
  web: "TGGamesYT/redstone-launcher-web",
};

export const OTHER_CREDITS_URL =
  "https://raw.githubusercontent.com/TGGamesYT/redstone-launcher/main/credits.json";

const DAY = 24 * 60 * 60 * 1000;

/** A Minecraft uuid, with or without its dashes -- normalised, or null. */
export function asUuid(v) {
  const s = String(v == null ? "" : v).trim().toLowerCase();
  if (/^[0-9a-f]{32}$/.test(s)) return s;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)) return s.replace(/-/g, "");
  return null;
}

/**
 * credits.json, read into sections of people.
 *
 * Each top-level key is a section, and its value says who is in it in any of
 * three shapes:
 *
 *   "Section": { "Shown name": "uuid or a name", ... }
 *   "Section": ["uuid or a name", ...]
 *   "Section": "uuid or a name"
 *
 * A value that is a uuid (with or without dashes) is a Minecraft player: drawn
 * with their head and shown by their current name -- with the key, where
 * there is one, as the name to use if that cannot be found. A value that is
 * not a uuid is simply the name of whoever is credited, written out.
 */
export function readOtherCredits(json) {
  const sections = [];
  if (!json || typeof json !== "object" || Array.isArray(json)) return sections;
  const person = (value, label) => {
    const uuid = asUuid(value);
    if (uuid) return { uuid, name: label || null };
    const text = String(value == null ? "" : value).trim();
    return text ? { uuid: null, name: text } : (label ? { uuid: null, name: label } : null);
  };
  for (const [section, value] of Object.entries(json)) {
    const people = [];
    if (Array.isArray(value)) {
      for (const v of value) { const p = person(v, null); if (p) people.push(p); }
    } else if (value && typeof value === "object") {
      for (const [label, v] of Object.entries(value)) { const p = person(v, label); if (p) people.push(p); }
    } else {
      const p = person(value, null);
      if (p) people.push(p);
    }
    if (people.length) sections.push({ title: String(section), people });
  }
  return sections;
}

/**
 * Who contributed to a repository, most added first.
 *
 * GitHub's statistics say how many lines each author added, which is "how
 * much code" in the only sense GitHub records. The endpoint answers 202 while
 * it works the numbers out the first time it is asked, so it is asked a few
 * times; if it still has not got them, the plain contributor list -- ordered
 * by commits -- is the fallback rather than nothing.
 */
export async function repoContributors(repo, { fetchImpl = fetch, wait = (ms) => new Promise(r => setTimeout(r, ms)), tries = 5, token = null } = {}) {
  const headers = { "User-Agent": "redstone-launcher", Accept: "application/vnd.github+json" };
  // Signed in where the launcher can be: GitHub allows sixty requests an hour
  // to an address it does not know, which a shared network can use up
  // without this launcher having made any of them.
  if (token) headers.Authorization = `Bearer ${token}`;
  for (let i = 0; i < tries; i++) {
    let res;
    try { res = await fetchImpl(`https://api.github.com/repos/${repo}/stats/contributors`, { headers }); }
    catch { break; }
    if (res.status === 202) { await wait(1500 * (i + 1)); continue; }
    if (!res.ok) break;
    let list;
    try { list = await res.json(); } catch { break; }
    if (!Array.isArray(list)) break;
    return list
      .filter(c => c && c.author && c.author.type !== "Bot")
      .map(c => ({
        login: c.author.login,
        avatar: c.author.avatar_url || null,
        url: c.author.html_url || null,
        added: (c.weeks || []).reduce((n, w) => n + (Number(w.a) || 0), 0),
        commits: Number(c.total) || 0,
      }))
      .sort((a, b) => b.added - a.added || b.commits - a.commits);
  }
  // The fallback: who, without how many lines.
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/contributors?per_page=100`, { headers });
    if (!res.ok) return null;
    const list = await res.json();
    if (!Array.isArray(list)) return null;
    return list
      .filter(c => c && c.type !== "Bot")
      .map(c => ({ login: c.login, avatar: c.avatar_url || null, url: c.html_url || null, added: null, commits: Number(c.contributions) || 0 }))
      .sort((a, b) => b.commits - a.commits);
  } catch { return null; }
}

/**
 * Everything the credits dialog shows, from the cache if it is fresh enough.
 *
 * `nameOf(uuid)` gives a player's current Minecraft name or null; it is the
 * launcher's own, rate-limited lookup.
 */
export async function loadCredits({ cacheDir, nameOf, fetchImpl = fetch, fresh = false, token = null } = {}) {
  const file = cacheDir ? path.join(cacheDir, "credits-cache.json") : null;
  let cached = null;
  if (file) { try { cached = JSON.parse(fs.readFileSync(file, "utf8")); } catch { cached = null; } }
  if (!fresh && cached && Date.now() - (cached.at || 0) < DAY) return cached.data;

  const [launcher, web, otherJson] = await Promise.all([
    repoContributors(REPOS.launcher, { fetchImpl, token }),
    repoContributors(REPOS.web, { fetchImpl, token }),
    (async () => {
      try {
        const r = await fetchImpl(OTHER_CREDITS_URL, { headers: { "User-Agent": "redstone-launcher" } });
        return r.ok ? await r.json() : null;
      } catch { return null; }
    })(),
  ]);
  const other = readOtherCredits(otherJson);

  // Current names for everyone credited by uuid, the founders included.
  const named = async (p) => {
    if (!p.uuid || !nameOf) return p;
    let current = null;
    try { current = await nameOf(p.uuid); } catch { current = null; }
    return { ...p, name: current || p.name || p.uuid };
  };
  const founders = await Promise.all(FOUNDERS.map(named));
  for (const s of other) s.people = await Promise.all(s.people.map(named));

  const data = {
    founders,
    // What could not be had is null rather than empty, so the dialog can say
    // it could not be reached instead of claiming there is nobody.
    launcher: launcher || (cached && cached.data && cached.data.launcher) || null,
    web: web || (cached && cached.data && cached.data.web) || null,
    other: other.length ? other : ((cached && cached.data && cached.data.other) || []),
    repos: REPOS,
  };
  if (file) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ at: Date.now(), data }));
    } catch { /* the cache is a nicety */ }
  }
  return data;
}

export default { FOUNDERS, REPOS, OTHER_CREDITS_URL, asUuid, readOtherCredits, repoContributors, loadCredits };
