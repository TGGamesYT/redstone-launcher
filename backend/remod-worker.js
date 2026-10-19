// Unpacking and packing a mod jar, OFF the main process.
//
// AdmZip is synchronous. A mod of any size -- a big one is tens of megabytes
// and tens of thousands of entries -- took five to ten seconds to unpack, and
// every window in the launcher was frozen for the whole of it, because that
// work was happening on the main process's one thread.
//
// Same shape as default-skins-worker.js and launcher-worker.js: an Electron
// utilityProcess rather than a worker_thread, because the app is packed into
// an asar and utilityProcess is the path Electron supports for that.
//
// Receives { type: "unpack", archive, dest } -> { ok: true, dirs }
//       or { type: "repack", dir, archive, dirs } -> { ok: true }
import remod from "./remod.js";

const post = (m) => { try { process.parentPort.postMessage(m); } catch { /* the parent went away */ } };

process.parentPort.on("message", (e) => {
  const msg = e.data;
  if (!msg) return;
  try {
    if (msg.type === "unpack") {
      const r = remod.unpack(msg.archive, msg.dest);
      post({ ok: true, dirs: r.dirs || [] });
    } else if (msg.type === "repack") {
      remod.repack(msg.dir, msg.archive, { dirs: msg.dirs || [] });
      post({ ok: true });
    } else {
      post({ ok: false, error: `unknown job "${msg.type}"` });
    }
  } catch (err) {
    post({ ok: false, error: (err && err.message) || String(err) });
  }
});
