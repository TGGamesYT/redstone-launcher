/**
 * A .properties file as names and values.
 *
 *   const ed = PropsEditor.render(host, text, onChange);
 *   ed.text()        // the file again, with the edits in it
 *
 * `server.properties` is a list of settings, and editing it as a wall of
 * `key=value` meant knowing the exact spelling of every name, never making a
 * typo, and knowing which of them are yes/no and which are numbers. Here the
 * name is on the left and the value on the right, as the control the value
 * actually is: a tick for true/false, a number field for a number, a list for
 * the few that have a fixed set of answers.
 *
 * Everything that is not a setting -- comments, blank lines, the order -- is
 * kept exactly as it was, so saving a file this has opened changes only the
 * values that were edited. A line it cannot make sense of is kept verbatim
 * too, rather than being dropped on the way back out.
 */
(function () {
  if (window.PropsEditor) return;

  // The handful of server.properties settings whose answers are a fixed list,
  // and one line each on what the rest are for. Nothing here decides what a
  // setting IS -- a key not in this list is still shown and still editable;
  // this only makes the common ones easier to get right.
  const CHOICES = {
    difficulty: ["peaceful", "easy", "normal", "hard"],
    gamemode: ["survival", "creative", "adventure", "spectator"],
    "level-type": ["minecraft:normal", "minecraft:flat", "minecraft:large_biomes", "minecraft:amplified", "minecraft:single_biome_surface"],
  };
  const ABOUT = {
    "allow-flight": "Whether a client may fly in survival (an anti-cheat setting, not creative flight).",
    "allow-nether": "Whether the Nether exists on this server.",
    difficulty: "How hard the world is.",
    "enable-command-block": "Whether command blocks run.",
    "enable-rcon": "A remote console on its own port.",
    "enforce-secure-profile": "Refuse clients that will not sign their chat.",
    "enforce-whitelist": "Kick anybody not on the whitelist, not just refuse new joins.",
    gamemode: "The mode a player starts in.",
    "force-gamemode": "Put returning players back into that mode every join.",
    hardcore: "Death is permanent, and the difficulty is locked to hard.",
    "level-name": "The folder the world lives in.",
    "level-seed": "The seed a new world is generated from. Blank is random.",
    "level-type": "Which generator makes the world.",
    "max-players": "How many may be connected at once.",
    "max-world-size": "How far out from the centre the world may be generated, in blocks.",
    motd: "The line shown under the name in the multiplayer list.",
    "online-mode": "Check every player with Mojang. Off, anybody may claim any name.",
    pvp: "Whether players can hurt each other.",
    "player-idle-timeout": "Kick a player after this many minutes of standing still. 0 never does.",
    "require-resource-pack": "Refuse a player who declines the server's resource pack.",
    "resource-pack": "A URL the client downloads a resource pack from.",
    "server-ip": "Which address to listen on. Blank is all of them.",
    "server-port": "The port to listen on.",
    "simulation-distance": "How far out from a player the world keeps ticking, in chunks.",
    "spawn-protection": "How many blocks around spawn only operators may build in.",
    "view-distance": "How far a player can see, in chunks.",
    "white-list": "Only let listed players in.",
  };

  const isBool = (v) => v === "true" || v === "false";
  const isNum = (v) => v !== "" && /^-?\d+(\.\d+)?$/.test(v);

  // A .properties file is lines. Each one is a setting, a comment, blank, or
  // something we do not understand -- and all four have to come back out.
  function parse(text) {
    return String(text == null ? "" : text).split(/\r?\n/).map((line) => {
      const m = /^([^#!=:\s][^=:]*?)\s*[=:]\s*(.*)$/.exec(line);
      if (!m) return { raw: line };
      return { raw: line, key: m[1], value: m[2], sep: line.slice(m[1].length).match(/^\s*[=:]\s*/)[0] };
    });
  }

  function serialise(lines) {
    return lines.map((l) => (l.key == null ? l.raw : `${l.key}${l.sep}${l.value}`)).join("\n");
  }

  function render(host, text, onChange) {
    const lines = parse(text);

    host.innerHTML = `
      <div class="pe-wrap">
        <div class="pe-tools">
          <input type="search" class="pe-find" placeholder="Search settings…" spellcheck="false">
          <span class="pe-count"></span>
        </div>
        <div class="pe-rows"></div>
      </div>`;
    const rows = host.querySelector(".pe-rows");
    const findEl = host.querySelector(".pe-find");
    const countEl = host.querySelector(".pe-count");

    const settings = lines.filter((l) => l.key != null);
    if (!settings.length) {
      rows.innerHTML = '<div class="pe-note">There are no settings in this file yet.</div>';
    }
    countEl.textContent = settings.length ? `${settings.length} setting${settings.length === 1 ? "" : "s"}` : "";

    // The comment lines immediately above a setting are about that setting, so
    // they are shown with it rather than as a line of their own.
    const noteFor = (i) => {
      const out = [];
      for (let k = i - 1; k >= 0; k--) {
        const l = lines[k];
        if (l.key != null) break;
        const t = l.raw.trim();
        if (!t) break;
        if (!/^[#!]/.test(t)) break;
        out.unshift(t.replace(/^[#!]\s*/, ""));
      }
      return out.join(" ");
    };

    const changed = () => { try { if (onChange) onChange(); } catch { /* the caller's problem */ } };

    lines.forEach((l, i) => {
      if (l.key == null) return;
      const row = document.createElement("div");
      row.className = "pe-row";
      row.dataset.search = `${l.key} ${l.value}`.toLowerCase();

      const k = document.createElement("div");
      k.className = "k";
      k.textContent = l.key;
      const about = ABOUT[l.key] || noteFor(i);
      if (about) {
        const small = document.createElement("small");
        small.textContent = about;
        k.appendChild(small);
      }

      const v = document.createElement("div");
      v.className = "v";
      const choices = CHOICES[l.key];
      if (choices) {
        const sel = document.createElement("select");
        // Whatever is in the file can still be chosen even if it is not one of
        // ours: a value we have not heard of is still the value.
        const all = choices.includes(l.value) ? choices : [l.value, ...choices];
        for (const c of all) {
          const o = document.createElement("option");
          o.value = c; o.textContent = c;
          if (c === l.value) o.selected = true;
          sel.appendChild(o);
        }
        sel.onchange = () => { l.value = sel.value; changed(); };
        v.appendChild(sel);
      } else if (isBool(l.value)) {
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = l.value === "true";
        const lab = document.createElement("span");
        lab.textContent = cb.checked ? "yes" : "no";
        lab.style.opacity = "0.7";
        cb.onchange = () => {
          l.value = cb.checked ? "true" : "false";
          lab.textContent = cb.checked ? "yes" : "no";
          changed();
        };
        v.append(cb, lab);
      } else if (isNum(l.value)) {
        const n = document.createElement("input");
        n.type = "number";
        n.value = l.value;
        n.oninput = () => { l.value = n.value; changed(); };
        v.appendChild(n);
      } else {
        const t = document.createElement("input");
        t.type = "text";
        t.value = l.value;
        t.oninput = () => { l.value = t.value; changed(); };
        v.appendChild(t);
      }

      row.append(k, v);
      rows.appendChild(row);
    });

    findEl.addEventListener("input", () => {
      const q = findEl.value.trim().toLowerCase();
      let shown = 0;
      for (const row of rows.querySelectorAll(".pe-row")) {
        const hit = !q || row.dataset.search.includes(q);
        row.classList.toggle("gone", !hit);
        if (hit) shown++;
      }
      countEl.textContent = q
        ? `${shown} of ${settings.length}`
        : (settings.length ? `${settings.length} setting${settings.length === 1 ? "" : "s"}` : "");
    });

    return { text: () => serialise(lines) };
  }

  window.PropsEditor = { render, parse, serialise };
})();
