/**
 * The icon an instance, server or project falls back to when it has none.
 *
 * This used to be an <img> pointed at https://tggamesyt.dev/assets/ — about
 * twenty of them, across ten pages — which meant the launcher could not draw
 * its own placeholder without a working internet connection and a third-party
 * host being up. The same block is already shipped with the launcher, in the
 * icon picker's own set, so it is used from there.
 *
 *   DEFAULT_ICON          the path, relative to frontend/
 *   instanceIcon(icon)    that icon, or the default when there isn't one
 *
 * instanceIcon also maps the old remote URL onto the local file, because it is
 * stored in profiles.json for every instance created before this: without that
 * those instances would keep fetching it forever.
 */
(function () {
  if (window.DEFAULT_ICON) return;

  const DEFAULT_ICON = 'assets/icons/Redstone_Ore_JE4_BE3.png';
  const LEGACY_REMOTE = 'https://tggamesyt.dev/assets/redstone_launcher_defaulticon.png';

  window.DEFAULT_ICON = DEFAULT_ICON;
  window.instanceIcon = function (icon) {
    if (!icon || icon === LEGACY_REMOTE) return DEFAULT_ICON;
    return icon;
  };

  // The icon for an instance that has none of its own.
  //
  // Every instance made before the version icons existed has no icon stored,
  // and they all came out as the same block of redstone ore -- a page of
  // identical rows that said nothing about any of them. An instance made today
  // is given its version's own render at the moment it is created, so the old
  // ones should show the same thing; they simply have nowhere to have stored
  // it. It is drawn on demand instead, and the main process keeps the drawing,
  // so a page of instances on one version costs one render between them.
  //
  // The redstone ore still goes up first and is replaced when the render
  // arrives, because the alternative is a hole in the list while it is drawn.
  // An instance that HAS an icon never reaches any of this.
  window.instanceIconInto = function (img, profile) {
    const own = profile && profile.icon;
    if (own && own !== LEGACY_REMOTE) { img.src = own; return; }
    img.src = DEFAULT_ICON;
    const version = profile && profile.version;
    if (!version || !window.VersionIcon) return;
    window.VersionIcon.get(version, (profile && profile.id) || null)
      .then((url) => {
        // Not if something else has taken the element over in the meantime --
        // these lists are rebuilt from under themselves constantly.
        if (url && img.isConnected && img.src.endsWith(DEFAULT_ICON)) img.src = url;
      })
      .catch(() => { /* the ore will do */ });
  };
})();
