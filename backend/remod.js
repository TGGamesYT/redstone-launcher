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

// The root of a mods.toml — everything before the first table header. That is
// where `loaderVersion`, `license` and `issueTrackerURL` live, and tomlSet
// deliberately cannot reach it because it works inside [[mods]].
function tomlRootEnd(text) {
  const m = /\n\s*\[/.exec(text);
  return m ? m.index : text.length;
}
function tomlGetRoot(text, key) {
  const head = text.slice(0, tomlRootEnd(text));
  const m = new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*(["'])([^\\n]*?)\\1`).exec(head);
  return m ? m[2] : "";
}
function tomlSetRoot(text, key, value) {
  const end = tomlRootEnd(text);
  const head = text.slice(0, end);
  const line = `${key}=${JSON.stringify(str(value))}`;
  const re = new RegExp(`(^|\\n)(\\s*)${key}\\s*=\\s*(["'])[^\\n]*?\\3`);
  if (re.test(head)) return head.replace(re, `$1$2${line}`) + text.slice(end);
  return head.replace(/\n*$/, "\n") + line + "\n" + text.slice(end);
}

// ── What a mod says it needs ────────────────────────────────────────────────
//
// Every manifest states this differently -- Fabric has five objects keyed by
// mod id, Forge has a [[dependencies.<modid>]] table apiece, a plugin.yml has
// three lists -- so they are read into one shape and written back out into
// whichever the format actually speaks:
//
//   { id, kind, versions, ordering, side }
//
// `kind` is one of required / optional / recommended / breaks / conflicts.
// A format with nowhere to put a kind gets the nearest thing it has, which is
// said out loud rather than silently dropped.
const DEP_KINDS = ["required", "optional", "recommended", "breaks", "conflicts"];
// Which key each kind lives under in a Fabric manifest.
const FABRIC_DEP_KEYS = {
  required: "depends", recommends: "recommends", recommended: "recommends",
  optional: "suggests", breaks: "breaks", conflicts: "conflicts",
};
const FABRIC_KEY_KINDS = { depends: "required", recommends: "recommended", suggests: "optional", breaks: "breaks", conflicts: "conflicts" };
// NeoForge names them; Forge only has mandatory true/false.
const NEO_TYPES = { required: "required", optional: "optional", recommended: "optional", breaks: "incompatible", conflicts: "discouraged" };
const NEO_TYPE_KINDS = { required: "required", optional: "optional", incompatible: "breaks", discouraged: "conflicts" };

const depKind = (k) => (DEP_KINDS.includes(k) ? k : "required");
// A version range as text, from whichever shape the manifest holds it in.
const rangeText = (v) => (Array.isArray(v) ? v.join(" || ") : str(v));
// And back: Fabric accepts a single string or a list, and a `||` list is
// clearer kept as a list.
const rangeValue = (t) => {
  const s = str(t).trim();
  if (!s) return "*";
  const parts = s.split("||").map(x => x.trim()).filter(Boolean);
  return parts.length > 1 ? parts : s;
};

// Which modId the [[mods]] block declares, needed to attach Forge's
// dependency tables to the right mod.
const tomlModId = (text) => tomlGet(text, "modId");

// Every [[dependencies.<who>]] block in a mods.toml, with where it sits.
function tomlDepBlocks(text) {
  const out = [];
  const re = /(^|\n)[ \t]*\[\[dependencies\.([^\]]+)\]\][ \t]*/g;
  let m;
  while ((m = re.exec(text))) {
    const start = m.index + (m[1] ? 1 : 0);
    const after = text.slice(m.index + m[0].length);
    const next = after.search(/\n[ \t]*\[/);
    out.push({
      who: m[2].replace(/^["']|["']$/g, ""),
      start,
      end: next < 0 ? text.length : m.index + m[0].length + next + 1,
    });
  }
  return out;
}
const tomlBlockGet = (body, key) => {
  const m = new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*(["'])([^\\n]*?)\\1`).exec(body);
  if (m) return m[2];
  const bare = new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*([^\\s"'][^\\n]*)`).exec(body);
  return bare ? bare[1].trim() : "";
};

export function readRequirements(dir, format) {
  const f = format || detectFormat(dir);
  const none = { supports: false, deps: [], loaderVersion: null, kinds: [] };
  if (!f) return none;
  try {
    if (f.id === "fabric") {
      const j = parseJson(readText(dir, f.file)) || {};
      const deps = [];
      for (const [key, kind] of Object.entries(FABRIC_KEY_KINDS)) {
        const o = j[key];
        if (!o || typeof o !== "object") continue;
        for (const [id, v] of Object.entries(o)) deps.push({ id, kind, versions: rangeText(v) });
      }
      return { supports: true, deps, loaderVersion: null, kinds: DEP_KINDS };
    }
    if (f.id === "quilt") {
      const q = (parseJson(readText(dir, f.file)) || {}).quilt_loader || {};
      const read = (v, kind) => (Array.isArray(v) ? v : []).map(d => (typeof d === "string"
        ? { id: d, kind, versions: "*" }
        : { id: str(d.id), kind, versions: rangeText(d.versions), optional: !!d.optional }));
      const deps = [
        ...read(q.depends, "required").map(d => (d.optional ? { ...d, kind: "optional" } : d)),
        ...read(q.breaks, "breaks"),
      ].map(({ optional, ...d }) => d);
      return { supports: true, deps, loaderVersion: null, kinds: ["required", "optional", "breaks"] };
    }
    if (f.id === "forge" || f.id === "neoforge") {
      const t = readText(dir, f.file) || "";
      const mine = tomlModId(t);
      const deps = [];
      for (const b of tomlDepBlocks(t)) {
        // A multi-mod jar can declare dependencies for each of its mods; only
        // the ones belonging to the mod being edited are shown.
        if (mine && b.who !== mine) continue;
        const body = t.slice(b.start, b.end);
        const type = tomlBlockGet(body, "type");
        const mandatory = tomlBlockGet(body, "mandatory");
        const kind = type
          ? (NEO_TYPE_KINDS[type.toLowerCase()] || "required")
          : (/^false$/i.test(mandatory) ? "optional" : "required");
        deps.push({
          id: tomlBlockGet(body, "modId"), kind,
          versions: tomlBlockGet(body, "versionRange"),
          ordering: tomlBlockGet(body, "ordering") || "",
          side: tomlBlockGet(body, "side") || "",
        });
      }
      return {
        supports: true, deps, loaderVersion: tomlGetRoot(t, "loaderVersion"),
        kinds: f.id === "neoforge" ? DEP_KINDS.filter(k => k !== "recommended") : ["required", "optional"],
        ordering: true,
      };
    }
    if (f.id === "mcmod") {
      const a = parseJson(readText(dir, f.file));
      const m = (Array.isArray(a) ? a[0] : (a && a.modList && a.modList[0])) || {};
      const list = [...(m.requiredMods || []), ...(m.dependencies || [])];
      // A 1.7–1.12 dependency is one string: "modid@[1.0,)".
      const deps = [...new Set(list.map(String))].map(s => {
        const at = s.indexOf("@");
        return at < 0 ? { id: s, kind: "required", versions: "" } : { id: s.slice(0, at), kind: "required", versions: s.slice(at + 1) };
      });
      return { supports: true, deps, loaderVersion: null, kinds: ["required"] };
    }
    if (f.id === "plugin" || f.id === "paper") {
      const t = readText(dir, f.file) || "";
      // depend/softdepend are inline `[a, b]` or a block list of `- a` lines.
      const listOf = (key) => {
        const inline = new RegExp(`^${key}:\\s*\\[(.*)\\]\\s*$`, "m").exec(t);
        if (inline) return inline[1].split(",").map(s => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
        const block = new RegExp(`^${key}:\\s*\\n((?:\\s*-\\s*.*\\n?)+)`, "m").exec(t);
        if (!block) return [];
        return block[1].split(/\n/).map(l => l.replace(/^\s*-\s*/, "").trim().replace(/^["']|["']$/g, "")).filter(Boolean);
      };
      const deps = [
        ...listOf("depend").map(id => ({ id, kind: "required", versions: "" })),
        ...listOf("softdepend").map(id => ({ id, kind: "optional", versions: "" })),
      ];
      return { supports: true, deps, loaderVersion: null, kinds: ["required", "optional"], versionless: true };
    }
  } catch { /* an unreadable manifest declares nothing we can edit */ }
  return none;
}

export function writeRequirements(dir, format, { deps, loaderVersion } = {}) {
  const f = format || detectFormat(dir);
  if (!f) return { error: "Nothing in this file declares what it needs" };
  const rows = (deps || []).map(d => ({
    id: str(d.id).trim(), kind: depKind(d.kind), versions: str(d.versions).trim(),
    ordering: str(d.ordering || "").trim(), side: str(d.side || "").trim(),
  })).filter(d => d.id);
  const notes = [];
  try {
    if (f.id === "fabric") {
      const j = parseJson(readText(dir, f.file)) || {};
      for (const key of Object.keys(FABRIC_KEY_KINDS)) delete j[key];
      for (const d of rows) {
        const key = FABRIC_DEP_KEYS[d.kind] || "depends";
        j[key] = j[key] || {};
        j[key][d.id] = rangeValue(d.versions);
      }
      writeText(dir, f.file, JSON.stringify(j, null, 2));
    } else if (f.id === "quilt") {
      const j = parseJson(readText(dir, f.file)) || {};
      j.quilt_loader = j.quilt_loader || {};
      const q = j.quilt_loader;
      q.depends = [];
      q.breaks = [];
      for (const d of rows) {
        const entry = { id: d.id, versions: rangeValue(d.versions) };
        if (d.kind === "breaks" || d.kind === "conflicts") {
          if (d.kind === "conflicts") notes.push(`Quilt has no "conflicts"; ${d.id} is written as breaks`);
          q.breaks.push(entry);
        } else {
          if (d.kind === "optional" || d.kind === "recommended") entry.optional = true;
          if (d.kind === "recommended") notes.push(`Quilt has no "recommended"; ${d.id} is written as an optional dependency`);
          q.depends.push(entry);
        }
      }
      if (!q.depends.length) delete q.depends;
      if (!q.breaks.length) delete q.breaks;
      writeText(dir, f.file, JSON.stringify(j, null, 2));
    } else if (f.id === "forge" || f.id === "neoforge") {
      let t = readText(dir, f.file) || "";
      if (loaderVersion != null && str(loaderVersion)) t = tomlSetRoot(t, "loaderVersion", loaderVersion);
      const mine = tomlModId(t) || "";
      // Cut our own dependency tables out, back to front so the earlier
      // offsets stay good, and write the new set at the end. Comments inside
      // a dependency table do not survive this; comments everywhere else do,
      // which is why the rest of the file is still edited in place.
      const blocks = tomlDepBlocks(t).filter(b => !mine || b.who === mine);
      for (const b of blocks.slice().reverse()) t = t.slice(0, b.start) + t.slice(b.end);
      t = t.replace(/\n{3,}$/, "\n\n");
      const who = mine || "mod";
      const out = [];
      for (const d of rows) {
        const lines = [`[[dependencies.${who}]]`, `modId=${JSON.stringify(d.id)}`];
        if (f.id === "neoforge") {
          lines.push(`type=${JSON.stringify(NEO_TYPES[d.kind] || "required")}`);
        } else {
          // Forge only knows mandatory or not.
          const mandatory = d.kind === "required";
          if (d.kind === "breaks" || d.kind === "conflicts") {
            notes.push(`Forge cannot say "${d.kind}"; ${d.id} is written as an optional dependency, which is the closest it has`);
          } else if (d.kind === "recommended") {
            notes.push(`Forge has no "recommended"; ${d.id} is written as optional`);
          }
          lines.push(`mandatory=${mandatory ? "true" : "false"}`);
        }
        lines.push(`versionRange=${JSON.stringify(d.versions || "[0,)")}`);
        lines.push(`ordering=${JSON.stringify(d.ordering || "NONE")}`);
        lines.push(`side=${JSON.stringify(d.side || "BOTH")}`);
        out.push(lines.join("\n"));
      }
      if (out.length) t = t.replace(/\n*$/, "\n\n") + out.join("\n\n") + "\n";
      writeText(dir, f.file, t);
    } else if (f.id === "mcmod") {
      const a = parseJson(readText(dir, f.file));
      const list = Array.isArray(a) ? a : (a && Array.isArray(a.modList) ? a.modList : null);
      if (!list || !list.length) return { error: "mcmod.info has no mod in it" };
      const m = list[0];
      const req = [], all = [];
      for (const d of rows) {
        if (d.kind !== "required") { notes.push(`mcmod.info can only say "required"; ${d.id} was left out`); continue; }
        const s = d.versions ? `${d.id}@${d.versions}` : d.id;
        req.push(s); all.push(s);
      }
      m.requiredMods = req;
      m.dependencies = all;
      writeText(dir, f.file, JSON.stringify(Array.isArray(a) ? list : a, null, 2));
    } else if (f.id === "plugin" || f.id === "paper") {
      let t = readText(dir, f.file) || "";
      const hard = [], soft = [];
      for (const d of rows) {
        if (d.versions) notes.push(`A plugin.yml cannot state a version range; ${d.id}'s was dropped`);
        if (d.kind === "required") hard.push(d.id);
        else if (d.kind === "optional" || d.kind === "recommended") soft.push(d.id);
        else notes.push(`A plugin.yml cannot say "${d.kind}"; ${d.id} was left out`);
      }
      const setList = (text, key, items) => {
        const line = items.length ? `${key}: [${items.map(i => JSON.stringify(i)).join(", ")}]` : null;
        const inline = new RegExp(`^${key}:\\s*\\[.*\\]\\s*$`, "m");
        const block = new RegExp(`^${key}:\\s*\\n(?:\\s*-\\s*.*\\n?)+`, "m");
        if (inline.test(text)) return line ? text.replace(inline, line) : text.replace(inline, "").replace(/\n{3,}/g, "\n\n");
        if (block.test(text)) return line ? text.replace(block, line + "\n") : text.replace(block, "");
        return line ? text.replace(/\n*$/, "\n") + line + "\n" : text;
      };
      t = setList(t, "depend", hard);
      t = setList(t, "softdepend", soft);
      writeText(dir, f.file, t);
    } else {
      return { error: `A ${f.id} file does not declare dependencies` };
    }
    return { success: true, notes };
  } catch (e) { return { error: e.message }; }
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

export default {
  detectFormat, readFields, writeFields, readRequirements, writeRequirements,
  iconPath, readIcon, writeIcon, unpack, repack,
};
