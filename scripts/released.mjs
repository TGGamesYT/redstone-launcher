// Has this version been released already?
//
//   node scripts/released.mjs            asks about package.json's version
//   node scripts/released.mjs 1.18.0     asks about that one
//
// Prints `yes` or `no`, and writes `released=yes|no` and `version=…` to
// $GITHUB_OUTPUT when there is one. Exits non-zero, loudly, on anything
// that is not a clear answer.
//
// That last part is the whole point of this file existing.
//
// The release workflow used to decide with
//
//     while gh release view "$TAG" >/dev/null 2>&1; do …
//
// on a step with no token on it. `gh` exits non-zero for "there is no such
// release" and ALSO for "I could not ask" -- no token, rate limited, GitHub
// having a bad morning -- and the loop could not tell those apart. It never
// had a token, so it always took the second for the first, always came out
// with the bare version, and action-gh-release then uploaded onto the
// release already sitting there, which REPLACES its files. Every commit to
// main rebuilt three platforms and overwrote the released binaries with
// them, under a version number that had not changed.
//
// So the rule here is: a 404 is a no, a 200 is a yes, and anything else is
// not an answer and stops the build. Being unable to ask must never be
// mistaken for "nothing is there" -- the cost of that mistake is somebody
// else's download being replaced.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const versionInPackageJson = (root = ROOT) =>
  JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;

/**
 * Whether `version` already has a release on `repo`.
 *
 * Resolves true or false. Throws for everything else, including every way of
 * failing to ask.
 */
export async function isReleased({ repo, version, token, fetchImpl = fetch }) {
  if (!repo) throw new Error("No repository given (GITHUB_REPOSITORY is unset).");
  if (!version) throw new Error("No version given, and package.json has none.");

  const url = `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(version)}`;
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "redstone-launcher-release-check",
  };
  // Without one every answer is a guess: an unauthenticated request is rate
  // limited to the point where a 403 is ordinary, and a 403 read as "not
  // released" is exactly the overwrite this is here to stop.
  if (!token) throw new Error("No token to ask with (GH_TOKEN is unset).");
  headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetchImpl(url, { headers });
  } catch (err) {
    throw new Error(`Could not reach GitHub to ask about ${version}: ${err && err.message || err}`);
  }
  if (res.status === 200) return true;
  if (res.status === 404) return false;

  let said = "";
  try { said = (await res.text()).slice(0, 400); } catch { /* nothing to add */ }
  throw new Error(
    `GitHub answered ${res.status} when asked whether ${version} is released.`
    + ` Stopping rather than guessing — guessing wrong overwrites a release.`
    + (said ? `\n${said}` : ""));
}

// ── run from a workflow ───────────────────────────────────────────────────
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = process.argv[2] || versionInPackageJson();
  try {
    const yes = await isReleased({
      repo: process.env.GITHUB_REPOSITORY,
      version,
      token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
    });
    const out = yes ? "yes" : "no";
    console.log(out);
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `released=${out}\nversion=${version}\n`);
    }
    console.error(yes
      ? `::notice::${version} is already released. Nothing is built and nothing is touched.`
        + ` Change the version in package.json to release again.`
      : `::notice::${version} has not been released yet — building it.`);
  } catch (err) {
    console.error(`::error::${String(err && err.message || err)}`);
    process.exit(1);
  }
}
