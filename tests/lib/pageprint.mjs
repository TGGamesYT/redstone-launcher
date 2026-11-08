// What a page looks like, and what changed about it.
//
// Shared by the two tests that need it: the one that photographs every page
// before and after a change, and the one that checks a page framed in the
// shell is laid out exactly as it is on its own. They have to measure the same
// things or neither claim means anything.

const FINGERPRINT = `(() => {
  const want = [
    "display", "position", "boxSizing", "overflow", "overflowX", "overflowY",
    "flexDirection", "justifyContent", "alignItems", "gridTemplateColumns",
    "fontFamily", "fontSize", "fontWeight", "lineHeight", "textAlign",
    "color", "backgroundColor", "borderRadius",
    "marginTop", "marginRight", "marginBottom", "marginLeft",
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "zIndex", "opacity", "visibility",
  ];
  const round = (n) => Math.round(n * 10) / 10;
  const out = [];
  const seen = new Set();
  // Everything with an id, plus the elements that carry layout: those are what
  // a shell could disturb without anybody noticing in a screenshot.
  const nodes = document.querySelectorAll(
    "[id], body, .sidebar, .main-scrolly, .full-scrolly, [data-fit-height], .modal-overlay, .modal-content, #toolbar, .drag-region"
  );
  for (const el of nodes) {
    if (seen.has(el)) continue;
    seen.add(el);
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const style = {};
    for (const k of want) style[k] = cs[k];
    out.push({
      key: el.id ? "#" + el.id : el.tagName.toLowerCase() + "." + (el.className || "").toString().trim().split(/\\s+/).filter(Boolean).slice(0, 3).join("."),
      box: [round(r.x), round(r.y), round(r.width), round(r.height)],
      style,
    });
  }
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return {
    scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
    count: out.length,
    nodes: out,
  };
})()`;

/** What differs, as the first handful of differences rather than a wall. */
function diffPrints(a, b) {
  const out = [];
  if (JSON.stringify(a.scroll) !== JSON.stringify(b.scroll)) {
    out.push(`the page's own size: was ${a.scroll.join("x")}, now ${b.scroll.join("x")}`);
  }
  const byKey = (p) => new Map(p.nodes.map(n => [n.key, n]));
  const before = byKey(a), after = byKey(b);
  for (const [key, was] of before) {
    const now = after.get(key);
    if (!now) { out.push(`${key} is gone`); continue; }
    if (JSON.stringify(was.box) !== JSON.stringify(now.box)) {
      out.push(`${key} moved: was [${was.box}], now [${now.box}]`);
    }
    for (const k of Object.keys(was.style)) {
      if (was.style[k] !== now.style[k]) {
        out.push(`${key} ${k}: was ${was.style[k]}, now ${now.style[k]}`);
      }
    }
    if (out.length > 40) { out.push("…and more"); return out; }
  }
  for (const key of after.keys()) if (!before.has(key)) out.push(`${key} is new`);
  return out;
}


/**
 * A fingerprint that has stopped changing.
 *
 * These pages are still settling for a while after `load`: an overlay fades
 * out, a list arrives and changes a height, a scroller is measured against the
 * window. A fixed wait is a guess, and a guess that is too short reports a
 * page as having moved when all that happened is that the photograph was taken
 * mid-blink -- which is exactly what a four-pixel "difference" in the mod
 * browser turned out to be.
 *
 * So it is read until two reads in a row agree, which is the page saying it
 * has finished. `target` is a Playwright page or frame.
 */
async function settled(target, { tries = 25, gap = 220 } = {}) {
  // The loading overlay first. Every page puts one up and takes it down again
  // a moment later, and it covers the whole content area while it is there --
  // so a photograph taken with it still up is a photograph of the overlay.
  // Its end state is always hidden, so that is what is waited for rather than
  // hoping the wait was long enough. (This is what made the server and skins
  // pages look as though they had changed when all that differed was whether
  // the shutter caught the overlay.)
  // The cap is generous because the cost of it being too short is a test that
  // fails for no reason the code did -- a page whose data arrives late holds
  // the overlay up, and all the suites running at once is exactly when that
  // happens. Waiting longer costs nothing when it is already down, since this
  // stops the moment it is.
  for (let i = 0; i < 90; i++) {
    const gone = await target.evaluate(() => {
      const el = document.getElementById("loading-overlay");
      if (!el) return true;
      const cs = getComputedStyle(el);
      return cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0;
    });
    if (gone) break;
    await new Promise(r => setTimeout(r, 150));
  }

  // And then the same grace the overlay's own fade used to give it.
  //
  // A page in the shell does not draw its own loading screen -- the shell's
  // covers the whole change -- so the wait above returns at once for a
  // framed page and only after the fade for the same page standing alone.
  // That is a different moment in the page's life, and the two were being
  // compared: the framed one was photographed before its list had arrived.
  for (let i = 0; i < 60; i++) {
    const done = await target.evaluate(() => document.readyState === "complete");
    if (done) break;
    await new Promise(r => setTimeout(r, 150));
  }
  await new Promise(r => setTimeout(r, 900));

  let last = null;
  for (let i = 0; i < tries; i++) {
    const now = await target.evaluate(FINGERPRINT);
    const text = JSON.stringify(now);
    if (last === text) return now;
    last = text;
    await new Promise(r => setTimeout(r, gap));
  }
  // Still moving after all that: hand back the last one rather than hanging,
  // and the comparison will say what is restless.
  return JSON.parse(last);
}

export { FINGERPRINT, diffPrints, settled };
