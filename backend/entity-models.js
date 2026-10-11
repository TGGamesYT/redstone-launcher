/**
 * Entity models, read out of Minecraft's own code.
 *
 * A block's shape is data — a JSON file in the jar that anyone can read. An
 * entity's is not: it is Java, a `createBodyLayer()` that builds a tree of
 * boxes by calling a builder API, compiled and obfuscated into the client jar.
 * There is no file to parse and no export to ask for.
 *
 * So this runs the method. Mojang publishes an obfuscation map beside every
 * jar, which turns `gyt.a(II)` back into `CubeListBuilder.texOffs(int,int)`;
 * backend/classfile.js decodes the bytecode; and the interpreter below
 * executes it against stand-ins for the builder classes. What comes back is
 * the same tree of boxes the game would have built, which is then flattened
 * into the element list the block renderer already draws.
 *
 * It is a small interpreter for a small language. These methods are almost
 * entirely constants and chained builder calls — the survey across 1.21.9's
 * model classes found `addOrReplaceChild`, `texOffs`, `create`, `offset` and
 * `addBox` accounting for nearly all of it — but a handful do loop over a
 * table (silverfish, endermite), so real control flow, arrays and static
 * initialisers are all supported rather than bailed on. What is NOT supported
 * bails loudly rather than guessing: an unknown call throws Bail, the model is
 * reported as unreadable, and the caller shows something else.
 *
 *   const r = new EntityModels({ stack, maps, log });
 *   await r.layer('net.minecraft.client.model.CowModel');
 *     -> { elements, texWidth, texHeight, parts }
 *
 * Coordinates: Minecraft builds entity models with +Y pointing DOWN and the
 * entity facing north, then renders them under a scale of (-1,-1,1) — which,
 * having determinant +1, is a half turn about Z rather than a mirror. That
 * turn is baked into every element's transform here, so what comes out is
 * right-way-up in ordinary world space.
 */
import { readClass } from './classfile.js';

class Bail extends Error { }
const bail = (msg) => { throw new Bail(msg); };

// ── The objects the builder API passes around ───────────────────────────────
// Stand-ins, not reimplementations: they record what was asked for and nothing
// more. Nothing here bakes, draws or validates.

class JPose {
  constructor(x = 0, y = 0, z = 0, xRot = 0, yRot = 0, zRot = 0, sx = 1, sy = 1, sz = 1) {
    Object.assign(this, { x, y, z, xRot, yRot, zRot, sx, sy, sz });
  }
  static ZERO = new JPose();
}

class JDeform {
  constructor(gx = 0, gy = 0, gz = 0) { this.gx = gx; this.gy = gy; this.gz = gz; }
  extend(a, b, c) {
    return b === undefined
      ? new JDeform(this.gx + a, this.gy + a, this.gz + a)
      : new JDeform(this.gx + a, this.gy + b, this.gz + c);
  }
  static NONE = new JDeform();
}

class JCubes {
  constructor() { this.u = 0; this.v = 0; this.mirror = false; this.boxes = []; }
  texOffs(u, v) { this.u = u; this.v = v; return this; }
  setMirror(m) { this.mirror = m; return this; }
  addBox(o) {
    this.boxes.push({
      x: o.x, y: o.y, z: o.z, w: o.w, h: o.h, d: o.d,
      u: this.u, v: this.v,
      mirror: o.mirror === undefined ? this.mirror : o.mirror,
      grow: o.grow || JDeform.NONE,
      texScaleU: o.texScaleU || 1, texScaleV: o.texScaleV || 1,
    });
    return this;
  }
}

class JPart {
  constructor(cubes, pose) {
    this.cubes = cubes ? cubes.boxes.slice() : [];
    this.pose = pose || JPose.ZERO;
    this.children = new Map();
  }
  addOrReplaceChild(name, cubesOrPart, pose) {
    const child = cubesOrPart instanceof JPart
      ? cubesOrPart
      : new JPart(cubesOrPart, pose);
    this.children.set(name, child);
    return child;
  }
  getChild(name, lenient) {
    const c = this.children.get(name);
    if (c) return c;
    // Walking the whole registry, a child that is not there means an earlier
    // call was not modelled, not that the model is wrong. An empty part keeps
    // the rest of the catalogue coming.
    if (lenient) { const made = new JPart(null, JPose.ZERO); this.children.set(name, made); return made; }
    return bail(`no child "${name}"`);
  }
  clearChild(name) { const c = new JPart(null, (this.children.get(name) || {}).pose); this.children.set(name, c); return c; }
  clearRecursively() { this.cubes = []; for (const c of this.children.values()) c.clearRecursively(); return this; }
}

