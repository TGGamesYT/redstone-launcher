// The MSIX package for the Microsoft Store, and the launcher behaving when
// it is installed from one.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import xml2js from "xml2js";
import { manifest, storeVersion } from "../scripts/build-msix.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let bad = 0;
const check = (what, got, want, note) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${note ? "  — " + note : ""}`
    + (ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`));
};

check("the Store's version is four numbers ending in 0",
  [storeVersion("1.18.0"), storeVersion("1.18"), storeVersion("2.0.1-beta.3")],
  ["1.18.0.0", "1.18.0.0", "2.0.1.0"],
  "the fourth is the Store's own, and a package that sets it is refused");

const text = manifest({
  identity: "12345Me.RedstoneLauncher", publisher: "CN=ABCD-1234",
  publisherDisplayName: "TG & co <x>", version: "1.18.0.0", exe: "Redstone Launcher.exe",
});
let doc = null, err = null;
try { doc = await xml2js.parseStringPromise(text); } catch (e) { err = e.message.split("\n")[0]; }
check("the manifest is well-formed XML", err, null,
  "a `--` inside one of its comments made it malformed once already");
if (doc) {
  const P = doc.Package;
  check("with the identity Partner Center gave out",
    P.Identity[0].$, { Name: "12345Me.RedstoneLauncher", Publisher: "CN=ABCD-1234", Version: "1.18.0.0", ProcessorArchitecture: "x64" });
  check("and text from outside escaped", P.Properties[0].PublisherDisplayName[0], "TG & co <x>");
  const main = fs.readFileSync(path.join(ROOT, "backend", "main.js"), "utf8");
  const scheme = /const DEEPLINK_SCHEME = '([^']+)'/.exec(main)[1];
  check("the shortcut protocol is declared, since a packaged app cannot register one itself",
    P.Applications[0].Application[0].Extensions[0]["uap:Extension"][0]["uap:Protocol"][0].$.Name, scheme);
  check("file writes are not redirected into a private copy",
    [P.Properties[0]["desktop6:FileSystemWriteVirtualization"][0],
      P.Capabilities[0]["rescap:Capability"].map(c => c.$.Name).includes("unvirtualizedResources")],
    ["disabled", true],
    "Explorer, Java and shortcut icons must see the files where the launcher put them");
}

{
  const main = fs.readFileSync(path.join(ROOT, "backend", "main.js"), "utf8");
  check("a Store copy never updates itself",
    ["checkForUpdate", "maybeApplyStagedUpdate", "stageUpdateInBackground"].every(fn => {
      const at = main.indexOf(`async function ${fn}(`);
      return at >= 0 && /FROM_THE_STORE/.test(main.slice(at, at + 300));
    }), true,
    "running the NSIS installer from a Store install would put a second copy beside it");
}

{
  const wf = fs.readFileSync(path.join(ROOT, ".github", "workflows", "build.yml"), "utf8");
  check("the Windows build packs the MSIX", /node scripts\/build-msix\.mjs/.test(wf), true);
  check("and submits it only once everything it needs is set",
    /if: env\.MS_STORE_PRODUCT_ID != '' && env\.MS_STORE_CLIENT_SECRET != ''[^\n]*\n\s+shell: pwsh\n\s+run: \|\n\s+msstore reconfigure/.test(wf), true);
}

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
