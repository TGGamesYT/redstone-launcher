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
import { fileURLToPath } from "url";
import src from "../backend/skin-sources.js";

let bad = 0;
const check = (what, got, want, note) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${note ? "  — " + note : ""}`
    + (ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`));
};

// ── the account telling us about itself ───────────────────────────────────
//
// api.minecraftservices.com is a different service on different machines
// from sessionserver, so one being down says nothing about the other. It is
// also authoritative, and it works for exactly the accounts somebody
// notices going Steve: their own.
{
  const body = {
    id: "069a79f444e94726a5befca90e38aaf5", name: "Someone",
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

// ── and no mirrors ────────────────────────────────────────────────────────
//
// The public skin mirrors were tried as a further fallback and taken out
// again, for the reason the owner gave: for a player they have not already
// cached they answer with a DEFAULT skin rather than an error, which is then
// drawn and remembered as that player; and a launcher's worth of lookups is
// what gets them rate-limiting. Checked here so they do not drift back in.
{
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  const code = strip(fs.readFileSync(path.join(ROOT, "backend", "main.js"), "utf8"))
    + strip(fs.readFileSync(path.join(ROOT, "backend", "skin-sources.js"), "utf8"));
  check("no skin mirror is asked for anything",
    ["minotar", "crafatar", "mc-heads"].filter(m => code.includes(m)), [],
    "one that has not cached a player answers with a default, and that would be cached as the player");
  const main = fs.readFileSync(path.join(ROOT, "backend", "main.js"), "utf8");
  check("the skin path still tries our own files and the account before giving up",
    [/skinFromSomewhereElse\(id, \{ playerId \}\)/.test(main), /profileFromServices/.test(main), /skinFromOurOwnFiles/.test(main)],
    [true, true, true]);
}

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
