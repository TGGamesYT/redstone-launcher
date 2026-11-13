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

const code = cut("  const WAIST_Y =", "  // clip: { length, loop, degrees");
if (!/function makeWaist/.test(code) || !/function emptyGroupLike/.test(code)) {
  console.log("FAIL could not slice makeWaist out of skin-animations.js");
  process.exit(1);
}
const scratch = path.join(ROOT, "node_modules", ".cache");
fs.mkdirSync(scratch, { recursive: true });
const modFile = path.join(scratch, "skinwaist.mjs");
fs.writeFileSync(modFile,
  // `data` is the converted clips file, declared further down the real file;
  // the slice reads it through basePivots(), so it is supplied here.
  "let data = null;\nexport const setData = (d) => { data = d; };\n"
  + code.replace(/^ {2}/gm, "")
    .replace(/^const WAIST_Y/m, "export const WAIST_Y")
    .replace(/^const ABOVE_THE_WAIST/m, "export const ABOVE_THE_WAIST")
    .replace(/^function makeWaist/m, "export function makeWaist")
    .replace(/^function emptyGroupLike/m, "export function emptyGroupLike")
    .replace(/^function pivotShift/m, "export function pivotShift")
    .replace(/^function pivotOffset/m, "export function pivotOffset"));
const mod = await import("file://" + modFile + "?v=" + Date.now());
const { makeWaist, WAIST_Y, ABOVE_THE_WAIST, pivotShift, pivotOffset, setData } = mod;

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

// ── a clip from a rig whose pivot was moved ──
//
// The converter has always said this was the point of taking a clip from a
// second rig: a wave wants the arm's pivot at the shoulder and a lean wants
// it at the waist. Nothing ever did it, so such a clip turned about the
// pivot skinview3d gives the part and looked wrong.
{
  setData({ pivots: { rightArm: [-5, 22, 0] } });

  check("a clip from the same rig has nothing to put back",
    pivotShift({ bones: { rightArm: { pivot: [-5, 22, 0] } } }, "rightArm", 1, 1), null,
    "every clip carries its pivot, so most of them have to cost nothing");
  check("a clip with no pivot at all is left alone",
    pivotShift({ bones: { rightArm: {} } }, "rightArm", 1, 1), null,
    "which is every clip exported before the converter recorded one");
  check("a moved pivot is the difference between the two",
    pivotShift({ bones: { rightArm: { pivot: [-5, 12, 0] } } }, "rightArm", 1, 1), [0, -10, 0],
    "ten down the arm, which is the difference between a shoulder and a waist");
  check("and it is turned with the rig, like everything else",
    pivotShift({ bones: { rightArm: { pivot: [-2, 22, 3] } } }, "rightArm", -1, -1), [-3, 0, -3],
    "a pivot is a point in the same space the rotations are in");

  // And what it does to the part. A moved pivot is a correction to the
  // part's position, worked out from its rotation: whatever the rotation,
  // the pivot point itself must not move.
  const turnAbout = (rot, shift) => {
    // Where the pivot point ends up, relative to the part's rest origin:
    // origin + offset + R*shift, which should equal shift.
    const off = pivotOffset(rot[0], rot[1], rot[2], shift);
    const [x, y, z] = shift;
    // R*shift, the way three.js would (XYZ: Rx*Ry*Rz).
    let [a, b, c] = [x, y, z];
    let co = Math.cos(rot[2]), si = Math.sin(rot[2]); [a, b] = [a * co - b * si, a * si + b * co];
    co = Math.cos(rot[1]); si = Math.sin(rot[1]); [a, c] = [a * co + c * si, -a * si + c * co];
    co = Math.cos(rot[0]); si = Math.sin(rot[0]); [b, c] = [b * co - c * si, b * si + c * co];
    return [off[0] + a, off[1] + b, off[2] + c].map(n => +n.toFixed(6));
  };
  check("turned, the moved pivot stays exactly where it was",
    turnAbout([0.7, -0.3, 1.1], [0, -10, 0]), [0, -10, 0],
    "which is what turning about a point means");
  check("and so it does for a pivot off to one side",
    turnAbout([-0.4, 0.9, 0.2], [3, 5, -2]), [3, 5, -2]);
  check("not turned, the part is not moved at all",
    pivotOffset(0, 0, 0, [0, -10, 0]).map(n => Math.abs(+n.toFixed(9))), [0, 0, 0],
    "an ordinary pose must cost nothing");
  check("and with no moved pivot there is nothing to add",
    pivotOffset(0.5, 0.5, 0.5, null), null);
}

