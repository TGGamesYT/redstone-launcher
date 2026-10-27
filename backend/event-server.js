// Event servers: a server described in a file, which sets itself up.
//
// The idea is a server you can hand somebody as one JSON file. Running it asks
// the questions the file says to ask, makes the server those answers describe,
// puts the plugins and packs it names into it, and then carries out whatever
// each stage of its life is supposed to do -- accepting the EULA, starting up,
// opping you, saying something in chat when a player joins.
//
// ── The shape ───────────────────────────────────────────────────────────────
//
// The format this grew from was written as JSON but was not valid JSON: it
// used arrays where it meant objects, and gave several entries the same key,
// which JSON cannot carry (an object may not repeat a key, and a parser keeps
// only the last one). Everything it expressed is here; the parts that were
// repeated keys are arrays of objects instead, and the parts that were arrays
// standing in for objects are objects.
//
//   {
//     "name": "My event",
//     "description": "What this is",
//
//     "oncreated": {
//       "questions": [
//         { "ask": "What version?",  "var": "mcver", "type": "mcversion" },
//         { "ask": "Start it now (and accept the EULA)?", "var": "doeula", "type": "yesno" }
//       ],
//       "server": {
//         "name": "my event server",
//         "loader": "paper-latest",
//         "version": "${mcver}",
//         "autoEula":  "${doeula} == yes",
//         "autoStart": "${doeula} == yes",
//         "content": {
//           "plugins":   ["modrinth:event-plugin-id", "curseforge:123456"],
//           "datapacks": ["modrinth:some-datapack"]
//         }
//       }
//     },
//
//     "onstarted": {
//       "questions": [
//         { "ask": "Op yourself?",       "var": "toop",     "type": "yesno" },
//         { "ask": "What's your name?",  "var": "username", "type": "string",
//           "when": "${toop} == yes" }
//       ]
//     },
//
//     "onfullystarted": {
//       "commands": [
//         { "run": "op ${username}", "when": "${toop} == yes" },
//         { "run": "say Starting event.." }
//       ]
//     },
//
//     "onplayerjoin": {
//       "commands": [ { "run": "msg ${player} welcome to the event" } ]
//     }
//   }
//
// A `${name}` anywhere in a string is the answer to the question that named
// that variable. `onplayerjoin` also has `${player}`, which is whoever just
// joined. A `when` is a condition on those answers and is the only thing
// standing between a step and being carried out.

// ── What a file may contain ─────────────────────────────────────────────────
//
// Declared once, here, so the editor can offer exactly what the runner
// understands rather than leaving somebody to guess at it.

export const PHASES = [
  {
    id: "oncreated",
    name: "When it is created",
    about: "Before anything exists: what to ask, and what server those answers describe.",
    allows: ["questions", "server"],
  },
  {
    id: "onstarted",
    name: "When it starts",
    about: "The moment the server process begins. Its console is not ready yet.",
    allows: ["questions", "commands"],
  },
  {
    id: "onfullystarted",
    name: "When it has finished starting",
    about: 'After the server says "Done" -- the first point a command will be understood.',
    allows: ["questions", "commands"],
  },
  {
    id: "onplayerjoin",
    name: "When a player joins",
    about: "Each time somebody joins. ${player} is whoever it was.",
    allows: ["commands"],
  },
];

export const QUESTION_TYPES = [
  { id: "string", name: "Some text", about: "Anything typed in." },
  { id: "yesno", name: "Yes or no", about: 'Answers as "yes" or "no", which a condition can test.' },
  { id: "choice", name: "One of a list", about: "Needs `options`." },
  { id: "number", name: "A number" },
  { id: "mcversion", name: "A Minecraft version", about: "Offered from the real version list." },
];

// The loaders a server can be made with. `-latest` takes the newest build
// rather than pinning one.
export const LOADERS = [
  { id: "vanilla", name: "Vanilla" },
  { id: "paper-latest", name: "Paper (newest build)" },
  { id: "purpur-latest", name: "Purpur (newest build)" },
  { id: "fabric-latest", name: "Fabric (newest loader)" },
  { id: "quilt-latest", name: "Quilt (newest loader)" },
  { id: "forge-latest", name: "Forge (newest)" },
  { id: "neoforge-latest", name: "NeoForge (newest)" },
];

// Where a piece of content comes from, and where it is put.
export const CONTENT_KINDS = [
  { id: "plugins", name: "Plugins", dir: "plugins" },
  { id: "mods", name: "Mods", dir: "mods" },
  { id: "datapacks", name: "Data packs", dir: "world/datapacks" },
  { id: "resourcepacks", name: "Resource packs", dir: "resourcepacks" },
];
export const PROVIDERS = ["modrinth", "curseforge"];