class JMesh {
  constructor(root) { this.root = root || new JPart(null, JPose.ZERO); }
}
class JLayer {
  constructor(mesh, texW, texH) { this.mesh = mesh; this.texW = texW; this.texH = texH; }
}
class JArray {
  constructor(n, fill = 0) { this.v = new Array(n).fill(fill); }
}
class JLambda {
  constructor(impl, captured) { this.impl = impl; this.captured = captured; }
}
// Anything the interpreter does not model but can carry around untouched.
class JOpaque {
  constructor(what) { this.what = what; }
}
// A ModelLayerLocation: "zombie", "creeper/armor", and so on.
class JLoc {
  constructor(model, layer) { this.model = model; this.layer = layer || 'main'; }
  toString() { return this.layer === 'main' ? this.model : `${this.model}/${this.layer}`; }
}
class JMap {
  constructor(entries) { this.entries = entries || []; }
}
class JMapBuilder {
  constructor() { this.entries = []; }
  put(k, v) { this.entries.push([k, v]); return this; }
  build() { return new JMap(this.entries.slice()); }
}

// ── Little matrices, column-major so three.js can take them as they are ─────
const mIdent = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mMul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
}
const mTranslate = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const mScale = (x, y, z) => [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
const mRotX = (a) => { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]; };
const mRotY = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]; };
const mRotZ = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; };

// ── The interpreter ─────────────────────────────────────────────────────────
const MAX_STEPS = 200000;     // a model that loops forever is a bug, not a model
const MAX_DEPTH = 12;

export class EntityModels {
  /**
   * @param stack an asset stack that can hand over "<obf>.class"
   * @param maps  the parsed obfuscation mappings
   */
  constructor({ stack, maps, log = () => { } }) {
    this.stack = stack;
    this.maps = maps;
    this.log = log;
    this.classes = new Map();         // obf -> parsed class (or null)
    this.statics = new Map();         // obf -> Map(fieldObf -> value)
    this.native = buildNativeTable();
    // Every map builder the interpreter has made. createRoots() ends with a
    // stream over the finished map that is of no interest here; if that part
    // bails, the entries already put into the builder are still the answer,
    // so they are kept rather than lost with the exception.
    this.builders = new Set();
    this._layers = null;
    // See the note on unmodelled calls in invoke(). Off by default.
    this.lenient = false;
  }

  /**
   * Every entity layer the game registers, by name — "zombie", "creeper",
   * "ender_dragon" — each with the boxes it is made of and the texture size
   * its UVs are against.
   *
   * This is the catalogue. A model class like ZombieModel declares no layer
   * method of its own (it inherits HumanoidModel's mesh and is given a size
   * at registration), so going class by class finds only some of them;
   * LayerDefinitions.createRoots() has them all, with their names.
   */
  async layers() {
    if (this._layers) return this._layers;
    const out = new Map();
    const obf = this.maps.obfClass('net.minecraft.client.model.geom.LayerDefinitions');
    const cls = obf && await this.loadClass(obf);
    const m = cls && cls.methods.find(x => {
      const real = this.maps.methodName(obf, x.name, x.descriptor);
      return real === 'createRoots' && x.code;
    });
    if (!m) { this._layers = out; return out; }

    this.builders.clear();
    let result = null;
    this.lenient = true;
    try { result = await this.exec(cls, m, [], 0); }
    catch (err) {
      if (!(err instanceof Bail)) throw err;
      this.log(`entity models: createRoots stopped early — ${err.message}`);
    } finally { this.lenient = false; }
    // Whatever was built, finished or not.
    let entries = result instanceof JMap ? result.entries : [];
    for (const b of this.builders) if (b.entries.length > entries.length) entries = b.entries;

    for (const [k, v] of entries) {
      if (!(k instanceof JLoc) || !(v instanceof JLayer)) continue;
      try { out.set(String(k), { ...flatten(v), name: String(k) }); } catch { /* skip */ }
    }
    this._layers = out;
    return out;
  }

  async loadClass(obf) {
    if (this.classes.has(obf)) return this.classes.get(obf);
    let parsed = null;
    try {
      const hit = await this.stack.get(obf.replace(/\./g, '/') + '.class');
      if (hit) parsed = readClass(hit.buf);
    } catch (err) {
      this.log(`entity models: could not read ${obf}: ${err && err.message}`);
    }
    this.classes.set(obf, parsed);
    return parsed;
  }

  /**
   * Run a model class's layer method and flatten the result.
   * @returns { elements, texWidth, texHeight } or null if it could not be run.
   */
  async layer(realClassName, methodName = 'createBodyLayer') {
    const obf = this.maps.obfClass(realClassName);
    if (!obf) return null;
    const cls = await this.loadClass(obf);
    if (!cls) return null;
    // The layer method takes no arguments in the overwhelming majority of
    // models; the ones that take a CubeDeformation are given the empty one.
    const cands = cls.methods.filter(m => {
      const real = this.maps.methodName(obf, m.name, m.descriptor);
      return real === methodName && m.static && m.code;
    });
    if (!cands.length) return null;
    cands.sort((a, b) => argCount(a.descriptor) - argCount(b.descriptor));
    for (const m of cands) {
      const args = defaultArgs(m.descriptor);
      if (args === null) continue;
      try {
        const v = await this.exec(cls, m, args, 0);
        const layer = v instanceof JLayer ? v : (v instanceof JMesh ? new JLayer(v, 64, 32) : null);
        if (!layer) continue;
        return flatten(layer);
      } catch (err) {
        if (!(err instanceof Bail)) throw err;
        this.log(`entity models: ${realClassName}.${methodName} — ${err.message}`);
      }
    }
    return null;
  }

