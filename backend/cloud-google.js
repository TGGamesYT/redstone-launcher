// Signing in with Google, for syncing through Drive.
//
// The loopback flow, which is the one Google asks desktop apps to use: the
// launcher starts a server on 127.0.0.1, opens the system browser at
// Google's consent page, and Google sends the browser back to that server
// with a code. The browser is the user's own, so they can see the address
// they are typing their password into -- which is the whole reason not to do
// this in a window of ours.
//
// With PKCE, so the code is worth nothing to anybody who sees it go past: a
// random verifier is kept here, only its hash is sent with the request, and
// the exchange has to present the verifier. Another program on the machine
// racing to the loopback port gets a code it cannot spend.
//
// Nothing about the Google account is sent to the relay, and the relay's
// name for the OAuth client is all it provides -- the tokens are the user's
// and stay on the user's machine.
import crypto from "crypto";
import http from "http";

// Loaded when it is needed rather than at the top, so this file can be run
// and tested outside Electron -- the flow is ordinary HTTP and has no
// business needing a whole desktop framework present to be checked.
const openInBrowser = async (url) => {
  const { shell } = await import("electron");
  return shell.openExternal(url);
};

// Only what syncing needs:
//
//   drive.file   files this app made, and nothing else. The launcher cannot
//                see, list or touch anything else in the Drive -- which is
//                worth more than the convenience of the wider scope, since
//                this is somebody's whole document store.
//   userinfo     the address, so the settings page can say which account is
//                signed in rather than "signed in".
export const SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/userinfo.email",
];

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const INFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** What the browser is shown when it comes back. */
const DONE_PAGE = (title, body) => `<!doctype html><html><head><meta charset="utf-8">
<title>${title}</title><style>
 html,body{height:100%;margin:0;display:flex;align-items:center;justify-content:center;
  background:#141414;color:#eee;font:16px/1.5 system-ui,sans-serif;text-align:center}
 div{max-width:28rem;padding:2rem}h1{font-size:1.3rem;margin:0 0 .5rem}p{opacity:.75;margin:0}
</style></head><body><div><h1>${title}</h1><p>${body}</p></div></body></html>`;

async function postForm(url, form, fetchImpl = fetch) {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json, which is itself the error */ }
  if (!res.ok) {
    // Google's errors are the useful part of this whole flow when something
    // is set up wrong -- redirect_uri_mismatch above all -- so they are
    // passed through rather than flattened into "sign-in failed".
    const why = (json && (json.error_description || json.error)) || text.slice(0, 200);
    throw new Error(`Google said: ${why}`);
  }
  return json;
}

/**
 * Sign in. Resolves { refreshToken, accessToken, expiresAt, email }.
 *
 * `client` is { clientId, clientSecret } as the relay handed it over. The
 * "secret" of an installed app is not one -- every copy of every desktop app
 * carries it, which is why PKCE exists -- but Google's token endpoint still
 * wants it for this client type.
 */
export function signIn({ client, openBrowser = openInBrowser, timeoutMs = 5 * 60 * 1000, fetchImpl = fetch } = {}) {
  if (!client || !client.clientId) {
    return Promise.reject(new Error("This relay has no Google client set up yet."));
  }
  const verifier = b64url(crypto.randomBytes(64));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  // Tied to this attempt, and checked when the browser comes back, so another
  // page cannot hand us a code from somewhere else.
  const state = b64url(crypto.randomBytes(24));

  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Let the browser's own response finish before the socket goes.
      setTimeout(() => { try { server.close(); } catch { /* already */ } }, 250);
      fn(v);
    };

    const server = http.createServer(async (req, res) => {
      let url;
      try { url = new URL(req.url, "http://127.0.0.1"); } catch { url = null; }
      if (!url || url.pathname !== "/") { res.writeHead(404).end(); return; }
      const say = (code, title, body) => {
        res.writeHead(code, { "Content-Type": "text/html; charset=utf-8" });
        res.end(DONE_PAGE(title, body));
      };

      if (url.searchParams.get("state") !== state) {
        say(400, "That did not come from here", "Start signing in again from the launcher.");
        return;                       // and keep waiting for the real one
      }
      const err = url.searchParams.get("error");
      if (err) {
        say(200, "Not signed in", "You can close this tab.");
        finish(reject, new Error(err === "access_denied"
          ? "You did not give the launcher access."
          : `Google said: ${err}`));
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) { say(400, "Something is missing", "Start signing in again from the launcher."); return; }

      say(200, "Signed in", "You can close this tab and go back to the launcher.");
      try {
        const tok = await postForm(TOKEN_URL, {
          code,
          client_id: client.clientId,
          ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
          code_verifier: verifier,
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
        }, fetchImpl);
        // Without one there is nothing to sync with tomorrow, only today.
        if (!tok.refresh_token) {
          throw new Error("Google did not send a refresh token."
            + " Remove the launcher at myaccount.google.com/permissions and sign in again.");
        }
        finish(resolve, {
          refreshToken: tok.refresh_token,
          accessToken: tok.access_token,
          expiresAt: Date.now() + (Number(tok.expires_in) || 3600) * 1000,
          email: await emailOf(tok.access_token, fetchImpl).catch(() => null),
        });
      } catch (e) { finish(reject, e); }
    });

    let redirectUri = "";
    const timer = setTimeout(
      () => finish(reject, new Error("Signing in took too long.")), timeoutMs);

    server.on("error", (e) => finish(reject, e));
    // Port 0: the operating system picks a free one. A fixed port is one
    // more thing that can already be in use, and Google allows any port on
    // the loopback address for this client type.
    server.listen(0, "127.0.0.1", () => {
      redirectUri = `http://127.0.0.1:${server.address().port}`;
      const q = new URLSearchParams({
        client_id: client.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: SCOPES.join(" "),
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
        // Together these are what make Google hand over a refresh token:
        // without them a second sign-in returns only an access token and
        // syncing stops working an hour later.
        access_type: "offline",
        prompt: "consent",
      });
      Promise.resolve(openBrowser(`${AUTH_URL}?${q}`)).catch((e) => finish(reject, e));
    });
  });
}

/** A fresh access token from the refresh token. */
export async function refresh({ client, refreshToken, fetchImpl = fetch }) {
  const tok = await postForm(TOKEN_URL, {
    client_id: client.clientId,
    ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  }, fetchImpl);
  return {
    accessToken: tok.access_token,
    expiresAt: Date.now() + (Number(tok.expires_in) || 3600) * 1000,
  };
}

/** Which account this is, for the settings page to show. */
export async function emailOf(accessToken, fetchImpl = fetch) {
  const res = await fetchImpl(INFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Google said ${res.status} when asked who this is.`);
  const info = await res.json();
  return info.email || null;
}

/**
 * Tell Google to forget the launcher.
 *
 * Signing out has to do this and not only drop the token locally: a token
 * that still works somewhere is not signed out, it is merely out of sight.
 */
export async function revoke({ refreshToken, fetchImpl = fetch }) {
  if (!refreshToken) return;
  await fetchImpl(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refreshToken)}`,
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" } })
    .catch(() => { /* offline: the local copy still goes */ });
}

export default { SCOPES, signIn, refresh, emailOf, revoke };
