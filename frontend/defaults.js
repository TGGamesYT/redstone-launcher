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
})();
