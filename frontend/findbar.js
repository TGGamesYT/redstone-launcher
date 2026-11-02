/**
 * Ctrl+F in a textarea.
 *
 *   FindBar.attach(textarea)            // and that is all
 *   FindBar.attach(textarea, { host })  // where to put the bar, if not above it
 *
 * Every editor in the launcher is a <textarea>, and a textarea has no find of
 * its own -- the browser's Ctrl+F does not search inside form fields, so a
 * server log or a config file of a few hundred lines could only be read by
 * scrolling. This is the missing one: a bar that counts the matches, steps
 * through them with Enter and Shift+Enter (or F3), and leaves each one
 * selected so it is visible in the field itself.
 *
 * It selects rather than highlights because a textarea cannot be marked up --
 * there is nothing inside it to paint. Selecting the match is what a textarea
 * can show, and it scrolls it into view for free.
 *
 * Attaching twice to the same field does nothing the second time.
 */
(function () {
  if (window.FindBar) return;

  const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  function attach(area, opts) {
    if (!area || area._findBar) return area && area._findBar;
    const host = (opts && opts.host) || area.parentElement;
    if (!host) return null;

    const bar = document.createElement("div");
    bar.className = "findbar";
    bar.style.display = "none";
    bar.innerHTML = `
      <i class="material-icons">search</i>
      <input type="text" class="fnd-q" placeholder="Find" spellcheck="false">
      <label class="fnd-case" title="Match upper and lower case"><input type="checkbox"> Aa</label>
      <span class="fnd-count"></span>
      <button type="button" class="fnd-prev" title="Previous (Shift+Enter)"><i class="material-icons">keyboard_arrow_up</i></button>
      <button type="button" class="fnd-next" title="Next (Enter)"><i class="material-icons">keyboard_arrow_down</i></button>
      <button type="button" class="fnd-x" title="Close (Esc)"><i class="material-icons">close</i></button>`;
    host.insertBefore(bar, area);

    const q = bar.querySelector(".fnd-q");
    const caseBox = bar.querySelector(".fnd-case input");
    const count = bar.querySelector(".fnd-count");

    let hits = [];        // [index, …] into the field's value
    let at = -1;

    // ── Showing where the matches are ────────────────────────────────────────
    //
    // A textarea cannot be marked up -- there is nothing inside it to paint --
    // and the obvious substitute does not work either: a textarea only draws
    // its selection while it is FOCUSED, and focus has to stay in the query
    // box or Enter would be typed into the file instead of stepping through
    // the matches. So selecting the match showed nothing at all.
    //
    // What does work is a copy of the text behind the field, with the matches
    // wrapped in <mark>, the field itself made transparent over the top of it,
    // and the two kept in step: same font, same padding, same wrapping, same
    // scroll position. The field still holds the text and still takes the
    // typing; the layer underneath only colours it in.
    //
    // Only while the bar is open. A page with a closed find bar pays nothing.
    let wrap = null, layer = null, wasBackground = null;

    // Everything that decides where a character lands. Miss one and the
    // highlight sits a few pixels off the word it is meant to be under.
    const MIRROR = [
      "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontVariant",
      "lineHeight", "letterSpacing", "wordSpacing", "textTransform", "textIndent",
      "textAlign", "tabSize", "whiteSpace", "wordBreak", "overflowWrap",
      "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
      "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
      "direction",
    ];

    function buildLayer() {
      if (layer) return layer;
      const cs = getComputedStyle(area);

      // The field is moved into a box of its own so the layer can be put
      // behind it without being positioned against something further up the
      // page. The box takes over the field's place in the layout -- these
      // fields are flex children that fill their panel -- and the field fills
      // the box.
      wrap = document.createElement("div");
      wrap.className = "fnd-wrap";
      wrap.style.flex = cs.flex;
      wrap.style.alignSelf = cs.alignSelf;
      area.parentElement.insertBefore(wrap, area);
      wrap.appendChild(area);

      layer = document.createElement("div");
      layer.className = "fnd-layer";
      for (const k of MIRROR) layer.style[k] = cs[k];
      // A textarea wraps on word boundaries and keeps its spaces; say so
      // explicitly rather than hoping the mirrored values cover it.
      if (layer.style.whiteSpace === "normal" || !layer.style.whiteSpace) layer.style.whiteSpace = "pre-wrap";
      layer.style.overflowWrap = "break-word";
      layer.style.borderStyle = "solid";
      layer.style.borderColor = "transparent";
      // The layer carries the field's background, because the field has to
      // become see-through for the marks under it to show.
      layer.style.background = cs.backgroundColor;
      wrap.insertBefore(layer, area);

      wasBackground = area.style.background;
      area.style.background = "transparent";
      area.classList.add("fnd-over");

      area.addEventListener("scroll", syncScroll);
      return layer;
    }

    function dropLayer() {
      if (!layer) return;
      area.removeEventListener("scroll", syncScroll);
      area.style.background = wasBackground || "";
      area.classList.remove("fnd-over");
      layer.remove();
      layer = null;
      // The field goes back where it was, so nothing is left wrapped in a box
      // it did not start in.
      if (wrap && wrap.parentElement) {
        wrap.parentElement.insertBefore(area, wrap);
        wrap.remove();
      }
      wrap = null;
    }

    const syncScroll = () => {
      if (!layer) return;
      layer.scrollTop = area.scrollTop;
      layer.scrollLeft = area.scrollLeft;
    };

    const escHtml = (t) => t.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

    // Every match marked, and the one you are on marked differently. A
    // trailing newline gets a space after it so the last line still has a box
    // to be drawn in.
    function paint() {
      if (!layer) return;
      const text = area.value;
      if (!q.value || !hits.length) {
        layer.innerHTML = escHtml(text) + "\n ";
        syncScroll();
        return;
      }
      const len = q.value.length;
      let out = "", from = 0;
      hits.forEach((start, i) => {
        out += escHtml(text.slice(from, start));
        out += `<mark class="fnd-hit${i === at ? " on" : ""}">`
          + escHtml(text.substr(start, len)) + "</mark>";
        from = start + len;
      });
      out += escHtml(text.slice(from)) + "\n ";
      layer.innerHTML = out;
      syncScroll();
    }

    const find = () => {
      const needle = q.value;
      hits = [];
      at = -1;
      if (needle) {
        const re = new RegExp(esc(needle), caseBox.checked ? "g" : "gi");
        const text = area.value;
        let m;
        // A zero-length match cannot happen (the needle is non-empty), so this
        // always advances.
        while ((m = re.exec(text))) hits.push(m.index);
      }
      say();
    };

    const say = () => {
      count.textContent = !q.value ? "" : hits.length ? `${at + 1} of ${hits.length}` : "none";
      bar.classList.toggle("empty", !!q.value && !hits.length);
      paint();
    };

    // Deliberately WITHOUT focusing the field: focus has to stay in the query
    // box or Enter and Shift+Enter would be typed into the file instead of
    // stepping through the matches. A textarea shows its selection while it is
    // not focused, and closing the bar hands focus back with the caret already
    // at the match.
    const go = (step) => {
      if (!hits.length) return;
      at = (at + step + hits.length) % hits.length;
      const start = hits[at];
      // Still selected as well as highlighted: closing the bar hands focus
      // back with the caret already at the match.
      area.setSelectionRange(start, start + q.value.length);
      // A textarea does not scroll on its own while unfocused, so the match is
      // put into view by hand -- by line, rather than by a share of the whole,
      // because long lines wrap and the two do not agree.
      try {
        const before = area.value.slice(0, start).split("\n").length - 1;
        const cs = getComputedStyle(area);
        let lh = parseFloat(cs.lineHeight);
        if (!Number.isFinite(lh)) lh = parseFloat(cs.fontSize) * 1.2;
        const want = before * lh - area.clientHeight / 2 + lh;
        area.scrollTop = Math.max(0, Math.min(area.scrollHeight - area.clientHeight, want));
      } catch { /* its own scrolling will do */ }
      syncScroll();
      say();
    };

    const open = () => {
      bar.style.display = "";
      buildLayer();
      // Whatever is selected in the field is what you are looking for.
      try {
        const sel = area.value.slice(area.selectionStart, area.selectionEnd);
        if (sel && !sel.includes("\n")) q.value = sel;
      } catch { /* no selection to read */ }
      q.focus();
      q.select();
      find();
      if (hits.length) go(1);
    };
    const close = () => {
      bar.style.display = "none";
      dropLayer();
      area.focus();
    };

    q.addEventListener("input", () => { find(); if (hits.length) go(1); });
    caseBox.addEventListener("change", () => { find(); if (hits.length) go(1); });
    q.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); go(e.shiftKey ? -1 : 1); }
      else if (e.key === "Escape") { e.preventDefault(); close(); }
    });
    bar.querySelector(".fnd-next").onclick = () => go(1);
    bar.querySelector(".fnd-prev").onclick = () => go(-1);
    bar.querySelector(".fnd-x").onclick = close;

    // On the field, and on the bar, so Ctrl+F works from either.
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        open();
      } else if (e.key === "F3") {
        e.preventDefault();
        if (bar.style.display === "none") open(); else go(e.shiftKey ? -1 : 1);
      } else if (e.key === "Escape" && bar.style.display !== "none") {
        close();
      }
    };
    area.addEventListener("keydown", onKey);
    bar.addEventListener("keydown", onKey);
    // The field's contents can be replaced out from under the bar (another
    // file opened in the same editor), so the count is re-counted on a change.
    area.addEventListener("input", () => { if (bar.style.display !== "none") find(); });
    // The field can be resized (these editors are resizable, and the window
    // is), which rewraps the text. The layer has to rewrap with it.
    if (typeof ResizeObserver === "function") {
      const ro = new ResizeObserver(() => { if (layer) syncScroll(); });
      ro.observe(area);
    }

    const api = { open, close, bar, refind: find, get layer() { return layer; } };
    area._findBar = api;
    return api;
  }

  window.FindBar = { attach };
})();
