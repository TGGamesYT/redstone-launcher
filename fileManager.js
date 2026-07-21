// Shared file-manager backend for the server AND instance file browsers.
// Everything is scoped to a root directory (traversal-guarded). It can also
// look *inside* .zip archives and read .gz files (both read-only).
import fs from "fs";
import path from "path";
import zlib from "zlib";
import AdmZip from "adm-zip";

// Resolve a repo-relative path safely under `root` (blocks ../ traversal).
export function safePath(root, rel) {
  const base = path.resolve(root);
  const target = path.resolve(path.join(base, rel || ""));
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}

// If any path component is an existing .zip FILE, return { zipPath, inner }
// where `inner` is the path *inside* the archive. Otherwise null.
function resolveArchive(root, rel) {
  const base = path.resolve(root);
  const parts = (rel || "").split("/").filter(Boolean);
  let cur = base;
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i]);
    if (cur !== base && !cur.startsWith(base + path.sep)) return null;
    if (/\.zip$/i.test(parts[i]) && fs.existsSync(cur) && fs.statSync(cur).isFile()) {
      return { zipPath: cur, inner: parts.slice(i + 1).join("/") };
    }
  }
  return null;
}

function isBinaryBuffer(buf) {
  return buf.slice(0, 8000).includes(0);
}

// List a directory (or a level inside a .zip). Folders first, then files.
export function listFiles(root, rel) {
  const arch = resolveArchive(root, rel);
  if (arch) return listInsideZip(arch.zipPath, arch.inner);

  const dir = safePath(root, rel);
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { path: rel || "", entries: [] };
  const entries = fs.readdirSync(dir, { withFileTypes: true }).map(d => {
    let size = 0;
    try { size = d.isFile() ? fs.statSync(path.join(dir, d.name)).size : 0; } catch { /* ignore */ }
    // .zip files are navigable like folders.
    return { name: d.name, isDir: d.isDirectory(), isArchive: !d.isDirectory() && /\.zip$/i.test(d.name), size };
  });
  entries.sort((a, b) => ((b.isDir || b.isArchive) - (a.isDir || a.isArchive)) || a.name.localeCompare(b.name));
  return { path: (rel || "").replace(/\\/g, "/"), entries };
}

function listInsideZip(zipPath, inner) {
  const prefix = inner ? inner.replace(/\/?$/, "/") : "";
  const seen = new Map(); // name -> entry
  try {
    const zip = new AdmZip(zipPath);
    for (const e of zip.getEntries()) {
      const name = e.entryName;
      if (!name.startsWith(prefix)) continue;
      const rest = name.slice(prefix.length);
      if (!rest) continue;
      const slash = rest.indexOf("/");
      if (slash === -1) {
        if (!e.isDirectory) seen.set(rest, { name: rest, isDir: false, isArchive: /\.zip$/i.test(rest), size: e.header.size });
      } else {
        const folder = rest.slice(0, slash);
        if (!seen.has(folder)) seen.set(folder, { name: folder, isDir: true, isArchive: false, size: 0 });
      }
    }
  } catch { /* ignore */ }
  const entries = [...seen.values()].sort((a, b) => ((b.isDir || b.isArchive) - (a.isDir || a.isArchive)) || a.name.localeCompare(b.name));
  return { path: (inner || ""), entries, readOnly: true };
}

// Read a file. Returns { text } / { text, readOnly } / { binary:true } / { error }.
export function readFile(root, rel) {
  const arch = resolveArchive(root, rel);
  if (arch) {
    try {
      const zip = new AdmZip(arch.zipPath);
      const entry = zip.getEntry(arch.inner);
      if (!entry || entry.isDirectory) return { error: "Not a file" };
      const buf = entry.getData();
      if (isBinaryBuffer(buf)) return { binary: true, readOnly: true };
      return { text: buf.toString("utf-8"), readOnly: true };
    } catch (e) { return { error: e.message }; }
  }

  const p = safePath(root, rel);
  if (!p || !fs.existsSync(p) || fs.statSync(p).isDirectory()) return { error: "Not a file" };
  try {
    let buf = fs.readFileSync(p);
    // .gz (e.g. rolled logs): decompress and show read-only.
    const isGz = /\.gz$/i.test(p) || (buf.length > 1 && buf[0] === 0x1f && buf[1] === 0x8b);
    if (isGz) {
      try {
        const out = zlib.gunzipSync(buf);
        if (isBinaryBuffer(out)) return { binary: true, readOnly: true };
        return { text: out.toString("utf-8"), readOnly: true };
      } catch (e) { return { error: "Could not decompress: " + e.message }; }
    }
    if (isBinaryBuffer(buf)) return { binary: true };
    return { text: buf.toString("utf-8") };
  } catch (e) { return { error: e.message }; }
}

export function writeFile(root, rel, text) {
  if (resolveArchive(root, rel)) return { error: "Files inside archives are read-only" };
  const p = safePath(root, rel);
  if (!p) return { error: "Invalid path" };
  if (/\.gz$/i.test(p)) return { error: "Compressed files are read-only" };
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return { success: true }; }
  catch (e) { return { error: e.message }; }
}

export function deleteFile(root, rel) {
  if (resolveArchive(root, rel)) return { error: "Files inside archives are read-only" };
  const p = safePath(root, rel);
  if (!p || p === path.resolve(root)) return { error: "Invalid path" };
  try { fs.rmSync(p, { recursive: true, force: true }); return { success: true }; }
  catch (e) { return { error: e.message }; }
}

export default { safePath, listFiles, readFile, writeFile, deleteFile };
