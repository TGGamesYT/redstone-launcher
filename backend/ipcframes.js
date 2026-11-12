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
/**
 * Can this frame actually be sent to?
 *
 * A frame exists before its document does. In between -- while it is still
 * `about:blank`, while it is being replaced, once it has been detached --
 * there is nothing in it listening, and sending anyway prints
 *
 *   ERROR:electron_ipc_native.cc: Attempted to get the 'ipcNative' object
 *   but it was missing
 *
 * in the renderer. Not thrown, so the try/catch below never saw it: logged,
 * once per send per unready frame, which at startup is every broadcast the
 * main process makes while the launcher's first page is still loading.
 *
 * Asked each time rather than remembered, because a frame goes through this
 * state more than once: every page change is a new document in the same
 * frame.
 */
function canHear(frame) {
  try {
    if (!frame || frame.detached) return false;
    const url = String(frame.url || "");
    // No document yet, or the empty one a frame starts life with. Nothing
    // of ours is running in either.
    if (!url || url === "about:blank") return false;
    return true;
  } catch { return false; }        // being torn down as we looked at it
}

export function patchWebContents(wc) {
  if (!wc || wc.__everyFrame) return wc;
  const toMainFrame = wc.send.bind(wc);
  wc.send = (channel, ...args) => {
    toMainFrame(channel, ...args);
    try {
      const top = wc.mainFrame;
      if (!top) return;
      for (const frame of top.framesInSubtree) {
        if (frame === top || !canHear(frame)) continue;
        try { frame.send(channel, ...args); } catch { /* that frame has gone */ }
      }
    } catch { /* the window is on its way out */ }
  };
  wc.__everyFrame = true;
  return wc;
}

export default { deliverToEveryFrame, patchWebContents };
