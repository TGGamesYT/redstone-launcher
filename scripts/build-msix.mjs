// Package the built Windows app as an MSIX, for the Microsoft Store.
//
// Runs after `npm run buildWin`, on Windows, from what electron-builder left
// in dist/win-unpacked: the same files the NSIS installer installs, wrapped in
// an MSIX with a manifest instead. makeappx.exe (part of the Windows SDK, which
// GitHub's windows runners have) does the packing.
//
// The package is NOT signed. The Store signs what it publishes with its own
// certificate, and Partner Center refuses nothing for arriving unsigned; a
// signed package is only needed to install one by hand, outside the Store.
//
// What goes in the manifest comes from the environment, because it is the
// Store's to decide, not the code's -- Partner Center hands out all three
// under Product management -> Product identity:
//
//   MS_STORE_IDENTITY_NAME             Package/Identity/Name
//   MS_STORE_PUBLISHER                 Package/Identity/Publisher  ("CN=...")
//   MS_STORE_PUBLISHER_DISPLAY_NAME    Package/Properties/PublisherDisplayName
//
// Usage: node scripts/build-msix.mjs [--out dist/Redstone-Launcher.msix]
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const OUT = path.resolve(ROOT, outAt >= 0 ? args[outAt + 1] : "dist/Redstone-Launcher.msix");

const need = (name) => {
  const v = String(process.env[name] || "").trim();
  if (!v) { console.error(`${name} is not set. See docs/microsoft-store.md.`); process.exit(1); }
  return v;
};
const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The Store's version: four numbers, the last of them 0. The fourth is
 * reserved for the Store's own use, and a package that sets it is refused.
 */
export function storeVersion(v) {
  const nums = String(v).split(/[.+-]/).map(n => parseInt(n, 10)).filter(Number.isFinite).slice(0, 3);
  while (nums.length < 3) nums.push(0);
  return [...nums, 0].join(".");
}

/** The manifest, from the identity Partner Center gave out. */
export function manifest({ identity, publisher, publisherDisplayName, version, exe }) {
  return `<?xml version="1.0" encoding="utf-8"?>
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:desktop6="http://schemas.microsoft.com/appx/manifest/desktop/windows10/6"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap desktop6 rescap">
  <Identity Name="${xml(identity)}" Publisher="${xml(publisher)}" Version="${xml(version)}" ProcessorArchitecture="x64" />
  <Properties>
    <DisplayName>Redstone Launcher</DisplayName>
    <PublisherDisplayName>${xml(publisherDisplayName)}</PublisherDisplayName>
    <Logo>assets\\StoreLogo.png</Logo>
    <!-- The launcher keeps everything (instances, Java, assets, worlds) in
         %APPDATA%\\Redstone Launcher, and other programs have to be able to
         see it there: Explorer when "Open folder" is pressed, the game's own
         Java, Gradle for a dev instance, desktop shortcuts' icon files.
         Packaged apps have those writes redirected into a private copy by
         default, which every one of those would miss. -->
    <desktop6:FileSystemWriteVirtualization>disabled</desktop6:FileSystemWriteVirtualization>
    <desktop6:RegistryWriteVirtualization>disabled</desktop6:RegistryWriteVirtualization>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.18362.0" MaxVersionTested="10.0.26100.0" />
  </Dependencies>
  <Resources>
    <Resource Language="en-us" />
  </Resources>
  <Applications>
    <Application Id="RedstoneLauncher" Executable="${xml(exe)}" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements
        DisplayName="Redstone Launcher"
        Description="A Minecraft launcher."
        BackgroundColor="transparent"
        Square150x150Logo="assets\\Square150x150Logo.png"
        Square44x44Logo="assets\\Square44x44Logo.png">
        <uap:DefaultTile Wide310x150Logo="assets\\Wide310x150Logo.png" />
      </uap:VisualElements>
      <Extensions>
        <!-- Desktop shortcuts to instances and servers are redstonelauncher://
             links. A packaged app cannot register a protocol at run time, so
             it is declared here instead. -->
        <uap:Extension Category="windows.protocol">
          <uap:Protocol Name="redstonelauncher">
            <uap:DisplayName>Redstone Launcher</uap:DisplayName>
          </uap:Protocol>
        </uap:Extension>
      </Extensions>
    </Application>
  </Applications>
  <Capabilities>
    <Capability Name="internetClient" />
    <rescap:Capability Name="runFullTrust" />
    <rescap:Capability Name="unvirtualizedResources" />
  </Capabilities>
</Package>
`;
}

/** makeappx.exe, from the newest Windows SDK on this computer. */
function findMakeAppx() {
  const kits = path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Windows Kits", "10", "bin");
  let versions = [];
  try { versions = fs.readdirSync(kits).filter(v => /^10\./.test(v)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })); } catch { /* none */ }
  for (const v of versions) {
    const at = path.join(kits, v, "x64", "makeappx.exe");
    if (fs.existsSync(at)) return at;
  }
  return null;
}

async function main() {
  const identity = need("MS_STORE_IDENTITY_NAME");
  const publisher = need("MS_STORE_PUBLISHER");
  const publisherDisplayName = need("MS_STORE_PUBLISHER_DISPLAY_NAME");

  const unpacked = path.join(ROOT, "dist", "win-unpacked");
  if (!fs.existsSync(unpacked)) { console.error("dist/win-unpacked is not there: run npm run buildWin first."); process.exit(1); }
  const exe = fs.readdirSync(unpacked).find(n => n.toLowerCase() === `${String(pkg.productName || pkg.name).toLowerCase()}.exe`)
    || fs.readdirSync(unpacked).find(n => /\.exe$/i.test(n) && !/uninst|elevate|crashpad/i.test(n));
  if (!exe) { console.error("No launcher .exe in dist/win-unpacked."); process.exit(1); }

  const stage = path.join(ROOT, "dist", "msix-stage");
  fs.rmSync(stage, { recursive: true, force: true });
  fs.cpSync(unpacked, stage, { recursive: true });

  // The tiles, out of the launcher's own logo.
  const logo = path.join(ROOT, "frontend", "assets", "icon", "redstone_logo.png");
  const assets = path.join(stage, "assets");
  fs.mkdirSync(assets, { recursive: true });
  const square = (n, file) => sharp(logo).resize(n, n, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(path.join(assets, file));
  await square(44, "Square44x44Logo.png");
  await square(150, "Square150x150Logo.png");
  await square(50, "StoreLogo.png");
  await sharp({ create: { width: 310, height: 150, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: await sharp(logo).resize(120, 120).png().toBuffer(), gravity: "center" }])
    .png().toFile(path.join(assets, "Wide310x150Logo.png"));

  const version = storeVersion(pkg.version);
  fs.writeFileSync(path.join(stage, "AppxManifest.xml"),
    manifest({ identity, publisher, publisherDisplayName, version, exe }));

  const makeappx = findMakeAppx();
  if (!makeappx) { console.error("makeappx.exe was not found: the Windows 10/11 SDK is needed."); process.exit(1); }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  execFileSync(makeappx, ["pack", "/d", stage, "/p", OUT, "/o"], { stdio: "inherit" });
  console.log(`Packed ${path.relative(ROOT, OUT)} -- ${identity} ${version}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
