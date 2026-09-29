// Resolving which mod-loader build to actually launch.
//
// tomate-loaders' getMCLCLaunchConfig takes a `loaderVersion` in its type but
// never reads it, so the version a modpack pins was silently discarded. Worse,
// its Forge and NeoForge helpers pick `filteredVersions[0]` from the Maven
// metadata — and Maven lists versions oldest-first, so a 1.21.1 pack got
// NeoForge 21.1.1 (the very first build) instead of 21.1.252. That is why a
// pack whose mods need `[21.1.169,)` crashed on launch with
//   NoClassDefFoundError: net/neoforged/fml/loading/moddiscovery/
//                         ModFileParser$MixinConfig
// while the same pack ran fine in other launchers.
//
// This module resolves the loader build properly — the pinned one when the pack
// asks for one, the NEWEST matching build otherwise — and builds the MCLC
// config itself. Vanilla still goes through tomate-loaders, which handles it
// correctly.
import fs from "fs";
import path from "path";
import { vanilla } from "tomate-loaders";

const NEOFORGE_MAVEN = "https://maven.neoforged.net/releases/net/neoforged/neoforge";
const FORGE_MAVEN = "https://maven.minecraftforge.net/net/minecraftforge/forge";
const FABRIC_META = "https://meta.fabricmc.net/v2";
const QUILT_META = "https://meta.quiltmc.org/v3";

// Compare two dotted version strings numerically, so "21.1.9" sorts before
// "21.1.169" (a lexical sort puts them the other way round).
export function compareVersions(a, b) {
  const pa = String(a).split(/[.\-+]/), pb = String(b).split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = parseInt(pa[i], 10), nb = parseInt(pb[i], 10);
    const va = Number.isNaN(na) ? -1 : na, vb = Number.isNaN(nb) ? -1 : nb;
    if (va !== vb) return va - vb;
    if (va === -1 && (pa[i] || "") !== (pb[i] || "")) return (pa[i] || "") < (pb[i] || "") ? -1 : 1;
  }
  return 0;
}

async function mavenVersions(base) {
  const res = await fetch(`${base}/maven-metadata.xml`);
  if (!res.ok) throw new Error(`Could not read ${base} metadata (HTTP ${res.status})`);
  const xml = await res.text();
  return [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map(m => m[1]);
}

// NeoForge numbers its builds after the Minecraft version with the leading "1."
// dropped: 1.21.1 -> 21.1.x, and 1.21 (no patch) -> 21.0.x.
export function neoPrefix(gameVersion) {
  const parts = String(gameVersion).split(".");
  if (parts[0] !== "1" || !parts[1]) return null;
  return `${parts[1]}.${parts[2] || "0"}.`;
}

export async function resolveNeoForgeVersion(gameVersion, wanted) {
  const all = await mavenVersions(NEOFORGE_MAVEN);
  const prefix = neoPrefix(gameVersion);
  if (wanted) {
    const want = String(wanted).trim();
    if (all.includes(want)) return want;
    // A pack may pin a build that has since been pulled from the repo. Take the
    // newest build of the same line rather than failing the launch outright.
    const line = want.split(".").slice(0, 2).join(".") + ".";
    const sameLine = all.filter(v => v.startsWith(line) && !v.includes("-beta"));
    if (sameLine.length) return sameLine.sort(compareVersions)[sameLine.length - 1];
  }
  if (!prefix) throw new Error(`NeoForge has no builds for Minecraft ${gameVersion}`);
  const matching = all.filter(v => v.startsWith(prefix) && !v.includes("-beta"));
  if (!matching.length) throw new Error(`NeoForge has no builds for Minecraft ${gameVersion}`);
  return matching.sort(compareVersions)[matching.length - 1];
}

export async function resolveForgeVersion(gameVersion, wanted) {
  const all = await mavenVersions(FORGE_MAVEN);
  // Forge's Maven versions carry the game version: "1.21.1-52.0.44".
  const mine = all.filter(v => v.startsWith(gameVersion + "-"));
  if (wanted) {
    const want = String(wanted).trim();
    // A pack pins just the Forge part ("52.0.44"); accept either form.
    const full = want.startsWith(gameVersion + "-") ? want : `${gameVersion}-${want}`;
    if (all.includes(full)) return full;
  }
  if (!mine.length) throw new Error(`Forge has no builds for Minecraft ${gameVersion}`);
  return mine.sort((a, b) => compareVersions(a.slice(gameVersion.length + 1), b.slice(gameVersion.length + 1)))[mine.length - 1];
}

async function downloadTo(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}): ${url}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

