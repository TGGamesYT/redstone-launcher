// Syncing, with two computers and one Drive between them.
//
// The fake Drive from the Drive test stands in for Google, and two syncs are
// built on it with different device ids -- so "this changed on the other
// computer" is a real second client rather than a flag.
//
// What matters most here is what happens when both have changed. Last writer
// wins is the usual shortcut and it is wrong for this: the things being
// synced are somebody's instances and worlds, and quietly throwing away an
// evening's building because the other machine uploaded afterwards is not a
// trade anybody agreed to. So a conflict has to be reported, and nothing
// may be written until it is.
import crypto from "crypto";
import cloudDrive from "../backend/cloud-drive.js";
import cloudSync from "../backend/cloud-sync.js";
import cc from "../backend/cloud-crypto.js";

let bad = 0;
const ok = (what, note) => console.log(`ok   ${what}${note ? "  — " + note : ""}`);
const fail = (what, why) => { bad++; console.log(`FAIL ${what}\n       ${why}`); };
const check = (what, got, want, note) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) ok(what, note); else fail(what, `got  ${a}\n       want ${b}`);
};
const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };

const RELAY_HALF = crypto.randomBytes(32).toString("hex");

// ── a Drive both computers can see ──
function sharedDrive() {
  const files = new Map();
  let n = 0;
  const impl = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method || "GET";
    const json = (v) => ({ ok: true, status: 200, json: async () => v, text: async () => JSON.stringify(v) });
    const unesc = (s) => (s == null ? s : String(s).replace(/\\(.)/g, "$1"));

    if (u.pathname.startsWith("/upload/drive/v3/files")) {
      const idInPath = u.pathname.split("/").pop();
      const updating = idInPath !== "files" ? idInPath : null;
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
      const query = u.searchParams.get("q") || "";
      const name = unesc((/name='((?:[^'\\]|\\.)*)'/.exec(query) || [])[1]);
      const parent = unesc((/'((?:[^'\\]|\\.)*)' in parents/.exec(query) || [])[1]);
      const wantFolder = /mimeType='application\/vnd\.google-apps\.folder'/.test(query);
      const out = [...files.values()].filter(f =>
        (name === undefined || f.name === name)
        && (parent === undefined || (f.parents || []).includes(parent))
        && (!wantFolder || f.mimeType === "application/vnd.google-apps.folder"));
      return json({ files: out.map(f => ({ ...f, body: undefined, size: String((f.body || "").length) })) });
    }
    throw new Error(`unexpected ${method} ${u.pathname}`);
  };
  return { impl, files };
}

/** One computer. */
const computer = (impl, id, name) => cloudSync.sync({
  drive: cloudDrive.drive({ token: async () => "at", fetchImpl: impl }),
  relayHalf: async () => RELAY_HALF,
  deviceId: id, deviceName: name,
});

// ── the key half ──
{
  const { impl, files } = sharedDrive();
  const pc = computer(impl, "a".repeat(32), "Desktop");
  const half = await pc.driveHalf();
  check("the Drive's half is made on the first computer that syncs",
    /^[0-9a-f]{64}$/.test(half), true);

  const laptop = computer(impl, "b".repeat(32), "Laptop");
  check("and the second computer finds it rather than making another",
    await laptop.driveHalf(), half,
    "two halves would mean each computer could only read what it wrote");

  const keyFile = [...files.values()].find(f => f.name === "key.json");
  const said = JSON.parse(keyFile.body.toString());
  check("it says what it is, so nobody tidies it away",
    /Deleting this makes everything in this folder unreadable/.test(said.note), true);
}

