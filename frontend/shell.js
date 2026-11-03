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

  /** Show a page in the frame. */
  function navigate(href) {
    const page = ourPage(href);
    if (!page) return false;
    // Same page, different query: still a navigation, because that is how
    // these pages are told which instance or server to open.
    frame.setAttribute("src", page);
    // Marked now rather than waiting to be told, so the sidebar answers the
    // click immediately instead of a beat later.
    markCurrent(page.split(/[?#]/)[0]);
    return true;
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
    const a = e.target && e.target.closest && e.target.closest("a[href]");
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
    if (!m || m.rsShell !== "page") return;
    if (m.page) markCurrent(m.page);
    if (m.title) document.title = m.title;
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