  /** Read a class's static field, running <clinit> first if it has not been. */
  async staticField(obf, fieldObf, depth) {
    let map = this.statics.get(obf);
    if (!map) {
      map = new Map();
      this.statics.set(obf, map);            // set first: <clinit> may read it
      const cls = await this.loadClass(obf);
      const clinit = cls && cls.methods.find(m => m.name === '<clinit>' && m.code);
      if (clinit) {
        try { await this.exec(cls, clinit, [], depth + 1); }
        catch (err) { if (!(err instanceof Bail)) throw err; }
      }
    }
    return map.has(fieldObf) ? map.get(fieldObf) : undefined;
  }

  async exec(cls, method, args, depth) {
    if (depth > MAX_DEPTH) bail('too deep');
    const code = method.code;
    if (!code) bail(`${method.name} has no code`);
    const ins = code.instructions;
    const pcIndex = new Map();
    ins.forEach((x, i) => pcIndex.set(x.pc, i));

    const locals = args.slice();
    const stack = [];
    const widths = [];
    const push = (v, w = 1) => { stack.push(v); widths.push(w); };
    const pop = () => { widths.pop(); return stack.pop(); };
    const peek = () => stack[stack.length - 1];

    let i = 0, steps = 0;
    while (i < ins.length) {
      if (++steps > MAX_STEPS) bail('ran too long');
      const x = ins[i];
      const op = x.op;

      // Control flow first. It used to be checked after the dispatch below,
      // which meant every `areturn` fell through to "unsupported opcode" and
      // no model built at all.
      if (op === 'return') return undefined;
      if (RETURNS.has(op)) return pop();
      if (JUMPS.has(op)) {
        const taken = branchTaken(op, pop);
        if (taken === true || taken === 'goto') {
          const t = pcIndex.get(x.branch);
          if (t === undefined) bail(`branch to nowhere from ${op}@${x.pc}`);
          i = t;
        } else i++;
        continue;
      }

      let next = i + 1;
      switch (op) {
        case 'nop': break;
        case 'aconst_null': push(null); break;
        case 'iconst_m1': push(-1); break;
        case 'iconst_0': case 'iconst_1': case 'iconst_2':
        case 'iconst_3': case 'iconst_4': case 'iconst_5':
          push(Number(op.slice(-1))); break;
        case 'lconst_0': push(0, 2); break;
        case 'lconst_1': push(1, 2); break;
        case 'fconst_0': push(0); break;
        case 'fconst_1': push(1); break;
        case 'fconst_2': push(2); break;
        case 'dconst_0': push(0, 2); break;
        case 'dconst_1': push(1, 2); break;
        case 'bipush': case 'sipush': push(x.value); break;
        case 'ldc': case 'ldc_w': case 'ldc2_w': {
          const c = x.const;
          if (!c) bail('bad ldc');
          if (c.kind === 'String') push(c.value);
          else if (c.kind === 'Long' || c.kind === 'Double') push(Number(c.value), 2);
          else if (c.value !== undefined) push(c.value);
          else push(new JOpaque(c.kind));
          break;
        }
        case 'iload': case 'fload': case 'aload': push(locals[x.index]); break;
        case 'lload': case 'dload': push(locals[x.index], 2); break;
        default: {
          const m = /^([ilfda])(load|store)_(\d)$/.exec(op);
          if (m) {
            const slot = Number(m[3]);
            const wide = (m[1] === 'l' || m[1] === 'd') ? 2 : 1;
            if (m[2] === 'load') push(locals[slot], wide);
            else locals[slot] = pop();
            break;
          }
          if (op === 'istore' || op === 'fstore' || op === 'astore'
            || op === 'lstore' || op === 'dstore') { locals[x.index] = pop(); break; }
          await this.step(op, x, { push, pop, peek, stack, widths, locals }, cls, depth);
          // A switch sets a jump marker rather than reaching into the loop.
          if (x.__jump !== undefined) { next = pcIndex.get(x.__jump); delete x.__jump; }
          break;
        }
      }

      if (next === undefined) bail(`branch to nowhere from ${op}@${x.pc}`);
      i = next;
    }
    return undefined;
  }

