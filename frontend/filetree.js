// Collapsible, editable tree view for prismarine-nbt tagged data AND plain JSON.
// Used by the server + instance file managers for .dat / .json files, with a
// toggle to raw-JSON text. Edits mutate the passed-in data object in place and
// fire onChange(); the caller serialises and saves.
(function () {
  const EXPAND = "▸", COLLAPSE = "▾";
  const NBT_CONTAINER = new Set(["compound", "list", "byteArray", "intArray", "longArray"]);

  function el(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }

  // prismarine-nbt stores longs as [high, low] 32-bit ints.
  function longToNum(v) { if (Array.isArray(v)) { const [hi, lo] = v; return hi * 4294967296 + (lo >>> 0); } return Number(v); }
  function numToLong(n) { n = Math.trunc(Number(n)) || 0; return [Math.floor(n / 4294967296), (n >>> 0)]; }

  // ---------- adapters ----------
  const nbtAdapter = {
    isContainer: (d) => d && NBT_CONTAINER.has(d.type),
    brace(d) {
      if (d.type === "compound") return "{" + Object.keys(d.value).length + "}";
      if (d.type === "list") return "[" + d.value.value.length + "]";
      return "[" + d.value.length + "]";
    },
    children(d) {
      if (d.type === "compound") {
        return Object.keys(d.value).map(k => ({ key: k, desc: d.value[k], setVal: (v) => { d.value[k].value = v; } }));
      }
      if (d.type === "list") {
        const et = d.value.type, arr = d.value.value;
        return arr.map((elv, i) => ({ key: String(i), desc: { type: et, value: elv }, setVal: (v) => { arr[i] = v; } }));
      }
      const arr = d.value;
      const et = d.type === "byteArray" ? "byte" : d.type === "intArray" ? "int" : "long";
      return arr.map((elv, i) => ({ key: String(i), desc: { type: et, value: elv }, setVal: (v) => { arr[i] = v; } }));
    },
    leafText: (d) => d.type === "long" ? String(longToNum(d.value)) : String(d.value),
    typeTag: (d) => d.type,
    parseLeaf(d, raw) {
      if (d.type === "string") return raw;
      if (d.type === "long") return numToLong(raw);
      const n = Number(raw); return Number.isNaN(n) ? d.value : n;
    },
  };

  const jsonAdapter = {
    isContainer: (d) => d !== null && typeof d === "object",
    brace: (d) => Array.isArray(d) ? "[" + d.length + "]" : "{" + Object.keys(d).length + "}",
    children(d) {
      if (Array.isArray(d)) return d.map((v, i) => ({ key: String(i), desc: v, setVal: (nv) => { d[i] = nv; } }));
      return Object.keys(d).map(k => ({ key: k, desc: d[k], setVal: (nv) => { d[k] = nv; } }));
    },
    leafText: (d) => d === null ? "null" : String(d),
    typeTag: (d) => typeof d,
    parseLeaf(d, raw) {
      if (typeof d === "number") { const n = Number(raw); return Number.isNaN(n) ? d : n; }
      if (typeof d === "boolean") return raw === "true";
      if (d === null) { if (raw === "null") return null; const n = Number(raw); return Number.isNaN(n) ? raw : n; }
      return raw;
    },
  };

  function renderNode(key, desc, setVal, ad, onChange, depth, expanded) {
    const wrap = el("div", "ft-node");
    const row = el("div", "ft-row");
    row.style.paddingLeft = (8 + depth * 16) + "px";

    if (ad.isContainer(desc)) {
      const toggle = el("span", "ft-toggle", expanded ? COLLAPSE : EXPAND);
      const label = el("span", "ft-key", key === "" ? "object" : key);
      const brace = el("span", "ft-count", " " + ad.brace(desc));
      row.append(toggle, label, brace);
      const box = el("div", "ft-children");
      box.style.display = expanded ? "" : "none";
      let built = false;
      const build = () => {
        if (built) return; built = true;
        for (const c of ad.children(desc)) box.appendChild(renderNode(c.key, c.desc, c.setVal, ad, onChange, depth + 1, false));
      };
      if (expanded) build();
      const doToggle = () => {
        const open = box.style.display === "none";
        if (open) build();
        box.style.display = open ? "" : "none";
        toggle.textContent = open ? COLLAPSE : EXPAND;
      };
      row.style.cursor = "pointer";
      row.onclick = doToggle;
      wrap.append(row, box);
    } else {
      const label = el("span", "ft-key", key);
      const sep = el("span", "ft-sep", " : ");
      const val = el("span", "ft-val", ad.leafText(desc));
      val.title = ad.typeTag(desc);
      val.contentEditable = "true"; val.spellcheck = false;
      val.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); val.blur(); } });
      val.addEventListener("blur", () => {
        const parsed = ad.parseLeaf(desc, val.textContent.trim());
        setVal(parsed);
        val.textContent = ad.leafText({ type: desc.type, value: parsed });
        onChange && onChange();
      });
      row.append(label, sep, val);
      wrap.append(row);
    }
    return wrap;
  }

  function ensureStyle() {
    if (document.getElementById("ft-style")) return;
    const s = el("style"); s.id = "ft-style";
    s.textContent = `
      .ft-tree { font-family: monospace; font-size: 13px; overflow:auto; background: var(--menu-bg, #2a2a2a);
                 border:1px solid var(--secondary-color, #666); border-radius: var(--border-radius, 6px); padding:6px 4px; }
      .ft-row { display:flex; align-items:center; white-space:nowrap; padding:1px 0; user-select:none; }
      .ft-toggle { width:14px; display:inline-block; text-align:center; opacity:0.8; flex:0 0 auto; }
      .ft-key { font-weight:bold; }
      .ft-count { opacity:0.6; }
      .ft-sep { opacity:0.6; }
      .ft-val { color:#e06a3b; user-select:text; padding:0 3px; border-radius:3px; outline:none; }
      .ft-val:focus { background: rgba(255,255,255,0.12); }
      .ft-children { }
    `;
    document.head.appendChild(s);
  }

  // Render tree for `data` (nbt tagged root, or a plain JSON value) into container.
  window.FileTree = {
    render(container, data, opts) {
      ensureStyle();
      const mode = (opts && opts.mode) || "json";
      const onChange = opts && opts.onChange;
      const ad = mode === "nbt" ? nbtAdapter : jsonAdapter;
      container.innerHTML = "";
      container.classList.add("ft-tree");
      container.appendChild(renderNode("", data, () => {}, ad, onChange, 0, true));
    },
  };
})();
