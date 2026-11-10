// The relay's own settings, and who is allowed to change them.
//
// There was no one place for them: the admin password was in a file of its
// own, the CurseForge token was an environment variable, the base domain was
// a default baked into relay.js, and changing any of them meant knowing which
// of those it happened to be in. config.js holds them all now, brings the old
// files in by itself, and can be edited from the admin panel.
//
// Two things here matter more than the rest and are checked hardest:
//
//   a secret is never handed back out -- the panel can show that there IS a
//   token without putting it on somebody's screen;
//   and changing these is behind the ACCOUNT, not the admin password. The
//   password is shared with whoever helps run the relay; this page changes
//   the relay's own credentials.
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { fileURLToPath, pathToFileURL } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "relay-server", "config.js");

let bad = 0;
const ok = (what, note) => console.log(`ok   ${what}${note ? "  — " + note : ""}`);
const fail = (what, why) => { bad++; console.log(`FAIL ${what}\n       ${why}`); };
const check = (what, got, want, note) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) ok(what, note); else fail(what, `got  ${a}\n       want ${b}`);
};

const TG = "20bbb23e-2f22-46ba-b201-c6bd435b445b";
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

// A fresh relay-server folder and a fresh copy of the module for each
// scenario: the file it reads is chosen from the environment when it loads,
// and ESM hands back the same module object otherwise.
let n = 0;
async function freshConfig({ files = {}, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relaycfg-"));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  const was = {};
  const vars = {
    RELAY_CONFIG: path.join(dir, "config.json"),
    RELAY_ADMIN_PASSWORD_FILE: path.join(dir, "admin-password.txt"),
    ...env,
  };
  for (const [k, v] of Object.entries(vars)) { was[k] = process.env[k]; process.env[k] = v; }
  const mod = await import(pathToFileURL(SRC).href + `?n=${++n}`);
  return {
    dir, mod,
    read: () => JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")),
    exists: () => fs.existsSync(path.join(dir, "config.json")),
    done() { for (const [k, v] of Object.entries(was)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } },
  };
}

// ── bringing the old password in ──────────────────────────────────────────
{
  const hash = sha256("hunter2");
  const c = await freshConfig({ files: { "admin-password.txt": hash + "\n" } });
  check("an admin-password.txt is moved in by itself", c.read().adminPasswordSha256, hash,
    "nobody has to be told to do anything on a box that is already running");
  check("and the password still works afterwards",
    [c.mod.adminPasswordOk("hunter2"), c.mod.adminPasswordOk("hunter3")], [true, false]);
  check("the old file is left where it is", fs.existsSync(path.join(c.dir, "admin-password.txt")), true,
    "deleting the only copy of a password's hash because a migration thinks it worked is not a trade worth making");
  c.done();
}
{
  // A second start must not undo a password set since.
  const c = await freshConfig({
    files: {
      "admin-password.txt": sha256("old") + "\n",
      "config.json": JSON.stringify({ adminPasswordSha256: sha256("new") }),
    },
  });
  check("and a password already set is never replaced by the old file",
    [c.mod.adminPasswordOk("new"), c.mod.adminPasswordOk("old")], [true, false]);
  c.done();
}
{
  const c = await freshConfig({ files: { "admin-password.txt": "not a hash\n" } });
  check("a password file that is not a hash sets nothing",
    [c.exists(), c.mod.adminPasswordOk("not a hash")], [false, false]);
  c.done();
}
{
  const c = await freshConfig();
  check("and with no password set, nothing is the password",
    [c.mod.adminPasswordOk(""), c.mod.adminPasswordOk("anything")], [false, false],
    "an unconfigured relay must not be an open one");
  c.done();
}

// ── the Cloudflare token, misnamed ────────────────────────────────────────
//
// CF_API_TOKEN is Cloudflare's and always was; it was written into this file
// as "curseforgeToken". A relay given the token through the admin panel in
// the meantime has it under that name, and losing it turns direct
// connections off without saying anything.
{
  const c = await freshConfig({
    files: { "config.json": JSON.stringify({ curseforgeToken: "cf-token" }) },
  });
  check("a token stored under the old name is carried across, not dropped",
    [c.mod.get("cloudflareToken"), "curseforgeToken" in c.read()], ["cf-token", false],
    "it is the one thing that makes a direct connection possible");
  c.done();
}
{
  const c = await freshConfig({
    files: { "config.json": JSON.stringify({ curseforgeToken: "old", cloudflareToken: "new" }) },
  });
  check("and never over one already set under the right name",
    [c.mod.get("cloudflareToken"), "curseforgeToken" in c.read()], ["new", false]);
  c.done();
}
{
  const c = await freshConfig({ files: { "config.json": JSON.stringify({ cloudflareToken: "tok" }) } });
  check("the setting is named after what it talks to",
    c.mod.describe().find(f => f.id === "cloudflareToken").label, "Cloudflare API token",
    "a panel that calls it a CurseForge token is a panel that gets a CurseForge token pasted into it");
  check("and there is no CurseForge setting at all",
    c.mod.describe().some(f => /curseforge/i.test(f.id) || /curseforge/i.test(f.label)), false,
    "CurseForge lookups go through a worker and need nothing on the relay");
  c.done();
}

// ── the environment still wins ────────────────────────────────────────────
{
  const c = await freshConfig({
    files: { "config.json": JSON.stringify({ cloudflareToken: "from-file" }) },
    env: { CF_API_TOKEN: "from-env" },
  });
  check("an environment variable beats the file", c.mod.get("cloudflareToken"), "from-env",
    "every relay running today is configured that way, and this must not change what any of them does");
  const row = c.mod.describe().find(f => f.id === "cloudflareToken");
  check("and the panel says so rather than letting it look ignored",
    [row.source, row.locked], ["environment", true],
    '"I changed it and nothing happened" is otherwise a mystery');
  c.done();
}
{
  const c = await freshConfig({ files: { "config.json": JSON.stringify({ domain: "example.net" }) } });
  check("without one the file is used", c.mod.get("domain"), "example.net");
  c.done();
}
{
  const c = await freshConfig();
  check("and without either, the default", c.mod.get("domain"), "redstonemc.net");
  c.done();
}

// ── a secret is never handed back ─────────────────────────────────────────
{
  const c = await freshConfig({
    files: {
      "config.json": JSON.stringify({
        cloudflareToken: "cf-secret-value",
        googleClientSecret: "google-secret-value",
        adminPasswordSha256: sha256("pw"),
      }),
    },
  });
  const shown = JSON.stringify(c.mod.describe());
  check("no secret appears anywhere in what the panel is given",
    ["cf-secret-value", "google-secret-value", sha256("pw")].map(v => shown.includes(v)),
    [false, false, false]);
  check("only whether each is set",
    ["adminPasswordSha256", "cloudflareToken", "googleClientSecret"]
      .map(id => c.mod.describe().find(f => f.id === id))
      .map(f => [f.id, f.set, "value" in f]),
    [["adminPasswordSha256", true, false], ["cloudflareToken", true, false],
      ["googleClientSecret", true, false]]);
  check("and no secret carries a value at all, whatever it is called",
    c.mod.describe().filter(f => f.set !== undefined).every(f => !("value" in f)), true,
    "so a secret added later cannot leak by being forgotten about here");
  check("and something that is not a secret is shown as itself",
    c.mod.describe().find(f => f.id === "domain").value, "redstonemc.net");
  c.done();
}

// ── who may change them ───────────────────────────────────────────────────
//
// The uuid handed in comes from Mojang's hasJoined for the connection and
// from nowhere else; nothing a client says about who it is reaches this.
{
  const c = await freshConfig();
  check("the owner list starts as TGdoesCode", c.mod.get("ownerUuids"), [TG]);
  check("and that account is recognised with dashes, without, and in any case",
    [TG, TG.replace(/-/g, ""), TG.toUpperCase()].map(u => c.mod.isOwner(u)),
    [true, true, true]);
  check("anybody else is not",
    ["f06d927e-d6cf-48b8-ba61-588866b610c0", "", null, undefined, "not-a-uuid", "0".repeat(32)]
      .map(u => c.mod.isOwner(u)),
    [false, false, false, false, false, false],
    "including the other accounts in admins.json, which is a different list for a different thing");
  c.done();
}
{
  const c = await freshConfig();
  c.mod.set({ ownerUuids: [TG, "f06d927e-d6cf-48b8-ba61-588866b610c0"] });
  check("the list can be added to", c.mod.isOwner("f06d927ed6cf48b8ba61588866b610c0"), true,
    "so signing in with the other account is one edit rather than a wall");
  let said = null;
  try { c.mod.set({ ownerUuids: [] }); } catch (e) { said = e.message; }
  check("but never emptied", [said !== null, c.mod.get("ownerUuids").length], [true, 2],
    "there would be nobody left who could put somebody back");
  said = null;
  try { c.mod.set({ ownerUuids: ["steve"] }); } catch (e) { said = e.message; }
  check("and only takes UUIDs", [/not a UUID/.test(said || ""), c.mod.isOwner(TG)], [true, true],
    "a name that is not a uuid would silently match nobody");
  c.done();
}

// ── setting them ──────────────────────────────────────────────────────────
{
  const c = await freshConfig();
  c.mod.set({ adminPasswordSha256: "a new password" });
  check("a password is stored as its hash, never as itself",
    [c.read().adminPasswordSha256, JSON.stringify(c.read()).includes("a new password")],
    [sha256("a new password"), false],
    "nothing here needs the password, only to recognise it");
  check("and it is the password from then on",
    c.mod.adminPasswordOk("a new password"), true);

  c.mod.set({ cloudflareToken: "tok" });
  check("one field at a time leaves the others alone",
    [c.mod.get("cloudflareToken"), c.mod.adminPasswordOk("a new password")], ["tok", true]);

  c.mod.set({ cloudflareToken: "" });
  check("clearing one puts it back to its default rather than leaving it empty",
    [c.mod.get("cloudflareToken"), "cloudflareToken" in c.read()], ["", false]);

  let said = null;
  try { c.mod.set({ notASetting: "x" }); } catch (e) { said = e.message; }
  check("and a setting nobody declared is refused", /No such setting/.test(said || ""), true,
    "so the panel cannot write arbitrary keys into the file");
  c.done();
}
{
  const c = await freshConfig();
  c.mod.set({ domain: "a.example" });
  check("the file it writes is valid JSON and readable only by its owner",
    [typeof c.read(), (fs.statSync(path.join(c.dir, "config.json")).mode & 0o077)], ["object", 0],
    "it holds a password hash and an API token");
  check("and nothing is left behind from writing it",
    fs.readdirSync(c.dir).filter(f => f.includes(".tmp")), [],
    "written beside itself and renamed over, so a reader never sees half a file");
  c.done();
}

// ── and what relay.js does with it ────────────────────────────────────────
const relay = fs.readFileSync(path.join(ROOT, "relay-server", "relay.js"), "utf8");
const code = relay.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

check("the settings ops are owner-only",
  /OWNER_OPS\s*=\s*new Set\(\[[^\]]*"settings\.list"[^\]]*"settings\.set"[^\]]*"settings\.clear"/.test(code),
  true);
check("and the gate asks config.isOwner about the account, not about the request",
  /OWNER_OPS\.has\(op\) && !config\.isOwner\(who/.test(code), true,
  "who comes from Mojang's hasJoined for the connection; nothing the client claims reaches it");
check("the gate is checked before the op runs",
  code.indexOf("OWNER_OPS.has(op)") < code.indexOf("return fn(req, who)"), true);
check("the panel is not even offered to anybody else",
  /panels: panelsFor\(who\)/.test(code) && /config\.isOwner\(who && who\.uuid\)/.test(code), true,
  "a locked door on everybody's screen is worse than no door");
check("the admin password alone still opens everything else",
  /if \(!adminOk\(req\.password\)\) return \{ ok: false, error: "no" \};/.test(code), true);
check("and the password check itself now goes through config",
  /const adminOk = \(password\) => config\.adminPasswordOk\(password\);/.test(code), true);
check("the scattered reads are gone",
  [/CF_API_TOKEN/.test(code), /adminPasswordHash/.test(code), /ADMIN_PASSWORD_FILE/.test(code)],
  [false, false, false]);

// The file holds a password hash and API tokens, so it must never be committed.
const ignored = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
check("config.json is not in the repository",
  /relay-server\/config\.json/.test(ignored), true);

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
