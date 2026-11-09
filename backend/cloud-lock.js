// Who has this world open.
//
// Two computers playing the same synced world is the one way cloud syncing
// can lose somebody's work for good. Both load it, both build for an hour,
// and whichever uploads second either overwrites the other or produces a
// conflict with no sensible answer -- there is no merging two afternoons in
// the same chunk.
//
// So a world being played is said out loud. Starting a game writes a claim
// into the Drive folder; closing it takes the claim away; and any other
// computer that is about to open the same world sees it and warns.
//
// This is a warning, not a lock, and that is deliberate. A real lock would
// have to fail closed -- no internet, no play -- and a launcher that will
// not open your single-player world because a cloud is unreachable is worse
// than the thing it is preventing. So it tells you, with who and since when,
// and you decide.
//
// The claim is encrypted like everything else, so the folder does not
// disclose which computers somebody owns or when they play.
//
// ── stale claims ──
//
// A launcher that is killed, crashes or loses power never takes its claim
// away. A claim that is never renewed must therefore expire, or one crash
// means a world that warns for ever and a warning nobody believes.
//
// So a claim carries the time it was last renewed, the launcher renews
// while the game runs, and a claim nobody has touched for long enough is
// treated as gone. STALE is deliberately much longer than RENEW: being told
// about a world that was closed five minutes ago is a small annoyance,
// while not being told about one that is open right now is the thing this
// exists to prevent.
export const RENEW_MS = 2 * 60 * 1000;        // while playing
export const STALE_MS = 10 * 60 * 1000;       // older than this is nobody

export const lockName = (key) => `locks/${key}.rlc`;

/**
 * Claims, kept in the Drive folder.
 *
 * `sync` is a cloud-sync.js sync -- the claims go through the same two-half
 * encryption as everything else.
 */
export function locks({ drive, seal, open, deviceId, deviceName, now = () => Date.now() }) {
  let folderId = null;
  const folder = async () => (folderId || (folderId = await drive.folder("locks", await drive.root())));
  const file = (key) => `${String(key).replace(/[^\w.-]+/g, "_")}.rlc`;

  /** Who has it, or null. A claim nobody has renewed lately is nobody. */
  async function who(key) {
    const f = await drive.find(await folder(), file(key));
    if (!f) return null;
    let claim;
    try { claim = JSON.parse((await open("lock", await drive.get(f.id))).toString("utf8")); }
    catch { return null; }                    // unreadable is not a claim
    if (!claim || !claim.deviceId) return null;
    if (now() - Number(claim.at || 0) > STALE_MS) {
      return { ...claim, stale: true, mine: claim.deviceId === deviceId };
    }
    return { ...claim, stale: false, mine: claim.deviceId === deviceId };
  }

  /**
   * Say this computer has it open.
   *
   * Returns what was there before, so the caller can warn -- taking the
   * claim and then asking would be a race with whoever else is starting.
   */
  async function take(key, { name } = {}) {
    const was = await who(key);
    const claim = { deviceId, deviceName, name: name || key, at: now(), since: (was && was.mine && was.since) || now() };
    await drive.put(await folder(), file(key), await seal("lock", Buffer.from(JSON.stringify(claim))),
      { props: { kind: "lock", device: deviceId } });
    return { ok: true, was: was && !was.mine && !was.stale ? was : null };
  }

  /** Still playing. */
  const renew = (key, opts) => take(key, opts);

  /**
   * Done playing.
   *
   * Only ever this computer's own claim. Another computer's is not ours to
   * clear, however stale it looks -- that is what the staleness rule is for,
   * and clearing somebody else's turns a crash on their machine into a
   * silent go-ahead on this one.
   */
  async function give(key) {
    const f = await drive.find(await folder(), file(key));
    if (!f) return { ok: true };
    const was = await who(key);
    if (was && !was.mine) return { ok: false, notMine: true };
    await drive.remove(f.id);
    return { ok: true };
  }

  /** Everything claimed right now, for showing in the worlds list. */
  async function all() {
    const out = [];
    for (const f of await drive.list(await folder()).catch(() => [])) {
      const key = f.name.replace(/\.rlc$/, "");
      const w = await who(key).catch(() => null);
      if (w) out.push({ key, ...w });
    }
    return out;
  }

  return { who, take, renew, give, all, RENEW_MS, STALE_MS };
}

export default { locks, RENEW_MS, STALE_MS, lockName };
