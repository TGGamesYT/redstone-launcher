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
  // ── The cape belongs to the body ─────────────────────────────────────────
  // skinview3d hangs the cape off the PLAYER, as a sibling of the whole skin
  // group, so it is only ever coincidentally in the right place: a clip that
  // leans the body, lifts it or stretches it leaves the cape hanging in the air
  // where the back used to be. It is fastened to a torso, so it belongs to the
  // torso -- reparent it there once and every body transform carries it along
  // for free, stretch included.
  //
  // attach() (as opposed to add()) keeps the cape exactly where it already is
  // while changing whose child it is, so this is invisible on the frame it
  // happens. The rest pose is captured AFTER it, so the cape's rest position is
  // recorded in body space -- which is what every later frame writes back.
  function capeToBody(player) {
    try {
      const cape = player.cape, body = player.skin && player.skin.body;
      if (!cape || !body || cape.parent === body) return;
      player.updateMatrixWorld(true);
      if (typeof body.attach === 'function') body.attach(cape);
      else {
        // Pre-r109 three.js has no attach(); the offset is a constant anyway.
        body.add(cape);
        cape.position.set(cape.position.x, cape.position.y - 2, cape.position.z);
      }
    } catch { /* leave it where skinview3d put it */ }
  }

  function restPose(player) {
    if (player.__restPose) return player.__restPose;
    // PlayerObject.resetJoints() puts the whole rig back to its defaults,
    // cape included. Without it a reload mid-animation would bake the current
    // pose in as "rest".
    try { player.resetJoints(); } catch { /* older build: read as-is */ }
    capeToBody(player);
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

  // ── Being spun around ────────────────────────────────────────────────────
  // Turning the figure used to move a perfectly rigid statue. A real body
  // spinning on the spot throws its arms outward, trails its head behind the
  // turn, and drags a cape through the air it is stirring up. All of that is
  // added ON TOP of whatever pose the animation has already set, so it layers
  // over the idle and over any clip without either of them knowing.
  //
  // `omega` is how fast the figure appears to be turning, in radians per
  // second, positive for a turn to its left. The main render gets it from the
  // camera orbit (orbiting the camera one way looks exactly like spinning the
  // model the other), card previews from the model's own spin.
  //
  // Each reaction is a target value run through a damped spring rather than
  // written straight on, so the limbs take a moment to fly out and swing past
  // centre once on the way back instead of snapping.
  const SPIN = {
    stiffness: 55,       // how hard it pulls toward the target
    damping: 9,          // < 2*sqrt(stiffness) leaves some overshoot
    // How much of each effect, and how far it is ever allowed to go. The
    // outward ones go with omega SQUARED -- that is what centrifugal force
    // does, and it is why a slow turn barely moves anything and a fast one
    // throws the arms right out.
    armOut: [0.055, 0.90], armLag: [0.080, 0.50],
    capeLift: [0.050, 0.80], capeSway: [0.070, 0.45],
    headLag: [0.060, 0.45], bodyTwist: [0.022, 0.18],
    legLag: [0.030, 0.25],
  };
  const clamp = (v, m) => Math.max(-m, Math.min(m, v));

  function newSpinState() {
    const k = {};
    for (const n of ['armOut', 'armLag', 'capeLift', 'capeSway', 'headLag', 'bodyTwist', 'legLag']) {
      k[n] = { x: 0, v: 0 };
    }
    return k;
  }

  // One spring step. dt is clamped by the caller.
  function springTo(s, target, dt) {
    s.v += ((target - s.x) * SPIN.stiffness - s.v * SPIN.damping) * dt;
    s.x += s.v * dt;
    return s.x;
  }

  // Add the spin reactions to the pose already on the model.
  function applySpin(state, rest, omega, dt) {
    const w = Number.isFinite(omega) ? omega : 0;
    const sq = w * Math.abs(w);     // omega^2, keeping the sign for the sway
    const abs = Math.abs(sq);
    const t = {
      armOut: clamp(SPIN.armOut[0] * abs, SPIN.armOut[1]),
      armLag: clamp(SPIN.armLag[0] * w, SPIN.armLag[1]),
      capeLift: clamp(SPIN.capeLift[0] * abs, SPIN.capeLift[1]),
      capeSway: clamp(SPIN.capeSway[0] * w, SPIN.capeSway[1]),
      headLag: clamp(SPIN.headLag[0] * w, SPIN.headLag[1]),
      bodyTwist: clamp(SPIN.bodyTwist[0] * w, SPIN.bodyTwist[1]),
      legLag: clamp(SPIN.legLag[0] * w, SPIN.legLag[1]),
    };
    const v = {};
    for (const n of Object.keys(t)) v[n] = springTo(state[n], t[n], dt);

    // Nothing to add once everything has settled back to zero.
    let moving = false;
    for (const n of Object.keys(t)) if (Math.abs(v[n]) > 1e-4 || Math.abs(state[n].v) > 1e-4) moving = true;
    if (!moving) return;

    const part = (name) => {
      const r = rest.find(x => x.name === name);
      return r ? r.part : null;
    };
    // Arms fly outward (positive Z swings the LEFT arm away from the body, so
    // the right one mirrors it) and trail the turn. The trail is opposite in
    // the two arms because an arm held out to the left and one held out to the
    // right move in opposite directions when the body turns: one goes forward,
    // the other back. That asymmetry is most of what sells it.
    const la = part('leftArm'), ra = part('rightArm');
    if (la) { la.rotation.z += v.armOut; la.rotation.x -= v.armLag; }
    if (ra) { ra.rotation.z -= v.armOut; ra.rotation.x += v.armLag; }

    const ll = part('leftLeg'), rl = part('rightLeg');
    if (ll) ll.rotation.x -= v.legLag;
    if (rl) rl.rotation.x += v.legLag;

    // The head is heavy and on a neck: it comes round last.
    const hd = part('head');
    if (hd) { hd.rotation.y -= v.headLag; hd.rotation.z -= v.headLag * 0.35; }

    const bd = part('body');
    if (bd) bd.rotation.y -= v.bodyTwist;

    // The cape is cloth in moving air: it lifts away from the back and streams
    // out to the side the turn is coming from.
    const cp = part('cape');
    if (cp) { cp.rotation.x += v.capeLift; cp.rotation.z -= v.capeSway; }
  }

  // How fast the page says the figure is turning. It is set from outside every
  // frame something is moving; when the updates stop it bleeds away on its own
  // rather than leaving the limbs held out forever.
  let spinOmega = 0, spinStamp = 0;
  function setSpin(w) {
    spinOmega = Number.isFinite(w) ? w : 0;
    spinStamp = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  }
  function currentSpin() {
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (now - spinStamp > 120) spinOmega *= 0.80;
    if (Math.abs(spinOmega) < 1e-3) spinOmega = 0;
    return spinOmega;
  }

  // A standalone animation for the card previews: no idle, no clips, just the
  // rest pose plus the physics, with the turn rate measured from the model's
  // own rotation (those cards spin the model itself rather than the camera).
  function spinOnlyAnimation() {
    const anim = new skinview3d.PlayerAnimation();
    const state = newSpinState();
    let lastYaw = null;
    anim.animate = function (player, delta) {
      const rest = restPose(player);
      const dt = Number.isFinite(delta) && delta > 0 ? Math.min(delta, 0.1) : 1 / 60;
      let yaw = 0;
      try { yaw = (player.parent || player).rotation.y; } catch { }
      let w = 0;
      if (lastYaw !== null) w = Math.atan2(Math.sin(yaw - lastYaw), Math.cos(yaw - lastYaw)) / dt;
      lastYaw = yaw;
      applyPose(rest, blankPose(rest));
      applySpin(state, rest, w, dt);
    };
    return anim;
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
    // The last pose the ANIMATION produced, before the spin reactions were
    // layered on top. Interrupting mid-clip blends out of this rather than off
    // the model itself, which by then has the spin baked into it and would
    // therefore get it applied a second time.
    let lastClean = null;

    const anim = new skinview3d.PlayerAnimation();
    const spinState = newSpinState();
    anim.animate = function (player, delta) {
      const rest = restPose(player);
      // skinview3d hands the speed-scaled delta to animate(); guard the first
      // frame, where it can be undefined.
      const dt = Number.isFinite(delta) && delta > 0 ? Math.min(delta, 0.1) : 1 / 60;
      // Every return path below goes through this, so being spun around reads
      // on the model whatever it happens to be doing at the time.
      const put = (pose) => {
        lastClean = pose;
        applyPose(rest, pose);
        applySpin(spinState, rest, currentSpin(), dt);
      };

      // Interrupted mid-clip: blend out of exactly where the model stands.
      if (cutIn) {
        cutIn = false;
        fromPose = lastClean || rest.map(r => ({
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
        put(evalIdle(rest, idleProgress));
        return;
      }

      if (phase === 'in') {
        blendT += dt;
        const f = Math.min(1, blendT / BLEND);
        put(lerpPose(fromPose, evalClip(rest, clip, 0), ease(f)));
        if (f >= 1) { phase = 'clip'; clipT = 0; }
        return;
      }

      if (phase === 'clip') {
        clipT += dt;
        const len = clip.length || 0;
        if (looping && len) {
          put(evalClip(rest, clip, clipT % len));
          return;
        }
        if (len && clipT >= len) {
          fromPose = evalClip(rest, clip, len);
          put(fromPose);
          blendT = 0; phase = 'out';
          return;
        }
        put(evalClip(rest, clip, clipT));
        return;
      }

      // 'out': land exactly on the calm point, so the idle carries on from the
      // position the arms are already in rather than jumping to meet it.
      blendT += dt;
      const f = Math.min(1, blendT / BLEND);
      put(lerpPose(fromPose, evalIdle(rest, IDLE_CALM), ease(f)));
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

  // The spin reactions and the cape reparenting are useful with or without
  // converted clips, so this object exists either way; only `conductor` and
  // `clips` depend on there being any.
  window.SkinAnimations = {
    clips,
    names,
    resetPose: resetToRest,
    conductor: names.length ? getConductor : null,
    // A clip at random, for whoever is doing the scheduling.
    randomName: () => names[Math.floor(Math.random() * names.length)],
    // How fast the figure looks like it is turning, radians per second,
    // positive for a turn to its left. Set it every frame while something is
    // moving; it bleeds away on its own once the updates stop.
    setSpin,
    // Rest pose plus the spin reactions, for the card previews -- they spin the
    // model itself, so this reads the rate off the model.
    spinOnly: spinOnlyAnimation,
  };

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