  // Everything that is not a load, a store or a constant.
  async step(op, x, st, cls, depth) {
    const { push, pop, stack, widths } = st;
    switch (op) {
      case 'pop': pop(); break;
      case 'pop2': if (widths[widths.length - 1] === 2) pop(); else { pop(); pop(); } break;
      case 'dup': { const v = pop(); push(v); push(v); break; }
      case 'dup_x1': { const a = pop(), b = pop(); push(a); push(b); push(a); break; }
      case 'dup2': {
        if (widths[widths.length - 1] === 2) { const v = pop(); push(v, 2); push(v, 2); }
        else { const a = pop(), b = pop(); push(b); push(a); push(b); push(a); }
        break;
      }
      case 'swap': { const a = pop(), b = pop(); push(a); push(b); break; }
      case 'iadd': case 'fadd': case 'ladd': case 'dadd': { const b = pop(), a = pop(); push(a + b); break; }
      case 'isub': case 'fsub': case 'lsub': case 'dsub': { const b = pop(), a = pop(); push(a - b); break; }
      case 'imul': case 'fmul': case 'lmul': case 'dmul': { const b = pop(), a = pop(); push(a * b); break; }
      case 'idiv': { const b = pop(), a = pop(); push(Math.trunc(a / b)); break; }
      case 'fdiv': case 'ddiv': case 'ldiv': { const b = pop(), a = pop(); push(a / b); break; }
      case 'irem': case 'lrem': { const b = pop(), a = pop(); push(a % b); break; }
      case 'frem': case 'drem': { const b = pop(), a = pop(); push(a % b); break; }
      case 'ineg': case 'fneg': case 'lneg': case 'dneg': push(-pop()); break;
      case 'ishl': { const b = pop(), a = pop(); push(a << b); break; }
      case 'ishr': { const b = pop(), a = pop(); push(a >> b); break; }
      case 'iushr': { const b = pop(), a = pop(); push(a >>> b); break; }
      case 'iand': { const b = pop(), a = pop(); push(a & b); break; }
      case 'ior': { const b = pop(), a = pop(); push(a | b); break; }
      case 'ixor': { const b = pop(), a = pop(); push(a ^ b); break; }
      case 'iinc': st.locals[x.index] = (st.locals[x.index] || 0) + x.const; break;
      case 'i2f': case 'i2l': case 'i2d': case 'l2i': case 'l2f': case 'l2d':
      case 'f2d': case 'f2l': case 'd2f': case 'd2l': break;      // all one number here
      case 'f2i': case 'd2i': push(Math.trunc(pop())); break;
      case 'i2b': push((pop() << 24) >> 24); break;
      case 'i2s': push((pop() << 16) >> 16); break;
      case 'i2c': push(pop() & 0xffff); break;
      case 'lcmp': case 'fcmpl': case 'fcmpg': case 'dcmpl': case 'dcmpg': {
        const b = pop(), a = pop(); push(a > b ? 1 : a < b ? -1 : 0); break;
      }
      case 'arraylength': { const a = pop(); push(a instanceof JArray ? a.v.length : bail('length of a non-array')); break; }
      case 'newarray': case 'anewarray': { const n = pop(); push(new JArray(n, op === 'newarray' ? 0 : null)); break; }
      case 'multianewarray': bail('multianewarray');
      case 'iaload': case 'faload': case 'aaload': case 'baload': case 'saload': case 'caload':
      case 'laload': case 'daload': {
        const idx = pop(), arr = pop();
        if (!(arr instanceof JArray)) bail('load from a non-array');
        push(arr.v[idx]);
        break;
      }
      case 'iastore': case 'fastore': case 'aastore': case 'bastore': case 'sastore': case 'castore':
      case 'lastore': case 'dastore': {
        const v = pop(), idx = pop(), arr = pop();
        if (!(arr instanceof JArray)) bail('store to a non-array');
        arr.v[idx] = v;
        break;
      }
      case 'new': push(new Pending(x.const.name)); break;
      case 'checkcast': case 'instanceof': if (op === 'instanceof') { pop(); push(1); } break;
      case 'getstatic': {
        const c = x.const;
        const nat = this.nativeStatic(c);
        if (nat !== undefined) { push(nat); break; }
        const v = await this.staticField(c.owner, c.name, depth);
        push(v === undefined ? new JOpaque(`${c.owner}.${c.name}`) : v);
        break;
      }
      case 'putstatic': {
        const c = x.const;
        const v = pop();
        let map = this.statics.get(c.owner);
        if (!map) { map = new Map(); this.statics.set(c.owner, map); }
        map.set(c.name, v);
        break;
      }
      case 'getfield': { const o = pop(); push(o && o.__fields ? o.__fields[x.const.name] : new JOpaque('field')); break; }
      case 'putfield': { const v = pop(), o = pop(); if (o) { o.__fields = o.__fields || {}; o.__fields[x.const.name] = v; } break; }
      case 'invokestatic': case 'invokevirtual': case 'invokespecial': case 'invokeinterface':
        await this.invoke(op, x, st, depth); break;
      case 'invokedynamic': {
        const c = x.const;
        const bsm = (cls.bootstrapMethods || [])[c.bootstrap];
        const nArgs = argCount(c.descriptor);
        const captured = [];
        for (let k = 0; k < nArgs; k++) captured.unshift(pop());
        const impl = bsm && bsm.args && bsm.args[1] && bsm.args[1].ref;
        push(new JLambda(impl || null, captured));
        break;
      }
      case 'athrow': bail('the method threw');
      case 'monitorenter': case 'monitorexit': pop(); break;
      case 'tableswitch': case 'lookupswitch': {
        const k = pop();
        const hit = (x.targets || []).find(t => t.key === k);
        x.__jump = hit ? hit.target : x.default;
        break;
      }
      default: bail(`unsupported opcode ${op}`);
    }
  }

