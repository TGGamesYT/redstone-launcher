// Who has this world open, across two computers.
//
// Two of them playing the same synced world is the one way cloud syncing can
// lose an afternoon's work for good: both load it, both build, and whichever
// uploads second either overwrites the other or makes a conflict with no
// sensible answer. There is no merging two afternoons in the same chunk.
//
// It is a warning rather than a lock, on purpose. A real lock has to fail
// closed, and a launcher that will not open your single-player world because
// a cloud is unreachable is worse than the thing it prevents. So what is
// checked is that the warning is right: who, since when, and -- the part
// that decides whether anybody believes it -- that a crashed launcher's
// claim stops warning on its own.
import crypto from "crypto";
import cloudDrive from "../backend/cloud-drive.js";
import cloudLock from "../backend/cloud-lock.js";
import cc from "../backend/cloud-crypto.js";

let bad = 0;
const ok = (what, note) => console.log(`ok   ${what}${note ? "  — " + note : ""}`);
const fail = (what, why) => { bad++; console.log(`FAIL ${what}\n       ${why}`); };
const check = (what, got, want, note) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) ok(what, note); else fail(what, `got  ${a}\n       want ${b}`);
};

const RELAY = crypto.randomBytes(32).toString("hex");
const DRIVE_HALF = cc.newDriveHalf();

function sharedDrive() {
  const files = new Map();
  let n = 0;
  return async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method || "GET";
    const json = (v) => ({ ok: true, status: 200, json: async () => v, text: async () => JSON.stringify(v) });
    const unesc = (s) => (s == null ? s : String(s).replace(/\\(.)/g, "$1"));
    if (u.pathname.startsWith("/upload/drive/v3/files")) {
      const last = u.pathname.split("/").pop();
      const updating = last !== "files" ? last : null;
      const body = Buffer.from(init.body);
      const text = body.toString("latin1");
      const meta = JSON.parse(/\r\n\r\n(\{.*?\})\r\n--/s.exec(text)[1]);
      const start = text.indexOf("\r\n\r\n", text.indexOf("application/octet-stream")) + 4;
      const end = text.lastIndexOf("\r\n--");
      const id = updating || `f${++n}`;
      files.set(id, { id, ...(files.get(id) || {}), ...meta, body: body.subarray(start, end) });
      return json({ id });
    }
    if (u.pathname.startsWith("/drive/v3/files/")) {
      const id = u.pathname.split("/").pop();
      if (method === "DELETE") { files.delete(id); return { ok: true, status: 204, text: async () => "" }; }
      const f = files.get(id);
      if (!f) return { ok: false, status: 404, text: async () => "gone" };
      return { ok: true, status: 200, arrayBuffer: async () => f.body, json: async () => f };
    }
    if (u.pathname === "/drive/v3/files") {
      if (method === "POST") {
        const meta = JSON.parse(String(init.body));
        const id = `f${++n}`;
        files.set(id, { id, ...meta, body: Buffer.alloc(0) });
        return json({ id });
      }
      const q = u.searchParams.get("q") || "";
      const name = unesc((/name='((?:[^'\\]|\\.)*)'/.exec(q) || [])[1]);
      const parent = unesc((/'((?:[^'\\]|\\.)*)' in parents/.exec(q) || [])[1]);
      const wantFolder = /mimeType='application\/vnd\.google-apps\.folder'/.test(q);
      const out = [...files.values()].filter(f =>
        (name === undefined || f.name === name)
        && (parent === undefined || (f.parents || []).includes(parent))
        && (!wantFolder || f.mimeType === "application/vnd.google-apps.folder"));
      return json({ files: out.map(f => ({ ...f, body: undefined, size: String((f.body || "").length) })) });
    }
    throw new Error(`unexpected ${method} ${u.pathname}`);
  };
}

let clock = Date.now();
const computer = (impl, id, name) => cloudLock.locks({
  drive: cloudDrive.drive({ token: async () => "at", fetchImpl: impl }),
  seal: async (kind, v) => cc.seal({ relayHalf: RELAY, driveHalf: DRIVE_HALF, kind, plaintext: v }),
  open: async (kind, b) => cc.open({ relayHalf: RELAY, driveHalf: DRIVE_HALF, kind, sealed: b }),
  deviceId: id, deviceName: name,
  now: () => clock,
});

