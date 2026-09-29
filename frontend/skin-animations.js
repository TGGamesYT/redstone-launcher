// Animations for the big skin render.
//
// The clips come from a Blockbench .bbmodel, converted by bbmodelconvert.js at
// the repo root into skin-clips.json. Nothing here parses .bbmodel — the app
// only ever reads the converted JSON. To add or change animations:
//
//   node bbmodelconvert.js path/to/player.bbmodel
//
// If skin-clips.json is missing or has no usable clips, the page falls back to
// skinview3d's own IdleAnimation and built-in gestures, exactly as before.
//
// A PlayerAnimation is any object with an `animate(player, delta)` method;
// skinview3d exports the base class as `skinview3d.PlayerAnimation`. `player`
// is the PlayerObject, so `player.skin.rightArm.rotation.x = …` and friends are
// what an animation actually sets. `this.progress` counts up in seconds.
//
// In devtools, on the skins page:
//   playerRenderAnimList()              what's available
//   playerRenderAnimPlay("idle2")       play one now
//   playerRenderAnimPlay(null)          back to the normal idle
(function () {
  if (typeof skinview3d === 'undefined') return;

  // Clip bone names -> the parts skinview3d exposes.
  const BONES = {
    head: (p) => p.skin.head,
    body: (p) => p.skin.body,
    rightArm: (p) => p.skin.rightArm,
    leftArm: (p) => p.skin.leftArm,
    rightLeg: (p) => p.skin.rightLeg,
    leftLeg: (p) => p.skin.leftLeg,
    cape: (p) => p.cape,
    // A waist/root bone drives the whole figure.
    root: (p) => p.skin,
  };
  const DEG = Math.PI / 180;
  // Rest pose per part, so a clip that only animates an arm doesn't leave every
  // other part wherever the previous animation happened to put it.
  const REST = { rotation: [0, 0, 0], position: [0, 0, 0], scale: [1, 1, 1] };

  const smoothstep = (f) => f * f * (3 - 2 * f);

  // Where a track sits at time t, interpolating between the keyframes either
  // side of it. Values are returned raw; the caller scales them.
  function sampleTrack(keys, t) {
    if (!keys || !keys.length) return null;
    if (t <= keys[0].time) return keys[0].value;
    const last = keys[keys.length - 1];
    if (t >= last.time) return last.value;
    for (let i = 1; i < keys.length; i++) {
      if (t > keys[i].time) continue;
      const a = keys[i - 1], b = keys[i];
      const span = b.time - a.time || 1;
      let f = (t - a.time) / span;
      // Blockbench's non-linear interpolations are all eased curves; easing
      // between the two keys is close enough and never overshoots.
      if (b.smooth || a.smooth) f = smoothstep(f);
      return [0, 1, 2].map(j => a.value[j] + (b.value[j] - a.value[j]) * f);
    }
    return last.value;
  }

  // clip: { length, loop, degrees, flipYZ, bones: { <bone>: { rotation: [...],
  //                                                position: [...], scale: [...] } } }
  function playClip(clip) {
    const degrees = clip.degrees !== false;      // Blockbench exports degrees
    // Blockbench and three.js disagree on the sign of Y and Z rotation for a
    // humanoid rig. bbmodelconvert sets this; --no-flip turns it off.
    const sy = clip.flipYZ ? -1 : 1, sz = clip.flipYZ ? -1 : 1;
    return function makeAnimation() {
      const anim = new skinview3d.PlayerAnimation();
      // So a caller can let a one-shot run for exactly as long as it lasts
      // instead of guessing.
      anim.clipLength = clip.length || 0;
      anim.clipLoops = !!clip.loop;
      anim.animate = function (player) {
        let t = this.progress;
        if (clip.length) t = clip.loop ? t % clip.length : Math.min(t, clip.length);
        for (const [name, get] of Object.entries(BONES)) {
          const tracks = (clip.bones || {})[name];
          let part;
          try { part = get(player); } catch { continue; }
          if (!part) continue;

          const rot = tracks && sampleTrack(tracks.rotation, t);
          if (rot) {
            const k = degrees ? DEG : 1;
            part.rotation.set(rot[0] * k, rot[1] * k * sy, rot[2] * k * sz);
          } else if (tracks !== undefined || clip.resetUntouched !== false) {
            part.rotation.set(REST.rotation[0], REST.rotation[1], REST.rotation[2]);
          }
          // Position and scale are model units, not angles, so no conversion.
          const pos = tracks && sampleTrack(tracks.position, t);
          if (pos) part.position.set(pos[0], pos[1], pos[2]);
          const scl = tracks && sampleTrack(tracks.scale, t);
          if (scl) part.scale.set(scl[0] || 1, scl[1] || 1, scl[2] || 1);
        }
      };
      return anim;
    };
  }

  window.SkinAnimationClip = playClip;

  // ── Load the converted clips ────────────────────────────────────────────
  // Synchronous on purpose: the skins page reads window.SkinAnimations while
  // it builds the viewer, and an async load would miss that window. The file
  // is small and local, so this costs nothing worth measuring.
  let data = null;
  try {
    const req = new XMLHttpRequest();
    req.open('GET', 'skin-clips.json', false);
    req.send(null);
    if (req.status === 200 || req.status === 0) data = JSON.parse(req.responseText);
  } catch (err) {
    console.warn('[skin-animations] no skin-clips.json, using the built-in animations', err && err.message);
  }

  const clips = (data && data.clips) || {};
  const names = Object.keys(clips);
  if (names.length) {
    // The looping clips are what the player does while it's just standing
    // there; a one-shot clip is a gesture that plays now and then.
    const looping = names.filter(n => clips[n].loop);
    const oneShots = names.filter(n => !clips[n].loop);
    const idleNames = looping.length ? looping : names;

    window.SkinAnimations = {
      // A different idle each time the page builds a viewer, so it isn't the
      // same loop forever.
      idle: () => playClip(clips[idleNames[Math.floor(Math.random() * idleNames.length)]])(),
      // Every converted clip is in the random rotation, one-shots first so a
      // deliberate gesture isn't drowned out by the idles.
      gestures: oneShots.concat(looping).map(n => playClip(clips[n])),
      clips,
      names,
    };
  }

  // ── Devtools ────────────────────────────────────────────────────────────
  const viewer = () => window.skinViewer || null;

  window.playerRenderAnimList = function () {
    if (!names.length) {
      console.log('No converted animations. Run:  node bbmodelconvert.js <file.bbmodel>');
      return [];
    }
    console.table(names.map(n => ({
      name: n,
      loop: clips[n].loop,
      seconds: clips[n].length,
      bones: Object.keys(clips[n].bones || {}).join(', '),
    })));
    return names;
  };

  window.playerRenderAnimPlay = function (name) {
    const v = viewer();
    if (!v) { console.warn('No skin render on this page.'); return false; }
    if (name == null) {
      v.animation = new skinview3d.IdleAnimation();
      console.log('Back to the normal idle.');
      return true;
    }
    const clip = clips[name];
    if (!clip) {
      console.warn(`No animation called "${name}". Try playerRenderAnimList().`);
      return false;
    }
    v.animation = playClip(clip)();
    console.log(`Playing "${name}" (${clip.loop ? 'looping' : clip.length + 's, once'}).`);
    return true;
  };
})();
