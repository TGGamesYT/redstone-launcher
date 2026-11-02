// The home page, made of segments.
//
// The page used to be a fixed greeting, a "Continue Playing" list and two
// hard-coded Modrinth rows. Now it draws whatever the layout says, and the
// layout is edited from the page itself — so what is on the home page is the
// user's business rather than the markup's.
//
// A segment is a type and its own settings. The main process holds both the
// layout and the list of types (HOME_TYPES), and the editor's controls are
// built from that list: a new kind of segment is described once in the main
// process and drawn once here, and the editor picks it up without being told
// about it.
(function () {
  const { ipcRenderer, shell } = require('electron');

  let LAYOUT = [];
  let TYPES = [];
  let COLUMNS = 100;
  const MIN_W = 12;        // the narrowest a segment may be made
  let editing = false;
  let profilesCache = [];
  // Every timer and 3D viewer a drawn segment owns, so redrawing the page
  // does not leave a clock ticking into a removed element or a render holding
  // a frame loop on a canvas that has gone.
  let cleanups = [];

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const typeSpec = (type) => TYPES.find(t => t.type === type) || { options: [] };

  function ensureStyle() {
    if (document.getElementById('home-style')) return;
    const s = document.createElement('style');
    s.id = 'home-style';
    s.textContent = `
      /* ── the grid ──
         The page was a single column: segments could only be moved up and
         down, nothing could sit beside anything else, and nothing could be
         made bigger or smaller. It is twelve columns now; each segment says
         how many it spans and, optionally, how tall it is.

         A min-width of 0 on the segments is what stops them being cropped off
         the right at small window sizes -- a grid item's default minimum is
         the width of its contents, so a row of cards refused to narrow and
         simply overflowed instead. */
      /* ── rows ──
         A row is a row, not a consequence of the widths.
         Segments used to be laid out one after another and wrapped when they
         ran out of room, which meant a row could not have a gap in it,
         shrinking one row pulled the next up into it, there was nowhere to
         drop a segment but onto another one, and the right-hand edge was
         whatever happened to be left over.
         Each row is its own hundred-column grid now, and a segment says
         where along it it starts and how many columns it takes. The gutter
         is the segment's own padding rather than a grid gap: a gap would be
         multiplied by ninety-nine and push the page thousands of pixels
         wide, where padding is inside the width, so two halves really are
         two halves. */
      /* The same margin on both sides. <body> insets the page twenty pixels
         on the left and nothing on the right, and the scroller adds another
         twelve on the left only -- so the left gutter was forty-three pixels
         against the right's eleven, which is the shelf between the sidebar
         and where the content started. The scroller's padding is cancelled
         and the right is given the same twenty <body> gives the left. */
      #home-segments { display:flex; flex-direction:column; align-items:stretch;
        margin-left:-12px; padding:14px 20px 40px 0; }
      .hs-rowbox { display:grid; grid-template-columns:repeat(100, 1fr);
        align-items:stretch; }
      .hs { position:relative; box-sizing:border-box; min-width:0;
        grid-column: calc(var(--x, 0) + 1) / span var(--w, 100);
        padding:0 11px 22px;
        display:flex; flex-direction:column;
        /* How big the things inside are drawn, as a multiplier. */
        --s: 1; }
      /* What happens at a segment's edge, and the same answer for all of
         them: the contents stay inside it. Some spilled over -- the player
         render most visibly -- and some were cut off, which looked like two
         different rules because it was.
         NOT overflow:hidden on the segment itself: that clipped the resize
         handles, which is why they sometimes seemed not to be there at all.
         The part that holds the contents clips, and the handles sit outside
         it. */
      .hs > * { max-width:100%; min-width:0; }
      .hs[data-h] > .hs-body, .hs[data-h] > .hs-list, .hs[data-h] > .hs-row,
      .hs[data-h] > .hs-grid, .hs[data-h] > .hs-player { overflow:auto; min-height:0; }
      /* A render is a fixed-size canvas; it is scaled down to the room there
         is rather than hanging over the side of its segment. */
      .hs-player canvas { max-width:100%; height:auto; }
      .hs > h2, .hs > h3 { margin:0 0 10px; }
      .hs-body { min-height:0; flex:1; overflow:auto; }
      .hs-empty { opacity:0.6; font-size:13px; }
      .hs-error { opacity:0.7; font-size:12px; }

      /* Narrow windows: a row stops being a row rather than its segments
         being squeezed to nothing. Each takes the whole width, in order. */
      @media (max-width: 820px) {
        .hs-rowbox { display:flex; flex-direction:column; }
        .hs { grid-column:auto; }
      }

      /* A row of project cards, which scrolls sideways rather than wrapping
         into a block that pushes everything else off the page. */
      .hs-row { display:flex; gap:12px; overflow-x:auto; padding-bottom:6px; }
      /* Cards keep their size. With a minmax(150px, 1fr) track they grew as the
         segment widened and then snapped smaller the moment another column
         fitted -- so making a segment bigger made its contents randomly
         shrink. A fixed track means the size is the inside-size setting and
         nothing else; a wider segment simply holds more of them. */
      .hs-grid { display:grid; grid-template-columns:repeat(auto-fill, calc(170px * var(--s)));
        justify-content:space-between; gap:calc(12px * var(--s)); }
      .hs-grid .hs-card, .hs-grid .hs-tile { flex:none; }
      .hs-card { flex:0 0 calc(170px * var(--s)); width:100%; background:var(--menu-bg); border:1px solid var(--border-dark);
        border-radius:var(--border-radius); padding:calc(10px * var(--s)); cursor:pointer; display:flex;
        flex-direction:column; min-width:0; }
      .hs-card:hover { border-color:var(--base-color); }
      /* Every icon the same size, whatever shape the file is. cover cropped
         non-square art to different-looking sizes; a fixed square box with
         the picture fitted inside it means they all match. */
      .hs-card .ic { width:100%; aspect-ratio:1; border-radius:6px; background:var(--very-dark);
        display:flex; align-items:center; justify-content:center; overflow:hidden; flex:0 0 auto; }
      .hs-card .ic img { width:100%; height:100%; object-fit:contain; image-rendering:auto; display:block; }
      .hs-card .t { font-weight:bold; font-size:calc(13px * var(--s)); margin-top:8px;
        overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .hs-card .d { font-size:calc(11px * var(--s)); opacity:0.7; margin-top:2px;
        display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
      .hs-card .go { margin-top:8px; display:flex; gap:6px; }
      .hs-card .go button { flex:1; padding:5px 6px; font-size:11px; }
      .hs-big { font-variant-numeric:tabular-nums; line-height:1.1; font-weight:bold; }
      .hs-sub { font-size:calc(12px * var(--s)); opacity:0.7; margin-top:4px; }
      .hs-media { width:100%; border-radius:var(--border-radius); background:var(--very-dark); display:block; }
      .hs-list { display:flex; flex-direction:column; gap:6px; }
      .hs-item { display:flex; align-items:center; gap:calc(10px * var(--s)); background:var(--menu-bg);
        border:1px solid var(--border-dark); border-radius:var(--border-radius);
        padding:calc(8px * var(--s)) calc(10px * var(--s)); min-width:0; }
      .hs-item img { width:calc(32px * var(--s)); height:calc(32px * var(--s)); border-radius:4px;
        image-rendering:pixelated; background:var(--very-dark); object-fit:contain; flex:0 0 auto; }
      .hs-item .t { font-size:calc(13px * var(--s)); flex:1; min-width:0; overflow:hidden;
        text-overflow:ellipsis; white-space:nowrap; }
      .hs-item .s { font-size:calc(11px * var(--s)); opacity:0.7; flex:0 0 auto; }
      .hs-item .go { flex:0 0 auto; display:flex; gap:4px; }
      .hs-item .go button { padding:3px 7px; font-size:12px; line-height:1.2; }
      .hs-dot { width:8px; height:8px; border-radius:50%; background:#777; flex:0 0 auto; }
      .hs-dot.on { background:#5ad65a; }
      /* Friends as tiles: a face, a name, and whether they are on. Narrower
         than a project card, since a head and a name is all there is. */
      .hs-faces { grid-template-columns:repeat(auto-fill, calc(92px * var(--s))); }
      .hs-face { position:relative; display:flex; flex-direction:column; align-items:center;
        gap:calc(6px * var(--s)); padding:calc(10px * var(--s)) calc(6px * var(--s));
        background:var(--menu-bg); border:1px solid var(--border-dark);
        border-radius:var(--border-radius); cursor:pointer; min-width:0; }
      .hs-face:hover { border-color:var(--base-color); }
      .hs-face img { width:calc(48px * var(--s)); height:calc(48px * var(--s));
        image-rendering:pixelated; border-radius:6px; background:var(--very-dark); }
      .hs-face .t { font-size:calc(12px * var(--s)); max-width:100%; overflow:hidden;
        text-overflow:ellipsis; white-space:nowrap; }
      .hs-face .hs-dot { position:absolute; top:calc(8px * var(--s)); right:calc(8px * var(--s)); }
      .hs-news { background:var(--menu-bg); border:1px solid var(--border-dark);
        border-radius:var(--border-radius); overflow:hidden; }
      .hs-news .bd { padding:10px 12px; }
      .hs-news img { width:100%; height:calc(120px * var(--s)); object-fit:cover; display:block; background:var(--very-dark); }
      .hs-news h4 { margin:0 0 4px; font-size:calc(13px * var(--s)); }
      .hs-news pre { margin:0; font-size:calc(11.5px * var(--s)); line-height:1.5; white-space:pre-wrap;
        max-height:calc(120px * var(--s)); overflow:hidden; opacity:0.85; font-family:inherit; }
      .hs-news .tag { font-size:calc(10px * var(--s)); text-transform:uppercase; letter-spacing:0.05em; opacity:0.6; }
      .hs-player { display:flex; justify-content:center; }
      .hs-player.left { justify-content:flex-start; }
      .hs-player.right { justify-content:flex-end; }
      .hs-greet { margin:0; font-weight:bold; line-height:1.2; }

      /* ── editing ── */
      /* Bottom RIGHT, and the icon alone. */
      #home-edit { position:fixed; right:18px; bottom:16px; z-index:30; display:flex; gap:8px; align-items:center; }
      #home-edit button { padding:7px 12px; }
      #home-edit button.icon-only { width:40px; height:40px; padding:0; border-radius:50%;
        display:flex; align-items:center; justify-content:center; }
      #home-edit button.icon-only i { font-size:19px; }
      /* The outline sits INSIDE the segment, in a colour of its own.
         It used to be the theme's base colour at 70% -- which on a red theme
         over a red panel is nearly invisible -- offset six pixels OUTSIDE the
         segment, which pushed the right-hand column past the edge of the page
         and made the whole thing scroll sideways while editing. The radius
         went with it, so the dashes looked snipped off at the corners. */
      body.home-editing .hs::before { content:""; position:absolute;
        left:5px; right:5px; top:-4px; bottom:16px;
        outline:2px dashed rgba(255,255,255,0.85);
        background:rgba(0,0,0,0.18); pointer-events:none; z-index:2; }
      body.home-editing .hs-card, body.home-editing .hs-item, body.home-editing .hs-news { pointer-events:none; }
      /* Inside the segment, not above it: at -10px the first row's buttons
         were clipped by the top of the scroller. */
      /* Settings and remove only -- moving is done by holding the segment
         itself, so there is no third little button to aim at. Bigger, too:
         the old ones were a few pixels across. */
      .hs-tools { position:absolute; top:4px; right:16px; display:none; gap:6px; z-index:8; }
      body.home-editing .hs-tools { display:flex; }
      .hs-tools button { width:30px; height:30px; padding:0; line-height:1; font-size:15px;
        display:flex; align-items:center; justify-content:center;
        background:var(--very-dark); border:1px solid rgba(255,255,255,0.35); border-radius:6px; }
      .hs-tools button:hover { border-color:#fff; }
      /* Held anywhere else on a segment: that is how it is moved. */
      body.home-editing .hs { cursor:grab; }
      body.home-editing .hs.dragging { cursor:grabbing; }
      .hs.dragging { opacity:0.4; }
      /* Where it will land if you let go now. A line down the side it will go
         to, or a wash over the whole segment when it will share the row. */
      /* Where it will land, drawn where it will land: a rectangle the size
         and shape of the space it is going into, in the row it is going into.
         A line down somebody's side said "next to this one" and then put it
         on a row of its own, which is not the same thing at all. */
      .hs-slot { grid-column: calc(var(--x, 0) + 1) / span var(--w, 100);
        margin:0 11px 22px; border-radius:var(--border-radius);
        outline:3px dashed #5ad65a; outline-offset:-3px;
        background:rgba(90,214,90,0.12); pointer-events:none; min-height:54px;
        position:relative; z-index:6; }
      .hs-slot::after { content:attr(data-what); position:absolute; top:6px; left:8px;
        font-size:10px; text-transform:uppercase; letter-spacing:0.06em;
        background:#5ad65a; color:#06290b; padding:2px 7px; border-radius:4px; white-space:nowrap; }
      /* A row of its own, between two that are already there. */
      .hs-rowslot { height:0; margin:0; }
      .hs-rowslot .hs-slot { min-height:46px; }

      /* A handle in each corner. The two bottom ones change the height as
         well, the top ones only the width. */
      /* Just INSIDE each corner. Hanging them outside meant a segment with a
         height -- which has to clip its contents -- clipped these too, so
         they simply were not there. */
      .hs-grip { position:absolute; width:18px; height:18px; z-index:7; display:none; }
      body.home-editing .hs-grip { display:block; }
      .hs-grip::before { content:""; position:absolute; inset:3px; border-radius:3px;
        background:#fff; border:2px solid rgba(0,0,0,0.55); }
      .hs-grip.nw { left:4px; top:-5px; cursor:nwse-resize; }
      .hs-grip.ne { right:4px; top:-5px; cursor:nesw-resize; }
      .hs-grip.sw { left:4px; bottom:15px; cursor:nesw-resize; }
      .hs-grip.se { right:4px; bottom:15px; cursor:nwse-resize; }
      .hs-size { position:absolute; left:50%; top:-12px; transform:translateX(-50%); z-index:7;
        font-size:11px; background:var(--base-color); color:#fff; padding:1px 7px;
        border-radius:4px; display:none; white-space:nowrap; }
      .hs.sizing .hs-size { display:block; }

      /* ── the segment picker ──
         It was a wall of icons and paragraphs. Now it is tiles: the icon, the
         name, and the explanation only when you hover one. */
      .he-search { width:100%; box-sizing:border-box; margin-bottom:12px; }
      .he-types { display:grid; grid-template-columns:repeat(auto-fill,minmax(118px,1fr)); gap:10px; }
      .he-type { display:flex; flex-direction:column; align-items:center; justify-content:center;
        gap:8px; text-align:center; padding:16px 8px; min-height:96px;
        border:2px solid var(--border-dark); background:var(--menu-bg);
        border-radius:var(--border-radius); cursor:pointer; transition:var(--smooth-transition); }
      .he-type:hover { border-color:var(--base-color); transform:translateY(-2px); }
      .he-type i { font-size:26px; opacity:0.9; }
      .he-type .n { font-weight:bold; font-size:12px; line-height:1.3; }
      .he-about { min-height:34px; margin-top:12px; font-size:12px; opacity:0.75; line-height:1.5; }
      .he-opt { display:flex; flex-direction:column; gap:4px; margin-bottom:10px; }
      .he-opt label { font-size:12px; opacity:0.8; }
      .he-opt input[type="text"], .he-opt input[type="number"], .he-opt select { width:100%; box-sizing:border-box; }
      .he-opt.row { flex-direction:row; align-items:center; gap:8px; }
      .he-opt.row input { width:auto; margin:0; }
      .he-size { display:flex; gap:14px; flex-wrap:wrap; align-items:flex-end;
        border-top:1px solid var(--border-dark); margin-top:4px; padding-top:12px; }
      .he-size .he-opt { flex:1 1 150px; margin-bottom:0; }
      .he-media { display:flex; gap:8px; align-items:center; }
      .he-media input { flex:1; }
    `;
    document.head.appendChild(s);
  }

  // ── drawing a segment ──────────────────────────────────────────────────────

  const titleOf = (seg, node) => {
    const t = String(seg.title || '').trim();
    if (t) node.appendChild(el('h2', '', t));
  };

  // Opening a project's page, the way the mod browser hands it over.
  function openProject(p) {
    localStorage.setItem('selectedModrinthProject', JSON.stringify({
      project_id: p.id, slug: p.slug, title: p.title, description: p.description,
      icon_url: p.icon, author: p.author, downloads: p.downloads,
    }));
    localStorage.setItem('selectedProjectType', p.kind || 'mod');
    window.location.href = p.provider === 'curseforge' ? 'curseforge_project.html' : 'modrinth_project.html';
  }

  // "Play" on a modpack or a mod means: put it somewhere you can play it.
  //
  // The button the featured rows used to have did nothing useful -- it is
  // meant to make an instance from the thing when you have not got one
  // already, and to open the one you have when you do.
  async function installProject(p) {
    let existing = null;
    try {
      const r = await ipcRenderer.invoke('instance-for-project',
        { id: p.id, slug: p.slug, title: p.title, provider: p.provider });
      existing = r && r.profileId ? r.profileId : null;
    } catch { /* ask the project page instead */ }
    if (existing) { window.location.href = `instances.html?i=${encodeURIComponent(existing)}`; return; }
    // Nothing for it yet, so the project's own page opens with the install
    // flow ready -- that is where making an instance from it lives.
    localStorage.setItem('installIntent', '1');
    openProject(p);
  }

  function projectCard(p, seg) {
    const action = (seg && seg.action) || 'both';
    const card = el('div', 'hs-card');
    const box = el('div', 'ic');
    const img = el('img');
    img.src = p.icon || (window.DEFAULT_ICON || '');
    img.alt = '';
    img.onerror = () => { img.src = window.DEFAULT_ICON || ''; };
    box.appendChild(img);
    card.appendChild(box);
    card.appendChild(el('div', 't', p.title || ''));
    if (action === 'info' || action === 'both') {
      const bits = [];
      if (p.author) bits.push('by ' + p.author);
      if (p.downloads) bits.push(fmtCount(p.downloads) + ' downloads');
      card.appendChild(el('div', 'd', bits.join(' · ')));
    } else {
      card.appendChild(el('div', 'd', p.description || ''));
    }
    if (action === 'play' || action === 'both') {
      const go = el('div', 'go');
      const play = el('button', 'primary');
      play.innerHTML = '<i class="material-icons" style="font-size:13px;vertical-align:middle;">play_arrow</i> Play';
      play.onclick = (e) => { e.stopPropagation(); installProject(p); };
      go.appendChild(play);
      card.appendChild(go);
    }
    card.onclick = () => openProject(p);
    return card;
  }

  const fmtCount = (n) => {
    const v = Number(n) || 0;
    if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
    return String(v);
  };

  // Playtime as somebody would say it: "4h 20m", "3 days, 2h".
  function fmtDuration(ms) {
    const total = Math.max(0, Math.round(Number(ms) || 0) / 1000);
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const mins = Math.floor((total % 3600) / 60);
    if (days) return `${days} day${days === 1 ? '' : 's'}, ${hours}h`;
    if (hours) return `${hours}h ${mins}m`;
    if (mins) return `${mins}m`;
    return `${Math.floor(total)}s`;
  }

  // The greeting, which used to be an <h1> in the markup and so was the one
  // thing on the home page that could not be moved, reworded or removed.
  const GREETINGS = [
    'Hello there!',
    'Greetings, human.',
    'Back for more? Are ya ready?',
    'Systems online.',
    'Ready for action?',
    "What's on the menu today?",
    'Did you bring snacks?',
    "Let's get rolling!",
    'Welcome back, commander!',
    'The redstone awaits your command!',
  ];

  const DRAW = {
    greeting(seg, node) {
      const said = String(seg.text || '').trim()
        || (window.__homeGreeting || (window.__homeGreeting = GREETINGS[Math.floor(Math.random() * GREETINGS.length)]));
      const h = el('h1', 'hs-greet', said);
      h.style.fontSize = (Number(seg.size) || 32) + 'px';
      h.style.textAlign = seg.align || 'left';
      node.appendChild(h);
    },

    recent(seg, node) {
      titleOf(seg, node);
      const grid = (seg.view || 'list') === 'grid';
      const box = el('div', grid ? 'hs-grid' : 'hs-list');
      node.appendChild(box);
      const action = seg.action || 'both';
      const open = (p) => { window.location.href = `instances.html?i=${encodeURIComponent(p.id)}`; };
      const play = async (p) => {
        const who = await ipcRenderer.invoke('get-selected-player');
        if (who == null) { window.location.href = 'players.html'; return; }
        ipcRenderer.send('launch-profile', { profileId: p.id, playerId: who });
        open(p);
      };
      const paint = () => {
        box.innerHTML = '';
        const items = (profilesCache || []).slice(0, Number(seg.count) || 6);
        if (!items.length) {
          const add = el('div', grid ? 'hs-card' : 'hs-item');
          add.appendChild(el('div', 't', 'Make an instance'));
          add.style.cursor = 'pointer';
          add.onclick = () => { window.location.href = 'instances.html?i=NEWINSTANCE'; };
          box.appendChild(add);
          return;
        }
        for (const p of items) {
          if (grid) {
            const card = el('div', 'hs-card');
            const ic = el('div', 'ic');
            const img = el('img');
            if (window.instanceIconInto) window.instanceIconInto(img, p);
            else img.src = window.DEFAULT_ICON || '';
            img.style.imageRendering = 'pixelated';
            ic.appendChild(img);
            card.append(ic, el('div', 't', p.name || ''));
            if (action === 'info' || action === 'both') {
              card.appendChild(el('div', 'd', `${p.version || ''}${p.loader ? ' · ' + p.loader : ''}`));
            }
            if (action === 'play' || action === 'both') {
              const go = el('div', 'go');
              const b = el('button', 'primary');
              b.innerHTML = '<i class="material-icons" style="font-size:13px;vertical-align:middle;">play_arrow</i> Play';
              b.onclick = (e) => { e.stopPropagation(); play(p); };
              go.appendChild(b);
              card.appendChild(go);
            }
            card.style.cursor = 'pointer';
            card.onclick = () => open(p);
            box.appendChild(card);
            continue;
          }
          const row = el('div', 'hs-item');
          row.style.cursor = 'pointer';
          const img = el('img');
          if (window.instanceIconInto) window.instanceIconInto(img, p);
          else img.src = window.DEFAULT_ICON || '';
          row.appendChild(img);
          row.appendChild(el('div', 't', p.name || ''));
          if (action === 'info' || action === 'both') {
            row.appendChild(el('div', 's', `${p.version || ''}${p.loader ? ' · ' + p.loader : ''}`));
          }
          if (action === 'play' || action === 'both') {
            // The play button this list used to have and lost.
            const go = el('div', 'go');
            const b = el('button', 'primary');
            b.title = 'Play';
            b.innerHTML = '<i class="material-icons" style="font-size:14px;vertical-align:middle;">play_arrow</i>';
            b.onclick = (e) => { e.stopPropagation(); play(p); };
            go.appendChild(b);
            row.appendChild(go);
          }
          row.onclick = () => open(p);
          box.appendChild(row);
        }
      };
      paint();
      node._repaint = paint;
    },

    async player(seg, node) {
      titleOf(seg, node);
      const box = el('div', 'hs-player ' + (seg.align || 'center'));
      box.style.flexDirection = 'column';
      box.style.alignItems = seg.align === 'left' ? 'flex-start'
        : seg.align === 'right' ? 'flex-end' : 'center';
      node.appendChild(box);
      const r = await ipcRenderer.invoke('pack:skinChoices');
      const account = r && r.account;
      if (!account) { node.appendChild(el('div', 'hs-empty', 'No account is signed in.')); return; }
      const canvas = el('canvas');
      box.appendChild(canvas);
      const skin = await ipcRenderer.invoke('head:skin', {
        uuid: account.uuid, name: account.name, offline: account.offline,
        playerId: account.offline ? account.id : null,
      });
      if (!skin || !skin.base64 || typeof skinview3d === 'undefined') {
        canvas.remove();
        const img = el('img');
        img.style.cssText = 'width:96px;height:96px;image-rendering:pixelated;border-radius:6px;';
        if (window.PlayerHead) window.PlayerHead.set(img, { uuid: account.uuid, name: account.name, size: 96 });
        box.appendChild(img);
        return;
      }
      // The inside-size setting did nothing here: the render was whatever
      // the height option said and no more. It is a multiplier on that, the
      // same as everything else inside a segment.
      const scale = (Number(seg.scale) || 100) / 100;
      const h = Math.round(Math.max(120, Math.min(700, Number(seg.height) || 320)) * scale);
      const v = new skinview3d.SkinViewer({ canvas, width: Math.round(h * 0.6), height: h });
      v.zoom = 0.9;
      v.autoRotate = !!seg.spin;
      // Whether it can be turned by hand. Some people want a picture, not a
      // toy that spins off-centre the moment the mouse crosses it.
      const movable = seg.movable !== false;
      try {
        v.controls.enabled = movable;
        v.controls.enableRotate = movable;
        v.controls.minPolarAngle = Math.PI / 2 - 0.55;
        v.controls.maxPolarAngle = Math.PI / 2 + 0.55;
        v.controls.enableZoom = false;
      } catch { /* an older bundle */ }
      canvas.style.cursor = movable ? 'grab' : 'default';
      await v.loadSkin('data:image/png;base64,' + skin.base64, { model: skin.slim ? 'slim' : 'default' });
      if (skin.capeUrl) { try { await v.loadCape(skin.capeUrl); } catch { /* no cape */ } }

      // ── it moves like the one on the skins page ──
      //
      // The same physics, out of the same file: let go of mid-turn it keeps
      // going and slows down, and the figure leans and its arms swing with
      // the turn rather than the model simply rotating on the spot. None of
      // that was here -- the render could be dragged and that was all.
      const SA = window.SkinAnimations;
      const physics = seg.physics !== false;
      let phys = null;
      if (movable && physics && SA && SA.orbitPhysics) {
        try {
          // `settle` is whether it finds its way back to facing forward after
          // being left alone, and how long it waits before doing so.
          phys = SA.orbitPhysics(v, {
            returnAfter: seg.settle === false ? Infinity : (Number(seg.settleAfter) || 3500),
          });
          cleanups.push(() => { try { phys.stop(); } catch { /* gone */ } });
        } catch { /* a drag with no weight behind it, then */ }
      }

      // What it is doing. "The skins page's own" is the converted clips that
      // page uses -- it idles, and every so often does something -- and the
      // rest are skinview3d's. An unknown one, or an older bundle, simply
      // leaves it standing.
      const ANIM = {
        idle: 'IdleAnimation', walk: 'WalkingAnimation',
        run: 'RunningAnimation', fly: 'FlyingAnimation',
      };
      const doing = String(seg.animation || 'idle');
      if (doing === 'clips' && SA && SA.conductor) {
        const rand = (lo, hi) => lo + Math.random() * (hi - lo);
        let timer = null;
        const again = () => { clearTimeout(timer); timer = setTimeout(go, rand(20000, 45000)); };
        const cond = SA.conductor(() => again());
        try { v.animation = cond.animation; } catch { /* standing still it is */ }
        const go = () => {
          // Not over somebody turning it, and not in a tab nobody is looking
          // at. Both of those are what made a gesture look wrong.
          const calm = !phys || phys.restingFor() > 6000;
          if (!calm || document.hidden || cond.busy) { again(); return; }
          try { cond.play(SA.clips[SA.randomName()]); } catch { again(); }
        };
        again();
        cleanups.push(() => clearTimeout(timer));
      } else {
        const want = ANIM[doing];
        if (want && typeof skinview3d[want] === 'function') {
          try { v.animation = new skinview3d[want](); } catch { /* standing still it is */ }
        }
      }
      cleanups.push(() => { try { v.dispose(); } catch { /* gone */ } });
      if (seg.showName !== false) box.appendChild(el('div', 'hs-sub', account.name || ''));
    },

    async friends(seg, node) {
      titleOf(seg, node);
      const id = await ipcRenderer.invoke('get-selected-player');
      if (id == null) { node.appendChild(el('div', 'hs-empty', 'Sign in to see your friends.')); return; }
      const loading = el('div', 'hs-empty', 'Loading friends…');
      node.appendChild(loading);
      const r = await ipcRenderer.invoke('friends:list', { accountId: id });
      loading.remove();
      if (!r || !r.success) {
        node.appendChild(el('div', 'hs-error', (r && r.error) || 'Your friends list could not be read.'));
        return;
      }
      let friends = r.friends || [];
      const presence = {};
      try {
        const pr = await ipcRenderer.invoke('friends:presence', { accountId: id });
        for (const [k, v] of Object.entries((pr && pr.presence) || {})) presence[k] = v;
      } catch { /* without it everybody simply shows as offline */ }
      const online = (f) => (presence[String(f.profileId || '').replace(/-/g, '')] || 'OFFLINE') !== 'OFFLINE';
      if (seg.onlineOnly) friends = friends.filter(online);
      friends.sort((a, b) => (online(b) ? 1 : 0) - (online(a) ? 1 : 0));
      if (!friends.length) {
        node.appendChild(el('div', 'hs-empty', seg.onlineOnly ? 'Nobody is online.' : 'No friends yet.'));
        return;
      }
      // A list or tiles. The setting was there and did nothing: this drew a
      // list whichever was chosen.
      const grid = (seg.view || 'list') === 'grid';
      const box = el('div', grid ? 'hs-grid hs-faces' : 'hs-list');
      const open = (f) => {
        // Somebody's own page, the same one the friends list on the players
        // page opens -- clicking a friend here did nothing at all.
        window.location.href = 'players.html?friend=' + encodeURIComponent(f.profileId || f.name || '');
      };
      for (const f of friends.slice(0, Number(seg.count) || 8)) {
        if (grid) {
          const card = el('div', 'hs-face');
          const img = el('img');
          if (window.PlayerHead) window.PlayerHead.set(img, { uuid: f.profileId, name: f.name, size: 64 });
          card.appendChild(img);
          card.appendChild(el('div', 't', f.name || ''));
          card.appendChild(el('div', 'hs-dot' + (online(f) ? ' on' : '')));
          card.onclick = () => open(f);
          box.appendChild(card);
          continue;
        }
        const row = el('div', 'hs-item');
        const img = el('img');
        if (window.PlayerHead) window.PlayerHead.set(img, { uuid: f.profileId, name: f.name, size: 32 });
        row.appendChild(img);
        row.appendChild(el('div', 't', f.name || ''));
        const dot = el('div', 'hs-dot' + (online(f) ? ' on' : ''));
        row.appendChild(dot);
        row.style.cursor = 'pointer';
        row.onclick = () => open(f);
        box.appendChild(row);
      }
      node.appendChild(box);
    },

    async projects(seg, node) {
      titleOf(seg, node);
      const view = seg.view || 'row';
      const row = el('div', view === 'grid' ? 'hs-grid' : view === 'list' ? 'hs-list' : 'hs-row');
      node.appendChild(row);
      row.appendChild(el('div', 'hs-empty', 'Looking…'));
      const r = await ipcRenderer.invoke('home:projects', {
        provider: seg.provider, kind: seg.kind, sort: seg.sort, count: seg.count,
        query: seg.query, gameVersion: seg.gameVersion, loader: seg.loader, categories: seg.categories,
      });
      row.innerHTML = '';
      if (!r || !r.success) {
        row.appendChild(el('div', 'hs-error', (r && r.error) || 'Nothing could be fetched.'));
        return;
      }
      if (!r.hits.length) { row.appendChild(el('div', 'hs-empty', 'Nothing matched that.')); return; }
      if (view === 'list') {
        const action = seg.action || 'both';
        for (const p of r.hits) {
          const item = el('div', 'hs-item');
          item.style.cursor = 'pointer';
          const img = el('img');
          img.src = p.icon || (window.DEFAULT_ICON || '');
          img.style.imageRendering = 'auto';
          item.appendChild(img);
          item.appendChild(el('div', 't', p.title || ''));
          if (action === 'info' || action === 'both') {
            item.appendChild(el('div', 's', fmtCount(p.downloads) + ' downloads'));
          }
          if (action === 'play' || action === 'both') {
            const go = el('div', 'go');
            const b = el('button', 'primary');
            b.title = 'Play';
            b.innerHTML = '<i class="material-icons" style="font-size:14px;vertical-align:middle;">play_arrow</i>';
            b.onclick = (e) => { e.stopPropagation(); installProject(p); };
            go.appendChild(b);
            item.appendChild(go);
          }
          item.onclick = () => openProject(p);
          row.appendChild(item);
        }
        return;
      }
      for (const p of r.hits) row.appendChild(projectCard(p, seg));
    },

    async news(seg, node) {
      titleOf(seg, node);
      const r = await ipcRenderer.invoke('home:news', { count: seg.count });
      if (!r || !r.success) { node.appendChild(el('div', 'hs-error', (r && r.error) || 'The news could not be fetched.')); return; }
      if (!r.items.length) { node.appendChild(el('div', 'hs-empty', 'Nothing yet.')); return; }
      const list = el('div', 'hs-list');
      for (const n of r.items) {
        const box = el('div', 'hs-news');
        const head = el('h4', '', `${n.title}${n.prerelease ? ' (pre-release)' : ''}`);
        box.appendChild(head);
        if (n.at) box.appendChild(el('div', 'hs-sub', new Date(n.at).toLocaleDateString()));
        if (n.body) box.appendChild(el('pre', '', n.body));
        if (n.url) {
          box.style.cursor = 'pointer';
          box.onclick = () => { try { shell.openExternal(n.url); } catch { /* no browser */ } };
        }
        list.appendChild(box);
      }
      node.appendChild(list);
    },

    // One of Mojang's entries, as a card: their picture, what it is, and the
    // opening of what they wrote.
    async _mojang(seg, node, channel, args, emptyText) {
      const r = await ipcRenderer.invoke(channel, args);
      if (!r || !r.success) {
        node.appendChild(el('div', 'hs-error', (r && r.error) || emptyText));
        return;
      }
      if (!r.items.length) { node.appendChild(el('div', 'hs-empty', 'Nothing yet.')); return; }
      const list = el('div', (seg.view || 'list') === 'grid' ? 'hs-grid' : 'hs-list');
      for (const n of r.items) {
        const box = el('div', 'hs-news');
        if (seg.images !== false && n.image) {
          const img = el('img');
          img.src = n.image;
          img.alt = '';
          img.onerror = () => img.remove();
          box.appendChild(img);
        }
        const bd = el('div', 'bd');
        if (n.tag || n.type) bd.appendChild(el('div', 'tag', n.tag || n.type));
        bd.appendChild(el('h4', '', n.title || n.id || ''));
        if (n.at) bd.appendChild(el('div', 'hs-sub', new Date(n.at).toLocaleDateString()));
        if (n.body) bd.appendChild(el('pre', '', n.body));
        box.appendChild(bd);
        if (n.url) {
          box.style.cursor = 'pointer';
          box.onclick = () => { try { shell.openExternal(n.url); } catch { /* no browser */ } };
        }
        list.appendChild(box);
      }
      node.appendChild(list);
    },

    // Mojang's written changelogs rather than a list of version numbers,
    // which is what this segment was and what made it useless: it said 25w14a
    // came out and nothing about what is in it.
    async snapshots(seg, node) {
      titleOf(seg, node);
      await DRAW._mojang(seg, node, 'home:patchnotes',
        { count: seg.count, releasesToo: seg.releasesToo },
        'The changelogs could not be fetched.');
    },

    async mcnews(seg, node) {
      titleOf(seg, node);
      await DRAW._mojang(seg, node, 'home:mcnews',
        { count: seg.count, category: seg.category },
        'The news could not be fetched.');
    },

    clock(seg, node) {
      titleOf(seg, node);
      const big = el('div', 'hs-big');
      big.style.fontSize = (Number(seg.size) || 44) + 'px';
      node.appendChild(big);
      const sub = el('div', 'hs-sub');
      node.appendChild(sub);
      const zone = String(seg.zone || '').trim() || undefined;
      const tick = () => {
        const now = new Date();
        try {
          big.textContent = now.toLocaleTimeString(undefined, {
            timeZone: zone, hour: '2-digit', minute: '2-digit',
            second: seg.seconds ? '2-digit' : undefined, hour12: !!seg.hour12,
          });
          sub.textContent = seg.showDate
            ? now.toLocaleDateString(undefined, { timeZone: zone, weekday: 'long', day: 'numeric', month: 'long' })
              + (zone ? ' · ' + zone : '')
            : (zone || '');
        } catch {
          // An unknown time zone would otherwise throw every second.
          big.textContent = now.toLocaleTimeString();
          sub.textContent = `"${seg.zone}" is not a time zone`;
        }
      };
      tick();
      const t = setInterval(tick, seg.seconds ? 1000 : 15000);
      cleanups.push(() => clearInterval(t));
    },

    countdown(seg, node) {
      const big = el('div', 'hs-big');
      big.style.fontSize = (Number(seg.size) || 36) + 'px';
      const label = el('div', 'hs-sub', seg.title || '');
      node.appendChild(big);
      node.appendChild(label);
      const target = Date.parse(String(seg.target || '').replace(' ', 'T'));
      if (!Number.isFinite(target)) {
        big.textContent = '—';
        label.textContent = seg.target ? `"${seg.target}" is not a date` : 'Set a date for this countdown.';
        return;
      }
      const tick = () => {
        const left = target - Date.now();
        if (left <= 0) { big.textContent = seg.afterText || "It's here"; return; }
        const s = Math.floor(left / 1000);
        const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
        const m = Math.floor((s % 3600) / 60), ss = s % 60;
        big.textContent = d
          ? `${d}d ${h}h ${m}m`
          : `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
      };
      tick();
      const t = setInterval(tick, 1000);
      cleanups.push(() => clearInterval(t));
    },

    async playtime(seg, node) {
      titleOf(seg, node);
      const one = String(seg.profileId || '').trim();
      const r = await ipcRenderer.invoke('playtime:get', one ? { profileId: one } : {});
      if (!r || !r.success) { node.appendChild(el('div', 'hs-error', 'Playtime could not be read.')); return; }
      const big = el('div', 'hs-big', fmtDuration(r.total));
      // The one number this segment is for, at the size the segment asks
      // for. It was a fixed thirty-two pixels whatever the inside size said.
      big.style.fontSize = `calc(32px * var(--s))`;
      node.appendChild(big);
      const sessions = r.sessions || 0;
      node.appendChild(el('div', 'hs-sub',
        one
          ? `${sessions} session${sessions === 1 ? '' : 's'}`
          : `across ${sessions} session${sessions === 1 ? '' : 's'}`));
      if (one || !seg.breakdown || !r.instances) return;
      const rows = Object.entries(r.instances)
        .map(([id, v]) => ({ id, ...v }))
        .sort((a, b) => (b.total || 0) - (a.total || 0))
        .slice(0, Number(seg.count) || 5);
      if (!rows.length) {
        node.appendChild(el('div', 'hs-empty', 'Nothing played yet.'));
        return;
      }
      const list = el('div', 'hs-list');
      list.style.marginTop = '10px';
      for (const row of rows) {
        const p = (profilesCache || []).find(x => String(x.id) === String(row.id));
        const item = el('div', 'hs-item');
        const img = el('img');
        if (p && window.instanceIconInto) window.instanceIconInto(img, p);
        item.appendChild(img);
        item.appendChild(el('div', 't', (p && p.name) || row.id));
        item.appendChild(el('div', 's', fmtDuration(row.total)));
        if (p) {
          item.style.cursor = 'pointer';
          item.onclick = () => { window.location.href = `instances.html?i=${encodeURIComponent(p.id)}`; };
        }
        list.appendChild(item);
      }
      node.appendChild(list);
    },

    media(seg, node) {
      titleOf(seg, node);
      const src = String(seg.src || '').trim();
      if (!src) { node.appendChild(el('div', 'hs-empty', 'Choose a picture or video for this segment.')); return; }
      const h = Math.max(60, Math.min(800, Number(seg.height) || 220));
      const video = /\.(mp4|webm|ogv|mov)(\?|$)/i.test(src);
      const m = el(video ? 'video' : 'img', 'hs-media');
      m.src = src;
      m.style.height = h + 'px';
      m.style.objectFit = seg.fit || 'cover';
      if (video) {
        m.autoplay = true;
        m.loop = seg.loop !== false;
        m.muted = seg.muted !== false;
        m.playsInline = true;
        m.controls = false;
      } else {
        m.alt = seg.caption || '';
      }
      node.appendChild(m);
      if (seg.caption) node.appendChild(el('div', 'hs-sub', seg.caption));
    },
  };

  // ── the page ───────────────────────────────────────────────────────────────



  // One segment's contents. Each type draws itself; an async one that fails
  // must not take the rest of the page down with it.
  //
  // Anything a segment leaves running -- a clock's timer, a 3D viewer's frame
  // loop -- is collected on the node itself rather than in one list for the
  // whole page, so a single segment can be thrown away and redrawn without
  // stopping everything else.
  function drawInto(node, seg) {
    const mine = [];
    const was = cleanups;
    cleanups = mine;
    try {
      const r = (DRAW[seg.type] || (() => { }))(seg, node);
      if (r && typeof r.catch === 'function') {
        r.catch((e) => {
          node.appendChild(el('div', 'hs-error', 'This segment could not be drawn: ' + (e && e.message || e)));
        });
      }
    } catch (e) {
      node.appendChild(el('div', 'hs-error', 'This segment could not be drawn: ' + (e && e.message || e)));
    } finally {
      cleanups = was;
    }
    node._cleanup = () => { for (const fn of mine) { try { fn(); } catch { /* going anyway */ } } };
  }

  // ── where everything is ─────────────────────────────────────────────────
  //
  // A row is a row. Each segment says which row it is on, where along that
  // row it starts, and how many of the hundred columns it takes. Nothing is
  // worked out from the order any more, which is what makes a gap in a row
  // possible, keeps one row's size from disturbing the next, and gives a
  // drop somewhere to land that is not on top of something else.

  const rowsOf = (layout) => {
    const by = new Map();
    for (const seg of layout) {
      const r = Number(seg.row) || 0;
      if (!by.has(r)) by.set(r, []);
      by.get(r).push(seg);
    }
    return [...by.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([row, segs]) => ({ row, segs: segs.sort((a, b) => (a.x || 0) - (b.x || 0)) }));
  };

  // What is free on a row, as a list of {from, to} column ranges.
  function gapsIn(segs, ignoreId) {
    const taken = segs.filter(s => s.id !== ignoreId).sort((a, b) => (a.x || 0) - (b.x || 0));
    const out = [];
    let at = 0;
    for (const s of taken) {
      const x = s.x || 0;
      if (x > at) out.push({ from: at, to: x });
      at = Math.max(at, x + (s.w || COLUMNS));
    }
    if (at < COLUMNS) out.push({ from: at, to: COLUMNS });
    return out.filter(g => g.to - g.from >= 1);
  }

  // What a segment's CONTENTS depend on. Its size and where it sits are not
  // in here: moving or resizing one does not change what it draws, so it does
  // not have to be drawn again.
  const contentKey = (seg) => {
    const { row, x, w, h, scale, ...rest } = seg;
    return JSON.stringify(rest);
  };

  function drawAll() {
    const host = document.getElementById('home-segments');
    if (!host) return;
    // Where the page was. Rebuilding it used to drop you back at the top,
    // which on a long page is the whole page lost for a change of one size.
    const scroller = host.closest('[data-fit-height]') || host.parentElement;
    const was = scroller ? scroller.scrollTop : 0;

    // Anything already on the page that has not changed is MOVED rather than
    // drawn again. Adding one segment used to reload every other one on the
    // page -- every clock restarted, every row of projects fetched afresh --
    // for a change that touched none of them.
    const keep = new Map();
    for (const node of [...host.querySelectorAll('.hs')]) {
      const seg = LAYOUT.find(x => x.id === node.dataset.id);
      if (seg && node._key === contentKey(seg)) keep.set(seg.id, node);
      else if (node._cleanup) { try { node._cleanup(); } catch { /* going anyway */ } }
    }
    // Only what is NOT being kept is torn down.
    for (const fn of cleanups) { try { fn(); } catch { /* going anyway */ } }
    cleanups = [];
    for (const node of keep.values()) node.remove();
    host.innerHTML = '';

    for (const { row, segs } of rowsOf(LAYOUT)) {
      const box = el('div', 'hs-rowbox');
      box.dataset.row = String(row);
      host.appendChild(box);
      for (const seg of segs) {
        const had = keep.get(seg.id);
        if (had) {
          box.appendChild(had);
          applyOne(had, seg);
          // The handles belong to the editing state, not to the contents.
          if (had._offTools) { try { had._offTools(); } catch { /* fine */ } }
          had._offTools = null;
          for (const n of had.querySelectorAll(':scope > .hs-tools, :scope > .hs-grip, :scope > .hs-size')) n.remove();
          if (editing) addTools(had, seg);
          continue;
        }
        const node = el('section', 'hs');
        node.dataset.id = seg.id;
        node._key = contentKey(seg);
        box.appendChild(node);
        applyOne(node, seg);
        drawInto(node, seg);
        if (editing) addTools(node, seg);
      }
    }
    if (scroller) scroller.scrollTop = was;
  }

  // One segment's width, position, height and content scale. A segment with
  // no height is as tall as its contents, which is how the page has always
  // been.
  function applyOne(node, seg) {
    node.style.setProperty('--x', String(seg.x || 0));
    node.style.setProperty('--w', String(seg.w || COLUMNS));
    node.style.setProperty('--s', String((seg.scale || 100) / 100));
    if (seg.h) { node.style.height = seg.h + 'px'; node.dataset.h = String(seg.h); }
    else { node.style.removeProperty('height'); delete node.dataset.h; }
  }

  // Recent instances are the one segment whose data arrives on its own, from
  // the profile list the page already listens for.
  function setProfiles(list) {
    profilesCache = Array.isArray(list) ? list : [];
    for (const node of document.querySelectorAll('#home-segments .hs')) {
      if (node._repaint) node._repaint();
    }
  }

  // ── editing ────────────────────────────────────────────────────────────────

  // ── moving a segment ────────────────────────────────────────────────────
  //
  // Held, not dragged by a handle: there were three buttons a few pixels
  // across in the corner and one of them started the move.
  //
  // Where it will land is drawn where it will land -- a rectangle the size
  // and shape of the space it is going into, in the row it is going into.
  // A line down a segment's side said "next to this one" and then put the
  // segment on a row of its own, which is not the same thing, and there was
  // no way at all to drop one into an empty space or between two rows.
  //
  // Three things can be under the pointer:
  //
  //   empty space in a row   -- it goes there, narrowed to fit if need be
  //   another segment        -- they share that segment's space, half each
  //   the join between rows  -- a new row of its own, there
  const HOLD_MS = 180;        // how long before a press counts as a move
  let drag = null;            // { id, node, ghost }
  let dropAt = null;          // { row, x, w, newRow, what }

  function clearDropMarks() {
    for (const n of document.querySelectorAll('.hs-slot, .hs-rowslot')) n.remove();
  }

  // Draw the landing place.
  function showDrop(at) {
    clearDropMarks();
    if (!at) return;
    const host = document.getElementById('home-segments');
    if (!host) return;
    const slot = el('div', 'hs-slot');
    slot.style.setProperty('--x', String(at.x));
    slot.style.setProperty('--w', String(at.w));
    slot.dataset.what = at.what;
    if (at.newRow) {
      // Its own row, shown between the two it would go between.
      const box = el('div', 'hs-rowbox hs-rowslot');
      box.appendChild(slot);
      const rows = [...host.querySelectorAll('.hs-rowbox')];
      const before = rows[at.row] || null;
      host.insertBefore(box, before);
      return;
    }
    const box = [...host.querySelectorAll('.hs-rowbox')].find(b => Number(b.dataset.row) === at.row);
    if (box) box.appendChild(slot);
  }

  // What dropping here would mean.
  function dropTarget(e) {
    const host = document.getElementById('home-segments');
    if (!host) return null;
    const me = LAYOUT.find(x => x.id === drag.id);
    if (!me) return null;
    const boxes = [...host.querySelectorAll('.hs-rowbox:not(.hs-rowslot)')];
    if (!boxes.length) return { row: 0, x: 0, w: COLUMNS, newRow: true, what: 'new row' };

    // Near the join between two rows -- or above the first, or below the
    // last -- means a row of its own there.
    const JOIN = 14;
    for (let i = 0; i <= boxes.length; i++) {
      const edge = i === 0
        ? boxes[0].getBoundingClientRect().top
        : boxes[i - 1].getBoundingClientRect().bottom;
      if (Math.abs(e.clientY - edge) <= JOIN) {
        return { row: i, x: 0, w: me.w || COLUMNS, newRow: true, what: 'new row' };
      }
    }

    const box = boxes.find(b => {
      const r = b.getBoundingClientRect();
      return e.clientY >= r.top && e.clientY <= r.bottom;
    });
    if (!box) return null;
    const row = Number(box.dataset.row);
    const r = box.getBoundingClientRect();
    const col = Math.max(0, Math.min(COLUMNS - 1,
      Math.floor(((e.clientX - r.left) / Math.max(1, r.width)) * COLUMNS)));

    const here = LAYOUT.filter(s => (Number(s.row) || 0) === row);
    const onto = here.find(s => s.id !== drag.id && col >= (s.x || 0) && col < (s.x || 0) + (s.w || COLUMNS));

    if (!onto) {
      // Empty space. It goes there, as wide as it is or as wide as the space
      // allows -- a big segment dropped into a small space used to be
      // ignored outright and then spill into the next row.
      const gap = gapsIn(here, drag.id).find(g => col >= g.from && col < g.to);
      if (!gap) return null;
      const room = gap.to - gap.from;
      if (room < MIN_W) return null;
      const w = Math.min(me.w || COLUMNS, room);
      // Lands under the pointer where there is room to, rather than always
      // at the left of the space.
      const x = Math.max(gap.from, Math.min(col - Math.floor(w / 2), gap.to - w));
      return { row, x, w, newRow: false, what: w < (me.w || COLUMNS) ? `fits ${w}%` : 'here' };
    }

    // Onto another segment: they share that segment's space, half each. The
    // side of it the pointer is on decides which half is whose.
    const span = onto.w || COLUMNS;
    if (span < MIN_W * 2) {
      // Too narrow to halve. It takes the whole of it and that one is moved
      // along, which tidyRows on the other side sorts out.
      return { row, x: onto.x || 0, w: span, newRow: false, what: 'swap' };
    }
    const mine = Math.floor(span / 2);
    const left = col < (onto.x || 0) + span / 2;
    const x = left ? (onto.x || 0) : (onto.x || 0) + (span - mine);
    return { row, x, w: mine, newRow: false, what: 'share', onto: onto.id, left };
  }

  function onDragMove(e) {
    if (!drag) return;
    drag.ghost.style.left = (e.clientX - drag.dx) + 'px';
    drag.ghost.style.top = (e.clientY - drag.dy) + 'px';
    const at = dropTarget(e);
    const same = at && dropAt && at.row === dropAt.row && at.x === dropAt.x
      && at.w === dropAt.w && at.newRow === dropAt.newRow;
    if (same) return;
    dropAt = at;
    showDrop(at);
  }

  function endDrag() {
    if (!drag) return;
    const { node, ghost } = drag;
    const landed = dropAt;
    drag = null;
    dropAt = null;
    ghost.remove();
    node.classList.remove('dragging');
    clearDropMarks();
    document.removeEventListener('mousemove', onDragMove, true);
    document.removeEventListener('mouseup', endDrag, true);
    if (!landed) return;
    placeSegment(node.dataset.id, landed);
  }

  function startDrag(node, seg, e) {
    const r = node.getBoundingClientRect();
    const ghost = el('div');
    ghost.style.cssText = `position:fixed;z-index:9500;pointer-events:none;opacity:0.85;
      width:${r.width}px;height:${Math.min(r.height, 220)}px;overflow:hidden;
      border:2px solid #5ad65a;border-radius:var(--border-radius);background:var(--menu-bg);
      box-shadow:0 10px 30px rgba(0,0,0,0.5);`;
    ghost.appendChild(el('div', '', typeSpec(seg.type).name || seg.type));
    ghost.firstChild.style.cssText = 'padding:10px 12px;font-weight:bold;';
    document.body.appendChild(ghost);
    drag = { id: seg.id, node, ghost, dx: e.clientX - r.left, dy: e.clientY - r.top };
    node.classList.add('dragging');
    ghost.style.left = r.left + 'px';
    ghost.style.top = r.top + 'px';
    document.addEventListener('mousemove', onDragMove, true);
    document.addEventListener('mouseup', endDrag, true);
  }

  function addTools(node, seg) {
    const tools = el('div', 'hs-tools');
    const cog = el('button', '', '⚙'); cog.title = 'Settings';
    const rm = el('button', '', '✕'); rm.title = 'Remove';
    cog.onclick = (e) => { e.stopPropagation(); editSegment(seg.id); };
    rm.onclick = (e) => { e.stopPropagation(); removeSegment(seg.id); };
    tools.append(cog, rm);
    node.appendChild(tools);

    // Hold the segment anywhere to move it. A short delay before it counts,
    // so pressing one of the two buttons -- or simply clicking -- is not
    // mistaken for the start of a drag.
    const onDown = (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('.hs-tools') || e.target.closest('.hs-grip')) return;
      const sx = e.clientX, sy = e.clientY;
      let armed = setTimeout(() => { armed = null; startDrag(node, seg, e); }, HOLD_MS);
      const giveUp = () => {
        if (armed) { clearTimeout(armed); armed = null; }
        document.removeEventListener('mouseup', giveUp, true);
        document.removeEventListener('mousemove', maybe, true);
      };
      // Moved far enough before the timer: that is a drag too.
      const maybe = (ev) => {
        if (!armed) return;
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
        clearTimeout(armed); armed = null;
        document.removeEventListener('mouseup', giveUp, true);
        document.removeEventListener('mousemove', maybe, true);
        startDrag(node, seg, ev);
      };
      document.addEventListener('mouseup', giveUp, true);
      document.addEventListener('mousemove', maybe, true);
    };
    node.addEventListener('mousedown', onDown);
    // Kept, so pressing Done can take it off again. It could not before, so
    // every segment was still listening for a hold after editing had ended
    // and could still be dragged about.
    node._offTools = () => node.removeEventListener('mousedown', onDown);

    addGrips(node, seg);
  }

  // Where the dragged segment ends up.
  function placeSegment(fromId, at) {
    const moved = LAYOUT.find(s => s.id === fromId);
    if (!moved || !at) return;

    if (at.newRow) {
      // Everything from that row down moves along to make space.
      for (const s of LAYOUT) if (s !== moved && (Number(s.row) || 0) >= at.row) s.row = (Number(s.row) || 0) + 1;
      moved.row = at.row;
      moved.x = 0;
      moved.w = Math.min(moved.w || COLUMNS, COLUMNS);
      save();
      return;
    }

    if (at.what === 'share' && at.onto) {
      // Half of that segment's space each, in the order the pointer asked
      // for. This is what "drop it next to this one" has to mean: they both
      // end up in the space that one had, not one of them on a new row.
      const onto = LAYOUT.find(s => s.id === at.onto);
      if (onto) {
        const span = onto.w || COLUMNS;
        const from = onto.x || 0;
        const mine = Math.floor(span / 2);
        moved.row = at.row;
        moved.h = onto.h || 0;
        if (at.left) { moved.x = from; moved.w = mine; onto.x = from + mine; onto.w = span - mine; }
        else { onto.w = span - mine; moved.x = from + (span - mine); moved.w = mine; }
        save();
        return;
      }
    }

    moved.row = at.row;
    moved.x = at.x;
    moved.w = at.w;
    save();
  }

  // ── resizing ────────────────────────────────────────────────────────────
  //
  // A handle in each corner. The two on the right move the right-hand edge;
  // the two on the left move the LEFT-hand edge, leaving the right where it
  // is -- which is what dragging a left edge means everywhere else, and what
  // this did not do: a segment on the right of a row was pinned to the left
  // and grew the wrong way.
  //
  // An edge stops where its neighbour is, and nowhere else. It does not have
  // to meet it, so a row can have a gap in it, and the last segment on a row
  // can be taken out to the right-hand edge without the one before it being
  // dragged along.
  function rowOf(seg) {
    const r = Number(seg.row) || 0;
    return LAYOUT.filter(s => (Number(s.row) || 0) === r).sort((a, b) => (a.x || 0) - (b.x || 0));
  }

  function addGrips(node, seg) {
    const readout = el('div', 'hs-size');
    node.appendChild(readout);

    for (const corner of ['nw', 'ne', 'sw', 'se']) {
      const grip = el('div', 'hs-grip ' + corner);
      node.appendChild(grip);
      grip.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const box = node.parentElement;
        const colW = box.clientWidth / COLUMNS;   // one column, in pixels
        const startX = e.clientX, startY = e.clientY;
        const startW = seg.w || COLUMNS;
        const startXc = seg.x || 0;
        const startH = seg.h || node.offsetHeight;
        const east = corner === 'ne' || corner === 'se';
        const south = corner === 'sw' || corner === 'se';
        node.classList.add('sizing');

        // How far this edge may travel: up to the neighbour on that side,
        // and no further. Nothing is pushed and nothing is taken from
        // anybody -- the space between them is simply a space.
        const row = rowOf(seg);
        const i = row.indexOf(seg);
        const leftWall = i > 0 ? (row[i - 1].x || 0) + (row[i - 1].w || COLUMNS) : 0;
        const rightWall = i >= 0 && i < row.length - 1 ? (row[i + 1].x || 0) : COLUMNS;
        const others = row.filter(x => x !== seg);

        const show = (w, h) => { readout.textContent = h ? `${w}% · ${Math.round(h)}px` : `${w}%`; };
        show(startW, seg.h);

        const onMove = (ev) => {
          const dx = (ev.clientX - startX) / colW;
          if (east) {
            const right = Math.round(Math.max(startXc + MIN_W, Math.min(rightWall, startXc + startW + dx)));
            seg.w = right - startXc;
          } else {
            const left = Math.round(Math.max(leftWall, Math.min(startXc + startW - MIN_W, startXc + dx)));
            seg.x = left;
            seg.w = (startXc + startW) - left;
          }
          applyOne(node, seg);

          let h = seg.h;
          if (south || corner === 'nw' || corner === 'ne') {
            const dy = (ev.clientY - startY) * (south ? 1 : -1);
            h = Math.max(80, Math.min(1200, Math.round(startH + dy)));
            seg.h = h;
            // A row of different heights is not a row, so the rest follow --
            // and only the rest of THIS row, which is why the row below no
            // longer creeps up into it.
            for (const o of others) {
              o.h = h;
              const n2 = node.parentElement.querySelector(`.hs[data-id="${o.id}"]`);
              if (n2) applyOne(n2, o);
            }
            applyOne(node, seg);
          }
          show(seg.w, h);
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          node.classList.remove('sizing');
          // Only the numbers changed, and the page is already showing them.
          save({ redraw: false });
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    }
  }

  // Storing the layout does not mean rebuilding the page.
  //
  // Every change -- a resize, a setting, adding one -- redrew every segment,
  // which threw the scroll position away, restarted every clock and fetched
  // every project row again. Only what actually changed is redrawn now.
  //
  //   save()                   -- order or membership changed; redraw
  //   save({ redraw: false })  -- only sizes changed; the page already shows them
  //   save({ only: id })       -- one segment's settings changed
  const save = async (opts = {}) => {
    const r = await ipcRenderer.invoke('home:setLayout', { layout: LAYOUT });
    // Merged INTO the objects already in LAYOUT rather than replacing them.
    //
    // The handles and the settings dialog each hold on to the segment they
    // were given, so swapping the array out from under them left those
    // references pointing at objects no longer on the page -- and a second
    // resize of the same segment went nowhere.
    if (r && r.layout) {
      const byId = new Map(LAYOUT.map(x => [x.id, x]));
      LAYOUT = r.layout.map(x => {
        const had = byId.get(x.id);
        if (!had) return x;
        for (const k of Object.keys(had)) if (!(k in x)) delete had[k];
        return Object.assign(had, x);
      });
    }
    if (opts.redraw === false) { applyGeometry(); return; }
    if (opts.only) { redrawOne(opts.only); applyGeometry(); return; }
    drawAll();
  };

  // The size and position of every segment, without touching what is inside
  // them. Enough on its own whenever nothing moved between rows.
  function applyGeometry() {
    const host = document.getElementById('home-segments');
    if (!host) return;
    // A segment that changed rows cannot be done this way; the page is
    // rebuilt for that.
    for (const seg of LAYOUT) {
      const node = host.querySelector(`.hs[data-id="${seg.id}"]`);
      if (!node) continue;
      const box = node.parentElement;
      if (!box || Number(box.dataset.row) !== (Number(seg.row) || 0)) { drawAll(); return; }
      applyOne(node, seg);
    }
  }

  // One segment's contents, in place.
  //
  // The node is REPLACED rather than emptied. An async segment -- playtime,
  // the news, anything that fetches -- may still be waiting when this runs,
  // and emptying the node it is holding did not stop it: it carried on and
  // appended its contents underneath the new ones, which is why the time
  // played segment drew itself twice. A new node leaves the old draw writing
  // into something nobody can see.
  function redrawOne(id) {
    const host = document.getElementById('home-segments');
    const old = host && host.querySelector(`.hs[data-id="${id}"]`);
    const seg = LAYOUT.find(x => x.id === id);
    if (!old || !seg) return;
    if (old._cleanup) { try { old._cleanup(); } catch { /* going anyway */ } }
    const node = el('section', 'hs');
    node.dataset.id = seg.id;
    node._key = contentKey(seg);
    old.replaceWith(node);
    applyOne(node, seg);
    drawInto(node, seg);
    if (editing) addTools(node, seg);
  }

  function removeSegment(id) {
    LAYOUT = LAYOUT.filter(x => x.id !== id);
    save();
  }

  // Everything a segment leaves behind when editing stops. Without this the
  // page was still listening for a hold on every segment after Done, so they
  // could all still be dragged about.
  function stripTools() {
    for (const node of document.querySelectorAll('#home-segments .hs')) {
      if (node._offTools) { try { node._offTools(); } catch { /* going anyway */ } }
      node._offTools = null;
      for (const n of node.querySelectorAll('.hs-tools, .hs-grip, .hs-size')) n.remove();
    }
    clearDropMarks();
  }

  function overlay(title, bodyBuilder, { wide = false } = {}) {
    const ov = el('div', 'modal-overlay active');
    ov.style.zIndex = 6000;
    const box = el('div', 'modal-content');
    box.style.maxWidth = wide ? '680px' : '460px';
    const head = el('div', 'modal-header');
    head.appendChild(el('h2', '', title));
    const x = el('button', 'modal-close', '✕');
    head.appendChild(x);
    box.appendChild(head);
    const body = el('div');
    box.appendChild(body);
    ov.appendChild(box);
    document.body.appendChild(ov);
    const close = () => ov.remove();
    x.onclick = close;
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
    bodyBuilder(body, box, close);
    return ov;
  }

  // The picker was a wall of icons each with a paragraph beside it. Tiles
  // now: the icon and the name, with the explanation shown once for whichever
  // one you are pointing at, and a box to narrow them down.
  function addSegment() {
    overlay('Add a segment', (body, box, close) => {
      const search = el('input', 'he-search');
      search.type = 'text';
      search.placeholder = 'Search';
      body.appendChild(search);

      const grid = el('div', 'he-types');
      const about = el('div', 'he-about', 'Pick something to put on the page.');
      const tiles = [];
      for (const t of TYPES) {
        const b = el('button', 'he-type');
        b.type = 'button';
        b.innerHTML = `<i class="material-icons">${t.icon || 'widgets'}</i><span class="n"></span>`;
        b.querySelector('.n').textContent = t.name;
        b.title = t.about || '';
        const say = () => { about.textContent = t.about || t.name; };
        b.addEventListener('mouseenter', say);
        b.addEventListener('focus', say);
        b.onclick = () => {
          close();
          // A row of its own at the bottom, which is somewhere definite --
          // without a row of its own a new segment landed wherever the
          // wrapping happened to put it.
          const lastRow = LAYOUT.reduce((n, x) => Math.max(n, Number(x.row) || 0), -1);
          const seg = {
            id: `${t.type}-${Date.now().toString(36)}`, type: t.type,
            row: lastRow + 1, x: 0, w: COLUMNS, h: 0, scale: 100,
          };
          for (const o of t.options || []) seg[o.id] = o.default;
          LAYOUT.push(seg);
          save().then(() => editSegment(seg.id));
        };
        tiles.push({ b, t });
        grid.appendChild(b);
      }
      search.oninput = () => {
        const q = search.value.trim().toLowerCase();
        for (const { b, t } of tiles) {
          const hit = !q || (t.name + ' ' + (t.about || '')).toLowerCase().includes(q);
          b.style.display = hit ? '' : 'none';
        }
      };
      body.append(grid, about);
      setTimeout(() => search.focus(), 0);
    }, { wide: true });
  }

  // The settings for one segment, built from the type's own option list -- so
  // a new option is declared once in the main process and turns up here.
  function editSegment(id) {
    const seg = LAYOUT.find(s => s.id === id);
    if (!seg) return;
    const spec = typeSpec(seg.type);
    overlay(spec.name || seg.type, (body, box, close) => {
      const values = { ...seg };
      for (const o of spec.options || []) {
        const wrap = el('div', 'he-opt' + (o.kind === 'toggle' ? ' row' : ''));
        if (o.kind === 'toggle') {
          const cb = el('input');
          cb.type = 'checkbox';
          cb.checked = !!values[o.id];
          cb.onchange = () => { values[o.id] = cb.checked; };
          wrap.append(cb, el('label', '', o.label));
        } else if (o.kind === 'choice') {
          wrap.appendChild(el('label', '', o.label));
          const sel = el('select');
          for (const c of o.choices || []) {
            const op = el('option', '', c.label);
            op.value = c.value;
            if (String(values[o.id]) === String(c.value)) op.selected = true;
            sel.appendChild(op);
          }
          sel.onchange = () => { values[o.id] = sel.value; };
          wrap.appendChild(sel);
        } else if (o.kind === 'media') {
          wrap.appendChild(el('label', '', o.label));
          const row = el('div', 'he-media');
          const input = el('input');
          input.type = 'text';
          input.value = values[o.id] || '';
          input.placeholder = 'https://… or choose a file';
          input.oninput = () => { values[o.id] = input.value.trim(); };
          const pick = el('button', '', 'Choose…');
          pick.type = 'button';
          pick.onclick = async () => {
            const r = await ipcRenderer.invoke('home:pickMedia');
            if (!r || r.canceled) return;
            if (r.error) { if (window.notify) notify(r.error, 'error'); return; }
            input.value = r.url;
            values[o.id] = r.url;
          };
          row.append(input, pick);
          wrap.appendChild(row);
        } else {
          wrap.appendChild(el('label', '', o.label));
          const input = el('input');
          input.type = o.kind === 'number' ? 'number' : 'text';
          if (o.kind === 'number') {
            if (o.min != null) input.min = o.min;
            if (o.max != null) input.max = o.max;
          }
          input.value = values[o.id] == null ? '' : values[o.id];
          input.oninput = () => {
            values[o.id] = o.kind === 'number' ? (parseInt(input.value, 10) || o.default) : input.value;
          };
          wrap.appendChild(input);
        }
        body.appendChild(wrap);
      }
      // How big it is, which belongs to every type rather than to any one of
      // them -- so it is here rather than in each type's option list. The
      // corner handles write the same two numbers.
      const sizeRow = el('div', 'he-size');
      const wWrap = el('div', 'he-opt');
      wWrap.appendChild(el('label', '', 'Width (% of the page)'));
      const wIn = el('input');
      wIn.type = 'number'; wIn.min = MIN_W; wIn.max = COLUMNS;
      wIn.value = String(values.w || COLUMNS);
      wIn.oninput = () => { values.w = Math.max(MIN_W, Math.min(COLUMNS, parseInt(wIn.value, 10) || COLUMNS)); };
      wWrap.appendChild(wIn);

      const hWrap = el('div', 'he-opt');
      hWrap.appendChild(el('label', '', 'Height in pixels (0 to fit its contents)'));
      const hIn = el('input');
      hIn.type = 'number'; hIn.min = 0; hIn.max = 1200;
      hIn.value = String(values.h || 0);
      hIn.oninput = () => {
        const n = parseInt(hIn.value, 10) || 0;
        values.h = n ? Math.max(80, Math.min(1200, n)) : 0;
      };
      hWrap.appendChild(hIn);

      // How big the things inside are drawn. There was no way to change this
      // at all, and after the page became a grid a list row came out far
      // smaller than it used to be.
      const sWrap = el('div', 'he-opt');
      sWrap.appendChild(el('label', '', 'Size of what is inside (%)'));
      const sIn = el('input');
      sIn.type = 'number'; sIn.min = 50; sIn.max = 220; sIn.step = 5;
      sIn.value = String(values.scale || 100);
      sIn.oninput = () => {
        values.scale = Math.max(50, Math.min(220, parseInt(sIn.value, 10) || 100));
      };
      sWrap.appendChild(sIn);

      sizeRow.append(wWrap, hWrap, sWrap);
      body.appendChild(sizeRow);

      const actions = el('div', 'modal-actions');
      actions.style.marginTop = '12px';
      const ok = el('button', '', 'Done');
      ok.onclick = () => {
        Object.assign(seg, values);
        close();
        // Only this segment changed, so only this one is drawn again.
        save({ only: seg.id });
      };
      actions.appendChild(ok);
      box.appendChild(actions);
    });
  }

  function setEditing(on) {
    editing = !!on;
    document.body.classList.toggle('home-editing', editing);
    const bar = document.getElementById('home-edit');
    if (bar) bar.innerHTML = '';
    if (!bar) return;
    if (editing) {
      const add = el('button', 'primary', 'Add a segment');
      add.onclick = addSegment;
      const reset = el('button', '', 'Start over');
      reset.onclick = async () => {
        const sure = window.uiConfirm
          ? await uiConfirm('Put the home page back the way it came?', { title: 'Start over', ok: 'Start over' })
          : true;
        if (!sure) return;
        const r = await ipcRenderer.invoke('home:resetLayout');
        if (r && r.layout) LAYOUT = r.layout.map(s => ({ ...s }));
        await load();
      };
      const done = el('button', '', 'Done');
      done.onclick = () => setEditing(false);
      bar.append(add, reset, done);
    } else {
      // The icon on its own, bottom right.
      const edit = el('button', 'icon-only');
      edit.title = 'Edit the page';
      edit.innerHTML = '<i class="material-icons">edit</i>';
      edit.onclick = () => setEditing(true);
      bar.appendChild(edit);
    }
    // Only the handles are being put on or taken off, so the segments
    // themselves are left alone -- redrawing them threw away the scroll
    // position every time the edit button was pressed.
    const host = document.getElementById('home-segments');
    if (host) {
      // Off first, listeners and all -- leaving the hold-to-move on was why
      // segments could still be dragged the moment after Done was pressed.
      stripTools();
      if (editing) {
        for (const node of host.querySelectorAll('.hs')) {
          const seg = LAYOUT.find(x => x.id === node.dataset.id);
          if (seg) addTools(node, seg);
        }
      }
    }
  }

  async function load() {
    const r = await ipcRenderer.invoke('home:layout');
    TYPES = (r && r.types) || [];
    COLUMNS = (r && r.columns) || 100;
    LAYOUT = ((r && r.layout) || []).map(s => ({ ...s }));
    drawAll();
  }

  let mounted = false;
  async function mount() {
    ensureStyle();
    if (!document.getElementById('home-edit')) {
      const bar = el('div');
      bar.id = 'home-edit';
      document.body.appendChild(bar);
    }
    await load();
    setEditing(false);
    // Once only: another call would stack a second listener on the same
    // channel and redraw the page twice for every change.
    if (mounted) return;
    mounted = true;
    // Another window changed the layout -- a second launcher window, or the
    // layout being reset.
    ipcRenderer.on('home-layout-changed', (e, layout) => {
      if (!Array.isArray(layout)) return;
      LAYOUT = layout.map(s => ({ ...s }));
      drawAll();
    });
  }

  window.Home = {
    mount, setProfiles, draw: drawAll, fmtDuration, setEditing,
    // Hand it a layout and have it do what a change does: store it, then
    // put on screen only what actually changed. Used by the tests.
    apply: async (layout) => { LAYOUT = layout.map(x => ({ ...x })); await save(); },
  };
})();
