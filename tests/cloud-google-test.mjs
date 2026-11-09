// Signing in with Google, driven end to end.
//
// A real loopback server, a real browser redirect (made by this test rather
// than by a person), and a stand-in for Google's token endpoint that checks
// what it was sent. So what is tested is the flow itself -- PKCE, the state
// parameter, the redirect URI, asking for a refresh token -- rather than
// whether the functions exist.
import crypto from "crypto";
import google from "../backend/cloud-google.js";

let bad = 0;
const ok = (what, note) => console.log(`ok   ${what}${note ? "  — " + note : ""}`);
const fail = (what, why) => { bad++; console.log(`FAIL ${what}\n       ${why}`); };
const check = (what, got, want, note) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) ok(what, note); else fail(what, `got  ${a}\n       want ${b}`);
};

const CLIENT = { clientId: "123.apps.googleusercontent.com", clientSecret: "shh" };
const realFetch = globalThis.fetch;

/**
 * Stand in for Google.
 *
 * `onToken` sees the form the launcher posted, so the test can check what was
 * sent rather than only what came back.
 */
function fakeGoogle({ onToken = () => ({}), token = {}, email = "someone@example.com" } = {}) {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith("https://oauth2.googleapis.com/token")) {
      const form = Object.fromEntries(new URLSearchParams(String(init.body)));
      const said = onToken(form);
      if (said && said.error) {
        return { ok: false, status: 400, text: async () => JSON.stringify(said) };
      }
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({
          access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, ...token,
        }),
      };
    }
    if (u.startsWith("https://www.googleapis.com/oauth2/v3/userinfo")) {
      return { ok: true, status: 200, json: async () => ({ email }) };
    }
    if (u.startsWith("https://oauth2.googleapis.com/revoke")) return { ok: true, status: 200 };
    throw new Error(`the test did not expect a request to ${u}`);
  };
}

/** A browser that goes where it is sent and comes back, as a real one would. */
const browser = (tweak = (p) => p) => async (authUrl) => {
  const u = new URL(authUrl);
  const back = new URL(u.searchParams.get("redirect_uri"));
  const params = tweak({
    code: "the-code",
    state: u.searchParams.get("state"),
  }, u);
  if (params === null) return;                       // never comes back
  back.search = new URLSearchParams(params).toString();
  const res = await realFetch(back.toString());
  return { status: res.status, body: await res.text(), authUrl: u };
};

// ── the ordinary way through ──
{
  let sent = null, seen = null;
  fakeGoogle({ onToken: (f) => { sent = f; } });
  const out = await google.signIn({
    client: CLIENT,
    openBrowser: async (url) => { seen = new URL(url); return browser()(url); },
  });
  check("signing in gives back what is needed to sync tomorrow, not only today",
    [out.refreshToken, out.accessToken, out.email, out.expiresAt > Date.now()],
    ["rt-1", "at-1", "someone@example.com", true]);

  check("it asks for only the files it makes, not the whole Drive",
    seen.searchParams.get("scope").split(" "),
    ["https://www.googleapis.com/auth/drive.file",
      "https://www.googleapis.com/auth/userinfo.email"],
    "this is somebody's entire document store; drive.file cannot see anything the launcher did not create");

  check("and it asks in a way that actually yields a refresh token",
    [seen.searchParams.get("access_type"), seen.searchParams.get("prompt")],
    ["offline", "consent"],
    "without these a second sign-in returns an access token and syncing stops working an hour later");

  check("the browser is sent to the loopback address and nowhere else",
    /^http:\/\/127\.0\.0\.1:\d+$/.test(seen.searchParams.get("redirect_uri")), true);
  check("and the port is whatever was free",
    sent.redirect_uri, seen.searchParams.get("redirect_uri"),
    "the exchange has to name the same one back");

  // PKCE, which is what makes the code worth nothing to anybody who sees it.
  const challenge = seen.searchParams.get("code_challenge");
  check("the request carries a hash and the exchange carries the secret itself",
    [seen.searchParams.get("code_challenge_method"),
      !!sent.code_verifier,
      challenge !== sent.code_verifier],
    ["S256", true, true]);
  check("and the hash really is of that secret",
    crypto.createHash("sha256").update(sent.code_verifier).digest("base64")
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
    challenge,
    "another program racing to the loopback port gets a code it cannot spend");
}