  nativeStatic(c) {
    const real = this.maps.realClass(c.owner);
    const field = this.maps.fieldName(c.owner, c.name);
    if (real === 'net.minecraft.client.model.geom.PartPose' && field === 'ZERO') return JPose.ZERO;
    if (real === 'net.minecraft.client.model.geom.builders.CubeDeformation' && field === 'NONE') return JDeform.NONE;
    if (real === 'net.minecraft.client.model.geom.builders.MeshTransformer' && field === 'IDENTITY') return new JOpaque('identity');
    return undefined;
  }

  async invoke(op, x, st, depth) {
    const { push, pop } = st;
    const c = x.const;
    const nArgs = argCount(c.descriptor);
    const args = [];
    for (let k = 0; k < nArgs; k++) args.unshift(pop());
    const isStatic = op === 'invokestatic';
    const self = isStatic ? null : pop();

    const realOwner = this.maps.realClass(c.owner) || c.owner.replace(/\//g, '.');
    const realName = this.maps.methodName(c.owner, c.name, c.descriptor) || c.name;
    const key = `${realOwner}#${realName}/${nArgs}`;

    // A constructor on a `new` that is still pending turns into the object.
    if (realName === '<init>' && self instanceof Pending) {
      const made = this.construct(realOwner, args, self);
      // `new` + `dup` means the reference is on the stack twice; both have to
      // become the real object, not just the one the constructor consumed.
      st.stack.forEach((v, k) => { if (v === self) st.stack[k] = made; });
      return;
    }

    // A lambda made by invokedynamic: call what it was compiled into, with
    // whatever it captured in front of the arguments.
    if (self instanceof JLambda && ['apply', 'accept', 'get', 'test', 'applyAsInt'].includes(realName)) {
      if (!self.impl) { push(args[0]); return; }
      const owner = self.impl.owner;
      const found = await this.findMethod(owner, self.impl.name, self.impl.descriptor);
      if (!found) { push(args[0]); return; }
      const isStaticImpl = found.method.static;
      const all = [...self.captured, ...args];
      const r = await this.exec(found.cls, found.method, isStaticImpl ? all : all, depth + 1);
      push(r);
      return;
    }

    const nat = this.native.get(key) || this.native.get(`${realOwner}#${realName}`);
    if (nat) {
      const r = nat(self, args, this);
      if (r instanceof JMapBuilder) this.builders.add(r);
      if (r !== undefined) push(r);
      return;
    }

    // java.lang.Math and Mth are worth having; nothing else from the JDK is.
    const jdk = jdkCall(realOwner, realName, args);
    if (jdk !== undefined) { if (jdk !== NO_RESULT) push(jdk); return; }

    // Not modelled — but if its bytecode is here, run it. A call's owner is
    // the class it was written against, which for an inherited method is a
    // SUBCLASS of the one that declares it: ColdCowModel.createBaseCowModel()
    // lives on CowModel. So the superclass chain is walked rather than giving
    // up at the first class that does not declare it.
    const found = await this.findMethod(c.owner, c.name, c.descriptor);
    if (found) {
      const locals = isStatic ? args : [self, ...args];
      const r = await this.exec(found.cls, found.method, locals, depth + 1);
      if (!c.descriptor.endsWith(')V')) push(r);
      return;
    }
    // In lenient mode an unknown call becomes a value that carries no meaning
    // rather than stopping everything. That is only safe where the result is
    // CHECKED afterwards: the registry walk keeps an entry only when its key
    // really is a layer location and its value really is a layer, so a stray
    // opaque can never be mistaken for geometry. Reading one model class is
    // not checked that way, so there it still stops.
    if (this.lenient) {
      if (!c.descriptor.endsWith(')V')) push(new JOpaque(`${realOwner}.${realName}`));
      return;
    }
    bail(`unmodelled call ${realOwner}.${realName}${c.descriptor}`);
  }

  async findMethod(ownerObf, name, descriptor) {
    let at = ownerObf;
    for (let hops = 0; at && hops < 10; hops++) {
      const cls = await this.loadClass(at);
      if (!cls) return null;
      const m = cls.methods.find(mm => mm.name === name && mm.descriptor === descriptor && mm.code);
      if (m) return { cls, method: m };
      at = cls.superClass;
      if (at === 'java/lang/Object') return null;
    }
    return null;
  }

  construct(realOwner, args) {
    switch (realOwner) {
      case 'net.minecraft.client.model.geom.builders.MeshDefinition':
        return new JMesh(args[0] instanceof JPart ? args[0] : undefined);
      case 'net.minecraft.client.model.geom.builders.CubeListBuilder':
        return new JCubes();
      case 'net.minecraft.client.model.geom.builders.CubeDeformation':
        return args.length === 1 ? new JDeform(args[0], args[0], args[0]) : new JDeform(args[0], args[1], args[2]);
      case 'net.minecraft.client.model.geom.PartPose':
        return new JPose(...args);
      default:
        return new JOpaque(realOwner);
    }
  }
}

// A reference produced by `new` that has not had its constructor run yet.
class Pending { constructor(type) { this.type = type; } }

const NO_RESULT = Symbol('void');
function jdkCall(owner, name, args) {
  if (owner === 'java.lang.Math' || owner === 'net.minecraft.util.Mth') {
    const f = { sin: Math.sin, cos: Math.cos, sqrt: Math.sqrt, abs: Math.abs, floor: Math.floor, ceil: Math.ceil }[name];
    if (f) return f(args[0]);
  }
  if (owner === 'java.lang.String' && name === 'valueOf') return String(args[0]);
  if (owner === 'java.lang.StringBuilder') return NO_RESULT;
  if (owner === 'java.util.Set' && name === 'of') return new JOpaque('set');
  if (owner === 'java.lang.Object' && name === '<init>') return NO_RESULT;
  return undefined;
}

const argCount = (descriptor) => {
  const inner = /\(([^)]*)\)/.exec(descriptor);
  if (!inner) return 0;
  let n = 0, i = 0;
  const s = inner[1];
  while (i < s.length) {
    while (s[i] === '[') i++;
    if (s[i] === 'L') { i = s.indexOf(';', i) + 1; } else i++;
    n++;
  }
  return n;
};

