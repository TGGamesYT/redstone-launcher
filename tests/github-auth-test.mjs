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

// Who gh is signed in as, from what `gh auth status` prints.
check("gh 2.40+: the active account is the one named",
  gha.loginFromGhStatus(`github.com
  ✓ Logged in to github.com account someone-else (keyring)
  - Active account: false
  ✓ Logged in to github.com account TGdoesCode (keyring)
  - Active account: true
  - Git operations protocol: https`), "TGdoesCode");
check("older gh: 'as NAME'",
  gha.loginFromGhStatus("github.com\n  ✓ Logged in to github.com as octocat (oauth_token)\n"), "octocat");
check("signed out is nobody", gha.loginFromGhStatus("You are not logged into any GitHub hosts. To log in, run: gh auth login"), null);

// There is no OAuth app of the launcher's own any more: gh is the way.
{
  const src = fs.readFileSync(path.join(ROOT, "backend", "github-auth.js"), "utf8");
  check("no device flow of the launcher's own is left behind", /login\/oauth\/access_token|GITHUB_CLIENT_ID/.test(src), false);
}

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
