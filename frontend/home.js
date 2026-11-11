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

  // ── where everything is ─────────────────────────────────────────────────
  //
  // One grid for the whole page, and a segment is a rectangle in it: x and w
  // across in hundredths, y and h down in grid rows of UNIT pixels. That is
  // the whole model, and it is the third attempt at it.
  //
  // The first laid segments out in order and wrapped them when they ran out
  // of width, so a row was a consequence rather than a place. The second gave
  // each segment a `row`, and each row its own container and its own grid --
  // which is what every remaining complaint was about, and all for the same
  // reason: a row was a BOX. A segment could not be made taller than the box
  // it was in, so dragging its bottom edge down made the whole box taller and
  // shoved the next one down the page; dragging its top edge up had nowhere
  // to go at all. Two segments could not sit side by side at different
  // heights, because the box was as tall as the taller of them. Dividing a
  // row up and down (`y` and `vh` out of twelve) only moved the problem
  // inside the box: the box was still there, still had to be as tall as its
  // contents, and still could not be shared with the box below it.
  //
  // There are no boxes now. A segment says where it is and nothing is worked
  // out from anything else, so its top edge and its bottom edge are the same
  // kind of thing as its left and its right: each moves until it would run
  // into something, and stops there. Nothing is ever pushed out of the way
  // and nothing closes up behind a segment that moves -- a gap is a gap
  // because somebody left one.
  const UNIT = 22;         // pixels per grid row
  const MIN_H = 3;         // the shortest a segment may be made, in rows
  const MAX_H = 80;
  const MAX_Y = 400;
  const SPARE = 6;         // empty rows kept under the page, to drop into

  const xOf = (s) => Math.max(0, Number(s && s.x) || 0);
  const wOf = (s) => {
    const v = Math.round(Number(s && s.w));
    return Number.isFinite(v) && v > 0 ? Math.max(MIN_W, Math.min(COLUMNS, v)) : COLUMNS;
  };
  const yOf = (s) => Math.max(0, Math.min(MAX_Y, Math.round(Number(s && s.y) || 0)));
  const hOf = (s) => {
    const v = Math.round(Number(s && s.h));
    return Number.isFinite(v) && v > 0 ? Math.max(MIN_H, Math.min(MAX_H, v)) : MIN_H;
  };
  /** A segment as a plain rectangle, which is all the layout rules need. */
  const rectOf = (s) => ({ x: xOf(s), y: yOf(s), w: wOf(s), h: hOf(s) });
  /** Do these two rectangles share any of the grid? */
  const hits = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w
    && a.y < b.y + b.h && b.y < a.y + a.h;
  /** Is this rectangle clear of everything except the segments named? */
  const isFree = (r, ...exceptIds) => !LAYOUT.some(s =>
    !exceptIds.includes(s.id) && hits(rectOf(s), r));
  /**
   * How many rows the page is.
   *
   * With room under it while it is being edited, so there is somewhere to
   * drag a segment to below everything there is -- and without it otherwise,
   * because empty rows at the bottom of the page are a strip of nothing to
   * scroll through for anybody who is only looking at it.
   */
  const pageRows = () =>
    LAYOUT.reduce((most, s) => Math.max(most, yOf(s) + hOf(s)), 0) + (editing ? SPARE : 0);

  // ── snapping ────────────────────────────────────────────────────────────
  //
  // Dragging an edge to a round number, or level with the thing beside it,
  // meant watching a percentage and stopping on it by hand -- a segment one
  // column out of line with the one above is not something you can see while
  // you are dragging and is very visible afterwards. An edge now pulls to
  // the lines that are worth landing on: the halves, thirds and quarters of
  // the page, and every edge anything else in that row already has.
  //
  // Toggleable, and remembered, because a layout that will not sit where it
  // is put is worse than one that needs care.
  const SNAP_TOL = 3;              // columns
  let SNAP = true;
  try { SNAP = localStorage.getItem('homeSnap') !== 'off'; } catch { /* no storage */ }
  const setSnap = (on) => {
    SNAP = !!on;
    try { localStorage.setItem('homeSnap', SNAP ? 'on' : 'off'); } catch { /* no storage */ }
  };
  /** The columns worth landing on: the page's own, and everyone else's. */
  function snapLines(selfId) {
    const lines = new Set([0, COLUMNS, 25, 33, 50, 67, 75]);
    for (const s of LAYOUT) {
      if (s.id === selfId) continue;
      lines.add(xOf(s));
      lines.add(xOf(s) + wOf(s));
    }
    return [...lines];
  }
  /** And the rows worth landing on: every edge anything else already has. */
  function snapRows(selfId) {
    const lines = new Set([0]);
    for (const s of LAYOUT) {
      if (s.id === selfId) continue;
      lines.add(yOf(s));
      lines.add(yOf(s) + hOf(s));
    }
    return [...lines];
  }
  /** Pull a column to the nearest line, if one is close enough. */
  function snapCol(v, lines, tol = SNAP_TOL) {
    if (!SNAP) return v;
    let best = v, near = tol + 1;
    for (const line of lines) {
      const d = Math.abs(line - v);
      if (d < near) { near = d; best = line; }
    }
    return near <= tol ? best : v;
  }
  let editing = false;
  let profilesCache = [];

  // Every timer and 3D viewer a drawn segment owns, so redrawing the page does
  // not leave a clock ticking into a removed element or a render holding a
  // frame loop on a canvas that has gone.
  //
  // Collected on the NODE. It used to be a module-level list that drawInto
  // swapped in and out around the call that draws a segment -- which works for
  // a segment drawn in one go, and not at all for one that awaits. Every
  // `await` in `player` hands control back, drawInto's `finally` puts the
  // page's list back, and the viewer and its timers were then collected
  // against the PAGE rather than against the segment. Two things followed from
  // that, both reported:
  //
  //   - Redrawing the page tore down every cleanup in the list, including
  //     those of segments it was keeping, so a player segment that was never
  //     redrawn had its viewer disposed underneath it. The canvas stayed
  //     exactly as it was -- a still image until the page was reloaded.
  //   - Redrawing ONE segment ran only that node's list, which was empty, so
  //     the old viewer kept its frame loop and its animation next to the new
  //     one's. Two animations on one figure reads as double speed.
  const onGone = (node, fn) => { (node._own || (node._own = [])).push(fn); };

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const typeSpec = (type) => TYPES.find(t => t.type === type) || { options: [] };

  // ── Markdown, for the release notes ──────────────────────────────────────
  //
  // A GitHub release's body is Markdown, and it was being put on the page as
  // preformatted text: headings showed as "## What's new", links as the raw
  // brackets-and-parentheses, and a bulleted list as asterisks. It is the same
  // renderer the mod pages use, at a smaller size so it fits in a segment.
  let _marked = null;
  function ensureMarked() {
    if (window.marked) return Promise.resolve(true);
    if (_marked) return _marked;
    _marked = new Promise((done) => {
      const s = document.createElement('script');
      s.src = 'marked.min.js';
      s.onload = () => done(!!window.marked);
      s.onerror = () => done(false);
      document.head.appendChild(s);
    });
    return _marked;
  }

  // Rendered into `box`, with the plain text standing in until it is. Nothing
  // from a release note gets to run or to navigate this window: scripts and
  // frames are dropped, and a link opens in the browser.
  async function markdownInto(box, text) {
    box.textContent = text;
    if (!await ensureMarked() || !box.isConnected) return;
    try {
      box.innerHTML = window.marked.parse(String(text));
    } catch { return; }
    for (const bad of box.querySelectorAll('script, iframe, object, embed, style, link')) bad.remove();
    for (const a of box.querySelectorAll('a')) {
      const href = a.getAttribute('href') || '';
      a.removeAttribute('href');
      if (!/^https?:/i.test(href)) continue;
      a.style.cursor = 'pointer';
      a.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();          // not the card's "open the release" click
        try { shell.openExternal(href); } catch { /* no browser */ }
      };
    }
  }

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
        margin-left:-12px; padding:0 20px 0 0; }
      /* The breathing room above the first row and below the last is a
         transparent BORDER on the scroller, not padding on the content.
         Padding inside a scroll container is part of what scrolls: with
         fourteen pixels above and forty below, a segment sized to exactly
         fill the page came out fifty-four pixels too tall, so the page became
         scrollable and scrolling it showed nothing but that blank. A border is
         outside the padding box and never scrolls, and because fitheight sizes
         these border-box the room comes off the visible area instead -- so the
         page looks the same and a segment that fills it fits it. */
      /* Nothing below the last row. Forty pixels of it was a strip the page
         could not draw in: a segment sized to the page ended at the top of
         it and was cut off there, with the rest of it only reachable by
         scrolling into blank. The room under the last row is that row's own
         bottom padding, which is inside the segment and so cannot crop it. */
      .home-scroller { border-top:14px solid transparent; }
      /* One grid for the page, not one per row.
         A row used to be a container, and every segment in it was placed in
         that container's own grid. Which meant a segment could not be taller
         than its row, two segments could not sit side by side at different
         heights, and making one taller made the row taller and pushed the
         next one down the page. There is one grid now and a segment is a
         rectangle in it, so there is nothing for its height to be measured
         against and nothing for it to push. */
      #home-segments { display:grid; grid-template-columns:repeat(100, 1fr);
        grid-auto-rows:var(--unit, 22px);
        grid-template-rows:repeat(var(--rows, 1), var(--unit, 22px));
        align-items:stretch; }
      .hs { position:relative; box-sizing:border-box; min-width:0;
        grid-column: calc(var(--x, 0) + 1) / span var(--w, 100);
        grid-row: calc(var(--y, 0) + 1) / span var(--h, 3);
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
      /* Every segment has a height of its own now, so every segment's
         contents have somewhere to overflow and have to be told what to do
         about it. This used to be conditional on a pixel height, which most
         segments did not have. */
      .hs > .hs-body, .hs > .hs-list, .hs > .hs-row,
      .hs > .hs-grid, .hs > .hs-player { overflow:auto; min-height:0; }
      /* A render is a fixed-size canvas; it is scaled down to the room there
         is rather than hanging over the side of its segment. */
      /* Scaled DOWN to fit, never squashed. The player box is a flex column, so
         a canvas taller than the segment was shrunk along the main axis -- its
         height compressed with its width left alone, which is exactly what a
         stretched render looks like. It does not flex, and both limits are
         maxima, so a canvas too big for its space keeps its proportions. */
      .hs-player canvas {
        flex: 0 0 auto;
        max-width: 100%;
        /* skinview3d sets the canvas size inline, so these cannot set it --
           they only stop it being squashed. The segment's own measurement
           does the sizing (see the player segment); object-fit means that
           even mid-resize, before that measurement has been taken, what is
           drawn is letterboxed rather than stretched. */
        object-fit: contain;
      }
      .hs > h2, .hs > h3 { margin:0 0 10px; }
      .hs-body { min-height:0; flex:1; overflow:auto; }
      .hs-empty { opacity:0.6; font-size:13px; }
      .hs-error { opacity:0.7; font-size:12px; }

      /* Narrow windows: the grid stops being a grid rather than its segments
         being squeezed to nothing. Each takes the whole width, down the page
         in the order they are laid out in -- which is what --order says, set
         from the layout, because a flex line has no idea where a segment
         would have been. The height is kept, so a segment that was given one
         still has it. */
      @media (max-width: 820px) {
        #home-segments { display:flex; flex-direction:column; }
        .hs { grid-column:auto; grid-row:auto; order:var(--order, 0);
          height:calc(var(--h, 3) * var(--unit, 22px)); }
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
        border-radius:var(--border-radius);
        padding:max(calc(10px * var(--s)), calc(var(--border-radius, 0px) * 0.6));
        cursor:pointer; display:flex; flex-direction:column; min-width:0; }
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
        padding:calc(8px * var(--s)) max(calc(10px * var(--s)), calc(var(--border-radius, 0px) * 0.6));
        min-width:0; }
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
      /* Far enough in that the rounded corner cannot reach the text. The
         corner radius is a setting and can be large; a fixed twelve pixels
         of padding meant the curve cut the first letter of a heading off at
         anything past about that. The inset follows the radius. */
      .hs-news .bd { padding:max(10px, calc(var(--border-radius, 0px) * 0.75))
        max(12px, calc(var(--border-radius, 0px) * 0.75)); }
      .hs-news img { width:100%; height:calc(120px * var(--s)); object-fit:cover; display:block; background:var(--very-dark); }
      .hs-news h4 { margin:0 0 4px; font-size:calc(13px * var(--s)); }
      .hs-news pre { margin:0; font-size:calc(11.5px * var(--s)); line-height:1.5; white-space:pre-wrap;
        max-height:calc(120px * var(--s)); overflow:hidden; opacity:0.85; font-family:inherit; }
      .hs-news .tag { font-size:calc(10px * var(--s)); text-transform:uppercase; letter-spacing:0.05em; opacity:0.6; }
      /* A release note is Markdown. The mod pages render it full size; here it
         has a segment to fit into, so everything is a size down and the whole
         block is capped and faded out at the bottom rather than cut mid-line.
         The card is a link to the release, so there is more to read either
         way. */
      .hs-news .md { font-size:calc(11.5px * var(--s)); line-height:1.5; opacity:0.85;
        max-height:calc(150px * var(--s)); overflow:hidden; position:relative;
        -webkit-mask-image:linear-gradient(to bottom, #000 calc(100% - 28px), transparent);
        mask-image:linear-gradient(to bottom, #000 calc(100% - 28px), transparent); }
      .hs-news .md > :first-child { margin-top:0; }
      .hs-news .md > :last-child { margin-bottom:0; }
      .hs-news .md h1, .hs-news .md h2, .hs-news .md h3,
      .hs-news .md h4, .hs-news .md h5, .hs-news .md h6 {
        margin:calc(8px * var(--s)) 0 calc(3px * var(--s)); font-size:calc(12px * var(--s));
        text-transform:uppercase; letter-spacing:0.04em; opacity:0.75; }
      .hs-news .md p { margin:0 0 calc(5px * var(--s)); }
      .hs-news .md ul, .hs-news .md ol { margin:0 0 calc(5px * var(--s)); padding-left:1.3em; }
      .hs-news .md li { margin:0 0 calc(2px * var(--s)); }
      .hs-news .md a { color:var(--secondary-color); text-decoration:underline; }
      .hs-news .md code { font-family:monospace; font-size:0.92em;
        background:rgba(0,0,0,0.3); padding:0 3px; border-radius:3px; }
      .hs-news .md pre { max-height:none; margin:0 0 calc(5px * var(--s)); padding:calc(5px * var(--s));
        background:rgba(0,0,0,0.3); border-radius:4px; overflow-x:auto; font-size:0.92em; }
      .hs-news .md pre code { background:none; padding:0; }
      /* Not the card's own cover picture: that one fills the width at a fixed
         height, and a badge inside a release note must not. */
      .hs-news .md img { width:auto; height:auto; max-width:100%; display:inline-block; }
      .hs-news .md hr { border:none; border-top:1px solid var(--border-dark); margin:calc(6px * var(--s)) 0; }
      .hs-news .md blockquote { margin:0 0 calc(5px * var(--s)); padding-left:calc(7px * var(--s));
        border-left:2px solid var(--border-dark); opacity:0.85; }
      .hs-news .md table { border-collapse:collapse; font-size:0.95em; }
      .hs-news .md th, .hs-news .md td { border:1px solid var(--border-dark); padding:1px 4px; }
      /* The render box is a flex COLUMN, so its cross axis is the one that
         runs left to right and its main axis is the one that runs up and
         down. "Where is it in space" across is therefore align-items, which
         the segment sets from the across setting; these used to set
         justify-content from the same setting, which is the up-and-down
         axis -- so asking for a render on the left put it at the TOP, and
         the up-and-down setting, which is what justify-content is for, had
         nothing left to do and appeared to do nothing. It sets it now. */
      .hs-player { display:flex; justify-content:center; }
      .hs[data-va="top"] > .hs-player { justify-content:flex-start; }
      .hs[data-va="middle"] > .hs-player { justify-content:center; }
      .hs[data-va="bottom"] > .hs-player { justify-content:flex-end; }

      /* And for every other kind of segment, whose parts do not grow: the
         block of them sits where it was asked to sit inside the segment. */
      .hs[data-va="top"] { justify-content:flex-start; }
      .hs[data-va="middle"] { justify-content:center; }
      .hs[data-va="bottom"] { justify-content:flex-end; }
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
      /* Nothing inside a segment answers the pointer while the page is being
         edited: a grab is a grab on the SEGMENT. The player render was not on
         this list, so picking a segment up by the figure turned the figure --
         the segment moved and the render span at the same time. */
      body.home-editing .hs-card, body.home-editing .hs-item,
      body.home-editing .hs-news, body.home-editing .hs-player,
      body.home-editing .hs-player canvas, body.home-editing .hs-faces { pointer-events:none; }
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
      /* Where it would land: a darkened area the size and shape of the space
         it is going into. No colour and no label -- a green box with a word
         on it is the launcher talking about itself, where a shadow where the
         thing will be is just the answer. */
      .hs-slot { grid-column: calc(var(--x, 0) + 1) / span var(--w, 100);
        grid-row: calc(var(--y, 0) + 1) / span var(--h, 3);
        margin:0 11px 22px; border-radius:var(--border-radius);
        background:rgba(0,0,0,0.42);
        box-shadow:inset 0 0 0 1px rgba(255,255,255,0.18);
        pointer-events:none; position:relative; z-index:6; }
      /* Nowhere to go: the space is taken and there is no room near it. Said
         with a shape rather than a word, the same as the rest of it. */
      .hs-slot.no { background:rgba(0,0,0,0.18);
        box-shadow:inset 0 0 0 1px rgba(255,120,110,0.55); }

      /* Hold still over a spot and the page shows you what it would do:
         whatever has to move to make room slides to where it would go, at
         half strength, and slides back when you move on. A line and a word
         described it; this performs it. */
      .hs.hs-would { opacity:0.5; transition:opacity 0.18s ease; }

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
      /* A segment's settings used to be one column of every option it has,
         one after another, with the switches among the boxes. They are in
         groups now: what it shows, what it does, and how big it is -- and the
         fields sit two or three across instead of a single stack as long as
         the window. */
      .he-body { max-height:min(62vh, 520px); overflow-y:auto; padding:2px 4px 2px 0; }
      .he-about { margin:0 0 14px; font-size:12px; line-height:1.5; opacity:0.7; }
      .he-group { margin:0 0 16px; }
      .he-group > h4 { margin:0 0 8px; font-size:11px; font-weight:bold;
        text-transform:uppercase; letter-spacing:0.06em; opacity:0.55; }
      .he-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(165px, 1fr));
        gap:10px 14px; align-items:end; }
      .he-grid .he-opt { margin:0; }
      .he-grid .he-opt.wide { grid-column:1 / -1; }
      .he-switches { display:flex; flex-direction:column; gap:3px; }
      .he-switches .he-opt.row { margin:0; padding:7px 9px; cursor:pointer;
        border-radius:var(--border-radius); background:var(--very-dark); }
      .he-switches .he-opt.row:hover { background:color-mix(in srgb, var(--base-color) 20%, var(--very-dark)); }
      .he-switches .he-opt.row label { opacity:1; cursor:pointer; }
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
      const ASPECT = 0.6;              // a player is this much wider than tall

      // How big the render can be in the room there is.
      //
      // skinview3d writes width and height onto the canvas as INLINE styles,
      // which is why the stylesheet could not keep it in proportion: an inline
      // height beats a rule, so capping the width with max-width squashed the
      // width and left the height exactly as it was. That IS the stretching.
      // So the room is measured and the viewer is told, which keeps the render
      // sharp as well -- scaling a canvas down in CSS is a blurry way to do
      // the same thing.
      const wanted = () => {
        let hh = h;
        let ww = Math.round(hh * ASPECT);

        // Across: the room inside the segment. A measurement of zero means
        // the page has not laid this out yet, which is not the same as "no
        // room" -- clamping to it is how the render came out tiny.
        const availW = box.clientWidth || node.clientWidth || 0;
        if (availW > 40 && ww > availW) { ww = Math.floor(availW); hh = Math.round(ww / ASPECT); }

        // Down: measured from the SEGMENT, less whatever else is in it --
        // the heading, the account name -- rather than from the box, which
        // at this point holds one canvas that has not been sized yet and is
        // therefore a few pixels tall. Unconditional now: every segment has
        // a height of its own, where this used to be skipped for the many
        // that were as tall as their contents.
        {
          let availH = node.clientHeight || 0;
          for (const kid of node.children) {
            if (kid === box || kid.classList.contains('hs-tools')
              || kid.classList.contains('hs-grip') || kid.classList.contains('hs-size')) continue;
            availH -= kid.offsetHeight || 0;
          }
          for (const kid of box.children) {
            if (kid === canvas) continue;
            availH -= kid.offsetHeight || 0;
          }
          if (availH > 80 && hh > availH) { hh = Math.floor(availH); ww = Math.round(hh * ASPECT); }
        }
        return { w: Math.max(60, ww), h: Math.max(100, hh) };
      };

      const first = wanted();
      const v = new skinview3d.SkinViewer({ canvas, width: first.w, height: first.h });
      let atW = first.w, atH = first.h;
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

      // Resized, not redrawn. Making a new viewer for a new size is what used
      // to leave the page with a dead canvas and a doubled animation; the
      // existing one is simply told, which also updates the camera's aspect
      // so nothing is squeezed. Only on a real change of size, or the observer
      // would answer its own writes for ever.
      if (typeof ResizeObserver === 'function') {
        // Once it stops moving, not on every step of the way.
        //
        // setSize is not a cheap call: skinview3d resizes the renderer AND
        // reallocates both of the post-processing render targets. Dragging
        // the window's edge reports a new size every frame, so that was two
        // full-size buffers thrown away and made again per frame, which the
        // render cannot keep up with -- so it was blank for most of the
        // drag. CSS holds the canvas inside its segment meanwhile (see
        // .hs-player canvas: max-width and object-fit), so what shows while
        // the window is moving is the render scaled, not a hole.
        //
        // A one-off change still takes effect at once: only a size that is
        // still moving is waited out.
        let settleSoon = null, lastAt = 0;
        const resizeTo = (want) => {
          atW = want.w; atH = want.h;
          try { v.setSize(want.w, want.h); } catch { /* an older bundle */ }
        };
        const ro = new ResizeObserver(() => {
          const want = wanted();
          if (want.w === atW && want.h === atH) return;
          const now = Date.now();
          const moving = now - lastAt < 250;
          lastAt = now;
          if (settleSoon) clearTimeout(settleSoon);
          if (!moving) { resizeTo(want); return; }
          settleSoon = setTimeout(() => {
            settleSoon = null;
            const end = wanted();
            if (end.w !== atW || end.h !== atH) resizeTo(end);
          }, 140);
        });
        ro.observe(node);
        onGone(node, () => {
          try { ro.disconnect(); } catch { /* gone */ }
          if (settleSoon) clearTimeout(settleSoon);
        });
      }

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
      const settles = seg.settle !== false;
      let phys = null;
      // Settling back is not part of the momentum. They were one switch here:
      // with "keep spinning when let go" off there was no physics at all, so
      // "settle back to facing forward" had nothing to act through and did
      // nothing -- and with it on, settling happened whether or not it was
      // asked for, because Infinity is not a finite number of milliseconds and
      // fell through to the default wait.
      if (movable && (physics || settles) && SA && SA.orbitPhysics) {
        try {
          phys = SA.orbitPhysics(v, {
            momentum: physics,
            returnAfter: settles ? (Number(seg.settleAfter) || 3500) : null,
          });
          onGone(node, () => { try { phys.stop(); } catch { /* gone */ } });
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
        onGone(node, () => clearTimeout(timer));
      } else {
        // Whatever it is doing, it still reacts to being turned: the arms
        // trail the turn, the head comes round last, the cape streams. Those
        // live in the conductor, so the clips had them and skinview3d's own
        // animations -- which went on the viewer raw -- did not. Standing
        // still had no animation at all, and therefore no reactions either.
        const want = ANIM[doing];
        let inner = null;
        if (want && typeof skinview3d[want] === 'function') {
          try { inner = new skinview3d[want](); } catch { inner = null; }
        }
        if (SA && SA.withSpin) {
          try { v.animation = SA.withSpin(inner); } catch { if (inner) v.animation = inner; }
        } else if (inner) {
          v.animation = inner;
        }
      }
      onGone(node, () => {
        try { v.dispose(); } catch { /* gone */ }
        // And hand the context back. A browser keeps only so many WebGL
        // contexts (a couple of dozen) and kills the oldest to make room, so a
        // segment resized enough times took out a render elsewhere on the page.
        try {
          const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
          const lose = gl && gl.getExtension('WEBGL_lose_context');
          if (lose) lose.loseContext();
        } catch { /* nothing to hand back */ }
      });
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
        // Inside a `.bd`, like Mojang's cards: that is what holds the padding
        // that follows the corner radius, and without it a large radius cut
        // the corner off the heading.
        const bd = el('div', 'bd');
        const head = el('h4', '', `${n.title}${n.prerelease ? ' (pre-release)' : ''}`);
        bd.appendChild(head);
        if (n.at) bd.appendChild(el('div', 'hs-sub', new Date(n.at).toLocaleDateString()));
        if (n.body) {
          const body = el('div', 'md');
          bd.appendChild(body);
          markdownInto(body, n.body);
        }
        box.appendChild(bd);
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
      onGone(node, () => clearInterval(t));
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
      onGone(node, () => clearInterval(t));
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
    node._own = [];
    // Run once, and emptied as it runs: a node can be torn down from more than
    // one direction (a redraw of the page and a redraw of the segment), and
    // disposing a viewer twice is not free.
    node._cleanup = () => {
      const list = node._own || [];
      node._own = [];
      for (const fn of list) { try { fn(); } catch { /* going anyway */ } }
    };
    try {
      const r = (DRAW[seg.type] || (() => { }))(seg, node);
      if (r && typeof r.catch === 'function') {
        r.catch((e) => {
          node.appendChild(el('div', 'hs-error', 'This segment could not be drawn: ' + (e && e.message || e)));
        });
      }
    } catch (e) {
      node.appendChild(el('div', 'hs-error', 'This segment could not be drawn: ' + (e && e.message || e)));
    }
  }

  // What a segment's CONTENTS depend on. Its size and where it sits are not
  // in here: moving or resizing one does not change what it draws, so it does
  // not have to be drawn again.
  // What a segment DRAWS, as opposed to where it is and how big. A change to
  // the second kind moves a node; a change to the first kind redraws it. Where
  // it sits down its row is the second kind -- redrawing a player segment over
  // it would throw its viewer away and build another.
  const contentKey = (seg) => {
    const { x, y, w, h, scale, valign, ...rest } = seg;
    return JSON.stringify(rest);
  };

  function drawAll() {
    const host = document.getElementById('home-segments');
    if (!host) return;
    // Where the page was. Rebuilding it used to drop you back at the top,
    // which on a long page is the whole page lost for a change of one size.
    const scroller = host.closest('[data-fit-height]') || host.parentElement;
    // The home page's own scroller carries the room above and below the rows
    // (see .home-scroller). Marked here rather than in the markup, so the
    // rule only ever applies to a scroller this page is actually drawn into.
    if (scroller) scroller.classList.add('home-scroller');
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
    // Only what is NOT being kept is torn down -- which is why each node owns
    // what it leaves running. The one list for the whole page was emptied here
    // whatever was being kept, so a kept player segment lost its viewer.
    for (const node of keep.values()) node.remove();
    host.innerHTML = '';

    applyPageRows();
    // Down the page and then across, which is the order a narrow window
    // falls back to and the order the keyboard would walk them in.
    const order = [...LAYOUT].sort((a, b) => (yOf(a) - yOf(b)) || (xOf(a) - xOf(b)));
    for (const seg of order) {
      const had = keep.get(seg.id);
      if (had) {
        host.appendChild(had);
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
      host.appendChild(node);
      applyOne(node, seg);
      drawInto(node, seg);
      if (editing) addTools(node, seg);
    }
    if (scroller) scroller.scrollTop = was;
  }

  // One segment's rectangle and the size of what is drawn inside it.
  //
  // Where its CONTENTS sit inside it, which matters now that every segment
  // has a height of its own and most are taller than what is in them.
  const VALIGN = { top: 'flex-start', middle: 'center', bottom: 'flex-end' };

  /**
   * How many rows tall the page is.
   *
   * The grid needs saying, because an implicit grid is only as tall as what
   * is in it -- and the room UNDER the last segment is where a segment is
   * dragged to when it is being moved to the end of the page. Without it
   * there is nothing below the bottom one to aim at.
   */
  function applyPageRows() {
    const host = document.getElementById('home-segments');
    if (!host) return;
    host.style.setProperty('--unit', UNIT + 'px');
    host.style.setProperty('--rows', String(pageRows()));
  }

  function applyOne(node, seg) {
    node.style.setProperty('--x', String(xOf(seg)));
    node.style.setProperty('--w', String(wOf(seg)));
    node.style.setProperty('--y', String(yOf(seg)));
    node.style.setProperty('--h', String(hOf(seg)));
    node.style.setProperty('--s', String((seg.scale || 100) / 100));
    // What is INSIDE it, up and down. align-self used to do this as well --
    // it placed the segment in its row, for the one case where something
    // beside it was taller. There are no rows, so there is nothing to place
    // a segment in and only the one meaning is left.
    const va = VALIGN[seg.valign];
    if (va) node.style.justifyContent = va; else node.style.removeProperty('justify-content');
    if (va) node.dataset.va = seg.valign; else delete node.dataset.va;
    // Still said out loud, for the player render, which measures it.
    node.dataset.h = String(hOf(seg) * UNIT);
    // Where it falls in the list a narrow window turns the grid into: down
    // the page and then across. A flex line has no idea where a segment
    // would have been, so it is told.
    const y = yOf(seg), x = xOf(seg);
    node.style.setProperty('--order', String(
      LAYOUT.filter(o => (yOf(o) < y) || (yOf(o) === y && xOf(o) < x)).length));
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
  let dropAt = null;          // { x, y, w, h, what }

  const PREVIEW_MS = 900;     // how long to hold still before it is acted out
  let previewTimer = null;
  // Set once a drag has acted one out. From then on it keeps up with the
  // pointer instead of waiting again for every new place.
  let previewing = false;

  function clearDropMarks() {
    for (const n of document.querySelectorAll('.hs-slot')) n.remove();
    previewing = false;        // the drag is over; the next one waits again
    clearPreview();
  }

  // Put everything back where it really is.
  // Put the segments back where they really are. NOT a reset of `previewing`:
  // this runs on the way to drawing the next place, and forgetting that one
  // has already been acted out would bring the wait back for every one of
  // them.
  function clearPreview() {
    if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; }
    for (const node of document.querySelectorAll('#home-segments .hs')) {
      node.classList.remove('hs-would');
      const seg = LAYOUT.find(x => x.id === node.dataset.id);
      if (seg) applyOne(node, seg);
    }
  }

  // What the layout WOULD be, without changing the one in use. The same
  // rules the drop itself follows, so what is acted out is what happens.
  //
  // There is no tidying up afterwards any more. A row used to have to be
  // put back in order when something left it -- a segment on its own took
  // the whole of its row back, rows closed up behind an empty one -- because
  // a row was a thing that could be half empty or not there. Nothing is
  // worked out from anything else now, so a move moves exactly one segment
  // and leaves every other one alone.
  function layoutAfterDrop(fromId, at) {
    const next = LAYOUT.map(x => ({ ...x }));
    const moved = next.find(s => s.id === fromId);
    if (!moved || !at) return next;
    if (at.swap) {
      const other = next.find(s => s.id === at.swap);
      // Its PLACE, not its size. Two segments trading places do not trade
      // how big they are -- a tall one put where a short one was is still
      // the tall one, and giving it the other's height silently resized it
      // as a side effect of a move.
      if (other) { const was = rectOf(moved); other.x = was.x; other.y = was.y; }
    }
    moved.x = at.x; moved.y = at.y; moved.w = at.w; moved.h = at.h;
    return next;
  }

  // Act it out: whatever would move slides to where it would go, at half
  // strength. Which is at most one other segment, and only in a swap.
  function showPreview(at) {
    const host = document.getElementById('home-segments');
    if (!host || !at) return;
    for (const seg of layoutAfterDrop(drag.id, at)) {
      if (seg.id === drag.id) continue;
      const now = LAYOUT.find(x => x.id === seg.id);
      const node = host.querySelector(`.hs[data-id="${seg.id}"]`);
      if (!now || !node) continue;
      const r1 = rectOf(now), r2 = rectOf(seg);
      if (r1.x === r2.x && r1.y === r2.y && r1.w === r2.w && r1.h === r2.h) continue;
      node.classList.add('hs-would');
      applyOne(node, seg);
    }
  }

  // Draw the landing place: a shadow exactly the size and shape of the
  // space it is going into, in the one grid everything else is in.
  function showDrop(at) {
    for (const n of document.querySelectorAll('.hs-slot')) n.remove();
    clearPreview();
    if (!at) return;
    const host = document.getElementById('home-segments');
    if (!host) return;
    const slot = el('div', 'hs-slot' + (at.blocked ? ' no' : ''));
    slot.style.setProperty('--x', String(at.x));
    slot.style.setProperty('--y', String(at.y));
    slot.style.setProperty('--w', String(at.w));
    slot.style.setProperty('--h', String(at.h));
    host.appendChild(slot);
  }

  /**
   * The grid itself: where its first column starts and how wide it is.
   *
   * Its CONTENT box, not the element's. The page carries its right-hand
   * gutter as padding on this element, so the element is twenty pixels wider
   * than the columns in it -- which is two columns out of a hundred, and
   * enough that a segment dropped at the right-hand edge of the page landed
   * two columns short of it.
   */
  function gridBox() {
    const host = document.getElementById('home-segments');
    if (!host) return null;
    const r = host.getBoundingClientRect();
    const cs = getComputedStyle(host);
    const left = parseFloat(cs.paddingLeft) || 0;
    const width = r.width - left - (parseFloat(cs.paddingRight) || 0);
    if (width <= 0) return null;
    return { host, left: r.left + left, top: r.top + (parseFloat(cs.paddingTop) || 0), width };
  }

  /** The grid cell under the pointer, as a fraction so it can be rounded. */
  function cellAt(e) {
    const g = gridBox();
    if (!g) return null;
    return {
      col: ((e.clientX - g.left) / g.width) * COLUMNS,
      row: (e.clientY - g.top) / UNIT,
    };
  }

  // What dropping here would mean.
  //
  // It used to mean one of five things -- a gap in a row, half of another
  // segment's width, half of its height, a new row above, a new row below --
  // because where a segment could go was decided by the rows that happened
  // to exist. A segment goes WHERE THE POINTER IS now, at the size it
  // already is. Nothing is halved, nothing is pushed along, and no row is
  // made or unmade, because there are no rows.
  const NEAR = 8;             // how far to look for room, in grid rows
  function dropTarget(e) {
    const me = LAYOUT.find(x => x.id === drag.id);
    const cell = cellAt(e);
    if (!me || !cell) return null;
    const w = wOf(me), h = hOf(me);
    // Held where it was picked up, rather than snapping a corner to the
    // pointer -- a segment taken by its middle should not jump.
    const lines = snapLines(drag.id);
    const want = {
      w, h,
      x: Math.max(0, Math.min(COLUMNS - w,
        snapCol(Math.round(cell.col - drag.gx), lines))),
      y: Math.max(0, Math.min(MAX_Y - h, Math.round(cell.row - drag.gy))),
    };
    if (isFree(want, drag.id)) return { ...want, what: 'here' };

    // Taken. If exactly one segment is in the way and it would fit where
    // this one is standing, they trade places -- which is the one thing
    // "drop it on that one" can mean that is not a guess.
    const inTheWay = LAYOUT.filter(s => s.id !== drag.id && hits(rectOf(s), want));
    if (inTheWay.length === 1) {
      const other = inTheWay[0];
      const mine = rectOf(me);
      const theirs = { x: mine.x, y: mine.y, w: wOf(other), h: hOf(other) };
      if (theirs.x + theirs.w <= COLUMNS
        && !LAYOUT.some(s => s.id !== drag.id && s.id !== other.id && hits(rectOf(s), theirs))) {
        // Squarely into the other one\'s place, rather than wherever the
        // pointer happened to be over it. Two segments trading places that
        // end up not quite where each other were is not a trade.
        const b = rectOf(other);
        return { x: b.x, y: b.y, w, h, swap: other.id, what: 'swap' };
      }
    }

    // Otherwise the nearest clear space to where the pointer is, up or down
    // first and then across, so it lands where it was aimed rather than
    // somewhere else entirely. Nothing within reach means nothing happens:
    // a segment is not flung to the end of the page for want of room.
    let best = null, near = Infinity;
    for (let dy = 0; dy <= NEAR; dy++) {
      for (const sy of dy ? [dy, -dy] : [0]) {
        for (let dx = 0; dx <= NEAR * 2; dx++) {
          for (const sx of dx ? [dx, -dx] : [0]) {
            const r = {
              w, h,
              x: Math.max(0, Math.min(COLUMNS - w, want.x + sx)),
              y: Math.max(0, want.y + sy),
            };
            const d = Math.abs(r.x - want.x) * 0.4 + Math.abs(r.y - want.y);
            if (d >= near || !isFree(r, drag.id)) continue;
            near = d; best = r;
          }
        }
      }
    }
    if (best) return { ...best, what: 'the nearest room' };
    return { ...want, blocked: true, what: 'no room' };
  }

  function onDragMove(e) {
    if (!drag) return;
    drag.ghost.style.left = (e.clientX - drag.dx) + 'px';
    drag.ghost.style.top = (e.clientY - drag.dy) + 'px';
    const at = dropTarget(e);
    const same = at && dropAt && at.x === dropAt.x && at.y === dropAt.y
      && at.w === dropAt.w && at.h === dropAt.h && at.swap === dropAt.swap;
    if (same) return;
    dropAt = at;
    showDrop(at);
    // The wait is to stop the page twitching as the pointer crosses things on
    // its way somewhere. Once it HAS been acted out, there is nothing to stop:
    // the page is already showing what a drop would do, so moving to another
    // place slides from one answer to the next rather than making you hold
    // still all over again for each one.
    if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; }
    if (!at) return;
    if (previewing) { showPreview(at); return; }
    previewTimer = setTimeout(() => {
      previewTimer = null;
      previewing = true;
      showPreview(at);
    }, PREVIEW_MS);
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
    if (!landed || landed.blocked) return;
    placeSegment(node.dataset.id, landed);
  }

  function startDrag(node, seg, e) {
    const r = node.getBoundingClientRect();
    const ghost = el('div');
    ghost.style.cssText = `position:fixed;z-index:9500;pointer-events:none;opacity:0.85;
      width:${r.width}px;height:${Math.min(r.height, 220)}px;overflow:hidden;
      border:2px solid rgba(255,255,255,0.45);border-radius:var(--border-radius);background:var(--menu-bg);
      box-shadow:0 10px 30px rgba(0,0,0,0.5);`;
    ghost.appendChild(el('div', '', typeSpec(seg.type).name || seg.type));
    ghost.firstChild.style.cssText = 'padding:10px 12px;font-weight:bold;';
    document.body.appendChild(ghost);
    // Where in the segment it was taken hold of, in grid units, so it keeps
    // that grip instead of jumping a corner to the pointer.
    const cell = cellAt(e);
    drag = {
      id: seg.id, node, ghost,
      dx: e.clientX - r.left, dy: e.clientY - r.top,
      gx: cell ? cell.col - xOf(seg) : 0,
      gy: cell ? cell.row - yOf(seg) : 0,
    };
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

  // Where the dragged segment ends up. The same answer the preview acted
  // out, out of the same function, so the two cannot drift apart.
  function placeSegment(fromId, at) {
    if (!at || !LAYOUT.some(s => s.id === fromId)) return;
    const next = layoutAfterDrop(fromId, at);
    // Merged into the objects already in LAYOUT: the handles and the
    // settings dialog hold references to them.
    for (const want of next) {
      const had = LAYOUT.find(s => s.id === want.id);
      if (had) Object.assign(had, want);
    }
    save();
  }

  // ── resizing ────────────────────────────────────────────────────────────
  //
  // A handle in each corner, and all four do the same kind of thing: the two
  // edges that meet at that corner move, and the two that do not stay exactly
  // where they are.
  //
  // This is the half of the page that rows made impossible. Across, an edge
  // had neighbours and stopped at them, which was right. Down, there was
  // nothing to stop at and nothing to grow into: a row was a box as tall as
  // what was in it, so dragging the bottom edge down made the BOX taller and
  // shoved everything below it further down the page, and dragging the top
  // edge up had nowhere at all to go. What was there instead was a special
  // gesture -- drag far enough past the end of the row and the row below is
  // taken into this one and the two become one divided row -- which is the
  // thing that was reported, twice, as still being a rowed system. It is
  // gone. An edge moves until it would run into something and stops there,
  // the same in all four directions, and nothing else on the page moves at
  // all.
  //
  // How far an edge may go: up to the nearest edge of anything that stands
  // in the way of the rectangle this would become. Worked out as a limit
  // rather than by trying every column, so an edge dragged fast lands in the
  // same place as one dragged slowly.
  /** The furthest `side` of `r` may travel before it overlaps something. */
  function edgeLimit(r, side, selfId) {
    let limit = side === 'e' ? COLUMNS : side === 'w' ? 0 : side === 's' ? MAX_Y : 0;
    for (const o of LAYOUT) {
      if (o.id === selfId) continue;
      const b = rectOf(o);
      if (side === 'e' || side === 'w') {
        // Only what this would actually run into: something level with it.
        if (!(r.y < b.y + b.h && b.y < r.y + r.h)) continue;
        if (side === 'e' && b.x >= r.x + r.w) limit = Math.min(limit, b.x);
        if (side === 'w' && b.x + b.w <= r.x) limit = Math.max(limit, b.x + b.w);
      } else {
        if (!(r.x < b.x + b.w && b.x < r.x + r.w)) continue;
        if (side === 's' && b.y >= r.y + r.h) limit = Math.min(limit, b.y);
        if (side === 'n' && b.y + b.h <= r.y) limit = Math.max(limit, b.y + b.h);
      }
    }
    return limit;
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
        const east = corner === 'ne' || corner === 'se';
        const south = corner === 'sw' || corner === 'se';
        node.classList.add('sizing');

        const g = gridBox();
        const colW = (g ? g.width : node.parentElement.clientWidth) / COLUMNS;
        const startX = e.clientX, startY = e.clientY;
        const was = rectOf(seg);
        const cols = snapLines(seg.id), rows = snapRows(seg.id);

        const show = (what) => {
          const where = node.querySelector(':scope > .hs-size') || readout;
          where.textContent = what;
        };
        const say = () => show(`${wOf(seg)}% · ${hOf(seg)} rows`
          + ` · from the ${south ? 'top' : 'bottom'} ${east ? 'left' : 'right'}`);
        say();

        const onMove = (ev) => {
          const dx = Math.round((ev.clientX - startX) / Math.max(1, colW));
          const dy = Math.round((ev.clientY - startY) / UNIT);

          // Across. The edge being dragged moves; the other stays put.
          if (east) {
            const stop = edgeLimit(was, 'e', seg.id);
            const right = Math.max(was.x + MIN_W,
              Math.min(stop, snapCol(was.x + was.w + dx, cols)));
            seg.x = was.x; seg.w = right - was.x;
          } else {
            const stop = edgeLimit(was, 'w', seg.id);
            const left = Math.min(was.x + was.w - MIN_W,
              Math.max(stop, snapCol(was.x + dx, cols)));
            seg.x = left; seg.w = (was.x + was.w) - left;
          }

          // And down, which is now exactly the same gesture. Dragging the
          // bottom edge down grows INTO the space below if there is any and
          // stops where there is not; dragging the top edge up does the
          // same upwards. Nothing is pushed and no rows are merged.
          if (south) {
            const stop = edgeLimit(was, 's', seg.id);
            const bottom = Math.max(was.y + MIN_H,
              Math.min(stop, Math.min(MAX_Y, snapCol(was.y + was.h + dy, rows, 1))));
            seg.y = was.y; seg.h = bottom - was.y;
          } else {
            const stop = edgeLimit(was, 'n', seg.id);
            const top = Math.min(was.y + was.h - MIN_H,
              Math.max(stop, snapCol(was.y + dy, rows, 1)));
            seg.y = top; seg.h = (was.y + was.h) - top;
          }

          applyOne(node, seg);
          applyPageRows();       // the page may have grown under the segment
          say();
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          node.classList.remove('sizing');
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
  // ── going back ──────────────────────────────────────────────────────────
  //
  // Every change to the page took effect and was saved at once, and there
  // was no way back from any of it: a segment dragged somewhere by accident,
  // a row halved, a size nudged -- the only undo was to put it back by hand
  // and hope you remembered where it was. Each change now leaves the layout
  // as it was on a stack, and Ctrl+Z walks back up it. Ctrl+Shift+Z (or
  // Ctrl+Y) walks forward again.
  //
  // Snapshots rather than reversible operations: a layout is a few hundred
  // bytes, and a snapshot cannot be wrong about what it undoes.
  const UNDO_MAX = 50;
  let undoStack = [], redoStack = [], restoring = false;
  // The layout as it was when it was last written down. The callers change
  // the segment objects in place and THEN save, so taking the snapshot
  // inside save would record the change rather than what came before it.
  let lastSaved = null;
  const snapshot = () => LAYOUT.map(s => ({ ...s }));
  function remember() {
    if (restoring || !lastSaved) return;
    undoStack.push(lastSaved);
    if (undoStack.length > UNDO_MAX) undoStack.shift();
    redoStack = [];                       // a new change forks the history
    paintUndo();
  }
  async function stepBack(forward) {
    const from = forward ? redoStack : undoStack;
    const to = forward ? undoStack : redoStack;
    if (!from.length) return false;
    to.push(lastSaved || snapshot());
    const want = from.pop();
    restoring = true;
    try { LAYOUT = want.map(s => ({ ...s })); await save({ full: true }); }
    finally { restoring = false; }
    paintUndo();
    return true;
  }
  function paintUndo() {
    const u = document.getElementById('home-undo');
    const r = document.getElementById('home-redo');
    if (u) u.disabled = !undoStack.length;
    if (r) r.disabled = !redoStack.length;
  }
  document.addEventListener('keydown', (e) => {
    if (!editing || !(e.ctrlKey || e.metaKey)) return;
    const k = String(e.key || '').toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); stepBack(false); }
    else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); stepBack(true); }
  });

  const save = async (opts = {}) => {
    if (!opts.full) remember();
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
    lastSaved = snapshot();
    if (opts.full) { drawAll(); return; }
    if (opts.redraw === false) { applyGeometry(); return; }
    if (opts.only) { redrawOne(opts.only); applyGeometry(); return; }
    drawAll();
  };

  // The size and position of every segment, without touching what is inside
  // them. Always enough: every segment is in the one grid, so there is no
  // longer such a thing as moving to another row's container and no reason
  // for a move to rebuild the page.
  function applyGeometry() {
    const host = document.getElementById('home-segments');
    if (!host) return;
    applyPageRows();
    for (const seg of LAYOUT) {
      const node = host.querySelector(`.hs[data-id="${seg.id}"]`);
      if (node) applyOne(node, seg);
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
          // Under everything there is, across the page, which is the one
          // place that is certainly empty.
          const below = LAYOUT.reduce((n, x) => Math.max(n, yOf(x) + hOf(x)), 0);
          const seg = {
            id: `${t.type}-${Date.now().toString(36)}`, type: t.type,
            x: 0, y: below, w: COLUMNS, h: t.rows || 14, scale: 100,
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

      // Three groups rather than one long column: what it shows, the switches
      // together, and how big it is. A group with nothing in it is not drawn.
      const scroll = el('div', 'he-body');
      body.appendChild(scroll);
      if (spec.about) scroll.appendChild(el('p', 'he-about', spec.about));
      const group = (title, cls) => {
        const g = el('div', 'he-group');
        if (title) g.appendChild(el('h4', '', title));
        const inner = el('div', cls);
        g.appendChild(inner);
        scroll.appendChild(g);
        return { g, inner, used: false };
      };
      const fields = group('What it shows', 'he-grid');
      const switches = group('And', 'he-switches');

      for (const o of spec.options || []) {
        const toggle = o.kind === 'toggle';
        // A label element, so the words switch it as well as the box.
        const wrap = el(toggle ? 'label' : 'div', 'he-opt' + (toggle ? ' row' : ''));
        if (o.kind === 'media' || (o.kind === 'text' && /text|says|heading/i.test(o.label || ''))) {
          wrap.classList.add('wide');
        }
        if (toggle) {
          const cb = el('input');
          cb.type = 'checkbox';
          // An option's default matters: most of these are on unless turned
          // off, and reading a missing value as false had them all drawn
          // unticked and then SAVED off by pressing Done.
          cb.checked = values[o.id] == null ? !!o.default : !!values[o.id];
          values[o.id] = cb.checked;
          cb.onchange = () => { values[o.id] = cb.checked; };
          wrap.append(cb, el('span', '', o.label));
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
        const into = toggle ? switches : fields;
        into.used = true;
        into.inner.appendChild(wrap);
      }
      for (const grp of [fields, switches]) if (!grp.used) grp.g.remove();

      // How big it is, which belongs to every type rather than to any one of
      // them -- so it is here rather than in each type's option list. The
      // corner handles write the same two numbers.
      const sizeGroup = group('How big', 'he-size');
      sizeGroup.used = true;
      const sizeRow = sizeGroup.inner;
      const wWrap = el('div', 'he-opt');
      wWrap.appendChild(el('label', '', 'Width (% of the page)'));
      const wIn = el('input');
      wIn.type = 'number'; wIn.min = MIN_W; wIn.max = COLUMNS;
      wIn.value = String(values.w || COLUMNS);
      wIn.oninput = () => { values.w = Math.max(MIN_W, Math.min(COLUMNS, parseInt(wIn.value, 10) || COLUMNS)); };
      wWrap.appendChild(wIn);

      // In grid rows, not pixels. A height in pixels was a height nothing
      // else on the page had to agree about, which is why 0 had to mean
      // "however tall its contents are" and why the row it was in had to be
      // as tall as the tallest thing in it. A segment is a rectangle in the
      // page's grid now, so its height is the same kind of number as its
      // width and there is no such thing as not having one.
      const hWrap = el('div', 'he-opt');
      hWrap.appendChild(el('label', '', `Height (rows of ${UNIT}px)`));
      const hIn = el('input');
      hIn.type = 'number'; hIn.min = MIN_H; hIn.max = MAX_H;
      hIn.value = String(hOf(values));
      hIn.oninput = () => {
        values.h = Math.max(MIN_H, Math.min(MAX_H, parseInt(hIn.value, 10) || MIN_H));
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

      // Where what is in it sits, up and down. It matters more than it did:
      // every segment has a height of its own now and most are taller than
      // what is in them.
      const vWrap = el('div', 'he-opt');
      vWrap.appendChild(el('label', '', 'What is inside it sits'));
      const vIn = el('select');
      for (const [value, label] of [
        ['stretch', 'Filling it'],
        ['top', 'At the top'],
        ['middle', 'In the middle'],
        ['bottom', 'At the bottom'],
      ]) {
        const op = el('option', '', label);
        op.value = value;
        if ((values.valign || 'stretch') === value) op.selected = true;
        vIn.appendChild(op);
      }
      vIn.onchange = () => { values.valign = vIn.value; };
      vWrap.appendChild(vIn);

      sizeRow.append(wWrap, hWrap, sWrap, vWrap);

      const actions = el('div', 'modal-actions');
      actions.style.marginTop = '12px';
      const cancel = el('button', '', 'Cancel');
      cancel.onclick = () => close();
      const ok = el('button', 'primary', 'Done');
      ok.onclick = () => {
        Object.assign(seg, values);
        close();
        // Only this segment changed, so only this one is drawn again.
        save({ only: seg.id });
      };
      actions.append(cancel, ok);
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
      // Back and forward through the changes. Shown as buttons as well as
      // Ctrl+Z, because a keyboard shortcut nobody is told about is not an
      // undo.
      const undo = el('button', 'icon-only');
      undo.id = 'home-undo';
      undo.title = 'Undo (Ctrl+Z)';
      undo.innerHTML = '<i class="material-icons">undo</i>';
      undo.onclick = () => stepBack(false);
      const redo = el('button', 'icon-only');
      redo.id = 'home-redo';
      redo.title = 'Redo (Ctrl+Shift+Z)';
      redo.innerHTML = '<i class="material-icons">redo</i>';
      redo.onclick = () => stepBack(true);
      // Snapping, on or off, and it says which it is.
      const snap = el('button', 'icon-only');
      snap.id = 'home-snap';
      const paintSnap = () => {
        snap.title = SNAP ? 'Snapping is on (edges pull to the lines)' : 'Snapping is off';
        snap.style.opacity = SNAP ? '1' : '0.45';
        snap.innerHTML = `<i class="material-icons">${SNAP ? 'grid_on' : 'grid_off'}</i>`;
      };
      snap.onclick = () => { setSnap(!SNAP); paintSnap(); };
      paintSnap();
      const done = el('button', '', 'Done');
      done.onclick = () => setEditing(false);
      bar.append(undo, redo, snap, add, reset, done);
      paintUndo();
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
      // The room under the page to drag a segment into comes and goes with
      // the handles.
      applyPageRows();
    }
  }

  async function load() {
    const r = await ipcRenderer.invoke('home:layout');
    TYPES = (r && r.types) || [];
    COLUMNS = (r && r.columns) || 100;
    LAYOUT = ((r && r.layout) || []).map(s => ({ ...s }));
    // Where undo starts from. A page just loaded has nothing to go back to.
    lastSaved = snapshot();
    undoStack = []; redoStack = [];
    paintUndo();
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
    undo: () => stepBack(false),
    redo: () => stepBack(true),
    // Hand it a layout and have it do what a change does: store it, then
    // put on screen only what actually changed. Used by the tests.
    apply: async (layout) => { LAYOUT = layout.map(x => ({ ...x })); await save(); },
  };
})();
