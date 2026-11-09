// The Drive layer, against a stand-in Drive.
//
// A fake that behaves the way the real one does in the places that matter --
// paging, resumable uploads that take less than they were given, 401 when a
// sign-in has gone stale. Those are the cases that are never exercised by
// hand and are exactly where a sync corrupts something or stops silently.
import cloud from "../backend/cloud-drive.js";

let bad = 0;
const ok = (what, note) => console.log(`ok   ${what}${note ? "  — " + note : ""}`);
const fail = (what, why) => { bad++; console.log(`FAIL ${what}\n       ${why}`); };
const check = (what, got, want, note) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) ok(what, note); else fail(what, `got  ${a}\n       want ${b}`);
};
const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

/**
 * A Drive that is enough like the real one.
 *
 * `takes` is how much of each chunk it accepts, so an upload that is only
 * partly taken can be tested -- the case that quietly corrupts a file if the
 * client carries on from where it assumed rather than where Drive said.
 */
function fakeDrive({ takes = Infinity, fail401 = false } = {}) {
  const files = new Map();                 // id -> { id, name, parents, body, appProperties }
  const sessions = new Map();
  let n = 0;
  const calls = [];

  const impl = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method || "GET";
    calls.push(`${method} ${u.pathname}${u.search ? "?" + u.searchParams.toString().slice(0, 60) : ""}`);
    if (fail401) return { ok: false, status: 401, text: async () => "no" };

    const json = (v) => ({ ok: true, status: 200, json: async () => v, text: async () => JSON.stringify(v) });

    if (u.pathname.startsWith("/upload/drive/v3/files")) {
      const kind = u.searchParams.get("uploadType");
      const idInPath = u.pathname.split("/").pop();
      const updating = idInPath !== "files" ? idInPath : null;
      if (kind === "multipart") {
        const body = Buffer.from(init.body);
        const text = body.toString("latin1");
        const meta = JSON.parse(/\r\n\r\n(\{.*?\})\r\n--/s.exec(text)[1]);
        const start = text.indexOf("\r\n\r\n", text.indexOf("application/octet-stream")) + 4;
        const end = text.lastIndexOf("\r\n--");
        const id = updating || `f${++n}`;
        files.set(id, { id, ...(files.get(id) || {}), ...meta, body: body.subarray(start, end) });
        return json({ id, size: String(end - start) });
      }
      // resumable: hand back a session URL
      const id = updating || `f${++n}`;
      const meta = JSON.parse(String(init.body));
      const sid = `s${++n}`;
      sessions.set(sid, { id, meta, got: Buffer.alloc(0) });
      return {
        ok: true, status: 200,
        headers: { get: (k) => (k.toLowerCase() === "location" ? `https://upload.example/${sid}` : null) },
        json: async () => ({}),
      };
    }

    if (u.hostname === "upload.example") {
      const s = sessions.get(u.pathname.slice(1));
      const chunk = Buffer.from(init.body);
      const total = Number(/\/(\d+)$/.exec(init.headers["Content-Range"])[1]);
      const take = chunk.subarray(0, Math.min(takes, chunk.length));
      s.got = Buffer.concat([s.got, take]);
      if (s.got.length >= total) {
        files.set(s.id, { id: s.id, ...s.meta, body: s.got });
        return { ok: true, status: 200, json: async () => ({ id: s.id, size: String(s.got.length) }) };
      }
      return {
        ok: true, status: 308,
        headers: { get: (k) => (k.toLowerCase() === "range" ? `bytes=0-${s.got.length - 1}` : null) },
        text: async () => "",
      };
    }

    if (u.pathname === "/drive/v3/about") {
      return json({ storageQuota: { usage: "10", limit: "100" }, user: { emailAddress: "a@b.c" } });
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
      const name = (/name='((?:[^'\\]|\\.)*)'/.exec(query) || [])[1];
      const parent = (/'((?:[^'\\]|\\.)*)' in parents/.exec(query) || [])[1];
      const wantFolder = /mimeType='application\/vnd\.google-apps\.folder'/.test(query);
      const unesc = (s) => String(s == null ? s : s.replace(/\\(.)/g, "$1"));
      let out = [...files.values()].filter(f =>
        (name === undefined || f.name === unesc(name))
        && (parent === undefined || (f.parents || []).includes(unesc(parent)))
        && (!wantFolder || f.mimeType === "application/vnd.google-apps.folder"));
      // Paging, which is the thing that is never noticed until there are
      // more than a page of worlds.
      const size = Number(u.searchParams.get("pageSize") || 100);
      const from = Number(u.searchParams.get("pageToken") || 0);
      const page = out.slice(from, from + size);
      return json({
        files: page.map(f => ({ ...f, size: String((f.body || "").length), body: undefined })),
        nextPageToken: from + size < out.length ? String(from + size) : undefined,
      });
    }
    throw new Error(`the test did not expect ${method} ${u.pathname}`);
  };
  return { impl, files, calls };
}

