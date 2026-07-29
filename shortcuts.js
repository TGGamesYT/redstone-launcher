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

// pngBuffer: optional Buffer with the chosen icon (PNG). Returns { path }.
export function createShortcut({ kind, id, name, action, pngBuffer }) {
  const label = safeName(name || id);
  const url = buildDeepLink({ kind, id, name, action });
  const desktop = app.getPath("desktop");
  fs.mkdirSync(desktop, { recursive: true });

  if (process.platform === "win32") {
    let iconLine = "";
    if (pngBuffer) {
      const ico = path.join(iconsDir(), `${label}.ico`);
      fs.writeFileSync(ico, pngToIco(pngBuffer));
      iconLine = `IconFile=${ico}\nIconIndex=0\n`;
    }
    const file = path.join(desktop, `${label}.url`);
    fs.writeFileSync(file, `[InternetShortcut]\nURL=${url}\n${iconLine}`);
    return { path: file };
  }

  if (process.platform === "darwin") {
    // Minimal .app bundle whose executable opens the deep link.
    const appDir = path.join(desktop, `${label}.app`);
    const macos = path.join(appDir, "Contents", "MacOS");
    const res = path.join(appDir, "Contents", "Resources");
    fs.mkdirSync(macos, { recursive: true });
    fs.mkdirSync(res, { recursive: true });
    const hasIcon = !!pngBuffer;
    if (hasIcon) fs.writeFileSync(path.join(res, "icon.icns"), pngToIcns(pngBuffer));
    fs.writeFileSync(path.join(appDir, "Contents", "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>CFBundleName</key><string>${label}</string>\n<key>CFBundleExecutable</key><string>run</string>\n<key>CFBundlePackageType</key><string>APPL</string>\n${hasIcon ? "<key>CFBundleIconFile</key><string>icon</string>\n" : ""}</dict></plist>\n`);
    const run = path.join(macos, "run");
    fs.writeFileSync(run, `#!/bin/bash\nopen "${url}"\n`);
    fs.chmodSync(run, 0o755);
    return { path: appDir };
  }

  // Linux .desktop
  let iconPath = "";
  if (pngBuffer) { iconPath = path.join(iconsDir(), `${label}.png`); fs.writeFileSync(iconPath, pngBuffer); }
  const exec = `"${process.execPath}" "${url}"`;
  const file = path.join(desktop, `${label}.desktop`);
  fs.writeFileSync(file,
    `[Desktop Entry]\nType=Application\nName=${label}\nExec=${exec}\n${iconPath ? `Icon=${iconPath}\n` : ""}Terminal=false\nCategories=Game;\n`);
  try { fs.chmodSync(file, 0o755); } catch { /* ignore */ }
  // Mark trusted (GNOME) so it's clickable without the "allow launching" prompt.
  return { path: file };
}

export default { createShortcut };
