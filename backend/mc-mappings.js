/**
 * Mojang's official obfuscation mappings, which turn `gyt.a(II)` back into
 * `CubeListBuilder.texOffs(int, int)`.
 *
 * Every version's JSON lists a `client_mappings` download beside the jar. It
 * is a ProGuard-format text file, ~11 MB, and reading it is the difference
 * between being able to follow Minecraft's own code and staring at three-letter
 * names. Entity models live in that code and nowhere else, so this is the way
 * in.
 *
 * The format, in full:
 *
 *   com.example.Thing -> ab:
 *       int field -> a
 *       12:34:void method(int,java.lang.String) -> b
 *
 * A line with no leading whitespace opens a class; indented lines are its
 * members. The leading `12:34:` on a method is its line-number range and is
 * dropped. Parameter types are SOURCE types (`float`, `java.lang.String`,
 * `net.minecraft.Foo[]`), so matching them against a JVM descriptor from the
 * bytecode means converting them — and converting the class names through the
 * map on the way, since the bytecode is obfuscated.
 */

const PRIM = {
  byte: 'B', char: 'C', double: 'D', float: 'F', int: 'I',
  long: 'J', short: 'S', boolean: 'Z', void: 'V',
};

export function parseMappings(text) {
  const classes = new Map();        // real class name -> { obf, methods: [], fields: Map }
  const byObf = new Map();          // obf -> real class name
  let cur = null;

  for (const raw of String(text).split('\n')) {
    if (!raw || raw.startsWith('#')) continue;
    if (raw[0] !== ' ' && raw[0] !== '\t') {
      const m = /^(\S+)\s*->\s*(\S+):\s*$/.exec(raw);
      if (!m) continue;
      cur = { real: m[1], obf: m[2], methods: [], fields: new Map(), fieldsByObf: new Map() };
      classes.set(m[1], cur);
      byObf.set(m[2], cur);
      continue;
    }
    if (!cur) continue;
    const line = raw.trim();
    // "12:34:ret name(args) -> obf"  |  "ret name(args) -> obf"  |  "type f -> obf"
    const m = /^(?:\d+:\d+:)?(\S+)\s+([^\s(]+)(\(([^)]*)\))?\s*->\s*(\S+)$/.exec(line);
    if (!m) continue;
    const [, retType, name, hasArgs, argList, obf] = m;
    if (hasArgs === undefined) {
      cur.fields.set(name, obf);
      cur.fieldsByObf.set(obf, name);
    } else {
      cur.methods.push({
        name, obf, retType,
        args: argList ? argList.split(',').map(s => s.trim()).filter(Boolean) : [],
      });
    }
  }
  return new Mappings(classes, byObf);
}

export class Mappings {
  constructor(classes, byObf) {
    this.classes = classes;
    this.byObf = byObf;
    this._descCache = new Map();
  }

  /** The obfuscated internal name of a real class, e.g. "gyt". */
  obfClass(real) {
    const c = this.classes.get(real);
    return c ? c.obf : null;
  }
  /** The real name of an obfuscated class. */
  realClass(obf) {
    const c = this.byObf.get(obf);
    return c ? c.real : null;
  }

  /** A source type ("float", "java.lang.String", "a.B[]") as a JVM descriptor. */
  descriptorOf(type) {
    if (this._descCache.has(type)) return this._descCache.get(type);
    let t = type, arr = '';
    while (t.endsWith('[]')) { arr += '['; t = t.slice(0, -2); }
    let d;
    if (PRIM[t]) d = PRIM[t];
    else {
      // Minecraft's own classes are renamed; the JDK's are not.
      const obf = this.obfClass(t);
      d = 'L' + String(obf || t).replace(/\./g, '/') + ';';
    }
    const out = arr + d;
    this._descCache.set(type, out);
    return out;
  }

  /** The full JVM descriptor a mapped method has after obfuscation. */
  methodDescriptor(m) {
    return '(' + m.args.map(a => this.descriptorOf(a)).join('') + ')' + this.descriptorOf(m.retType);
  }

  /**
   * Look up a call seen in bytecode. Takes the obfuscated owner, name and
   * descriptor; answers the real method name, or null.
   */
  methodName(ownerObf, nameObf, descriptor) {
    const c = this.byObf.get(ownerObf);
    if (!c) return null;
    let loose = null;
    for (const m of c.methods) {
      if (m.obf !== nameObf) continue;
      if (this.methodDescriptor(m) === descriptor) return m.name;
      loose = loose || m.name;          // same obf name, descriptor did not match
    }
    return loose;
  }

  /** A field seen in bytecode -> its real name. */
  fieldName(ownerObf, nameObf) {
    const c = this.byObf.get(ownerObf);
    return c ? (c.fieldsByObf.get(nameObf) || null) : null;
  }

  /** Every obfuscated class whose real name starts with this prefix. */
  classesUnder(prefix) {
    const out = [];
    for (const [real, c] of this.classes) if (real.startsWith(prefix)) out.push(c);
    return out;
  }
}

/**
 * Mappings for a jar that does not need any.
 *
 * From 26.1 Mojang ships the client DEOBFUSCATED — 26.4-snapshot-3 has 10,822
 * classes under net/minecraft/ and no client_mappings download at all, where
 * 1.21.9 has 31 and an 11 MB mapping file. So for a modern jar every name in
 * the bytecode is already the real one and the whole lookup collapses to
 * changing slashes for dots.
 *
 * It answers the same questions as a parsed mapping file so that nothing
 * downstream has to know which kind of jar it is reading. `classesUnder` needs
 * a list of what exists, which comes from the jar itself.
 */
export function identityMappings(classPaths) {
  const names = [];
  for (const p of classPaths || []) {
    if (!p.endsWith('.class') || p.includes('$')) continue;
    names.push(p.slice(0, -'.class'.length));
  }
  const toReal = (internal) => String(internal || '').replace(/\//g, '.');
  return {
    identity: true,
    obfClass: (real) => String(real || '').replace(/\./g, '/'),
    realClass: (obf) => toReal(obf),
    methodName: (ownerObf, nameObf) => nameObf,
    fieldName: (ownerObf, nameObf) => nameObf,
    descriptorOf: () => null,
    methodDescriptor: () => null,
    classesUnder(prefix) {
      const p = String(prefix).replace(/\./g, '/');
      const out = [];
      for (const n of names) {
        if (!n.startsWith(p)) continue;
        out.push({ real: toReal(n), obf: n, methods: [], fields: new Map(), fieldsByObf: new Map() });
      }
      return out;
    },
  };
}
