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
import { cloud as makeCloud } from "../backend/cloud.js";

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

/** One launcher: its own settings store, themes and accounts. */
function launcher(impl, { name, settings = {}, themes = [], players = [] } = {}) {
  const store = { ...settings, cloudGoogle: { refreshToken: "rt", email: "me@example.com" } };
  const s = {
    store,
    get: (k, d) => (k in store ? store[k] : d),
    set: (k, v) => { store[k] = v; },
  };
  const state = { themes: [...themes], players: [...players] };
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

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