// ── Reading one ─────────────────────────────────────────────────────────────

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

// Everything wrong with a file, rather than only the first thing: somebody
// writing one of these wants the whole list.
export function parseEventServer(input) {
  const problems = [];
  const bad = (where, what) => problems.push(`${where}: ${what}`);

  let raw = input;
  if (typeof input === "string") {
    try { raw = JSON.parse(input); }
    catch (e) { return { ok: false, problems: [`That is not valid JSON -- ${e.message}`], value: null }; }
  }
  if (!isObj(raw)) return { ok: false, problems: ["The file has to be a JSON object."], value: null };

  const out = {
    name: String(raw.name || "").trim() || "Event server",
    description: String(raw.description || "").trim(),
    phases: {},
  };

  const known = new Set(PHASES.map(p => p.id));
  for (const key of Object.keys(raw)) {
    if (key === "name" || key === "description") continue;
    if (!known.has(key)) {
      bad(key, `not a stage. The stages are ${PHASES.map(p => p.id).join(", ")}.`);
    }
  }

  for (const phase of PHASES) {
    const block = raw[phase.id];
    if (block == null) continue;
    if (!isObj(block)) { bad(phase.id, "has to be an object."); continue; }
    const got = { questions: [], commands: [], server: null };

    for (const key of Object.keys(block)) {
      if (!phase.allows.includes(key)) {
        bad(`${phase.id}.${key}`, `is not used at this stage. It takes ${phase.allows.join(" and ")}.`);
      }
    }

    if (block.questions != null) {
      if (!Array.isArray(block.questions)) bad(`${phase.id}.questions`, "has to be a list.");
      else block.questions.forEach((q, i) => {
        const at = `${phase.id}.questions[${i}]`;
        if (!isObj(q)) { bad(at, "has to be an object."); return; }
        if (!String(q.ask || "").trim()) bad(at, "needs an `ask` -- the question to put.");
        if (!/^[a-zA-Z_][\w]*$/.test(String(q.var || ""))) {
          bad(at, "needs a `var` -- a name for the answer, letters and digits only.");
        }
        const type = String(q.type || "string");
        if (!QUESTION_TYPES.some(t => t.id === type)) {
          bad(at, `has type "${type}", which is not one of ${QUESTION_TYPES.map(t => t.id).join(", ")}.`);
        }
        if (type === "choice" && (!Array.isArray(q.options) || !q.options.length)) {
          bad(at, "is a choice, so it needs `options`.");
        }
        got.questions.push({
          ask: String(q.ask || ""), var: String(q.var || ""), type,
          options: Array.isArray(q.options) ? q.options.map(String) : [],
          default: q.default == null ? "" : String(q.default),
          when: q.when == null ? null : String(q.when),
        });
      });
    }

    if (block.commands != null) {
      if (!Array.isArray(block.commands)) bad(`${phase.id}.commands`, "has to be a list.");
      else block.commands.forEach((c, i) => {
        const at = `${phase.id}.commands[${i}]`;
        // A bare string is allowed as a shorthand for a command with no condition.
        if (typeof c === "string") { got.commands.push({ run: c, when: null }); return; }
        if (!isObj(c)) { bad(at, "has to be an object or a string."); return; }
        if (!String(c.run || "").trim()) bad(at, "needs a `run` -- the command to send.");
        got.commands.push({ run: String(c.run || ""), when: c.when == null ? null : String(c.when) });
      });
    }

    if (block.server != null) {
      if (!isObj(block.server)) bad(`${phase.id}.server`, "has to be an object.");
      else {
        const sv = block.server;
        const loader = String(sv.loader || "vanilla");
        // A loader may be a variable, which cannot be checked until it is run.
        if (!/\$\{/.test(loader) && !LOADERS.some(l => l.id === loader)) {
          bad(`${phase.id}.server.loader`, `"${loader}" is not one of ${LOADERS.map(l => l.id).join(", ")}.`);
        }
        if (!String(sv.version || "").trim()) bad(`${phase.id}.server.version`, "is needed.");
        const content = {};
        if (sv.content != null) {
          if (!isObj(sv.content)) bad(`${phase.id}.server.content`, "has to be an object.");
          else for (const [kind, list] of Object.entries(sv.content)) {
            if (!CONTENT_KINDS.some(k => k.id === kind)) {
              bad(`${phase.id}.server.content.${kind}`, `is not one of ${CONTENT_KINDS.map(k => k.id).join(", ")}.`);
              continue;
            }
            // A list, or the semicolon-separated string the first draft used.
            const items = Array.isArray(list)
              ? list.map(String)
              : String(list).split(";").map(x => x.trim()).filter(Boolean);
            for (const it of items) {
              const m = /^([a-z]+):(.+)$/i.exec(it);
              if (!m || !PROVIDERS.includes(m[1].toLowerCase())) {
                bad(`${phase.id}.server.content.${kind}`,
                  `"${it}" should look like ${PROVIDERS.map(p => p + ":id").join(" or ")}.`);
              }
            }
            content[kind] = items;
          }
        }
        got.server = {
          name: String(sv.name || out.name),
          loader,
          version: String(sv.version || ""),
          autoEula: sv.autoEula == null ? false : sv.autoEula,
          autoStart: sv.autoStart == null ? false : sv.autoStart,
          content,
        };
      }
    }

    out.phases[phase.id] = got;
  }

  if (!out.phases.oncreated || !out.phases.oncreated.server) {
    bad("oncreated.server", "is needed -- without it there is no server to make.");
  }

  return { ok: problems.length === 0, problems, value: out };
}

// ── Running one ─────────────────────────────────────────────────────────────

// `${name}` becomes the answer that named it. Anything unanswered becomes
// nothing rather than being left as the literal text.
export function fill(text, vars) {
  return String(text == null ? "" : text).replace(/\$\{(\w+)\}/g, (_, k) =>
    (vars && k in vars) ? String(vars[k]) : "");
}

// A condition on the answers. Deliberately small: a value, a comparison, or
// nothing at all. This is a description of a server, not a programming
// language, and anything cleverer would be a way to run arbitrary code from a
// file somebody was handed.
//
//   (absent)             -- always
//   "true" / "false"     -- always / never
//   "${a} == yes"        -- equal, ignoring case and surrounding space
//   "${a} != yes"        -- not equal
export function test(when, vars) {
  if (when == null || when === "") return true;
  const s = fill(when, vars).trim();
  if (/^true$/i.test(s)) return true;
  if (/^false$/i.test(s)) return false;
  const m = /^(.*?)\s*(==|!=)\s*(.*)$/.exec(s);
  if (!m) return !!s;                       // a bare value: anything non-empty
  const a = m[1].trim().toLowerCase();
  const b = m[3].trim().toLowerCase();
  return m[2] === "==" ? a === b : a !== b;
}

// The questions a stage actually asks, given what has been answered so far.
// A question whose `when` is false is not put at all.
export function questionsFor(def, phaseId, vars) {
  const phase = def && def.phases && def.phases[phaseId];
  if (!phase) return [];
  return phase.questions.filter(q => test(q.when, vars));
}

// The next question a stage still wants answered.
//
// They are put one at a time rather than all at once, because a question may
// depend on an earlier answer: "what is your username" is only worth asking
// once "op yourself?" has been answered yes, and until it has been there is
// no way to know.
export function nextQuestion(def, phaseId, vars) {
  const phase = def && def.phases && def.phases[phaseId];
  if (!phase) return null;
  for (const q of phase.questions) {
    if (vars && q.var in vars) continue;        // already answered
    if (!test(q.when, vars)) continue;          // not asked at all
    return q;
  }
  return null;
}

// The commands a stage runs, filled in and with the false ones dropped.
export function commandsFor(def, phaseId, vars) {
  const phase = def && def.phases && def.phases[phaseId];
  if (!phase) return [];
  return phase.commands.filter(c => test(c.when, vars)).map(c => fill(c.run, vars));
}

// What `oncreated` says to build, with the answers filled in.
export function serverSpecFor(def, vars) {
  const sv = def && def.phases && def.phases.oncreated && def.phases.oncreated.server;
  if (!sv) return null;
  const content = {};
  for (const [kind, items] of Object.entries(sv.content || {})) {
    content[kind] = items.map(it => fill(it, vars)).filter(Boolean);
  }
  return {
    name: fill(sv.name, vars).trim() || "Event server",
    loader: fill(sv.loader, vars).trim() || "vanilla",
    version: fill(sv.version, vars).trim(),
    autoEula: typeof sv.autoEula === "boolean" ? sv.autoEula : test(sv.autoEula, vars),
    autoStart: typeof sv.autoStart === "boolean" ? sv.autoStart : test(sv.autoStart, vars),
    content,
  };
}

// "modrinth:some-id" -> { provider, id }
export function splitRef(ref) {
  const m = /^([a-z]+):(.+)$/i.exec(String(ref || "").trim());
  if (!m) return null;
  const provider = m[1].toLowerCase();
  if (!PROVIDERS.includes(provider)) return null;
  return { provider, id: m[2].trim() };
}

export default {
  PHASES, QUESTION_TYPES, LOADERS, CONTENT_KINDS, PROVIDERS,
  parseEventServer, fill, test, questionsFor, nextQuestion, commandsFor, serverSpecFor, splitRef,
};
