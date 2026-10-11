/**
 * Just enough of the Java class file format to read a method's bytecode.
 *
 * Minecraft's entity models are not data. A block's shape is a JSON file in
 * the jar; an entity's is Java — a `createBodyLayer()` that builds a tree of
 * boxes by calling a builder API. To draw an entity at all, that method has to
 * be read, and reading it means reading the class file it lives in.
 *
 * This is a reader, not a VM: the constant pool, the method table, and each
 * method's `Code` attribute decoded into a list of instructions. What to DO
 * with those instructions is entity-models.js's problem.
 *
 * Deliberately dependency-free and deliberately partial. StackMapTable,
 * annotations, generics and the verifier are all skipped — nothing here needs
 * them, and a jar from Mojang is not hostile input in the way a random upload
 * would be.
 *
 * Reference: JVMS chapter 4 (the class file) and chapter 6 (the instruction
 * set).
 */

// tag -> how many bytes follow, for the constant pool entries that are a fixed
// size. CONSTANT_Utf8 (1) is variable and handled on its own.
const CP_TAG = {
  7: 'Class', 8: 'String', 9: 'Fieldref', 10: 'Methodref', 11: 'InterfaceMethodref',
  12: 'NameAndType', 3: 'Integer', 4: 'Float', 5: 'Long', 6: 'Double',
  15: 'MethodHandle', 16: 'MethodType', 17: 'Dynamic', 18: 'InvokeDynamic',
  19: 'Module', 20: 'Package',
};

class Reader {
  constructor(buf) { this.b = buf; this.p = 0; }
  u1() { return this.b.readUInt8(this.p++); }
  u2() { const v = this.b.readUInt16BE(this.p); this.p += 2; return v; }
  u4() { const v = this.b.readUInt32BE(this.p); this.p += 4; return v; }
  i4() { const v = this.b.readInt32BE(this.p); this.p += 4; return v; }
  f4() { const v = this.b.readFloatBE(this.p); this.p += 4; return v; }
  d8() { const v = this.b.readDoubleBE(this.p); this.p += 8; return v; }
  l8() { const v = this.b.readBigInt64BE(this.p); this.p += 8; return v; }
  bytes(n) { const v = this.b.subarray(this.p, this.p + n); this.p += n; return v; }
}

function readConstantPool(r) {
  const count = r.u2();
  const pool = new Array(count);
  for (let i = 1; i < count; i++) {
    const tag = r.u1();
    const kind = CP_TAG[tag];
    switch (tag) {
      case 1: { const len = r.u2(); pool[i] = { kind: 'Utf8', value: r.bytes(len).toString('utf8') }; break; }
      case 3: pool[i] = { kind, value: r.i4() }; break;
      case 4: pool[i] = { kind, value: r.f4() }; break;
      case 5: pool[i] = { kind, value: r.l8() }; break;
      case 6: pool[i] = { kind, value: r.d8() }; break;
      case 7: case 8: case 16: case 19: case 20:
        pool[i] = { kind, index: r.u2() }; break;
      case 9: case 10: case 11: case 12: case 17: case 18:
        pool[i] = { kind, a: r.u2(), b: r.u2() }; break;
      case 15: pool[i] = { kind, refKind: r.u1(), index: r.u2() }; break;
      default: throw new Error(`unknown constant pool tag ${tag} at #${i}`);
    }
    // Longs and doubles take two slots. A design decision from 1995 that every
    // class file reader since has had to remember.
    if (tag === 5 || tag === 6) i++;
  }
  return pool;
}

