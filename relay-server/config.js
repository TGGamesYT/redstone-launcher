// Everything about this relay that is not in the repository.
//
// There was no such thing before: the secrets and the deployment settings
// were scattered across environment variables with defaults baked in
// (RELAY_DOMAIN, CF_API_TOKEN, the TLS paths), a file holding the admin
// password's hash, a file holding admin UUIDs, and another holding the theme
// key. Changing any of them meant knowing which of those it happened to live
// in, finding it on the box, and restarting.
//
// One file holds them now -- config.json, beside this one and NOT in the
// repository -- and everything that wants one of these values asks here. It
// is re-read when it changes, so an edit takes effect on a relay that is
// already running, and it can be written as well as read, so the admin panel
// can change these without anybody opening an SSH session.
//
// Three rules it keeps:
//
//   The environment still wins. Every deployment that is running right now
//   is configured by environment variables, and this must not quietly change
//   what any of them does -- so an env var, where it is set, is the answer,
//   and the file is what is used when there is none.
//
//   What was already on disk is brought in rather than abandoned. The first
//   run that finds an admin-password.txt and no password in the file moves
//   it in (see migrate below). Nobody has to be told to do anything.
//
//   A secret is never handed out. describe() says whether a value is set and
//   nothing else about it -- the admin panel can show that something has a
//   password without putting the password on somebody's screen, and setting
//   a new one never requires reading the old one.
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FILE = process.env.RELAY_CONFIG || path.join(__dirname, "config.json");
// Where the admin password used to live, and still may on a box that has not
// been restarted since. Read once, moved in, and then left alone.
const OLD_PASSWORD_FILE = process.env.RELAY_ADMIN_PASSWORD_FILE
  || path.join(__dirname, "admin-password.txt");

const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
/** A UUID with the dashes taken out and in one case, which is how they are compared. */
const flatUuid = (v) => String(v || "").toLowerCase().replace(/-/g, "");

// ── what there is ─────────────────────────────────────────────────────────
//
// Declared rather than written out in each place that uses one, so the admin
// panel is built from this list and a new setting turns up there without the
// panel being told about it -- the same way ADMIN_PANELS works in relay.js.
//
//   text     shown and edited as itself
//   secret   stored as itself, never handed back; shown as set or not set
//   password stored as its sha256, because nothing here needs the password
//            itself -- only to recognise it -- so there is no reason for the
//            box to have a copy of one lying about
//   list     several short strings, one per line
const FIELDS = [
  {
    id: "adminPasswordSha256", kind: "password", label: "Admin panel password",
    env: null,
    help: "What the admin panel asks for. Stored as its hash, so this can be"
      + " set but never read back.",
  },
  {
    id: "ownerUuids", kind: "list", label: "Who may change these settings",
    // Minecraft UUIDs. Not the admin password: the password is shared with
    // whoever helps run the relay, and this is the list of people who may
    // change the relay's own credentials, which is a different thing.
    //
    // It starts as TGdoesCode alone. It is a list, and this file can be
    // edited on the box, so locking yourself out by signing in with another
    // account is one line to undo rather than a wall.
    fallback: ["20bbb23e-2f22-46ba-b201-c6bd435b445b"],
    help: "Minecraft UUIDs, one per line. Only these accounts see or change"
      + " the settings on this page, and only after Mojang has verified them"
      + " on the connection. Everything else in the admin panel still works"
      + " for anybody with the password.",
  },
  {
    id: "curseforgeToken", kind: "secret", label: "CurseForge API token",
    env: "CF_API_TOKEN",
    help: "Lets the relay look up CurseForge projects. Without one those"
      + " lookups are simply off.",
  },
  {
    id: "googleClientId", kind: "text", label: "Google OAuth client ID",
    env: "RELAY_GOOGLE_CLIENT_ID",
    help: "For signing in with Google to sync through Drive. Made in the"
      + " Google Cloud console as an OAuth client; the launcher asks the"
      + " relay for it rather than carrying a copy.",
  },
  {
    id: "googleClientSecret", kind: "secret", label: "Google OAuth client secret",
    env: "RELAY_GOOGLE_CLIENT_SECRET",
    help: "Goes with the client ID above.",
  },
  {
    id: "domain", kind: "text", label: "Base domain",
    env: "RELAY_DOMAIN", fallback: "redstonemc.net",
    help: "The domain subdomains are handed out under.",
  },
];
const FIELD = new Map(FIELDS.map(f => [f.id, f]));

