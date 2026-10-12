/**
 * Draws a Minecraft block or item model as an isometric icon.
 *
 * The main process reads the model out of the instance's assets and flattens it
 * (backend/model-assets.js); this takes that description and makes a picture of
 * it, in the style of the wiki's isometric renders: a true isometric view, the
 * top face lit, the left face at base brightness, the right face shaded.
 *
 *   await BlockRender.render(flat, { size, rotX, rotY, uvlock })  -> data: URL
 *
 * `flat` is { kind: 'elements' | 'layers', elements, textures, layers }, where
 * `textures` maps each key to { url, width, height, frames }.
 *
 * Notes on the format, since they are all places it is easy to get wrong:
 *
 *  - Model space is 0..16 on each axis with the block's origin at its corner,
 *    so the centre is (8,8,8). Elements may stick out past that; nothing here
 *    assumes a 16-cube.
 *  - A face's `uv` is [u1, v1, u2, v2] in 0..16 of the TEXTURE, with v running
 *    DOWNWARD — the opposite of three.js, where v runs up from the bottom.
 *  - An animated texture is a vertical strip of square frames. A still picture
 *    of one is its first frame, i.e. the top 1/frames of the image, which is
 *    folded into the v coordinate rather than cropping the image.
 *  - `rotation` on a face is 0/90/180/270 and turns the texture, not the face.
 *  - Shading is per direction and flat, not a light source: up 1.0, down 0.5,
 *    north/south 0.8, east/west 0.6 — Minecraft's own numbers. The camera is
 *    placed so that +Y is the top, +Z is the left face and +X is the right one,
 *    which is what makes those numbers come out as "top lit, right shaded".
 *    `"shade": false` on a face turns it off, as in the game.
 */
