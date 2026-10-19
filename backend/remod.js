// Remod — editing a mod jar or a resource pack that is already installed.
//
// A mod's name, description, version, authors and icon are not launcher
// metadata: they are declared inside the archive, in whichever manifest its
// loader reads. So changing them means unpacking the file, editing that
// manifest, and packing it back up EXACTLY as it was, or the loader stops
// recognising it. That is what this does, for every manifest the launcher
// already knows how to read, plus a resource pack's `pack.mcmeta`.
//
// The unpacked copy lives in a workspace folder so the launcher's own file
// browser can be pointed at it — "Edit assets" is that browser, rooted here —
// and the archive on disk is not touched until Save.
import fs from "fs";
import path from "path";
import AdmZip from "adm-zip";

// ── Which manifest an archive speaks ────────────────────────────────────────
// In the order the loaders themselves prefer: a jar carrying both a Quilt and
// a Fabric manifest is a Quilt mod to Quilt and a Fabric mod to Fabric, and
// the Quilt one is the more specific of the two.
const FORMATS = [
  { id: "quilt", file: "quilt.mod.json", kind: "mod" },
  { id: "fabric", file: "fabric.mod.json", kind: "mod" },
  { id: "neoforge", file: "META-INF/neoforge.mods.toml", kind: "mod" },
  { id: "forge", file: "META-INF/mods.toml", kind: "mod" },
  { id: "mcmod", file: "mcmod.info", kind: "mod" },
  { id: "plugin", file: "plugin.yml", kind: "plugin" },
  { id: "paper", file: "paper-plugin.yml", kind: "plugin" },
  { id: "pack", file: "pack.mcmeta", kind: "pack" },
];

// What each format can actually hold. A resource pack has a description and a
// picture and nothing else — offering it a version field would be offering to
// write something no pack format reads.
const SUPPORTS = {
  quilt: ["name", "description", "version", "authors", "icon"],
  fabric: ["name", "description", "version", "authors", "icon"],
  neoforge: ["name", "description", "version", "authors", "icon"],
  forge: ["name", "description", "version", "authors", "icon"],
  mcmod: ["name", "description", "version", "authors", "icon"],
  plugin: ["name", "description", "version", "authors"],
  paper: ["name", "description", "version", "authors"],
  pack: ["description", "icon"],
};