// Resolve a constant pool entry into something readable.
function cpResolve(pool, i) {
  const e = pool[i];
  if (!e) return null;
  const utf = (n) => (pool[n] && pool[n].kind === 'Utf8') ? pool[n].value : null;
  switch (e.kind) {
    case 'Utf8': case 'Integer': case 'Float': case 'Long': case 'Double':
      return { kind: e.kind, value: e.value };
    case 'Class': return { kind: 'Class', name: utf(e.index) };
    case 'String': return { kind: 'String', value: utf(e.index) };
    case 'NameAndType': return { kind: 'NameAndType', name: utf(e.a), descriptor: utf(e.b) };
    case 'Fieldref': case 'Methodref': case 'InterfaceMethodref': {
      const cls = cpResolve(pool, e.a), nt = cpResolve(pool, e.b);
      return { kind: e.kind, owner: cls && cls.name, name: nt && nt.name, descriptor: nt && nt.descriptor };
    }
    case 'InvokeDynamic': case 'Dynamic': {
      const nt = cpResolve(pool, e.b);
      return { kind: e.kind, bootstrap: e.a, name: nt && nt.name, descriptor: nt && nt.descriptor };
    }
    case 'MethodHandle': return { kind: 'MethodHandle', refKind: e.refKind, ref: cpResolve(pool, e.index) };
    case 'MethodType': return { kind: 'MethodType', descriptor: utf(e.index) };
    default: return { kind: e.kind };
  }
}

