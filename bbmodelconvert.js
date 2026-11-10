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
//   npm run anim                              animations.bbmodel in the repo root
//   npm run anim -- path/to/player.bbmodel    a different rig
//   npm run anim -- --list                    say what is in it, write nothing
//
// or directly:
//
//   node bbmodelconvert.js path/to/player.bbmodel
//   node bbmodelconvert.js path/to/player.bbmodel -o frontend/skin-clips.json
//
// Options:
//   -o, --out <file>   where to write (default: frontend/skin-clips.json)
//   --no-flip          keep Y/Z rotation as authored
//                      (it is mirrored by default, for Bedrock-style rigs)
//   --list             print what's in the file and write nothing
//
// Blockbench's "free" model format uses the same handedness as three.js, so
// rotations from one of those could be written out unchanged. Rigs authored
// the Bedrock way mirror Y and Z, and in practice that is what every rig here
// has been -- so mirroring is what happens unless --no-flip says otherwise.
// In the app, playerRenderAnimFlip() in devtools switches between the two so
// you can see which is right before committing.
// The package is ESM ("type": "module" in package.json), so this is too.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DEFAULT_OUT = path.join('frontend', 'skin-clips.json');
// The rig lives in the repository, so the usual run takes no arguments at
// all: `npm run anim`. Naming a file still works, for a one-off or a second
// rig.
const DEFAULT_IN = 'animations.bbmodel';

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
function num(v, warnings, where, fallback) {
  // `fallback` is what an absent or unreadable component means for THIS
  // channel: 0 for a rotation or a position offset, but 1 for a scale, where 0
  // would flatten the part out of existence.
  if (typeof v === 'number') return Number.isFinite(v) ? v : fallback;
  const s = String(v == null ? '' : v).trim();
  if (s === '') return fallback;
  const n = Number(s);
  if (Number.isFinite(n)) return n;
  warnings.push(`${where}: couldn't read "${s}" as a number, used ${fallback}`);
  return fallback;
}

function convertAnimator(animator, warnings, animName) {
  const tracks = {};
  for (const kf of animator.keyframes || []) {
    const channel = kf.channel;
    if (channel !== 'rotation' && channel !== 'position' && channel !== 'scale') continue;
    const dp = (kf.data_points || [])[0] || {};
    const where = `${animName}/${animator.name || 'bone'}/${channel}@${kf.time}`;
    // Blockbench leaves out components that weren't touched. For scale that
    // means "still 1", not "now 0" -- reading it as 0 collapses the part.
    const blank = channel === 'scale' ? 1 : 0;
    (tracks[channel] || (tracks[channel] = [])).push({
      time: Number(kf.time) || 0,
      value: [num(dp.x, warnings, where, blank), num(dp.y, warnings, where, blank), num(dp.z, warnings, where, blank)],
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
      // Which handedness THIS clip was authored in. One file's clips all
      // share it, but a set built up out of several rigs need not -- one may
      // have been authored the Bedrock way and the next not -- so it travels
      // with the clip rather than with the file.
      flipYZ: !!flip,
      length: Number(anim.length) || 0,
      // Recorded, but the launcher plays everything once at random intervals;
      // this flag is about previewing in Blockbench.
      loop: anim.loop === 'loop',
      degrees: true,
      bones,
    };
  }
  return { clips, warnings };
}

/** Read a .bbmodel, or say why not. Returns null after printing the reason. */
function readModel(file) {
  if (!fs.existsSync(file)) {
    console.error(`No such file: ${file}`);
    return null;
  }
  let model;
  try { model = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) { console.error(`${file} isn't valid JSON: ${err.message}`); return null; }
  if (!Array.isArray(model.animations) || !model.animations.length) {
    console.error(`${file} has no animations in it.`);
    return null;
  }
  return model;
}

/** What is already in the output, so adding to it does not throw the rest away. */
function readExisting(out) {
  try {
    const had = JSON.parse(fs.readFileSync(out, 'utf8'));
    if (had && had.clips && typeof had.clips === 'object') return had;
  } catch { /* nothing there yet, or not ours */ }
  return null;
}

function writeOut(out, clips, sources, flip) {
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({
    // Which rig each clip came from, because they no longer all come from
    // one: an animation can be taken from a model whose pivots were moved
    // for it, and the next one from another.
    sources,
    generated: new Date().toISOString(),
    // How the rig was authored, not a per-clip property.
    flipYZ: !!flip,
    clips,
  }, null, 2) + '\n');
}

function describe(clips) {
  for (const n of Object.keys(clips)) {
    const c = clips[n];
    console.log(`  ${n.padEnd(18)} ${c.length}s  ${Object.keys(c.bones).join(', ')}`);
  }
}

