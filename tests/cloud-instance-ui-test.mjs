// Saving one instance to the cloud, and taking one back.
//
// There used to be a switch called "Instances" in the settings page. It did
// nothing -- nothing read it -- but what it SAID was that ticking a box put
// every instance somebody owned into their Drive. These three dialogs are
// what replaced it, and the whole point of them is that nothing goes without
// being chosen, so what is checked here is the choosing:
//
//   the dialog says what each choice costs before anything is sent;
//   nothing is ticked for you, so the quiet path sends the least;
//   an instance can be written into a DIFFERENT instance, which is what
//   "my other computer" actually means, since the ids never line up;
//   and a world that already exists is not written over without asking.
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(ROOT, "frontend", "instances.html"), "utf8");

let bad = 0;
const check = (label, got, want, note) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${note ? "  — " + note : ""}`
    + (ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`));
};

const code = src.slice(
  src.indexOf("        // ── this instance, to and from the cloud ──"),
  src.indexOf("        async function openExportModal(profile) {"));
if (!code.includes("openCloudSaveModal")
  || !code.includes("openCloudGetModal")
  || !code.includes("openCloudWorldModal")) {
  console.log("FAIL could not slice the cloud dialogs out of instances.html");
  process.exit(1);
}

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setContent("<!doctype html><html><body></body></html>");

/** Load the dialogs with a stubbed launcher behind them. */
async function load(answers) {
  await page.evaluate(({ code, answers }) => {
    window.__calls = [];
    window.__alerts = [];
    window.__asked = [];
    window.__answers = answers;
    window.alert = (m) => window.__alerts.push(String(m));
    window.notify = () => { };
    window.uiConfirm = async (message) => {
      window.__asked.push(String(message));
      return window.__answers.confirm !== false;
    };
    window.ipcRenderer = {
      invoke: async (channel, args) => {
        window.__calls.push([channel, args]);
        const a = window.__answers[channel];
        return typeof a === "function" ? a(args) : a;
      },
    };
    // The page's own names, as the slice expects to find them.
    window.eval(`var ipcRenderer = window.ipcRenderer; var uiConfirm = window.uiConfirm;\n`
      + code.replace(/^ {8}/gm, ""));
  }, { code, answers });
}

const PROFILE = { id: 31, name: "My Instance" };
const clear = () => page.evaluate(() => { document.body.innerHTML = ""; });

// ── saving: what it says before it sends ──
{
  await clear();
  await load({
    "cloud:instanceParts": {
      ok: true,
      parts: {
        name: "1.21 Fabric",
        describe: { files: 42, carried: 3, carriedBytes: 300 * 1024, skipped: [] },
        worlds: ["My Base", "Spare"],
        loose: [{ path: "mods/private.jar", size: 4 * 1024 * 1024 }],
        looseBytes: 4 * 1024 * 1024,
      },
    },
    "cloud:pushInstance": { ok: true, describe: { skipped: [] }, worlds: { sent: [], failed: [] } },
  });
  await page.evaluate((p) => window.openCloudSaveModal(p), PROFILE);
  await page.waitForFunction(() => !/Looking at/.test(document.querySelector("#csBody").textContent));

  const said = await page.evaluate(() => document.querySelector("#csBody").textContent.replace(/\s+/g, " "));
  check("the dialog says what the instance is before anything is sent",
    [/42 file\(s\) recorded by hash/.test(said), /3 carried \(300 KB\)/.test(said)], [true, true],
    "a dialog that only says “upload?” is one nobody can answer");
  check("and names the files nothing can fetch, with what they cost",
    [/1 file\(s\) that are on neither Modrinth nor CurseForge \(4\.0 MB\)/.test(said),
      /mods\/private\.jar/.test(said)], [true, true]);

  check("nothing is ticked for you",
    await page.evaluate(() => [
      document.querySelector("#csLoose").checked,
      [...document.querySelectorAll(".cs-world")].map(c => c.checked),
    ]),
    [false, [false, false]],
    "a world is every byte of it, and a default of on is somebody's Drive filled without asking");

  await page.click("#csGo");
  await page.waitForFunction(() => window.__calls.some(c => c[0] === "cloud:pushInstance"));
  check("so saving without touching anything sends the instance and nothing else",
    await page.evaluate(() => window.__calls.find(c => c[0] === "cloud:pushInstance")[1]),
    { id: 31, worlds: [], loose: false });
}

// ── saving: what it sends when asked ──
{
  await clear();
  await load({
    "cloud:instanceParts": {
      ok: true,
      parts: {
        name: "1.21 Fabric",
        describe: { files: 2, carried: 0, carriedBytes: 0, skipped: [] },
        worlds: ["My Base", "Spare"],
        loose: [{ path: "mods/private.jar", size: 10 }],
        looseBytes: 10,
      },
    },
    "cloud:pushInstance": {
      ok: true,
      describe: { skipped: [{ path: "mods/giant.jar", why: "too big" }] },
      worlds: { sent: ["My Base"], failed: [{ world: "Spare", why: "no room" }] },
    },
  });
  await page.evaluate((p) => window.openCloudSaveModal(p), PROFILE);
  await page.waitForFunction(() => !!document.querySelector("#csLoose"));
  await page.check("#csLoose");
  await page.check('.cs-world[value="My Base"]');
  await page.click("#csGo");
  await page.waitForFunction(() => window.__alerts.length);

  check("what was ticked is what is sent",
    await page.evaluate(() => window.__calls.find(c => c[0] === "cloud:pushInstance")[1]),
    { id: 31, worlds: ["My Base"], loose: true });
  const told = await page.evaluate(() => window.__alerts.join("\n"));
  check("and what did not go is said out loud, both kinds",
    [/mods\/giant\.jar/.test(told), /1 world\(s\) did not go/.test(told), /Spare/.test(told)],
    [true, true, true],
    "a dialog that reports success while dropping a world is how somebody loses one");
}