// Opcode -> [mnemonic, operand bytes]. -1 means "variable, handled by hand".
export const OPCODES = {
  0x00: ['nop', 0], 0x01: ['aconst_null', 0],
  0x02: ['iconst_m1', 0], 0x03: ['iconst_0', 0], 0x04: ['iconst_1', 0],
  0x05: ['iconst_2', 0], 0x06: ['iconst_3', 0], 0x07: ['iconst_4', 0], 0x08: ['iconst_5', 0],
  0x09: ['lconst_0', 0], 0x0a: ['lconst_1', 0],
  0x0b: ['fconst_0', 0], 0x0c: ['fconst_1', 0], 0x0d: ['fconst_2', 0],
  0x0e: ['dconst_0', 0], 0x0f: ['dconst_1', 0],
  0x10: ['bipush', 1], 0x11: ['sipush', 2],
  0x12: ['ldc', 1], 0x13: ['ldc_w', 2], 0x14: ['ldc2_w', 2],
  0x15: ['iload', 1], 0x16: ['lload', 1], 0x17: ['fload', 1], 0x18: ['dload', 1], 0x19: ['aload', 1],
  0x1a: ['iload_0', 0], 0x1b: ['iload_1', 0], 0x1c: ['iload_2', 0], 0x1d: ['iload_3', 0],
  0x1e: ['lload_0', 0], 0x1f: ['lload_1', 0], 0x20: ['lload_2', 0], 0x21: ['lload_3', 0],
  0x22: ['fload_0', 0], 0x23: ['fload_1', 0], 0x24: ['fload_2', 0], 0x25: ['fload_3', 0],
  0x26: ['dload_0', 0], 0x27: ['dload_1', 0], 0x28: ['dload_2', 0], 0x29: ['dload_3', 0],
  0x2a: ['aload_0', 0], 0x2b: ['aload_1', 0], 0x2c: ['aload_2', 0], 0x2d: ['aload_3', 0],
  0x2e: ['iaload', 0], 0x2f: ['laload', 0], 0x30: ['faload', 0], 0x31: ['daload', 0],
  0x32: ['aaload', 0], 0x33: ['baload', 0], 0x34: ['caload', 0], 0x35: ['saload', 0],
  0x36: ['istore', 1], 0x37: ['lstore', 1], 0x38: ['fstore', 1], 0x39: ['dstore', 1], 0x3a: ['astore', 1],
  0x3b: ['istore_0', 0], 0x3c: ['istore_1', 0], 0x3d: ['istore_2', 0], 0x3e: ['istore_3', 0],
  0x3f: ['lstore_0', 0], 0x40: ['lstore_1', 0], 0x41: ['lstore_2', 0], 0x42: ['lstore_3', 0],
  0x43: ['fstore_0', 0], 0x44: ['fstore_1', 0], 0x45: ['fstore_2', 0], 0x46: ['fstore_3', 0],
  0x47: ['dstore_0', 0], 0x48: ['dstore_1', 0], 0x49: ['dstore_2', 0], 0x4a: ['dstore_3', 0],
  0x4b: ['astore_0', 0], 0x4c: ['astore_1', 0], 0x4d: ['astore_2', 0], 0x4e: ['astore_3', 0],
  0x4f: ['iastore', 0], 0x50: ['lastore', 0], 0x51: ['fastore', 0], 0x52: ['dastore', 0],
  0x53: ['aastore', 0], 0x54: ['bastore', 0], 0x55: ['castore', 0], 0x56: ['sastore', 0],
  0x57: ['pop', 0], 0x58: ['pop2', 0], 0x59: ['dup', 0], 0x5a: ['dup_x1', 0], 0x5b: ['dup_x2', 0],
  0x5c: ['dup2', 0], 0x5d: ['dup2_x1', 0], 0x5e: ['dup2_x2', 0], 0x5f: ['swap', 0],
  0x60: ['iadd', 0], 0x61: ['ladd', 0], 0x62: ['fadd', 0], 0x63: ['dadd', 0],
  0x64: ['isub', 0], 0x65: ['lsub', 0], 0x66: ['fsub', 0], 0x67: ['dsub', 0],
  0x68: ['imul', 0], 0x69: ['lmul', 0], 0x6a: ['fmul', 0], 0x6b: ['dmul', 0],
  0x6c: ['idiv', 0], 0x6d: ['ldiv', 0], 0x6e: ['fdiv', 0], 0x6f: ['ddiv', 0],
  0x70: ['irem', 0], 0x71: ['lrem', 0], 0x72: ['frem', 0], 0x73: ['drem', 0],
  0x74: ['ineg', 0], 0x75: ['lneg', 0], 0x76: ['fneg', 0], 0x77: ['dneg', 0],
  0x78: ['ishl', 0], 0x79: ['lshl', 0], 0x7a: ['ishr', 0], 0x7b: ['lshr', 0],
  0x7c: ['iushr', 0], 0x7d: ['lushr', 0], 0x7e: ['iand', 0], 0x7f: ['land', 0],
  0x80: ['ior', 0], 0x81: ['lor', 0], 0x82: ['ixor', 0], 0x83: ['lxor', 0],
  0x84: ['iinc', 2],
  0x85: ['i2l', 0], 0x86: ['i2f', 0], 0x87: ['i2d', 0], 0x88: ['l2i', 0], 0x89: ['l2f', 0],
  0x8a: ['l2d', 0], 0x8b: ['f2i', 0], 0x8c: ['f2l', 0], 0x8d: ['f2d', 0], 0x8e: ['d2i', 0],
  0x8f: ['d2l', 0], 0x90: ['d2f', 0], 0x91: ['i2b', 0], 0x92: ['i2c', 0], 0x93: ['i2s', 0],
  0x94: ['lcmp', 0], 0x95: ['fcmpl', 0], 0x96: ['fcmpg', 0], 0x97: ['dcmpl', 0], 0x98: ['dcmpg', 0],
  0x99: ['ifeq', 2], 0x9a: ['ifne', 2], 0x9b: ['iflt', 2], 0x9c: ['ifge', 2],
  0x9d: ['ifgt', 2], 0x9e: ['ifle', 2],
  0x9f: ['if_icmpeq', 2], 0xa0: ['if_icmpne', 2], 0xa1: ['if_icmplt', 2],
  0xa2: ['if_icmpge', 2], 0xa3: ['if_icmpgt', 2], 0xa4: ['if_icmple', 2],
  0xa5: ['if_acmpeq', 2], 0xa6: ['if_acmpne', 2],
  0xa7: ['goto', 2], 0xa8: ['jsr', 2], 0xa9: ['ret', 1],
  0xaa: ['tableswitch', -1], 0xab: ['lookupswitch', -1],
  0xac: ['ireturn', 0], 0xad: ['lreturn', 0], 0xae: ['freturn', 0], 0xaf: ['dreturn', 0],
  0xb0: ['areturn', 0], 0xb1: ['return', 0],
  0xb2: ['getstatic', 2], 0xb3: ['putstatic', 2], 0xb4: ['getfield', 2], 0xb5: ['putfield', 2],
  0xb6: ['invokevirtual', 2], 0xb7: ['invokespecial', 2], 0xb8: ['invokestatic', 2],
  0xb9: ['invokeinterface', 4], 0xba: ['invokedynamic', 4],
  0xbb: ['new', 2], 0xbc: ['newarray', 1], 0xbd: ['anewarray', 2],
  0xbe: ['arraylength', 0], 0xbf: ['athrow', 0],
  0xc0: ['checkcast', 2], 0xc1: ['instanceof', 2],
  0xc2: ['monitorenter', 0], 0xc3: ['monitorexit', 0],
  0xc4: ['wide', -1], 0xc5: ['multianewarray', 3],
  0xc6: ['ifnull', 2], 0xc7: ['ifnonnull', 2],
  0xc8: ['goto_w', 4], 0xc9: ['jsr_w', 4],
};

