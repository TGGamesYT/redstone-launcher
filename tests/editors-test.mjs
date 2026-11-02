// The two things every text editor in the launcher was missing: a way to edit
// a .properties file as settings rather than as a wall of key=value, and
// Ctrl+F.
//
// The round-trip is the part that matters for the first one. Saving a config
// file must not reword it: the comments, the blank lines, the order and the
// separators all have to come back out exactly as they went in, or editing one
// value quietly rewrites the whole file.
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FE = path.join(ROOT, "frontend");

let bad = 0;
const check = (label, got, want, note) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${note ? "  — " + note : ""}\n       got  ${JSON.stringify(got)}` + (ok ? "" : `\n       want ${JSON.stringify(want)}`));
};

// A server.properties with everything awkward in it: comments, a blank line,
// a colon separator, an empty value, a value with spaces, and a key nothing
// knows about.
const PROPS = [
  "#Minecraft server properties",
  "#Thu Jan 01 00:00:00 GMT 2026",
  "",
  "# How hard the world is",
  "difficulty=normal",
  "enable-command-block=false",
  "level-seed=",
  "max-players=20",
  "motd=A Minecraft Server",
  "server-port: 25565",
  "something-we-have-never-heard-of=42",
].join("\n");

const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${path.join(FE, "common.css")}"></head><body>
<div id="props"></div>
<div id="hold"><textarea id="area" style="width:400px;height:200px;"></textarea></div>
<script src="${path.join(FE, "propsedit.js")}"></script>
<script src="${path.join(FE, "findbar.js")}"></script>
</body></html>`;

const OUT = path.join(ROOT, "node_modules", ".cache", "editors");
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "probe.html"), html);

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
const p = await browser.newPage();
await p.goto("file://" + path.join(OUT, "probe.html"), { waitUntil: "domcontentloaded" });
await p.waitForFunction(() => window.PropsEditor && window.FindBar);

// ── the properties editor ──
await p.evaluate((text) => {
  window.__changes = 0;
  window.__ed = window.PropsEditor.render(document.getElementById("props"), text, () => { window.__changes++; });
}, PROPS);

check("every setting gets a row, and nothing else does",
  await p.$$eval("#props .pe-row .k", els => els.map(e => e.firstChild.textContent)),
  ["difficulty", "enable-command-block", "level-seed", "max-players", "motd", "server-port",
    "something-we-have-never-heard-of"],
  "the comments and the blank line are not settings");

check("the value is the kind of control the value is",
  await p.$$eval("#props .pe-row .v", els => els.map(e => {
    const c = e.firstElementChild;
    return c.tagName === "SELECT" ? "select" : c.type;
  })),
  ["select", "checkbox", "text", "number", "text", "number", "number"],
  "a fixed list of answers is a list, true/false is a tick, a number is a number");

check("a setting we know about explains itself",
  await p.$eval("#props .pe-row .k small", e => e.textContent),
  "How hard the world is.");
check("and one we do not takes the comment above it, if there is one",
  await p.$$eval("#props .pe-row", els => {
    const row = els.find(e => e.firstChild.firstChild.textContent === "something-we-have-never-heard-of");
    return row.querySelector("small") ? row.querySelector("small").textContent : null;
  }),
  null,
  "there is no comment above that one, so there is nothing to say");

check("untouched, the file comes back byte for byte",
  await p.evaluate(() => window.__ed.text()), PROPS,
  "a config file must not be reworded by having been opened");

// Change one value of each kind and check nothing else moved.
await p.evaluate(() => {
  const rows = [...document.querySelectorAll("#props .pe-row")];
  const by = (k) => rows.find(r => r.firstChild.firstChild.textContent === k);
  const sel = by("difficulty").querySelector("select");
  sel.value = "hard"; sel.dispatchEvent(new Event("change"));
  const cb = by("enable-command-block").querySelector("input");
  cb.checked = true; cb.dispatchEvent(new Event("change"));
  const num = by("max-players").querySelector("input");
  num.value = "8"; num.dispatchEvent(new Event("input"));
  const txt = by("motd").querySelector("input");
  txt.value = "Hello there"; txt.dispatchEvent(new Event("input"));
});

check("an edit changes that line and only that line",
  (await p.evaluate(() => window.__ed.text())).split("\n"),
  [
    "#Minecraft server properties",
    "#Thu Jan 01 00:00:00 GMT 2026",
    "",
    "# How hard the world is",
    "difficulty=hard",
    "enable-command-block=true",
    "level-seed=",
    "max-players=8",
    "motd=Hello there",
    "server-port: 25565",
    "something-we-have-never-heard-of=42",
  ],
  "the colon separator and the spacing around it are kept as they were found");

check("and each edit says so, so it can be saved", await p.evaluate(() => window.__changes), 4);