// ── getting: into THIS instance, not the one it came from ──
{
  await clear();
  await load({
    "cloud:status": {
      ok: true, signedIn: true,
      items: [
        { kind: "instances", id: "7", name: "1.21 Fabric", deviceName: "Desktop", at: 1 },
        { kind: "settings", id: null, name: "Settings", at: 2 },
      ],
    },
    "cloud:pullInstance": { ok: true, wrote: 9, worlds: { got: [], missing: [] } },
  });
  await page.evaluate((p) => window.openCloudGetModal(p), PROFILE);
  await page.waitForFunction(() => !/Looking in/.test(document.querySelector("#cgBody").textContent));

  check("only instances are offered, not everything in the Drive",
    await page.evaluate(() => [...document.querySelectorAll('input[name="cgPick"]')].length), 1);
  await page.click("#cgGo");
  await page.waitForFunction(() => window.__calls.some(c => c[0] === "cloud:pullInstance"));
  check("it is asked about first, because files here are replaced",
    await page.evaluate(() => /Write "1\.21 Fabric" into "My Instance"/.test(window.__asked[0] || "")), true);
  check("and it is written into the instance it was opened from",
    await page.evaluate(() => window.__calls.find(c => c[0] === "cloud:pullInstance")[1]),
    { id: "7", intoId: 31 },
    "the sending computer's instance id means nothing here, so pulling by it would only ever work at home");
}

// ── getting: a refusal is a refusal ──
{
  await clear();
  await load({
    "cloud:status": { ok: true, signedIn: true, items: [{ kind: "instances", id: "7", name: "A", at: 1 }] },
    "cloud:pullInstance": { ok: true },
    confirm: false,
  });
  await page.evaluate((p) => window.openCloudGetModal(p), PROFILE);
  await page.waitForFunction(() => !!document.querySelector('input[name="cgPick"]'));
  await page.click("#cgGo");
  await page.waitForFunction(() => window.__asked.length);
  check("saying no writes nothing",
    await page.evaluate(() => window.__calls.some(c => c[0] === "cloud:pullInstance")), false);
}

// ── importing a world from any instance ──
{
  await clear();
  await load({
    "cloud:worlds": {
      ok: true,
      worlds: [
        { instanceId: "7", world: "My Base", name: "My Base", size: 1024 * 1024, deviceName: "Desktop" },
        { instanceId: "31", world: "Here", name: "Here", size: 2048, deviceName: "Laptop" },
      ],
    },
    "get-instance-worlds": [],
    "cloud:pullWorld": { ok: true },
  });
  await page.evaluate((p) => window.openCloudWorldModal(p), PROFILE);
  await page.waitForFunction(() => !/Looking in/.test(document.querySelector("#cwBody").textContent));

  const shown = await page.evaluate(() => document.querySelector("#cwBody").textContent.replace(/\s+/g, " "));
  check("worlds from every instance are offered, not just this one's",
    [/My Base/.test(shown), /from Desktop/.test(shown), /Here.*this instance/.test(shown)],
    [true, true, true],
    "a world synced from another computer is in a differently-numbered instance, always");

  await page.click("#cwGo");
  await page.waitForFunction(() => window.__calls.some(c => c[0] === "cloud:pullWorld"));
  check("and it lands in the instance it was imported from",
    await page.evaluate(() => window.__calls.find(c => c[0] === "cloud:pullWorld")[1]),
    { instanceId: "7", world: "My Base", intoId: 31 });
  check("no overwrite was asked about, because nothing was there",
    await page.evaluate(() => window.__asked.length), 0);
}

// ── importing over a world that is already here ──
{
  await clear();
  await load({
    "cloud:worlds": { ok: true, worlds: [{ instanceId: "7", world: "My Base", size: 10, deviceName: "Desktop" }] },
    "get-instance-worlds": [{ folder: "My Base", name: "My Base" }],
    "cloud:pullWorld": { ok: true },
    confirm: false,
  });
  await page.evaluate((p) => window.openCloudWorldModal(p), PROFILE);
  await page.waitForFunction(() => !!document.querySelector('input[name="cwPick"]'));
  await page.click("#cwGo");
  await page.waitForFunction(() => window.__asked.length);
  check("a world already here is not written over without asking",
    await page.evaluate(() => /already exists/.test(window.__asked[0] || "")), true,
    "what is here now is somebody's save game, and it cannot be got back");
  check("and saying no leaves it alone",
    await page.evaluate(() => window.__calls.some(c => c[0] === "cloud:pullWorld")), false);
}

await browser.close();
console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
