// Joining one of your own servers from one of your own instances.
//
// Two different things stop a join, and they are worth telling apart because
// only one of them can be worked around. Either the client speaks a different
// protocol than the server -- which a translation mod on either end can
// bridge, and which nothing else can -- or the server runs mods the client has
// to run too, which no amount of translation helps with but which can simply
// be copied across.
//
// So every instance gets a verdict with its reason named, and the reason
// decides what is offered next: a version gap offers nothing but "join
// anyway", where missing mods offer to put them in. Nothing is ever hidden --
// an instance that cannot join is still listed with a "join anyway" button,
// because the launcher is guessing from file names and should not be the one
// to decide you may not try.

// Server software that runs plugins. Plugins are server-side only, so a
// plugin server is as joinable as a vanilla one of the same version.
export const PLUGIN_TYPES = ["paper", "purpur", "folia", "spigot", "bukkit"];
// Server software that runs mods, which the client usually needs as well.
export const MOD_TYPES = ["fabric", "quilt", "forge", "neoforge"];

// Which client loaders can join a server running each one. Quilt reads Fabric
// mods, so a Quilt instance can join a Fabric server; Forge and NeoForge share
// a history and nothing else, and a mod for one will not load in the other.
export const CLIENT_LOADERS = {
  fabric: ["fabric", "quilt"],
  quilt: ["quilt"],
  forge: ["forge"],
  neoforge: ["neoforge"],
};

// Translation on the SERVER, which lets clients of other versions in.
// ViaVersion carries newer clients onto an older server; ViaBackwards carries
// older clients onto a newer one; ViaRewind reaches back further still.
export const VIA_UP = ["viaversion", "protocolsupport"];
export const VIA_DOWN = ["viabackwards", "viarewind", "protocolsupport"];
// Translation on the CLIENT, which lets an instance join servers of other
// versions. These work in both directions, so one list covers it.
export const VIA_CLIENT = ["viafabricplus", "viafabric", "viaforge", "multiconnect", "viamcp"];

// A name as it is worth comparing: mod ids, display names and file names are
// written every which way ("ViaVersion", "via-version", "ViaVersion-5.0.1").
const norm = (s) => String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]+/g, "");

// Everything a jar might be known by. A mod we could not read at all still has
// its file name, which is usually enough to recognise one of the Via mods --
// and which is all a plugin jar with no readable plugin.yml ever gives us.
export function modKeys(m) {
  if (!m) return [];
  const file = String(m.filename || "")
    .replace(/\.(jar|zip)(\.disabled)?$/i, "")
    // Drop a trailing version so "ViaVersion-5.0.1" matches "viaversion".
    .replace(/[-_ ]*(v?\d[\w.+]*|mc\d[\w.]*)$/i, "");
  return [m.id, m.name, file].filter(Boolean).map(norm).filter(Boolean);
}

// Is this one of the named mods? Matched on the whole name rather than as a
// substring: "viaversion" must not be found inside some unrelated mod that
// merely mentions it.
const isOneOf = (m, names) => modKeys(m).some((k) => names.includes(k));
export const findOneOf = (list, names) => (list || []).find((m) => isOneOf(m, names)) || null;

export const serverKind = (type) => {
  const t = String(type || "").toLowerCase();
  if (MOD_TYPES.includes(t)) return "mods";
  if (PLUGIN_TYPES.includes(t)) return "plugins";
  return "plain";
};

// Minecraft versions, compared only when both are plain releases. A snapshot
// is named nothing like a release ("26w04a"), and guessing which side of a
// release it falls on would be a guess -- so the answer is "we do not know",
// and an unknown gap is treated as a gap.
const RELEASE = /^\d+\.\d+(\.\d+)?$/;
export function compareMc(a, b) {
  const x = String(a || "").trim(), y = String(b || "").trim();
  if (x && x === y) return 0;
  if (!RELEASE.test(x) || !RELEASE.test(y)) return null;
  const pa = x.split("."), pb = y.split(".");
  for (let i = 0; i < 3; i++) {
    const a1 = Number(pa[i] || 0), b1 = Number(pb[i] || 0);
    if (a1 !== b1) return a1 > b1 ? 1 : -1;
  }
  return 0;
}

// The mods a client has to have because the server has them. A Fabric mod can
// say which side it belongs on, and a server-only one is not the client's
// business -- without that, all we can do is assume it is needed, which is the
// safe way round: being told about a mod you did not need is a nuisance, and
// not being told about one you did need is a failed join.
export const clientSide = (mods) =>
  (mods || []).filter((m) => String((m && m.environment) || "").toLowerCase() !== "server");

