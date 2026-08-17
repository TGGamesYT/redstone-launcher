// Runs a Minecraft launch OFF the main process.
//
// mclc's launch() does heavy, largely-synchronous work (hashing every asset,
// unzipping natives, verifying libraries) which blocked Electron's main event
// loop and froze the whole UI. This runs in an Electron utilityProcess, so all
// of that happens on a separate process/event loop and the app stays smooth.
//
// It receives a fully-resolved launch config from the main process, forwards
// mclc's log/progress events back, reports the spawned PID, and stays alive only
// long enough to report the game's exit (the game itself is detached and
// survives this worker).
import { vanilla, fabric, quilt, forge, neoforge } from "tomate-loaders";
import { Client } from "minecraft-launcher-core";

const LOADERS = { vanilla, fabric, quilt, forge, neoforge };
const post = (m) => { try { process.parentPort.postMessage(m); } catch { /* ignore */ } };

function isTransient(err) {
  const s = String(err && err.message || err || "");
  return /\b(429|500|502|503|504)\b/.test(s) || /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network|timed? ?out|fetch failed/i.test(s);
}
async function withRetry(fn, tries = 3) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try { return await fn(); }
    catch (e) { last = e; if (i >= tries || !isTransient(e)) throw e; await new Promise(r => setTimeout(r, 800 * 2 ** (i - 1))); }
  }
  throw last;
}

async function runLaunch(cfg) {
  const loaderer = LOADERS[cfg.loader] || vanilla;
  const launcherConfig = await withRetry(() => loaderer.getMCLCLaunchConfig({
    gameVersion: cfg.gameVersion,
    rootPath: cfg.rootPath,
    ...(cfg.loaderVersion ? { loaderVersion: cfg.loaderVersion } : {}),
  }));

  const launcher = new Client();
  launcher.on("data", (m) => post({ type: "log", line: String(m) }));
  launcher.on("debug", (m) => post({ type: "log", line: String(m) }));
  launcher.on("error", (e) => post({ type: "log", line: "ERROR: " + (e?.message || e) }));
  launcher.on("progress", (p) => post({ type: "progress", p }));
  launcher.on("download-status", (s) => post({ type: "dl", s }));

  const opts = {
    ...launcherConfig,
    authorization: cfg.auth,
    memory: cfg.memory,
    javaPath: cfg.javaPath,
    overrides: { assetRoot: cfg.assetRoot, detached: true },
    quickPlay: cfg.quickPlay || null,
  };
  if (cfg.customArgs && cfg.customArgs.length) opts.customArgs = cfg.customArgs;
  if (cfg.customLaunchArgs && cfg.customLaunchArgs.length) opts.customLaunchArgs = cfg.customLaunchArgs;

  const child = await withRetry(() => launcher.launch(opts), 2);
  if (!child || !child.pid) { post({ type: "error", error: "The game process failed to start" }); return; }
  try { child.unref(); } catch { /* ignore */ }
  post({ type: "spawned", pid: child.pid });
  if (child.stdout) child.stdout.on("data", (d) => post({ type: "gamelog", line: d.toString() }));
  if (child.stderr) child.stderr.on("data", (d) => post({ type: "gamelog", line: d.toString() }));
  child.on("exit", (code) => post({ type: "exit", pid: child.pid, code }));
  child.on("error", (e) => post({ type: "log", line: "ERROR: " + (e?.message || e) }));
}

process.parentPort.on("message", async (e) => {
  const msg = e.data;
  if (!msg || msg.type !== "launch") return;
  try { await runLaunch(msg.cfg); }
  catch (err) { post({ type: "error", error: err && err.message || String(err) }); }
});
