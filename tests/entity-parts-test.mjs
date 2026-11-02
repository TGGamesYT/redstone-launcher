// What a mob is NOT showing while it stands still.
//
// Nothing in the game's assets says which parts those are -- the renderer
// decides it in Java, per mob -- so the launcher names the few that matter.
// A name that stops matching the game's own model definitions would silently
// stop hiding anything, so this checks them against a REAL client.
//
// The jar is ~40MB and is fetched once into node_modules/.cache. Set
// OFFLINE=1 to skip the part that needs it; the rest still runs.
import fs from "fs";
import path from "path";
import https from "https";
import { fileURLToPath } from "url";
import AdmZip from "adm-zip";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = path.join(ROOT, "node_modules", ".cache", "mc");
let bad = 0;
const check = (label, got, want, note) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${note ? "  — " + note : ""}\n       got  ${JSON.stringify(got)}` + (ok ? "" : `\n       want ${JSON.stringify(want)}`));
};

// ── what the launcher claims ──
const src = fs.readFileSync(path.join(ROOT, "backend/icon-models.js"), "utf8");
const i = src.indexOf("const IDLE_KEY = ");
const j = src.indexOf("\n};", src.indexOf("const IDLE_HIDDEN = {", i)) + 3;
if (i < 0 || j < 3) { console.log("FAIL could not find IDLE_HIDDEN in icon-models.js"); process.exit(1); }
const { IDLE_HIDDEN } = new Function(`${src.slice(i, j)} return { IDLE_HIDDEN };`)();

check("an armadillo's rolled-up form is named", IDLE_HIDDEN.armadillo.parts, ["cube"]);
check("and every illager's held-out arms are",
  ["evoker", "illusioner", "pillager", "vindicator"].map(m => IDLE_HIDDEN[m].parts.join(",")),
  ["right_arm,left_arm", "right_arm,left_arm", "right_arm,left_arm", "right_arm,left_arm"]);
check("each says what it is, for the list that can switch it back on",
  Object.values(IDLE_HIDDEN).every(v => typeof v.label === "string" && v.label.length > 2), true);

if (process.env.OFFLINE === "1") {
  console.log("ok   (the check against a real client was skipped: OFFLINE=1)");
  console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
  process.exit(bad ? 1 : 0);
}

// ── what the game actually has ──
const get = (url) => new Promise((ok, no) => {
  https.get(url, (r) => {
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) { r.resume(); return get(r.headers.location).then(ok, no); }
    if (r.statusCode !== 200) { r.resume(); return no(new Error(`HTTP ${r.statusCode}`)); }
    const parts = [];
    r.on("data", (c) => parts.push(c));
    r.on("end", () => ok(Buffer.concat(parts)));
    r.on("error", no);
  }).on("error", no);
});

fs.mkdirSync(CACHE, { recursive: true });
let jarPath = null;
try {
  const manifest = JSON.parse((await get("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json")).toString());
  const newest = manifest.versions.find(v => v.type === "release");
  jarPath = path.join(CACHE, `client-${newest.id}.jar`);
  if (!fs.existsSync(jarPath)) {
    const meta = JSON.parse((await get(newest.url)).toString());
    fs.writeFileSync(jarPath, await get(meta.downloads.client.url));
  }
  console.log(`     (checked against Minecraft ${newest.id})`);
} catch (e) {
  console.log(`ok   (could not reach Mojang, so the client check was skipped: ${e.message})`);
  console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
  process.exit(bad ? 1 : 0);
}

const { EntityModels } = await import("../backend/entity-models.js");
const { identityMappings } = await import("../backend/mc-mappings.js");
const MA = await import("../backend/model-assets.js");

const jar = new AdmZip(jarPath);
const stack = MA.makeStack([{
  label: "client",
  async get(p) { const e = jar.getEntry(p); return e ? e.getData() : null; },
}]);
const em = new EntityModels({ stack, maps: identityMappings(jar.getEntries().map(e => e.entryName)), log: () => {} });
em.lenient = true;
const layers = await em.layers();
check("the model catalogue reads", layers.size > 200, true, `${layers.size} layers`);

const partsOf = (layer) => {
  const l = layers.get(layer);
  if (!l) return null;
  return [...new Set((l.elements || []).map(e => String(e.part || "").split("/").pop()))];
};

for (const [model, { parts }] of Object.entries(IDLE_HIDDEN)) {
  const have = partsOf(model);
  if (!have) { check(`${model} is in the game's catalogue`, false, true); continue; }
  check(`${model} really does have ${parts.join(" and ")}`,
    parts.map(p => have.includes(p)), parts.map(() => true),
    `it is made of: ${have.join(", ")}`);
}

// And the pose that is LEFT must still be a whole mob, or hiding the other
// one would leave a figure with no arms at all.
check("an illager still has its crossed arms once the held-out pair is hidden",
  ["evoker", "illusioner", "pillager", "vindicator"].map(m => (partsOf(m) || []).includes("arms")),
  [true, true, true, true]);
check("and an armadillo still has a body once the ball is hidden",
  (partsOf("armadillo") || []).includes("body"), true);

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
