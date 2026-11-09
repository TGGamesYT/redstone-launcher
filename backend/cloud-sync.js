// What it means for something to be synced.
//
// One place that knows how a thing gets into the Drive and back out again,
// so that settings, themes, the server list, instances, worlds and accounts
// are all the same kind of thing with different contents -- rather than six
// syncs that each went their own way.
//
// What is in the Drive folder:
//
//   key.json          the Drive's half of the key. NOT encrypted, because it
//                     is half a key -- see cloud-crypto.js for why that is
//                     the point rather than an oversight.
//   manifest.rlc      what is synced, which version of each, and which
//                     computer wrote it last
//   <kind>.rlc        one file per whole-launcher thing: settings, themes,
//                     servers, accounts
//   <kind>/<id>.rlc   one file each for the many: instances, worlds
//
// Everything but key.json is encrypted with both halves, so the folder is of
// no use to anybody who only has the Google account.
//
// ── versions, and not losing things ──
//
// Each item carries a version that goes up by one each time it is written,
// and every computer remembers which version it last agreed with. From those
// three numbers -- mine, theirs, and the one we last shared -- the answer is
// never a guess:
//
//   theirs == base     nobody else has touched it; push
//   mine  == base      I have not; pull
//   neither            both have. That is a conflict, and it is REPORTED
//                      rather than resolved by whoever saved last.
//
// Last-writer-wins is the usual shortcut and it is wrong here. The things
// being synced are a person's instances and worlds; quietly throwing away an
// evening's building because another computer uploaded afterwards is not a
// trade anybody agreed to.
import crypto from "crypto";
import cc from "./cloud-crypto.js";

export const MANIFEST = "manifest.rlc";
export const KEY_FILE = "key.json";

/** Things there is one of for the whole launcher. */
export const SINGLE = ["settings", "themes", "servers", "accounts"];
/** Things there are many of, each with an id of its own. */
export const MANY = ["instances", "worlds"];
export const KINDS = [...SINGLE, ...MANY];

const isSingle = (kind) => SINGLE.includes(kind);
const pathFor = (kind, id) => (isSingle(kind) ? `${kind}.rlc` : `${kind}/${id}.rlc`);

/**
 * A sync, for one Google account and one Minecraft account.
 *
 * `drive` is a cloud-drive.js drive. `relayHalf()` is asked for the relay's
 * half of the key -- asked, not given, because it must never be written down
 * here: it is kept for as long as one sync runs and no longer. `deviceId`
 * says which computer this is, which is what makes a conflict detectable and
 * what the world locks are about.
 */