// Opcodes whose operand is a constant pool index, and how wide it is.
const CP_OPERAND = new Set([
  'ldc', 'ldc_w', 'ldc2_w', 'getstatic', 'putstatic', 'getfield', 'putfield',
  'invokevirtual', 'invokespecial', 'invokestatic', 'invokeinterface',
  'invokedynamic', 'new', 'anewarray', 'checkcast', 'instanceof', 'multianewarray',
]);

function decode(code, pool) {
  const out = [];
  let p = 0;
  while (p < code.length) {
    const pc = p;
    const b = code.readUInt8(p++);
    const entry = OPCODES[b];
    if (!entry) throw new Error(`unknown opcode 0x${b.toString(16)} at ${pc}`);
    const [op, nOperand] = entry;
    const ins = { pc, op };

    if (op === 'tableswitch' || op === 'lookupswitch') {
      // Padded to a 4-byte boundary from the start of the method's code.
      while (p % 4 !== 0) p++;
      const def = code.readInt32BE(p); p += 4;
      ins.default = pc + def;
      ins.targets = [];
      if (op === 'tableswitch') {
        const lo = code.readInt32BE(p); p += 4;
        const hi = code.readInt32BE(p); p += 4;
        for (let k = lo; k <= hi; k++) { ins.targets.push({ key: k, target: pc + code.readInt32BE(p) }); p += 4; }
      } else {
        const n = code.readInt32BE(p); p += 4;
        for (let k = 0; k < n; k++) {
          const key = code.readInt32BE(p); p += 4;
          ins.targets.push({ key, target: pc + code.readInt32BE(p) }); p += 4;
        }
      }
      ins.text = `default -> ${ins.default}`;
      out.push(ins);
      continue;
    }

    if (op === 'wide') {
      const inner = OPCODES[code.readUInt8(p++)][0];
      ins.op = 'wide ' + inner;
      ins.index = code.readUInt16BE(p); p += 2;
      if (inner === 'iinc') { ins.const = code.readInt16BE(p); p += 2; }
      out.push(ins);
      continue;
    }

    if (nOperand > 0) {
      if (op === 'ldc') { ins.cpIndex = code.readUInt8(p); p += 1; }
      else if (CP_OPERAND.has(op)) { ins.cpIndex = code.readUInt16BE(p); p += 2; }
      else if (op === 'bipush') { ins.value = code.readInt8(p); p += 1; }
      else if (op === 'sipush') { ins.value = code.readInt16BE(p); p += 2; }
      else if (op === 'iinc') { ins.index = code.readUInt8(p); ins.const = code.readInt8(p + 1); p += 2; }
      else if (op.endsWith('load') || op.endsWith('store') || op === 'ret') { ins.index = code.readUInt8(p); p += 1; }
      else if (nOperand === 2) { ins.branch = pc + code.readInt16BE(p); p += 2; }
      else if (nOperand === 4) { ins.branch = pc + code.readInt32BE(p); p += 4; }
      else p += nOperand;
      // invokeinterface and multianewarray carry trailing bytes after the index.
      if (op === 'invokeinterface') p += 2;
      if (op === 'invokedynamic') p += 2;
      if (op === 'multianewarray') p += 1;
    }

    if (ins.cpIndex != null) {
      ins.const = cpResolve(pool, ins.cpIndex);
      const c = ins.const;
      ins.text = c
        ? (c.owner ? `${c.owner}.${c.name}${c.descriptor || ''}`
          : c.name || (c.value !== undefined ? JSON.stringify(c.value) : c.kind))
        : `#${ins.cpIndex}`;
    } else if (ins.value !== undefined) ins.text = String(ins.value);
    else if (ins.branch !== undefined) ins.text = '-> ' + ins.branch;
    else if (ins.index !== undefined) ins.text = '#' + ins.index;

    out.push(ins);
  }
  return out;
}