check("the tick says which way it is",
  await p.$$eval("#props .pe-row .v span", els => els.map(e => e.textContent)), ["yes"]);

// Searching the settings.
await p.evaluate(() => {
  const f = document.querySelector("#props .pe-find");
  f.value = "players"; f.dispatchEvent(new Event("input"));
});
check("searching narrows to the matching settings",
  await p.$$eval("#props .pe-row", els => els.filter(e => !e.classList.contains("gone"))
    .map(e => e.firstChild.firstChild.textContent)),
  ["max-players"]);
check("and says how many are left",
  await p.$eval("#props .pe-count", e => e.textContent), "1 of 7");

// ── Ctrl+F ──
await p.evaluate(() => {
  const a = document.getElementById("area");
  a.value = "one\ntwo\nthree\ntwo again\nTWO shouting\n";
  window.FindBar.attach(a, { host: document.getElementById("hold") });
});
check("the bar is not there until it is asked for",
  await p.$eval("#hold .findbar", e => e.style.display), "none");

await p.click("#area");
await p.keyboard.press("Control+f");
check("Ctrl+F opens it", await p.$eval("#hold .findbar", e => e.style.display !== "none"), true);

await p.fill("#hold .fnd-q", "two");
check("it counts the matches, ignoring case by default",
  await p.$eval("#hold .fnd-count", e => e.textContent), "1 of 3");
check("and selects the first one",
  await p.$eval("#area", e => e.value.slice(e.selectionStart, e.selectionEnd)), "two");

await p.keyboard.press("Enter");
check("Enter goes to the next", await p.$eval("#hold .fnd-count", e => e.textContent), "2 of 3");
await p.keyboard.press("Shift+Enter");
check("and Shift+Enter back", await p.$eval("#hold .fnd-count", e => e.textContent), "1 of 3");
await p.keyboard.press("Shift+Enter");
check("which wraps round the end", await p.$eval("#hold .fnd-count", e => e.textContent), "3 of 3");

await p.check("#hold .fnd-case input");
check("matching case counts fewer",
  await p.$eval("#hold .fnd-count", e => e.textContent), "1 of 2");

await p.fill("#hold .fnd-q", "nothing like this");
check("and says so when there are none",
  [await p.$eval("#hold .fnd-count", e => e.textContent),
   await p.$eval("#hold .findbar", e => e.classList.contains("empty"))],
  ["none", true]);

// ── and that the matches are actually SHOWN ──
// Selecting them was not enough: a textarea only draws its selection while it
// is focused, and focus stays in the find box, so nothing appeared at all.
// Case matching is still ticked from above; these are about the marks.
await p.uncheck("#hold .fnd-case input");
await p.fill("#hold .fnd-q", "two");
check("every match is marked",
  await p.$$eval("#hold .fnd-layer .fnd-hit", els => els.map(e => e.textContent)),
  ["two", "two", "TWO"]);
check("and exactly one of them is marked as the one you are on",
  await p.$$eval("#hold .fnd-layer .fnd-hit", els => els.map(e => e.classList.contains("on"))),
  [true, false, false]);
await p.keyboard.press("Enter");
check("stepping moves which one that is",
  await p.$$eval("#hold .fnd-layer .fnd-hit", els => els.map(e => e.classList.contains("on"))),
  [false, true, false]);
check("the layer holds the same text as the field",
  await p.evaluate(() => document.querySelector("#hold .fnd-layer").textContent.trim()
    === document.getElementById("area").value.trim()),
  true,
  "a character out of step and the highlight sits beside the word");
check("the marks line up with the words they are under",
  await p.evaluate(() => {
    const a = document.getElementById("area");
    const mark = document.querySelectorAll("#hold .fnd-layer .fnd-hit")[0];
    const m = mark.getBoundingClientRect();
    // The first match is on the second line of the field. Its box has to be
    // inside the field's, and a sensible size for three characters.
    const r = a.getBoundingClientRect();
    return [m.width > 4, m.height > 4, m.left >= r.left - 1, m.top >= r.top - 1, m.bottom <= r.bottom + 1];
  }),
  [true, true, true, true, true]);
check("the field is see-through while they are showing, so they can be seen",
  await p.$eval("#area", e => getComputedStyle(e).backgroundColor),
  "rgba(0, 0, 0, 0)");

await p.keyboard.press("Escape");
check("Escape closes it", await p.$eval("#hold .findbar", e => e.style.display), "none");
check("and the layer goes with it, along with the field's own background",
  [await p.$$eval("#hold .fnd-layer", els => els.length),
   await p.$eval("#area", e => getComputedStyle(e).backgroundColor !== "rgba(0, 0, 0, 0)")],
  [0, true],
  "a page with a closed find bar pays nothing for it");
check("and the field is back where it started in the layout",
  await p.evaluate(() => document.getElementById("area").parentElement.id), "hold");

await browser.close();
console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