// ── the waist, whose pivot was moved, frame after frame ──
//
// This is the one that was reported as "the modified pivot still isn't
// modified", and the data was never the problem: the clip carried the moved
// pivot and the shift came out right. What went wrong was downstream.
//
// A waist with a moved pivot hangs off the group that moves where it turns,
// so it is a GRANDCHILD of the skin rather than a child. makeWaist asked
// `parent === skin`, called that gone, and built a second waist -- every
// frame, because the spin layer resets the pose on every one. The head, body
// and arms were moved into each new waist in turn and the first one was left
// hanging off the pivot group with nothing under it. The rest pose is read
// once and still held that first one, so the clip went on writing the
// waist's rotation to an orphan: the one bone whose pivot had been moved was
// the one bone that stopped moving.
{
  setData({ pivots: { waist: [0, 12, 0], rightLeg: [-1.9, 12, 0] } });
  const skin = new Skin();
  const player = { skin };
  const waist = makeWaist(player);
  // idle.bored's waist, from the rig with the pivot at the neck.
  const clip = { bones: { waist: { pivot: [0, 24, 0] }, rightLeg: { pivot: [-1.9, 0, 0] } } };

  const shift = pivotShift(clip, "waist", 1, 1);
  check("the moved waist is twelve higher", shift, [0, 12, 0],
    "the hip line against the neck, which is what the second rig moved");

  // Play it: every frame resets the pose, which asks for the waist again.
  let rebuilt = 0;
  for (let f = 0; f < 5; f++) if (makeWaist(player) !== waist) rebuilt++;
  check("the rig is not rebuilt behind the clip's back", rebuilt, 0);

  // The waist turned forward a little, about the neck rather than the hips:
  // the hips swing, the neck stays put.
  const off = pivotOffset(-0.08, 0, 0, shift);
  check("turned about the neck, the hips are what move",
    [+off[1].toFixed(2), +off[2].toFixed(2)], [0.04, 0.96],
    "measured in the running launcher too: the neck stays at 0,0,0 and the hip swings forward by just under a unit at -0.08 rad");

  check("a leg's moved pivot puts it at the floor",
    pivotShift(clip, "rightLeg", 1, 1), [0, -12, 0],
    "bbmodel y=0 is the feet; the leg normally turns at the hip");
}

// ── and the clips the skins page actually plays get it ────────────────────
//
// The pivot used to be applied in playClip only, by hanging the part off an
// extra group. The skins page plays everything through the conductor, which
// evaluates clips with evalClip and never went near those groups -- so the
// moved pivot did nothing where anybody could see it.
{
  const evalClip = src.slice(src.indexOf("  function evalClip("), src.indexOf("  const lerpPose"));
  check("the conductor's own clip evaluation applies the moved pivot",
    /pivotOffset\(e\.r\[0\], e\.r\[1\], e\.r\[2\], pivotShift\(clip, r\.name, sx, sz\)\)/.test(evalClip), true,
    "it was only ever done in playClip, which the skins page does not use");
  const play = src.slice(src.indexOf("  function playClip("), src.indexOf("  // ── The idle, evaluated rather than delegated"));
  check("and playClip draws the very same pose rather than its own",
    /applyPose\(rest, evalClip\(rest, clip, t\)\)/.test(play), true);
}

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
