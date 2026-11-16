// The Female Gender Mod easter egg: reading what the mod saved, in both of
// the shapes it has saved it in, with the mod's own defaults and limits.
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import gm from "../backend/gender-mod.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let bad = 0;
const check = (what, got, want, note) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${note ? "  — " + note : ""}`
    + (ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`));
};

// The current shape, as the mod writes it.
const nested = gm.readGenderConfig({
  gender: "female",
  breasts: { offset: [0.3, -0.2, -0.5], size: 0.7, cleavage: 0.05,
    physics: { enabled: true, uniboob: false, bounce_multiplier: 0.4, floppiness: 0.6 } },
  show_in_armor: false,
  uvs: { skin: { left: { east: [1, 2, 3, 4], west: [16, 21, 20, 26], down: [20, 17, 24, 21], up: [20, 25, 24, 27], north: [20, 21, 24, 26] } } },
});
check("the nested shape is read", [nested.gender, nested.shows, nested.breasts.x, nested.breasts.y, nested.breasts.z, nested.breasts.size, nested.breasts.cleavage],
  ["female", true, 0.3, -0.2, -0.5, 0.7, 0.05]);
check("with its physics", nested.breasts.physics, { enabled: true, uniboob: false, bounce: 0.4, floppiness: 0.6 });
check("and a UV layout it names", nested.uvs.skin.left.east, [1, 2, 3, 4]);
check("while one it does not name is the default", nested.uvs.skin.right.north, [24, 21, 28, 26]);
check("show in armor", nested.showInArmor, false);

// The older, flat shape.
const flat = gm.readGenderConfig({
  gender: 0, bust_size: 0.5, breasts_xOffset: -0.4, breasts_yOffset: 0.1, breasts_zOffset: -0.2,
  breasts_cleavage: 0.02, breast_physics: false, breasts_uniboob: true, bounce_multiplier: 0.2, floppy_multiplier: 0.9,
  leftBreastUVLayout: { east: { x1: 9, y1: 8, x2: 7, y2: 6 } },
});
check("the flat shape, with the old number for the gender", [flat.gender, flat.breasts.size, flat.breasts.x, flat.breasts.y, flat.breasts.z],
  ["female", 0.5, -0.4, 0.1, -0.2]);
check("its physics", flat.breasts.physics, { enabled: false, uniboob: true, bounce: 0.2, floppiness: 0.9 });
check("and the old way of writing a face's UVs", flat.uvs.skin.left.east, [9, 8, 7, 6]);
check("a face the saved layout leaves out is no face, as in the game", flat.uvs.skin.left.north, null);

// Defaults and limits are the mod's.
const empty = gm.readGenderConfig({});
check("nothing saved is the mod's defaults: male, so nothing shows", [empty.gender, empty.shows, empty.breasts.size, empty.breasts.physics.bounce, empty.breasts.physics.floppiness],
  ["male", false, 0.6, 0.333, 0.75]);
const wild = gm.readGenderConfig({ gender: "other", bust_size: 5, breasts_zOffset: 3, floppy_multiplier: 0 });
check("out of range is held to the mod's limits", [wild.shows, wild.breasts.size, wild.breasts.z, wild.breasts.physics.floppiness], [true, 0.8, 0, 0.25]);

// An instance folder, with both config folders, newest file winning.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gender-"));
  const uuid = "0f2a3b4c-5d6e-4f70-8192-a3b4c5d6e7f8";
  fs.mkdirSync(path.join(dir, "config", "FemaleGenderMod"), { recursive: true });
  fs.mkdirSync(path.join(dir, "config", "WildfireGender"), { recursive: true });
  const older = path.join(dir, "config", "WildfireGender", `${uuid}.json`);
  const newer = path.join(dir, "config", "FemaleGenderMod", `${uuid}.json`);
  fs.writeFileSync(older, JSON.stringify({ gender: "female", bust_size: 0.2 }));
  fs.writeFileSync(newer, JSON.stringify({ gender: "female", breasts: { size: 0.75 } }));
  fs.utimesSync(older, new Date(Date.now() - 60000), new Date(Date.now() - 60000));
  fs.writeFileSync(path.join(dir, "config", "FemaleGenderMod", "not-a-player.json"), "{}");
  const got = gm.readInstanceConfigs(dir);
  check("players are found by uuid, without dashes", Object.keys(got), [uuid.replace(/-/g, "")]);
  check("and the file the mod wrote last is the one used", got[uuid.replace(/-/g, "")].config.breasts.size, 0.75);
  check("an instance with no config folder is nobody", gm.readInstanceConfigs(path.join(dir, "nothing")), {});
  fs.rmSync(dir, { recursive: true, force: true });
}

check("the mod's jar is recognised by its usual names",
  ["FemaleGenderMod-fabric-1.21.1-4.3.jar", "wildfire_gender-3.1.jar", "Wildfire-Gender-Mod.jar", "sodium.jar", "female-gender.jar.disabled"].map(gm.looksLikeGenderModJar),
  [true, true, true, false, false]);

// The renderer is what is meant to match the game; its numbers are checked
// against the mod's own.
{
  const src = fs.readFileSync(path.join(ROOT, "frontend", "gender-render.js"), "utf8");
  for (const [what, re] of [
    ["the boxes are 4 x 5 x 3", /BOX\s*=\s*\{\s*w:\s*4,\s*h:\s*5,\s*d:\s*3\s*\}/],
    ["tilted by 35 degrees times the size", /-35\s*\*\s*rotation/],
    ["breathing at the game's rate", /0\.09/],
    ["the jacket layer pushed out and grown by 5%", /1\.05/],
    ["physics run at 20 ticks a second", /TICK_MS\s*=\s*50/],
  ]) check(`renderer: ${what}`, re.test(src), true);
}

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
