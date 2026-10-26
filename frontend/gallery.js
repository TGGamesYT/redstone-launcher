// A project's gallery, and the viewer you get when you click one.
//
// The gallery was a column of <img max-width:100%> inside the description
// panel: each picture came out whatever size its own file happened to be, so
// a row of them was ragged, none of them used the width that was actually
// available, and clicking one did nothing at all.
//
// Now: a grid of tiles that are all the same size whatever shape the picture
// is, and clicking one opens it full size, zoomable and draggable, with the
// rest of the gallery reachable from the arrow keys.
//
//   Gallery.render(node, [{ url, title, description }])
(function () {
  const MAX_ZOOM = 8;
  const MIN_ZOOM = 1;

  function ensureStyle() {
    if (document.getElementById('gallery-style')) return;
    const s = document.createElement('style');
    s.id = 'gallery-style';
    s.textContent = [
      /* The tiles. auto-fill with a minimum means they grow to use whatever
         width there is rather than sitting at one fixed size, and they stay
         the same size as each other because the box is what is sized, not
         the picture inside it. */
      '.gal-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(240px, 1fr));',
      '  gap:14px; }',
      '.gal-tile { margin:0; cursor:zoom-in; min-width:0; }',
      '.gal-tile .shot { position:relative; aspect-ratio:16/9; border-radius:var(--border-radius);',
      '  overflow:hidden; background:#000; border:1px solid var(--border-dark); }',
      '.gal-tile img { width:100%; height:100%; object-fit:cover; display:block;',
      '  transition:transform 0.25s ease; }',
      '.gal-tile:hover img { transform:scale(1.04); }',
      '.gal-tile:hover .shot { border-color:var(--base-color); }',
      '.gal-tile figcaption { font-size:12px; opacity:0.8; margin-top:6px; line-height:1.4; }',

      /* The viewer. */
      '.gal-view { position:fixed; inset:0; z-index:9000; background:rgba(0,0,0,0.88);',
      '  display:flex; align-items:center; justify-content:center; overscroll-behavior:contain; }',
      '.gal-view img { max-width:94vw; max-height:88vh; display:block; transform-origin:center center;',
      '  cursor:grab; user-select:none; -webkit-user-drag:none; }',
      '.gal-view img.dragging { cursor:grabbing; transition:none; }',
      '.gal-view .gal-x, .gal-view .gal-prev, .gal-view .gal-next {',
      '  position:absolute; background:rgba(0,0,0,0.55); color:#fff; border:1px solid rgba(255,255,255,0.25);',
      '  border-radius:var(--border-radius); cursor:pointer; font-size:20px; line-height:1;',
      '  width:44px; height:44px; display:flex; align-items:center; justify-content:center; }',
      '.gal-view .gal-x { top:16px; right:16px; }',
      '.gal-view .gal-prev { left:16px; top:50%; margin-top:-22px; }',
      '.gal-view .gal-next { right:16px; top:50%; margin-top:-22px; }',
      '.gal-view .gal-bar { position:absolute; left:50%; bottom:16px; transform:translateX(-50%);',
      '  display:flex; gap:8px; align-items:center; background:rgba(0,0,0,0.55);',
      '  border:1px solid rgba(255,255,255,0.25); border-radius:var(--border-radius); padding:6px 10px; }',
      '.gal-view .gal-bar button { background:none; border:none; color:#fff; cursor:pointer;',
      '  font-size:16px; padding:2px 8px; }',
      '.gal-view .gal-bar .gal-zoom { font-size:12px; min-width:48px; text-align:center;',
      '  font-variant-numeric:tabular-nums; }',
      '.gal-view .gal-cap { position:absolute; left:50%; top:16px; transform:translateX(-50%);',
      '  max-width:60vw; text-align:center; font-size:13px; color:#fff; opacity:0.85; }',
    ].join('\n');
    document.head.appendChild(s);
  }

  function open(items, start) {
    let at = start;
    let zoom = 1, panX = 0, panY = 0;

    const view = document.createElement('div');
    view.className = 'gal-view';
    const img = document.createElement('img');
    const cap = document.createElement('div');
    cap.className = 'gal-cap';
    const x = document.createElement('button');
    x.className = 'gal-x'; x.innerHTML = '&times;'; x.title = 'Close';
    const prev = document.createElement('button');
    prev.className = 'gal-prev'; prev.innerHTML = '&lsaquo;'; prev.title = 'Previous';
    const next = document.createElement('button');
    next.className = 'gal-next'; next.innerHTML = '&rsaquo;'; next.title = 'Next';

    const bar = document.createElement('div');
    bar.className = 'gal-bar';
    const out = document.createElement('button'); out.textContent = '−'; out.title = 'Zoom out';
    const pct = document.createElement('span'); pct.className = 'gal-zoom';
    const inn = document.createElement('button'); inn.textContent = '+'; inn.title = 'Zoom in';
    const fit = document.createElement('button'); fit.textContent = 'Fit'; fit.title = 'Back to fitting the window';
    bar.append(out, pct, inn, fit);

    view.append(img, cap, x, prev, next, bar);
    document.body.appendChild(view);

    const apply = () => {
      img.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
      pct.textContent = Math.round(zoom * 100) + '%';
      // Only worth dragging once it is bigger than the window.
      img.style.cursor = zoom > 1 ? 'grab' : 'zoom-in';
    };
    const setZoom = (z, originX, originY) => {
      const was = zoom;
      zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
      if (zoom === 1) { panX = 0; panY = 0; }
      else if (originX != null) {
        // Keep whatever is under the pointer under the pointer.
        const r = img.getBoundingClientRect();
        const cx = originX - (r.left + r.width / 2);
        const cy = originY - (r.top + r.height / 2);
        const k = zoom / was - 1;
        panX -= cx * k;
        panY -= cy * k;
      }
      apply();
    };
    const show = (i) => {
      at = (i + items.length) % items.length;
      const it = items[at];
      img.src = it.url;
      img.alt = it.title || '';
      cap.textContent = items.length > 1
        ? `${at + 1} / ${items.length}${it.title ? ' · ' + it.title : ''}`
        : (it.title || '');
      zoom = 1; panX = 0; panY = 0;
      apply();
    };
    const only = items.length < 2;
    prev.style.display = only ? 'none' : '';
    next.style.display = only ? 'none' : '';

    const close = () => {
      view.remove();
      document.removeEventListener('keydown', onKey, true);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
      else if (e.key === 'ArrowLeft') show(at - 1);
      else if (e.key === 'ArrowRight') show(at + 1);
      else if (e.key === '+' || e.key === '=') setZoom(zoom * 1.3);
      else if (e.key === '-') setZoom(zoom / 1.3);
      else if (e.key === '0') setZoom(1);
      else return;
      e.preventDefault();
    };
    document.addEventListener('keydown', onKey, true);

    x.onclick = close;
    prev.onclick = (e) => { e.stopPropagation(); show(at - 1); };
    next.onclick = (e) => { e.stopPropagation(); show(at + 1); };
    out.onclick = (e) => { e.stopPropagation(); setZoom(zoom / 1.3); };
    inn.onclick = (e) => { e.stopPropagation(); setZoom(zoom * 1.3); };
    fit.onclick = (e) => { e.stopPropagation(); setZoom(1); };

    // Clicking the backdrop closes; clicking the picture zooms in a step.
    view.addEventListener('mousedown', (e) => { if (e.target === view) close(); });
    img.addEventListener('click', (e) => {
      e.stopPropagation();
      if (zoom === 1) setZoom(2, e.clientX, e.clientY);
    });
    view.addEventListener('wheel', (e) => {
      e.preventDefault();
      setZoom(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX, e.clientY);
    }, { passive: false });

    // Dragging a zoomed picture about.
    let from = null;
    img.addEventListener('mousedown', (e) => {
      if (zoom <= 1) return;
      e.preventDefault();
      from = { x: e.clientX - panX, y: e.clientY - panY };
      img.classList.add('dragging');
    });
    const onMove = (e) => {
      if (!from) return;
      panX = e.clientX - from.x;
      panY = e.clientY - from.y;
      apply();
    };
    const onUp = () => { from = null; img.classList.remove('dragging'); };
    view.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);

    show(start);
    return { close, show };
  }

  function render(node, items) {
    ensureStyle();
    if (!node) return;
    node.innerHTML = '';
    const list = (items || []).filter(i => i && i.url);
    if (!list.length) return;
    const grid = document.createElement('div');
    grid.className = 'gal-grid';
    list.forEach((it, i) => {
      const fig = document.createElement('figure');
      fig.className = 'gal-tile';
      const shot = document.createElement('div');
      shot.className = 'shot';
      const img = document.createElement('img');
      img.src = it.url;
      img.alt = it.title || '';
      img.loading = 'lazy';
      shot.appendChild(img);
      fig.appendChild(shot);
      if (it.title) {
        const cap = document.createElement('figcaption');
        cap.textContent = it.title;
        fig.appendChild(cap);
      }
      fig.onclick = () => open(list, i);
      grid.appendChild(fig);
    });
    node.appendChild(grid);
  }

  window.Gallery = { render, open };
})();