function main(argv) {
  const args = argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    console.log('usage:');
    console.log('  npm run anim                            ' + DEFAULT_IN + ' -> ' + DEFAULT_OUT + ', replacing what is there');
    console.log('  npm run anim -- --list [file]            say what is in it and write nothing');
    console.log('  npm run anim -- export <file> <name>...  add only those, keeping what is already there');
    console.log('  npm run anim -- remove <name>...         take those out again');
    console.log('');
    console.log('  A name may be renamed on the way in:  export rig.bbmodel wave=wave_left');
    console.log('  so the same animation can be taken from two rigs with different pivots.');
    console.log('');
    console.log('  -o, --out <file>   where to write (default: ' + DEFAULT_OUT + ')');
    console.log('      --no-flip      keep Y/Z rotation as authored (mirrored by default, for Bedrock-style rigs)');
    console.log('      --list         print what is in the file and write nothing');
    return 0;
  }

  // Mirrored by default. Every rig that has come through here has been a
  // Bedrock-style one, so --flip was something to remember on every single
  // export and nothing but a nuisance to forget; --no-flip is there for the
  // day a Blockbench "free" rig turns up.
  const flip = !args.includes('--no-flip');
  const listOnly = args.includes('--list');
  const outIdx = Math.max(args.indexOf('-o'), args.indexOf('--out'));
  const out = outIdx >= 0 ? args[outIdx + 1] : DEFAULT_OUT;
  // Everything that is not a flag, and not the value of -o.
  const rest = args.filter((a, i) => !a.startsWith('-') && !(outIdx >= 0 && i === outIdx + 1));
  const verb = rest[0] === 'export' || rest[0] === 'add' || rest[0] === 'remove' ? rest[0] : null;

  // ── taking clips back out ──
  if (verb === 'remove') {
    const had = readExisting(out);
    if (!had) { console.error(`There is nothing in ${out} to take anything out of.`); return 1; }
    const names = rest.slice(1);
    if (!names.length) { console.error('Which ones? npm run anim -- remove <name>...'); return 1; }
    let gone = 0;
    for (const n of names) {
      if (had.clips[n]) { delete had.clips[n]; gone++; }
      else console.error(`note: there is no "${n}" in ${out}`);
    }
    if (!gone) return 1;
    const sources = { ...(had.sources || {}) };
    for (const n of names) delete sources[n];
    writeOut(out, had.clips, sources, had.flipYZ);
    console.log(`Took ${gone} out of ${out}; ${Object.keys(had.clips).length} left.`);
    return 0;
  }

  // ── which file ──
  const named = verb ? rest[1] : rest[0];
  const input = named || DEFAULT_IN;
  if (!named && !fs.existsSync(input)) {
    console.error(`${DEFAULT_IN} is not in this folder. Put the rig there, or name one: npm run anim -- path/to/rig.bbmodel`);
    return 1;
  }
  const model = readModel(input);
  if (!model) return 1;
  if (!named) console.log(`Reading ${DEFAULT_IN}`);

  const { clips, warnings } = convert(model, { flip });
  const names = Object.keys(clips);
  if (!names.length) { console.error('None of the animations use bones the player render has.'); return 1; }
  for (const w of warnings) console.warn('note: ' + w);

  // ── just say what is in it ──
  if (listOnly) {
    console.log(`${names.length} animation${names.length === 1 ? '' : 's'} in ${input}:`);
    describe(clips);
    console.log('');
    console.log(`  npm run anim -- export ${input} ${names[0]}`);
    console.log('  takes one of them, and leaves whatever is already in ' + out + ' alone.');
    return 0;
  }

  // ── a few of them, added to what is there ──
  //
  // One rig cannot always be the right one for every animation: a wave wants
  // the arm's pivot at the shoulder and a lean wants it at the waist, which
  // is two models of the same player. So a clip can be taken from one file
  // and the next clip from another, and they end up in the same place.
  if (verb) {
    const wanted = rest.slice(2);
    if (!wanted.length) {
      console.error('Which animations? These are in ' + input + ':');
      describe(clips);
      return 1;
    }
    const had = readExisting(out);
    const into = had ? { ...had.clips } : {};
    const sources = had ? { ...(had.sources || {}) } : {};
    const taken = [];
    for (const ask of wanted) {
      // "wave=wave_left" takes `wave` out of this rig and files it under
      // `wave_left`, so the same animation can come from two rigs.
      const [from, to] = ask.split('=');
      const name = to || from;
      if (!clips[from]) {
        console.error(`"${from}" is not in ${input}. It has: ${names.join(', ')}`);
        return 1;
      }
      if (into[name] && !to) console.log(`  replacing the ${name} that was there`);
      into[name] = clips[from];
      sources[name] = { file: path.basename(input), animation: from, flipYZ: !!flip };
      taken.push(name);
    }
    writeOut(out, into, sources, had ? had.flipYZ : flip);
    console.log(`Added ${taken.join(', ')} to ${out}.`);
    console.log(`It now holds ${Object.keys(into).length}: ${Object.keys(into).join(', ')}`);
    return 0;
  }

  // ── all of them, replacing what is there ──
  describe(clips);
  const sources = {};
  for (const n of names) sources[n] = { file: path.basename(input), animation: n, flipYZ: !!flip };
  writeOut(out, clips, sources, flip);
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