const make = (opts) => {
  const f = fakeDrive(opts);
  return { ...f, d: cloud.drive({ token: async () => "at", fetchImpl: f.impl }) };
};

// ── the folder ──
{
  const { d, files } = make();
  const a = await d.root();
  const b = await d.root();
  check("the launcher's folder is made once and found after that", a, b);
  check("and it is one folder, not one per call",
    [...files.values()].filter(f => f.mimeType === "application/vnd.google-apps.folder").length, 1);
  check("named so a person can see what it is", [...files.values()][0].name, "Redstone Launcher");
}

// ── writing and reading ──
{
  const { d } = make();
  const root = await d.root();
  await d.put(root, "settings.rlc", Buffer.from("hello"), { props: { kind: "settings" } });
  const f = await d.find(root, "settings.rlc");
  check("a file written is found again", [f.name, f.appProperties.kind], ["settings.rlc", "settings"]);
  check("and reads back exactly", (await d.get(f.id)).toString(), "hello");

  await d.put(root, "settings.rlc", Buffer.from("goodbye"));
  const again = await d.list(root);
  check("writing it again replaces it rather than making a second",
    [again.length, (await d.get(again[0].id)).toString()], [1, "goodbye"],
    "two files of the same name is how a sync starts disagreeing with itself");

  await d.remove(again[0].id);
  check("and removing it takes it away", (await d.list(root)).length, 0);
}

// ── paging ──
{
  const { d } = make();
  const root = await d.root();
  for (let i = 0; i < 450; i++) await d.put(root, `w${i}.rlc`, Buffer.from("x"));
  const all = await d.list(root);
  check("listing follows the pages to the end", all.length, 450,
    "Drive hands back 200 at a time; stopping at the first page loses the rest");
}

// ── a big upload ──
{
  const big = Buffer.alloc(cloud.RESUMABLE_OVER + 1234, 7);
  const { d } = make();
  const root = await d.root();
  const seen = [];
  await d.put(root, "world.rlc", big, { onProgress: (at, total) => seen.push([at, total]) });
  const f = await d.find(root, "world.rlc");
  check("something too big for one go still arrives whole",
    [(await d.get(f.id)).length, (await d.get(f.id)).equals(big)], [big.length, true]);
  check("and it says how far along it is while it goes",
    [seen.length > 0, seen[seen.length - 1][0]], [true, big.length]);
}
{
  // Drive taking less than it was given is the case that corrupts a file if
  // the client carries on from where it assumed.
  const big = Buffer.alloc(cloud.RESUMABLE_OVER + 5000, 3);
  const { d } = make({ takes: 1000 });
  const root = await d.root();
  await d.put(root, "world.rlc", big);
  const f = await d.find(root, "world.rlc");
  check("an upload only partly taken carries on from where Drive says, not from where we hoped",
    (await d.get(f.id)).equals(big), true,
    "the Range header is the truth; assuming the whole chunk landed is how a world arrives corrupt");
}

// ── a name with a quote in it ──
{
  const { d } = make();
  const root = await d.root();
  await d.put(root, "Steve's world.rlc", Buffer.from("x"));
  const f = await d.find(root, "Steve's world.rlc");
  check("a name with a quote in it is found, not a query that ends early",
    f && f.name, "Steve's world.rlc",
    "rare in a world's name; not impossible");
}

// ── when things go wrong ──
{
  const { d } = make({ fail401: true });
  const e = await threw(() => d.root());
  check("a sign-in Google will not accept says so, in a way the caller can act on",
    [e.signedOut, /would not accept/.test(e.message)], [true, true],
    "so the settings page can ask them to sign in again rather than show a number");
}
{
  const { d } = make();
  const e = await threw(() => d.get("nope"));
  check("and anything else carries the status", e.status, 404);
}

// ── how much room ──
{
  const { d } = make();
  check("there is an answer to \"why did it stop\"", await d.room(),
    { email: "a@b.c", used: 10, limit: 100 });
}

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
