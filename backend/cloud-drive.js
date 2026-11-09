// Google Drive, as much of it as syncing needs.
//
// Deliberately small: a folder, files in it, and the four things you can do
// to one. There is a official client library and it is a hundred times the
// size of this, pulls in its own auth stack, and would have to be kept in
// step with it -- for six REST calls that have not changed in a decade.
//
// Everything here works inside one folder the launcher makes, because the
// scope is drive.file: the launcher can only ever see files it created
// itself. It cannot list, read or touch anything else in the Drive, which is
// worth saying twice, because it is the difference between "this app syncs
// my launcher" and "this app can read my documents".
//
// Uploads are resumable above a few megabytes. A world is not a settings
// file: it is tens or hundreds of megabytes over whatever connection the
// person has, and a simple upload that fails at 90% starts again at zero.
const ROOT_FOLDER = "Redstone Launcher";
const FOLDER_MIME = "application/vnd.google-apps.folder";
// Over this, upload in chunks that can be picked up again. Google wants
// chunks to be a multiple of 256 KiB.
const RESUMABLE_OVER = 4 * 1024 * 1024;
const CHUNK = 8 * 1024 * 1024;

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";

/**
 * A Drive, for one signed-in account.
 *
 * `token()` is asked for an access token every time rather than handed one,
 * so a sync that runs longer than an hour refreshes in the middle instead of
 * failing at the end. That is the normal case for a world, not the unusual
 * one.
 */
export function drive({ token, fetchImpl = fetch }) {
  const call = async (url, { method = "GET", headers = {}, body, raw = false } = {}) => {
    const res = await fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${await token()}`, ...headers },
      body,
    });
    if (res.status === 401) throw Object.assign(new Error("Google would not accept the sign-in."), { signedOut: true });
    if (!res.ok) {
      let why = "";
      try { why = (await res.text()).slice(0, 300); } catch { /* nothing to add */ }
      throw Object.assign(new Error(`Drive said ${res.status}${why ? `: ${why}` : ""}`), { status: res.status });
    }
    return raw ? res : res.json();
  };

  const q = (s) => encodeURIComponent(s);
  // A name inside a Drive query is in single quotes, so a quote in one would
  // end the query early. Rare in a world's name; not impossible.
  const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

  /** The folder with this name under `parent`, made if it is not there. */
  async function folder(name, parent = "root") {
    const found = await call(`${API}/files?q=${q(
      `name='${esc(name)}' and mimeType='${FOLDER_MIME}' and '${esc(parent)}' in parents and trashed=false`
    )}&fields=files(id,name)&pageSize=2`);
    if (found.files && found.files.length) return found.files[0].id;
    const made = await call(`${API}/files?fields=id`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parent] }),
    });
    return made.id;
  }

  let rootId = null;
  /** The launcher's own folder, made once. */
  const root = async () => (rootId || (rootId = await folder(ROOT_FOLDER)));

  /** Everything in a folder, following the pages. */
  async function list(parentId) {
    const out = [];
    let pageToken = "";
    do {
      const page = await call(`${API}/files?q=${q(`'${esc(parentId)}' in parents and trashed=false`)}`
        + `&fields=nextPageToken,files(id,name,size,modifiedTime,mimeType,appProperties)`
        + `&pageSize=200${pageToken ? `&pageToken=${q(pageToken)}` : ""}`);
      out.push(...(page.files || []));
      pageToken = page.nextPageToken || "";
    } while (pageToken);
    return out;
  }

  /** The file called `name` in `parentId`, or null. */
  const find = async (parentId, name) => {
    const r = await call(`${API}/files?q=${q(
      `name='${esc(name)}' and '${esc(parentId)}' in parents and trashed=false`
    )}&fields=files(id,name,size,modifiedTime,appProperties)&pageSize=2`);
    return (r.files && r.files[0]) || null;
  };

  /** Its contents, as bytes. */
  async function get(fileId) {
    const res = await call(`${API}/files/${q(fileId)}?alt=media`, { raw: true });
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * Write a file, replacing one of the same name.
   *
   * `props` are small strings kept with the file -- what it is, which device
   * last wrote it, when -- so the manifest and the files cannot disagree
   * about what is there. Drive allows 124 bytes per key and value together.
   */
  async function put(parentId, name, bytes, { props = {}, onProgress } = {}) {
    const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const existing = await find(parentId, name);
    const meta = existing
      ? { name, appProperties: props }
      : { name, parents: [parentId], appProperties: props };

    if (body.length <= RESUMABLE_OVER) {
      const boundary = `rl${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
      const head = Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`
        + `${JSON.stringify(meta)}\r\n--${boundary}\r\n`
        + `Content-Type: application/octet-stream\r\n\r\n`);
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
      const r = await call(
        `${UPLOAD}/files${existing ? `/${q(existing.id)}` : ""}?uploadType=multipart&fields=id,size,modifiedTime`,
        {
          method: existing ? "PATCH" : "POST",
          headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
          body: Buffer.concat([head, body, tail]),
        });
      if (onProgress) onProgress(body.length, body.length);
      return r;
    }

    // Big enough to be worth not starting again. Google hands back a URL to
    // push chunks at, and tells us where it got to if one is lost.
    const start = await call(
      `${UPLOAD}/files${existing ? `/${q(existing.id)}` : ""}?uploadType=resumable&fields=id,size,modifiedTime`,
      {
        method: existing ? "PATCH" : "POST",
        headers: {
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Length": String(body.length),
        },
        body: JSON.stringify(meta),
        raw: true,
      });
    const session = start.headers.get("location");
    if (!session) throw new Error("Drive did not offer a resumable upload.");

    let at = 0;
    while (at < body.length) {
      const end = Math.min(at + CHUNK, body.length);
      const res = await fetchImpl(session, {
        method: "PUT",
        headers: {
          "Content-Length": String(end - at),
          "Content-Range": `bytes ${at}-${end - 1}/${body.length}`,
        },
        body: body.subarray(at, end),
      });
      if (res.status === 200 || res.status === 201) {
        if (onProgress) onProgress(body.length, body.length);
        return res.json();
      }
      if (res.status === 308) {
        // It took some of it. The Range header says how much, and it is NOT
        // always the whole chunk -- carrying on from where we assumed rather
        // than from where it says is how an upload ends up corrupt.
        const range = res.headers.get("range");
        const got = range && /bytes=0-(\d+)/.exec(range);
        at = got ? Number(got[1]) + 1 : end;
        if (onProgress) onProgress(at, body.length);
        continue;
      }
      let why = ""; try { why = (await res.text()).slice(0, 200); } catch { /* ignore */ }
      throw new Error(`Drive said ${res.status} part way through${why ? `: ${why}` : ""}`);
    }
    throw new Error("The upload ended without Drive saying it was done.");
  }

  /** Take it away. Properly -- not to the bin, which still counts against the quota. */
  const remove = (fileId) => call(`${API}/files/${q(fileId)}`, { method: "DELETE", raw: true });

  /** How much room is left, so "it stopped working" has an answer. */
  async function room() {
    const a = await call(`${API}/about?fields=storageQuota,user(emailAddress)`);
    const quota = a.storageQuota || {};
    return {
      email: a.user && a.user.emailAddress || null,
      used: Number(quota.usage || 0),
      limit: quota.limit ? Number(quota.limit) : null,   // null means unlimited
    };
  }

  return { root, folder, list, find, get, put, remove, room, ROOT_FOLDER };
}

export default { drive, ROOT_FOLDER, RESUMABLE_OVER };
