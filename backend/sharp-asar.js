// sharp, made able to read files that are inside the app's own archive.
//
// A built launcher's files live in app.asar, one archive. Electron teaches
// Node's own fs to read inside it, but sharp opens a path with native code
// (libvips), which sees only the real disk -- so every sharp() handed a path
// to one of the launcher's own pictures failed in a built launcher and
// worked in development, where they are ordinary files. The app icon was the
// one that showed it: anything built from the icon's layer files (the
// launcher's mark, your colour, the background behind it) never changed,
// while a picture of your own, passed as bytes, did.
//
// So a path inside an archive is read through fs first and passed as bytes.
// Anything else goes straight through, untouched.
import fs from "fs";
import realSharp from "sharp";

const inArchive = (p) => typeof p === "string" && /\.asar([\\/]|$)/i.test(p);

function sharp(input, options) {
  if (inArchive(input)) input = fs.readFileSync(input);
  // Composite layers can be paths too.
  return arguments.length > 1 ? realSharp(input, options) : realSharp(input);
}
// Everything else sharp offers (cache, concurrency, versions…) as it is.
Object.assign(sharp, realSharp);

// composite() takes { input: path } entries; the same applies to those.
const composite = realSharp.prototype.composite;
realSharp.prototype.composite = function (images) {
  if (Array.isArray(images)) {
    images = images.map((im) => (im && inArchive(im.input)) ? { ...im, input: fs.readFileSync(im.input) } : im);
  }
  return composite.call(this, images);
};

export default sharp;
