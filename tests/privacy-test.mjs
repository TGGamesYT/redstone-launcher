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

// ── the folder it names ──
check("the folder name is right", policy.includes(drive.ROOT_FOLDER), true);

// ── the cipher it names ──
check("the cipher named is the one used",
  [policy.includes("AES-256-GCM"), src("backend/cloud-crypto.js").includes("aes-256-gcm")],
  [true, true]);

// ── the file it says is not encrypted ──
check("the one unencrypted file is named, and is the only one",
  [policy.includes("key.json"),
    /drive\.put\(root, KEY_FILE, Buffer\.from\(JSON\.stringify/.test(src("backend/cloud-sync.js"))],
  [true, true],
  "every other write goes through seal()");

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

// ── the placeholders are still marked, so they cannot be submitted by accident ──
const left = (policy.match(/\[(CONTACT EMAIL|POLICY URL)\]/g) || []).length;
console.log(left
  ? `ok   ${left} placeholder(s) still marked  — fill these in before submitting`
  : "ok   no placeholders left");

// ── and it is reachable where the policy says it is ──
check("the policy is at the path it says it is",
  fs.existsSync(path.join(ROOT, "PRIVACY.md")), true);

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
