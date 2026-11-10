// Cloud syncing, as the rest of the launcher sees it.
//
// The four pieces underneath -- signing in with Google, talking to Drive,
// the two key halves, and what it means for a thing to be synced -- each do
// one job and know nothing about the launcher. This is where they are tied
// together and where the state lives: who is signed in, what this computer
// has agreed with, and which things are being synced at all.
//
// What is kept on this computer, and what is not:
//
//   kept      the Google refresh token (it is this machine's way back in,
//             exactly like the Microsoft one already stored beside it), the
//             e-mail address to show, this computer's id and name, and the
//             version and hash of each item last agreed with
//   NOT kept  the relay's half of the key. It is fetched for as long as one
//             sync takes and then dropped. Writing it down next to the
//             Drive's half would put both halves on one disk and undo the
//             whole point of there being two.
import crypto from "crypto";
import os from "os";
import google from "./cloud-google.js";
import cloudDrive from "./cloud-drive.js";
import cloudSync from "./cloud-sync.js";
import items from "./cloud-items.js";
import cloudPack from "./cloud-pack.js";
import cloudLock from "./cloud-lock.js";

/**
 * Build the service.
 *
 * Everything it needs comes in, so it can be exercised without Electron:
 *   settings            the launcher's own store (get/set)
 *   relayCall(req)      ask the relay's cloud channel, already authenticated
 *   fetchImpl           for the tests
 */