// ── the file ──────────────────────────────────────────────────────────────

let cache = null;
let readAt = 0;          // the mtime the cache was taken at, so a change is seen

function readFile() {
  try {
    const st = fs.statSync(FILE);
    if (cache && st.mtimeMs === readAt) return cache;
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    cache = (raw && typeof raw === "object" && !Array.isArray(raw)) ? raw : {};
    readAt = st.mtimeMs;
    return cache;
  } catch (err) {
    if (err && err.code === "ENOENT") { cache = cache || {}; return cache; }
    // A file that is there but unreadable is worth saying out loud: carrying
    // on with the defaults would look like the settings had been forgotten.
    console.error(`[config] ${FILE} could not be read: ${err && err.message || err}`);
    return cache || {};
  }
}

function writeFile(next) {
  // Written beside itself and renamed over, so a reader never sees a half
  // written file -- and a crash mid-write leaves the old one intact rather
  // than a truncated one.
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, FILE);
  cache = next;
  try { readAt = fs.statSync(FILE).mtimeMs; } catch { readAt = 0; }
}

// ── bringing the old files in ─────────────────────────────────────────────

/**
 * Move what is already on disk into the file, once.
 *
 * Only ever fills in what is missing: a value in config.json is never
 * replaced by an older one from somewhere else. Safe to call on every start,
 * and it is.
 */
function migrate() {
  const now = readFile();
  const next = { ...now };
  let moved = [];

  if (!next.adminPasswordSha256) {
    try {
      const raw = fs.readFileSync(OLD_PASSWORD_FILE, "utf8").trim();
      // That file held the hash, not the password, so it moves across as it
      // is. Anything else in it was never a working password either.
      if (/^[0-9a-f]{64}$/i.test(raw)) {
        next.adminPasswordSha256 = raw.toLowerCase();
        moved.push(`the admin password from ${path.basename(OLD_PASSWORD_FILE)}`);
      } else if (raw) {
        console.error(`[config] ${path.basename(OLD_PASSWORD_FILE)} is not a sha256 hash;`
          + ` it has been left alone and no password is set.`);
      }
    } catch { /* not there, which is the ordinary case from now on */ }
  }

  if (!moved.length) return;
  try {
    writeFile(next);
    // The old file is left exactly where it is. Deleting the only copy of a
    // password's hash because a migration thinks it worked is not a trade
    // worth making; it is simply no longer read.
    console.log(`[config] moved ${moved.join(", ")} into ${path.basename(FILE)}.`);
  } catch (err) {
    console.error(`[config] could not write ${FILE}: ${err && err.message || err}`);
  }
}

// ── reading one ───────────────────────────────────────────────────────────

/**
 * What a setting is, with the environment winning.
 *
 * Every relay that is running today is configured by environment variables,
 * and this must not change what any of them does -- so where one is set it
 * is the answer, the file is what is used when there is none, and the
 * field's own fallback is what is used when there is neither.
 */
function get(id) {
  const f = FIELD.get(id);
  if (!f) throw new Error(`No such setting: ${id}`);
  if (f.env && process.env[f.env]) return process.env[f.env];
  const stored = readFile()[id];
  if (stored !== undefined && stored !== null && stored !== "") return stored;
  return f.fallback !== undefined ? f.fallback : (f.kind === "list" ? [] : "");
}

