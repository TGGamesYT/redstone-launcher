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
//   playerRenderAnimFlip()              treat the rig as facing the other way
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
    // Everything above the hips, legs left standing. See makeWaist below.
    waist: (p) => makeWaist(p),
    // The root is the whole figure, legs and all -- which is what a root
    // bone is for, and what the waist was wrongly doing.
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
  // Only the POSITION changes: the cape keeps the rotation it was authored
  // with. three.js's attach() would do this in one call, but it rebuilds the
  // rotation by decomposing a matrix, and skinview3d builds the cape with
  // rotation (x 10.8deg, y 180deg, z 0) -- which comes back out of a matrix as
  // the equivalent but differently spelled (x -169.2deg, y 0, z 180deg). The
  // same rotation, so nothing moves on that frame; but the idle writes
  // cape.rotation.x by itself, and 10.8deg against that second spelling is a
  // different rotation entirely, which swings the cape up over the head.
  //
  // Between the cape and the body there is nothing but plain offsets (the skin
  // group at y=8, the body at y=-6 inside it) and resetJoints() has just run,
  // so subtracting those offsets is the whole conversion into body space.
  function capeToBody(player) {
    try {
      const cape = player.cape, body = player.skin && player.skin.body;
      if (!cape || !body || cape.parent === body) return;
      let dx = 0, dy = 0, dz = 0;
      for (let n = body; n && n !== player; n = n.parent) {
        dx += n.position.x; dy += n.position.y; dz += n.position.z;
      }
      cape.position.set(cape.position.x - dx, cape.position.y - dy, cape.position.z - dz);
      body.add(cape);
    } catch { /* leave it where skinview3d put it */ }
  }

  // ── The waist ────────────────────────────────────────────────────────────
  //
  // A waist bone turns everything above the hips and leaves the legs standing
  // where they are: that is what the word means in every rig that has one.
  // It used to be an alias for the root, which drives the WHOLE figure --
  // legs included -- so a clip that turned the waist turned the model on the
  // spot instead of twisting it, and a clip that did both fought itself.
  //
  // skinview3d has no such bone, so there is one here: a group between the
  // skin and the parts above the waist. The legs stay where they were, as
  // children of the skin, and are untouched by it.
  //
  // It sits on the hip line, because that is what it has to turn about --
  // measured rather than assumed: the body's box runs from the neck at y=0
  // down to y=-12, and both legs pivot at y=-12, so y=-12 is where the legs
  // meet the body.
  const WAIST_Y = -12;
  const ABOVE_THE_WAIST = ["head", "body", "rightArm", "leftArm"];

  /**
   * An empty container, from whatever three.js the viewer is already using.
   *
   * There is no THREE on the page to ask -- skinview3d brings its own, in a
   * bundle -- so the class is found by walking up from something that is
   * already in the scene. `skin.constructor` itself is no good: building one
   * of those builds a whole second player. Its parent class is the plain
   * group this wants, and it is recognised by BEING empty rather than by its
   * name, which a minifier is free to change.
   */
  function emptyGroupLike(obj) {
    let C = obj && obj.constructor;
    for (let i = 0; i < 6 && typeof C === "function"; i++) {
      try {
        const made = new C();
        if (made && made.isObject3D && made.children && made.children.length === 0) return made;
      } catch { /* not constructible without arguments; try its parent */ }
      C = Object.getPrototypeOf(C);
    }
    return null;
  }

  //
  // Two groups, not one. The waist sits on the hip line so that it turns
  // about it, and a second group inside it puts that offset straight back --
  // so every part keeps the local position skinview3d gave it.
  //
  //   skin
  //    +- waist      y = -12   <- what a clip rotates
  //    |   +- inner  y = +12
  //    |       +- head, body, rightArm, leftArm   (positions untouched)
  //    +- rightLeg, leftLeg                       (never moved)
  //
  // Taking the offset off the parts instead would have been one group fewer
  // and wrong: resetJoints() writes each part's default position back, and
  // those defaults are relative to the skin. The upper half dropped twelve
  // units the first time a rest pose was taken. Leaving the parts alone means
  // there is nothing for resetJoints to disagree with.
  /** Is this still somewhere under that, however many groups deep? */
  function stillUnder(node, root) {
    for (let n = node; n; n = n.parent) if (n === root) return true;
    return false;
  }

  function makeWaist(player) {
    const skin = player && player.skin;
    if (!skin) return null;
    // Still rigged? Asked by ANCESTRY, not by parentage.
    //
    // A clip whose rig moved the waist's pivot turns it about a group hung
    // between it and the skin, so the waist is then a grandchild rather than
    // a child. Asking `parent === skin` called that "gone" -- and this runs
    // every frame -- so every frame built a SECOND waist, moved the head,
    // body and arms into it, and left the first one hanging off the pivot
    // group with nothing under it. The rest pose is read once and still held
    // the first one, so the clip went on writing the waist's rotation to an
    // orphan: the one bone whose pivot had been moved was the one bone that
    // stopped moving at all.
    if (skin.__waist && stillUnder(skin.__waist, skin)) return skin.__waist;
    try {
      const group = emptyGroupLike(skin);
      const inner = emptyGroupLike(skin);
      if (!group || !inner) return null;
      group.name = "waist";
      inner.name = "waistInner";
      group.position.set(0, WAIST_Y, 0);
      inner.position.set(0, -WAIST_Y, 0);
      group.add(inner);
      skin.add(group);
      for (const name of ABOVE_THE_WAIST) {
        const part = skin[name];
        if (!part || part.parent === inner) continue;
        inner.add(part);
      }
      skin.__waist = group;
      return group;
    } catch { return null; }
  }

  function restPose(player) {
    if (player.__restPose) return player.__restPose;
    // PlayerObject.resetJoints() puts the whole rig back to its defaults,
    // cape included. Without it a reload mid-animation would bake the current
    // pose in as "rest".
    try { player.resetJoints(); } catch { /* older build: read as-is */ }
    // Both of these move parts between parents, so they happen BEFORE the
    // rest pose is read -- what is recorded has to be where things actually
    // are, or every frame would put them back somewhere else.
    makeWaist(player);
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
    // resetJoints() may have been called in between and put the parts back
    // under the skin; remaking the waist is a no-op when it has not.
    makeWaist(player);
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
  // rotations map across unchanged. A rig authored the Bedrock way faces the
  // other direction, and turning a rig half a turn about Y negates its X and
  // Z rotations and leaves Y alone -- so that is what this does.
  //
  // It used to negate Y and Z, which was wrong in both halves and showed as
  // exactly that: an arm reaching forward reached backwards (X never
  // negated, and it had to be), and a head looking left then right looked
  // right then left (Y negated, and it must not be).
  let turned = false;
  // A clip says which way its rig faced, because a set of them can be built
  // up out of several rigs. The file-wide flag is what a clip that does not
  // say falls back to, and playerRenderAnimFlip() overrides both so the
  // question can still be settled by looking.
  let flipForced = false;
  // `flipYZ` is what the key was called when it meant something else; a file
  // written before this still says which way its rig faced, so it is still
  // read.
  const saysTurned = (c) => (c.turned === undefined ? c.flipYZ : c.turned);
  const flipFor = (clip) => (flipForced || !clip || saysTurned(clip) === undefined)
    ? turned : !!saysTurned(clip);

  // ── Turning somewhere other than where the part turns ────────────────────
  //
  // A rig's bone has an origin, and a wave wants the arm's at the shoulder
  // while a lean wants it at the waist -- which is two models of the same
  // player, and is exactly why a clip may be taken from a second rig. The
  // converter has always said this was the point of the thing; nothing ever
  // did it, so a clip from a rig with a moved pivot turned about the pivot
  // skinview3d gives the part and looked wrong.
  //
  // The file records where each bone turns on the rig most of the clips came
  // from, and a clip from elsewhere records its own. The difference is how
  // far the pivot moved, and it is put back by hanging the part off a group
  // that far away and turning THAT.
  //
  //   parent
  //    +- pivot   at p + shift      <- the clip's rotation goes here
  //        +- back at -(p + shift)
  //            +- part  (its own position, untouched)
  //
  // Two groups for the same reason the waist has two: resetJoints() writes a
  // part's own position back, so a part whose position had been adjusted
  // would be put somewhere else on the next rest pose.
  // Read when it is asked for, not now: `data` is declared further down this
  // file, so reading it here is reading a let before it exists -- which is
  // not a slow failure, it throws every time an animation plays.
  const basePivots = () => ((data && data.pivots) || {});

  /** How far this clip's bone turns from where the part normally turns. */
  function pivotShift(clip, bone, sx, sz) {
    const mine = clip && clip.bones && clip.bones[bone] && clip.bones[bone].pivot;
    const base = basePivots()[bone];
    if (!mine || !base) return null;
    const dx = Number(mine[0]) - Number(base[0]);
    const dy = Number(mine[1]) - Number(base[1]);
    const dz = Number(mine[2]) - Number(base[2]);
    if (!dx && !dy && !dz) return null;
    if (![dx, dy, dz].every(Number.isFinite)) return null;
    // A pivot is a point in the same space the rotations are in, so a rig
    // that faces the other way moves it the same way: X and Z change sign.
    return [dx * sx, dy, dz * sz];
  }

  /** The group a part is turned by, given a shift. Built once per part. */
  function pivotGroupFor(part, shift) {
    if (!part || !shift) return null;
    const key = shift.join(",");
    if (part.__pivotKey === key && part.__pivotGroup && part.__pivotGroup.parent) {
      return part.__pivotGroup;
    }
    try {
      const home = part.__pivotHome || part.parent;
      if (!home) return null;
      part.__pivotHome = home;
      // A shift that changed: take the old rigging out before building new.
      if (part.__pivotGroup && part.__pivotGroup.parent) {
        home.add(part);
        part.__pivotGroup.parent.remove(part.__pivotGroup);
      }
      const outer = emptyGroupLike(part);
      const back = emptyGroupLike(part);
      if (!outer || !back) return null;
      outer.name = "pivot";
      back.name = "pivotBack";
      const p = part.position;
      outer.position.set(p.x + shift[0], p.y + shift[1], p.z + shift[2]);
      back.position.set(-(p.x + shift[0]), -(p.y + shift[1]), -(p.z + shift[2]));
      outer.add(back);
      back.add(part);
      home.add(outer);
      part.__pivotGroup = outer;
      part.__pivotKey = key;
      return outer;
    } catch { return null; }
  }

  /** Put a part back under its own parent, turning where it normally turns. */
  function clearPivotGroup(part) {
    if (!part || !part.__pivotGroup) return;
    try {
      const outer = part.__pivotGroup;
      if (part.__pivotHome) part.__pivotHome.add(part);
      if (outer.parent) outer.parent.remove(outer);
    } catch { /* already taken apart */ }
    part.__pivotGroup = null;
    part.__pivotKey = null;
  }

  /**
   * Where this bone's rotation should be written, and what to reset.
   *
   * Returns the object the angles go on. When there is no shift that is the
   * part itself, which is what every clip did before any of this.
   */
  function turnerFor(part, shift) {
    if (!shift) { clearPivotGroup(part); return part; }
    const g = pivotGroupFor(part, shift);
    if (!g) return part;
    // The part keeps the rest pose's own rotation; the clip's goes on the
    // group, so the two compose rather than one replacing the other.
    return g;
  }

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
        const f = flipFor(clip);
        // Half a turn about Y: X and Z change sign, Y does not.
        const sx = f ? -1 : 1, sz = f ? -1 : 1;
        let t = this.progress;
        if (clip.length) t = loops ? t % clip.length : Math.min(t, clip.length);

        for (const r of pose) {
          const tracks = (clip.bones || {})[r.name];
          const part = r.part;

          const rot = tracks && sampleTrack(tracks.rotation, t);
          // Where this bone turns. A clip from a rig whose pivot was moved
          // turns about a group that far away instead of about the part.
          const shift = pivotShift(clip, r.name, sx, sz);
          const turner = turnerFor(part, shift);
          if (turner !== part) {
            // The part keeps its rest rotation and the clip's goes on the
            // group, so the pivot moves without the pose being replaced.
            part.rotation.set(r.rotation[0], r.rotation[1], r.rotation[2]);
            turner.rotation.set(
              (rot ? rot[0] * k * sx : 0),
              (rot ? rot[1] * k : 0),
              (rot ? rot[2] * k * sz : 0),
            );
          } else {
            part.rotation.set(
              r.rotation[0] + (rot ? rot[0] * k * sx : 0),
              r.rotation[1] + (rot ? rot[1] * k : 0),
              r.rotation[2] + (rot ? rot[2] * k * sz : 0),
            );
          }

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

  // Everything here is written as rest PLUS an offset, never as an absolute
  // angle. skinview3d's own IdleAnimation writes absolutes, which works only
  // because it knows the rest values it is overwriting -- the arms at 0 and the
  // cape at 0.06*PI. Spelling the cape's rest rotation differently (as
  // reparenting it onto the body used to) is then enough to flip it over the
  // head, and a rig whose arms do not rest at zero would be wrong from the
  // first frame. Offsets cannot go wrong that way.
  function evalIdle(rest, progress) {
    const pose = blankPose(rest);
    const t = 2 * progress;
    const lean = 0.02 * Math.PI;
    const idx = (name) => rest.findIndex(r => r.name === name);
    const at = (name) => { const i = idx(name); return i < 0 ? null : pose[i]; };
    const la = at('leftArm'), ra = at('rightArm'), cp = at('cape');
    if (la) la.r[2] = rest[idx('leftArm')].rotation[2] + 0.03 * Math.cos(t) + lean;
    if (ra) ra.r[2] = rest[idx('rightArm')].rotation[2] + 0.03 * Math.cos(t + Math.PI) - lean;
    if (cp) cp.r[0] = rest[idx('cape')].rotation[0] + 0.01 * Math.sin(t);
    return pose;
  }

  // The clip's pose at time t, as data, so it can be blended rather than only
  // written straight to the model.
  function evalClip(rest, clip, t) {
    const pose = blankPose(rest);
    const k = clip.degrees !== false ? DEG : 1;
    const f = flipFor(clip);
    // Half a turn about Y: X and Z change sign, Y does not.
    const sx = f ? -1 : 1, sz = f ? -1 : 1;
    rest.forEach((r, idx) => {
      const tracks = (clip.bones || {})[r.name];
      if (!tracks) return;
      const e = pose[idx];
      const rot = sampleTrack(tracks.rotation, t);
      if (rot) {
        e.r[0] = r.rotation[0] + rot[0] * k * sx;
        e.r[1] = r.rotation[1] + rot[1] * k;
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
    stiffness: 34,       // how hard it pulls toward the target
    damping: 7.6,        // < 2*sqrt(stiffness) leaves some overshoot
    // How much of each effect, and how far it is ever allowed to go.
    //
    // The TRAIL leads, not the fly-out. Spinning on the spot drags your hands
    // round behind you — they are left where the turn started and catch up —
    // and that is the part you actually feel. Throwing them straight out
    // sideways is a much smaller thing on top of it, so armOut is a tenth of
    // what it was and armLag is now the bigger of the two at any realistic
    // speed. (armOut goes with omega SQUARED because centrifugal force does;
    // the trailing ones are linear in omega, like drag.)
    armOut: [0.0085, 0.26], armLag: [0.105, 0.62],
    capeLift: [0.012, 0.30], capeSway: [0.095, 0.55],
    headLag: [0.055, 0.40], bodyTwist: [0.020, 0.16],
    legLag: [0.038, 0.30],
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
    // Remembered, because whoever is driving the render needs to know: a card
    // that swaps itself back to a still picture the moment its ROTATION is
    // home does it while the arms are still swinging, and they teleport.
    //
    // Two different questions, two different thresholds. `moving` decides
    // whether to touch the pose at all, and 1e-4 is right for that. "Has it
    // visually settled" is a quarter of a degree: measured in the running
    // launcher, the arm is 0.88 rad out when the spin stops, back under
    // 0.01 rad half a second later, and does not clear 1e-4 for another two
    // seconds -- so waiting for THAT would be waiting for nothing anybody
    // can see.
    state.moving = moving;
    let rested = true;
    for (const n of Object.keys(t)) {
      if (Math.abs(v[n]) > 0.004 || Math.abs(state[n].v) > 0.02) { rested = false; break; }
    }
    state.rested = rested;
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
  // `getExtra` adds a turn rate the model itself cannot show. A card preview
  // spins the MODEL, which this reads off directly — but DRAGGING one orbits
  // the camera instead, and from the figure's point of view being orbited is
  // the same as being spun. Without that, the arms only reacted to the idle
  // auto-spin and did nothing at all while the card was being dragged.
  function spinOnlyAnimation(getExtra) {
    const anim = new skinview3d.PlayerAnimation();
    const state = newSpinState();
    let lastYaw = null;
    // A turn bigger than this in one frame is not a turn, it is a jump: these
    // viewers are pooled, so the same animation sees one card's final angle
    // and then the next card's starting angle back to back, and the snap home
    // at the end of an ease-out is another. Reading those as motion is what
    // flung the arms out the moment a card was hovered and then let them slide
    // back. 0.35 rad in a frame is already 21 rad/s -- far past anything a
    // pointer produces.
    const JUMP = 0.35;
    anim.resetSpin = function () {
      lastYaw = null;
      for (const k of Object.keys(state)) {
        if (!state[k] || typeof state[k] !== 'object') continue;
        state[k].x = 0; state[k].v = 0;
      }
      state.moving = false;
      state.rested = true;
    };
    // Whether the limbs have finished reacting. The rotation coming home is
    // not the same thing: the arms are springs hanging off it and they are
    // still moving for a moment afterwards.
    anim.atRest = function () { return state.rested !== false; };
    anim.animate = function (player, delta) {
      const rest = restPose(player);
      const dt = Number.isFinite(delta) && delta > 0 ? Math.min(delta, 0.1) : 1 / 60;
      let yaw = 0;
      try { yaw = (player.parent || player).rotation.y; } catch { }
      let w = 0;
      if (lastYaw !== null) {
        const d = Math.atan2(Math.sin(yaw - lastYaw), Math.cos(yaw - lastYaw));
        if (Math.abs(d) <= JUMP) w = d / dt;
      }
      lastYaw = yaw;
      let extra = 0;
      if (typeof getExtra === 'function') {
        try { const e = getExtra(); if (Number.isFinite(e)) extra = e; } catch { /* ignore */ }
      }
      applyPose(rest, blankPose(rest));
      applySpin(state, rest, w + extra, dt);
    };
    return anim;
  }

  // One of skinview3d's own animations -- idling, walking, running, flying --
  // with the spin reactions on top of it.
  //
  // The reactions are added to whatever pose is already on the model, so they
  // layer over anything. The converted clips go through the conductor, which
  // does this itself; skinview3d's own animations went on the viewer raw, so
  // a render set to walk or idle was a rigid statue when it was turned while
  // the same render set to the clips threw its arms out. Standing still was
  // the same: no animation at all meant no reactions either.
  //
  // `inner` may be null, which is "standing still, but it still reacts".
  function withSpin(inner) {
    const anim = new skinview3d.PlayerAnimation();
    const state = newSpinState();
    anim.animate = function (player, delta) {
      const dt = Number.isFinite(delta) && delta > 0 ? Math.min(delta, 0.1) : 1 / 60;
      const rest = restPose(player);

      // Back to rest FIRST, every frame.
      //
      // The reactions are added to the pose already on the model -- `+=` on a
      // rotation -- which is only relative to this frame if something has put
      // the rig back to a known pose first. The conductor does: it writes a
      // complete pose with `.set()` before adding anything. skinview3d's own
      // animations do not, and neither does its update loop: an idle writes
      // the two parts it animates and leaves the head, the cape and the legs
      // exactly as they were left last frame. So the spin was added to its own
      // output over and over, and a flick wound the limbs up without bound --
      // which is what "ultra crazy" is. One reset and they behave like the
      // skins page's, because now they are doing the same thing.
      resetToRest(player);

      if (inner && typeof inner.animate === 'function') {
        // Its own progress, its own speed: skinview3d advances `progress` on
        // the animation object it was given, and this is that object now.
        try { inner.progress = anim.progress; } catch { /* a plain object */ }
        try { inner.animate(player, delta); } catch { /* leave it standing */ }
      }
      applySpin(state, rest, currentSpin(), dt);
    };
    anim.atRest = function () { return state.rested !== false; };
    return anim;
  }

  // ── Being turned, and finding the way back ───────────────────────────────
  /**
   * Wire a viewer's camera so dragging it has weight, the limbs react to being
   * turned, and the figure comes back to facing forward when it is left alone.
   *
   *   const phys = SkinAnimations.orbitPhysics(viewer);
   *   …
   *   phys.stop();      // when the viewer goes
   *
   * It lived on the skins page, where it is the big render's whole character:
   * the friend-details render had a camera that moved when dragged and nothing
   * else -- no weight, no reaction from the figure, and wherever you left it is
   * where it stayed. So it is here, where both pages can have it.
   *
   * resetCameraPose() puts the camera at (0, 0, d) -- theta 0, phi PI/2,
   * looking at the origin -- and orbiting preserves d, so "home" needs no
   * bookkeeping beyond the distance the camera is already at.
   *
   * The camera used to creep home at a fixed fraction per frame, which is why
   * it read as lifeless: the same lazy drift whether you nudged it ten degrees
   * or spun it right round, and it stopped dead on arrival. It is a spring with
   * a bit of weight instead. Flicking leaves velocity behind so the model keeps
   * turning and slows down on its own; the pull home is proportional to how far
   * out it is, and damped rather than critically damped, so it runs past centre
   * and settles back with a couple of diminishing swings.
   *
   * opts:
   *   onSpin(w)     told the apparent turn rate, rad/s, instead of setSpin.
   *   returnAfter   ms to stay where it was left before drifting back.
   */
  // ── Keeping the figure level while it spins ──────────────────────────────
  // Spinning hard and ending up looking at the top of a head is not what
  // spinning something does: a thing being turned fast settles into the plane
  // it is turning in. So the pitch is always pulled back toward level, and the
  // harder it is spinning the harder that pull is -- a slow look around stays
  // where you put it, a fast flick levels itself out while it runs down.
  const LEVEL_PULL = 0.035;     // the pull at full spin
  const LEVEL_FULL = 0.14;      // radians/frame of yaw that counts as "fast"
  const LEVEL_DAMP = 0.88;      // heavy enough that it barely overshoots
  // Zero when it is not turning, deliberately: looking at the top of a head and
  // letting go has to STAY there, or being able to tilt at all is pointless.
  // Settling back to the front is the homing's job, not this one's.
  const levelPull = (yawRate) => LEVEL_PULL * Math.min(1, Math.abs(yawRate) / LEVEL_FULL);
  // Damped rather than critically damped on purpose: it runs past centre and
  // settles back with a couple of diminishing swings, which reads as weight.
  const HOME_SPRING = 0.022;    // pull toward home, per frame
  const HOME_DAMP = 0.94;       // <1 leaves overshoot; lower = stiffer
  const HOME_PHI = Math.PI / 2; // level
  const MAX_VEL = 0.35;
  // Free-spin decay after a flick, per frame at 60Hz. It was 0.97, which halves
  // the speed every 0.4s and has the figure standing still inside two and a
  // half seconds: the levelling finishes in a quarter of a second and the spin
  // is nearly gone by the time it does, so the two read as one thing and the
  // flick looked like it had been stopped rather than left to run. They are
  // separate -- a flick with no lift in it runs down at exactly the same rate
  // as one that gets levelled -- so what was wrong was only how long it lasts.
  // 0.988 went too far the other way: the render kept gliding for the whole
  // wait and read as frictionless, nothing like the small card renders beside
  // it. 0.975 halves the speed in about half a second and is done inside two
  // and a half -- a flick that carries, rather than one that is stopped or one
  // that never stops.
  const SPIN_DAMP = 0.975;
  const MAX_OMEGA = 14;         // rad/s; past this nothing looks any different

  const normAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  // The camera orbits at a fixed distance, so its pose is two angles. Easing in
  // spherical coordinates swings it back along its arc; a straight-line lerp
  // between positions cuts the corner (which reads as a zoom) and, at exactly
  // 180 degrees, passes through the origin and never converges at all.
  function camSpherical(p) {
    const r = p.length() || 1;
    return { theta: Math.atan2(p.x, p.z), phi: Math.acos(Math.max(-1, Math.min(1, p.y / r))) };
  }
  function camFromSpherical(p, theta, phi, r) {
    const sp = Math.sin(phi);
    p.set(r * sp * Math.sin(theta), r * Math.cos(phi), r * sp * Math.cos(theta));
  }

  function orbitPhysics(v, opts) {
    opts = opts || {};
    if (!v || !v.canvas || !v.controls) return { dragging: false, stop() { }, home() { } };
    const canvas = v.canvas;
    // Not asking for it and asking for NEVER are two different things.
    //
    // A returnAfter that is given but is not a number means never come back:
    // that is how "do not settle back" is asked for, and it used to fall
    // through to the default and settle back like everything else. But not
    // mentioning it at all means the ordinary behaviour, which is to come
    // home after three and a half seconds -- and that got swept up in the
    // same change, so the skins page, which passes no options whatever,
    // stopped settling back to the middle.
    const RETURN_AFTER = !('returnAfter' in opts) ? 3500
      : (Number.isFinite(opts.returnAfter) ? opts.returnAfter : null);
    // Whether a flick carries after the pointer goes. Off, a release simply
    // stops where it was left -- which is what somebody who wants it to settle
    // back without it spinning around first is asking for.
    const MOMENTUM = opts.momentum !== false;
    // The pitch stops the controls already enforce, so a flick carrying on
    // after the pointer has gone cannot sail past one.
    const minPolar = Number.isFinite(v.controls.minPolarAngle) ? v.controls.minPolarAngle : 0;
    const maxPolar = Number.isFinite(v.controls.maxPolarAngle) ? v.controls.maxPolarAngle : Math.PI;

    let raf = null, idleTimer = null;
    let velTheta = 0, velPhi = 0;       // radians per frame
    let lastTheta = null, lastPhi = null;
    let homing = false, dragging = false, hovering = false, dead = false;
    let lastW = 0;
    // When it last came to rest facing forward with nobody touching it, so
    // whoever schedules gestures can tell "left alone" from "just let go of".
    // A render that is being turned, hovered, flung or on its way home is not
    // left alone, and a gesture starting then is the thing that looks wrong.
    let restingSince = 0;

    const stopLoop = () => { if (raf) { cancelAnimationFrame(raf); raf = null; } };

    // Orbiting the camera one way around a still model looks exactly like
    // spinning the model the other way, so that is what the limbs are told is
    // happening -- hence the flipped sign.
    //
    // The rate is measured against the clock rather than assumed to be one
    // frame: the loop runs at the display's rate, but a drag reports through
    // OrbitControls' "change" event, which fires per pointer move. Calling
    // either one 1/60s would make the same drag read as a different speed
    // depending on which path saw it.
    const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    let lastSpinAt = 0;
    const reportSpin = (dTheta) => {
      const t = nowMs();
      const dt = lastSpinAt ? Math.min(0.25, Math.max(1 / 240, (t - lastSpinAt) / 1000)) : 1 / 60;
      lastSpinAt = t;
      const w = Math.max(-MAX_OMEGA, Math.min(MAX_OMEGA,
        -(Number.isFinite(dTheta) ? dTheta : 0) / dt));
      lastW = w;
      try { (opts.onSpin || setSpin)(w); } catch { /* the render is not worth throwing over */ }
    };

    // While dragging, measure how fast the camera is actually moving so the
    // flick carries over when the pointer is released.
    const sampleDrag = () => {
      try {
        const cur = camSpherical(v.camera.position);
        if (lastTheta !== null) {
          velTheta = normAngle(cur.theta - lastTheta);
          velPhi = cur.phi - lastPhi;
          reportSpin(velTheta);
        }
        lastTheta = cur.theta; lastPhi = cur.phi;
      } catch { }
    };

    // The springs below are written per frame, and were tuned at 60Hz. Taken
    // literally that makes the whole thing run at the speed of the display: on
    // a 144Hz screen a flick comes home in a third of the time, and on anything
    // struggling -- a slow machine, a blurred overlay over the top, a laptop on
    // battery -- it crawls back so slowly it reads as never coming back at all.
    // So a frame counts for how long it actually took. k is 1 at 60Hz, which is
    // where the numbers came from, and is capped because a spring integrated in
    // one huge step does not settle, it explodes.
    let lastStepAt = 0;
    const frames = () => {
      const t = nowMs();
      const dt = lastStepAt ? (t - lastStepAt) / 1000 : 1 / 60;
      lastStepAt = t;
      return Math.max(0.2, Math.min(3, dt * 60));
    };

    const step = () => {
      raf = null;
      if (dragging || dead) return;
      try {
        const cam = v.camera, tgt = v.controls.target;
        const r = cam.position.length() || 1;
        const cur = camSpherical(cam.position);
        const k = frames();

        if (homing) {
          // Spring toward the front, phi included so a drag upwards settles too.
          velTheta += normAngle(0 - cur.theta) * HOME_SPRING * k;
          velPhi += (HOME_PHI - cur.phi) * HOME_SPRING * k;
          velTheta *= Math.pow(HOME_DAMP, k); velPhi *= Math.pow(HOME_DAMP, k);
        } else {
          // Free spin after a flick: bleed the speed away -- but keep pulling
          // the pitch back to level the whole time, harder the faster it is
          // going, so a hard spin does not leave the figure tipped up or down.
          // The yaw is left alone; only the pitch self-corrects.
          velTheta *= Math.pow(SPIN_DAMP, k);
          velPhi += (HOME_PHI - cur.phi) * levelPull(velTheta) * k;
          velPhi *= Math.pow(LEVEL_DAMP, k);
        }
        velTheta = Math.max(-MAX_VEL, Math.min(MAX_VEL, velTheta));
        velPhi = Math.max(-MAX_VEL, Math.min(MAX_VEL, velPhi));

        const stepPhi = velPhi * k;
        const nextPhi = Math.max(minPolar, Math.min(maxPolar, cur.phi + stepPhi));
        if (nextPhi !== cur.phi + stepPhi) velPhi = 0;   // hit the stop; don't keep pushing
        camFromSpherical(cam.position, cur.theta + velTheta * k, nextPhi, r);

        if (tgt.lengthSq() > 0.0001) tgt.multiplyScalar(0.9); else tgt.set(0, 0, 0);
        v.controls.update();
        reportSpin(velTheta);

        const offT = Math.abs(normAngle(0 - cur.theta)), offP = Math.abs(HOME_PHI - cur.phi);
        const speed = Math.abs(velTheta) + Math.abs(velPhi);
        if (homing && speed < 0.0015 && offT < 0.01 && offP < 0.01) {
          camFromSpherical(cam.position, 0, HOME_PHI, r);
          v.controls.update();
          velTheta = velPhi = 0;
          homing = false;
          if (!hovering) restingSince = nowMs();
          return;                        // settled
        }
        // A flick that has run out of speed just stops there and waits. It used
        // to start homing the moment it slowed down, which meant a plain
        // drag-and-release (no flick, so no speed to bleed off) snapped back
        // immediately and the wait below never got a say.
        //
        // The pitch is the exception: the loop keeps running until it IS level,
        // otherwise a fast spin stops the instant the yaw dies and leaves the
        // figure tipped where the flick left it.
        if (!homing && speed < 0.002 && offP < 0.01) {
          velTheta = velPhi = 0;
          if (offT < 0.01 && !hovering) restingSince = nowMs();
          // Never stop off-centre with nothing left to bring it back. If the
          // figure is turned and no return is pending, schedule one -- the loop
          // may pause, but the render may not be stranded. Unless coming back
          // is exactly what it was told not to do, in which case where it was
          // left IS where it belongs.
          if (offT > 0.01 && !idleTimer && RETURN_AFTER !== null) armReturn();
          return;
        }
      } catch { return; }
      raf = requestAnimationFrame(step);
    };

    restingSince = nowMs();          // nothing has touched it yet
    const startLoop = () => { if (!raf && !dead) raf = requestAnimationFrame(step); };
    function armReturn() {
      clearTimeout(idleTimer);
      // Let the flick play out first; the wait is before it decides to come
      // back, not before it is allowed to move.
      startLoop();
      if (RETURN_AFTER === null) return;         // asked never to come back
      // Nulled when it fires, so "is a return pending?" is answerable.
      idleTimer = setTimeout(() => { idleTimer = null; homing = true; startLoop(); }, RETURN_AFTER);
    }
    // Only the PENDING return is cancelled. A return already under way is left
    // to finish: clearing `homing` as well meant that moving the pointer over
    // the render while it was swinging back dropped it into the free-spin
    // branch, which -- slow and already level -- stopped the loop on the spot
    // and left the figure at whatever angle it had reached, with no timer left
    // to bring it home. That was the "sometimes it ends up a bit rotated".
    // Starting a DRAG still clears it, which is the one place abandoning the
    // return is right.
    const cancelReturn = () => { clearTimeout(idleTimer); idleTimer = null; };

    const onEnter = () => { hovering = true; restingSince = 0; cancelReturn(); };
    // Not while it is being dragged. The pointer leaves the canvas constantly
    // mid-drag -- the render is a narrow column and a sideways drag runs off it
    // in a few dozen pixels -- and arming the return there started the loop,
    // which saw `dragging` and stopped again, leaving nothing running to carry
    // the flick when the pointer came up. The drag's own end arms it.
    const onLeave = () => { hovering = false; if (!dragging) armReturn(); };
    const onStart = () => {
      dragging = true; restingSince = 0; cancelReturn(); homing = false; stopLoop();
      velTheta = velPhi = 0; lastTheta = lastPhi = null;
    };
    const onChange = () => { if (dragging) sampleDrag(); };
    const onEnd = () => {
      dragging = false;
      // No momentum means a release stops it dead rather than letting the
      // flick carry; it may still find its way back to the front afterwards.
      if (!MOMENTUM) { velTheta = 0; velPhi = 0; }
      armReturn();
    };

    canvas.addEventListener('pointerenter', onEnter);
    canvas.addEventListener('pointerleave', onLeave);
    try {
      v.controls.addEventListener('start', onStart);
      v.controls.addEventListener('change', onChange);
      v.controls.addEventListener('end', onEnd);
    } catch { }

    return {
      get dragging() { return dragging; },
      get hovering() { return hovering; },
      // The apparent turn rate, for an animation that wants to read it rather
      // than be told through setSpin.
      rate: () => lastW,
      // How long it has stood still facing forward with nobody on it, in ms.
      // 0 while it is being turned, hovered, flung or brought back.
      restingFor: () => (restingSince ? nowMs() - restingSince : 0),
      // Bring it home now, without waiting.
      home() { cancelReturn(); homing = true; startLoop(); },
      stop() {
        dead = true;
        stopLoop(); cancelReturn();
        canvas.removeEventListener('pointerenter', onEnter);
        canvas.removeEventListener('pointerleave', onLeave);
        try {
          v.controls.removeEventListener('start', onStart);
          v.controls.removeEventListener('change', onChange);
          v.controls.removeEventListener('end', onEnd);
        } catch { }
      },
    };
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
    // The same figure, read back: what the spin currently is. Poll it once a
    // frame; it bleeds away between polls once the updates stop.
    currentSpin,
    // Rest pose plus the spin reactions, for the card previews -- they spin the
    // model itself, so this reads the rate off the model.
    spinOnly: spinOnlyAnimation,
    // Any animation, with the spin reactions layered over it. Pass null for
    // standing still, which still reacts.
    withSpin,
    // Weight on the camera, and a way back to facing forward.
    orbitPhysics,
    // The springs orbitPhysics is built from, for a render that drives its own
    // camera and still has to come home the same way -- the card previews do.
    // One definition, so a skin let go of moves identically whichever render
    // it was.
    spring: {
      HOME_SPRING, HOME_DAMP, LEVEL_DAMP, MAX_VEL, SPIN_DAMP, HOME_PHI,
      levelPull, camSpherical, camFromSpherical, norm: normAngle,
    },
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
    // Playing one by hand is still one having been played: whoever schedules
    // the random ones starts its wait again rather than firing on top of it.
    try { window.dispatchEvent(new CustomEvent('skin-animation-played', { detail: { name } })); } catch { }
    console.log(`Playing "${name}" (${clip.length}s, ${loop ? 'looping' : 'once'}).`
      + (loop ? ' playerRenderAnimPlay(null) to stop.' : ''));
    return true;
  };

  // Which way the rig faces is a property of how it was authored, and the
  // only honest way to settle it is to watch the model. Turn it, watch, and
  // re-export whichever way round turns out to be right.
  window.playerRenderAnimFlip = function () {
    // Asked for by hand, so it wins over what each clip says about itself --
    // the point of it is to try the other way round and look.
    flipForced = true;
    turned = !turned;
    console.log(`The rig is treated as facing ${turned ? 'THE OTHER WAY' : 'the way it was authored'}.`
      + ' If this is the right way round, re-export with: node bbmodelconvert.js <file>'
      + (turned ? '' : ' --no-flip') + '  (turned is the default)');
    const p = playerOf(viewer());
    if (p) { try { resetToRest(p); } catch { /* next frame will */ } }
    return turned;
  };

  // Set from the converted file, so the export's choice is honoured without a
  // devtools call. `flipYZ` is the old spelling of the same flag.
  if (data && (data.turned !== undefined ? data.turned : data.flipYZ)) turned = true;
})();