// Arguments for a layer method we are calling ourselves. A CubeDeformation is
// the empty one; anything else and we do not know what to pass.
function defaultArgs(descriptor) {
  const inner = /\(([^)]*)\)/.exec(descriptor)[1];
  const out = [];
  let i = 0;
  while (i < inner.length) {
    if (inner[i] === 'L') {
      const end = inner.indexOf(';', i);
      out.push(new JDeform());               // the only object a layer method takes
      i = end + 1;
    } else if ('FIJDS BCZ'.includes(inner[i])) {
      out.push(0); i++;
    } else return null;
  }
  return out;
}

const RETURNS = new Set(['areturn', 'ireturn', 'freturn', 'lreturn', 'dreturn']);
const JUMPS = new Set([
  'ifeq', 'ifne', 'iflt', 'ifge', 'ifgt', 'ifle',
  'if_icmpeq', 'if_icmpne', 'if_icmplt', 'if_icmpge', 'if_icmpgt', 'if_icmple',
  'if_acmpeq', 'if_acmpne', 'ifnull', 'ifnonnull', 'goto', 'goto_w',
]);
function branchTaken(op, pop) {
  if (op === 'goto' || op === 'goto_w') return 'goto';
  if (op === 'ifnull') return pop() === null;
  if (op === 'ifnonnull') return pop() !== null;
  if (op.startsWith('if_')) {
    const b = pop(), a = pop();
    switch (op.slice(op.indexOf('cmp') + 3)) {
      case 'eq': return a === b;
      case 'ne': return a !== b;
      case 'lt': return a < b;
      case 'ge': return a >= b;
      case 'gt': return a > b;
      case 'le': return a <= b;
    }
  }
  const a = pop();
  switch (op.slice(2)) {
    case 'eq': return a === 0;
    case 'ne': return a !== 0;
    case 'lt': return a < 0;
    case 'ge': return a >= 0;
    case 'gt': return a > 0;
    case 'le': return a <= 0;
  }
  return false;
}

