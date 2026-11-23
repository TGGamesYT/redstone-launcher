// When a turned skin is allowed to come to rest.
//
// The small renders on the skins page are a still picture until the pointer
// is over them, and a live one while it is. On the way out the card eases
// the figure back to facing forward and then swaps the picture in again --
// and it used to swap the moment the ROTATION was home, which is not the
// moment the figure is still.
//
// The arms, the legs, the head and the cape are springs hanging off that
// rotation: they are thrown out by the turn and come back after it. Measured
// in the running launcher, the right arm is 0.87 radians -- fifty degrees --
// out of place at the instant the spin stops. The still picture is the rest
// pose, so swapping then is the arms teleporting, which is exactly what was
// reported.
//
// So the physics now says whether it has settled, and the card waits for it.
// What is checked here is that the answer is the right SHAPE: not settled
// while the limbs are visibly out, settled once they are back, and not
// hanging on for a hundredth of a degree nobody can see.
//
// The real applySpin is sliced out of skin-animations.js; a copy would pass
// while the launcher was broken.
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

// ── the real springs ──
const cut = (from, to) => {
  const i = src.indexOf(from), j = src.indexOf(to, i);
  if (i < 0 || j < 0) {
    console.log(`FAIL could not find ${JSON.stringify(i < 0 ? from : to)} in skin-animations.js`);
    process.exit(1);
  }
  return src.slice(i, j);
};
const code = cut("  const SPIN = {", "  // How fast the page says the figure is turning");
for (const want of ["function applySpin", "function newSpinState", "function springTo"]) {
  if (!code.includes(want)) { console.log(`FAIL the slice is missing ${want}`); process.exit(1); }
}
const scratch = path.join(ROOT, "node_modules", ".cache");
fs.mkdirSync(scratch, { recursive: true });
const modFile = path.join(scratch, "spinsettle.mjs");
fs.writeFileSync(modFile,
  "const clamp = (v, lim) => Math.max(-lim, Math.min(lim, v));\n"
  + code.replace(/^ {2}/gm, "")
    .replace(/^const SPIN/m, "export const SPIN")
    .replace(/^function newSpinState/m, "export function newSpinState")
    .replace(/^function applySpin/m, "export function applySpin")
    // `clamp` is declared further up the real file, beside the other maths.
    .replace(/^const clamp[^\n]*\n/m, ""));
const { applySpin, newSpinState } = await import("file://" + modFile + "?v=" + Date.now());

// A rig, as far as applySpin touches one.
const rotation = () => ({ x: 0, y: 0, z: 0 });
const PARTS = ["leftArm", "rightArm", "leftLeg", "rightLeg", "head", "body", "cape"];
const rig = () => PARTS.map(name => ({ name, part: { rotation: rotation() } }));

const armOut = (rest) => {
  const ra = rest.find(p => p.name === "rightArm").part.rotation;
  return Math.abs(ra.x) + Math.abs(ra.y) + Math.abs(ra.z);
};

// ── turned hard, then let go ──
{
  const state = newSpinState();
  const DT = 1 / 60;
  // Half a second of being spun.
  let rest = rig();
  for (let i = 0; i < 30; i++) { rest = rig(); applySpin(state, rest, 6, DT); }
  const spunArm = armOut(rest);
  check("a figure being turned throws its arms out",
    [spunArm > 0.3, state.rested], [true, false],
    "measured in the running launcher at 0.87 radians, which is fifty degrees");

  // The turn stops. This is the instant the card's rotation is home, and the
  // instant the still picture used to go back.
  rest = rig();
  applySpin(state, rest, 0, DT);
  check("and they are still out the moment the turn stops",
    [armOut(rest) > 0.3, state.rested], [true, false],
    "swapping to the still picture here is the teleport that was reported");

  // Let it settle.
  let frames = 0, settledArm = null;
  for (; frames < 600; frames++) {
    rest = rig();
    applySpin(state, rest, 0, DT);
    if (state.rested) { settledArm = armOut(rest); break; }
  }
  check("they come back, and it says so when they have",
    [settledArm !== null, settledArm !== null && settledArm < 0.01],
    [true, true]);
  check("within about a second, not three",
    [frames > 10, frames < 120], [true, true],
    `took ${Math.round(frames / 60 * 1000)}ms: long enough to be the real spring, `
    + "short enough that nobody is left waiting for a hundredth of a degree");
}

// Standing still is at rest from the first frame: a card that was never
// turned must not sit there waiting for a spring that never moved.
{
  const state = newSpinState();
  const rest = rig();
  applySpin(state, rest, 0, 1 / 60);
  check("a figure that was never turned is already at rest",
    [state.rested, armOut(rest)], [true, 0]);
}

// The two questions are not the same question.
{
  const state = newSpinState();
  const DT = 1 / 60;
  for (let i = 0; i < 30; i++) applySpin(state, rig(), 6, DT);
  let restedAt = null, movingAt = null;
  for (let i = 0; i < 1200; i++) {
    applySpin(state, rig(), 0, DT);
    if (restedAt === null && state.rested) restedAt = i;
    if (movingAt === null && !state.moving) movingAt = i;
    if (restedAt !== null && movingAt !== null) break;
  }
  check("'visibly settled' comes well before 'not a flicker left'",
    [restedAt !== null, movingAt !== null, restedAt < movingAt], [true, true, true],
    `rested at ${restedAt} frames, every last thousandth gone at ${movingAt} -- `
    + "waiting for the second one is waiting for nothing anybody can see");
}

// ── stopped dead: the limbs carry on round ──
//
// Grabbing a spinning render stops the figure at once. The trailing parts are
// still moving, so they swing PAST where they hang and come back -- rather
// than holding still and drifting home, which is what was reported.
{
  const DT = 1 / 60;
  const spinThenStop = (after) => {
    const state = newSpinState();
    for (let i = 0; i < 30; i++) applySpin(state, rig(), 6, DT);
    const trailing = state.armLag.x;
    let past = 0, at = -1;
    for (let i = 0; i < 40; i++) {
      applySpin(state, rig(), after(i), DT);
      // Past rest means the other side from where the turn left it.
      const over = -Math.sign(trailing) * state.armLag.x;
      if (over > past) past = over;
      if (over > 0 && at < 0) at = i;
    }
    return { trailing, past, at };
  };
  const dead = spinThenStop(() => 0);
  check("stopped dead, the arms swing on past where they hang",
    dead.past > Math.abs(dead.trailing) * 0.4, true,
    `trailing ${dead.trailing.toFixed(2)} rad, then ${dead.past.toFixed(2)} rad the other way`);
  check("and they do it at once, not after a pause",
    dead.at >= 0 && dead.at <= 8, true, `past rest by frame ${dead.at}`);
  // A spin that runs down on its own is not a jolt: no kick.
  let w = 6;
  const slow = spinThenStop(() => (w *= 0.9));
  // A drag's readings jump about while it keeps going: no kicks from that.
  {
    const state = newSpinState();
    let worst = 0;
    for (let i = 0; i < 60; i++) {
      applySpin(state, rig(), i % 2 ? 9 : 5, DT);
      worst = Math.max(worst, Math.abs(state.armLag.v));
    }
    check("a drag whose speed jitters does not shake the arms",
      worst < 2, true, `fastest the arm moved: ${worst.toFixed(2)} rad/s`);
  }
  check("a spin that slows down by itself gets no kick",
    slow.past < dead.past * 0.5, true,
    `${slow.past.toFixed(2)} rad past rest, against ${dead.past.toFixed(2)} when stopped dead`);
}

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
