// A theme carries its pictures. All of them.
//
// A background is a STACK of pictures now, and a theme that is saved with
// "its picture" ticked is supposed to bring it with it -- the paths in the
// setting belong to the computer the theme was made on and mean nothing to
// anybody else, so the bytes travel.
//
// It carried one: the top of the stack. That looked like it worked, because
// applying it on the computer it was made on kept whichever of the saved
// paths still existed. Then moving to another theme prunes the copies
// nothing points at any more -- so the pictures the theme had not carried
// were deleted off the disk, and coming back there was one picture left.
//
// The real functions out of main.js, with the settings store and the folder
// it writes into handed in.
import fs from "fs";
import os from "os";
import path from "path";
import { liftModule } from "./lib/lift.mjs";

let bad = 0;
const check = (what, got, want, note) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${note ? "  — " + note : ""}`
    + (ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`));
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "theme-wall-"));
const dataDir = path.join(tmp, "data");
fs.mkdirSync(path.join(dataDir, "background"), { recursive: true });

const store = {};
const mod = await liftModule(
  ["WALLPAPER_MAX", "currentWallpapers", "readWallpapers",
    "_wallpaperSeq", "freshWallpaperPath", "placeWallpaper",
    "backgroundFilesInUse", "pruneBackgroundCopies", "withCarriedWallpapers"],
  {
    file: "themewall",
    prelude: 'import fs from "fs";\nimport path from "path";\n'
      + "export const settings = { get: (k, d) => (k in STORE ? STORE[k] : d) };\n"
      + "export let STORE = {};\nexport const setStore = (s) => { STORE = s; };\n"
      + "export let dataDir = null;\nexport const setDataDir = (d) => { dataDir = d; };\n",
  },
);
mod.setDataDir(dataDir);
const setBackground = (bg) => mod.setStore({ background: bg });

// Two pictures of this computer's own, as a wallpaper folder would hold.
const pics = [];
for (const [name, byte] of [["one.png", 11], ["two.png", 22]]) {
  const f = path.join(tmp, name);
  fs.writeFileSync(f, Buffer.from([byte, byte, byte, byte]));
  pics.push(f);
}

// ── what a theme takes with it ──
{
  setBackground({
    mode: "image",
    images: [{ file: pics[0], fit: "contain" }, { file: pics[1], fit: "cover" }],
    image: { file: pics[0], fit: "contain" },
  });
  const w = mod.currentWallpapers();
  check("every picture of the stack goes with the theme",
    w.map(x => [x.name, x.fit]), [["one.png", "contain"], ["two.png", "cover"]],
    "it used to be bg.image and nothing else, which is the top of the stack");
  check("and each one carries its own bytes",
    w.map(x => Buffer.from(x.data, "base64").length), [4, 4]);
}

// A stack too big to be a theme is refused as a whole rather than half
// carried: the limit is about the size of the theme file.
{
  const big = path.join(tmp, "big.png");
  fs.writeFileSync(big, Buffer.alloc(mod.WALLPAPER_MAX + 10, 7));
  setBackground({ mode: "image", images: [{ file: pics[0] }, { file: big }], image: { file: pics[0] } });
  const w = mod.currentWallpapers();
  check("a stack too big for a theme says so", !!(w && w.tooBig), true);
}

// A background saved before there were stacks is a stack of one.
{
  setBackground({ mode: "image", image: { file: pics[1], fit: "stretch" } });
  check("one picture and no list still goes",
    mod.currentWallpapers().map(x => [x.name, x.fit]), [["two.png", "stretch"]]);
}

// ── and what comes back ──
//
// The theme is applied on another computer: its own background names paths
// that do not exist here, and the pictures it carries are what the stack is
// rebuilt out of.
{
  setBackground({ mode: "image", images: [{ file: pics[0], fit: "contain" }, { file: pics[1], fit: "cover" }], image: { file: pics[0] } });
  const theme = {
    wallpapers: mod.currentWallpapers(),
    background: {
      mode: "image",
      images: [{ file: "D:/somebody/else/one.png", fit: "contain" }, { file: "D:/somebody/else/two.png", fit: "cover" }],
      image: { file: "D:/somebody/else/one.png" },
    },
  };
  const out = mod.withCarriedWallpapers(theme.background, theme);
  check("the whole stack is put back, in order",
    out.images.length, 2,
    "a theme that carried one picture left the rest of the stack pointing at another computer's disk");
  check("each one is a file on THIS computer",
    out.images.map(im => fs.existsSync(im.file)), [true, true]);
  check("in the launcher's own background folder",
    out.images.map(im => path.dirname(im.file) === path.join(dataDir, "background")), [true, true]);
  check("with the fit it was saved with",
    out.images.map(im => im.fit), ["contain", "cover"]);
  check("and each one a file of its own",
    new Set(out.images.map(im => im.file)).size, 2,
    "two pictures written in the same millisecond must not be given the same name");
  check("and the top one mirrored as `image`",
    out.image.file, out.images[0].file,
    "everything that means `the picture` -- the theme's colours, the icon's backing -- reads that");

  // Now the part that was actually broken: moving to another theme throws
  // away the copies nothing points at, and coming back has to bring them
  // all back rather than whichever one survived.
  setBackground({ mode: "image", images: out.images, image: out.image });
  const kept = [...mod.backgroundFilesInUse()];
  check("both copies are counted as in use", kept.length, 2,
    "the pruning is what deleted the picture a theme had not carried");

  setBackground({ mode: "theme" });          // off to another theme
  mod.pruneBackgroundCopies();
  check("and both are swept up when nothing points at them",
    out.images.filter(im => fs.existsSync(im.file)).length, 0);

  const again = mod.withCarriedWallpapers(theme.background, theme);
  check("coming back puts both of them on disk again",
    again.images.map(im => fs.existsSync(im.file)), [true, true],
    "which is the whole bug: it came back with one");
}

// ── a theme file somebody else wrote ──
{
  const file = {
    wallpapers: [
      { ext: ".png", name: "a.png", fit: "contain", data: "AAAA" },
      { ext: ".png", name: "b.png", data: "BBBB" },
      { name: "no data at all" },
    ],
  };
  check("what a theme file carries is taken field by field",
    mod.readWallpapers(file).map(w => [w.name, w.fit]),
    [["a.png", "contain"], ["b.png", "cover"]],
    "it came out of a file somebody else wrote; nothing else about it is taken");
  check("a file from before stacks still reads",
    mod.readWallpapers({ wallpaper: { name: "old.png", data: "CCCC" } }).map(w => w.name),
    ["old.png"]);
  check("and one that carries nothing is nothing",
    mod.readWallpapers({}), []);
}

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