// ── The builder API, as the interpreter sees it ─────────────────────────────
function buildNativeTable() {
  const T = new Map();
  const P = 'net.minecraft.client.model.geom.';
  const B = P + 'builders.';
  const set = (k, fn) => T.set(k, fn);

  set(`${B}CubeListBuilder#create/0`, () => new JCubes());
  set(`${B}CubeListBuilder#texOffs/2`, (self, a) => self.texOffs(a[0], a[1]));
  set(`${B}CubeListBuilder#mirror/0`, (self) => self.setMirror(true));
  set(`${B}CubeListBuilder#mirror/1`, (self, a) => self.setMirror(!!a[0]));
  set(`${B}CubeListBuilder#getCubes/0`, (self) => new JOpaque('cubes'));

  // All nine addBox overloads, told apart by how many arguments came in and
  // whether the first is a name. The shapes, from the mappings:
  //   (f x6)                     (f x6, deform)      (f x6, bool)
  //   (f x6, deform, f, f)       (f x6, Set)
  //   (name, f x6)               (name, f x6, deform)
  //   (name, f,f,f, i,i,i, i,i)  (name, f,f,f, i,i,i, deform, i,i)
  const addBox = (self, a) => {
    let i = 0;
    if (typeof a[0] === 'string' || a[0] === null) i = 1;        // a name, maybe null
    const [x, y, z, w, h, d] = a.slice(i, i + 6);
    const rest = a.slice(i + 6);
    const o = { x, y, z, w, h, d };
    for (const r of rest) {
      if (r instanceof JDeform) o.grow = r;
      else if (typeof r === 'boolean') o.mirror = r;
    }
    // The (name, f,f,f, i,i,i, texU, texV) overloads end with the texture
    // offset rather than carrying it on the builder.
    if (i === 1 && rest.length >= 2 && typeof rest[rest.length - 2] === 'number'
      && typeof rest[rest.length - 1] === 'number' && !(rest[rest.length - 1] instanceof JDeform)) {
      self.texOffs(rest[rest.length - 2], rest[rest.length - 1]);
    }
    // (f x6, deform, texScaleU, texScaleV)
    if (i === 0 && rest.length === 3 && rest[0] instanceof JDeform) {
      o.texScaleU = rest[1]; o.texScaleV = rest[2];
    }
    return self.addBox(o);
  };
  for (const n of [6, 7, 8, 9, 10, 11]) set(`${B}CubeListBuilder#addBox/${n}`, addBox);

  set(`${B}MeshDefinition#getRoot/0`, (self) => self.root);
  set(`${B}MeshDefinition#transformed/1`, (self) => self);
  set(`${B}MeshDefinition#apply/1`, (self) => self);
  set(`${B}PartDefinition#addOrReplaceChild/3`, (self, a) => self.addOrReplaceChild(a[0], a[1], a[2]));
  set(`${B}PartDefinition#addOrReplaceChild/2`, (self, a) => self.addOrReplaceChild(a[0], a[1]));
  set(`${B}PartDefinition#getChild/1`, (self, a, em) => self.getChild(a[0], em && em.lenient));
  set(`${B}PartDefinition#clearChild/1`, (self, a) => self.clearChild(a[0]));
  set(`${B}PartDefinition#clearRecursively/0`, (self) => self.clearRecursively());
  set(`${B}PartDefinition#retainPartsAndChildren/1`, () => NO_RESULT);
  set(`${B}PartDefinition#retainExactParts/1`, () => NO_RESULT);
  set(`${B}PartDefinition#transformed/1`, (self) => self);

  set(`${B}LayerDefinition#create/3`, (self, a) => new JLayer(a[0], a[1], a[2]));
  set(`${B}LayerDefinition#apply/1`, (self) => self);
  set(`${B}MeshTransformer#scaling/1`, () => new JOpaque('scaling'));

  set(`${P}PartPose#offset/3`, (self, a) => new JPose(a[0], a[1], a[2]));
  set(`${P}PartPose#rotation/3`, (self, a) => new JPose(0, 0, 0, a[0], a[1], a[2]));
  set(`${P}PartPose#offsetAndRotation/6`, (self, a) => new JPose(a[0], a[1], a[2], a[3], a[4], a[5]));
  set(`${P}PartPose#translated/3`, (self, a) =>
    new JPose(self.x + a[0], self.y + a[1], self.z + a[2], self.xRot, self.yRot, self.zRot, self.sx, self.sy, self.sz));
  set(`${P}PartPose#withScale/1`, (self, a) =>
    new JPose(self.x, self.y, self.z, self.xRot, self.yRot, self.zRot, a[0], a[0], a[0]));
  set(`${P}PartPose#scaled/1`, (self, a) =>
    new JPose(self.x, self.y, self.z, self.xRot, self.yRot, self.zRot, self.sx * a[0], self.sy * a[0], self.sz * a[0]));
  set(`${P}PartPose#scaled/3`, (self, a) =>
    new JPose(self.x, self.y, self.z, self.xRot, self.yRot, self.zRot, self.sx * a[0], self.sy * a[1], self.sz * a[2]));

  set(`${B}CubeDeformation#extend/1`, (self, a) => self.extend(a[0]));
  set(`${B}CubeDeformation#extend/3`, (self, a) => self.extend(a[0], a[1], a[2]));

  // ── The layer registry ───────────────────────────────────────────────────
  // LayerDefinitions.createRoots() builds the map of every entity layer the
  // game knows, each with the texture size it is drawn against. It is the only
  // place a model like ZombieModel — which declares no layer method of its
  // own, inheriting HumanoidModel's mesh — can be found at all, and it names
  // each one, so the map it returns IS the catalogue.
  set(`${P}ModelLayers#register/1`, (self, a) => new JLoc(a[0]));
  set(`${P}ModelLayers#register/2`, (self, a) => new JLoc(a[0], a[1]));
  set(`${P}ModelLayers#createLocation/2`, (self, a) => new JLoc(a[0], a[1]));
  set(`${P}ModelLayers#registerArmorSet/1`, (self, a) => new JOpaque('armor:' + a[0]));
  set(`${P}ModelLayerLocation#<init>/2`, (self, a) => new JLoc(a[0], a[1]));
  // Armour sets are four more layers of the same humanoid shape; for a picture
  // of a mob they add nothing, so they are carried about and ignored.
  set('net.minecraft.client.renderer.entity.ArmorModelSet#map/1', () => new JOpaque('armorset'));

  const builder = () => new JMapBuilder();
  for (const cls of ['com.google.common.collect.ImmutableMap', 'com.google.common.collect.ImmutableMap$Builder']) {
    set(`${cls}#builder/0`, builder);
    set(`${cls}#builderWithExpectedSize/1`, builder);
  }
  set('com.google.common.collect.ImmutableMap$Builder#put/2', (self, a) => self.put(a[0], a[1]));
  for (const m of ['build', 'buildOrThrow', 'buildKeepingLast']) {
    set(`com.google.common.collect.ImmutableMap$Builder#${m}/0`, (self) => self.build());
  }
  set('java.util.Map#put/2', (self, a) => (self instanceof JMapBuilder ? self.put(a[0], a[1]) : new JOpaque('map')));

  return T;
}

