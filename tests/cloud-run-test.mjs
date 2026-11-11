// A whole sync, on two computers, end to end.
//
// Everything below this is stubbed except the launcher's own code: a Drive
// both computers can see, a relay that answers the way the real one does,
// and two launchers with their own settings, themes and accounts. So what is
// exercised is the thing the Sync now button actually does.
//
// The case this exists for is the second half: both computers change the
// same thing, and neither is allowed to quietly win.
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { cloud as makeCloud } from "../backend/cloud.js";

/**
 * Stand-in for Modrinth and CurseForge: the files the world knows about,
 * by sha1, which is how the real lookup answers too.
 */
const FETCHABLE = new Map();
const publish = (body) => {
  FETCHABLE.set(crypto.createHash("sha1").update(body).digest("hex"), Buffer.from(body));
  return body;
};

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cloudrun-"));
function put(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return root;
}

let bad = 0;
const ok = (what, note) => console.log(`ok   ${what}${note ? "  — " + note : ""}`);
const fail = (what, why) => { bad++; console.log(`FAIL ${what}\n       ${why}`); };
const check = (what, got, want, note) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) ok(what, note); else fail(what, `got  ${a}\n       want ${b}`);
};

const RELAY_HALF = crypto.randomBytes(32).toString("hex");

// ── one Drive, seen by both ──
function sharedDrive() {
  const files = new Map();
  let n = 0;
  return async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method || "GET";
    const json = (v) => ({ ok: true, status: 200, json: async () => v, text: async () => JSON.stringify(v) });
    const unesc = (s) => (s == null ? s : String(s).replace(/\\(.)/g, "$1"));
    if (u.pathname.startsWith("/oauth2") || u.hostname === "oauth2.googleapis.com") {
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: "at", expires_in: 3600 }) };
    }
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
    if (u.pathname === "/drive/v3/about") {
      return json({ storageQuota: { usage: "1", limit: "100" }, user: { emailAddress: "me@example.com" } });
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

/** One launcher: its own settings store, themes, accounts and files on disk. */
function launcher(impl, { name, settings = {}, themes = [], players = [], profiles = [], root = null } = {}) {
  const store = { ...settings, cloudGoogle: { refreshToken: "rt", email: "me@example.com" } };
  const s = {
    store,
    get: (k, d) => (k in store ? store[k] : d),
    set: (k, v) => { store[k] = v; },
  };
  const state = { themes: [...themes], players: [...players], profiles: [...profiles] };
  const c = makeCloud({
    settings: s,
    relayCall: async (req) => (req.op === "secret"
      ? { ok: true, half: RELAY_HALF }
      : { ok: true, clientId: "id", clientSecret: "sec" }),
    fetchImpl: impl,
    content: {
      readThemes: () => state.themes,
      writeThemes: (l) => { state.themes = l; },
      readPlayers: () => state.players,
      writePlayers: (l) => { state.players = l; },
      readProfiles: () => state.profiles,
      instanceDir: (id) => path.join(root, String(id)),
      worldDir: (id, world) => path.join(root, String(id), "saves", String(world)),
      listWorlds: (id) => {
        try {
          return fs.readdirSync(path.join(root, String(id), "saves"), { withFileTypes: true })
            .filter(e => e.isDirectory()).map(e => e.name).sort();
        } catch { return []; }
      },
      knowsFiles: async (entries) => entries.map(e => FETCHABLE.has(e.sha1)),
      fetchFile: async (entry) => FETCHABLE.get(entry.sha1) || null,
    },
  });
  s.set("cloudDeviceName", name);
  for (const k of ["settings", "themes", "accounts"]) c.setKind(k, true);
  return { c, s, state, store };
}

const did = (r, kind) => (r.results.find(x => x.kind === kind) || {}).did;

// ── one computer up, the other down ──
{
  const impl = sharedDrive();
  const pc = launcher(impl, {
    name: "Desktop",
    settings: { baseColor: "#111111", font: "Pixel" },
    themes: [{ name: "Mine", at: 1 }],
    players: [{ id: "p1", username: "TGdoesCode", refresh: "the-token" }],
  });
  const up = await pc.c.syncNow();
  check("the first sync sends everything that is switched on",
    ["settings", "themes", "accounts"].map(k => did(up, k)), ["pushed", "pushed", "pushed"]);

  const laptop = launcher(impl, { name: "Laptop", settings: { baseColor: "#ffffff" } });
  const down = await laptop.c.syncNow();
  check("and the second computer takes it",
    ["settings", "themes", "accounts"].map(k => did(down, k)), ["pulled", "pulled", "pulled"]);
  check("the settings arrived", laptop.s.get("baseColor"), "#111111");
  check("the themes arrived", laptop.state.themes.map(t => t.name), ["Mine"]);
  check("and so did the account, token and all",
    [laptop.state.players.length, laptop.state.players[0].refresh], [1, "the-token"],
    "which is the whole reason to sync accounts");

  const again = await laptop.c.syncNow();
  check("syncing again with nothing changed does nothing",
    ["settings", "themes", "accounts"].map(k => did(again, k)), ["nothing", "nothing", "nothing"],
    "a sync that pushes every time is a sync nobody can tell is working");
}

// ── both changed ──
{
  const impl = sharedDrive();
  const pc = launcher(impl, { name: "Desktop", settings: { baseColor: "#111111" } });
  await pc.c.syncNow();
  const laptop = launcher(impl, { name: "Laptop" });
  await laptop.c.syncNow();

  pc.s.set("baseColor", "#aa0000");
  laptop.s.set("baseColor", "#0000aa");
  await laptop.c.syncNow();                  // laptop gets there first
  const clash = await pc.c.syncNow();

  check("the second one to sync is told, not overwritten",
    did(clash, "settings"), "conflict",
    "quietly taking whichever saved last is how somebody's settings disappear");
  check("and nothing of either was changed by the attempt",
    [pc.s.get("baseColor"), laptop.s.get("baseColor")], ["#aa0000", "#0000aa"]);
  check("it says which computer it clashed with",
    /Laptop/.test((clash.results.find(r => r.kind === "settings") || {}).why || ""), true);

  // And the two ways out, which a person chooses.
  await pc.c.keepMine("settings");
  const after = await laptop.c.syncNow();
  check("keeping this computer's makes the Drive match it",
    [did(after, "settings"), laptop.s.get("baseColor")], ["pulled", "#aa0000"]);
}
{
  const impl = sharedDrive();
  const pc = launcher(impl, { name: "Desktop", settings: { baseColor: "#111111" } });
  await pc.c.syncNow();
  const laptop = launcher(impl, { name: "Laptop" });
  await laptop.c.syncNow();
  pc.s.set("baseColor", "#aa0000");
  laptop.s.set("baseColor", "#0000aa");
  await laptop.c.syncNow();
  await pc.c.syncNow();                      // conflict
  await pc.c.takeTheirs("settings");
  check("or taking the Drive's replaces what is here",
    pc.s.get("baseColor"), "#0000aa");
}

// ── one kind clashing does not stop the rest ──
{
  const impl = sharedDrive();
  const pc = launcher(impl, { name: "Desktop", settings: { baseColor: "#111111" }, themes: [{ name: "A", at: 1 }] });
  await pc.c.syncNow();
  const laptop = launcher(impl, { name: "Laptop" });
  await laptop.c.syncNow();

  pc.s.set("baseColor", "#aa0000");
  laptop.s.set("baseColor", "#0000aa");
  await laptop.c.syncNow();
  pc.state.themes.push({ name: "B", at: 2 });
  const mixed = await pc.c.syncNow();
  check("the clashing kind is reported and the others still go",
    [did(mixed, "settings"), did(mixed, "themes")], ["conflict", "pushed"],
    "one conflict must not stop the other five from syncing");
}

// ── what is switched off stays off ──
{
  const impl = sharedDrive();
  const pc = launcher(impl, { name: "Desktop", settings: { baseColor: "#111111" }, players: [{ id: "p1", refresh: "t" }] });
  pc.c.setKind("accounts", false);
  const r = await pc.c.syncNow();
  check("a kind that is switched off is not synced",
    [did(r, "settings"), did(r, "accounts")], ["pushed", undefined],
    "and is not quietly included because the others were");
}

// ── and the Google token is not in any of it ──
{
  const impl = sharedDrive();
  const files = [];
  const watched = async (url, init) => {
    if (init && init.body && Buffer.isBuffer(init.body)) files.push(init.body.toString("latin1"));
    return impl(url, init);
  };
  const pc = launcher(watched, {
    name: "Desktop",
    settings: { baseColor: "#111111" },
    players: [{ id: "p1", refresh: "minecraft-token" }],
  });
  pc.s.set("cloudGoogle", { refreshToken: "GOOGLE-TOKEN", email: "me@example.com" });
  await pc.c.syncNow();
  const all = files.join("");
  check("nothing sent to Drive contains the Google token",
    all.includes("GOOGLE-TOKEN"), false,
    "it is the key to the folder being written to");
  check("and the Minecraft token, which IS synced, is not sent readable",
    all.includes("minecraft-token"), false,
    "it is in there, encrypted with both halves");
}

// ── one instance, sent on purpose, and taken on another computer ──
//
// The case the whole per-instance design exists for. The two computers
// number their instances differently -- they always do -- so "pull the one
// with my id" is exactly what must NOT be how this works.
{
  const impl = sharedDrive();

  const pcRoot = tmp();
  put(pcRoot, {
    "7/mods/sodium.jar": publish("SODIUM-BYTES"),
    "7/mods/private.jar": "NOBODY HAS THIS",
    "7/config/sodium.json": '{"q":"high"}',
    "7/saves/My Base/level.dat": "A WHOLE WORLD",
    "7/saves/Spare/level.dat": "ANOTHER",
  });
  const pc = launcher(impl, {
    name: "Desktop", root: pcRoot,
    profiles: [{ id: 7, name: "1.21 Fabric", version: "1.21", loader: "fabric" }],
  });

  const parts = await pc.c.instanceParts(7);
  check("the page is told which files nothing can fetch, before anything goes",
    parts.loose.map(f => f.path), ["mods/private.jar"],
    "so the choice to carry them is somebody's, made knowing what it costs");
  check("and which worlds there are to choose from", parts.worlds, ["My Base", "Spare"]);

  // Send it: one world, and the file nothing can fetch.
  const up = await pc.c.pushInstance(7, { worlds: ["My Base"], loose: true });
  check("sending one instance sends it", up.ok, true);
  check("the world went with it, and only the one asked for",
    [up.worlds.sent, up.worlds.failed], [["My Base"], []]);
  check("and the unfetchable file was carried rather than recorded",
    [up.describe.files, up.describe.carried], [1, 2],
    "sodium recorded; the private jar and the config carried");

  // Another computer. Same instance, different number.
  const lapRoot = tmp();
  const laptop = launcher(impl, {
    name: "Laptop", root: lapRoot,
    profiles: [{ id: 31, name: "Empty", version: "1.21", loader: "fabric" }],
  });
  const down = await laptop.c.pullInstance(7, { intoId: 31 });
  check("it can be written into a differently-numbered instance", down.ok, true,
    "two computers never agree on an instance id, so pulling by id alone would never work twice");
  check("the mod that could be fetched was fetched",
    fs.readFileSync(path.join(lapRoot, "31/mods/sodium.jar"), "utf8"), "SODIUM-BYTES");
  check("the one that could not was carried, so it is here too",
    fs.readFileSync(path.join(lapRoot, "31/mods/private.jar"), "utf8"), "NOBODY HAS THIS");
  check("the config came", fs.readFileSync(path.join(lapRoot, "31/config/sodium.json"), "utf8"), '{"q":"high"}');
  check("and the world landed in THIS instance's saves",
    [fs.readFileSync(path.join(lapRoot, "31/saves/My Base/level.dat"), "utf8"),
      fs.existsSync(path.join(lapRoot, "31/saves/Spare"))],
    ["A WHOLE WORLD", false],
    "the world that was not chosen was never sent, so it cannot arrive");
}

// ── a world on its own, into any instance ──
{
  const impl = sharedDrive();
  const pcRoot = tmp();
  put(pcRoot, { "7/saves/My Base/level.dat": "A WHOLE WORLD" });
  const pc = launcher(impl, { name: "Desktop", root: pcRoot, profiles: [{ id: 7, name: "A" }] });
  await pc.c.pushWorld(7, "My Base");

  const lapRoot = tmp();
  const laptop = launcher(impl, { name: "Laptop", root: lapRoot, profiles: [{ id: 31, name: "B" }] });
  const seen = await laptop.c.cloudWorlds();
  check("a synced world is findable without knowing whose instance it was",
    seen.map(w => [w.instanceId, w.world]), [["7", "My Base"]],
    "the id in the key is the SENDING computer's, so it means nothing here");

  await laptop.c.pullWorld("7", "My Base", { intoId: 31 });
  check("and it can be imported into an instance here",
    fs.readFileSync(path.join(lapRoot, "31/saves/My Base/level.dat"), "utf8"), "A WHOLE WORLD");
}

// ── and none of this is swept up by "sync everything" ──
{
  const impl = sharedDrive();
  const root = tmp();
  put(root, { "7/mods/a.jar": "A", "7/saves/W/level.dat": "W" });
  const pc = launcher(impl, {
    name: "Desktop", root, settings: { baseColor: "#111111" },
    profiles: [{ id: 7, name: "A", version: "1.21" }],
  });
  for (const k of ["settings", "themes", "accounts", "servers"]) pc.c.setKind(k, true);
  // The switches that used to exist for these, set as high as they go.
  pc.c.setKind("instances", true);
  pc.c.setKind("worlds", true);
  const r = await pc.c.syncNow();
  check("no instance or world is sent by syncing everything",
    r.results.map(x => x.kind).filter(k => k === "instances" || k === "worlds"), [],
    "sending somebody's instances because a box was ticked is not what ticking a box means");
  const items = await pc.c.list();
  check("and nothing of the sort reached the Drive",
    items.filter(i => i.kind === "instances" || i.kind === "worlds").length, 0);
}

// ── keeping in step by itself ──
//
// A switch, and nothing more than the Sync now button on a timer. What
// matters is what it is NOT: it must not decide anything a person would
// have been asked about.
{
  const impl = sharedDrive();
  const pc = launcher(impl, { name: "Desktop", settings: { baseColor: "#111111" } });

  check("it is off until it is asked for", pc.c.autoSync(), false,
    "syncing on a timer is a thing to opt into");
  check("and the settings page is told which it is",
    (await pc.c.status()).auto, false);
  pc.c.setAutoSync(true);
  check("turning it on sticks", [pc.c.autoSync(), (await pc.c.status()).auto], [true, true]);

  // With it on, a sync is still exactly the sync the button does.
  await pc.c.syncNow();
  const laptop = launcher(impl, { name: "Laptop" });
  laptop.c.setAutoSync(true);
  await laptop.c.syncNow();

  pc.s.set("baseColor", "#aa0000");
  laptop.s.set("baseColor", "#0000aa");
  await laptop.c.syncNow();
  const clash = await pc.c.syncNow();
  check("something changed in both places is still a conflict",
    did(clash, "settings"), "conflict",
    "a sync that runs by itself must not settle anything by itself");
  check("and neither copy was touched",
    [pc.s.get("baseColor"), laptop.s.get("baseColor")], ["#aa0000", "#0000aa"]);

  pc.c.setAutoSync(false);
  check("and it can be turned off again", pc.c.autoSync(), false);
}

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
