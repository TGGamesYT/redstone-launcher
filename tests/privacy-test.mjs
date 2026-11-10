// The privacy policy, checked against the code it describes.
//
// This one is submitted to Google, and a privacy policy that overstates what
// an app does is worse than no policy -- it is a claim somebody relies on.
// Writing it next to the code is not enough on its own: the code moves.
//
// So every factual claim that CAN be checked mechanically is checked here,
// and the ones that cannot are the ones worth re-reading by hand.
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import google from "../backend/cloud-google.js";
import drive from "../backend/cloud-drive.js";
import lock from "../backend/cloud-lock.js";
import items from "../backend/cloud-items.js";
import cc from "../backend/cloud-crypto.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const policy = fs.readFileSync(path.join(ROOT, "PRIVACY.md"), "utf8");
const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

let bad = 0;
const check = (what, got, want, note) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${note ? "  — " + note : ""}`
    + (ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`));
};

// ── the scopes it names are the scopes it asks for ──
check("every scope the policy names is one the launcher asks for",
  google.SCOPES.every(s => policy.includes(s)), true);
check("and it names no scope the launcher does not ask for",
  (policy.match(/https:\/\/www\.googleapis\.com\/auth\/[\w.]+/g) || [])
    .filter(s => !google.SCOPES.includes(s)), [],
  "a policy that claims a narrower scope than the app requests is the bad direction");
check("there are only two of them", google.SCOPES.length, 2);