export function sync({ drive, relayHalf, deviceId, deviceName }) {
  if (!deviceId) throw new Error("A sync has to know which computer it is.");

  let driveHalfCache = null;
  let folders = new Map();

  /** The folder for a kind, made if it is not there. */
  async function folderFor(kind) {
    const root = await drive.root();
    if (isSingle(kind)) return root;
    if (!folders.has(kind)) folders.set(kind, await drive.folder(kind, root));
    return folders.get(kind);
  }

  /**
   * The Drive's half of the key, made on the first computer that syncs.
   *
   * Read from the folder every time a sync starts rather than remembered
   * between runs, because the other computer is the one that may have made
   * it -- and a half remembered from before an "unsync everything" would
   * open nothing anyway.
   */
  async function driveHalf() {
    if (driveHalfCache) return driveHalfCache;
    const root = await drive.root();
    const found = await drive.find(root, KEY_FILE);
    if (found) {
      let said = null;
      try { said = JSON.parse((await drive.get(found.id)).toString("utf8")); } catch { /* below */ }
      if (said && typeof said.half === "string") return (driveHalfCache = said.half);
      throw new Error(`${KEY_FILE} in the Drive folder is not readable.`
        + " Nothing can be opened without it; take the folder out of the bin if it was deleted.");
    }
    const half = cc.newDriveHalf();
    await drive.put(root, KEY_FILE, Buffer.from(JSON.stringify({
      half,
      // So somebody who finds it knows what they are looking at and does not
      // tidy it away.
      note: "Half of the key Redstone Launcher's synced data is encrypted with."
        + " The other half never leaves the launcher's relay. Deleting this makes"
        + " everything in this folder unreadable, including on your other computers.",
      made: new Date().toISOString(),
    }, null, 2)));
    return (driveHalfCache = half);
  }

  const keys = async () => ({ relayHalf: await relayHalf(), driveHalf: await driveHalf() });

  async function seal(kind, value) {
    const k = await keys();
    return cc.seal({ ...k, kind, plaintext: Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)) });
  }
  async function open(kind, bytes) {
    const k = await keys();
    return cc.open({ ...k, kind, sealed: bytes });
  }

  // ── the manifest ────────────────────────────────────────────────────────

  const EMPTY = { version: 1, items: {}, devices: {} };

  async function readManifest() {
    const root = await drive.root();
    const f = await drive.find(root, MANIFEST);
    if (!f) return { ...EMPTY };
    const bytes = await drive.get(f.id);
    const got = JSON.parse((await open("manifest", bytes)).toString("utf8"));
    return { ...EMPTY, ...got, items: got.items || {}, devices: got.devices || {} };
  }

  async function writeManifest(m) {
    const root = await drive.root();
    m.devices[deviceId] = { name: deviceName || deviceId, at: Date.now() };
    await drive.put(root, MANIFEST, await seal("manifest", m), {
      props: { kind: "manifest", device: deviceId },
    });
    return m;
  }

  const keyOf = (kind, id) => (isSingle(kind) ? kind : `${kind}/${id}`);

  /** `base` as { version, hash }, whichever of the two shapes it arrived in. */
  const baseOf = (base) => (base && typeof base === "object")
    ? { version: Number(base.version) || 0, hash: base.hash || null }
    : { version: Number(base) || 0, hash: null };

  // ── pushing and pulling ─────────────────────────────────────────────────

  /**
   * What should happen to this item, given what is here and what is there.
   *
   * `base` is the version this computer last agreed with -- 0 if it has
   * never synced this. Nothing is written by either side until this has been
   * asked, so a conflict is something to decide rather than something that
   * has already happened.
   */
  function compare({ mine, theirs, base }) {
    const t = theirs ? theirs.version : 0;
    // `base` is what this computer last agreed with, and callers have it in
    // two shapes: the whole thing ({ version, hash }) when they kept it, and
    // just the version number when that is all they have. Reading only one
    // of those is how "it changed here only" came out as a conflict --
    // Number({ ... }) is NaN, so the version it was compared against was 0.
    const b = baseOf(base);

    if (!mine && !t) return { do: "nothing", why: "there is nothing on either side" };
    if (!mine) return { do: "pull", why: "it is not on this computer" };
    if (!t) return { do: "push", why: "it is not in the Drive yet" };
    if (mine.hash && theirs.hash && mine.hash === theirs.hash) {
      return { do: "nothing", why: "both sides are the same", version: t };
    }

    // A computer that has never synced this before has nothing to have
    // changed FROM, so there is no conflict to have: it takes the Drive's
    // copy. Treating it as a clash means every new computer clashes on
    // everything the moment it signs in, which is noise rather than a
    // question -- and of the things synced, two of the three merge, so
    // nothing is lost by taking.
    //
    // It is marked as the first one, so the page can say what it did and
    // offer to put this computer's back rather than leaving somebody to
    // find out that their settings changed.
    if (!b.version && !b.hash) {
      return { do: "pull", first: true, why: "this computer has not synced this before" };
    }

    // Without a remembered hash there is no way to tell whether this computer
    // has changed anything, so it is taken to have -- which errs towards
    // asking rather than towards overwriting.
    const iChanged = !b.hash || !mine.hash || mine.hash !== b.hash;
    const theyChanged = t !== b.version;

    if (!iChanged && !theyChanged) return { do: "nothing", why: "neither has changed" };
    if (!iChanged) return { do: "pull", why: "it changed on another computer" };
    if (!theyChanged) return { do: "push", why: "it changed here" };
    return {
      do: "conflict",
      why: `it changed here and on ${(theirs.deviceName || "another computer")}`,
      mine, theirs,
    };
  }

  /** Put this item in the Drive, as the next version. */
  async function push(kind, id, bytes, { name, base } = {}) {
    const m = await readManifest();
    const k = keyOf(kind, id);
    const theirs = m.items[k] || null;
    const next = (theirs ? theirs.version : 0) + 1;
    const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(JSON.stringify(bytes));
    const hash = crypto.createHash("sha256").update(body).digest("hex");

    // Somebody else got there first while this was being prepared.
    if (base !== undefined && theirs && theirs.version !== baseOf(base).version) {
      return { ok: false, conflict: true, theirs, why: compare({
        mine: { hash }, theirs, base,
      }).why };
    }

    const folder = await folderFor(kind);
    await drive.put(folder, isSingle(kind) ? pathFor(kind, id) : `${id}.rlc`,
      await seal(kind, body),
      { props: { kind, device: deviceId, version: String(next) } });

    m.items[k] = {
      kind, id: id || kind, version: next, hash, size: body.length,
      name: name || id || kind,
      at: Date.now(), deviceId, deviceName: deviceName || deviceId,
    };
    await writeManifest(m);
    return { ok: true, version: next, hash };
  }

  /** Take this item out of the Drive. */
  async function pull(kind, id) {
    const m = await readManifest();
    const k = keyOf(kind, id);
    const theirs = m.items[k];
    if (!theirs) return { ok: false, missing: true };
    const folder = await folderFor(kind);
    const f = await drive.find(folder, isSingle(kind) ? pathFor(kind, id) : `${id}.rlc`);
    if (!f) {
      // The manifest says it is there and it is not. Say so rather than
      // pretending the item never existed: somebody deleted it by hand.
      return { ok: false, missing: true, inManifest: true };
    }
    const body = await open(kind, await drive.get(f.id));
    const hash = crypto.createHash("sha256").update(body).digest("hex");
    if (theirs.hash && hash !== theirs.hash) {
      throw new Error(`${theirs.name} in the Drive is not what the manifest says it is.`);
    }
    return { ok: true, bytes: body, version: theirs.version, meta: theirs };
  }

  /** Everything the Drive has, as the manifest sees it. */
  async function list() {
    const m = await readManifest();
    return Object.entries(m.items).map(([k, v]) => ({ key: k, ...v }));
  }

  /**
   * Stop syncing one thing, and take it out of the Drive.
   *
   * It stays on this computer. "Unsync" means "stop keeping this in the
   * cloud", and somebody who meant "delete my world" would have said that.
   */
  async function unsync(kind, id) {
    const m = await readManifest();
    const k = keyOf(kind, id);
    if (!m.items[k]) return { ok: true, already: true };
    const folder = await folderFor(kind);
    const f = await drive.find(folder, isSingle(kind) ? pathFor(kind, id) : `${id}.rlc`);
    if (f) await drive.remove(f.id);
    delete m.items[k];
    await writeManifest(m);
    return { ok: true };
  }

  /**
   * Stop syncing altogether and leave nothing behind.
   *
   * The key goes last. If anything fails before that, what is left is still
   * readable and can be tried again -- whereas a key removed first would
   * leave files nobody can ever open, including the person who owns them.
   */
  async function unsyncAll() {
    const root = await drive.root();
    const m = await readManifest().catch(() => ({ ...EMPTY }));
    const gone = [];
    for (const k of Object.keys(m.items)) {
      const [kind, id] = k.includes("/") ? k.split("/") : [k, null];
      try { await unsync(kind, id); gone.push(k); } catch { /* carry on with the rest */ }
    }
    for (const name of [MANIFEST]) {
      const f = await drive.find(root, name);
      if (f) await drive.remove(f.id);
    }
    const key = await drive.find(root, KEY_FILE);
    if (key) await drive.remove(key.id);
    // Then whatever is still in there -- the per-kind sub-folders, and
    // anything a later version put there that this one does not know about
    // -- and then the folder itself. Listed rather than assumed: Drive does
    // remove a folder's contents with it, but "empty the folder" promising
    // more than it does is exactly the kind of claim nobody checks.
    for (const left of await drive.list(root).catch(() => [])) {
      await drive.remove(left.id).catch(() => { /* carry on with the rest */ });
    }
    // Last, for the same reason the key was second to last: while it is
    // there, anything that went wrong above can be tried again.
    await drive.remove(root).catch(() => { /* already gone, or in use */ });
    folders = new Map();
    driveHalfCache = null;
    return { ok: true, removed: gone.length };
  }

  return {
    push, pull, list, unsync, unsyncAll, compare,
    readManifest, writeManifest, driveHalf,
    // So a caller can hash the same way before deciding whether to push.
    hash: (b) => crypto.createHash("sha256")
      .update(Buffer.isBuffer(b) ? b : Buffer.from(JSON.stringify(b))).digest("hex"),
  };
}

/** This computer, as the Drive knows it. Made once and kept. */
export function deviceOf(settings) {
  let id = settings.get("cloudDeviceId", null);
  if (!/^[0-9a-f]{32}$/.test(String(id || ""))) {
    id = crypto.randomBytes(16).toString("hex");
    settings.set("cloudDeviceId", id);
  }
  return id;
}

export default { sync, deviceOf, KINDS, SINGLE, MANY, MANIFEST, KEY_FILE };