// Both Forge and NeoForge hand MCLC an installer jar, which it unpacks into a
// version JSON. The jar is kept per resolved version so switching an instance's
// loader build doesn't reuse the previous one's installer.
async function installerConfig({ kind, rootPath, gameVersion, version, url }) {
  const dir = path.join(rootPath, "versions", `${kind}-${gameVersion}`);
  const jar = path.join(dir, `${kind}-${version}-installer.jar`);
  if (!fs.existsSync(jar) || !fs.statSync(jar).size) await downloadTo(url, jar);
  return {
    root: rootPath,
    clientPackage: null,
    version: { number: gameVersion, type: "release", custom: `${kind}-${gameVersion}` },
    forge: jar,   // MCLC's option name for "the loader installer", both kinds
    resolvedLoaderVersion: version,
  };
}

async function fabricLike({ meta, kind, rootPath, gameVersion, loaderVersion }) {
  let version = loaderVersion && String(loaderVersion).trim();
  if (!version) {
    const res = await fetch(`${meta}/versions/loader/${encodeURIComponent(gameVersion)}`);
    if (!res.ok) throw new Error(`No ${kind} builds for Minecraft ${gameVersion}`);
    const list = await res.json();
    // These APIs answer newest-first.
    const first = Array.isArray(list) ? list[0] : null;
    version = first && (first.loader ? first.loader.version : first.version);
    if (!version) throw new Error(`No ${kind} builds for Minecraft ${gameVersion}`);
  }
  const url = `${meta}/versions/loader/${encodeURIComponent(gameVersion)}/${encodeURIComponent(version)}/profile/json`;
  let res = await fetch(url);
  if (!res.ok && loaderVersion) {
    // The pinned build is gone; fall back to the newest rather than refusing.
    return fabricLike({ meta, kind, rootPath, gameVersion, loaderVersion: null });
  }
  if (!res.ok) throw new Error(`Could not fetch the ${kind} profile (HTTP ${res.status})`);
  const profile = await res.json();
  const dir = path.join(rootPath, "versions", `${kind}-${gameVersion}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${kind}-${gameVersion}.json`), JSON.stringify(profile));
  return {
    root: rootPath,
    version: { number: gameVersion, type: "release", custom: `${kind}-${gameVersion}` },
    resolvedLoaderVersion: version,
  };
}

/**
 * The MCLC launch config for an instance, honouring the loader build a modpack
 * pinned. `onNote` (optional) is called with a human-readable line about which
 * build was chosen, for the instance log.
 */
export async function getLaunchConfig({ loader, gameVersion, loaderVersion, rootPath }, onNote) {
  const note = (m) => { try { if (onNote) onNote(m); } catch { /* logging must not break a launch */ } };
  const pinned = loaderVersion ? String(loaderVersion).trim() : "";

  switch (String(loader || "vanilla").toLowerCase()) {
    case "neoforge": {
      const version = await resolveNeoForgeVersion(gameVersion, pinned);
      if (pinned && version !== pinned) note(`[loader] NeoForge ${pinned} is not available; using ${version}`);
      else note(`[loader] NeoForge ${version}${pinned ? " (pinned by the pack)" : " (newest for " + gameVersion + ")"}`);
      return installerConfig({
        kind: "neoforge", rootPath, gameVersion, version,
        url: `${NEOFORGE_MAVEN}/${version}/neoforge-${version}-installer.jar`,
      });
    }
    case "forge": {
      const version = await resolveForgeVersion(gameVersion, pinned);
      note(`[loader] Forge ${version}${pinned ? " (pinned by the pack)" : " (newest for " + gameVersion + ")"}`);
      return installerConfig({
        kind: "forge", rootPath, gameVersion, version,
        url: `${FORGE_MAVEN}/${version}/forge-${version}-installer.jar`,
      });
    }
    case "fabric": {
      const cfg = await fabricLike({ meta: FABRIC_META, kind: "fabric", rootPath, gameVersion, loaderVersion: pinned });
      note(`[loader] Fabric loader ${cfg.resolvedLoaderVersion}${pinned ? " (pinned by the pack)" : ""}`);
      return cfg;
    }
    case "quilt": {
      const cfg = await fabricLike({ meta: QUILT_META, kind: "quilt", rootPath, gameVersion, loaderVersion: pinned });
      note(`[loader] Quilt loader ${cfg.resolvedLoaderVersion}${pinned ? " (pinned by the pack)" : ""}`);
      return cfg;
    }
    default:
      return vanilla.getMCLCLaunchConfig({ gameVersion, rootPath });
  }
}