// ── what a switch sweeps up, and what it does not ──
//
// The policy now says two different things about two different sets: the
// switched kinds are kept in step on every sync, and instances and worlds go
// one at a time when asked for. If a switch for either ever comes back, that
// sentence stops being true, and it is the kind of claim somebody relies on.
{
  const cloud = src("backend/cloud.js");
  const sweep = [...cloud.matchAll(/^    (\w+): \{\n      name: "/gm)].map(m => m[1]);
  check("the kinds a sync sweeps up are the four the policy lists as switches",
    sweep.sort(), ["accounts", "servers", "settings", "themes"],
    "an instance or a world in here would be sent by ticking a box, which the policy says cannot happen");
  const page = src("frontend/settings.html");
  check("and the settings page offers a switch for exactly those",
    [...page.matchAll(/class="cloud-kind" data-kind="(\w+)"/g)].map(m => m[1]).sort(),
    ["accounts", "servers", "settings", "themes"],
    "a switch for instances or worlds is a promise the policy does not make");
  check("the policy says instances and worlds are asked for one at a time",
    /one at a time, when you ask for that one/i.test(policy), true);
}

// ── carrying a file nothing can fetch is the person's choice ──
//
// The policy says other people's mod files are not put in your Drive, with
// one exception the person ticks themselves. That exception has to BE a
// choice in the code, not a default.
{
  const cloud = src("backend/cloud.js");
  check("nothing is carried unless the call asked for it",
    /pushInstance\(id, \{ worlds = \[\], loose = false \} = \{\}\)/.test(cloud), true,
    "a default of true would make the policy's exception the ordinary case");
  const pack = src("backend/cloud-pack.js");
  check("and the packer carries nothing by default either",
    /carry = \(\) => false/.test(pack), true);
  check("the policy admits the exception rather than only the reassuring half",
    /with one exception you choose yourself/i.test(policy), true,
    "a policy that lists only what is comfortable is the kind nobody can rely on");
}

// ── the folder it names ──
check("the folder name is right", policy.includes(drive.ROOT_FOLDER), true);

// ── the cipher it names ──
check("the cipher named is the one used",
  [policy.includes("AES-256-GCM"), src("backend/cloud-crypto.js").includes("aes-256-gcm")],
  [true, true]);

// ── what it says is encrypted is what is encrypted ──
//
// The policy used to say everything but one file was. It now says the
// opposite -- one file is, and the rest is readable on purpose -- and
// getting that backwards in either direction is the kind of mistake that
// matters most in a document somebody relies on.
const sync = await import("../backend/cloud-sync.js");
check("exactly one kind is encrypted, and it is the accounts",
  sync.SECRET_KINDS, ["accounts"]);
check("the policy names that file and no other as encrypted",
  [policy.includes("accounts.rlc"), /except one file is encrypted/.test(policy)],
  [true, false],
  "it used to claim the whole folder was");
check("and it says the rest is readable, which is the thing people rely on",
  /real `?\.zip`? files|download a world/.test(policy), true);
check("key.json is still named as the half-key it is",
  policy.includes("key.json"), true);
check("and the policy admits what being readable costs",
  /discloses \*what you have\*|discloses what you have/.test(policy), true,
  "a policy that lists only the reassuring half is not a policy");

// ── the Google token really is excluded ──
check("the claim that Google tokens are never synced holds",
  "cloudGoogle" in items.settingsFor({ store: { cloudGoogle: { refreshToken: "x" }, baseColor: "#111" } }),
  false);
check("and the policy says so", /never uploaded, never synced/.test(policy), true);

// ── the staleness it quotes ──
// The policy is hard-wrapped, so the claim can be split across a newline.
const quoted = /renewed\s+for\s+(\w+)\s+minutes\s+is\s+ignored/.exec(policy);
check("the number of minutes the policy quotes is the real one",
  quoted && quoted[1], "ten",
  `cloud-lock.js says ${lock.STALE_MS / 60000}`);
check("and that is what the code says", lock.STALE_MS / 60000, 10);

// ── what "empty the folder" promises ──
const unsync = src("backend/cloud-sync.js");
const body = unsync.slice(unsync.indexOf("async function unsyncAll"));
check("emptying the folder really removes the folder, as promised",
  /drive\.remove\(root\)/.test(body), true,
  "it used to delete the files and leave the folder, which made this sentence false");

// ── it does not claim things that are not built ──
for (const absent of ["analytics", "advertis", "telemetry", "we store", "our servers store"]) {
  check(`it does not use the words "${absent}" loosely`,
    new RegExp(`(?<!not )(?<!no )${absent}`, "i").test(policy.replace(/^#.*$/gm, "")) === false
      || /do not|does not|never|no /i.test(policy), true);
}

// ── it is ready to be submitted ──
//
// Google's consent screen wants a contact address and a publicly reachable
// URL. These were placeholders while the feature was being written; a
// placeholder that reaches the submission is a support address nobody reads
// and a policy link that 404s.
check("no placeholder is left in it",
  (policy.match(/\[(CONTACT EMAIL|POLICY URL)\]/g) || []), []);
check("there is a contact address, and it is one address throughout",
  [...new Set(policy.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || [])],
  ["contact@redstone-launcher.com"],
  "two different addresses in one policy is the one somebody writes to being the wrong one");

// The URL it claims to be published at has to be where this file actually
// is -- on the default branch, since that is what the link resolves to.
const url = (/published at <([^>]+)>/.exec(policy) || [])[1];
// The address given to Google is the site's own page, which renders this
// file -- not a link into a code host. A GitHub blob is a perfectly working
// link and a poor front door for a legal document.
check("it says where it is published, and that is the website",
  url, "https://redstone-launcher.com/privacy");
check("and it still says where the source is, so the two are not confused",
  /blob\/main\/PRIVACY\.md/.test(policy) && fs.existsSync(path.join(ROOT, "PRIVACY.md")), true);
// Against the remote this is actually pushed to, rather than against a
// string written twice -- a link to somebody else's repository would still
// have resolved.
const remote = execSync("git remote get-url origin", { cwd: ROOT }).toString().trim();
const slug = (/github\.com[/:]([^/]+\/[^/.]+)/.exec(remote) || [])[1];
check("the source link names the repository this is pushed to",
  [slug, policy.includes(slug)], [slug, true], remote);

// Dates: the "last updated" has to be a real date, not a leftover.
check("the date on it parses",
  !Number.isNaN(Date.parse((/Last updated: ([^*]+)\*\*/.exec(policy) || [])[1])), true);

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
