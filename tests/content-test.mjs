// Putting a file you already have into an instance or a server, and which
// folder of jars a server actually keeps.
//
// Everything else the launcher installs comes from somewhere online. A jar
// built by hand, a pack sent by a friend, a plugin off a forum had nowhere to
// go but the folder itself.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "node_modules", ".cache", "content");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

let bad = 0;
const check = (label, got, want, note) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${note ? "  — " + note : ""}\n       got  ${JSON.stringify(got)}` + (ok ? "" : `\n       want ${JSON.stringify(want)}`));
};

const src = fs.readFileSync(path.join(ROOT, "backend/main.js"), "utf8");
const page = fs.readFileSync(path.join(ROOT, "frontend/server.html"), "utf8");

// ── where each kind of file goes ──
const cut = (a, b) => {
  const i = src.indexOf(a), j = src.indexOf(b, i);
  if (i < 0 || j < 0) { console.log(`FAIL could not find ${JSON.stringify(i < 0 ? a : b)} in main.js`); process.exit(1); }
  return src.slice(i, j);
};
const CONTENT_FILES = new Function(`${cut("const CONTENT_FILES = {", "ipcMain.handle(\"content:addFiles\"")} return CONTENT_FILES;`)();
check("a jar is what mods and plugins take",
  [CONTENT_FILES.mods.extensions, CONTENT_FILES.plugins.extensions], [["jar"], ["jar"]]);
check("and a zip is what the packs take",
  [CONTENT_FILES.resourcepacks.extensions, CONTENT_FILES.shaderpacks.extensions, CONTENT_FILES.datapacks.extensions],
  [["zip"], ["zip"], ["zip"]]);
check("every kind the content tabs show is covered",
  ["mods", "plugins", "resourcepacks", "shaderpacks", "datapacks"].map(k => !!CONTENT_FILES[k]),
  [true, true, true, true, true]);

// ── copying, and never over something already there ──
// The naming loop out of the handler, which is the part that can go wrong.
const uniqueName = (base, name) => {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let dest = path.join(base, name), n = 1;
  while (fs.existsSync(dest)) dest = path.join(base, `${stem}-${n++}${ext}`);
  return dest;
};
check("the handler is the one that names them",
  /while \(fs\.existsSync\(dest\) && path\.resolve\(dest\) !== path\.resolve\(src\)\)/.test(src), true,
  "a jar of the same name is usually a different build, and replacing one silently is how an instance stops working for no visible reason");
const dir = path.join(OUT, "mods");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "sodium.jar"), "one");
check("a second file of the same name is kept beside the first",
  path.basename(uniqueName(dir, "sodium.jar")), "sodium-1.jar");
fs.writeFileSync(path.join(dir, "sodium-1.jar"), "two");
check("and a third beside both", path.basename(uniqueName(dir, "sodium.jar")), "sodium-2.jar");

// A server's resource packs are an ordered list, not just a folder.
check("a pack added to a server joins its order",
  /if \(type === "server" && tab === "resourcepacks"\)[\s\S]{0,300}cfg\.order\.push/.test(src), true);
check("and a data pack goes under the world, where the game looks",
  /tab === "datapacks" \? path\.join\("world", "datapacks"\)/.test(src), true);

// ── mods or plugins ──
const dirFor = new Function(`${page.slice(page.indexOf("const SRV_MODDED ="), page.indexOf("const srvDir ="))} return srvContentDir;`)();
check("a modded server keeps mods",
  ["fabric", "forge", "quilt", "neoforge"].map(t => dirFor({ type: t })), ["mods", "mods", "mods", "mods"]);
check("a Paper-like one keeps plugins",
  ["paper", "purpur", "folia", "spigot", "bukkit"].map(t => dirFor({ type: t })),
  ["plugins", "plugins", "plugins", "plugins", "plugins"],
  "a plugin server had no tab at all, and no way to see what was installed");
check("a plain vanilla server keeps neither", dirFor({ type: "vanilla" }), null);
check("and a jar of your own is taken as a Paper-like fork", dirFor({ type: "custom" }), "plugins");

// ── dev plugins ──
check("dev mods on a Paper-like server go to its plugins folder",
  /PLUGIN_SERVER_TYPES\.includes\(loader\) \? "plugins" : "mods"/.test(src), true);
check("and a plugin.yml is enough to know what a dev jar is",
  /get\("plugin\.yml"\) \|\| get\("paper-plugin\.yml"\)/.test(src), true,
  "its name IS its id, the same way a mod's manifest gives one");

// ── a jar of your own ──
const sm = fs.readFileSync(path.join(ROOT, "backend/serverManager.js"), "utf8");
check("a custom server copies the jar in rather than fetching one",
  /if \(t === "custom"\)[\s\S]{0,400}copyFileSync\(jarPath, path\.join\(serverDir, "server\.jar"\)\)/.test(sm), true);
check("with nothing chosen it says so rather than making an empty server",
  /No server jar was chosen/.test(sm), true);
check("and editing one that hands over a jar re-provisions",
  /const changedJar = !!jarPath/.test(sm), true,
  "it is a different file even when every other field is the same");
check("the form will not submit without one",
  /type === 'custom' && !pickedJar && !\(editingServer && editingServer\.customJar\)/.test(page), true);

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