// What stands between this instance and this server.
//
// `server`: { type, version, mods: [...], plugins: [...] }
// `instance`: { loader, version, mods: [...] }
// where a mod is { id, name, filename, environment }.
//
// Returns { level, reasons, missing, notes }:
//   level "ok"   -- nothing in the way
//         "no"   -- it will not work, and the reasons say why
//   `missing` names the server mods this instance has not got, which is the
//   one problem the caller can offer to fix.
export function judge(server, instance) {
  const reasons = [], notes = [];
  const kind = serverKind(server && server.type);
  const sType = String((server && server.type) || "").toLowerCase();
  const loader = String((instance && instance.loader) || "vanilla").toLowerCase();
  const sMods = (server && server.mods) || [];
  const sPlugins = (server && server.plugins) || [];
  const iMods = (instance && instance.mods) || [];
  let missing = [];

  // ── the loader ──
  let loaderFits = true;
  if (kind === "mods") {
    const allowed = CLIENT_LOADERS[sType] || [sType];
    if (!allowed.includes(loader)) {
      loaderFits = false;
      reasons.push(loader === "vanilla"
        ? `This server runs ${server.type} mods, and this instance has no mod loader.`
        : `This server runs ${server.type} mods, which ${instance.loader} cannot load.`);
    } else if (loader !== sType) {
      notes.push(`${instance.loader} can load this server's ${server.type} mods.`);
    }
  }

  // ── the version ──
  const cmp = compareMc(instance && instance.version, server && server.version);
  if (cmp !== 0) {
    // Translation anywhere closes the gap. Which end it sits on only changes
    // what we call it, so say which one is doing the work.
    const onServer = findOneOf(sPlugins.concat(sMods), cmp === null ? VIA_UP.concat(VIA_DOWN) : cmp > 0 ? VIA_UP : VIA_DOWN);
    const onClient = findOneOf(iMods, VIA_CLIENT);
    if (onServer) notes.push(`${instance.version} to the server's ${server.version}, through ${onServer.name || onServer.filename} on the server.`);
    else if (onClient) notes.push(`${instance.version} to the server's ${server.version}, through ${onClient.name || onClient.filename} in this instance.`);
    else reasons.push(cmp === null
      ? `This instance is on ${instance.version} and the server is on ${server.version}.`
      : `This instance is ${cmp > 0 ? "newer" : "older"} than the server: ${instance.version} against ${server.version}.`);
  }

  // ── the mods ──
  // Only worth working out once the loader is right. A Forge instance is not
  // "missing" a Fabric mod -- it could not load one, and saying so would offer
  // to copy jars in that would do nothing but break it.
  if (kind === "mods" && loaderFits) {
    const have = new Set();
    iMods.forEach((m) => modKeys(m).forEach((k) => have.add(k)));
    missing = clientSide(sMods).filter((m) => !modKeys(m).some((k) => have.has(k)));
    if (missing.length) {
      const shown = missing.slice(0, 3).map((m) => m.name || m.filename).join(", ");
      reasons.push(missing.length > 3
        ? `${missing.length} of the server's mods are not in this instance: ${shown}, and ${missing.length - 3} more.`
        : `The server has ${missing.length === 1 ? "a mod" : "mods"} this instance has not got: ${shown}.`);
    }
  }

  return { level: reasons.length ? "no" : "ok", reasons, notes, missing };
}

// What to build when none of your instances can join. A modded server wants
// its own loader, its own version and its own mods and nothing else, so that
// is exactly what this describes -- the mods are named by file so the caller
// copies the server's own jars rather than going looking for them again and
// landing on a different build.
export function planFor(server) {
  const kind = serverKind(server && server.type);
  const mods = kind === "mods" ? clientSide((server && server.mods) || []) : [];
  return {
    loader: kind === "mods" ? String(server.type).toLowerCase() : "vanilla",
    version: (server && server.version) || "",
    // A server's loader build is the one its mods were run against, so the
    // instance is pinned to it rather than to whatever is newest today.
    loaderVersion: kind === "mods" ? ((server && server.loaderVersion) || "") : "",
    mods: mods.map((m) => m.filename).filter(Boolean),
    // Named for the dialog: "a Fabric 1.21.4 instance with 23 mods".
    describe: kind === "mods"
      ? `${server.type} ${server.version}${mods.length ? ` with the server's ${mods.length} mod${mods.length === 1 ? "" : "s"}` : ""}`
      : `vanilla ${server.version}`,
  };
}

export default { PLUGIN_TYPES, MOD_TYPES, CLIENT_LOADERS, VIA_UP, VIA_DOWN, VIA_CLIENT, modKeys, findOneOf, serverKind, compareMc, clientSide, judge, planFor };
