// A download is all of it or none of it.
//
// It used to write straight to the destination, so a connection that dropped
// halfway left a TRUNCATED file at the real path, looking like a finished
// download. A truncated zip is exactly what produces
//
//     Suppressed ZIP exception loading PNG ...: incorrect data check
//
// for every texture in it, for the life of the instance. Each case here is a
// real server behaving badly, and a real file read back off the disk.
import fs from "fs";
import path from "path";
import http from "http";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "node_modules", ".cache", "dl");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

let bad = 0;
const check = (label, got, want, note) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${note ? "  — " + note : ""}\n       got  ${JSON.stringify(got)}` + (ok ? "" : `\n       want ${JSON.stringify(want)}`));
};

// The launcher's own downloader, sliced out of main.js with the queue it sits
// behind replaced by "just run it".
const src = fs.readFileSync(path.join(ROOT, "backend/main.js"), "utf8");
const i = src.indexOf("function downloadFile(url, dest) {");
const j = src.indexOf("\n}\n", src.indexOf("runNextDownload();", i)) + 3;
if (i < 0 || j < 3) { console.log("FAIL could not find downloadFile in main.js"); process.exit(1); }
const downloadFile = new Function("fs", "path", "http", "https", `
  const downloadQueue = [];
  // The real queue catches a task's rejection (the caller's promise carries
  // it), so this stand-in must too, or a failed download looks like an
  // unhandled rejection that the launcher never actually has.
  const runNextDownload = () => { const t = downloadQueue.shift(); if (t) t().catch(() => {}); };
  ${src.slice(i, j)}
  return downloadFile;
`)(fs, path, http, http);

const BODY = Buffer.alloc(64 * 1024, 7);

// A server that can be told to misbehave.
let mode = "ok";
const server = http.createServer((req, res) => {
  if (mode === "ok") {
    res.writeHead(200, { "content-length": String(BODY.length) });
    res.end(BODY);
  } else if (mode === "cut") {
    // Promises the whole thing, sends a third, then drops the connection.
    res.writeHead(200, { "content-length": String(BODY.length) });
    res.write(BODY.subarray(0, BODY.length / 3));
    setTimeout(() => res.destroy(), 20);
  } else if (mode === "short") {
    // Ends cleanly, but short of what it promised.
    res.writeHead(200, { "content-length": String(BODY.length) });
    res.end(BODY.subarray(0, BODY.length / 2));
  } else if (mode === "404") {
    res.writeHead(404); res.end("no");
  } else if (mode === "redirect") {
    res.writeHead(302, { location: `http://127.0.0.1:${port}/real` });
    res.end();
  }
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const port = server.address().port;
const url = (p = "/") => `http://127.0.0.1:${port}${p}`;
const grab = async (dest) => {
  try { await downloadFile(url(), dest); return null; }
  catch (e) { return e.message; }
};
const leftovers = () => fs.readdirSync(OUT).sort();

// ── the good case ──
mode = "ok";
const good = path.join(OUT, "good.bin");
check("a whole file arrives whole", await grab(good), null);
check("byte for byte", [fs.statSync(good).size, Buffer.compare(fs.readFileSync(good), BODY)], [BODY.length, 0]);
check("and nothing is left beside it", leftovers(), ["good.bin"],
  "the half-written file has its own name until it is finished");

// ── the one that caused it ──
mode = "cut";
const cut = path.join(OUT, "cut.bin");
const whyCut = await grab(cut);
check("a connection that drops halfway fails, rather than succeeding quietly", whyCut !== null, true, whyCut);
check("and leaves NOTHING at the destination", fs.existsSync(cut), false,
  "this is the bug: a third of a zip sat there looking like a finished download");
check("nor a half-written file beside it", leftovers(), ["good.bin"]);

// ── short, but tidy about it ──
mode = "short";
const short = path.join(OUT, "short.bin");
const whyShort = await grab(short);
// Node's own client notices a body that ends short of the content-length it
// was promised and reports it as an abort; the launcher's length check is
// the backstop for the cases it does not (a proxy, a chunked body). Either
// way the download must fail rather than leave half a file.
check("a body that stops short of its own content-length is caught",
  whyShort !== null, true, whyShort);
check("and nothing is left of it", [fs.existsSync(short), leftovers()], [false, ["good.bin"]],
  "it ends the stream cleanly, so only the length gives it away");

// ── the ordinary failures ──
mode = "404";
check("a 404 is a failure", /404/.test(await grab(path.join(OUT, "missing.bin")) || ""), true);
check("with nothing left behind", leftovers(), ["good.bin"]);

mode = "redirect";
server.removeAllListeners("request");
server.on("request", (req, res) => {
  if (req.url === "/real") { res.writeHead(200, { "content-length": String(BODY.length) }); res.end(BODY); return; }
  res.writeHead(302, { location: url("/real") }); res.end();
});
const moved = path.join(OUT, "moved.bin");
check("a redirect is followed", await grab(moved), null);
check("and lands the whole file", fs.statSync(moved).size, BODY.length);

// Nothing may be an uncaught exception: this runs in the main process, and an
// 'error' with no listener takes the whole launcher down.
const uncaught = [];
process.on("uncaughtException", (e) => uncaught.push(e.message));
server.removeAllListeners("request");
server.on("request", (req, res) => { res.writeHead(200, { "content-length": "999999" }); res.write("x"); res.destroy(); });
for (let k = 0; k < 5; k++) await grab(path.join(OUT, `reset${k}.bin`));
await new Promise(r => setTimeout(r, 200));
check("a connection reset is never an uncaught exception", uncaught, []);

server.close();
console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