// ── From a part tree to something that can be drawn ─────────────────────────
// Minecraft's standard box unwrap. (u, v) is the top-left of the whole layout
// and the six faces sit around it by the box's own dimensions:
//
//        +--------+--------+
//        |  up    |  down  |
//   +----+--------+--------+----+
//   |west| north  |  east  |south|
//   +----+--------+--------+----+
//
// The player's head, at texOffs(0, 0) on a 64x64 skin, lands exactly on the
// skin's head squares, which is the check that this is the right way round.
function boxUv(b) {
  const { u, v, w, h, d } = b;
  const su = b.texScaleU || 1, sv = b.texScaleV || 1;
  const U = (n) => n / su, V = (n) => n / sv;
  return {
    up: [U(u + d), V(v), U(u + d + w), V(v + d)],
    down: [U(u + d + w), V(v + d), U(u + d + w + w), V(v)],   // flipped, as the game draws it
    west: [U(u), V(v + d), U(u + d), V(v + d + h)],
    north: [U(u + d), V(v + d), U(u + d + w), V(v + d + h)],
    east: [U(u + d + w), V(v + d), U(u + d + w + d), V(v + d + h)],
    south: [U(u + d + w + d), V(v + d), U(u + d + w + d + w), V(v + d + h)],
  };
}

function flatten(layer) {
  const elements = [];
  const texW = layer.texW || 64, texH = layer.texH || 32;
  // Minecraft renders a model under scale(-1, -1, 1), whose determinant is +1:
  // a half turn about Z, not a mirror. That is what puts the model the right
  // way up, since it is built with +Y pointing down.
  const ROOT = mRotZ(Math.PI);

  const walk = (part, parent) => {
    // A pose that came out of a call the interpreter did not model is not a
    // pose; treat it as no offset rather than letting undefined spread.
    const p = (part.pose instanceof JPose) ? part.pose : JPose.ZERO;
    let m = mMul(parent, mTranslate(p.x, p.y, p.z));
    // The game's own order: translate, then z, then y, then x.
    if (p.zRot) m = mMul(m, mRotZ(p.zRot));
    if (p.yRot) m = mMul(m, mRotY(p.yRot));
    if (p.xRot) m = mMul(m, mRotX(p.xRot));
    if (p.sx !== 1 || p.sy !== 1 || p.sz !== 1) m = mMul(m, mScale(p.sx, p.sy, p.sz));

    for (const b of part.cubes) {
      const g = b.grow || JDeform.NONE;
      const uv = boxUv(b);
      const faces = {};
      for (const dir of ['up', 'down', 'north', 'south', 'east', 'west']) {
        const [u0, v0, u1, v1] = uv[dir];
        faces[dir] = {
          texture: '#0',
          // The renderer's uv is in sixteenths of the texture; an entity's is
          // in pixels of it, so this is the one place they have to be bridged.
          uv: [u0 / texW * 16, v0 / texH * 16, u1 / texW * 16, v1 / texH * 16],
        };
      }
      // A mirrored box reads its texture the other way round left to right.
      if (b.mirror) {
        for (const dir of ['up', 'down', 'north', 'south']) {
          const f = faces[dir];
          [f.uv[0], f.uv[2]] = [f.uv[2], f.uv[0]];
        }
        const w = faces.west, e = faces.east;
        faces.west = e; faces.east = w;
      }
      elements.push({
        from: [b.x - g.gx, b.y - g.gy, b.z - g.gz],
        to: [b.x + b.w + g.gx, b.y + b.h + g.gy, b.z + b.d + g.gz],
        faces,
        transform: mMul(ROOT, m),
      });
    }
    for (const child of part.children.values()) walk(child, m);
  };
  walk(layer.mesh.root, mIdent());

  return { elements, texWidth: texW, texHeight: texH };
}

export { JPose, JDeform, JCubes, JPart, JMesh, JLayer, flatten, boxUv };
