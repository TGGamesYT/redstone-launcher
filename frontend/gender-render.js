// An easter egg: Wildfire's Female Gender Mod, on the launcher's player renders.
//
// When an instance with the mod in it is running, or ran in the last ten
// minutes (or Settings says to keep it), a player render in the launcher wears
// what the mod is set to in that instance: the same two boxes, cut from the
// same part of the skin, placed, tilted and moved the way the mod does it in
// the game, physics included. backend/gender-mod.js reads the mod's settings.
//
// This is a port of the mod's own drawing and physics
// (https://github.com/FemaleGenderMod/FemaleGenderMod, LGPL-3.0:
// GenderLayer, WildfireModelRenderer and BreastPhysics), so the numbers below
// are the mod's. Where the game has something a render here does not -- a
// world to walk through, armour, vehicles -- what the render does have stands
// in for it: the figure turning, or being turned by a drag, is the body
// turning; its legs' swing is the walk; an arm thrown fast is a swing.
//
//   GenderRender.attach(viewer, who?)   who: { selected: true } (the default)
//                                        or { uuid, name, offline, playerId }
//                                        or { config } -- settings as given
(function () {
  if (window.GenderRender) return;
  let ipcRenderer = null;
  try { ({ ipcRenderer } = require('electron')); } catch { /* not in the launcher */ }

  const TICK_MS = 50;                       // the game's 20 ticks a second
  const BOX = { w: 4, h: 5, d: 3 };         // each one, in skin pixels
  const DIRS = ['east', 'west', 'down', 'up', 'north'];

  // ── 4x4 matrices, column-major like three's ──────────────────────────────
  const I = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  function mul(a, b) {
    const o = new Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
    return o;
  }
  const T = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
  const S = (x, y, z) => [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
  const RX = (a) => { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]; };
  const RY = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]; };
  const DEG = Math.PI / 180;
  const lerp = (t, a, b) => a + (b - a) * t;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const round1 = (v) => Math.round(v * 10) / 10;

  // ── the physics, one breast's worth (BreastPhysics) ──────────────────────
  function newPhysics() {
    return {
      bounceVelX: 0, targetBounceX: 0, velocityX: 0, positionX: 0, prePositionX: 0,
      bounceVel: 0, targetBounceY: 0, velocity: 0, positionY: 0, prePositionY: 0,
      bounceRotVel: 0, targetRotVel: 0, rotVelocity: 0, bounceRotation: 0, preBounceRotation: 0,
      breastSize: 0, preBreastSize: 0,
      started: false, lastPose: null, randomB: 1, lastVert: 0,
      lastSwingDuration: 6, lastSwingTick: 0,
    };
  }

  function distanceFromMedian(p1, p2, point) {
    if (point <= p1 || point >= p2) return 0;
    const median = (p2 - p1) / 2;
    point -= p1;
    if (point > median) point = -(median - (point - median));
    return point / median;
  }

  function tickPhysics(P, cfg, inp, tickCount) {
    const b = cfg.breasts, ph = b.physics;
    P.prePositionY = P.positionY; P.prePositionX = P.positionX;
    P.preBounceRotation = P.bounceRotation; P.preBreastSize = P.breastSize;
    if (!P.started) { P.started = true; return; }

    let target = b.size;
    const weight = target * 1.25;
    if (!cfg.shows) target = 0;
    P.breastSize += P.breastSize < target ? Math.abs(P.breastSize - target) / 2 : -Math.abs(P.breastSize - target) / 2;

    let bounce = target * 3 * Math.round(ph.bounce * 3 * 100) / 100;
    if (!ph.uniboob) bounce *= 0.5 + Math.random() * 2;

    // movement
    const vert = inp.motionY;
    if ((P.lastVert <= 0 && vert > 0) || (P.lastVert < 0 && vert === 0)) P.randomB = Math.random() < 0.5 ? -1 : 1;
    P.lastVert = vert;
    P.targetBounceY = inp.motionY * bounce + weight;
    const turn = -(inp.yawDelta / 15) * bounce;
    P.targetRotVel = turn + inp.motionY * bounce * P.randomB;
    P.targetBounceX = -turn / 10;
    let speed = inp.speedSq / 0.2;
    speed = speed * speed * speed;
    if (speed < 1) speed = 1;
    P.targetBounceY += inp.walk / speed;

    // pose
    if (inp.pose !== P.lastPose) {
      if (P.lastPose !== null && (inp.pose === 'crouching' || P.lastPose === 'crouching')) P.targetBounceY += bounce;
      P.lastPose = inp.pose;
    }

    // arm swing
    const sw = inp.swing;
    if (sw.duration > 1 || P.lastSwingDuration > 1) {
      const amp = clamp(1 + sw.amplifier, 0.6, 1.3);
      const delta = sw.tick - P.lastSwingTick;
      const progress = distanceFromMedian(0, P.lastSwingDuration, clamp(P.lastSwingTick, 0, P.lastSwingDuration));
      const toward = progress > -0.2 ? (sw.arm === 'right' ? 'left' : 'right') : sw.arm;
      const nth = clamp(sw.duration - 1, 1, 5);
      if (sw.isSwinging && tickCount % nth === 0) {
        P.targetBounceY += (Math.random() < 0.5 ? -0.25 : 0.25) * amp * bounce;
        P.targetBounceX = 0.325 * sw.xAmplifier * bounce * (sw.arm === 'right' ? -1 : 1);
      }
      if (delta < 0 && P.lastSwingTick !== P.lastSwingDuration - 1) {
        P.targetRotVel += (sw.arm === 'right' ? -4 : 4) * Math.abs(progress) * bounce;
      } else if (sw.isSwinging && sw.duration > 1) {
        P.targetRotVel += (toward === 'right' ? -0.2 : 0.2) * amp * bounce;
      }
      P.lastSwingTick = sw.tick;
    }
    if (!sw.isSwinging) P.lastSwingTick = 0;
    P.lastSwingDuration = Math.max(sw.duration, 1);

    // finishTick
    const percent = ph.floppiness;
    let bounceAmount = clamp(0.45 * (1 - percent) + 0.15, 0.15, 0.6);
    const d = 2.25 - bounceAmount;
    const fromMin = Math.abs(P.bounceVel + 1.5) * 0.5;
    const fromMax = Math.abs(P.bounceVel - 2.65) * 0.5;
    if (P.bounceVel < -0.5) P.targetBounceY += fromMin;
    if (P.bounceVel > 2.5) P.targetBounceY -= fromMax;
    P.targetBounceY = clamp(P.targetBounceY, -1.5, 2.5);
    P.targetRotVel = clamp(P.targetRotVel, -25, 25);
    P.velocity = lerp(bounceAmount, P.velocity, (P.targetBounceY - P.bounceVel) * d);
    P.bounceVel += P.velocity * percent * 1.1625;
    P.velocityX = lerp(bounceAmount, P.velocityX, (P.targetBounceX - P.bounceVelX) * d);
    P.bounceVelX += P.velocityX * percent;
    P.rotVelocity = lerp(bounceAmount, P.rotVelocity, (P.targetRotVel - P.bounceRotVel) * d);
    P.bounceRotVel += P.rotVelocity * percent;
    P.bounceRotation = P.bounceRotVel;
    P.positionX = P.bounceVelX;
    P.positionY = P.bounceVel;
    if (P.positionY < -0.5) P.positionY = -0.5;
    if (P.positionY > 1.5) { P.positionY = 1.5; P.velocity = 0; }
  }

  // ── where each box goes (GenderLayer.setupRender / setupTransformations) ─
  // In blocks, in the model's own space: y down from the neck, the front of
  // the body towards -z. The holder the boxes hang from makes that so.
  function sideMatrices(st, t) {
    const cfg = st.cfg, b = cfg.breasts;
    const L = st.left, R = cfg.breasts.physics.uniboob ? st.left : st.right;
    const bSize = lerp(t, L.preBreastSize, L.breastSize);
    let breastSize = Math.min(bSize * 1.5, 0.7);
    if (bSize > 0.7) breastSize = bSize;
    if (breastSize < 0.02) return null;
    const zOffset = 0.0625 - bSize * 0.0625;
    breastSize += 0.5 * Math.abs(bSize - 0.7) * 2;

    const offX = round1(b.x), offY = -round1(b.y), offZ = -round1(b.z);
    const uniboob = b.physics.uniboob;
    const outward = Math.min(Math.round(b.cleavage * 100), 10);
    const bounceOn = b.physics.enabled;
    const age = st.age + t;

    const out = {};
    for (const side of ['left', 'right']) {
      const isL = side === 'left';
      const P = isL ? L : R;
      const pY = lerp(t, P.prePositionY, P.positionY);
      const pX = lerp(t, P.prePositionX, P.positionX);
      const rot = lerp(t, P.preBounceRotation, P.bounceRotation);
      const neg = (v) => (isL ? v : -v);
      let M = I();
      if (bounceOn) M = mul(M, T(pX / 32, pY / 32, 0));
      M = mul(M, T(neg(offX) * 0.0625, 0.05625 + offY * 0.0625, zOffset - 0.0625 * 2 + offZ * 0.0425));
      if (!uniboob) M = mul(M, T(neg(-0.0625 * 2), 0, 0));
      if (bounceOn) M = mul(M, RY(rot * DEG));
      if (!uniboob) M = mul(M, T(neg(0.0625 * 2), 0, 0));
      let rotation = breastSize;
      if (bounceOn) {
        M = mul(M, T(0, -0.035 * breastSize, 0));
        rotation -= pY / 12;
      }
      rotation = Math.min(rotation, breastSize + 0.2);
      rotation = Math.min(rotation, 1);
      M = mul(M, RY((isL ? outward : -outward) * DEG));
      M = mul(M, RX(-35 * rotation * DEG));
      // Breathing, while the player is not under water -- which here they
      // never are.
      const f5 = -Math.cos(age * 0.09) * 0.45 + 0.45;
      M = mul(M, RX(f5 * DEG));
      M = mul(M, S(0.9995, 1, 1));
      out[side] = { skin: M, jacket: mul(mul(M, T(0, 0, -0.015)), S(1.05, 1.05, 1.05)) };
    }
    return out;
  }

  // ── the boxes (WildfireModelRenderer.ModelBox), in blocks ────────────────
  function boxGeometry(C, x0, layout) {
    const s = 1 / 16;
    const x = x0 * s, f = (x0 + BOX.w) * s, y = 0, f1 = BOX.h * s, z = 0, f2 = BOX.d * s;
    const v = [[f, y, z], [f, f1, z], [x, f1, z], [x, y, f2], [f, y, f2], [f, f1, f2], [x, f1, f2], [x, y, z]];
    const faces = [[v[4], v[0], v[1], v[5]], [v[7], v[3], v[6], v[2]], [v[4], v[3], v[7], v[0]], [v[1], v[2], v[6], v[5]], [v[0], v[7], v[2], v[1]]];
    const pos = [], uv = [];
    let i = 0;
    for (const d of DIRS) {
      const q = layout[d];
      if (q == null) continue;           // the mod skips a missing face without using up a slot
      const fv = faces[i++];
      if (q[0] === 0 && q[1] === 0 && q[2] === 0 && q[3] === 0) continue;
      const [u1, v1, u2, v2] = q;
      const tex = [[u2, v1], [u1, v1], [u1, v2], [u2, v2]].map(([u, w]) => [u / 64, 1 - w / 64]);
      for (const k of [0, 1, 2, 0, 2, 3]) { pos.push(...fv[k]); uv.push(...tex[k]); }
    }
    const g = new C.BufferGeometry();
    g.setAttribute('position', new C.Attr(new Float32Array(pos), 3));
    g.setAttribute('uv', new C.Attr(new Float32Array(uv), 2));
    g.computeVertexNormals();
    return g;
  }

  // three's classes, from the three skinview3d bundles -- there is no other
  // on the page, and a second copy would not mix with this one.
  function classesFrom(viewer) {
    const skin = viewer.playerObject.skin;
    const mesh = skin.body.innerLayer;
    const Box = mesh.geometry.constructor;
    let Group = null;
    for (let K = skin.body.constructor, i = 0; i < 6 && typeof K === 'function'; i++, K = Object.getPrototypeOf(K)) {
      try { const g = new K(); if (g && g.isObject3D && g.children.length === 0) { Group = K; break; } } catch { /* next */ }
    }
    return {
      Mesh: mesh.constructor,
      BufferGeometry: Object.getPrototypeOf(Box),
      Attr: mesh.geometry.getAttribute('position').constructor,
      Group,
    };
  }

  // ── what the figure is doing, read off it ────────────────────────────────
  function readInputs(st) {
    const v = st.viewer, skin = v.playerObject.skin;
    const inp = { motionY: 0, yawDelta: 0, speedSq: 0, walk: 0, pose: 'standing', swing: st.swing };
    try {
      v.camera.updateMatrixWorld();
      skin.body.updateWorldMatrix(true, false);
      const m = skin.body.matrixWorld.elements, c = v.camera.matrixWorldInverse.elements;
      // the body's forward, as the camera sees it
      const fx = m[8], fy = m[9], fz = m[10];
      const cx = c[0] * fx + c[4] * fy + c[8] * fz, cz = c[2] * fx + c[6] * fy + c[10] * fz;
      const yaw = Math.atan2(cx, cz) / DEG;
      if (st.yaw != null) {
        let d = yaw - st.yaw;
        while (d > 180) d -= 360;
        while (d < -180) d += 360;
        inp.yawDelta = d;
      }
      st.yaw = yaw;
      const y = m[13] / 16;
      if (st.y != null) inp.motionY = y - st.y;
      st.y = y;
      inp.speedSq = inp.motionY * inp.motionY;
      // The walk: the game's term is cos(pos * 0.6662 + PI) * 0.5 * speed * 0.5,
      // and its leg is cos(pos * 0.6662) * 1.4 * speed -- so it is the leg.
      const leg = skin.rightLeg ? skin.rightLeg.rotation.x : 0;
      inp.walk = -(leg / 1.4) * 0.25;
      if (skin.body.rotation.x > 0.3) inp.pose = 'crouching';
      // A swing: an arm moving faster than an arm at rest ever does.
      const ra = skin.rightArm ? skin.rightArm.rotation.x : 0, la = skin.leftArm ? skin.leftArm.rotation.x : 0;
      const dr = st.ra == null ? 0 : Math.abs(ra - st.ra), dl = st.la == null ? 0 : Math.abs(la - st.la);
      st.ra = ra; st.la = la;
      const sw = st.swing;
      if (Math.max(dr, dl) > 0.35 && !sw.isSwinging) { sw.isSwinging = true; sw.tick = 0; sw.arm = dr >= dl ? 'right' : 'left'; }
      else if (sw.isSwinging) { sw.tick++; if (sw.tick >= sw.duration) { sw.isSwinging = false; sw.tick = 0; } }
    } catch { /* a still with no camera yet: standing still */ }
    return inp;
  }

  function tick(st) {
    st.tickCount++;
    st.age++;
    const inp = readInputs(st);
    tickPhysics(st.left, st.cfg, inp, st.tickCount);
    if (!st.cfg.breasts.physics.uniboob) tickPhysics(st.right, st.cfg, inp, st.tickCount);
  }

  // Standing still long enough for everything to come to rest, which is what
  // a still render shows and where a live one starts.
  function settle(st) {
    const still = { motionY: 0, yawDelta: 0, speedSq: 0, walk: 0, pose: 'standing', swing: { isSwinging: false, tick: 0, duration: 6, arm: 'right', amplifier: 0, xAmplifier: 1 } };
    for (let i = 0; i < 80; i++) {
      st.tickCount++;
      tickPhysics(st.left, st.cfg, still, st.tickCount);
      tickPhysics(st.right, st.cfg, still, st.tickCount);
    }
  }

  function build(st) {
    const C = st.C, skin = st.viewer.playerObject.skin;
    if (st.holder) { try { st.holder.parent.remove(st.holder); } catch { } }
    const holder = new C.Group();
    // The neck, turned so that inside it is the game's model space.
    holder.position.set(0, 6, 0);
    holder.rotation.x = Math.PI;
    holder.scale.set(16, 16, 16);
    const inner = skin.layer1Material.clone(); inner.side = 2;
    const outer = skin.layer2Material.clone(); outer.side = 2;
    const uvs = st.cfg.uvs;
    const mk = (geo, mat) => { const m = new C.Mesh(geo, mat); m.matrixAutoUpdate = false; holder.add(m); return m; };
    st.meshes = {
      left: { skin: mk(boxGeometry(C, -4, uvs.skin.left), inner), jacket: mk(boxGeometry(C, -4, uvs.overlay.left), outer) },
      right: { skin: mk(boxGeometry(C, 0, uvs.skin.right), inner), jacket: mk(boxGeometry(C, 0, uvs.overlay.right), outer) },
    };
    st.mats = { inner, outer };
    skin.body.add(holder);
    st.holder = holder;
  }

  function place(st, t) {
    if (!st.holder) return;
    const skin = st.viewer.playerObject.skin;
    // The skin's texture, whichever one it is wearing now.
    if (st.mats.inner.map !== skin.layer1Material.map) { st.mats.inner.map = skin.layer1Material.map; st.mats.inner.needsUpdate = true; }
    if (st.mats.outer.map !== skin.layer2Material.map) { st.mats.outer.map = skin.layer2Material.map; st.mats.outer.needsUpdate = true; }
    const m = sideMatrices(st, t);
    st.holder.visible = !!m;
    if (!m) return;
    const jacketOn = !skin.body.outerLayer || skin.body.outerLayer.visible !== false;
    for (const side of ['left', 'right']) {
      st.meshes[side].skin.matrix.fromArray(m[side].skin);
      st.meshes[side].jacket.matrix.fromArray(m[side].jacket);
      st.meshes[side].jacket.visible = jacketOn;
      st.meshes[side].skin.matrixWorldNeedsUpdate = true;
      st.meshes[side].jacket.matrixWorldNeedsUpdate = true;
    }
  }

  const attached = new Set();

  async function refresh(st) {
    let r = null;
    // Settings handed over directly (devtools, tests) rather than asked for.
    if (st.who && st.who.config) r = { config: st.who.config };
    else if (!ipcRenderer) return;
    else { try { r = await ipcRenderer.invoke('gender:get', st.who); } catch { r = null; } }
    const cfg = r && r.config;
    const sig = JSON.stringify(cfg);
    if (sig === st.sig) return;
    st.sig = sig;
    if (!cfg) {
      st.cfg = null;
      if (st.holder) st.holder.visible = false;
    } else {
      st.cfg = cfg;
      st.left = newPhysics(); st.right = newPhysics();
      settle(st);
      build(st);
      place(st, 1);
    }
    // A still is drawn once; draw it again now that there is something to draw.
    try { if (st.isStill) st.viewer.render(); } catch { }
  }

  function attach(viewer, who) {
    if (!viewer || viewer.__gender) return viewer && viewer.__gender && viewer.__gender.ready;
    let C;
    try { C = classesFrom(viewer); } catch { return Promise.resolve(); }
    if (!C.Group) return Promise.resolve();
    const st = {
      viewer, C, who: who || { selected: true }, cfg: null, sig: undefined,
      holder: null, meshes: null, mats: null,
      left: newPhysics(), right: newPhysics(),
      tickCount: 0, age: 0, acc: 0, last: 0, yaw: null, y: null, ra: null, la: null,
      swing: { isSwinging: false, tick: 0, duration: 6, arm: 'right', amplifier: 0, xAmplifier: 1 },
      isStill: false,
    };
    viewer.__gender = st;
    attached.add(st);
    // Every frame the viewer draws, and every still it is asked for, goes
    // through render(): the physics catch up to now there and the boxes are
    // put where they belong for this instant between two ticks.
    const render = viewer.render.bind(viewer);
    viewer.render = function () {
      try {
        if (st.cfg) {
          const now = performance.now();
          if (st.last) st.acc += Math.min(now - st.last, 500);
          st.last = now;
          let n = 0;
          while (st.acc >= TICK_MS && n++ < 10) { tick(st); st.acc -= TICK_MS; }
          if (st.acc >= TICK_MS) st.acc = 0;
          place(st, st.acc / TICK_MS);
        }
      } catch { /* the figure is drawn either way */ }
      return render();
    };
    st.ready = refresh(st);
    return st.ready;
  }

  // A still: the boxes at rest, and the render the caller takes includes them.
  function attachStill(viewer, who) {
    const p = attach(viewer, who);
    if (viewer && viewer.__gender) viewer.__gender.isStill = true;
    return p;
  }

  if (ipcRenderer) {
    try {
      ipcRenderer.on('gender-changed', () => {
        for (const st of [...attached]) {
          if (st.viewer._disposed) { attached.delete(st); continue; }
          refresh(st);
        }
      });
      // A different account is a different player.
      ipcRenderer.on('selected-player-changed', () => {
        for (const st of [...attached]) {
          if (st.viewer._disposed) { attached.delete(st); continue; }
          if (st.who && st.who.selected) refresh(st);
        }
      });
    } catch { /* no events: what was there at the start stays */ }
  }

  window.GenderRender = {
    attach, attachStill,
    // for tests and for poking at it from devtools
    _internals: { newPhysics, tickPhysics, sideMatrices, boxGeometry, settle },
  };
})();
