// What an auth failure is allowed to look like in the log.
//
// This was reported as an error in the launcher's log that nobody could make
// anything of, under an account that was signed in and working:
//
//   Failed to refresh player: {"response":{"size":0,"timeout":0},"ts":"error.auth.minecraft.login"}
//   [Relay] token refresh failed, trying existing token: undefined
//
// Both lines are the same mistake. msmc does not throw Errors; it throws a
// plain object whose `ts` names the step that failed, and which has no
// message on it at all. So `err.message` is undefined -- printed literally
// by one of them -- and `String(err)` is "[object Object]", so the other
// printed the raw object instead. Neither said which account it was about
// or what had actually gone wrong, and in this case nothing had: an empty
// response from Minecraft's login is a hiccup, retried a moment later.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let bad = 0;
const ok = (what, note) => console.log(`ok   ${what}${note ? "  — " + note : ""}`);
const fail = (what, why) => { bad++; console.log(`FAIL ${what}\n       ${why}`); };
const check = (what, got, want, note) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) ok(what, note); else fail(what, `got  ${a}\n       want ${b}`);
};

// The real functions out of the main process.
const src = fs.readFileSync(path.join(ROOT, "backend/main.js"), "utf8");
const from = src.indexOf("/**\n * What an auth failure actually says.");
const to = src.indexOf("// Write a changed account back to disk", from);
if (from < 0 || to < 0) { console.log("FAIL could not find describeAuthError in main.js"); process.exit(1); }
const { describeAuthError, authErrorText } =
  new Function(src.slice(from, to) + "return { describeAuthError, authErrorText };")();

// The error from the report, exactly.
const REPORTED = { response: { size: 0, timeout: 0 }, ts: "error.auth.minecraft.login" };

check("the error that was reported says what it is now",
  describeAuthError(REPORTED),
  "Minecraft's own login did not answer — it sent nothing back, so this is a hiccup rather than a problem with the account");
check("and it is not the two things it used to print",
  [describeAuthError(REPORTED) === "undefined",
    describeAuthError(REPORTED) === JSON.stringify(REPORTED)],
  [false, false],
  "one printed the word undefined, the other the raw object");

// Every step msmc can fail at is named, rather than coming out as its code.
for (const [ts, want] of [
  ["error.auth.microsoft.token", "Microsoft"],
  ["error.auth.xbox.token", "Xbox Live"],
  ["error.auth.xsts.token", "Xbox Live"],
  ["error.auth.minecraft.profile", "Minecraft"],
  ["error.gui.closed", "closed"],
]) {
  const said = describeAuthError({ ts });
  check(`${ts} is said in words`, [said.includes(want), said.includes(ts)], [true, false], said);
}
check("and one nobody has a name for still says what it was",
  describeAuthError({ ts: "error.something.new" }), "error.something.new",
  "better the code than nothing at all");

// An HTTP status is worth having when there is one.
check("a status is included where the answer had one",
  describeAuthError({ ts: "error.auth.xsts.token", response: { status: 401 } }),
  "Xbox Live would not authorise this account — it answered 401");

// A real Error still reads as itself.
check("an ordinary Error is left to speak for itself",
  describeAuthError(new Error("invalid_grant: the grant is expired")),
  "invalid_grant: the grant is expired");
check("and nothing at all does not throw", describeAuthError(null), "no reason given");

// ── and what the handling still has to be able to see ──
//
// The text these are matched against has to hold everything the error has,
// or an msmc object -- which carries its reason in `ts` and nowhere else --
// would match nothing and a dead grant would be retried for ever.
const dead = (e) => /invalid_grant|must sign in again|grant is expired|reading 'refresh_token'/i
  .test(authErrorText(e));
const limited = (e) => e?.response?.status === 429 || /\b429\b/.test(authErrorText(e));

check("a dead grant is still recognised as dead",
  [dead(new Error("invalid_grant")), dead({ message: "the grant is expired" })], [true, true]);
check("and a hiccup is still not",
  dead(REPORTED), false,
  "an empty answer from Minecraft is retried, not a reason to make somebody sign in again");
check("a rate limit is still recognised, however it arrives",
  [limited({ response: { status: 429 } }),
    limited({ ts: "error.auth.microsoft.token", message: "429 Too Many Requests" })],
  [true, true]);
check("and an ordinary failure is not mistaken for one",
  limited(REPORTED), false);

// The two places that report one both go through this.
const says = (what) => new RegExp(what).test(src);
check("both places that report an auth failure describe it",
  (src.match(/describeAuthError\(err\)/g) || []).length >= 2, true);
check("neither prints a bare err.message any more",
  says("token refresh failed, trying existing token"), false,
  "that is the line that printed the word undefined");
check("and the account it is about is named",
  /Could not refresh the sign-in for \$\{/.test(src), true,
  "the account that fails is very often not the one being played, which is why it read as something being broken");

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
