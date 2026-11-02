// The event-server editor's form.
//
// A file whose whole point is being handed to somebody else was editable only
// as raw JSON -- which means knowing the shape, spelling every key right and
// keeping the brackets balanced. The form is the editor now and the JSON is
// the other view of it, so the thing to prove is that they are the same
// document: what the form shows is what the file says, and what the form
// changes is what gets saved.
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FE = path.join(ROOT, "frontend");
const OUT = path.join(ROOT, "node_modules", ".cache", "eventform");
fs.mkdirSync(OUT, { recursive: true });

let bad = 0;
const check = (label, got, want, note) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${note ? "  — " + note : ""}\n       got  ${JSON.stringify(got)}` + (ok ? "" : `\n       want ${JSON.stringify(want)}`));
};

// The schema the main process hands over, as it really is.
const SCHEMA = {
  success: true,
  phases: [
    { id: "oncreated", name: "When it is created", about: "Before anything exists.", allows: ["questions", "server"] },
    { id: "onstarted", name: "When it starts", about: "The process begins.", allows: ["questions", "commands"] },
    { id: "onfullystarted", name: "When it has finished starting", about: "After Done.", allows: ["questions", "commands"] },
    { id: "onplayerjoin", name: "When a player joins", about: "${player} is whoever it was.", allows: ["commands"] },
  ],
  questionTypes: [
    { id: "string", name: "Some text" },
    { id: "yesno", name: "Yes or no" },
    { id: "choice", name: "One of a list" },
    { id: "mcversion", name: "A Minecraft version" },
  ],
  loaders: [{ id: "vanilla", name: "Vanilla" }, { id: "paper-latest", name: "Paper (newest build)" }],
  contentKinds: [
    { id: "plugins", name: "Plugins", dir: "plugins" },
    { id: "datapacks", name: "Data packs", dir: "world/datapacks" },
  ],
  providers: ["modrinth", "curseforge"],
};

const FILE = {
  name: "My event",
  description: "What this is",
  oncreated: {
    questions: [{ ask: "What version?", var: "mcver", type: "mcversion" }],
    server: {
      name: "my event server", loader: "paper-latest", version: "${mcver}",
      autoEula: true, autoStart: true,
      content: { plugins: ["modrinth:event-plugin"] },
    },
  },
  onplayerjoin: { commands: [{ run: "msg ${player} hello" }] },
};

const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${path.join(FE, "server.css")}"></head>
<body><div id="host"></div>
<script>
  window.__text = null;
  window.require = () => ({ ipcRenderer: {
    invoke: async (ch) => (ch === 'eventserver:schema' ? ${JSON.stringify(SCHEMA)} : { success: true }),
    on() {}, send() {},
  } });
</script>
<script src="${path.join(FE, "eventservers.js")}"></script>
<script>
  // The form on its own, with a document and a change callback -- which is
  // exactly how the editor uses it.
  window.__doc = ${JSON.stringify(FILE)};
  window.__changes = 0;
  window.__draw = () => window.__buildForm(
    document.getElementById('host'), window.__doc, ${JSON.stringify(SCHEMA)},
    () => { window.__changes++; });
</script>
</body></html>`;

fs.writeFileSync(path.join(OUT, "probe.html"), html);
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
const p = await browser.newPage();
p.on("pageerror", (e) => { bad++; console.log("FAIL page error\n       " + e.message); });
await p.goto("file://" + path.join(OUT, "probe.html"), { waitUntil: "domcontentloaded" });
await p.waitForFunction(() => typeof window.__buildForm === "function");
await p.evaluate(() => window.__draw());

check("a panel per stage, plus what the file is",
  await p.$$eval("#host .es-stage > header .nm", els => els.map(e => e.textContent)),
  ["What this is", "When it is created", "When it starts", "When it has finished starting", "When a player joins"]);

// "What this is" carries no count -- there is nothing to count in a name and a
// description -- so these are the four stages.
check("a closed stage says what is in it",
  await p.$$eval("#host .es-stage > header .ct", els => els.map(e => e.textContent)),
  ["1 question · a server", "", "", "1 command"],
  "so a file can be read without opening every stage");

check("only the first is open to begin with",
  await p.$$eval("#host .es-stage", els => els.map(e => e.classList.contains("open"))),
  [true, false, false, false, false]);

