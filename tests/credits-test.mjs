// The credits: who is in them, in what order, and how credits.json is read.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import credits from "../backend/credits.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let bad = 0;
const check = (what, got, want, note) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${note ? "  — " + note : ""}`
    + (ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`));
};

// ── the founders ──
check("the founders are the two, by their Minecraft uuids, looked up once and written down",
  credits.FOUNDERS.map(f => [f.name, f.uuid]),
  [["TGdoesCode", "20bbb23e2f2246bab201c6bd435b445b"], ["Muavees", "52af5540dd184ad99acb50eb11531180"]]);

// ── credits.json, in every shape it may take ──
{
  const r = credits.readOtherCredits({
    "Skin model animators": { "Akimitsu": "069a79f4-44e9-4726-a5be-fca90e38aaf5", "other player": "not a uuid at all" },
    "Supporters": ["20bbb23e2f2246bab201c6bd435b445b", "Somebody Kind"],
    "Something else": "52af5540dd184ad99acb50eb11531180",
    "Empty": [],
  });
  check("a section of name to uuid keeps the name as the fallback",
    r[0].people[0], { uuid: "069a79f444e94726a5befca90e38aaf5", name: "Akimitsu" },
    "a uuid with dashes is the same uuid");
  check("and a value that is not a uuid is simply the credited name",
    r[0].people[1], { uuid: null, name: "not a uuid at all" });
  check("a list mixes uuids and plain names",
    r[1].people, [{ uuid: "20bbb23e2f2246bab201c6bd435b445b", name: null }, { uuid: null, name: "Somebody Kind" }]);
  check("a single value is a section of one",
    r[2].people, [{ uuid: "52af5540dd184ad99acb50eb11531180", name: null }]);
  check("and an empty section is not shown", r.map(s => s.title),
    ["Skin model animators", "Supporters", "Something else"]);
  check("nothing usable is no sections rather than a crash",
    [credits.readOtherCredits(null), credits.readOtherCredits([1, 2]), credits.readOtherCredits("x")], [[], [], []]);
}
{
  const file = JSON.parse(fs.readFileSync(path.join(ROOT, "credits.json"), "utf8"));
  check("the repository's credits.json is readable as credits",
    credits.readOtherCredits(file).length > 0, true);
}

// ── contributors, most added first ──
const statsBody = [
  { author: { login: "small", type: "User", avatar_url: "a", html_url: "u" }, total: 50, weeks: [{ a: 10 }, { a: 5 }] },
  { author: { login: "big", type: "User", avatar_url: "a", html_url: "u" }, total: 2, weeks: [{ a: 9000 }, { a: 177 }] },
  { author: { login: "github-actions[bot]", type: "Bot" }, total: 8, weeks: [{ a: 104 }] },
];
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
{
  let asked = 0;
  const list = await credits.repoContributors("o/r", {
    wait: async () => { },
    fetchImpl: async () => (++asked < 3 ? res(202, {}) : res(200, statsBody)),
  });
  check("GitHub working its numbers out is waited for", asked, 3,
    "it answers 202 the first time it is asked for a repository's statistics");
  check("and contributors come out most added first, not most commits first",
    list.map(c => [c.login, c.added]), [["big", 9177], ["small", 15]]);
  check("bots are not people", list.some(c => /\[bot\]/.test(c.login)), false);
}
{
  const list = await credits.repoContributors("o/r", {
    wait: async () => { },
    tries: 2,
    fetchImpl: async (u) => /stats/.test(u) ? res(202, {})
      : res(200, [{ login: "a", contributions: 3, type: "User" }, { login: "b", contributions: 9, type: "User" }]),
  });
  check("statistics never ready: the plain list, by commits, rather than nothing",
    list.map(c => [c.login, c.added, c.commits]), [["b", null, 9], ["a", null, 3]]);
}
{
  let auth = null;
  await credits.repoContributors("o/r", { token: "t0k", wait: async () => { },
    fetchImpl: async (u, o) => { auth = o.headers.Authorization; return res(200, []); } });
  check("a saved GitHub token is used, for the higher rate limit", auth, "Bearer t0k");
  const none = await credits.repoContributors("o/r", { wait: async () => { }, fetchImpl: async () => res(403, {}) });
  check("rate-limited is null, so the dialog can say so instead of listing nobody", none, null);
}

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
