// Where a skin can come from when Mojang's session server will not say.
//
// It goes down, and answers with an HTML page titled "Service unavailable".
// A launcher that only asks it then has nothing but a default skin to draw,
// which is also exactly what an account with no custom skin looks like.
//
// What is here is the account telling the launcher about itself:
// api.minecraftservices.com, a different service on different machines,
// asked with the account's own token. It is authoritative, and it covers
// the accounts somebody notices going Steve -- their own.
//
// What is deliberately NOT here is the public skin mirrors (minotar,
// crafatar, mc-heads). They were tried and taken out again: for a player
// they have not already cached they answer 200 with a default skin, which
// is then drawn and remembered as that player, and many lookups at once is
// what gets a launcher rate-limited by them. A fallback that can lie is
// worse than none.

/**
 * What an account says about itself, with its own token.
 *
 * api.minecraftservices.com is a different service on different machines
 * from sessionserver, so one being down says nothing about the other -- and
 * this is the authoritative answer for the accounts the launcher is signed
 * in to, which are the ones somebody notices going Steve.
 *
 * Cloudflare sits in front of it and rejects a request with no User-Agent
 * (or Node's default), so one is always sent.
 */
export async function profileFromServices(token, { fetchImpl = fetch, userAgent = "minecraft-launcher" } = {}) {
  if (!token || token === "0") return null;
  let res;
  try {
    res = await fetchImpl("https://api.minecraftservices.com/minecraft/profile", {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": userAgent },
    });
  } catch { return null; }
  if (!res || !res.ok) return null;
  let data;
  try { data = await res.json(); } catch { return null; }   // HTML, when it is down too
  const skin = (data.skins || []).find(s => String(s.state).toUpperCase() === "ACTIVE") || (data.skins || [])[0];
  if (!skin || !skin.url) return null;
  const cape = (data.capes || []).find(c => String(c.state).toUpperCase() === "ACTIVE");
  return {
    hash: String(skin.url).split("/").pop() || null,
    url: skin.url,
    slim: String(skin.variant || "").toUpperCase() === "SLIM",
    cape: (cape && cape.url) || null,
    id: data.id || null,
    name: data.name || null,
  };
}

/**
 * Is a service answering at all, or answering with a page saying it is not?
 *
 * Mojang's outage pages come back as HTML with a title that says so, and
 * sometimes with a 200. "It answered" is therefore not the same question as
 * "it is up", and the difference is worth saying out loud in a log: "Mojang
 * is down" is a sentence somebody can act on, where "unexpected token <" is
 * not.
 */
export function describeOutage(status, body) {
  const text = String(body || "").slice(0, 2000);
  const title = /<title>([^<]{1,120})<\/title>/i.exec(text);
  if (title) return `${title[1].trim()}${status ? ` (${status})` : ""}`;
  if (status === 429) return "we are being rate-limited (429)";
  if (status >= 500) return `it answered ${status}`;
  if (status === 0 || status === undefined) return "it could not be reached";
  return `it answered ${status}`;
}

export default { profileFromServices, describeOutage };