// Open the created stage and read what it shows.
await p.evaluate(() => document.querySelectorAll("#host .es-stage > header")[1].click());
check("the question is shown as fields, with its own value in them",
  await p.$$eval("#host .es-stage:nth-child(2) .es-card .es-f", els => els.slice(0, 3).map(e => [
    e.querySelector("label").textContent,
    e.querySelector("input, select").value,
  ])),
  [["Ask", "What version?"], ["Remember as", "mcver"], ["Kind of answer", "mcversion"]]);

check("the server's software is a list, set to the one in the file",
  await p.$$eval("#host .es-stage:nth-child(2) select", els => {
    const sel = els.find(e => [...e.options].some(o => o.value === "paper-latest"));
    return [sel.value, [...sel.options].map(o => o.value)];
  }),
  ["paper-latest", ["vanilla", "paper-latest"]]);

check("a true switch reads as always, and one the file does not set is blank",
  await p.$$eval("#host .es-stage:nth-child(2) .es-f", els => {
    const by = (lab) => {
      const f = els.find(e => e.querySelector("label").textContent.startsWith(lab));
      return f ? f.querySelector("input").value : "(missing)";
    };
    return [by("Accept the EULA"), by("Start it"), by("Share it over the internet")];
  }),
  ["always", "always", ""],
  "they are conditions as much as switches, so one field does both");

check("content is a provider and an id rather than one string to get right",
  await p.$$eval("#host .es-stage:nth-child(2) .es-ref", els => els.map(e => [
    e.querySelector("select").value, e.querySelector("input").value,
  ])),
  [["modrinth", "event-plugin"]]);

// Now change things through the form and check the document.
await p.evaluate(() => {
  const els = [...document.querySelectorAll("#host .es-stage:nth-child(2) .es-f")];
  const share = els.find(e => e.querySelector("label").textContent.startsWith("Share it"));
  const i = share.querySelector("input");
  i.value = "always"; i.dispatchEvent(new Event("input"));
});
check("turning sharing on puts it in the file",
  await p.evaluate(() => window.__doc.oncreated.server.autoShare), true);

await p.evaluate(() => {
  const els = [...document.querySelectorAll("#host .es-stage:nth-child(2) .es-f")];
  const eula = els.find(e => e.querySelector("label").textContent.startsWith("Accept the EULA"));
  const i = eula.querySelector("input");
  i.value = "${doeula} == yes"; i.dispatchEvent(new Event("input"));
});
check("and a condition typed in stays a condition",
  await p.evaluate(() => window.__doc.oncreated.server.autoEula), "${doeula} == yes");

// Adding and removing, through the list controls.
await p.evaluate(() => {
  const stage = document.querySelectorAll("#host .es-stage")[4];
  stage.querySelector("header").click();
  [...stage.querySelectorAll(".es-add")].find(b => b.textContent.includes("Command")).click();
});
check("a command can be added",
  await p.evaluate(() => window.__doc.onplayerjoin.commands.length), 2);

await p.evaluate(() => {
  const stage = document.querySelectorAll("#host .es-stage")[4];
  const run = stage.querySelectorAll(".es-card")[1].querySelector("input");
  run.value = "say someone arrived"; run.dispatchEvent(new Event("input"));
  const when = stage.querySelectorAll(".es-card")[1].querySelectorAll("input")[1];
  when.value = "${toop} == yes"; when.dispatchEvent(new Event("input"));
});
check("with what to run and when",
  await p.evaluate(() => window.__doc.onplayerjoin.commands[1]),
  { run: "say someone arrived", when: "${toop} == yes" });

await p.evaluate(() => {
  const stage = document.querySelectorAll("#host .es-stage")[4];
  const when = stage.querySelectorAll(".es-card")[1].querySelectorAll("input")[1];
  when.value = "  "; when.dispatchEvent(new Event("input"));
});
check("an emptied condition is removed rather than left blank",
  await p.evaluate(() => Object.keys(window.__doc.onplayerjoin.commands[1])), ["run"],
  "a blank `when` would be a condition that is never true");

await p.evaluate(() => {
  const stage = document.querySelectorAll("#host .es-stage")[4];
  stage.querySelectorAll(".es-card")[0].querySelector('.es-mini[title="Move down"]').click();
});
check("and the order can be changed",
  await p.evaluate(() => window.__doc.onplayerjoin.commands.map(c => c.run)),
  ["say someone arrived", "msg ${player} hello"]);

check("every edit says so, so the file is written back",
  await p.evaluate(() => window.__changes > 0), true);

await browser.close();
console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
