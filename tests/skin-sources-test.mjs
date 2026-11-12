// Where a skin comes from when Mojang will not say.
//
// Mojang's session server goes down, and not politely: it answers with an
// HTML page whose title is "Service unavailable". A launcher that only asks
// Mojang has nothing then, and the obvious thing to draw is a default skin --
// which is also exactly what an account with no custom skin looks like, so
// the launcher says nothing is wrong while every premium account wears
// Steve. "Have a fallback, not just the default" is the right answer, and
// this is about doing that without making things worse.
//
// Worse is easy here. The launcher used to point an <img> straight at
// minotar.net and mc-heads.net, and was moved off them because when those
// services throttle they answer 200 with a default skin rather than an
// error. A fallback that lies is worse than one that fails: the lie cannot
// be told from an answer. So what is checked here is mostly the refusing.
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { fileURLToPath } from "url";
import src from "../backend/skin-sources.js";

let bad = 0;
const check = (what, got, want, note) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${note ? "  — " + note : ""}`
    + (ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`));
};

// ── a PNG of the right shape, built by hand ───────────────────────────────
//
// Only the header is read, so only the header has to be real -- but it is a
// real one, chunk lengths and CRCs and all, rather than a string that
// happens to start with the right bytes.
function pngOf(width, height) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;                 // 8-bit RGBA
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) >>> 0 : 0);
    return Buffer.concat([len, body, crc]);
  };
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IEND", Buffer.alloc(0))]);
}

// ── what is and is not a skin ─────────────────────────────────────────────
{
  check("a 64x64 sheet is a skin",
    (src.readSkinPng(pngOf(64, 64)) || {}).scale, 1);
  check("and so is an old 64x32 one",
    [(src.readSkinPng(pngOf(64, 32)) || {}).legacy, (src.readSkinPng(pngOf(64, 32)) || {}).scale],
    [true, 1]);
  check("and an HD one, which is a whole multiple of both",
    (src.readSkinPng(pngOf(256, 256)) || {}).scale, 4);
  check("an avatar is not a skin",
    src.readSkinPng(pngOf(96, 96)), null,
    "96 is not 64 times anything whole, so it is not a sheet at any scale");
  check("but 128 is, because an HD skin is a whole multiple",
    (src.readSkinPng(pngOf(128, 128)) || {}).scale, 2);
  check("and a sheet the wrong shape is not one either",
    src.readSkinPng(pngOf(64, 48)), null,
    "a skin is square or exactly half as tall as it is wide");
  check("nor is a tracking pixel", src.readSkinPng(pngOf(1, 1)), null);
  check("nor is an error page with a PNG's name on it",
    src.readSkinPng(Buffer.from("<html><title>Service unavailable</title></html>")), null,
    "which is exactly what Mojang answers with when it is down");
  check("nor is nothing at all",
    [src.readSkinPng(null), src.readSkinPng(Buffer.alloc(0))], [null, null]);
  // A PNG whose IHDR is not where a PNG's IHDR is.
  const odd = Buffer.concat([pngOf(64, 64).subarray(0, 12), Buffer.from("tEXt"), Buffer.alloc(40)]);
  check("nor a PNG that does not begin the way a PNG begins",
    src.readSkinPng(odd), null);
}

// ── the mirrors ───────────────────────────────────────────────────────────
const UUID = "069a79f444e94726a5befca90e38aaf5";
const skin = pngOf(64, 64);

{
  const tried = [];
  const got = await src.skinFromMirrors(UUID, {
    get: async (url) => { tried.push(url); return { ok: true, status: 200, body: skin }; },
  });
  check("the first mirror that answers is the one used",
    [tried.length, got && got.via], [1, "minotar.net"],
    "minotar first because it answers with Mojang's own bytes rather than a re-encoding");
}

// One being down moves on to the next, which is the whole point of having
// three of them.
{
  const tried = [];
  const got = await src.skinFromMirrors(UUID, {
    get: async (url) => {
      tried.push(url);
      if (/minotar/.test(url)) return { ok: false, status: 503 };
      if (/crafatar/.test(url)) return { ok: false, status: 0, error: "it took too long" };
      return { ok: true, status: 200, body: skin };
    },
  });
  check("one being down is not all of them being down",
    [tried.length, got && got.via], [3, "mc-heads.net"]);
}

