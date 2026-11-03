// Everything the main process says reaches the page, not just the shell.
//
// `webContents.send` delivers to a window's MAIN frame and to nothing else.
// That was the whole window until the launcher became one page -- a shell
// holding the title bar and the sidebar, with whichever page you are on in a
// frame beneath them -- and from then on every broadcast stopped at the
// shell. The page in the frame heard none of it: not a line of a running
// game's log, not a launch's progress, not an instance crashing, not a list
// changing. What still worked did so by polling, which is why a log line was
// in Electron's own terminal at once and in the launcher a moment later.
//
// This is measured rather than assumed, in tests/ipcframes-test.mjs, which
// stands up a real window with a real frame and checks both halves: that a
// frame hears nothing without this, and hears it with.
//
// Patched once, here, rather than at each of the hundred-odd places that send
// something, so there is no second way of saying it for somebody to reach for
// by mistake. `event.reply` already goes to the frame that asked and is left
// alone.

/**
 * Make `webContents.send` reach every frame in the window.
 *
 * Called with Electron's `app` before any window exists.
 */
export function deliverToEveryFrame(app) {
  app.on("web-contents-created", (_e, wc) => patchWebContents(wc));
}

/** The same, for one webContents that already exists. */
export function patchWebContents(wc) {
  if (!wc || wc.__everyFrame) return wc;
  const toMainFrame = wc.send.bind(wc);
  wc.send = (channel, ...args) => {
    toMainFrame(channel, ...args);
    try {
      const top = wc.mainFrame;
      if (!top) return;
      for (const frame of top.framesInSubtree) {
        if (frame === top) continue;
        try { frame.send(channel, ...args); } catch { /* that frame has gone */ }
      }
    } catch { /* the window is on its way out */ }
  };
  wc.__everyFrame = true;
  return wc;
}

export default { deliverToEveryFrame, patchWebContents };
