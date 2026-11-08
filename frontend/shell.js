/**
 * The shell: the title bar and the sidebar, once, for the whole launcher.
 *
 * Every page used to carry its own copy of both, so navigating anywhere threw
 * them away and built them again -- the window controls flickered, the
 * instance list was fetched afresh, the running-instances pill restarted its
 * poll, and the sidebar's highlight flashed off and on. Now the bars are the
 * shell's and the page you are on lives in a frame underneath them.
 *
 * What this file does is small, because the design is doing the work: the
 * frame covers the whole window and the bars are drawn over it, so no page's
 * layout changes at all. What is left is
 *
 *   - sending the sidebar's links to the frame instead of the shell, which is
 *     the one thing that would otherwise navigate the shell away and leave
 *     nothing behind,
 *   - marking which page is open, since the shell's own URL never changes and
 *     so cannot say,
 *   - keeping the window title the frame's title.
 *
 * Back and forward need nothing: they go through the main process, and a
 * frame's navigations are part of the window's own session history.
 */
(function () {
  const frame = document.getElementById("view");
  if (!frame) return;

  // Only the launcher's own pages, and only by file name. A sidebar link is
  // ours by definition, but this is also what `shellNavigate` accepts from a
  // page, so it is checked rather than trusted.
  const ourPage = (href) => {
    const name = String(href || "").trim();
    if (!name || /^[a-z]+:/i.test(name) && !/^\.?\//.test(name)) {
      // Anything with a scheme (http:, mailto:, …) is not one of ours.
      if (/^[a-z][a-z0-9+.-]*:/i.test(name)) return null;
    }
    // A bare page, optionally with a query or a hash.
    return /^[\w.-]+\.html(\?[^#]*)?(#.*)?$/.test(name) ? name : null;
  };

  // ── the loading screen ────────────────────────────────────────────────────
  //
  // The shell's, not the page's. Up when a change starts, down when the page
  // asked for says it is ready. See the #shell-loading comment in shell.html
  // for why, and hideLoadingOverlay in sidebar.js for the other half.
  const overlay = document.getElementById("shell-loading");
  let settleTimer = 0, capTimer = 0, upAt = 0;

  // Long enough that a slow page is covered, short enough that a stuck one
  // does not hide the launcher. The page's own loading screen takes over if
  // it really is still loading.
  const LOADING_CAP = 6000;
  // Up for at least this long once it is up, so a page that arrives in a
  // frame or two does not flash it.
  const LOADING_MIN = 260;

  function loadingUp(what) {
    if (!overlay) return;
    const sub = overlay.querySelector(".loading-subtext");
    if (sub) sub.textContent = what || "Loading...";
    clearTimeout(settleTimer); clearTimeout(capTimer);
    upAt = Date.now();
    overlay.classList.remove("going");
    overlay.classList.add("on");
    capTimer = setTimeout(() => loadingDown(true), LOADING_CAP);
  }

  function loadingDown(now) {
    if (!overlay || !overlay.classList.contains("on")) return;
    const left = now ? 0 : Math.max(0, LOADING_MIN - (Date.now() - upAt));
    clearTimeout(settleTimer); clearTimeout(capTimer);
    settleTimer = setTimeout(() => {
      overlay.classList.remove("on");
      overlay.classList.add("going");
      // Off the paint path once it has faded, so it cannot sit over the page
      // eating clicks.
      settleTimer = setTimeout(() => overlay.classList.remove("going"), 340);
    }, left);
  }

  /** Show a page in the frame. */
  function navigate(href) {
    const page = ourPage(href);
    if (!page) return false;
    // Same page, different query: still a navigation, because that is how
    // these pages are told which instance or server to open.
    loadingUp(label(page));
    frame.setAttribute("src", page);
    // Marked now rather than waiting to be told, so the sidebar answers the
    // click immediately instead of a beat later.
    markCurrent(page.split(/[?#]/)[0]);
    return true;
  }

  // What the loading screen says it is doing. The sidebar already has a name
  // for every page it links to -- its tooltip -- so the words come from there
  // rather than from a second list that could disagree with it.
  function label(page) {
    const file = String(page).split(/[?#]/)[0].toLowerCase();
    for (const a of document.querySelectorAll(".sidebar a[href]")) {
      if ((a.getAttribute("href") || "").split("/").pop().toLowerCase() !== file) continue;
      const li = a.querySelector("li") || a.closest("li");
      const span = (li || a).querySelector("span:not(.provider-icon)");
      const name = span && span.textContent && span.textContent.trim();
      if (name) return "Opening " + name + "…";
    }
    return "Loading...";
  }
  window.shellNavigate = navigate;

  // The sidebar's links, which are ordinary anchors so that each page still
  // works on its own. In the shell they must move the FRAME: left alone they
  // would navigate the shell to the page and the bars would go with it, which
  // is the whole thing this is here to stop.
  //
  // Captured, so this runs before the handler sidebar.js puts on the link for
  // the in-page case.
  document.addEventListener("click", (e) => {
    if (!e.target || !e.target.closest) return;
    // The button, not just the icon in it.
    //
    // Three of the sidebar's buttons have the link INSIDE the <li> and around
    // the icon alone -- the instance shortcuts, Skins and Settings -- so a
    // 24-pixel icon was the only part of a 50-pixel button that did anything,
    // and clicking the button next to its icon did nothing at all. Where a
    // click lands in a sidebar button that holds a link, the link is what was
    // meant.
    const a = e.target.closest("a[href]")
      || (() => {
        const li = e.target.closest(".sidebar li");
        return li ? li.querySelector("a[href]") : null;
      })();
    if (!a) return;
    const href = a.getAttribute("href");
    if (!ourPage(href)) return;                 // let the browser deal with it
    e.preventDefault();
    e.stopPropagation();
    navigate(href);
  }, true);

  // Which page is open.
  //
  // The shell cannot look: these are file:// documents, and a file:// page is
  // its own opaque origin, so reading a frame's location is not allowed --
  // in Electron as much as in a browser. So the page says, through a message
  // (see theme-boot.js), and the shell also remembers what it last navigated
  // to, for the moment before the page has had a chance to speak.
  let here = "";

  function markCurrent(page) {
    if (page) here = String(page).toLowerCase();
    if (!here) return;
    for (const a of document.querySelectorAll(".sidebar a[href]")) {
      const target = (a.getAttribute("href") || "").split("/").pop().toLowerCase();
      const button = a.querySelector("li")
        || (a.parentElement && a.parentElement.tagName === "LI" ? a.parentElement : null);
      if (!button) continue;
      button.classList.toggle("current", !!target && target === here);
    }
  }

  // The page tells us what it is and what it is called, for the same reason.
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (!m) return;
    if (m.rsShell === "page") {
      if (m.page) markCurrent(m.page);
      if (m.title) document.title = m.title;
      return;
    }
    // "I have finished loading" -- the moment the page would have taken its
    // own loading screen down, so it is the moment to take ours down.
    if (m.rsShell === "ready") loadingDown();
    // A page asking for the loading screen for something it is doing in
    // place -- going into an instance and back, say. Same screen, so what it
    // looks like and where it is never changes.
    if (m.rsShell === "loading") loadingUp(m.text || "Loading...");
    // A page changing page on its own, which the shell cannot see coming.
    // Only if the loading screen is not already up, so this does not restart
    // one the shell itself raised a moment ago and lose what it says.
    if (m.rsShell === "leaving" && overlay && !overlay.classList.contains("on")) loadingUp();
  });

  markCurrent();

  // ── Being told to show something ──────────────────────────────────────────
  //
  // A desktop shortcut or a redstonelauncher:// link names a page and some
  // parameters. The main process used to load that straight into the window,
  // which now would replace the shell; it asks for it to be framed instead.
  //
  // Asked for as well as listened for, because on a cold start the link is
  // dispatched while this page is still loading, and a message sent to a
  // window that is not listening yet goes nowhere.
  try {
    const { ipcRenderer } = require("electron");
    ipcRenderer.on("shell-navigate", (_e, page) => { navigate(page); });
    ipcRenderer.invoke("shell:pending").then((page) => { if (page) navigate(page); }).catch(() => { });
  } catch { /* not in the app */ }
})();
