// CurseForge's file fingerprint.
//
// A murmur2 of the file with every whitespace byte removed first, which is
// not a thing murmur2 normally does -- CurseForge does it so that a jar
// repacked with different line endings still matches. There is no way to ask
// for a file by its sha1 the way Modrinth allows, so this is the only handle
// on "which CurseForge file is this jar".
//
// It lived in main.js, which meant the one function the pack format needs to
// name a CurseForge file could not be used without loading the whole
// launcher. Moved out as it was, byte for byte, and checked against known
// fingerprints in tests/cf-fingerprint-test.mjs.
import fs from "fs";

const WHITESPACE = new Set([9, 10, 13, 32]);         // \t \n \r space
// CurseForge's (and Python's) murmur2 multiplier.
const MULTIPLEX = 0x5bd1e995;

/** The fingerprint of these bytes. */
export function fingerprintOf(data) {
  let lenNoWs = 0;
  for (const b of data) if (!WHITESPACE.has(b)) lenNoWs++;

  let num2 = (1 ^ lenNoWs) >>> 0;
  let num3 = 0;
  let num4 = 0;

  for (const b of data) {
    if (WHITESPACE.has(b)) continue;
    num3 |= (b << num4);
    num4 += 8;
    if (num4 === 32) {
      const a = Math.imul(num3, MULTIPLEX) >>> 0;
      const c = Math.imul((a ^ (a >>> 24)) >>> 0, MULTIPLEX) >>> 0;
      num2 = Math.imul(num2, MULTIPLEX) ^ c;
      num2 >>>= 0;
      num3 = 0;
      num4 = 0;
    }
  }
  if (num4 > 0) num2 = Math.imul(num2 ^ num3, MULTIPLEX) >>> 0;
  const last = Math.imul(num2 ^ (num2 >>> 13), MULTIPLEX) >>> 0;
  return (last ^ (last >>> 15)) >>> 0;
}

/** The fingerprint of the file at this path. */
export function getFingerprint(filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`File not found: ${filePath}`);
  }
  return fingerprintOf(fs.readFileSync(filePath));
}

export default { fingerprintOf, getFingerprint };
