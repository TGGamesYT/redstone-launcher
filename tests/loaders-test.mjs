// Which loader builds exist for a Minecraft version.
//
// Minecraft changed how it numbers releases -- 1.21.11 was the last of the
// old scheme and 26.x is the new one -- and NeoForge numbers its builds after
// whatever Minecraft is on. Getting that mapping wrong does not fail loudly:
// the loader simply stops being offered, which is what happened after 1.21.11.
import { neoPrefix, resolveNeoForgeVersion, compareVersions } from "../backend/loader-versions.js";

const LIVE = process.env.OFFLINE !== "1";
let bad = 0;
const check = (label, got, want, note) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${note ? "  — " + note : ""}\n       got  ${JSON.stringify(got)}` + (ok ? "" : `\n       want ${JSON.stringify(want)}`));
};

// ── the mapping ──
check("the old numbering drops the leading 1.",
  ["1.20.2", "1.21.1", "1.21.11"].map(neoPrefix), ["20.2.", "21.1.", "21.11."]);
check("a version with no patch counts as .0", neoPrefix("1.21"), "21.0.");
check("the new numbering keeps all of itself",
  ["26.1.2", "26.2", "26.3"].map(neoPrefix), ["26.1.2.", "26.2.0.", "26.3.0."],
  "this returned null for every one of them, so NeoForge vanished after 1.21.11");
check("and nonsense is nonsense", ["", "snapshot", "1"].map(neoPrefix), [null, null, null]);

check("builds sort by number, not as text",
  ["26.3.0.9", "26.3.0.101", "26.3.0.84"].sort(compareVersions).pop(), "26.3.0.101");

if (LIVE) {
  // Against their real Maven, because the shape of those version strings is
  // theirs to change and this is the only thing that would notice.
  const got = await resolveNeoForgeVersion("26.3");
  check("a 26.x version really does resolve to a build", /^26\.3\.0\.\d+$/.test(got), true, got);
  const old = await resolveNeoForgeVersion("1.21.1");
  check("and an old one still does", /^21\.1\.\d+$/.test(old), true, old);
  check("no beta is handed back as the answer", [got, old].some(v => v.includes("-beta")), false);
  let why = null;
  try { await resolveNeoForgeVersion("1.7.10"); } catch (e) { why = e.message; }
  check("a version they never supported says so", /no builds for/.test(why || ""), true, why);
} else {
  console.log("ok   (the live checks were skipped: OFFLINE=1)");
}

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