/** Does `password` match the one set? Constant time, and false when none is. */
function adminPasswordOk(password) {
  const want = String(get("adminPasswordSha256") || "");
  if (!/^[0-9a-f]{64}$/i.test(want)) return false;
  const a = Buffer.from(want.toLowerCase(), "hex");
  const b = crypto.createHash("sha256").update(String(password || "")).digest();
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

/**
 * May this account change these settings?
 *
 * The uuid must come from Mojang's hasJoined for this connection and from
 * nowhere else -- see the SECURITY note at the AUTH frame in relay.js.
 * Nothing the client says about who it is is an input here.
 */
function isOwner(uuid) {
  const flat = flatUuid(uuid);
  if (!flat) return false;
  const list = get("ownerUuids");
  return (Array.isArray(list) ? list : [list]).some(u => flatUuid(u) === flat);
}

// ── reading them all, for the admin panel ─────────────────────────────────

/**
 * Every setting, with the secrets left out.
 *
 * A secret comes back as whether it is set, never as itself, so the panel can
 * show that there IS a CurseForge token without putting it on a screen -- and
 * setting a new one has never needed reading the old one.
 */
function describe() {
  return FIELDS.map((f) => {
    const value = get(f.id);
    const fromEnv = !!(f.env && process.env[f.env]);
    const row = {
      id: f.id, kind: f.kind, label: f.label, help: f.help,
      // Which of the three it is coming from, because "I changed it and
      // nothing happened" is otherwise a mystery: an environment variable
      // set on the service overrides anything written here.
      source: fromEnv ? "environment" : (readFile()[f.id] !== undefined ? "file" : "default"),
      env: f.env || null,
      locked: fromEnv,
    };
    if (f.kind === "secret" || f.kind === "password") row.set = !!value;
    else row.value = value;
    return row;
  });
}

/**
 * Change some of them.
 *
 * `values` is id -> new value. A password arrives as the password and is
 * stored as its hash. An empty string clears a setting, which puts it back
 * to its default rather than leaving it empty. Anything not mentioned is
 * left alone, so the panel can send one field.
 */
function set(values) {
  if (!values || typeof values !== "object") throw new Error("Nothing to set.");
  const next = { ...readFile() };
  const changed = [];
  for (const [id, raw] of Object.entries(values)) {
    const f = FIELD.get(id);
    if (!f) throw new Error(`No such setting: ${id}`);
    const list = f.kind === "list"
      ? (Array.isArray(raw) ? raw : String(raw ?? "").split(/[\s,]+/))
        .map(s => String(s).trim()).filter(Boolean)
      : null;

    // Who may change these is checked BEFORE the clearing below, not after.
    // It used to fall through to it: emptying the list deleted it and the
    // built-in default quietly came back, so an owner who had taken
    // themselves off the list and cleared it was put back to somebody else
    // -- with no error to say so.
    if (id === "ownerUuids") {
      for (const u of (list || [])) {
        if (!/^[0-9a-f]{32}$/.test(flatUuid(u))) throw new Error(`${u} is not a UUID.`);
      }
      if (!list || !list.length) {
        throw new Error("Somebody has to be able to change these."
          + " Add the account that should before taking this one off.");
      }
      next[id] = list;
      changed.push(id);
      continue;
    }

    if (raw === "" || raw === null || (Array.isArray(raw) && !raw.length)) {
      if (next[id] !== undefined) { delete next[id]; changed.push(id); }
      continue;
    }
    if (f.kind === "list") {
      next[id] = list;
    } else if (f.kind === "password") {
      next[id] = sha256(String(raw));
    } else {
      next[id] = String(raw);
    }
    changed.push(id);
  }
  if (!changed.length) return { changed: [] };
  writeFile(next);
  return { changed };
}

migrate();

/** For the tests, which start from nothing each time. */
export function _reload() { cache = null; readAt = 0; }

export { FILE, FIELDS, get, set, describe, adminPasswordOk, isOwner, migrate };
export default { FILE, FIELDS, get, set, describe, adminPasswordOk, isOwner, migrate, _reload };
