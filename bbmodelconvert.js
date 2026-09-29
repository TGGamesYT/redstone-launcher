#!/usr/bin/env node
//
// bbmodelconvert — turn a Blockbench .bbmodel's animations into clips the
// launcher's skin render can play.
//
// This is a tool, not part of the launcher: run it when the modeller hands over
// a new .bbmodel, commit the result, and the skins page picks the animations up
// on its next load. The launcher never reads .bbmodel files itself, so nothing
// has to parse Blockbench's format at runtime.
//
//   node bbmodelconvert.js path/to/player.bbmodel
//   node bbmodelconvert.js path/to/player.bbmodel -o frontend/skin-clips.json
//
// Options:
//   -o, --out <file>   where to write (default: frontend/skin-clips.json)
//   --no-flip          keep Blockbench's Y/Z rotation signs as-is
//   --list             print what's in the file and write nothing
//
// Blockbench and three.js disagree about the sign of Y and Z rotation for a
// humanoid rig, so by default both are negated on the way out. If an animation
// comes out mirrored, re-run with --no-flip.
// The package is ESM ("type": "module" in package.json), so this is too.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DEFAULT_OUT = path.join('frontend', 'skin-clips.json');

// Blockbench group names -> the parts skinview3d exposes. Case and spacing are
// normalised first, so "Right Arm", "rightArm" and "right_arm" all land here.
const BONE_ALIASES = {
  head: 'head',
  body: 'body',
  torso: 'body',
  rightarm: 'rightArm',
  armright: 'rightArm',
  leftarm: 'leftArm',
  armleft: 'leftArm',
  rightleg: 'rightLeg',
  legright: 'rightLeg',
  leftleg: 'leftLeg',
  legleft: 'leftLeg',
  cape: 'cape',
  // The rig's root group. skinview3d has no waist, so it drives the whole
  // player -- which is what a waist bone does anyway.
  waist: 'root',
  root: 'root',
  player: 'root',
};

const normaliseBone = (name) => {
  const key = String(name || '').toLowerCase().replace(/[^a-z]/g, '');
  return BONE_ALIASES[key] || null;
};

// Keyframe values are strings, and Blockbench allows a Molang expression where
// a number is expected. Anything that isn't a plain number is not something
// this tool can evaluate, so it becomes 0 and is reported.
function num(v, warnings, where) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const s = String(v == null ? '' : v).trim();
  if (s === '') return 0;
  const n = Number(s);
  if (Number.isFinite(n)) return n;
  warnings.push(`${where}: couldn't read "${s}" as a number, used 0`);
  return 0;
}

function convertAnimator(animator, warnings, animName) {
  const tracks = {};
  for (const kf of animator.keyframes || []) {
    const channel = kf.channel;
    if (channel !== 'rotation' && channel !== 'position' && channel !== 'scale') continue;
    const dp = (kf.data_points || [])[0] || {};
    const where = `${animName}/${animator.name || 'bone'}/${channel}@${kf.time}`;
    (tracks[channel] || (tracks[channel] = [])).push({
      time: Number(kf.time) || 0,
      value: [num(dp.x, warnings, where), num(dp.y, warnings, where), num(dp.z, warnings, where)],
      // Blockbench's "catmullrom" is a smooth curve; the player treats anything
      // that isn't linear as smooth and eases between the keys.
      ...(kf.interpolation && kf.interpolation !== 'linear' ? { smooth: true } : {}),
    });
  }
  for (const list of Object.values(tracks)) list.sort((a, b) => a.time - b.time);
  return tracks;
}

function convert(model, { flip = true } = {}) {
  const warnings = [];
  const clips = {};
  // Group uuid -> name, for animators that don't carry their own name.
  const groupNames = {};
  for (const g of model.groups || []) if (g && g.uuid) groupNames[g.uuid] = g.name;

  for (const anim of model.animations || []) {
    const bones = {};
    let used = 0;
    for (const [uuid, animator] of Object.entries(anim.animators || {})) {
      const rawName = animator.name || groupNames[uuid];
      const bone = normaliseBone(rawName);
      if (!bone) {
        if ((animator.keyframes || []).length) {
          warnings.push(`${anim.name}: no skinview3d part matches the bone "${rawName}" — skipped`);
        }
        continue;
      }
      const tracks = convertAnimator(animator, warnings, anim.name);
      if (!Object.keys(tracks).length) continue;
      // Two Blockbench groups can map to the same part (a rig may split the
      // body); merge rather than letting the second silently win.
      if (bones[bone]) {
        for (const [ch, list] of Object.entries(tracks)) {
          bones[bone][ch] = (bones[bone][ch] || []).concat(list).sort((a, b) => a.time - b.time);
        }
      } else {
        bones[bone] = tracks;
      }
      used++;
    }
    if (!used) { warnings.push(`${anim.name}: nothing animatable, skipped`); continue; }

    // "animation.idle1" -> "idle1": the prefix is Blockbench's namespace, not
    // part of the name anyone wants to type into playerRenderAnimPlay().
    const name = String(anim.name || 'animation').replace(/^animation\./, '') || 'animation';
    clips[name] = {
      length: Number(anim.length) || 0,
      loop: anim.loop === 'loop',
      degrees: true,
      flipYZ: !!flip,
      bones,
    };
  }
  return { clips, warnings };
}

function main(argv) {
  const args = argv.slice(2);
  if (!args.length || args.includes('-h') || args.includes('--help')) {
    console.log('usage: node bbmodelconvert.js <file.bbmodel> [-o out.json] [--no-flip] [--list]');
    return 0;
  }
  const flip = !args.includes('--no-flip');
  const listOnly = args.includes('--list');
  const outIdx = Math.max(args.indexOf('-o'), args.indexOf('--out'));
  const out = outIdx >= 0 ? args[outIdx + 1] : DEFAULT_OUT;
  // The argument after -o is its value, not the input file.
  const input = args.find((a, i) => !a.startsWith('-') && !(outIdx >= 0 && i === outIdx + 1));
  if (!input) { console.error('No .bbmodel given.'); return 1; }
  if (!fs.existsSync(input)) { console.error(`No such file: ${input}`); return 1; }

  let model;
  try {
    model = JSON.parse(fs.readFileSync(input, 'utf8'));
  } catch (err) {
    console.error(`${input} isn't valid JSON: ${err.message}`);
    return 1;
  }
  if (!Array.isArray(model.animations) || !model.animations.length) {
    console.error(`${input} has no animations in it.`);
    return 1;
  }

  const { clips, warnings } = convert(model, { flip });
  const names = Object.keys(clips);
  if (!names.length) { console.error('None of the animations use bones the player render has.'); return 1; }

  for (const w of warnings) console.warn('note: ' + w);
  for (const n of names) {
    const c = clips[n];
    console.log(`  ${n.padEnd(16)} ${c.loop ? 'loop' : 'once'}  ${c.length}s  ${Object.keys(c.bones).join(', ')}`);
  }
  if (listOnly) return 0;

  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({
    source: path.basename(input),
    generated: new Date().toISOString(),
    clips,
  }, null, 2) + '\n');
  console.log(`\nWrote ${names.length} animation${names.length === 1 ? '' : 's'} to ${out}`);
  console.log('The skins page picks these up on its next load. In devtools:');
  console.log('  playerRenderAnimList()             list them');
  console.log(`  playerRenderAnimPlay("${names[0]}")${' '.repeat(Math.max(0, 14 - names[0].length))} play one`);
  return 0;
}

// Run when invoked directly; importable for anything that wants the converter.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv));
}
export { convert, normaliseBone };