// The one that matters: an answer that is not a skin is not taken for one.
{
  const got = await src.skinFromMirrors(UUID, {
    get: async () => ({ ok: true, status: 200, body: Buffer.from("<html><title>Too many requests</title></html>") }),
  });
  check("a mirror answering 200 with a page is no answer at all", got, null,
    "a fallback that lies is worse than one that fails");
}

// All of them down.
{
  const got = await src.skinFromMirrors(UUID, { get: async () => ({ ok: false, status: 503 }) });
  check("and nowhere having it says so", got, null);
}

// Not a uuid: nothing is asked of anybody.
{
  const tried = [];
  const got = await src.skinFromMirrors("Notch", { get: async (u) => { tried.push(u); return { ok: true, body: skin }; } });
  check("a name is not a uuid, and nothing is asked", [got, tried.length], [null, 0],
    "every one of these services takes a uuid; a name would fetch somebody else");
}

// Dashes, which is how a uuid is written everywhere except in these URLs.
{
  const tried = [];
  await src.skinFromMirrors("069a79f4-44e9-4726-a5be-fca90e38aaf5", {
    get: async (u) => { tried.push(u); return { ok: true, status: 200, body: skin }; },
  });
  check("and a uuid with dashes in it is asked for without them",
    /[0-9a-f]{32}$/.test(tried[0] || ""), true);
}

// ── the account telling us about itself ───────────────────────────────────
//
// api.minecraftservices.com is a different service on different machines
// from sessionserver, so one being down says nothing about the other. It is
// also authoritative, and it works for exactly the accounts somebody
// notices going Steve: their own.
{
  const body = {
    id: UUID, name: "Someone",
    skins: [
      { id: "1", state: "INACTIVE", url: "https://textures.minecraft.net/texture/old", variant: "CLASSIC" },
      { id: "2", state: "ACTIVE", url: "https://textures.minecraft.net/texture/abc123", variant: "SLIM" },
    ],
    capes: [{ id: "c", state: "ACTIVE", url: "https://textures.minecraft.net/texture/cape" }],
  };
  let sent = null;
  const got = await src.profileFromServices("a-token", {
    fetchImpl: async (url, opts) => { sent = { url, opts }; return { ok: true, json: async () => body }; },
  });
  check("the account's own profile gives its texture",
    [got.hash, got.slim, got.cape], ["abc123", true, "https://textures.minecraft.net/texture/cape"],
    "the ACTIVE one, not the first in the list");
  check("asked for with the account's token",
    sent.opts.headers.Authorization, "Bearer a-token");
  check("and with a user agent, because Cloudflare rejects a request with none",
    !!sent.opts.headers["User-Agent"], true);
}
{
  check("no token, nothing asked",
    await src.profileFromServices("", { fetchImpl: async () => { throw new Error("should not be asked"); } }), null);
  check("and the 0 that stands in for one on an offline account is not a token",
    await src.profileFromServices("0", { fetchImpl: async () => { throw new Error("should not be asked"); } }), null);
}
{
  // Down as well, and answering HTML like everything else that day.
  const got = await src.profileFromServices("a-token", {
    fetchImpl: async () => ({ ok: true, json: async () => { throw new Error("Unexpected token <"); } }),
  });
  check("it being down too is no answer rather than a crash", got, null);
}

// ── saying what went wrong in words ───────────────────────────────────────
//
// "Mojang is down" is a sentence somebody can act on. "Unexpected token <"
// is not, and it is what the log said.
{
  check("an outage page is read for what it says",
    src.describeOutage(200, "<html><head><title>Service unavailable</title></head>"),
    "Service unavailable (200)",
    "it comes back as a 200, which is half of why this was confusing");
  check("a rate limit says so in words", src.describeOutage(429, ""), "we are being rate-limited (429)");
  check("and a plain failure says what it was", src.describeOutage(503, ""), "it answered 503");
  check("and no answer at all says that", src.describeOutage(0, ""), "it could not be reached");
}

// ── and the launcher actually uses it ─────────────────────────────────────
{
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const main = fs.readFileSync(path.join(ROOT, "backend", "main.js"), "utf8");
  check("the skin path tries somewhere else before it gives up",
    /skinFromSomewhereElse\(id, \{ playerId \}\)/.test(main), true);
  check("and so does the head path",
    (main.match(/skinFromSomewhereElse/g) || []).length >= 3, true,
    "the declaration, the skin, and the head");
  check("a stand-in is still asked about again later",
    /if \(!other\.sure\) headWasGuessed\(id\)/.test(main), true,
    "drawn because it is the best picture there is, never settled on");
}

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
