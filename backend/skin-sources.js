// Where a skin can come from when Mojang will not say.
//
// Mojang's session server goes down, and when it does it does not go down
// politely: it answers 200-looking HTML --
//
//   <title>Service unavailable</title>
//
// -- so a launcher that only asks Mojang has nothing, and the obvious thing
// to draw is the default skin. Which is also exactly what an account with no
// custom skin looks like, so the launcher tells you nothing is wrong while
// every premium account on it wears Steve. That was reported, and "have a
// fallback, not just the default" is the right answer.
//
// ── what counts as a fallback ──
//
// Not any source. The launcher used to point an <img> straight at
// minotar.net and mc-heads.net and was moved off them for a reason worth
// keeping in mind: when those services throttle, they answer 200 with a
// default skin rather than an error. A fallback that lies is worse than one
// that fails, because the lie is indistinguishable from an answer.
//
// So nothing here is trusted on its word. Every answer is checked for
// actually being a Minecraft skin sheet, and one that turns out to BE a
// default is passed on as unsure -- drawn, because it is the best picture
// there is, but never recorded as what this player looks like, and asked
// about again when Mojang comes back.
//
// ── and the order ──
//
// The account's own profile first, where there is one. That is
// api.minecraftservices.com, a different service on different machines from
// sessionserver, and it is authoritative: it is the account telling the
// launcher about itself with the account's own token. The commonest version
// of this complaint is "all MY accounts went Steve", and those are exactly
// the accounts this works for.
//
// Then the mirrors, which are caches of Mojang: when Mojang is down they
// often still hold what it said an hour ago, which is the whole point.
import https from "https";

/** The mirrors, in the order they are tried. */
export const MIRRORS = [
  // First because it is the only one that answers with Mojang's own bytes
  // rather than a re-encoding of them -- measured, not assumed: its reply
  // for Notch is byte-identical to textures.minecraft.net's.
  { name: "minotar.net", skin: (uuid) => `https://minotar.net/skin/${uuid}` },
  { name: "crafatar.com", skin: (uuid) => `https://crafatar.com/skins/${uuid}` },
  { name: "mc-heads.net", skin: (uuid) => `https://mc-heads.net/skin/${uuid}` },
];

/**
 * Is this a PNG, and is it the shape of a skin sheet?
 *
 * Read out of the header rather than by decoding it: this runs on an answer
 * from a service that may be having a bad day, and the question is only
 * whether it is worth going any further with.
 *
 * A skin is 64 wide and 32 or 64 tall, or a whole multiple of that for an
 * HD one. Anything else -- an error page, a 1x1 tracking pixel, somebody's
 * avatar at 128x128 -- is not a skin and is not drawn as one.
 */
export function readSkinPng(buf) {
  if (!buf || buf.length < 24) return null;
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (buf[i] !== PNG[i]) return null;
  // IHDR is always the first chunk: 4 bytes length, 4 bytes "IHDR", then
  // width and height as big-endian 32-bit.
  if (buf.toString("latin1", 12, 16) !== "IHDR") return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (!width || !height) return null;
  const scale = width / 64;
  if (!Number.isInteger(scale) || scale < 1) return null;
  if (height !== width && height !== width / 2) return null;
  return { width, height, scale, legacy: height === width / 2 };
}

/** A GET that gives back bytes, with a timeout and a size limit. */
export function getBytes(url, { timeout = 20000, limit = 4 * 1024 * 1024, headers = {} } = {}) {
  return new Promise((resolve) => {
    let req;
    const done = (value) => { try { req && req.destroy(); } catch { /* already done */ } resolve(value); };
    try {
      req = https.get(url, { headers, timeout }, (res) => {
        // A redirect is how several of these serve from a CDN.
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(getBytes(new URL(res.headers.location, url).toString(), { timeout, limit, headers }));
        }
        if (res.statusCode !== 200) { res.resume(); return done({ ok: false, status: res.statusCode }); }
        const parts = [];
        let size = 0;
        res.on("data", (c) => {
          size += c.length;
          if (size > limit) { res.destroy(); return done({ ok: false, status: 0, error: "too big" }); }
          parts.push(c);
        });
        res.on("end", () => done({ ok: true, status: 200, body: Buffer.concat(parts) }));
        res.on("error", (e) => done({ ok: false, status: 0, error: e.message }));
      });
      req.on("timeout", () => done({ ok: false, status: 0, error: "it took too long" }));
      req.on("error", (e) => done({ ok: false, status: 0, error: e.message }));
    } catch (e) { done({ ok: false, status: 0, error: e.message }); }
  });
}

