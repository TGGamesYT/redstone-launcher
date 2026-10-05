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

  // ── The idle, evaluated rather than delegated ────────────────────────────
  // skinview3d's IdleAnimation is three lines of trigonometry, and we need to
  // know what it WOULD look like at an arbitrary moment -- to blend into it, and
  // to find the point in its cycle where the arms hang closest to the body. So
  // it is reproduced here exactly rather than called.
  //
  //   t = 2 * progress
  //   leftArm.z  =  0.03*cos(t)   + 0.02*PI
  //   rightArm.z =  0.03*cos(t+PI) - 0.02*PI
  //   cape.x     =  0.01*sin(t)   + 0.06*PI
  //
  // Positive Z on the left arm swings it outward (and negative on the right),
  // so the arms are NEAREST the body when cos(t) = -1, i.e. t = PI. In progress
  // terms that is PI/2, repeating every PI seconds.
  const IDLE_CALM = Math.PI / 2;      // progress at which the arms are nearest
  const IDLE_PERIOD = Math.PI;        // and how often that comes round
  const BLEND = 0.4;                  // seconds to ease in or out of a clip
  const ease = (f) => f * f * (3 - 2 * f);

  // A pose is one entry per bone, parallel to the rest pose.
  const blankPose = (rest) => rest.map(r => ({
    p: r.position.slice(), r: r.rotation.slice(), s: r.scale.slice(),
  }));

  function evalIdle(rest, progress) {
    const pose = blankPose(rest);
    const t = 2 * progress;
    const lean = 0.02 * Math.PI;
    const at = (name) => pose[rest.findIndex(r => r.name === name)];
    const la = at('leftArm'), ra = at('rightArm'), cp = at('cape');
    if (la) la.r[2] = 0.03 * Math.cos(t) + lean;
    if (ra) ra.r[2] = 0.03 * Math.cos(t + Math.PI) - lean;
    if (cp) cp.r[0] = 0.01 * Math.sin(t) + 0.06 * Math.PI;
    return pose;
  }

  // The clip's pose at time t, as data, so it can be blended rather than only
  // written straight to the model.
  function evalClip(rest, clip, t) {
    const pose = blankPose(rest);
    const k = clip.degrees !== false ? DEG : 1;
    const sy = flipYZ ? -1 : 1, sz = flipYZ ? -1 : 1;
    rest.forEach((r, idx) => {
      const tracks = (clip.bones || {})[r.name];
      if (!tracks) return;
      const e = pose[idx];
      const rot = sampleTrack(tracks.rotation, t);
      if (rot) {
        e.r[0] = r.rotation[0] + rot[0] * k;
        e.r[1] = r.rotation[1] + rot[1] * k * sy;
        e.r[2] = r.rotation[2] + rot[2] * k * sz;
      }
      const pos = sampleTrack(tracks.position, t);
      if (pos) for (let a = 0; a < 3; a++) e.p[a] = r.position[a] + pos[a];
      const scl = sampleTrack(tracks.scale, t);
      if (scl) for (let a = 0; a < 3; a++) e.s[a] = r.scale[a] * scl[a];
    });
    return pose;
  }

  const lerpPose = (a, b, f) => a.map((x, i) => ({
    p: [0, 1, 2].map(n => x.p[n] + (b[i].p[n] - x.p[n]) * f),
    r: [0, 1, 2].map(n => x.r[n] + (b[i].r[n] - x.r[n]) * f),
    s: [0, 1, 2].map(n => x.s[n] + (b[i].s[n] - x.s[n]) * f),
  }));

  function applyPose(rest, pose) {
    rest.forEach((r, i) => {
      const e = pose[i];
      r.part.position.set(e.p[0], e.p[1], e.p[2]);
      r.part.rotation.set(e.r[0], e.r[1], e.r[2]);
      r.part.scale.set(e.s[0], e.s[1], e.s[2]);
    });
  }

  // ── The conductor ────────────────────────────────────────────────────────
  // ONE animation owns the player for the whole page. It idles, and when a clip
  // is requested it waits for the calm point of the idle, eases into the clip's
  // opening pose, plays it once, and eases back to that same calm point before
  // picking the idle up from there. Swapping viewer.animation per gesture (what
  // this replaces) could only ever snap: each animation starts from whatever
  // the last one left behind, with no way to blend between them.
  function makeConductor(opts) {
    opts = opts || {};
    let phase = 'idle';
    let idleProgress = IDLE_CALM;
    let clip = null, looping = false, clipT = 0;
    let blendT = 0, fromPose = null, pending = null, pendingImmediate = false;
    // Set when play() interrupts something: the blend starts from the pose the
    // model is actually in, not from the idle curve.
    let cutIn = false;

    const anim = new skinview3d.PlayerAnimation();
    anim.animate = function (player, delta) {
      const rest = restPose(player);
      // skinview3d hands the speed-scaled delta to animate(); guard the first
      // frame, where it can be undefined.
      const dt = Number.isFinite(delta) && delta > 0 ? Math.min(delta, 0.1) : 1 / 60;

      // Interrupted mid-clip: blend out of exactly where the model stands.
      if (cutIn) {
        cutIn = false;
        fromPose = rest.map(r => ({
          p: [r.part.position.x, r.part.position.y, r.part.position.z],
          r: [r.part.rotation.x, r.part.rotation.y, r.part.rotation.z],
          s: [r.part.scale.x, r.part.scale.y, r.part.scale.z],
        }));
        clip = pending; pending = null; pendingImmediate = false;
        blendT = 0; clipT = 0; phase = 'in';
      }

      if (phase === 'idle') {
        const before = idleProgress;
        idleProgress += dt;
        if (pending) {
          // Crossed the calm point since the last frame?
          const cycle = (x) => Math.floor((x - IDLE_CALM) / IDLE_PERIOD);
          if (pendingImmediate || cycle(idleProgress) > cycle(before)) {
            fromPose = evalIdle(rest, idleProgress);
            clip = pending; pending = null; pendingImmediate = false;
            blendT = 0; clipT = 0; phase = 'in';
          }
        }
        applyPose(rest, evalIdle(rest, idleProgress));
        return;
      }

      if (phase === 'in') {
        blendT += dt;
        const f = Math.min(1, blendT / BLEND);
        applyPose(rest, lerpPose(fromPose, evalClip(rest, clip, 0), ease(f)));
        if (f >= 1) { phase = 'clip'; clipT = 0; }
        return;
      }

      if (phase === 'clip') {
        clipT += dt;
        const len = clip.length || 0;
        if (looping && len) {
          applyPose(rest, evalClip(rest, clip, clipT % len));
          return;
        }
        if (len && clipT >= len) {
          fromPose = evalClip(rest, clip, len);
          applyPose(rest, fromPose);
          blendT = 0; phase = 'out';
          return;
        }
        applyPose(rest, evalClip(rest, clip, clipT));
        return;
      }

      // 'out': land exactly on the calm point, so the idle carries on from the
      // position the arms are already in rather than jumping to meet it.
      blendT += dt;
      const f = Math.min(1, blendT / BLEND);
      applyPose(rest, lerpPose(fromPose, evalIdle(rest, IDLE_CALM), ease(f)));
      if (f >= 1) {
        phase = 'idle';
        idleProgress = IDLE_CALM;
        clip = null; looping = false;
        if (opts.onIdle) { try { opts.onIdle(); } catch { /* caller's problem */ } }
      }
    };

    return {
      animation: anim,
      get busy() { return phase !== 'idle'; },
      // immediate: don't wait for the calm point (devtools, where waiting up to
      // PI seconds for something you just asked for reads as nothing happening).
      play(c, o) {
        o = o || {};
        looping = !!o.loop;
        if (phase === 'idle') { pending = c; pendingImmediate = !!o.immediate; return true; }
        if (!o.immediate) return false;    // already doing something
        // Cut in from wherever the model is right now, so even interrupting
        // mid-clip blends rather than jumps. The next frame reads the live
        // pose, so there is nothing to compute here.
        pending = c; pendingImmediate = true; cutIn = true;
        return true;
      },
      stop() {
        if (phase === 'idle') return;
        looping = false;
        blendT = 0; phase = 'out';
      },
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

  // One conductor per page. The skins page hands it to the viewer once and then
  // only ever ASKS for clips; it never swaps viewer.animation again.
  let conductor = null;
  function getConductor(onIdle) {
    if (!conductor) conductor = makeConductor({ onIdle });
    else if (onIdle) conductor.onIdle = onIdle;
    return conductor;
  }

  if (names.length) {
    window.SkinAnimations = {
      clips,
      names,
      resetPose: resetToRest,
      conductor: getConductor,
      // A clip at random, for whoever is doing the scheduling.
      randomName: () => names[Math.floor(Math.random() * names.length)],
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
    const c = conductor;
    if (!c) { console.warn('The skin render has no animation conductor yet.'); return false; }
    if (name == null) {
      c.stop();
      console.log('Easing back to the resting idle.');
      return true;
    }
    const clip = clips[name];
    if (!clip) {
      console.warn(`No animation called "${name}". Try playerRenderAnimList().`);
      return false;
    }
    // Through the conductor, so it eases in and -- the part that was missing --
    // eases back into the idle afterwards instead of freezing on the last frame.
    c.play(clip, { loop: !!loop, immediate: true });
    console.log(`Playing "${name}" (${clip.length}s, ${loop ? 'looping' : 'once'}).`
      + (loop ? ' playerRenderAnimPlay(null) to stop.' : ''));
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
