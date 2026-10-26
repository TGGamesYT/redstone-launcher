// Cross-platform desktop-shortcut creation for Redstone Launcher.
// Shortcuts invoke the app's deep-link protocol (redstonelauncher://…); the main
// process navigates to the right page and performs the action. Windows uses a
// .url internet shortcut, Linux a .desktop file, macOS a tiny .app bundle. Icons
// are embedded by wrapping the PNG into .ico / .icns (both formats can hold a
// raw PNG), so no native image library is needed.
import fs from "fs";
import path from "path";
import os from "os";
import { app } from "electron";
import { execFileSync } from "child_process";

// --- PNG → .ico (single image; ICO may embed a PNG payload directly) ---
function pngDimensions(png) {
  // IHDR width/height are big-endian uint32 at offsets 16 and 20.
  try { return { w: png.readUInt32BE(16), h: png.readUInt32BE(20) }; } catch { return { w: 256, h: 256 }; }
}
function pngToIco(png) {
  const { w, h } = pngDimensions(png);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);        // reserved
  header.writeUInt16LE(1, 2);        // type: icon
  header.writeUInt16LE(1, 4);        // image count
  const entry = Buffer.alloc(16);
  entry.writeUInt8(w >= 256 ? 0 : w, 0);
  entry.writeUInt8(h >= 256 ? 0 : h, 1);
  entry.writeUInt8(0, 2);            // colors in palette
  entry.writeUInt8(0, 3);            // reserved
  entry.writeUInt16LE(1, 4);         // color planes
  entry.writeUInt16LE(32, 6);        // bits per pixel
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(6 + 16, 12);   // offset to image data
  return Buffer.concat([header, entry, png]);
}
// --- PNG → .icns (embed as an 'ic08' 256px PNG entry) ---
function pngToIcns(png) {
  const type = Buffer.from("ic08", "ascii"); // 256×256 PNG
  const entryLen = 8 + png.length;
  const entryHdr = Buffer.alloc(8);
  type.copy(entryHdr, 0);
  entryHdr.writeUInt32BE(entryLen, 4);
  const body = Buffer.concat([entryHdr, png]);
  const magic = Buffer.from("icns", "ascii");
  const fileHdr = Buffer.alloc(8);
  magic.copy(fileHdr, 0);
  fileHdr.writeUInt32BE(8 + body.length, 4);
  return Buffer.concat([fileHdr, body]);
}

