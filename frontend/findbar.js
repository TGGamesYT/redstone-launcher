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
      area.setSelectionRange(start, start + q.value.length);
      // Nor does it scroll on its own while unfocused, so the match is put
      // into view by hand -- by line, rather than by a share of the whole,
      // because long lines wrap and the two do not agree.
      try {
        const before = area.value.slice(0, start).split("\n").length - 1;
        const cs = getComputedStyle(area);
        let lh = parseFloat(cs.lineHeight);
        if (!Number.isFinite(lh)) lh = parseFloat(cs.fontSize) * 1.2;
        const want = before * lh - area.clientHeight / 2 + lh;
        area.scrollTop = Math.max(0, Math.min(area.scrollHeight - area.clientHeight, want));
      } catch { /* its own scrolling will do */ }
      say();
    };

    const open = () => {
      bar.style.display = "";
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
    const close = () => { bar.style.display = "none"; area.focus(); };

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

    const api = { open, close, bar, refind: find };
    area._findBar = api;
    return api;
  }

  window.FindBar = { attach };
})();
