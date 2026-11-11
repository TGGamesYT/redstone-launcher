// What each synced thing is made of.
//
// cloud.js knows how a thing gets to the Drive and back. This knows WHAT --
// which settings are yours rather than this computer's, what a theme is, what
// has to be stripped out of an account before it goes anywhere.
//
// It is a file of its own because the interesting part is the leaving out,
// and a list of things that must not be synced is worth being able to read
// in one place and check in one test. Two of them matter more than the rest:
//
//   cloudGoogle      the Google refresh token. Syncing the settings with
//                    this in them would put the key to the Drive inside the
//                    Drive, which is both a circle and a disaster.
//   themeSigningKey  the private half of the key a shared theme is signed
//                    with. Whoever has it can sign a theme as you.
//
// The rule for settings is a DENY list rather than an allow list, chosen the
// other way round from what is usual and on purpose: a setting added later
// and forgotten about should sync (mildly wrong, easily fixed) rather than
// silently not sync (invisible, and reported a year later as "my settings
// do not follow me"). Everything genuinely dangerous is secret-shaped and
// is caught by the shape test below as well as by name.

/**
 * Settings that belong to THIS computer, or to nobody.
 *
 * Grouped by why, because "why is this one here" is the question somebody
 * will have when they add the next one.
 */
export const NOT_SETTINGS = [
  // Secrets. These must never leave this machine.
  "themeSigningKey",        // signs a theme as you

  // This computer, not you.
  "pendingUpdate",          // an update downloaded here
  "javaPath", "javaPaths",  // where Java is on this disk
  "dataDir", "instancesDir",

  // How much of this machine to use. A laptop and a desktop do not want the
  // same numbers, and arriving to find your laptop told to use 32 GB is a
  // worse outcome than setting it twice.
  "ramInstancesMin", "ramInstancesMax",
  "ramServersMin", "ramServersMax",

  // About this relay/deployment rather than about you.
  "relayBackend", "relayVerifyTls",

  // ── The look the launcher is wearing right now ──
  //
  // A theme is a thing you save, and saved themes sync as THEMES: the list
  // of them is merged, nothing is thrown away, and which one you are
  // wearing stays each computer's own business.
  //
  // These went with the settings, so a sync reached across and changed the
  // colours of a launcher somebody was looking at -- "it applies the one
  // that was applied", without ever being asked to. And it did it badly:
  // the settings arrive as a file written straight into the store, so the
  // page you were on re-read them and the bars did not, and the icon on the
  // desktop was left as the old theme's. Syncing by itself must not mean
  // deciding by itself, which is the same rule the rest of this follows.
  //
  // The same names as THEME_FIELDS and THEME_OPTIONAL in main.js, plus the
  // icon, which is part of the look and not a preference.
  "baseColor", "secondaryColor", "thirdColor", "autoThird",
  "textColor", "font", "fontSmoothing", "borderRadius",
  "background", "homeLayout", "appIcon",
];

/**
 * A setting that looks secret whatever it is called.
 *
 * The named list above is the first line; this is the second, for the key
 * somebody adds next year and does not think about. It is deliberately
 * blunt -- a false positive means one setting does not follow you, which is
 * a complaint; a false negative means a token in somebody's cloud storage,
 * which is not.
 */
const SECRET_NAME = /token|secret|password|refresh|credential|private.?key|api.?key|sign(ing)?.?key/i;

export const looksSecret = (key, value) => {
  if (SECRET_NAME.test(String(key))) return true;
  if (typeof value === "string") {
    // A long opaque string under a key nobody listed.
    if (value.length > 120 && !/\s/.test(value)) return true;
    // A private key, which has plenty of whitespace and so slips past the
    // rule above. themeSigningKey is one of these.
    if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(value)) return true;
  }
  // A secret nested one level down, under a name that says nothing. This is
  // the realistic future leak: `cloudGoogle` is not a secret-shaped NAME,
  // and what is inside it is the key to the Drive we would be writing to.
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const k of Object.keys(value)) if (SECRET_NAME.test(k)) return true;
  }
  return false;
};