// ── nothing readable is left lying in the folder ──
{
  const { impl, files } = sharedDrive();
  const pc = computer(impl, "a".repeat(32), "Desktop");
  await pc.push("settings", null, { theme: "red", secretish: "my-server-password" }, { name: "Settings" });
  const bodies = [...files.values()].map(f => (f.body || Buffer.alloc(0)).toString("latin1")).join("");
  check("what is written to Drive is not readable",
    [/my-server-password/.test(bodies), /"theme"/.test(bodies)], [false, false]);
  const manifest = [...files.values()].find(f => f.name === "manifest.rlc");
  check("including the manifest, which would otherwise list what somebody has",
    cc.peek(manifest.body), { scheme: cc.SCHEME, kind: "manifest" });
}

// ── there and back ──
{
  const { impl } = sharedDrive();
  const pc = computer(impl, "a".repeat(32), "Desktop");
  const laptop = computer(impl, "b".repeat(32), "Laptop");

  const settings = Buffer.from(JSON.stringify({ theme: "red" }));
  const up = await pc.push("settings", null, settings, { name: "Settings" });
  check("pushing gives it a version", [up.ok, up.version], [true, 1]);

  const down = await laptop.pull("settings", null);
  check("and the other computer gets exactly what was sent",
    [down.ok, down.bytes.toString(), down.version], [true, '{"theme":"red"}', 1]);
  check("and is told where it came from",
    [down.meta.deviceName, down.meta.name], ["Desktop", "Settings"]);

  const again = await pc.push("settings", null, Buffer.from('{"theme":"blue"}'), { base: 1 });
  check("pushing again moves the version on", again.version, 2);
  check("and the other side sees the new one",
    (await laptop.pull("settings", null)).bytes.toString(), '{"theme":"blue"}');
}

// ── many of a kind ──
{
  const { impl } = sharedDrive();
  const pc = computer(impl, "a".repeat(32), "Desktop");
  await pc.push("worlds", "w1", Buffer.from("world one"), { name: "My Base" });
  await pc.push("worlds", "w2", Buffer.from("world two"), { name: "Nether" });
  await pc.push("instances", "i1", Buffer.from("instance"), { name: "1.21 Fabric" });

  const all = (await pc.list()).map(i => [i.key, i.name]).sort();
  check("each of the many gets a file of its own",
    all, [["instances/i1", "1.21 Fabric"], ["worlds/w1", "My Base"], ["worlds/w2", "Nether"]]);
  check("and comes back by itself",
    (await pc.pull("worlds", "w2")).bytes.toString(), "world two");
}

// ── both changed ──
//
// The case the whole design is about.
{
  const { impl } = sharedDrive();
  const pc = computer(impl, "a".repeat(32), "Desktop");
  const laptop = computer(impl, "b".repeat(32), "Laptop");

  await pc.push("worlds", "w1", Buffer.from("evening one"), { name: "My Base" });
  // Both computers now know version 1. Both build on it.
  await laptop.push("worlds", "w1", Buffer.from("laptop evening"), { base: 1 });
  const clash = await pc.push("worlds", "w1", Buffer.from("desktop evening"), { base: 1 });

  check("the second computer to push from the same version is stopped",
    [clash.ok, clash.conflict], [false, true],
    "last writer wins would have thrown away an evening's building without asking");
  check("and nothing of theirs was overwritten",
    (await laptop.pull("worlds", "w1")).bytes.toString(), "laptop evening");
  check("it says which computer it clashed with",
    /Laptop/.test(clash.why), true, clash.why);
}
{
  // And what compare() says about each shape, since that is what the page
  // will show before anything is written.
  const { impl } = sharedDrive();
  const pc = computer(impl, "a".repeat(32), "Desktop");
  const mine = { hash: "aaa" }, theirs = { version: 3, hash: "bbb", deviceName: "Laptop" };
  check("neither side has it", pc.compare({}).do, "nothing");
  check("only the Drive has it", pc.compare({ theirs, base: 0 }).do, "pull");
  check("only this computer has it", pc.compare({ mine, base: 0 }).do, "push");
  check("both have the same thing",
    pc.compare({ mine: { hash: "x" }, theirs: { version: 2, hash: "x" }, base: 2 }).do, "nothing");
  check("it changed there only",
    pc.compare({ mine: { hash: "aaa" }, theirs, base: { hash: "aaa", version: 2 } }).do, "pull");
  check("it changed here only",
    pc.compare({ mine, theirs: { version: 3, hash: "bbb" }, base: { hash: "ccc", version: 3 } }).do, "push");
  check("it changed in both places",
    pc.compare({ mine, theirs, base: { hash: "ccc", version: 2 } }).do, "conflict");
}

