// Pulls the default player skins out of a Minecraft client jar, OFF the main
// process.
//
// The nine defaults (Alex, Ari, Efe, Kai, Makena, Noor, Steve, Sunny, Zuri) are
// not hashed assets — they live inside the client jar, two models each, at
//   assets/minecraft/textures/entity/player/<wide|slim>/<name>.png
// so getting them means downloading ~40 MB and reading a zip whose central
// directory has around twenty thousand entries.
//
// AdmZip is synchronous, so doing that in the main process froze every window
// for as long as it took — which is what the launcher did on its first run,
// right when it also wanted to draw its first heads. Here it costs the main
// process nothing: measured against a real 39.6 MB jar, the extraction took
// 4.6 seconds and the main thread's worst stall was 9ms.
//
// Same shape as launcher-worker.js: an Electron utilityProcess rather than a
// worker_thread, because the app is packed into an asar and utilityProcess is
// the path Electron supports for that.
//
// Receives { jarUrl, version, keepAt }, posts { ok: true, version, skins, jar }
// or { ok: false, error }.
//
// `keepAt` is where to save the jar once it is here. The whole 40 MB is
// downloaded either way, and the block and item models the version icons are
// rendered from live in the same file — so throwing it away only meant
// downloading it again. `jar` in the reply is the path it was saved to, or null
// if saving failed (which is not a reason to fail the skins).
import AdmZip from "adm-zip";
import fs from "fs";
import path from "path";

const PLAYER_TEXTURES = "assets/minecraft/textures/entity/player/";
const post = (m) => { try { process.parentPort.postMessage(m); } catch { /* parent gone */ } };

async function run({ jarUrl, version, keepAt }) {
  const res = await fetch(jarUrl);
  if (!res.ok) throw new Error(`client jar: HTTP ${res.status}`);
  const jar = Buffer.from(await res.arrayBuffer());

  // Written to a temporary name and renamed, so a half-written jar can never be
  // read as a complete one by whatever picks it up next.
  let kept = null;
  if (keepAt) {
    try {
      fs.mkdirSync(path.dirname(keepAt), { recursive: true });
      const tmp = keepAt + ".part";
      fs.writeFileSync(tmp, jar);
      fs.renameSync(tmp, keepAt);
      kept = keepAt;
    } catch { /* the cache is a bonus; the skins are the job */ }
  }

  const zip = new AdmZip(jar);
  const skins = [];
  for (const e of zip.getEntries()) {
    const p = e.entryName;
    if (!p.startsWith(PLAYER_TEXTURES) || !p.endsWith(".png")) continue;
    const parts = p.split("/");
    const model = parts[parts.length - 2];        // wide | slim
    if (model !== "wide" && model !== "slim") continue;
    skins.push({
      name: parts[parts.length - 1].replace(/\.png$/, ""),
      model,
      base64: e.getData().toString("base64"),
    });
  }
  // By name then model, which is the order the default picker indexes into —
  // so it has to be stable, or every account's default would move about.
  skins.sort((a, b) => a.name.localeCompare(b.name) || a.model.localeCompare(b.model));
  return { ok: true, version, skins, jar: kept };
}

process.parentPort.on("message", (e) => {
  const msg = (e && e.data) || {};
  if (msg.type !== "build") return;
  run(msg)
    .then(post)
    .catch(err => post({ ok: false, error: String(err && err.message || err) }));
});