function readAttributes(r, pool) {
  const n = r.u2();
  const out = [];
  for (let i = 0; i < n; i++) {
    const nameIndex = r.u2();
    const len = r.u4();
    const name = pool[nameIndex] && pool[nameIndex].value;
    out.push({ name, data: r.bytes(len) });
  }
  return out;
}

function readCode(attr, pool) {
  const r = new Reader(attr.data);
  const maxStack = r.u2(), maxLocals = r.u2();
  const len = r.u4();
  const code = r.bytes(len);
  const exLen = r.u2();
  const handlers = [];
  for (let i = 0; i < exLen; i++) {
    handlers.push({ start: r.u2(), end: r.u2(), handler: r.u2(), type: r.u2() });
  }
  // The nested attributes (StackMapTable, LineNumberTable) are of no use here.
  return { maxStack, maxLocals, code, handlers, instructions: decode(code, pool) };
}

/** Parse a .class file into { thisClass, superClass, methods, fields, pool }. */
export function readClass(buf) {
  const r = new Reader(buf);
  const magic = r.u4();
  if (magic !== 0xCAFEBABE) throw new Error('not a class file');
  r.u2(); r.u2();                                   // minor, major
  const pool = readConstantPool(r);
  const className = (i) => {
    const c = cpResolve(pool, i);
    return c && c.name;
  };
  const accessFlags = r.u2();
  const thisClass = className(r.u2());
  const superIdx = r.u2();
  const superClass = superIdx ? className(superIdx) : null;
  const nIface = r.u2();
  const interfaces = [];
  for (let i = 0; i < nIface; i++) interfaces.push(className(r.u2()));

  const members = (isMethod) => {
    const n = r.u2();
    const out = [];
    for (let i = 0; i < n; i++) {
      const flags = r.u2();
      const name = pool[r.u2()].value;
      const descriptor = pool[r.u2()].value;
      const attrs = readAttributes(r, pool);
      const m = { flags, name, descriptor, attributes: attrs, static: !!(flags & 0x0008) };
      if (isMethod) {
        const code = attrs.find(a => a.name === 'Code');
        if (code) { try { m.code = readCode(code, pool); } catch (err) { m.codeError = String(err.message); } }
      } else {
        const cv = attrs.find(a => a.name === 'ConstantValue');
        if (cv) m.constantValue = cpResolve(pool, cv.data.readUInt16BE(0));
      }
      out.push(m);
    }
    return out;
  };
  const fields = members(false);
  const methods = members(true);

  // The BootstrapMethods attribute, which invokedynamic indexes into. Needed
  // to follow a lambda back to the method that implements it.
  const attrs = readAttributes(r, pool);
  let bootstrapMethods = null;
  const bm = attrs.find(a => a.name === 'BootstrapMethods');
  if (bm) {
    const br = new Reader(bm.data);
    const n = br.u2();
    bootstrapMethods = [];
    for (let i = 0; i < n; i++) {
      const ref = cpResolve(pool, br.u2());
      const argc = br.u2();
      const args = [];
      for (let k = 0; k < argc; k++) args.push(cpResolve(pool, br.u2()));
      bootstrapMethods.push({ ref, args });
    }
  }

  return { accessFlags, thisClass, superClass, interfaces, fields, methods, pool, attributes: attrs, bootstrapMethods };
}

export { cpResolve };