// ── when the Drive and the manifest disagree ──
{
  const { impl, files } = sharedDrive();
  const pc = computer(impl, "a".repeat(32), "Desktop");
  await pc.push("worlds", "w1", Buffer.from("a world"), { name: "My Base" });

  // Somebody deleted the file by hand and left the manifest alone.
  const f = [...files.values()].find(x => x.name === "w1.rlc");
  files.delete(f.id);
  const got = await pc.pull("worlds", "w1");
  check("a file the manifest promises and the Drive does not have says so",
    [got.ok, got.missing, got.inManifest], [false, true, true],
    "rather than quietly behaving as though it had never been synced");
}
{
  const { impl, files } = sharedDrive();
  const pc = computer(impl, "a".repeat(32), "Desktop");
  await pc.push("worlds", "w1", Buffer.from("a world"), { name: "My Base" });
  // Something else of ours, moved into its place.
  const other = await (async () => {
    await pc.push("worlds", "w2", Buffer.from("a different world"), { name: "Other" });
    return [...files.values()].find(x => x.name === "w2.rlc");
  })();
  const target = [...files.values()].find(x => x.name === "w1.rlc");
  files.set(target.id, { ...target, body: other.body });
  check("a file swapped for another is caught by its hash",
    /is not what the manifest says it is/.test(await threw(() => pc.pull("worlds", "w1")) || ""), true);
}

// ── the key is no good without the other half ──
{
  const { impl } = sharedDrive();
  const pc = computer(impl, "a".repeat(32), "Desktop");
  await pc.push("accounts", null, Buffer.from("the tokens"), { name: "Accounts" });

  // Somebody with the whole Google account, and no Minecraft account.
  const thief = cloudSync.sync({
    drive: cloudDrive.drive({ token: async () => "at", fetchImpl: impl }),
    relayHalf: async () => crypto.randomBytes(32).toString("hex"),
    deviceId: "c".repeat(32), deviceName: "Somebody else",
  });
  check("the whole Drive, with the wrong relay half, opens nothing",
    /could not be opened/.test(await threw(() => thief.pull("accounts", null)) || ""), true,
    "which is the entire reason the key is in two places");
}

// ── stopping ──
{
  const { impl, files } = sharedDrive();
  const pc = computer(impl, "a".repeat(32), "Desktop");
  await pc.push("worlds", "w1", Buffer.from("a"), { name: "One" });
  await pc.push("worlds", "w2", Buffer.from("b"), { name: "Two" });

  await pc.unsync("worlds", "w1");
  check("unsyncing one takes it out of the Drive",
    [...files.values()].some(f => f.name === "w1.rlc"), false);
  check("and leaves the others alone",
    (await pc.list()).map(i => i.key), ["worlds/w2"]);

  await pc.unsyncAll();
  const left = [...files.values()].filter(f => f.mimeType !== "application/vnd.google-apps.folder");
  check("and unsyncing everything leaves nothing behind",
    left.map(f => f.name), [],
    "including the manifest and the key, so starting again starts clean");
}
{
  // The order matters: a key removed first would leave files nobody can ever
  // open, including the person who owns them.
  const src = (await import("fs")).readFileSync(
    new URL("../backend/cloud-sync.js", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("async function unsyncAll"));
  check("the key is the last thing removed",
    body.indexOf("KEY_FILE") > body.indexOf("MANIFEST"), true,
    "anything that fails before it leaves the folder still readable and worth trying again");
}

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
