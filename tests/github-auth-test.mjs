// Signing in to GitHub the way `gh auth login` does: a code shown here, typed
// in at github.com/login/device.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import gha from "../backend/github-auth.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let bad = 0;
const check = (what, got, want, note) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${note ? "  — " + note : ""}`
    + (ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`));
};

// What gh prints, from its own source: "! First copy your one-time code: X".
check("gh's one-time code is read out of what it prints",
  gha.codeFromGhOutput("! First copy your one-time code: WDJB-MJHT\nOpen this URL to continue in your web browser: https://github.com/login/device"),
  "WDJB-MJHT");
check("and nothing is made up when there is none", gha.codeFromGhOutput("error connecting to github.com"), null);

// gh's own app id must never be borrowed.
{
  const src = fs.readFileSync(path.join(ROOT, "backend", "github-auth.js"), "utf8");
  check("GitHub CLI's client id is not used as the launcher's",
    /178c6fc778ccc68e1d6a/.test(src), false,
    "GitHub would show 'GitHub CLI wants access' for something that is not GitHub CLI");
}

// The device flow, against a stand-in GitHub -- only if the launcher has an
// app registered, since without one it is not offered at all.
if (gha.GITHUB_CLIENT_ID) {
  let polls = 0, shown = null;
  const r = await gha.signInDeviceFlow({
    sleep: async () => { },
    onCode: (c) => { shown = c; },
    fetchImpl: async (url) => ({
      json: async () => /device\/code/.test(url)
        ? { device_code: "dc", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", interval: 5, expires_in: 900 }
        : (++polls < 3 ? { error: "authorization_pending" } : { access_token: "gho_x" }),
    }),
  });
  check("the code is shown before anything is waited for", shown, { code: "ABCD-1234", url: "https://github.com/login/device" });
  check("and the token arrives once it is approved", [r.ok, r.token, polls], [true, "gho_x", 3]);
} else {
  const r = await gha.signInDeviceFlow({});
  check("without the launcher's own app, the device flow is not attempted", r.ok, false);
  check("and is not offered", gha.methods().native, false);
}

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
