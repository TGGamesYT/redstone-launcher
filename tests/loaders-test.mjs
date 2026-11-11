// Which loader builds exist for a Minecraft version.
//
// Minecraft changed how it numbers releases -- 1.21.11 was the last of the
// old scheme and 26.x is the new one -- and NeoForge numbers its builds after
// whatever Minecraft is on. Getting that mapping wrong does not fail loudly:
// the loader simply stops being offered, which is what happened after 1.21.11.
import { neoPrefix, resolveNeoForgeVersion, compareVersions, loaderJvmArgs } from "../backend/loader-versions.js";
import AdmZip from "adm-zip";
import fs from "fs";
import os from "os";
import path from "path";

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

// ── the JVM arguments the loader itself asks for ──
//
// They are in the installer's own version.json and they are not optional:
// NeoForge 26.3 asks for -DlibraryDirectory, and without it FML cannot find
// its libraries and stops before the window opens -- with its own error
// window crashing on the way out, so nothing says why.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loaderjvm-"));
  const jar = path.join(tmp, "installer.jar");
  const zip = new AdmZip();
  zip.addFile("version.json", Buffer.from(JSON.stringify({
    id: "neoforge-26.3.0.102",
    arguments: {
      jvm: [
        "-Djava.net.preferIPv6Addresses=system",
        "-DlibraryDirectory=${library_directory}",
        "--add-opens", "java.base/java.lang.invoke=ALL-UNNAMED",
        "-Dsomething=${nobody_knows}",
        { rules: [{ action: "allow", os: { name: "osx" } }], value: "-XstartOnFirstThread" },
      ],
    },
  })));
  zip.writeZip(jar);
  check("the loader's own JVM arguments are read out of its installer",
    loaderJvmArgs(jar, { rootPath: "/games/inst" }),
    [
      "-Djava.net.preferIPv6Addresses=system",
      "-DlibraryDirectory=" + path.join("/games/inst", "libraries"),
      "--add-opens", "java.base/java.lang.invoke=ALL-UNNAMED",
    ],
    "an argument with a placeholder nothing here can answer is left out rather than passed on with a ${...} in it");
  check("and a jar that has no version.json is simply nothing",
    loaderJvmArgs(path.join(tmp, "nope.jar"), { rootPath: "/games/inst" }), []);
}

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