const readText = (dir, rel) => {
  try { return fs.readFileSync(path.join(dir, rel), "utf8"); } catch { return null; }
};
const writeText = (dir, rel, text) => {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
// A manifest can carry stray control characters; JSON.parse will not have them.
const parseJson = (text) => JSON.parse(String(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ""));
const str = (v) => (v == null ? "" : String(v));

// An author list comes in four shapes depending on the manifest: a string, an
// array of strings, an array of { name }, or Quilt's name → role map.
function authorsToText(v) {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(a => (a && typeof a === "object" ? str(a.name) : str(a))).filter(Boolean).join(", ");
  if (typeof v === "object") return Object.keys(v).join(", ");
  return "";
}
const authorsToList = (text) => str(text).split(",").map(s => s.trim()).filter(Boolean);

// ── TOML, edited as text ────────────────────────────────────────────────────
// Not parsed and re-emitted: a mods.toml is hand-written, with comments and an
// ordering its author chose, and rewriting it from a parse tree throws all of
// that away. Only the values asked for are replaced, in place.
//
// The edits are confined to the first [[mods]] block, because `version` means
// something else in a [[dependencies]] one.
function tomlModsBlock(text) {
  const start = text.indexOf("[[mods]]");
  if (start < 0) return null;
  const after = text.slice(start + 8);
  const next = after.search(/\n\s*\[\[/);
  return { start, end: next < 0 ? text.length : start + 8 + next };
}
function tomlSet(text, key, value) {
  const block = tomlModsBlock(text);
  const from = block ? block.start : 0;
  const to = block ? block.end : text.length;
  const body = text.slice(from, to);
  // `'''…'''` first: a multi-line description is the common case and its
  // delimiters would otherwise be read as an empty single-quoted string.
  const triple = new RegExp(`(^|\\n)(\\s*)${key}\\s*=\\s*('''|""")[\\s\\S]*?\\3`);
  const single = new RegExp(`(^|\\n)(\\s*)${key}\\s*=\\s*(["'])(?:[^\\n]*?)\\3`);
  const quoted = JSON.stringify(str(value));
  let out;
  if (triple.test(body)) {
    const m = triple.exec(body);
    out = body.replace(triple, `$1$2${key}=${m[3]}${str(value)}${m[3]}`);
  } else if (single.test(body)) {
    out = body.replace(single, `$1$2${key}=${quoted}`);
  } else if (block) {
    // Not declared yet: put it at the top of the block, where a
    // hand-written mods.toml keeps its own.
    out = body.replace(/^(\[\[mods\]\][^\n]*\n)/, `$1${key}=${quoted}\n`);
    if (out === body) out = body + `\n${key}=${quoted}\n`;
  } else {
    out = body + `\n[[mods]]\n${key}=${quoted}\n`;
  }
  return text.slice(0, from) + out + text.slice(to);
}
function tomlGet(text, key) {
  const block = tomlModsBlock(text);
  const body = block ? text.slice(block.start, block.end) : text;
  const triple = new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*('''|""")([\\s\\S]*?)\\1`).exec(body);
  if (triple) return triple[2].replace(/^\n/, "").replace(/\n$/, "");
  const single = new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*(["'])([^\\n]*?)\\1`).exec(body);
  return single ? single[2] : "";
}

// ── YAML, edited as text, one `key: value` line at a time ───────────────────
function ymlGet(text, key) {
  const m = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(text);
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
}
function ymlSet(text, key, value) {
  const line = `${key}: ${JSON.stringify(str(value))}`;
  const re = new RegExp(`^${key}:.*$`, "m");
  return re.test(text) ? text.replace(re, line) : (text.replace(/\n*$/, "\n") + line + "\n");
}

// ── Reading a workspace's declared fields ───────────────────────────────────
export function detectFormat(dir) {
  for (const f of FORMATS) if (fs.existsSync(path.join(dir, f.file))) return f;
  return null;
}

export function readFields(dir, format) {
  const f = format || detectFormat(dir);
  if (!f) return { fields: {}, supports: [] };
  const fields = { name: "", description: "", version: "", authors: "", icon: "" };
  try {
    if (f.id === "quilt") {
      const q = (parseJson(readText(dir, f.file)) || {}).quilt_loader || {};
      const md = q.metadata || {};
      Object.assign(fields, {
        name: str(md.name || q.id), description: str(md.description), version: str(q.version),
        authors: authorsToText(md.contributors), icon: typeof md.icon === "string" ? md.icon : "",
      });
    } else if (f.id === "fabric") {
      const j = parseJson(readText(dir, f.file)) || {};
      Object.assign(fields, {
        name: str(j.name || j.id), description: str(j.description), version: str(j.version),
        authors: authorsToText(j.authors), icon: typeof j.icon === "string" ? j.icon : "",
      });
    } else if (f.id === "forge" || f.id === "neoforge") {
      const t = readText(dir, f.file) || "";
      Object.assign(fields, {
        name: tomlGet(t, "displayName"), description: tomlGet(t, "description"),
        version: tomlGet(t, "version"), authors: tomlGet(t, "authors"),
        icon: tomlGet(t, "logoFile"),
      });
    } else if (f.id === "mcmod") {
      const a = parseJson(readText(dir, f.file));
      const m = (Array.isArray(a) ? a[0] : (a && a.modList && a.modList[0])) || {};
      Object.assign(fields, {
        name: str(m.name || m.modid), description: str(m.description), version: str(m.version),
        authors: authorsToText(m.authorList || m.authors), icon: str(m.logoFile),
      });
    } else if (f.id === "plugin" || f.id === "paper") {
      const t = readText(dir, f.file) || "";
      Object.assign(fields, {
        name: ymlGet(t, "name"), description: ymlGet(t, "description"),
        version: ymlGet(t, "version"), authors: ymlGet(t, "author") || ymlGet(t, "authors"),
      });
    } else if (f.id === "pack") {
      const j = parseJson(readText(dir, f.file)) || {};
      const p = j.pack || {};
      // A pack description can be a chat component rather than a string. Only
      // a plain one is editable as text; anything else is shown as its JSON so
      // nothing is silently flattened.
      fields.description = typeof p.description === "string" ? p.description : JSON.stringify(p.description ?? "");
      fields.icon = fs.existsSync(path.join(dir, "pack.png")) ? "pack.png" : "";
    }
  } catch { /* an unreadable manifest leaves the fields blank */ }
  return { fields, supports: SUPPORTS[f.id] || [], format: f.id, kind: f.kind, manifest: f.file };
}

export function writeFields(dir, format, fields) {
  const f = format || detectFormat(dir);
  if (!f) return { error: "Nothing in this file declares a name to change" };
  const has = (k) => Object.prototype.hasOwnProperty.call(fields || {}, k);
  try {
    if (f.id === "quilt") {
      const j = parseJson(readText(dir, f.file)) || {};
      j.quilt_loader = j.quilt_loader || {};
      const q = j.quilt_loader;
      q.metadata = q.metadata || {};
      if (has("name")) q.metadata.name = str(fields.name);
      if (has("description")) q.metadata.description = str(fields.description);
      if (has("version")) q.version = str(fields.version);
      if (has("authors")) {
        // Quilt's contributors is name → role. Keep the roles it already has.
        const old = (q.metadata.contributors && typeof q.metadata.contributors === "object") ? q.metadata.contributors : {};
        const out = {};
        for (const a of authorsToList(fields.authors)) out[a] = old[a] || "Author";
        q.metadata.contributors = out;
      }
      if (has("icon") && str(fields.icon)) q.metadata.icon = str(fields.icon);
      writeText(dir, f.file, JSON.stringify(j, null, 2));
    } else if (f.id === "fabric") {
      const j = parseJson(readText(dir, f.file)) || {};
      if (has("name")) j.name = str(fields.name);
      if (has("description")) j.description = str(fields.description);
      if (has("version")) j.version = str(fields.version);
      if (has("authors")) j.authors = authorsToList(fields.authors);
      if (has("icon") && str(fields.icon)) j.icon = str(fields.icon);
      writeText(dir, f.file, JSON.stringify(j, null, 2));
    } else if (f.id === "forge" || f.id === "neoforge") {
      let t = readText(dir, f.file) || "";
      if (has("name")) t = tomlSet(t, "displayName", fields.name);
      if (has("description")) t = tomlSet(t, "description", fields.description);
      if (has("version")) t = tomlSet(t, "version", fields.version);
      if (has("authors")) t = tomlSet(t, "authors", fields.authors);
      if (has("icon") && str(fields.icon)) t = tomlSet(t, "logoFile", fields.icon);
      writeText(dir, f.file, t);
    } else if (f.id === "mcmod") {
      const a = parseJson(readText(dir, f.file));
      const list = Array.isArray(a) ? a : (a && Array.isArray(a.modList) ? a.modList : null);
      if (!list || !list.length) return { error: "mcmod.info has no mod in it" };
      const m = list[0];
      if (has("name")) m.name = str(fields.name);
      if (has("description")) m.description = str(fields.description);
      if (has("version")) m.version = str(fields.version);
      if (has("authors")) m.authorList = authorsToList(fields.authors);
      if (has("icon") && str(fields.icon)) m.logoFile = str(fields.icon);
      writeText(dir, f.file, JSON.stringify(Array.isArray(a) ? list : a, null, 2));
    } else if (f.id === "plugin" || f.id === "paper") {
      let t = readText(dir, f.file) || "";
      if (has("name")) t = ymlSet(t, "name", fields.name);
      if (has("description")) t = ymlSet(t, "description", fields.description);
      if (has("version")) t = ymlSet(t, "version", fields.version);
      if (has("authors")) t = ymlSet(t, new RegExp("^authors:", "m").test(t) ? "authors" : "author", fields.authors);
      writeText(dir, f.file, t);
    } else if (f.id === "pack") {
      const j = parseJson(readText(dir, f.file)) || {};
      j.pack = j.pack || {};
      if (has("description")) {
        // Put a component back as a component if that is what it was and the
        // text still parses as one; otherwise it is a plain string.
        const was = j.pack.description;
        let next = str(fields.description);
        if (was && typeof was !== "string") {
          try { next = JSON.parse(next); } catch { /* a plain string it is */ }
        }
        j.pack.description = next;
      }
      writeText(dir, f.file, JSON.stringify(j, null, 2));
    }
    return { success: true };
  } catch (e) { return { error: e.message }; }
}

// Where this format wants its picture. A pack's is always pack.png; a mod's is
// wherever its manifest says, and a mod that declares none gets `icon.png`
// plus a line in the manifest pointing at it.
export function iconPath(dir, format) {
  const f = format || detectFormat(dir);
  if (!f) return null;
  if (f.id === "pack") return "pack.png";
  const { fields } = readFields(dir, f);
  const declared = str(fields.icon).replace(/^[./]+/, "");
  if (declared && !declared.includes("${")) return declared;
  for (const n of ["icon.png", "logo.png", "pack.png", "assets/icon.png"]) {
    if (fs.existsSync(path.join(dir, n))) return n;
  }
  return "icon.png";
}

export function readIcon(dir, format) {
  const rel = iconPath(dir, format);
  if (!rel) return null;
  try {
    const buf = fs.readFileSync(path.join(dir, rel));
    if (!buf.length) return null;
    return { path: rel, dataUrl: "data:image/png;base64," + buf.toString("base64") };
  } catch { return null; }
}

// Put a new picture in, and make sure the manifest points at it.
export function writeIcon(dir, format, buffer) {
  const f = format || detectFormat(dir);
  if (!f) return { error: "Nothing in this file declares an icon" };
  const rel = iconPath(dir, f);
  try {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, buffer);
    if (f.id !== "pack") writeFields(dir, f, { icon: rel });
    return { success: true, path: rel };
  } catch (e) { return { error: e.message }; }
}

// ── Unpacking and packing back ──────────────────────────────────────────────
// Unpack, and report the shape of what was unpacked so packing it back can
// reproduce it. `dirs` is the archive's own folder entries: a jar built by
// Gradle has one per package and a jar built by some other tool has none, and
// since an unpacked folder cannot tell you which it was, the answer has to be
// carried across rather than guessed.
export function unpack(archive, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const zip = new AdmZip(archive);
  const dirs = zip.getEntries().filter(e => e.isDirectory).map(e => e.entryName.replace(/\/+$/, ""));
  // extractAllTo rather than entry by entry: it makes the folders a nested
  // entry needs even when the archive declares none.
  zip.extractAllTo(dest, true);
  return { success: true, dirs };
}

// Re-zip the folder with the archive's structure intact: every path relative
// to the workspace root, forward slashes, no wrapper folder, and a folder
// entry wherever the original had one. The file is written beside its
// destination and moved into place, so a failure halfway through leaves the
// installed mod alone rather than truncated.
export function repack(dir, archive, { dirs = [] } = {}) {
  const zip = new AdmZip();
  const wanted = new Set((dirs || []).map(d => String(d).replace(/\/+$/, "")));
  const walk = (abs, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    // An empty folder exists only as its own entry, so it always gets one.
    if (rel && (wanted.has(rel) || !entries.length)) zip.addFile(rel + "/", Buffer.alloc(0));
    for (const e of entries) {
      const child = path.join(abs, e.name);
      const childRel = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) walk(child, childRel);
      else if (e.isFile()) zip.addFile(childRel, fs.readFileSync(child));
      // A symlink inside a mod jar is not a thing; skipped deliberately.
    }
  };
  walk(dir, "");
  const tmp = archive + ".remod-tmp";
  zip.writeZip(tmp);
  fs.renameSync(tmp, archive);
  return { success: true };
}

export default { detectFormat, readFields, writeFields, iconPath, readIcon, writeIcon, unpack, repack };
