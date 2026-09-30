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
// Blockbench keyframes are OFFSETS FROM THE REST POSE, not absolute values.
// That matters enormously here: skinview3d parks the body at y=-6, the arms at
// x=±5, the legs at y=-12 and the whole skin group at y=8, so writing a
// keyframe straight into `part.position` drops every limb onto the origin and
// the figure folds up into its own head. Everything below is applied relative
// to a rest pose captured once per player:
//
//   position = rest + keyframe       rotation = rest + keyframe (radians)
//   scale    = rest * keyframe
//
// In devtools, on the skins page:
//   playerRenderAnimList()              what's available
//   playerRenderAnimPlay("idle2")       play one now, once
//   playerRenderAnimPlay("idle2", true) play it on a loop
//   playerRenderAnimPlay(null)          back to the resting idle
//   playerRenderAnimFlip()              flip the Y/Z rotation convention
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

  // ── Rest pose ─────────────────────────────────────────────────────────────
  // Captured once per player object, immediately after resetJoints() so the
  // capture can't inherit a pose some earlier animation left behind. Every
  // frame writes rest + keyframe for EVERY bone, including the ones the clip
  // says nothing about, so a clip can never leave a limb where the last one
  // put it.
  function restPose(player) {
    if (player.__restPose) return player.__restPose;
    // PlayerObject.resetJoints() puts the whole rig back to its defaults,
    // cape included. Without it a reload mid-animation would bake the current
    // pose in as "rest".
    try { player.resetJoints(); } catch { /* older build: read as-is */ }
    const pose = [];
    for (const [name, get] of Object.entries(BONES)) {
      let part;
      try { part = get(player); } catch { continue; }
      if (!part) continue;
      pose.push({
        name, part,
        position: [part.position.x, part.position.y, part.position.z],
        rotation: [part.rotation.x, part.rotation.y, part.rotation.z],
        scale: [part.scale.x, part.scale.y, part.scale.z],
      });
    }
    player.__restPose = pose;
    return pose;
  }

  function resetToRest(player) {
    for (const r of restPose(player)) {
      r.part.position.set(r.position[0], r.position[1], r.position[2]);
      r.part.rotation.set(r.rotation[0], r.rotation[1], r.rotation[2]);
      r.part.scale.set(r.scale[0], r.scale[1], r.scale[2]);
    }
  }

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

  // Blockbench's "free" model format uses the same handedness as three.js, so
  // rotations map across unchanged. Some rigs are authored the Bedrock way,
  // where Y and Z are mirrored; playerRenderAnimFlip() switches between the two
  // so it can be settled by looking rather than by argument.
  let flipYZ = false;

  // clip: { length, loop, degrees, bones: { <bone>: { rotation: [...],
  //                                         position: [...], scale: [...] } } }
  // opts.loop overrides the clip's own flag — the page plays everything once.
  function playClip(clip, opts) {
    opts = opts || {};
    const degrees = clip.degrees !== false;      // Blockbench exports degrees
    const loops = opts.loop === undefined ? !!clip.loop : !!opts.loop;
    return function makeAnimation() {
      const anim = new skinview3d.PlayerAnimation();
      // So a caller can let a one-shot run for exactly as long as it lasts
      // instead of guessing.
      anim.clipLength = clip.length || 0;
      anim.clipLoops = loops;
      anim.animate = function (player) {
        const pose = restPose(player);
        const k = degrees ? DEG : 1;
        const sy = flipYZ ? -1 : 1, sz = flipYZ ? -1 : 1;
        let t = this.progress;
        if (clip.length) t = loops ? t % clip.length : Math.min(t, clip.length);

        for (const r of pose) {
          const tracks = (clip.bones || {})[r.name];
          const part = r.part;

          const rot = tracks && sampleTrack(tracks.rotation, t);
          part.rotation.set(
            r.rotation[0] + (rot ? rot[0] * k : 0),
            r.rotation[1] + (rot ? rot[1] * k * sy : 0),
            r.rotation[2] + (rot ? rot[2] * k * sz : 0),
          );

          // Model units, not angles — an offset from where the part lives.
          const pos = tracks && sampleTrack(tracks.position, t);
          part.position.set(
            r.position[0] + (pos ? pos[0] : 0),
            r.position[1] + (pos ? pos[1] : 0),
            r.position[2] + (pos ? pos[2] : 0),
          );

          // A multiplier, so 1 means "unchanged" and a missing track means 1.
          const scl = tracks && sampleTrack(tracks.scale, t);
          part.scale.set(
            r.scale[0] * (scl ? scl[0] : 1),
            r.scale[1] * (scl ? scl[1] : 1),
            r.scale[2] * (scl ? scl[2] : 1),
          );
        }
      };
      return anim;
    };
  }

  // The resting state between gestures: skinview3d's own idle, which sways the
  // arms and the cape. It only ever writes rotations, so the rest pose is put
  // back first — otherwise a gesture that moved or scaled anything would leave
  // it that way until the page was reloaded.
  function makeIdle() {
    let inner = null;
    try { inner = new skinview3d.IdleAnimation(); } catch { /* none available */ }
    const anim = new skinview3d.PlayerAnimation();
    anim.clipLength = 0;
    anim.clipLoops = true;
    anim.animate = function (player) {
      resetToRest(player);
      if (!inner) return;
      inner.progress = this.progress;
      try { inner.animate(player); } catch { /* leave it at rest */ }
    };
    return anim;
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
    window.SkinAnimations = {
      // Between gestures the player just stands there breathing. The authored
      // clips are things it DOES, not what it does the rest of the time --
      // running one of them as the idle meant whichever clip was picked looped
      // forever and the others never got a turn.
      idle: () => makeIdle(),
      // Every converted clip, played ONCE when its turn comes round. A clip
      // marked "loop" in Blockbench is still played once here: that flag is
      // about previewing it in the editor, not about how often the launcher
      // should show it.
      gestures: names.map(n => playClip(clips[n], { loop: false })),
      clips,
      names,
      resetPose: resetToRest,
    };
  }

  // ── Devtools ────────────────────────────────────────────────────────────
  const viewer = () => window.skinViewer || null;
  const playerOf = (v) => (v && (v.playerObject || v.player)) || null;

  window.playerRenderAnimList = function () {
    if (!names.length) {
      console.log('No converted animations. Run:  node bbmodelconvert.js <file.bbmodel>');
      return [];
    }
    console.table(names.map(n => ({
      name: n,
      seconds: clips[n].length,
      'loops in blockbench': clips[n].loop,
      bones: Object.keys(clips[n].bones || {}).join(', '),
    })));
    return names;
  };

  window.playerRenderAnimPlay = function (name, loop) {
    const v = viewer();
    if (!v) { console.warn('No skin render on this page.'); return false; }
    if (name == null) {
      v.animation = makeIdle();
      console.log('Back to the resting idle.');
      return true;
    }
    const clip = clips[name];
    if (!clip) {
      console.warn(`No animation called "${name}". Try playerRenderAnimList().`);
      return false;
    }
    v.animation = playClip(clip, { loop: !!loop })();
    console.log(`Playing "${name}" (${clip.length}s, ${loop ? 'looping' : 'once'}).`);
    return true;
  };

  // Whether Y/Z rotation is mirrored is a property of how the rig was authored,
  // and the only honest way to settle it is to watch the model. Flip it, watch,
  // and if the flipped version is right, re-run bbmodelconvert.js with --flip.
  window.playerRenderAnimFlip = function () {
    flipYZ = !flipYZ;
    console.log(`Y/Z rotation is now ${flipYZ ? 'MIRRORED' : 'as authored'}.`
      + (flipYZ ? ' If this is the right way round, re-run: node bbmodelconvert.js <file> --flip' : ''));
    const p = playerOf(viewer());
    if (p) { try { resetToRest(p); } catch { /* next frame will */ } }
    return flipYZ;
  };

  // Set from the converted file, so --flip is honoured without a devtools call.
  if (data && data.flipYZ) flipYZ = true;
})();