/**
 * The skin a mirror holds for this player.
 *
 * Returns { png, via, width } or null. Nothing is believed on its word: the
 * answer has to be a PNG of a skin's shape before it goes any further, and
 * whether it is really this player's skin is somebody else's question --
 * see `isOneOfTheDefaults` in the caller.
 */
export async function skinFromMirrors(uuid, { get = getBytes, mirrors = MIRRORS, onTry = null } = {}) {
  const key = String(uuid || "").replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(key)) return null;
  for (const mirror of mirrors) {
    let r = null;
    try { r = await get(mirror.skin(key), { headers: { "User-Agent": "minecraft-launcher" } }); }
    catch { r = null; }
    if (onTry) { try { onTry(mirror.name, r); } catch { /* the caller's log */ } }
    if (!r || !r.ok || !r.body) continue;
    const shape = readSkinPng(r.body);
    if (!shape) continue;                  // an error page in a PNG's clothing
    return { png: r.body, via: mirror.name, width: shape.width, legacy: shape.legacy };
  }
  return null;
}

// ── what a mirror serves when it has nothing ──────────────────────────────
//
// The failure that matters is not a mirror being down -- that is obvious and
// handled. It is a mirror under load answering 200 with a stand-in skin,
// because that is indistinguishable from an answer and is how this whole
// complaint started in the first place.
//
// The stand-in cannot be recognised from a list of Minecraft's own defaults:
// measured, minotar's is none of the nine, nor the Steve and Alex in the
// client jar -- it is its own file. So each mirror is ASKED what it serves
// for somebody who does not exist, once, and its answer is remembered. After
// that, a reply that matches it is a mirror saying "I do not know" with a
// picture.
//
// Not a uuid of all zeros, which several of these special-case. Something
// that looks like an ordinary uuid and is not one.
export const NOBODY_UUID = "d3adbeefcafe4f00ba5eba11deadbe77";

/**
 * What this mirror serves for a player who does not exist.
 *
 * Returns the bytes, or null if it will not say (which is itself fine: a
 * mirror that errors on an unknown player is one that cannot mislead).
 */
export async function standInFor(mirror, { get = getBytes } = {}) {
  let r = null;
  try { r = await get(mirror.skin(NOBODY_UUID), { headers: { "User-Agent": "minecraft-launcher" } }); }
  catch { return null; }
  if (!r || !r.ok || !r.body) return null;
  return readSkinPng(r.body) ? r.body : null;
}

/**
 * What an account says about itself, with its own token.
 *
 * api.minecraftservices.com is a different service on different machines
 * from sessionserver, so one being down says nothing about the other -- and
 * this is the authoritative answer for the accounts the launcher is signed
 * in to, which are the ones somebody notices going Steve.
 *
 * Cloudflare sits in front of it and rejects a request with no User-Agent
 * (or Node's default), so one is always sent.
 */
export async function profileFromServices(token, { fetchImpl = fetch, userAgent = "minecraft-launcher" } = {}) {
  if (!token || token === "0") return null;
  let res;
  try {
    res = await fetchImpl("https://api.minecraftservices.com/minecraft/profile", {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": userAgent },
    });
  } catch { return null; }
  if (!res || !res.ok) return null;
  let data;
  try { data = await res.json(); } catch { return null; }   // HTML, when it is down too
  const skin = (data.skins || []).find(s => String(s.state).toUpperCase() === "ACTIVE") || (data.skins || [])[0];
  if (!skin || !skin.url) return null;
  const cape = (data.capes || []).find(c => String(c.state).toUpperCase() === "ACTIVE");
  return {
    hash: String(skin.url).split("/").pop() || null,
    url: skin.url,
    slim: String(skin.variant || "").toUpperCase() === "SLIM",
    cape: (cape && cape.url) || null,
    id: data.id || null,
    name: data.name || null,
  };
}

/**
 * Is a service answering at all, or answering with a page saying it is not?
 *
 * Mojang's outage pages come back as HTML with a title that says so, and
 * sometimes with a 200. "It answered" is therefore not the same question as
 * "it is up", and the difference is worth saying out loud in a log: "Mojang
 * is down" is a sentence somebody can act on, where "unexpected token <" is
 * not.
 */
export function describeOutage(status, body) {
  const text = String(body || "").slice(0, 2000);
  const title = /<title>([^<]{1,120})<\/title>/i.exec(text);
  if (title) return `${title[1].trim()}${status ? ` (${status})` : ""}`;
  if (status === 429) return "we are being rate-limited (429)";
  if (status >= 500) return `it answered ${status}`;
  if (status === 0 || status === undefined) return "it could not be reached";
  return `it answered ${status}`;
}

export default {
  MIRRORS, NOBODY_UUID, readSkinPng, getBytes, skinFromMirrors, standInFor,
  profileFromServices, describeOutage,
};