(function () {
  if (window.BlockRender) return;

  let _three = null;
  const loadThree = () => (_three || (_three = import('./three.module.js')));

  // Minecraft's per-direction brightness.
  const SHADE = { up: 1.0, down: 0.5, north: 0.8, south: 0.8, east: 0.6, west: 0.6 };
  // BoxGeometry's material slots, in order: +X, -X, +Y, -Y, +Z, -Z.
  const SLOT_DIR = ['east', 'west', 'up', 'down', 'south', 'north'];
  const DIR_NORMAL = {
    east: [1, 0, 0], west: [-1, 0, 0],
    up: [0, 1, 0], down: [0, -1, 0],
    south: [0, 0, 1], north: [0, 0, -1],
  };
  // Which two model axes a face's default UV comes from, and which way round.
  // Straight out of the format: a north face reads x right-to-left, an east
  // face reads z right-to-left, and so on.
  const DEFAULT_UV = {
    north: (f, t) => [16 - t[0], 16 - t[1], 16 - f[0], 16 - f[1]],
    south: (f, t) => [f[0], 16 - t[1], t[0], 16 - f[1]],
    west: (f, t) => [f[2], 16 - t[1], t[2], 16 - f[1]],
    east: (f, t) => [16 - t[2], 16 - t[1], 16 - f[2], 16 - f[1]],
    up: (f, t) => [f[0], f[2], t[0], t[2]],
    down: (f, t) => [f[0], 16 - t[2], t[0], 16 - f[2]],
  };

  // A zero-thickness element (a plant's crossed planes) would put two faces in
  // exactly the same place and let them fight over which is in front.
  const MIN_THICK = 0.002;

  // A face with a `tintindex` is drawn greyscale and coloured by the game from
  // the biome — grass, leaves, vines, stems. Without a tint, a grass block's
  // top and a patch of short grass come out a dead grey, which is not what
  // anyone means by a picture of grass. There is no biome here, so this is
  // Minecraft's own plains colour, which is what the wiki's renders use too.
  // (Tints that are not foliage — redstone dust, water — are rare enough among
  // blocks that getting those slightly wrong is the better trade.)
  const DEFAULT_TINT = [0x91 / 255, 0xBD / 255, 0x59 / 255];
  // A face says it is tinted by carrying a `tintindex`, and that is the whole
  // test. It used to be gated on the texture being nearly grey as well, which
  // left jungle leaves, water and some of the grasses flatly grey -- they are
  // greyish but not grey enough for the number that had been picked.
  //
  // The one case the model data cannot tell apart is cherry leaves, which
  // inherit `tintindex` from block/leaves and are NOT tinted by the game:
  // every leaf block shares one model file, so there is nothing in it that
  // separates them. A texture that is already properly coloured is therefore
  // left alone -- cherry blossom is pink at 0.33, where jungle leaves are
  // 0.08 and grass is 0.01.
  const TINT_MAX_SATURATION = 0.25;
  const wantsTint = (face, spec, opts, flat) =>
    opts.tint !== false
    && ((face.tintindex != null && face.tintindex >= 0) || (flat && flat.tintAll))
    && !(spec && typeof spec.saturation === 'number' && spec.saturation > TINT_MAX_SATURATION);

  function textureKey(name, textures) {
    // A face's texture is "#key"; the flattened map is already keyed by name
    // with the references resolved, so "#all" means textures.all.
    const k = String(name || '').replace(/^#/, '');
    return textures[k] || null;
  }

  async function makeTexture(THREE, spec, cache) {
    if (!spec || !spec.url) return null;
    if (cache.has(spec.url)) return cache.get(spec.url);
    const p = new Promise((res) => {
      const loader = new THREE.TextureLoader();
      loader.load(spec.url, (t) => {
        // Pixel art, so nothing is interpolated and no mip chain is built —
        // a mipped 16px texture at icon size turns to mush.
        t.magFilter = THREE.NearestFilter;
        t.minFilter = THREE.NearestFilter;
        t.generateMipmaps = false;
        t.colorSpace = THREE.SRGBColorSpace;
        t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
        res(t);
      }, undefined, () => res(null));
    });
    cache.set(spec.url, p);
    return p;
  }

  // Write one face's UVs into a BoxGeometry's uv attribute.
  //
  // The four corners of a box face, in BoxGeometry's vertex order, are
  // top-left, top-right, bottom-left, bottom-right of that face as the format
  // describes it, so [u1,v1] is the first corner and [u2,v2] the last.
  function setFaceUv(uvAttr, slot, uv, rotation, frames) {
    const [u1, v1, u2, v2] = uv;
    const f = Math.max(1, frames || 1);
    // 0..16 -> 0..1, and v flipped because three counts up from the bottom.
    // Dividing v by the frame count keeps it inside the first frame of an
    // animated strip.
    const U = (u) => u / 16;
    const V = (v) => 1 - (v / 16) / f;
    // corners: TL, TR, BR, BL
    let c = [[U(u1), V(v1)], [U(u2), V(v1)], [U(u2), V(v2)], [U(u1), V(v2)]];
    const turns = ((Math.round((rotation || 0) / 90) % 4) + 4) % 4;
    for (let i = 0; i < turns; i++) c = [c[3], c[0], c[1], c[2]];
    // BoxGeometry's per-face vertex order is TL, TR, BL, BR.
    const order = [c[0], c[1], c[3], c[2]];
    const base = slot * 4;
    for (let i = 0; i < 4; i++) uvAttr.setXY(base + i, order[i][0], order[i][1]);
  }

  // The world direction a face ends up pointing, once the element's own
  // rotation has been applied, snapped to the nearest axis — which is what
  // decides its shade.
  function shadedDir(THREE, dir, quat) {
    const n = DIR_NORMAL[dir];
    const v = new THREE.Vector3(n[0], n[1], n[2]).applyQuaternion(quat);
    const a = [Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)];
    const i = a.indexOf(Math.max(...a));
    if (i === 1) return v.y >= 0 ? 'up' : 'down';
    if (i === 0) return v.x >= 0 ? 'east' : 'west';
    return v.z >= 0 ? 'south' : 'north';
  }

  // The box of actually-drawn pixels on a rendered canvas, or null. The canvas
  // is a WebGL one, so it is copied onto a 2d canvas to be read — which needs
  // the renderer's preserveDrawingBuffer, and has it.
  function contentBox(canvas) {
    const n = canvas.width;
    let d;
    try {
      const scratch = document.createElement('canvas');
      scratch.width = n; scratch.height = canvas.height;
      const sx = scratch.getContext('2d', { willReadFrequently: true });
      sx.drawImage(canvas, 0, 0);
      d = sx.getImageData(0, 0, n, canvas.height).data;
    } catch { return null; }
    let minX = n, minY = n, maxX = -1, maxY = -1;
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < n; x++) {
        if (d[(y * n + x) * 4 + 3] < 8) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    return maxX < 0 ? null : { minX, minY, maxX, maxY };
  }

  async function renderElements(THREE, flat, opts) {
    const size = Math.max(16, Math.min(1024, opts.size || 256));
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
    renderer.setClearColor(0x000000, 0);
    renderer.setSize(size, size, false);

    const scene = new THREE.Scene();
    const root = new THREE.Group();
    // Model space is 0..16 with the origin at a corner; put the block's middle
    // at the world origin so rotations turn it about its own centre.
    const inner = new THREE.Group();
    // A block's space is 0..16 with the origin at a corner, so its middle has
    // to be brought to the world origin for rotations to turn it about itself.
    // An entity's is already centred on its own pivot and carries its own
    // transforms, so it is left where it is.
    if (flat.space !== 'entity') inner.position.set(-8, -8, -8);
    root.add(inner);
    scene.add(root);

    // The blockstate variant's rotation. Minecraft turns the model clockwise
    // seen from above for `y`, which is the other way round from three's
    // right-handed Y rotation.
    root.rotation.y = -(opts.rotY || 0) * Math.PI / 180;
    root.rotation.x = -(opts.rotX || 0) * Math.PI / 180;

    const texCache = new Map();
    const disposables = [];
    const elements = Array.isArray(flat.elements) ? flat.elements : [];

    for (const el of elements) {
      const from = (el.from || [0, 0, 0]).map(Number);
      const to = (el.to || [16, 16, 16]).map(Number);
      const dim = [0, 1, 2].map(i => Math.max(MIN_THICK, to[i] - from[i]));
      const geo = new THREE.BoxGeometry(dim[0], dim[1], dim[2]);
      disposables.push(geo);

      const mesh = new THREE.Mesh(geo);
      mesh.position.set(
        from[0] + (to[0] - from[0]) / 2,
        from[1] + (to[1] - from[1]) / 2,
        from[2] + (to[2] - from[2]) / 2,
      );

      // An entity's box comes with a matrix instead — the part tree it hangs
      // off has already been walked and composed, which a single axis and
      // angle could not express.
      let holder = mesh;
      if (Array.isArray(el.transform) && el.transform.length === 16) {
        const g = new THREE.Group();
        g.matrixAutoUpdate = false;
        g.matrix.fromArray(el.transform);
        g.add(mesh);
        holder = g;
      } else if (el.rotation && el.rotation.axis && el.rotation.angle) {
        const o = (el.rotation.origin || [8, 8, 8]).map(Number);
        const g = new THREE.Group();
        g.position.set(o[0], o[1], o[2]);
        mesh.position.sub(new THREE.Vector3(o[0], o[1], o[2]));
        const a = Number(el.rotation.angle) * Math.PI / 180;
        if (el.rotation.axis === 'x') g.rotation.x = a;
        else if (el.rotation.axis === 'y') g.rotation.y = a;
        else g.rotation.z = a;
        // `rescale` stretches the element so a 22.5 or 45 degree rotation still
        // meets its neighbours. 1/cos(angle) is the factor the game uses.
        if (el.rotation.rescale) {
          const k = 1 / Math.cos(Math.abs(a));
          if (el.rotation.axis === 'x') g.scale.set(k, 1, k);
          else if (el.rotation.axis === 'y') g.scale.set(k, 1, k);
          else g.scale.set(1, k, k);
        }
        g.add(mesh);
        holder = g;
      }
      inner.add(holder);
      holder.updateWorldMatrix(true, true);

      const uvAttr = geo.getAttribute('uv');
      const materials = [];
      const worldQuat = new THREE.Quaternion();
      mesh.getWorldQuaternion(worldQuat);

      for (let slot = 0; slot < 6; slot++) {
        const dir = SLOT_DIR[slot];
        const face = (el.faces || {})[dir];
        if (!face) {
          // A face the model does not declare is simply not there.
          const m = new THREE.MeshBasicMaterial({ visible: false });
          materials.push(m); disposables.push(m);
          continue;
        }
        const spec = textureKey(face.texture, flat.textures || {});
        const map = await makeTexture(THREE, spec, texCache);
        const frames = (spec && spec.frames) || 1;

        let uv = Array.isArray(face.uv) && face.uv.length === 4
          ? face.uv.map(Number)
          : DEFAULT_UV[dir](from, to);
        let rot = face.rotation || 0;
        // uvlock keeps a texture world-aligned when the variant turns the
        // model. For the up and down faces under a y rotation that is a turn
        // of the texture the other way, which covers logs, stairs, slabs and
        // most of what it is used for. The x-rotation case is not handled.
        if (opts.uvlock && opts.rotY) {
          if (dir === 'up') rot -= opts.rotY;
          else if (dir === 'down') rot += opts.rotY;
        }
        setFaceUv(uvAttr, slot, uv, rot, frames);

        // `shade` is an ELEMENT property in the format, not a face one —
        // block/cross and block/tinted_cross both turn it off on the element,
        // which is why every plant and sapling came out two shades too dark
        // when only the face was looked at. A face may still override it.
        const shadeOff = face.shade === false || (face.shade === undefined && el.shade === false);
        const shade = shadeOff ? 1 : SHADE[shadedDir(THREE, dir, worldQuat)];
        // The factor is stated in sRGB, not in three's linear working space.
        // `new Color(0.8, 0.8, 0.8)` means 0.8 of LINEAR white, which comes out
        // at 231/255 rather than the 204/255 that "80% brightness" means
        // everywhere else — visibly too pale, and not what the game does.
        // The colour comes with the model: the game keeps a table of which
        // block is coloured from which biome map, and the backend has read
        // the right one out of the jar.
        const t = wantsTint(face, spec, opts, flat) ? (flat.tint || DEFAULT_TINT) : [1, 1, 1];
        const tint = new THREE.Color();
        tint.setRGB(shade * t[0], shade * t[1], shade * t[2], THREE.SRGBColorSpace);
        const m = new THREE.MeshBasicMaterial({
          map: map || null,
          color: tint,
          transparent: true,
          // Cutout rather than blending, which is what leaves, grass and glass
          // panes need; without it their transparent corners punch holes in
          // whatever is behind them.
          alphaTest: 0.02,
          // Front faces only, so a block is not see-through. With both sides
          // drawn, glass and leaves showed the INSIDE of their own far faces
          // through their transparent parts, which reads as a wireframe box
          // rather than a block. A model that needs both sides says so by
          // declaring a face in each direction, which a cross-shaped plant
          // does — those still work, because a zero-thickness element is
          // given a hair of depth and so has two real faces.
          side: opts.doubleSide ? THREE.DoubleSide : THREE.FrontSide,
          depthWrite: true,
        });
        if (!map) m.visible = false;      // a texture that could not be read
        materials.push(m); disposables.push(m);
      }
      uvAttr.needsUpdate = true;
      mesh.material = materials;
    }

    // A true isometric view: an orthographic camera down the (1,1,1) diagonal,
    // which puts the top, the +Z side and the +X side on screen at equal
    // angles. That is also what makes the shading table read as "top lit, left
    // plain, right shaded" — +Z lands on the left of the screen and +X on the
    // right.
    const box = new THREE.Box3().setFromObject(root);
    const centre = box.getCenter(new THREE.Vector3());
    // Far enough out to be outside the model, whatever size it is. A fixed 40
    // units is comfortably outside a 16-unit block and comfortably INSIDE the
    // ender dragon, which is 256 across — the camera ended up in its head, and
    // the near plane cut a hole in the head and the near wing. The frustum is
    // sized from the model too, since an orthographic camera's near and far
    // have to straddle it.
    const radius = Math.max(8, box.getSize(new THREE.Vector3()).length() / 2);
    const dist = radius * 4 + 40;
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, dist * 2 + radius * 4);
    camera.position.copy(centre).add(new THREE.Vector3(dist, dist, dist).multiplyScalar(1 / Math.sqrt(3)));
    camera.up.set(0, 1, 0);
    camera.lookAt(centre);
    camera.updateMatrixWorld();

    // Fit: measure the model's corners in the camera's own frame so the icon
    // is as big as it can be without touching the edge, whatever shape it is.
    const half = (() => {
      const inv = camera.matrixWorldInverse;
      const min = box.min, max = box.max;
      let w = 0, h = 0;
      for (let i = 0; i < 8; i++) {
        const p = new THREE.Vector3(
          (i & 1) ? max.x : min.x,
          (i & 2) ? max.y : min.y,
          (i & 4) ? max.z : min.z,
        ).applyMatrix4(inv);
        w = Math.max(w, Math.abs(p.x));
        h = Math.max(h, Math.abs(p.y));
      }
      return Math.max(w, h, 0.001) * 1.04;   // a hair of margin
    })();
    camera.left = -half; camera.right = half;
    camera.top = half; camera.bottom = -half;
    camera.updateProjectionMatrix();

    renderer.render(scene, camera);

    // Fit to what was actually DRAWN, not to the model's box.
    //
    // A torch, a flower and a patch of grass each fill a 16-cube's worth of
    // geometry while covering a fraction of it in opaque pixels, so fitting the
    // camera to the geometry leaves them as a speck in the middle of an icon.
    // Rather than cropping and blowing up the first render — which would be
    // four times magnified and soft — the alpha box is measured, turned back
    // into camera-space units, and the scene is rendered AGAIN through a
    // frustum that frames it. The second render is at full resolution.
    if (opts.fit !== 'model') {
      const box2 = contentBox(canvas);
      if (box2) {
        const w = box2.maxX - box2.minX + 1, h = box2.maxY - box2.minY + 1;
        const side = Math.max(w, h);
        if (side < size * 0.94) {
          // Pixels -> the camera's own units. x runs left..right over the
          // frustum's width; y runs top..bottom, which is +half down to -half.
          const perPx = (2 * half) / size;
          const cxCam = -half + ((box2.minX + box2.maxX + 1) / 2) * perPx;
          const cyCam = half - ((box2.minY + box2.maxY + 1) / 2) * perPx;
          const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
          const upv = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
          camera.position.add(right.multiplyScalar(cxCam)).add(upv.multiplyScalar(cyCam));
          const half2 = Math.max(0.001, (side * perPx) / 2 * 1.06);
          camera.left = -half2; camera.right = half2;
          camera.top = half2; camera.bottom = -half2;
          camera.updateProjectionMatrix();
          camera.updateMatrixWorld();
          renderer.render(scene, camera);
        }
      }
    }

    let url = null;
    try { url = canvas.toDataURL('image/png'); } catch { /* tainted, somehow */ }

    for (const d of disposables) { try { d.dispose(); } catch { } }
    for (const p of texCache.values()) { try { (await p)?.dispose(); } catch { } }
    try { renderer.dispose(); renderer.forceContextLoss(); } catch { }
    return url;
  }

  // A flat item sprite: layer0 under layer1 under layer2… drawn as-is, which is
  // how the game draws them. No 3D, so no three.js either.
  function renderLayers(flat, opts) {
    const size = Math.max(16, Math.min(1024, opts.size || 256));
    const specs = (flat.layers || []).map(id => (flat.textures || {})[id] || null).filter(Boolean);
    if (!specs.length) return Promise.resolve(null);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const cx = canvas.getContext('2d');
    cx.imageSmoothingEnabled = false;
    return specs.reduce((chain, spec) => chain.then(() => new Promise((res) => {
      const im = new Image();
      im.onload = () => {
        // The first frame only, for an animated item like a clock or compass.
        const side = Math.min(im.naturalWidth, im.naturalHeight / Math.max(1, spec.frames || 1))
          || im.naturalWidth;
        try { cx.drawImage(im, 0, 0, side, side, 0, 0, size, size); } catch { }
        res();
      };
      im.onerror = () => res();
      im.src = spec.url;
    })), Promise.resolve()).then(() => {
      try { return canvas.toDataURL('image/png'); } catch { return null; }
    });
  }

  async function render(flat, opts = {}) {
    if (!flat) return null;
    if (flat.kind === 'layers') return renderLayers(flat, opts);
    if (flat.kind !== 'elements' || !Array.isArray(flat.elements) || !flat.elements.length) return null;
    const THREE = await loadThree();
    return renderElements(THREE, flat, opts);
  }

  window.BlockRender = { render };
})();
