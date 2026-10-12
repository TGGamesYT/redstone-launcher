/**
 * The icon picker's blocks, items and entities.
 *
 * A jar holds several thousand models and the picker is opened a lot, so
 * nothing here renders anything it does not have to:
 *
 *   - the catalogue is a list of names from the main process, not pictures;
 *   - a cell draws only once it has scrolled into view;
 *   - what it drew is kept on disk, so the second time the picker is opened
 *     the grid fills from the cache with no WebGL at all;
 *   - one viewer does all the drawing, in turn, rather than sixty contexts
 *     fighting over the GPU.
 *
 *   ModelPicker.mount(container, { instanceId, version, onPick })
 *
 * `onPick` is handed a data: URL, the same as every other cell in the picker.
 */
(function () {
  if (window.ModelPicker) return;
  let ipcRenderer = null;
  try { ({ ipcRenderer } = require('electron')); } catch { /* not in the app */ }

  const CELL_PX = 128;          // what a thumbnail is drawn at
  const PAGE = 90;              // how many names to ask for at a time
  const DEBOUNCE = 180;

  // key -> data URL, for this session. The disk cache behind it survives
  // restarts; this one saves even the round trip.
  const memo = new Map();
  const keyOf = (it, state) => `${it.kind}|${it.id}|${state || ''}`;

  // One drawing queue. Two WebGL contexts racing makes both slower, and
  // Chromium starts dropping contexts past a dozen or so.
  const queue = [];
  let working = false;
  function enqueue(fn) {
    return new Promise((res) => {
      queue.push({ fn, res });
      pump();
    });
  }
  async function pump() {
    if (working) return;
    working = true;
    while (queue.length) {
      const job = queue.shift();
      let out = null;
      try { out = await job.fn(); } catch { /* one failed cell is not the grid */ }
      job.res(out);
    }
    working = false;
  }

  // The description a cell was drawn from, kept so that picking it can open
  // the adjust dialog without asking for it all over again.
  const described = new Map();

  async function describe(it, ctx, state) {
    const key = keyOf(it, state);
    if (described.has(key)) return described.get(key);
    const p = it.kind === 'entity'
      ? ipcRenderer.invoke('model:entity', {
        profileId: ctx.instanceId, version: ctx.version, name: it.id.replace(/^entity:/, ''),
      })
      : ipcRenderer.invoke('model:describe', {
        profileId: ctx.instanceId, version: ctx.version, id: it.id, state,
      });
    described.set(key, p);
    return p;
  }

  async function draw(it, ctx, state) {
    const key = keyOf(it, state);
    if (memo.has(key)) return memo.get(key);
    const p = (async () => {
      const desc = await describe(it, ctx, state);
      if (!desc || desc.error) return null;
      const url = await enqueue(() => window.BlockRender.render(desc, {
        size: CELL_PX, rotX: desc.rotX || 0, rotY: desc.rotY || 0, uvlock: !!desc.uvlock,
      }));
      if (url) ipcRenderer.invoke('model:thumbPut', { key, dataUrl: url }).catch(() => { });
      return url;
    })();
    memo.set(key, p);
    return p;
  }

  function cellFor(it, ctx, state) {
    const cell = document.createElement('div');
    cell.className = 'ip-cell';
    cell.title = (it.ns && it.ns !== 'minecraft' ? it.ns + ':' : '') + it.name
      + (state ? ` [${state}]` : '') + (it.kind === 'entity' ? ' (entity)' : '');
    const img = document.createElement('img');
    img.alt = '';
    img.style.cssText = 'padding:2px;object-fit:contain;';
    cell.appendChild(img);
    cell._item = it;
    cell._state = state || '';
    cell.onclick = async () => {
      const url = img.getAttribute('src') || await draw(it, ctx, state);
      if (!url) return;
      // The description comes with it: what is picked here is a model, and
      // the next step is a chance to turn it, size it, and switch off a part
      // the game would not have drawn.
      let desc = null;
      try { desc = await describe(it, ctx, state); } catch { /* the picture will do */ }
      ctx.onPick(url, { desc: desc && !desc.error ? desc : null, item: it, state: state || '' });
    };
    return cell;
  }

  // Draw the cells that are on screen, nearest the top first. An
  // IntersectionObserver rather than a scroll handler, so a cell that is never
  // scrolled to is never drawn.
  function watcher(ctx) {
    let io = null;
    try {
      io = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const cell = e.target;
          io.unobserve(cell);
          const img = cell.querySelector('img');
          if (!img || img.getAttribute('src')) continue;
          draw(cell._item, ctx, cell._state).then(url => {
            if (!url) { cell.remove(); return; }
            img.src = url;
          });
        }
      }, { root: null, rootMargin: '200px' });
    } catch { /* no observer: draw everything */ }
    return io;
  }

  async function prefill(cells) {
    // One round trip for every thumbnail already on disk, before any drawing
    // starts. This is what makes a second visit instant.
    if (!ipcRenderer) return;
    const keys = cells.map(c => keyOf(c._item, c._state));
    let got = {};
    try { got = await ipcRenderer.invoke('model:thumbs', { keys }); } catch { return; }
    for (const c of cells) {
      const k = keyOf(c._item, c._state);
      const url = got[k];
      if (!url) continue;
      memo.set(k, Promise.resolve(url));
      const img = c.querySelector('img');
      if (img && !img.getAttribute('src')) img.src = url;
    }
  }

  function mount(container, opts) {
    const ctx = {
      instanceId: opts.instanceId ?? null,
      version: opts.version || null,
      onPick: opts.onPick || (() => { }),
    };
    container.innerHTML = `
      <div class="mp-bar">
        <input type="text" class="mp-search" placeholder="Search blocks, items and mobs…" />
        <div class="mp-kinds">
          <label><input type="checkbox" data-kind="block" checked> Blocks</label>
          <label><input type="checkbox" data-kind="item" checked> Items</label>
          <label><input type="checkbox" data-kind="entity" checked> Mobs</label>
        </div>
      </div>
      <div class="ip-grid mp-grid"></div>
      <div class="mp-more" style="display:none;"></div>`;
    const search = container.querySelector('.mp-search');
    const grid = container.querySelector('.mp-grid');
    const more = container.querySelector('.mp-more');
    const kindBoxes = [...container.querySelectorAll('.mp-kinds input')];
    let io = watcher(ctx);
    let seq = 0, offset = 0, total = 0, query = '';

    const kinds = () => kindBoxes.filter(b => b.checked).map(b => b.dataset.kind);

    async function load(reset) {
      const mine = ++seq;
      if (reset) {
        offset = 0;
        grid.innerHTML = '';
        if (io) { io.disconnect(); io = watcher(ctx); }
      }
      more.textContent = 'Loading…';
      more.style.display = '';
      let r;
      try {
        r = await ipcRenderer.invoke('model:list', {
          profileId: ctx.instanceId, version: ctx.version,
          query, kinds: kinds(), limit: PAGE, offset,
        });
      } catch { r = null; }
      if (mine !== seq) return;                      // a newer search overtook
      if (!r || r.error || !r.items) {
        more.textContent = (r && r.error) || 'Nothing to show for this version yet.';
        return;
      }
      total = r.total;
      const cells = r.items.map(it => cellFor(it, ctx, ''));
      for (const c of cells) { grid.appendChild(c); if (io) io.observe(c); }
      offset += r.items.length;
      await prefill(cells);
      if (mine !== seq) return;
      if (offset < total) {
        more.style.display = '';
        more.innerHTML = `<button class="mp-moreBtn">Show more (${total - offset} left)</button>`;
        more.querySelector('button').onclick = () => load(false);
      } else {
        more.style.display = total ? 'none' : '';
        if (!total) more.textContent = 'No match.';
      }
    }

    let timer = null;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => { query = search.value.trim(); load(true); }, DEBOUNCE);
    });
    for (const b of kindBoxes) b.addEventListener('change', () => load(true));
    load(true);
    return { reload: () => load(true) };
  }

  function ensureStyle() {
    if (document.getElementById('modelpicker-style')) return;
    const s = document.createElement('style');
    s.id = 'modelpicker-style';
    s.textContent = `
      .mp-bar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin:4px 0 6px; }
      .mp-bar .mp-search { flex:1 1 180px; min-width:140px; margin:0; }
      .mp-kinds { display:flex; gap:10px; font-size:12px; opacity:0.85; }
      .mp-kinds label { display:flex; align-items:center; gap:4px; }
      .mp-kinds input { width:auto; margin:0; }
      /* The picker's own .ip-grid rules cover this when it is mounted there,
         but repeating the essentials means the grid is not at the mercy of
         load order, or of being mounted anywhere else. */
      .mp-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(56px,1fr)); gap:8px;
                 max-height:300px; overflow-y:auto; padding:4px; }
      .mp-grid .ip-cell { width:56px; height:56px; border:2px solid var(--border-dark,#444);
                 border-radius:var(--border-radius,6px); cursor:pointer; display:flex;
                 align-items:center; justify-content:center; background:var(--menu-bg,#222); overflow:hidden; }
      .mp-grid .ip-cell:hover { border-color:var(--accent,#c33); }
      .mp-grid .ip-cell img { width:100%; height:100%; object-fit:contain; }
      .mp-more { font-size:12px; opacity:0.75; text-align:center; padding:6px 0; }
      .mp-more button { margin:0; }`;
    document.head.appendChild(s);
  }

  window.ModelPicker = { mount, ensureStyle, draw, keyOf };
})();