// ── the ordinary case ──
{
  const impl = sharedDrive();
  const pc = computer(impl, "a".repeat(32), "Desktop");
  const laptop = computer(impl, "b".repeat(32), "Laptop");

  check("nobody has it to begin with", await pc.who("w1"), null);

  const took = await pc.take("w1", { name: "My Base" });
  check("taking it when nobody has it warns about nobody", took.was, null);

  const seen = await laptop.who("w1");
  check("and the other computer can see who has it",
    [seen.deviceName, seen.name, seen.stale, seen.mine],
    ["Desktop", "My Base", false, false],
    '"this world is open on Desktop" is the whole feature');

  const clash = await laptop.take("w1", { name: "My Base" });
  check("a second computer opening it is told, with who",
    clash.was && clash.was.deviceName, "Desktop",
    "told rather than stopped: a lock would have to fail closed, and not opening your own world because a cloud is unreachable is worse");
}

// ── giving it back ──
{
  const impl = sharedDrive();
  const pc = computer(impl, "a".repeat(32), "Desktop");
  const laptop = computer(impl, "b".repeat(32), "Laptop");
  await pc.take("w1", { name: "My Base" });
  await pc.give("w1");
  check("closing the game clears it", await laptop.who("w1"), null);
  check("and the next computer opens it with no warning",
    (await laptop.take("w1", {})).was, null);
}
{
  const impl = sharedDrive();
  const pc = computer(impl, "a".repeat(32), "Desktop");
  const laptop = computer(impl, "b".repeat(32), "Laptop");
  await pc.take("w1", {});
  const r = await laptop.give("w1");
  check("one computer cannot clear another's claim",
    [r.ok, r.notMine], [false, true],
    "clearing somebody else's turns a crash on their machine into a silent go-ahead on this one");
  check("and it is still theirs afterwards", (await laptop.who("w1")).deviceName, "Desktop");
}

// ── the crash ──
//
// A launcher that is killed never clears its claim. If that warned for ever,
// one crash would make a world warn permanently and nobody would believe any
// of the warnings.
{
  const impl = sharedDrive();
  const pc = computer(impl, "a".repeat(32), "Desktop");
  const laptop = computer(impl, "b".repeat(32), "Laptop");
  await pc.take("w1", { name: "My Base" });

  clock += cloudLock.STALE_MS - 1000;
  check("a claim renewed recently is still a claim",
    (await laptop.who("w1")).stale, false);

  clock += 2000;
  const old = await laptop.who("w1");
  check("one nobody has touched for long enough is nobody",
    old.stale, true,
    "one crash would otherwise leave a world warning for ever");
  check("and opening it is no longer a clash",
    (await laptop.take("w1", {})).was, null);
}
{
  // Renewing while the game runs is what keeps it from going stale.
  const impl = sharedDrive();
  const pc = computer(impl, "a".repeat(32), "Desktop");
  const laptop = computer(impl, "b".repeat(32), "Laptop");
  await pc.take("w1", { name: "My Base" });
  for (let i = 0; i < 10; i++) { clock += cloudLock.RENEW_MS; await pc.renew("w1", { name: "My Base" }); }
  clock += 1000;
  check("a game that is still running keeps its claim alive",
    (await laptop.who("w1")).stale, false,
    `renewed every ${cloudLock.RENEW_MS / 60000} minutes, stale after ${cloudLock.STALE_MS / 60000}`);
  check("and renewing does not restart when it was first opened",
    (await laptop.who("w1")).since < clock - cloudLock.RENEW_MS * 9, true,
    '"open since 10:15" rather than "open since a moment ago"');
}
check("and going stale takes much longer than renewing",
  cloudLock.STALE_MS >= cloudLock.RENEW_MS * 4, true,
  "being told about a world closed five minutes ago is an annoyance; not being told about one open right now is the thing this prevents");

// ── what the folder gives away ──
{
  const impl = sharedDrive();
  const pc = computer(impl, "a".repeat(32), "My Gaming PC");
  await pc.take("Secret Base", { name: "Secret Base" });
  // Read everything the Drive holds, as somebody with the Google account
  // and no Minecraft account would.
  const seen = [];
  const d = cloudDrive.drive({ token: async () => "at", fetchImpl: impl });
  for (const f of await d.list(await d.folder("locks", await d.root()))) {
    seen.push(f.name, (await d.get(f.id)).toString("latin1"));
  }
  check("a claim does not say what it is about to anybody who cannot open it",
    [seen.join("").includes("Secret Base"), seen.join("").includes("My Gaming PC")],
    [false, false],
    "the folder should not disclose which computers somebody owns or when they play");
}

// ── and nonsense is not a claim ──
{
  const impl = sharedDrive();
  const pc = computer(impl, "a".repeat(32), "Desktop");
  const d = cloudDrive.drive({ token: async () => "at", fetchImpl: impl });
  await d.put(await d.folder("locks", await d.root()), "w1.rlc", Buffer.from("not a claim at all"));
  check("something unreadable where a claim should be is not a claim",
    await pc.who("w1"), null,
    "rather than a world that cannot be opened because a file got corrupted");
}

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
