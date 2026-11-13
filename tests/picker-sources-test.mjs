// What the block, item and mob picker reads from, and what it keeps.
//
// Three things from one round of feedback:
//
//   - a dev instance's picker did not have the mod being developed in it,
//     because that mod is not a jar in the mods folder: it is the project,
//     and Gradle runs it from the source tree;
//   - a version no instance had downloaded was read out of Mojang's jar over
//     the network on every launcher start, which is slow every single time;
//   - changing a skin from the launcher left every head showing the old one,
//     because the remembered profile was never told.
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let bad = 0;
const check = (what, got, want, note) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${note ? "  — " + note : ""}`
    + (ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`));
};

// icon-models.js imports only node modules and siblings, so it can be
// loaded as it is; projectResourceDirs needs nothing configured.
const IM = await import(path.join(ROOT, "backend", "icon-models.js"));

// ── a mod project's own assets ─────────────────────────────────────────────
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rl-proj-"));
  const mk = (rel) => fs.mkdirSync(path.join(tmp, ...rel.split("/")), { recursive: true });
  mk("src/main/resources/assets/mymod/models");
  mk("src/generated/resources/assets/mymod/models");     // NeoForge datagen
  mk("src/main/java/com/me");                            // not resources
  mk("fabric/src/main/generated/assets/mymod");          // Fabric datagen, multi-loader
  mk("common/src/main/resources/data/mymod");            // data only: no assets
  const rel = IM.projectResourceDirs(tmp).map(d => path.relative(tmp, d).split(path.sep).join("/"));
  check("a project's resources are found where the loaders put them",
    rel.sort(), ["fabric/src/main/generated", "src/generated/resources", "src/main/resources"],
    "hand-written, NeoForge's datagen, and Fabric's in a loader folder");
  check("and a folder with no assets in it is not one",
    rel.includes("common/src/main/resources"), false);
  fs.rmSync(tmp, { recursive: true, force: true });
}

const im = fs.readFileSync(path.join(ROOT, "backend", "icon-models.js"), "utf8");
const main = fs.readFileSync(path.join(ROOT, "backend", "main.js"), "utf8");

check("an instance's sources include its project, ahead of everything else",
  /out\.unshift\(MA\.dirSource\(label, 'mod', dir\)\)/.test(im), true,
  "the mod the dev instance is FOR is not in its mods folder");
check("and the launcher tells the picker where a dev instance's project is",
  /projectOf: \(profileId\) =>/.test(main), true);

// ── a jar read over the network is kept for next time ──────────────────────
check("a version read from Mojang's jar in place is also fetched to disk",
  /keepJarForNextTime\(v, url,/.test(im), true,
  "otherwise every launcher start reads it over the network again");
check("checked before it is kept, so a broken download is never the one used",
  [/if \(sha1\)/.test(im), /renameSync\(part, dest\)/.test(im)], [true, true]);
check("and not without limit",
  /const JARS_KEPT = \d+/.test(im) && /pruneKeptJars/.test(im), true);

// ── a skin changed here reaches the heads ──────────────────────────────────
{
  const calls = (name) => {
    const at = main.indexOf(name);
    if (at < 0) return false;
    const body = main.slice(at, main.indexOf("\n});", at) + 4);
    return /headsFollowSkinChange\(/.test(body);
  };
  check("uploading a skin updates the heads", calls("async function postSkinToMojang"), true);
  check("applying one from the library does", calls('ipcMain.handle("mc:applySkin"'), true);
  check("resetting to the default does", calls('ipcMain.handle("mc:resetSkin"'), true);
  check("and setting one by file does", calls("ipcMain.handle('set-player-skin'"), true);
  check("and every window is told to redraw them",
    /async function headsFollowSkinChange[\s\S]*?sendEverywhere\("heads-changed"/.test(main), true);
}

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