// ── things that go wrong ──
{
  // A page on the machine firing a code at our port is the attack PKCE and
  // `state` exist for. The wrong state must not end the sign-in -- the real
  // browser may still be on its way.
  fakeGoogle();
  let answered = null;
  const out = await google.signIn({
    client: CLIENT,
    openBrowser: async (url) => {
      const u = new URL(url);
      const back = new URL(u.searchParams.get("redirect_uri"));
      back.search = new URLSearchParams({ code: "somebody-elses", state: "wrong" }).toString();
      const res = await realFetch(back.toString());
      answered = res.status;
      // Then the real browser arrives.
      return browser()(url);
    },
  });
  check("a code with the wrong state is turned away, and the real one still works",
    [answered, out.refreshToken], [400, "rt-1"],
    "a page on this machine firing at the loopback port must not be able to end the sign-in either");
}
{
  fakeGoogle();
  let said = null;
  await google.signIn({
    client: CLIENT,
    openBrowser: browser((p) => ({ error: "access_denied", state: p.state })),
  }).catch(e => { said = e.message; });
  check("saying no at Google's page comes back as that, not as a failure",
    said, "You did not give the launcher access.");
}
{
  fakeGoogle({ token: { refresh_token: undefined } });
  let said = null;
  await google.signIn({ client: CLIENT, openBrowser: browser() }).catch(e => { said = e.message; });
  check("no refresh token is caught now rather than an hour later",
    /did not send a refresh token/.test(said || ""), true,
    said);
}
{
  fakeGoogle({ onToken: () => ({ error: "redirect_uri_mismatch", error_description: "Bad Request" }) });
  let said = null;
  await google.signIn({ client: CLIENT, openBrowser: browser() }).catch(e => { said = e.message; });
  check("and what Google actually said is passed through",
    /Bad Request/.test(said || ""), true,
    "redirect_uri_mismatch is the useful part when the client is set up wrong, not \"sign-in failed\"");
}
{
  let said = null;
  await google.signIn({ client: {} }).catch(e => { said = e.message; });
  check("with no client configured it says so instead of opening a broken page",
    said, "This relay has no Google client set up yet.");
}
{
  fakeGoogle();
  let said = null;
  const started = Date.now();
  await google.signIn({ client: CLIENT, openBrowser: async () => { /* never comes back */ }, timeoutMs: 300 })
    .catch(e => { said = e.message; });
  check("and a sign-in nobody finishes gives up rather than waiting for ever",
    [said, Date.now() - started < 3000], ["Signing in took too long.", true]);
}

// ── keeping it alive, and ending it ──
{
  let form = null;
  fakeGoogle({ onToken: (f) => { form = f; } });
  const r = await google.refresh({ client: CLIENT, refreshToken: "rt-1" });
  check("refreshing asks with the refresh token and gets a new access token",
    [form.grant_type, form.refresh_token, r.accessToken, r.expiresAt > Date.now()],
    ["refresh_token", "rt-1", "at-1", true]);

  let revoked = null;
  globalThis.fetch = async (url) => { revoked = String(url); return { ok: true, status: 200 }; };
  await google.revoke({ refreshToken: "rt-1" });
  check("signing out tells Google, rather than only forgetting locally",
    /oauth2\.googleapis\.com\/revoke\?token=rt-1/.test(revoked || ""), true,
    "a token that still works somewhere is not signed out, it is out of sight");
}

globalThis.fetch = realFetch;
console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
