// sharp cannot read inside app.asar (it opens files with native code), so the
// main process goes through backend/sharp-asar.js, which reads such a path
// with Electron's fs first. A built launcher's app icon -- every kind built
// from the icon's layer files -- failed without it and worked in development.
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import sharp from "../backend/sharp-asar.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let bad = 0;
const check = (what, got, want, note) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${note ? "  — " + note : ""}`
    + (ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`));
};

// Nothing in the backend takes sharp straight from the package.
const direct = fs.readdirSync(path.join(ROOT, "backend"))
  .filter(f => f.endsWith(".js") && f !== "sharp-asar.js")
  .filter(f => /from\s+["']sharp["']|require\(["']sharp["']\)/.test(fs.readFileSync(path.join(ROOT, "backend", f), "utf8")));
check("the backend uses sharp only through sharp-asar.js", direct, [],
  "plain sharp cannot open the launcher's own pictures in a built launcher");

// It still takes everything sharp takes.
const logo = path.join(ROOT, "frontend", "assets", "icon", "redstone_logo.png");
const a = await sharp(logo).resize(16, 16).png().toBuffer();
check("a path", a.length > 0, true);
const b = await sharp(fs.readFileSync(logo)).resize(16, 16).png().toBuffer();
check("bytes", b.length > 0, true);
const c = await sharp({ create: { width: 8, height: 8, channels: 4, background: "#000" } }).png().toBuffer();
check("a made-up image", c.length > 0, true);
check("and sharp's own properties", typeof sharp.cache, "function");

// A path that names an archive is read with fs. Outside Electron there is no
// archive reading, so a folder called *.asar stands in: what matters is that
// the wrapper hands sharp the bytes rather than the path.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-"));
  const fake = path.join(dir, "app.asar", "frontend");
  fs.mkdirSync(fake, { recursive: true });
  fs.copyFileSync(logo, path.join(fake, "logo.png"));
  const orig = fs.readFileSync;
  let readThroughFs = false;
  fs.readFileSync = function (p, ...rest) { if (String(p).includes("app.asar")) readThroughFs = true; return orig.call(this, p, ...rest); };
  try { await sharp(path.join(fake, "logo.png")).png().toBuffer(); } finally { fs.readFileSync = orig; }
  check("a path inside app.asar is read through fs", readThroughFs, true);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
