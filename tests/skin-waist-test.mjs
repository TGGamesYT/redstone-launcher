// The waist turns the top half and leaves the legs standing.
//
// "waist" used to be an alias for the root bone, and the root drives the
// whole figure -- so a clip that turned the waist turned the model on the
// spot instead of twisting it, and a clip that animated both fought itself.
// A waist means everything above the hips in every rig that has one.
//
// skinview3d has no such bone, so skin-animations.js builds one. What is
// checked here is the shape of what it builds, because getting it subtly
// wrong is silent: the figure still renders, it just moves wrongly.
//
// The real function is sliced out rather than rewritten, because a copy
// would pass while the launcher was broken.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(ROOT, "frontend", "skin-animations.js"), "utf8");

let bad = 0;
const check = (what, got, want, note) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${note ? "  — " + note : ""}`
    + (ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`));
};

const cut = (a, b) => {
  const i = src.indexOf(a), j = src.indexOf(b, i);
  if (i < 0 || j < 0) {
    console.log(`FAIL could not find ${JSON.stringify(i < 0 ? a : b)} in skin-animations.js`);
    process.exit(1);
  }
  return src.slice(i, j);
};

const code = cut("  const WAIST_Y =", "  function restPose(");
if (!/function makeWaist/.test(code) || !/function emptyGroupLike/.test(code)) {
  console.log("FAIL could not slice makeWaist out of skin-animations.js");
  process.exit(1);
}
const scratch = path.join(ROOT, "node_modules", ".cache");
fs.mkdirSync(scratch, { recursive: true });
const modFile = path.join(scratch, "skinwaist.mjs");
fs.writeFileSync(modFile,
  code.replace(/^ {2}/gm, "")
    .replace(/^const WAIST_Y/m, "export const WAIST_Y")
    .replace(/^const ABOVE_THE_WAIST/m, "export const ABOVE_THE_WAIST")
    .replace(/^function makeWaist/m, "export function makeWaist")
    .replace(/^function emptyGroupLike/m, "export function emptyGroupLike"));
const { makeWaist, WAIST_Y, ABOVE_THE_WAIST } = await import("file://" + modFile + "?v=" + Date.now());

// ── a stand-in for three.js, as far as this function uses it ──
//
// Only parenting and offsets, which is all makeWaist touches. Group is empty
// when constructed and Skin is not, which is what emptyGroupLike walks the
// prototype chain to tell apart -- so the real distinction is exercised
// rather than assumed.
class Group {
  constructor() {
    this.isObject3D = true;
    this.type = "Group";
    this.children = [];
    this.parent = null;
    this.name = "";
    this.position = {
      x: 0, y: 0, z: 0,
      set(x, y, z) { this.x = x; this.y = y; this.z = z; },
      toArray() { return [this.x, this.y, this.z]; },
    };
  }
  add(child) {
    if (child.parent) child.parent.children = child.parent.children.filter(c => c !== child);
    child.parent = this;
    this.children.push(child);
    return this;
  }
}
const PARTS = {
  head: [0, 0, 0], body: [0, -6, 0],
  rightArm: [-5, -2, 0], leftArm: [5, -2, 0],
  rightLeg: [-1.9, -12, -0.1], leftLeg: [1.9, -12, -0.1],
};
class Skin extends Group {
  constructor() {
    super();
    this.type = "Skin";
    for (const [name, p] of Object.entries(PARTS)) {
      const part = new Group();
      part.name = name;
      part.position.set(...p);
      this.add(part);
      this[name] = part;
    }
  }
}
/** Where a part ends up, by adding the offsets along the chain to the skin. */
const offsetToSkin = (part, skin) => {
  let x = 0, y = 0, z = 0;
  for (let n = part; n && n !== skin; n = n.parent) { x += n.position.x; y += n.position.y; z += n.position.z; }
  return [+x.toFixed(2), +y.toFixed(2), +z.toFixed(2)];
};

// ── what it builds ──
{
  const skin = new Skin();
  const player = { skin };
  const where = (n) => offsetToSkin(skin[n], skin);
  const before = Object.fromEntries(Object.keys(PARTS).map(n => [n, where(n)]));

  const waist = makeWaist(player);
  check("a waist is made", !!waist, true);
  check("it is a plain container, not a second skin",
    [waist.type, waist.children.length === 1], ["Group", true],
    "building one out of skin.constructor would build a whole other player");
  check("and it sits on the hip line, where the legs meet the body",
    waist.position.toArray(), [0, WAIST_Y, 0]);
  check("which is where the legs actually pivot",
    [PARTS.rightLeg[1], PARTS.leftLeg[1]], [WAIST_Y, WAIST_Y],
    "measured off the model rather than chosen");

  const after = Object.fromEntries(Object.keys(PARTS).map(n => [n, where(n)]));
  check("nothing is anywhere different afterwards", after, before,
    "rigging the model must not move it; a waist that drops the top half is worse than none");

  check("the four parts above the hips hang off it",
    ABOVE_THE_WAIST.map(n => skin[n].parent.parent === waist), [true, true, true, true]);
  check("and their own positions are untouched",
    ABOVE_THE_WAIST.map(n => skin[n].position.toArray()),
    ABOVE_THE_WAIST.map(n => PARTS[n]),
    "resetJoints() writes these defaults back, so anything else would be undone on the next rest pose");
  check("the legs are left where they were, as the skin's own",
    ["rightLeg", "leftLeg"].map(n => skin[n].parent === skin), [true, true],
    "that is the whole difference between a waist and a root");
}

// ── asked for twice ──
{
  const skin = new Skin();
  const player = { skin };
  const first = makeWaist(player);
  const before = Object.fromEntries(Object.keys(PARTS).map(n => [n, offsetToSkin(skin[n], skin)]));
  const second = makeWaist(player);
  check("asking again gives the same one", second === first, true);
  check("and moves nothing a second time",
    Object.fromEntries(Object.keys(PARTS).map(n => [n, offsetToSkin(skin[n], skin)])), before,
    "resetToRest calls it on every reset, so it has to be a no-op after the first");
}

// ── a viewer that will not give one up ──
{
  check("no skin, no waist", makeWaist({}), null);
  check("and nothing thrown for it", makeWaist(null), null,
    "a rig this cannot build is a clip that does nothing, not a page that stops");
}

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