/**
 * Everything syncing itself keeps, which is never synced.
 *
 * All of it is about THIS computer -- which Google account it is signed in
 * with, what it has agreed with, when it last ran -- and one of them is the
 * refresh token for the very Drive being written to.
 *
 * It is a prefix rather than a list because of what happened without one.
 * `cloudLastSync` is written BY a sync and was then included IN the next
 * one, so the settings changed every time they were synced: every sync
 * pushed, both computers pushed at each other for ever, and a push from
 * either looked to the other like a change worth conflicting over.
 * Anything syncing writes about itself has that shape, so the rule is about
 * the shape rather than about the names.
 */
const OURS = /^cloud[A-Z]/;

/** The settings that are yours, ready to go. */
export function settingsFor(store, { all } = {}) {
  const out = {};
  const every = all || store.store || {};
  for (const [k, v] of Object.entries(every)) {
    if (NOT_SETTINGS.includes(k) || OURS.test(k)) continue;
    if (looksSecret(k, v)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Put synced settings back.
 *
 * The same list applies coming IN: a Drive folder that has been tampered
 * with must not be able to set this computer's Java path or hand it a
 * relay to talk to. Nothing outside what we would have sent is taken.
 */
export function applySettings(store, incoming) {
  if (!incoming || typeof incoming !== "object") return { changed: [] };
  const changed = [];
  for (const [k, v] of Object.entries(incoming)) {
    if (NOT_SETTINGS.includes(k) || OURS.test(k)) continue;
    if (looksSecret(k, v)) continue;
    store.set(k, v);
    changed.push(k);
  }
  return { changed };
}

// ── accounts ──────────────────────────────────────────────────────────────
//
// The one that is worth real money to somebody else. The whole record goes,
// tokens included -- that is what makes signing in on another computer
// unnecessary, which is what was asked for -- and it is safe to do only
// because of the two halves (see cloud-crypto.js). What is left out is what
// is about this computer rather than about the account.

export const NOT_ACCOUNT = [
  "needsReauth",      // this computer's opinion of the token, not the account's
  "lastRefresh",      // when THIS computer last refreshed it
];

export function accountsFor(players) {
  return (players || []).map((p) => {
    const out = {};
    for (const [k, v] of Object.entries(p)) {
      if (NOT_ACCOUNT.includes(k)) continue;
      out[k] = v;
    }
    return out;
  });
}

/**
 * Merge synced accounts into the ones here.
 *
 * Merged rather than replaced: a computer that has an account the Drive has
 * not should not lose it for syncing. Where both have one, the one with the
 * newer refresh wins -- but a local account that still works is never
 * replaced by a synced one that is marked as needing a new sign-in.
 */
export function mergeAccounts(local, incoming) {
  const by = new Map((local || []).map(p => [String(p.id), { ...p }]));
  const added = [], updated = [];
  for (const p of incoming || []) {
    const id = String(p.id || "");
    if (!id) continue;
    const have = by.get(id);
    if (!have) { by.set(id, { ...p }); added.push(id); continue; }
    // Keep this computer's own view of whether the token still works.
    const keep = { needsReauth: have.needsReauth, lastRefresh: have.lastRefresh };
    if (have.needsReauth && !p.needsReauth) {
      by.set(id, { ...have, ...p, needsReauth: undefined });
      updated.push(id);
    } else if (!have.needsReauth) {
      // Ours works. Take anything new about the account but not the token.
      by.set(id, { ...p, ...keep, auth: have.auth, refresh: have.refresh });
    } else {
      by.set(id, { ...have, ...p, ...keep });
      updated.push(id);
    }
  }
  return { players: [...by.values()], added, updated };
}

// ── themes ────────────────────────────────────────────────────────────────
//
// Already self-contained -- a theme is made to be handed to somebody else --
// so there is nothing to strip. Merged by name so a computer's own themes
// are not thrown away by a sync.

export function mergeThemes(local, incoming) {
  const by = new Map((local || []).map(t => [String(t.name || t.id), t]));
  const added = [];
  for (const t of incoming || []) {
    const key = String(t.name || t.id || "");
    if (!key) continue;
    if (!by.has(key)) { by.set(key, t); added.push(key); continue; }
    // The newer of the two, where either says when it was made.
    const have = by.get(key);
    if (Number(t.at || 0) > Number(have.at || 0)) by.set(key, t);
  }
  return { themes: [...by.values()], added };
}

export default {
  NOT_SETTINGS, NOT_ACCOUNT, looksSecret,
  settingsFor, applySettings, accountsFor, mergeAccounts, mergeThemes,
};