export function cloud({ settings, relayCall, fetchImpl = fetch, openBrowser, content = {} }) {
  // Held only while the launcher is running.
  let accessToken = null, accessUntil = 0, relayHalfCache = null, clientCache = null;

  const saved = () => settings.get("cloudGoogle", null) || null;
  const save = (v) => settings.set("cloudGoogle", v);

  /** The Google OAuth client this relay was set up with. */
  async function client() {
    if (clientCache) return clientCache;
    const r = await relayCall({ op: "config" });
    if (!r || !r.ok) throw new Error((r && r.error) || "Could not ask the relay about Google sign-in.");
    return (clientCache = { clientId: r.clientId, clientSecret: r.clientSecret });
  }

  /** The relay's half of the key, for as long as this sync takes. */
  async function relayHalf() {
    if (relayHalfCache) return relayHalfCache;
    const r = await relayCall({ op: "secret" });
    if (!r || !r.ok || !r.half) {
      throw new Error((r && r.error)
        || "Could not get this account's key from the relay. Sign in with your Minecraft account first.");
    }
    return (relayHalfCache = r.half);
  }

  /** A Google access token, refreshed when it is about to run out. */
  async function token() {
    const now = saved();
    if (!now || !now.refreshToken) throw Object.assign(new Error("Not signed in to Google."), { signedOut: true });
    // A minute's grace, so a long upload does not expire half way through
    // the one call that was started just before the hour.
    if (accessToken && accessUntil > Date.now() + 60_000) return accessToken;
    const r = await google.refresh({ client: await client(), refreshToken: now.refreshToken, fetchImpl });
    accessToken = r.accessToken;
    accessUntil = r.expiresAt;
    return accessToken;
  }

  const driveFor = () => cloudDrive.drive({ token, fetchImpl });

  /** This computer, as the other ones will see it in a conflict. */
  function device() {
    let id = settings.get("cloudDeviceId", null);
    if (!/^[0-9a-f]{32}$/.test(String(id || ""))) {
      id = crypto.randomBytes(16).toString("hex");
      settings.set("cloudDeviceId", id);
    }
    let name = settings.get("cloudDeviceName", null);
    if (!name) {
      // The computer's own name, because in a conflict "it also changed on
      // DESKTOP-4F2A" is an answer and "it also changed on
      // 8f3a…" is not.
      name = String(os.hostname() || "This computer").replace(/\.local$/, "").slice(0, 40);
      settings.set("cloudDeviceName", name);
    }
    return { id, name };
  }

  const syncer = () => {
    const d = device();
    return cloudSync.sync({
      drive: driveFor(), relayHalf, deviceId: d.id, deviceName: d.name,
    });
  };

  /** Who has a world open, across every computer signed in to this Drive. */
  function lockbook() {
    const d = device();
    const s = syncer();
    return cloudLock.locks({
      drive: driveFor(),
      seal: (kind, v) => s.sealFor(kind, v),
      open: (kind, b) => s.openFor(kind, b),
      deviceId: d.id, deviceName: d.name,
    });
  }

  // ── what this computer has agreed with ──────────────────────────────────
  //
  // Per item: the version and the hash it last saw. Without the hash there is
  // no way to tell "I have not touched this" from "I have", and everything
  // becomes a conflict.
  const agreedAll = () => settings.get("cloudAgreed", {}) || {};
  const agreed = (key) => agreedAll()[key] || null;
  const agree = (key, v) => settings.set("cloudAgreed", { ...agreedAll(), [key]: v });
  const forget = (key) => {
    const all = { ...agreedAll() };
    delete all[key];
    settings.set("cloudAgreed", all);
  };

  // ── signing in and out ──────────────────────────────────────────────────

  async function signIn() {
    const got = await google.signIn({ client: await client(), fetchImpl, ...(openBrowser ? { openBrowser } : {}) });
    save({ refreshToken: got.refreshToken, email: got.email, at: Date.now() });
    accessToken = got.accessToken;
    accessUntil = got.expiresAt;
    return { ok: true, email: got.email };
  }

  /**
   * Sign out.
   *
   * `andRemove` also empties the Drive folder. Without it the synced data is
   * left alone, which is what somebody signing out on a computer they are
   * giving away wants -- their other computers keep working.
   */
  async function signOut({ andRemove = false } = {}) {
    if (andRemove) {
      try { await syncer().unsyncAll(); } catch { /* say it below rather than refuse to sign out */ }
    }
    const now = saved();
    await google.revoke({ refreshToken: now && now.refreshToken, fetchImpl }).catch(() => { });
    save(null);
    settings.set("cloudAgreed", {});
    accessToken = null; accessUntil = 0; relayHalfCache = null;
    return { ok: true };
  }

  /** What the settings page shows. */
  async function status() {
    const now = saved();
    if (!now) return { signedIn: false, device: device() };
    const out = { signedIn: true, email: now.email || null, device: device(), kinds: settings.get("cloudKinds", {}) };
    try {
      const d = driveFor();
      const room = await d.room();
      out.room = room;
      out.items = await syncer().list();
    } catch (e) {
      out.error = String(e && e.message || e);
      out.signedOut = !!(e && e.signedOut);
    }
    return out;
  }

  // ── one item ────────────────────────────────────────────────────────────

  /**
   * What would happen to this item, without doing it.
   *
   * The page asks this before offering a button, so "Sync" and "Download"
   * are never the same button with different consequences.
   */
  async function planFor(kind, id, bytes) {
    const s = syncer();
    const key = id ? `${kind}/${id}` : kind;
    const m = await s.readManifest();
    return s.compare({
      mine: bytes === undefined ? null : { hash: s.hash(bytes) },
      theirs: m.items[key] || null,
      base: agreed(key),
    });
  }

  async function push(kind, id, bytes, { name } = {}) {
    const key = id ? `${kind}/${id}` : kind;
    const r = await syncer().push(kind, id, bytes, { name, base: agreed(key) });
    if (r.ok) agree(key, { version: r.version, hash: r.hash });
    relayHalfCache = null;
    return r;
  }

  async function pull(kind, id) {
    const key = id ? `${kind}/${id}` : kind;
    const r = await syncer().pull(kind, id);
    if (r.ok) agree(key, { version: r.version, hash: syncer().hash(r.bytes) });
    relayHalfCache = null;
    return r;
  }

  /**
   * Push anyway, after being told it clashed.
   *
   * Separate from push on purpose: overwriting what is in the Drive is a
   * thing somebody chooses, and a function that does it when asked nicely is
   * a function that will do it by accident.
   */
  async function pushOver(kind, id, bytes, { name } = {}) {
    const key = id ? `${kind}/${id}` : kind;
    const m = await syncer().readManifest();
    const theirs = m.items[key];
    const r = await syncer().push(kind, id, bytes, { name, base: theirs ? theirs.version : 0 });
    if (r.ok) agree(key, { version: r.version, hash: r.hash });
    relayHalfCache = null;
    return r;
  }

  async function unsync(kind, id) {
    const r = await syncer().unsync(kind, id);
    forget(id ? `${kind}/${id}` : kind);
    relayHalfCache = null;
    return r;
  }

  /** Which kinds this computer syncs at all. */
  const kinds = () => settings.get("cloudKinds", {}) || {};
  const setKind = (kind, on) => {
    settings.set("cloudKinds", { ...kinds(), [kind]: !!on });
    return kinds();
  };

  // ── what each kind is, here ─────────────────────────────────────────────
  //
  // The reading and writing of the launcher's own files is handed in, so
  // this file stays about syncing and cloud-items.js stays about what is in
  // a thing. A kind with nothing behind it simply does not run, which is how
  // the ones not written yet behave rather than by throwing.
  const WHAT = {
    settings: {
      name: "Settings",
      read: () => items.settingsFor(settings),
      write: (v) => items.applySettings(settings, v),
    },
    themes: {
      name: "Themes",
      read: () => (content.readThemes ? content.readThemes() : null),
      write: (v) => content.writeThemes
        && content.writeThemes(items.mergeThemes(content.readThemes(), v).themes),
    },
    accounts: {
      name: "Accounts",
      read: () => (content.readPlayers ? items.accountsFor(content.readPlayers()) : null),
      write: (v) => content.writePlayers
        && content.writePlayers(items.mergeAccounts(content.readPlayers(), v).players),
    },
    servers: {
      name: "Server list",
      read: () => (content.readServers ? content.readServers() : null),
      write: (v) => content.writeServers && content.writeServers(v),
    },
  };

  // ── instances and worlds ────────────────────────────────────────────────
  //
  // Many of each, so they are not in WHAT: each is pushed and pulled by
  // name rather than swept up by "sync everything". Sending somebody's
  // whole instance list to the cloud because they ticked a box is not what
  // ticking a box should mean.

  /** Describe an instance without sending it, so the page can say what will go. */
  function previewInstance(id) {
    if (!content.instanceDir || !content.readProfiles) throw new Error("Instances are not available here.");
    const profile = (content.readProfiles() || []).find(p => String(p.id) === String(id));
    if (!profile) throw new Error("No such instance.");
    return cloudPack.describePack(cloudPack.packInstance({
      profile, dir: content.instanceDir(id),
      known: content.knownFile || (() => null),
    }));
  }

  async function pushInstance(id) {
    const profile = (content.readProfiles() || []).find(p => String(p.id) === String(id));
    if (!profile) throw new Error("No such instance.");
    const p = cloudPack.packInstance({
      profile, dir: content.instanceDir(id), known: content.knownFile || (() => null),
    });
    const r = await push("instances", String(id), Buffer.from(JSON.stringify(p)), { name: profile.name });
    return { ...r, describe: cloudPack.describePack(p) };
  }

  async function pullInstance(id, { into } = {}) {
    const r = await pull("instances", String(id));
    if (!r.ok) return r;
    const p = JSON.parse(r.bytes.toString("utf8"));
    return cloudPack.unpackInstance({
      pack: p,
      dir: into || content.instanceDir(id),
      fetchFile: content.fetchFile || (async () => null),
    });
  }

  async function pushWorld(instanceId, worldName) {
    if (!content.worldDir) throw new Error("Worlds are not available here.");
    const dir = content.worldDir(instanceId, worldName);
    // A real zip, so it can be downloaded from the Drive and dropped into
    // saves/ by hand -- or handed to any other launcher.
    const w = cloudPack.packWorld({ dir, name: worldName });
    const key = `${instanceId}:${worldName}`;
    return push("worlds", key, w.bytes, { name: worldName });
  }

  async function pullWorld(instanceId, worldName) {
    const key = `${instanceId}:${worldName}`;
    const r = await pull("worlds", key);
    if (!r.ok) return r;
    return cloudPack.unpackWorld({
      bytes: r.bytes,
      dir: content.worldDir(instanceId, worldName),
    });
  }

  /**
   * About to play a synced world.
   *
   * Says who else has it open, and claims it either way -- the answer is a
   * warning for somebody to read, not a refusal. See cloud-lock.js for why
   * it is not a lock.
   */
  async function openingWorld(instanceId, worldName) {
    const key = `${instanceId}:${worldName}`;
    const r = await lockbook().take(key, { name: worldName });
    relayHalfCache = null;
    return r;
  }
  async function stillPlaying(instanceId, worldName) {
    const r = await lockbook().renew(`${instanceId}:${worldName}`, { name: worldName });
    relayHalfCache = null;
    return r;
  }
  async function closedWorld(instanceId, worldName) {
    const r = await lockbook().give(`${instanceId}:${worldName}`);
    relayHalfCache = null;
    return r;
  }
  async function whoHasWorlds() {
    const r = await lockbook().all();
    relayHalfCache = null;
    return r;
  }

  /**
   * Sync everything that is switched on.
   *
   * Reports per kind rather than throwing on the first one that will not go:
   * one conflict must not stop the other five from syncing, and the page has
   * to be able to say which was which.
   *
   * Nothing is overwritten. A kind that has changed in both places comes back
   * as a conflict for somebody to decide, which is what compare() is for.
   */
  async function syncNow({ only } = {}) {
    const want = kinds();
    const out = [];
    for (const [kind, spec] of Object.entries(WHAT)) {
      if (only && kind !== only) continue;
      if (!want[kind]) continue;
      try {
        const mine = spec.read();
        if (mine === null || mine === undefined) {
          out.push({ kind, did: "nothing", why: "there is nothing here to sync yet" });
          continue;
        }
        const bytes = Buffer.from(JSON.stringify(mine));
        const plan = await planFor(kind, null, bytes);
        if (plan.do === "push") {
          const r = await push(kind, null, bytes, { name: spec.name });
          out.push({ kind, did: r.ok ? "pushed" : "conflict", why: r.why || plan.why, version: r.version });
        } else if (plan.do === "pull") {
          const r = await pull(kind, null);
          if (r.ok) {
            spec.write(JSON.parse(r.bytes.toString("utf8")));
            out.push({ kind, did: "pulled", why: plan.why, first: !!plan.first });
          }
          else out.push({ kind, did: "nothing", why: r.inManifest ? "it is missing from the Drive" : "there is nothing to take" });
        } else {
          out.push({ kind, did: plan.do, why: plan.why, mine: plan.mine, theirs: plan.theirs });
        }
      } catch (e) {
        out.push({ kind, did: "failed", why: String(e && e.message || e), signedOut: !!(e && e.signedOut) });
      }
    }
    relayHalfCache = null;
    settings.set("cloudLastSync", Date.now());
    return { ok: true, results: out, at: Date.now() };
  }

  /**
   * Take the Drive's copy, throwing away what is here.
   *
   * Only ever after being told there is a conflict, and only when somebody
   * says so -- which is why it is its own call and not an option on a sync.
   */
  async function takeTheirs(kind) {
    const spec = WHAT[kind];
    if (!spec) throw new Error(`Nothing called ${kind} is synced.`);
    const r = await pull(kind, null);
    if (!r.ok) return { ok: false, why: "there is nothing in the Drive to take" };
    spec.write(JSON.parse(r.bytes.toString("utf8")));
    return { ok: true };
  }

  /** Keep what is here, and make the Drive match it. */
  async function keepMine(kind) {
    const spec = WHAT[kind];
    if (!spec) throw new Error(`Nothing called ${kind} is synced.`);
    const mine = spec.read();
    if (mine === null || mine === undefined) return { ok: false, why: "there is nothing here to send" };
    return pushOver(kind, null, Buffer.from(JSON.stringify(mine)), { name: spec.name });
  }

  return {
    client, status, signIn, signOut,
    syncNow, takeTheirs, keepMine, WHAT,
    previewInstance, pushInstance, pullInstance,
    pushWorld, pullWorld,
    openingWorld, stillPlaying, closedWorld, whoHasWorlds,
    plan: planFor, push, pull, pushOver, unsync,
    list: () => syncer().list(),
    unsyncAll: async () => { const r = await syncer().unsyncAll(); settings.set("cloudAgreed", {}); return r; },
    kinds, setKind, device,
    // For the tests and for anything that needs the raw pieces.
    _syncer: syncer, _drive: driveFor,
  };
}

export default { cloud };
