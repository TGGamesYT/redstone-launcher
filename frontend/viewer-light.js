// Minecraft's lighting, for every player render in the launcher.
//
// skinview3d lights a figure with a strong ambient light and a faint one at
// the camera, so every face comes out nearly as bright as every other: the
// figure reads as flat colour. Anything that sticks out of it -- the Female
// Gender Mod's shapes (gender-render.js), the outer layer of a skin -- then
// disappears into what is behind it.
//
// The game lights an entity with an ambient 0.4 and two directional lights of
// 0.6 each, one from above and in front, one from above and behind (its
// Lighting class: LIGHT0 = (0.2, 1, -0.7), LIGHT1 = (-0.2, 1, 0.7)). A top is
// as bright as it gets, a front a little less, a side and an underside
// clearly darker. That is what this gives every viewer, by wrapping
// skinview3d's SkinViewer once, before any page makes one.
//
// The lights hang off the camera, as the game's do when it draws a player in
// a screen rather than in the world, so the figure is lit the same whichever
// way it is turned to face.
(function () {
  if (typeof window === 'undefined' || !window.skinview3d || window.skinview3d.__lit) return;
  const Orig = window.skinview3d.SkinViewer;
  if (typeof Orig !== 'function') return;

  // As bright as skinview3d's flat light (its ambient is 3) where it counts:
  // a face turned to the viewer. The game's lights give that face 0.4 + 0.6 *
  // 0.56 = 0.74 of full, which at a full of 3 left the whole figure looking
  // dimmed next to the unshaded one -- so full is raised until the front is
  // where it was, and the sides and undersides keep the game's proportions
  // below it. A top goes past full and is simply at its brightest.
  const FRONT = 0.4 + 0.6 * (0.7 / Math.hypot(0.2, 1, 0.7));
  const FULL = 3 / FRONT;
  const AMBIENT = 0.4 * FULL;
  const DIFFUSE = 0.6 * FULL;
  // In the camera's space: x right, y up, z towards the viewer.
  const LIGHTS = [[0.2, 1, 0.7], [-0.2, 1, -0.7]];

  function light(viewer) {
    try {
      viewer.globalLight.intensity = AMBIENT;
      const PointLight = viewer.cameraLight.constructor;
      viewer.cameraLight.intensity = 0;
      for (const [x, y, z] of LIGHTS) {
        // A point light with no falloff, far away, is a directional light
        // for anything the size of a player -- and is a class the bundle
        // already has.
        const l = new PointLight(0xffffff, DIFFUSE, 0, 0);
        const n = Math.hypot(x, y, z);
        l.position.set((x / n) * 1000, (y / n) * 1000, (z / n) * 1000);
        viewer.camera.add(l);
      }
    } catch { /* lit the old way, which is only flatter */ }
  }

  class LitSkinViewer extends Orig {
    constructor(opts) {
      super(opts);
      light(this);
    }
  }
  window.skinview3d.SkinViewer = LitSkinViewer;
  window.skinview3d.__lit = true;
})();