function iconsDir() {
  const d = path.join(app.getPath("userData"), "shortcut-icons");
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function safeName(s) { return String(s || "shortcut").replace(/[<>:"/\\|?*\x00-\x1f]+/g, " ").trim() || "shortcut"; }

function buildDeepLink({ kind, id, name, action }) {
  const p = new URLSearchParams();
  if (kind === "server") { p.set("name", name || id); }
  else { p.set("id", id); if (action) for (const [k, v] of Object.entries(action)) if (v != null && v !== "") p.set(k, String(v)); }
  return `redstonelauncher://${kind}?${p.toString()}`;
}

// pngBuffer: optional Buffer with the chosen icon (PNG).
// Returns { path, iconPath } — iconPath is the on-disk icon file (so it can be
// rewritten later for auto-updating icons), or null when no icon was set.
export function createShortcut({ kind, id, name, action, pngBuffer }) {
  const label = safeName(name || id);
  const url = buildDeepLink({ kind, id, name, action });
  const desktop = app.getPath("desktop");
  fs.mkdirSync(desktop, { recursive: true });

  if (process.platform === "win32") {
    let iconLine = "", iconPath = null;
    if (pngBuffer) {
      iconPath = path.join(iconsDir(), `${label}.ico`);
      fs.writeFileSync(iconPath, pngToIco(pngBuffer));
      iconLine = `IconFile=${iconPath}\nIconIndex=0\n`;
    }
    const file = path.join(desktop, `${label}.url`);
    fs.writeFileSync(file, `[InternetShortcut]\nURL=${url}\n${iconLine}`);
    return { path: file, iconPath };
  }

  if (process.platform === "darwin") {
    // Minimal .app bundle whose executable opens the deep link.
    const appDir = path.join(desktop, `${label}.app`);
    const macos = path.join(appDir, "Contents", "MacOS");
    const res = path.join(appDir, "Contents", "Resources");
    fs.mkdirSync(macos, { recursive: true });
    fs.mkdirSync(res, { recursive: true });
    const hasIcon = !!pngBuffer;
    let iconPath = null;
    if (hasIcon) { iconPath = path.join(res, "icon.icns"); fs.writeFileSync(iconPath, pngToIcns(pngBuffer)); }
    fs.writeFileSync(path.join(appDir, "Contents", "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>CFBundleName</key><string>${label}</string>\n<key>CFBundleExecutable</key><string>run</string>\n<key>CFBundlePackageType</key><string>APPL</string>\n${hasIcon ? "<key>CFBundleIconFile</key><string>icon</string>\n" : ""}</dict></plist>\n`);
    const run = path.join(macos, "run");
    fs.writeFileSync(run, `#!/bin/bash\nopen "${url}"\n`);
    fs.chmodSync(run, 0o755);
    return { path: appDir, iconPath };
  }

  // Linux .desktop
  let iconPath = null;
  if (pngBuffer) { iconPath = path.join(iconsDir(), `${label}.png`); fs.writeFileSync(iconPath, pngBuffer); }
  const exec = `"${process.execPath}" "${url}"`;
  const file = path.join(desktop, `${label}.desktop`);
  fs.writeFileSync(file,
    `[Desktop Entry]\nType=Application\nName=${label}\nExec=${exec}\n${iconPath ? `Icon=${iconPath}\n` : ""}Terminal=false\nCategories=Game;\n`);
  try { fs.chmodSync(file, 0o755); } catch { /* ignore */ }
  // Mark trusted (GNOME) so it's clickable without the "allow launching" prompt.
  return { path: file, iconPath };
}

// Rewrite an existing shortcut icon file in place with a new PNG, re-encoding to
// whatever format the icon path expects (.ico / .icns / .png). Used to keep a
// shortcut's icon in sync with its source (e.g. an instance server's icon).
export function rewriteIcon(iconPath, pngBuffer) {
  if (!iconPath || !pngBuffer) return false;
  try {
    const ext = path.extname(iconPath).toLowerCase();
    if (ext === ".ico") fs.writeFileSync(iconPath, pngToIco(pngBuffer));
    else if (ext === ".icns") fs.writeFileSync(iconPath, pngToIcns(pngBuffer));
    else fs.writeFileSync(iconPath, pngBuffer);
    return true;
  } catch { return false; }
}

// ── The launcher's own icon, outside the launcher ───────────────────────────
//
// Setting a window's icon changes it in the taskbar while the app is running
// and nowhere else, which is why the icon on the desktop stayed red. The
// desktop entry has to be told separately, and each platform keeps it
// somewhere different:
//
//   Windows — the installer leaves a .lnk, whose icon lives inside the
//     shortcut file. A .lnk is a COM object, so it is rewritten through the
//     Windows Script Host, the way any installer would.
//   Linux — a .desktop file with an `Icon=` line, rewritten in place.
//   macOS — the icon belongs to the .app bundle and is signed with it;
//     nothing here touches that, and it is reported as untouched rather than
//     silently doing nothing.
//
// Returns the files it managed to change, so the launcher can say what
// happened instead of claiming more than it did.
// A name of its own for each version of the icon.
//
// Both shells cache an icon against the file it came from, so rewriting the
// same `app.ico` or `app.png` left the old picture on the desktop until the
// cache happened to be rebuilt -- which is why a change of theme was not
// visible out there until a reboot. A path that has never been seen before
// cannot have a cached icon, so each write gets a fresh name and the ones
// before it are cleared away afterwards.
function freshIconPath(dir, ext) {
  return path.join(dir, `app-${Date.now().toString(36)}${ext}`);
}
function sweepOldIcons(dir, ext, keep) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  // Exactly the names freshIconPath makes, plus the single fixed name used
  // before it. An instance's own shortcut icon is `<label>.png` and must not
  // be caught by this, however the instance happens to be called.
  const mine = new RegExp(`^app(-[0-9a-z]+)?\\${ext}$`);
  for (const n of names) {
    if (!mine.test(n)) continue;
    const full = path.join(dir, n);
    if (full === keep) continue;
    // Still referenced by a shortcut that was not ours to change: leaving a
    // few stale files behind is better than blanking somebody's icon.
    try { fs.unlinkSync(full); } catch { /* it will go next time */ }
  }
}

// Tell Explorer the association changed, so it re-reads the shortcuts rather
// than redrawing them from its cache at some point of its own choosing.
function nudgeWindowsShell() {
  const ps = "$sig='[DllImport(\"shell32.dll\")]public static extern void SHChangeNotify("
    + "int wEventId,uint uFlags,IntPtr dwItem1,IntPtr dwItem2);';"
    + "$t=Add-Type -MemberDefinition $sig -Name Sh -Namespace W -PassThru;"
    + "$t::SHChangeNotify(0x08000000,0x0000,[IntPtr]::Zero,[IntPtr]::Zero)";
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps],
      { windowsHide: true, timeout: 15000 });
  } catch { /* the icon is written either way; this only makes it immediate */ }
}

export function setAppShortcutIcon(pngBuffer, { appName = "Redstone Launcher", exec } = {}) {
  if (!pngBuffer) return { updated: [], skipped: ["no icon given"] };
  const updated = [], skipped = [];
  const dir = iconsDir();
  const desktop = (() => { try { return app.getPath("desktop"); } catch { return null; } })();
  const home = os.homedir();

  try {
    if (process.platform === "win32") {
      const ico = freshIconPath(dir, ".ico");
      fs.writeFileSync(ico, pngToIco(pngBuffer));
      // Wherever an installer puts them: the desktop, and the Start menu for
      // this user and for everybody.
      const places = [
        desktop,
        path.join(home, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs"),
        path.join(process.env.ProgramData || "C:\\ProgramData", "Microsoft", "Windows", "Start Menu", "Programs"),
      ].filter(Boolean);
      const links = [];
      for (const place of places) {
        let names = [];
        try { names = fs.readdirSync(place); } catch { continue; }
        for (const n of names) {
          if (!/\.lnk$/i.test(n)) continue;
          if (!n.toLowerCase().includes(appName.toLowerCase().split(" ")[0])) continue;
          links.push(path.join(place, n));
        }
      }
      if (!links.length) skipped.push("no shortcut found to change");
      for (const lnk of links) {
        // One quoted script, so a path with spaces or an apostrophe in the
        // user's name survives. Doubling a single quote is how PowerShell
        // escapes one inside a single-quoted string.
        const q = (v) => String(v).replace(/'/g, "''");
        const ps = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${q(lnk)}');`
          + `$s.IconLocation='${q(ico)},0';$s.Save()`;
        try {
          execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps],
            { windowsHide: true, timeout: 15000 });
          updated.push(lnk);
        } catch (e) { skipped.push(`${path.basename(lnk)}: ${e.message}`); }
      }
      if (updated.length) { nudgeWindowsShell(); sweepOldIcons(dir, ".ico", ico); }
      return { updated, skipped, icon: ico };
    }

    if (process.platform === "darwin") {
      return { updated: [], skipped: ["a macOS app's icon belongs to its signed bundle"] };
    }

    // Linux: the .desktop entries, wherever they are.
    const png = freshIconPath(dir, ".png");
    fs.writeFileSync(png, pngBuffer);
    const places = [desktop, path.join(home, ".local", "share", "applications")].filter(Boolean);
    const want = appName.toLowerCase().split(" ")[0];
    let found = 0;
    for (const place of places) {
      let names = [];
      try { names = fs.readdirSync(place); } catch { continue; }
      for (const n of names) {
        if (!/\.desktop$/i.test(n)) continue;
        const full = path.join(place, n);
        let text = "";
        try { text = fs.readFileSync(full, "utf8"); } catch { continue; }
        // Ours, not every shortcut on the desktop: either the file is named
        // after the app or its Exec points at this very binary.
        const mine = n.toLowerCase().includes(want)
          || (exec && text.includes(exec))
          || text.includes(process.execPath);
        if (!mine) continue;
        found++;
        const next = /^Icon=.*$/m.test(text)
          ? text.replace(/^Icon=.*$/m, `Icon=${png}`)
          : text.replace(/^\[Desktop Entry\]\s*$/m, `[Desktop Entry]\nIcon=${png}`);
        try { fs.writeFileSync(full, next); updated.push(full); }
        catch (e) { skipped.push(`${n}: ${e.message}`); }
      }
    }
    if (!found) skipped.push("no desktop entry found to change");
    if (updated.length) sweepOldIcons(dir, ".png", png);
    return { updated, skipped, icon: png };
  } catch (e) {
    return { updated, skipped: [...skipped, String(e && e.message || e)] };
  }
}

export default { createShortcut, rewriteIcon, setAppShortcutIcon };
