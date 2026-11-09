// Whether a build is allowed to replace a release that is already out.
//
// It was, on every commit. The workflow decided with
//
//     while gh release view "$TAG" >/dev/null 2>&1; do …
//
// on a step that had no token on it. `gh` exits non-zero for "there is no
// such release" and equally for "I could not ask", and that loop could not
// tell the two apart -- so it read "no token" as "nothing is there", came
// out with the bare version every time, and action-gh-release uploaded onto
// the existing release, which REPLACES its files. Three platforms rebuilt
// and the released binaries overwritten, per commit, under a version number
// that had not moved.
//
// So what is checked here is mostly the unhappy paths: every way of failing
// to ask has to STOP the build, not wave it through.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { isReleased, versionInPackageJson } from "../scripts/released.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let bad = 0;
const ok = (what, note) => console.log(`ok   ${what}${note ? "  — " + note : ""}`);
const fail = (what, why) => { bad++; console.log(`FAIL ${what}\n       ${why}`); };
const check = (what, got, want, note) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) ok(what, note); else fail(what, `got  ${a}\n       want ${b}`);
};
const answers = (status, body = "") => async () => ({
  status, text: async () => body,
});
const asking = async (opts) => {
  try { return { answer: await isReleased(opts) }; }
  catch (err) { return { stopped: String(err.message || err) }; }
};

const base = { repo: "TGGamesYT/redstone-launcher", version: "1.18.0", token: "t" };

// ── the two real answers ──
check("a release that is there means yes",
  await asking({ ...base, fetchImpl: answers(200, '{"html_url":"…"}') }), { answer: true });
check("and one that is not means no",
  await asking({ ...base, fetchImpl: answers(404, '{"message":"Not Found"}') }), { answer: false });

// ── and every way of not getting one ──
//
// Each of these is a non-zero exit from `gh`, which the old loop read as
// "there is no release, go ahead and publish over it".
for (const [status, what] of [
  [401, "a token that is not accepted"],
  [403, "being rate limited or refused"],
  [500, "GitHub having a bad morning"],
  [502, "a gateway between here and there"],
]) {
  const r = await asking({ ...base, fetchImpl: answers(status, "nope") });
  check(`${what} (${status}) stops the build`,
    [r.answer, /Stopping rather than guessing/.test(r.stopped || "")], [undefined, true],
    r.stopped && r.stopped.split("\n")[0]);
}

const offline = await asking({
  ...base, fetchImpl: async () => { throw new Error("getaddrinfo ENOTFOUND api.github.com"); },
});
check("not reaching GitHub at all stops the build",
  [offline.answer, /Could not reach GitHub/.test(offline.stopped || "")], [undefined, true]);

// No token is the exact condition the old step was in, every single run.
const noToken = await asking({ ...base, token: "", fetchImpl: answers(404) });
check("and having no token to ask with stops it before it even asks",
  [noToken.answer, /No token/.test(noToken.stopped || "")], [undefined, true],
  "this was the state it was in on every run, and it published anyway");

const noRepo = await asking({ ...base, repo: "", fetchImpl: answers(404) });
check("not knowing which repository stops it too", noRepo.answer, undefined);

// ── it asks about the right thing ──
let asked = null;
await isReleased({
  ...base, version: "2.0.0-beta 1",
  fetchImpl: async (url, init) => { asked = { url, init }; return { status: 404, text: async () => "" }; },
});
check("it asks about the version it was given, escaped",
  asked.url, "https://api.github.com/repos/TGGamesYT/redstone-launcher/releases/tags/2.0.0-beta%201");
check("and it asks with the token",
  asked.init.headers.Authorization, "Bearer t");

check("the version it asks about by default is package.json's",
  versionInPackageJson(ROOT), JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version);

// ── and what the workflows do with the answer ──
// What the workflow RUNS, with the commentary taken out -- the comments
// quote the old broken step on purpose, so matching against them would find
// it for ever.
const wf = (name) => fs.readFileSync(path.join(ROOT, ".github/workflows", name), "utf8")
  .split("\n").filter(l => !/^\s*#/.test(l)).join("\n");
const build = wf("build.yml"), snap = wf("snap-release.yml");

check("the gate runs before anything is built, not after",
  ["build-win", "build-linux", "build-mac", "create-release"]
    .every(job => new RegExp(`${job}:[\\s\\S]*?needs: (check|\\[check)`).test(build)),
  true,
  "answering `no` has to cost ten seconds, not three platforms' worth of build");
check("and every build job is skipped when the answer is no",
  (build.match(/if: needs\.check\.outputs\.build == 'true'/g) || []).length, 4);

check("the loop that could not tell a 404 from a 401 is gone",
  /gh release view/.test(build), false);
check("and so is releasing the same version again under another name",
  /\$\{BASE\}\(\$i\)|\(\$i\)/.test(build), false,
  "1.18.0(1), 1.18.0(2) … was one release per commit, which is not better");

check("creating the release and uploading to it is one step, not two",
  (build.match(/softprops\/action-gh-release/g) || []).length, 1,
  "two steps is two chances to land on something already there");

check("a release published by hand still builds its artifacts",
  /github\.event_name.*==.*release|github\.event_name.*=.*"release"/.test(build), true);

check("the snap is gated the same way",
  /scripts\/released\.mjs/.test(snap), true,
  "it pushed a new revision to the stable channel on every commit as well");

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
