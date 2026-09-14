// Hand-made animations for the big skin render.
//
// The skins page uses skinview3d's own IdleAnimation and a couple of its
// gestures by default. Define `window.SkinAnimations` here and those are used
// instead — this is where Blockbench-authored animations go once they exist.
//
//   window.SkinAnimations = {
//     idle:     (viewer) => <a skinview3d PlayerAnimation>,
//     gestures: [ (viewer) => <PlayerAnimation>, ... ],   // or a function
//                                                        // returning that array
//   }
//
// A PlayerAnimation is any object with an `animate(player, delta)` method;
// skinview3d exports the base class as `skinview3d.PlayerAnimation`, and
// `skinview3d.FunctionAnimation` wraps a plain function. `player` is the
// PlayerObject, so `player.skin.rightArm.rotation.x = …` and friends are what
// an animation actually sets. `this.progress` counts up in seconds.
//
// Blockbench exports keyframes per bone as {time, rotation:[x,y,z]} (and
// position for bones that move). playClip below turns one of those into a
// PlayerAnimation, so an exported clip can be dropped in as data rather than
// rewritten as code. It covers what a humanoid rig moves: head, body, the two
// arms and the two legs.
(function () {
  if (typeof skinview3d === 'undefined') return;

  // Blockbench bone names -> the parts skinview3d exposes.
  const BONES = {
    head: (p) => p.skin.head,
    body: (p) => p.skin.body,
    rightArm: (p) => p.skin.rightArm,
    leftArm: (p) => p.skin.leftArm,
    rightLeg: (p) => p.skin.rightLeg,
    leftLeg: (p) => p.skin.leftLeg,
    cape: (p) => p.cape,
  };
  const DEG = Math.PI / 180;

  // Where a track sits at time t, interpolating between the keyframes either
  // side of it. Blockbench writes degrees; three.js wants radians.
  function sampleTrack(keys, t, degrees) {
    if (!keys || !keys.length) return null;
    if (t <= keys[0].time) return keys[0].value;
    const last = keys[keys.length - 1];
    if (t >= last.time) return last.value;
    for (let i = 1; i < keys.length; i++) {
      if (t > keys[i].time) continue;
      const a = keys[i - 1], b = keys[i];
      const span = b.time - a.time || 1;
      const f = (t - a.time) / span;
      const k = degrees ? DEG : 1;
      return [0, 1, 2].map(j => (a.value[j] + (b.value[j] - a.value[j]) * f) * k);
    }
    return last.value;
  }

  // clip: { length, loop, degrees, bones: { <bone>: { rotation: [{time,value}],
  //                                                   position: [{time,value}] } } }
  function playClip(clip) {
    const degrees = clip.degrees !== false;      // Blockbench exports degrees
    return function makeAnimation() {
      const anim = new skinview3d.PlayerAnimation();
      anim.animate = function (player) {
        let t = this.progress;
        if (clip.loop && clip.length) t = t % clip.length;
        for (const [name, tracks] of Object.entries(clip.bones || {})) {
          const get = BONES[name];
          if (!get) continue;
          let part;
          try { part = get(player); } catch { continue; }
          if (!part) continue;
          const rot = sampleTrack(tracks.rotation, t, degrees);
          if (rot) part.rotation.set(rot[0], rot[1], rot[2]);
          // Position is in model units and is NOT an angle, so it never gets
          // the degree conversion.
          const pos = sampleTrack(tracks.position, t, false);
          if (pos) part.position.set(pos[0], pos[1], pos[2]);
        }
      };
      return anim;
    };
  }

  // Nothing authored yet — leaving SkinAnimations undefined keeps the built-in
  // idle and gestures. To switch over, build the clips and assign:
  //
  //   window.SkinAnimations = {
  //     idle: playClip(BREATHE),
  //     gestures: [playClip(WAVE), playClip(LOOK_AROUND), playClip(STRETCH)],
  //   };
  window.SkinAnimationClip = playClip;
})();
