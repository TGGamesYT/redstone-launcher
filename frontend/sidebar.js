function error(text, duration = 3000) {
  console.error(text)
  // Create container if needed
  let container = document.getElementById("error-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "error-container";
    document.body.appendChild(container);
  }

  // Create the popup
  const popup = document.createElement("div");
  popup.className = "error-popup";
  popup.innerHTML = `
    <span>${text}</span>
    <span class="close-btn">&times;</span>
    <div class="error-timer"><div class="error-timer-fill"></div></div>
  `;

  // Timer bar animation
  popup.querySelector(".error-timer-fill").style.animationDuration = duration + "ms";

  container.appendChild(popup);

  // Close on "X"
  popup.querySelector(".close-btn").onclick = () => popup.remove();

  // Auto-remove
  setTimeout(() => {
    popup.remove();
  }, duration);
}

function hexToRgb(hex) {
  hex = hex.replace(/^#/, '');
  return [
    parseInt(hex.substring(0, 2), 16),
    parseInt(hex.substring(2, 4), 16),
    parseInt(hex.substring(4, 6), 16)
  ];
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
}

function getMiddleColor(hex1, hex2) {
  const rgb1 = hexToRgb(hex1);
  const rgb2 = hexToRgb(hex2);
  const middle = rgb1.map((c, i) => Math.round((c + rgb2[i]) / 2));
  return rgbToHex(middle[0], middle[1], middle[2]);
}

function applyTheme(settings) {
  const textColor = settings.textColor;
  const textFont = settings.font;
  const base = settings.baseColor;
  const secondary = settings.secondaryColor;
  const mid = settings.thirdColor ?? getMiddleColor(base, secondary);
  document.documentElement.style.setProperty('--base-color', base);
  document.documentElement.style.setProperty('--secondary-color', secondary);
  document.documentElement.style.setProperty('--third-color', mid);
  document.documentElement.style.setProperty('--text-color', textColor);
  document.documentElement.style.setProperty('--text-font', textFont);
  document.documentElement.style.setProperty('--border-radius', `${settings.borderRadius}px`);
  document.documentElement.style.setProperty('--gradient-angle', `${settings.gradientAngle ?? 180}deg`);
  
  // Apply app gradient if enabled
  if (settings.gradientEnabled && settings.gradientColors && settings.gradientColors.length > 0) {
    const gradientStr = `linear-gradient(${settings.gradientAngle ?? 180}deg, ${settings.gradientColors.join(', ')})`;
    document.documentElement.style.setProperty('--app-gradient', gradientStr);
    document.documentElement.classList.add('gradient-enabled');
    document.body.classList.add('gradient-enabled');
  } else {
    document.documentElement.style.setProperty('--app-gradient', 'none');
    document.documentElement.classList.remove('gradient-enabled');
    document.body.classList.remove('gradient-enabled');
  }
}

const cachedTheme = JSON.parse(localStorage.getItem('launcherTheme') || '{}');
if (Object.keys(cachedTheme).length > 0) {
  applyTheme(cachedTheme);
}

ipcRenderer.invoke('get-settings').then(settings => {
  applyTheme(settings);
  localStorage.setItem('launcherTheme', JSON.stringify(settings));
});


players = [];
selectedPlayerId = null;
document.getElementById("min-btn").onclick = () => minApp();
document.getElementById("max-btn").onclick = () => maxApp();
document.getElementById("close-btn").onclick = () => closeApp();

document.getElementById("close-btn").addEventListener("click", () => {
  win.close();
});

function setSelectedPlayer(id) {ipcRenderer.send('set-selected-player', id)}
async function getSelectedPlayer() {return await ipcRenderer.invoke('get-selected-player')}

async function updateLoginIcon() {
  const newSelectedPlayerId = await getSelectedPlayer();
  selectedPlayerId = newSelectedPlayerId;

  const li = document.getElementById('players-login');
  if (!li) return;

  // Always re-render: this runs both before and after the players list loads,
  // and the player head must replace the login icon once players arrive.
  // (id can be a number or string depending on how it was created/edited.)
  const player = players.find(p => String(p.id) === String(selectedPlayerId));

  // Avoid pointless DOM churn if nothing changed.
  if (li.dataset.renderedFor === String(player ? player.id : 'none')) return;
  li.dataset.renderedFor = String(player ? player.id : 'none');

  li.innerHTML = '';

  if (player) {
    const username = player.type === 'microsoft' ? (player.auth?.name ?? 'MS Account') : (player.username ?? 'Offline');

    const img = document.createElement('img');
    // Offline accounts get the default skin, premium accounts their real one.
    img.src = player.type === 'microsoft'
      ? `https://minotar.net/helm/${encodeURIComponent(username)}/24`
      : 'https://minotar.net/helm/MHF_Steve/24';
    img.onerror = () => { img.src = 'https://tggamesyt.dev/assets/stevehead.png'; };
    img.style.width = '24px';
    img.style.height = '24px';
    img.style.borderRadius = '4px';
    img.href = "players.html";
    img.id = "playerIconSiderbar"
    li.appendChild(img);

    const span = document.createElement('span');
    span.textContent = username;
    span.id = "playerIconTextSidebar"
    li.appendChild(span);

  } else {
    const a = document.createElement('a');
    a.href = 'players.html';
    const icon = document.createElement('i');
    icon.className = 'material-icons';
    icon.textContent = 'login';
    a.appendChild(icon);
    li.appendChild(a);

    const span = document.createElement('span');
    span.textContent = 'Login';
    li.appendChild(span);
  }
}

function renderInstances(instances) {
  const ul = document.getElementById("instances");
  ul.innerHTML = ""; // clear placeholder items
  num = 0;

  // Add each instance
  instances.forEach(instance => {
    if (num < 3) {
      const li = document.createElement("li");

      // clickable icon + link
      const a = document.createElement("a");
      a.href = `instances.html?i=${instance.id}`;
      const img = document.createElement("img");
      img.src = instance.icon || "https://tggamesyt.dev/assets/redstone_launcher_defaulticon.png";
      img.alt = instance.name;
      img.style.width = "24px";
      a.appendChild(img);

      const span = document.createElement("span");
      span.textContent = instance.name;

      li.appendChild(a);
      li.appendChild(span);
      ul.appendChild(li);
      num++
    }
  });

  // "Add an instance" option
  const liAdd = document.createElement("li");
  const iAdd = document.createElement("i");
  iAdd.className = "material-icons";
  iAdd.textContent = "add";

  const spanAdd = document.createElement("span");
  spanAdd.textContent = "Add an instance";

  liAdd.appendChild(iAdd);
  liAdd.appendChild(spanAdd);
  liAdd.addEventListener("click", () => {
    window.location.href = "instances.html?i=NEWINSTANCE";
  });
  ul.appendChild(liAdd);
}

// Provider logos (Modrinth / CurseForge) as inline SVGs so they take the
// current text colour. Exposed globally for the mod browser toggle too.
window.PROVIDER_SVG = {
  modrinth: '<svg viewBox="0 0 24 24" fill="currentColor" width="100%" height="100%"><path d="M12.252.004a11.78 11.768 0 0 0-8.92 3.73 11 10.999 0 0 0-2.17 3.11 11.37 11.359 0 0 0-1.16 5.169c0 1.42.17 2.5.6 3.77.24.759.77 1.899 1.17 2.529a12.3 12.298 0 0 0 8.85 5.639c.44.05 2.54.07 2.76.02.2-.04.22.1-.26-1.7l-.36-1.37-1.01-.06a8.5 8.489 0 0 1-5.18-1.8 5.34 5.34 0 0 1-1.3-1.26c0-.05.34-.28.74-.5a37.572 37.545 0 0 1 2.88-1.629c.03 0 .5.45 1.06.98l1 .97 2.07-.43 2.06-.43 1.47-1.47c.8-.8 1.48-1.5 1.48-1.52 0-.09-.42-1.63-.46-1.7-.04-.06-.2-.03-1.02.18-.53.13-1.2.3-1.45.4l-.48.15-.53.53-.53.53-.93.1-.93.07-.52-.5a2.7 2.7 0 0 1-.96-1.7l-.13-.6.43-.57c.68-.9.68-.9 1.46-1.1.4-.1.65-.2.83-.33.13-.099.65-.579 1.14-1.069l.9-.9-.7-.7-.7-.7-1.95.54c-1.07.3-1.96.53-1.97.53-.03 0-2.23 2.48-2.63 2.97l-.29.35.28 1.03c.16.56.3 1.16.31 1.34l.03.3-.34.23c-.37.23-2.22 1.3-2.84 1.63-.36.2-.37.2-.44.1-.08-.1-.23-.6-.32-1.03-.18-.86-.17-2.75.02-3.73a8.84 8.839 0 0 1 7.9-6.93c.43-.03.77-.08.78-.1.06-.17.5-2.999.47-3.039-.01-.02-.1-.02-.2-.03Zm3.68.67c-.2 0-.3.1-.37.38-.06.23-.46 2.42-.46 2.52 0 .04.1.11.22.16a8.51 8.499 0 0 1 2.99 2 8.38 8.379 0 0 1 2.16 3.449 6.9 6.9 0 0 1 .4 2.8c0 1.07 0 1.27-.1 1.73a9.37 9.369 0 0 1-1.76 3.769c-.32.4-.98 1.06-1.37 1.38-.38.32-1.54 1.1-1.7 1.14-.1.03-.1.06-.07.26.03.18.64 2.56.7 2.78l.06.06a12.07 12.058 0 0 0 7.27-9.4c.13-.77.13-2.58 0-3.4a11.96 11.948 0 0 0-5.73-8.578c-.7-.42-2.05-1.06-2.25-1.06Z"/></svg>',
  curseforge: '<svg viewBox="0 0 24 24" fill="currentColor" width="100%" height="100%"><path d="M18.326 9.2145S23.2261 8.4418 24 6.1882h-7.5066V4.4H0l2.0318 2.3576V9.173s5.1267-.2665 7.1098 1.2372c2.7146 2.516-3.053 5.917-3.053 5.917L5.0995 19.6c1.5465-1.4726 4.494-3.3775 9.8983-3.2857-2.0565.65-4.1245 1.6651-5.7344 3.2857h10.9248l-1.0288-3.2726s-7.918-4.6688-.8336-7.1127z"/></svg>'
};

// The sidebar's mod-browser entry shows the currently-selected provider's logo
// and updates everywhere the provider is switched.
function applyModProviderIcon() {
  const provider = localStorage.getItem('modProvider') === 'curseforge' ? 'curseforge' : 'modrinth';
  const svg = (window.PROVIDER_SVG && window.PROVIDER_SVG[provider]) || '';
  document.querySelectorAll('.sidebar a.modrinth > li').forEach(li => {
    li.innerHTML = `<span class="provider-icon">${svg}</span><span>Mod Browser</span>`;
  });
}
applyModProviderIcon();

// Ask backend for profiles/instances
function updateSideBar() {
  updateLoginIcon()
  ipcRenderer.send("get-profiles");
  ipcRenderer.on("profiles-list", (event, profiles) => {
    renderInstances(profiles);
  });
}

function closeApp() {ipcRenderer.send("close-app")}
function minApp() {ipcRenderer.send("min-app")}
function maxApp() {
  ipcRenderer.send("max-app");
}

function updateMaxIcon(isMaximized) {
  if (isMaximized) {
    document.getElementById("max-btn").innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#e3e3e3"><path d="M631.19-164.04q5.19 0 8.75-3.46 3.56-3.46 3.56-8.85v-339.84q0-5.39-3.56-8.85t-8.75-3.46H176.35q-5.39 0-8.85 3.46t-3.46 8.85v339.84q0 5.39 3.46 8.85t8.85 3.46h454.84Zm68.27-211.5v-55.96h84.19q5.39 0 8.85-3.46t3.46-8.85v-339.84q0-5.39-3.46-8.85t-8.85-3.46H329q-5.38 0-8.85 3.46-3.46 3.46-3.46 8.85v199.19h-55.96v-199.19q0-28.44 19.82-48.36 19.81-19.91 48.45-19.91h454.65q28.44 0 48.36 19.91 19.91 19.92 19.91 48.36v339.84q0 28.44-19.91 48.35-19.92 19.92-48.36 19.92h-84.19Zm-523.2 267.46q-28.35 0-48.27-19.91-19.91-19.92-19.91-48.36v-339.84q0-28.44 19.91-48.35 19.92-19.92 48.29-19.92h456.37q27.53 0 47.17 19.51t19.64 46.91v341.77q0 28.36-19.92 48.28-19.91 19.91-48.26 19.91H176.26Zm380.32-579.15ZM403.92-346.27Z"/></svg>`;
  } else {
    document.getElementById("max-btn").textContent = "◻";
  }
}

// Listen for maximize/unmaximize events from main
ipcRenderer.on("window-maximized", () => updateMaxIcon(true));
ipcRenderer.on("window-unmaximized", () => updateMaxIcon(false));

// Global launch progress indicator, shown in the top-right toolbar on every
// page while an instance is downloading/preparing.
(function setupToolbarProgress() {
  const container = document.getElementById('instance-processes');
  if (!container) return;
  let bar = null, label = null, fill = null, hideTimer = null;
  function ensureBar() {
    if (bar) return;
    bar = document.createElement('div');
    bar.className = 'toolbar-progress';
    bar.innerHTML = '<span class="tp-label"></span><span class="tp-track"><span class="tp-fill"></span></span>';
    label = bar.querySelector('.tp-label');
    fill = bar.querySelector('.tp-fill');
    container.appendChild(bar);
  }
  ipcRenderer.on('launch-progress', (e, data) => {
    if (!data) return;
    if (data.done) {
      if (bar) {
        label.textContent = data.label || 'Ready';
        fill.style.width = '100%';
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => { if (bar) { bar.remove(); bar = null; } }, 1500);
      }
      return;
    }
    ensureBar();
    clearTimeout(hideTimer);
    const pct = data.total ? Math.min(100, Math.round((data.current / data.total) * 100)) : null;
    fill.style.width = pct === null ? '100%' : pct + '%';
    let text = data.label || 'Loading';
    if (pct !== null && !data.bytes) text += ` ${data.current}/${data.total}`;
    else if (pct !== null) text += ` ${pct}%`;
    label.textContent = text;
  });
})();

  ipcRenderer.send("get-players");
  ipcRenderer.on("players-list", (event, newPlayers) => { players = newPlayers; updateLoginIcon(); });
  ipcRenderer.on("players-updated", (event, newPlayers) => { players = newPlayers; updateLoginIcon(); });


  document.addEventListener("DOMContentLoaded", async () => {
    const updateEl = document.getElementById("update");
    const updateText = document.getElementById("updateText");
  
    if (!updateEl || !updateText) return;
  
    // Ask backend if update exists
    const result = await ipcRenderer.invoke("check-for-updates");

    // No update → keep hidden
    if (!result || !result.updateAvailable) {
      return;
    }

    updateEl.classList.add("show-update");

    // If autoUpdates is on, the main process quietly downloads ("stages") the
    // update in the background and installs it on the NEXT launch — we never
    // interrupt the current session. Reflect that state to the user.
    const pending = await ipcRenderer.invoke("get-pending-update");
    const staged = pending && pending.version === result.version;

    if (staged) {
      updateText.textContent = `Update ${result.version} ready — restart to apply`;
      updateEl.onclick = async () => {
        updateText.textContent = "Installing...";
        const res = await ipcRenderer.invoke("apply-staged-update");
        if (!res.success) {
          updateText.textContent = "Update failed!";
          console.error(res.error);
        }
      };
    } else {
      // Not staged yet (autoUpdates off, or still downloading). Offer a manual
      // "install now" that downloads and installs immediately.
      updateText.textContent = `Update to ${result.version}`;
      updateEl.onclick = async () => {
        updateText.textContent = "Downloading...";
        const res = await ipcRenderer.invoke(
          "download-and-install",
          result.assetURL,
          result.assetName
        );
        if (!res.success) {
          updateText.textContent = "Update failed!";
          console.error(res.error);
          updateEl.style.pointerEvents = "auto";
          return;
        }
        updateText.textContent = "Installing...";
      };
    }
  });
  

updateSideBar()

const currentFile = "frontend/" + window.location.pathname.split(/[/\\]/).pop();

// Track visible .page elements, or the whole HTML if no pages
const pages = document.querySelectorAll('.page');

if (pages.length === 0) {
  // No sub-pages; track the whole HTML as one page
  ipcRenderer.send('track-page', { file: currentFile, pageId: null });
} else {
  // MutationObserver tracks .page visibility
  let historySent = false;

  const observer = new MutationObserver(mutations => {
    mutations.forEach(m => {
      if (m.attributeName === 'style') {
        const el = m.target;
        const display = window.getComputedStyle(el).display;
        if (display !== 'none') {
          ipcRenderer.send('track-page', { file: currentFile, pageId: el.id });
        }
      }
    });
  });

  pages.forEach(p => observer.observe(p, { attributes: true, attributeFilter: ['style'] }));
}

// Listen for main telling us to show a page
ipcRenderer.on('show-page', (event, pageId) => {
  if (!pageId) return; // nothing to do, whole HTML is shown
  pages.forEach(p => p.style.display = p.id === pageId ? 'flex' : 'none');
});

document.getElementById('backBtn').addEventListener('click', () => {
  ipcRenderer.send('go-back');
});

document.getElementById('forwardBtn').addEventListener('click', () => {
  ipcRenderer.send('go-forward');
});

ipcRenderer.on("devtools-log", (event, text) => {
  console.log(text);
});
ipcRenderer.on("alert-message", (event, message) => {
  alert(message);
});

// Instance process list bar
async function createInstanceInfoBar(container) {
    const wrapper = document.createElement("div");
    wrapper.style.display = "flex";
    wrapper.style.alignItems = "center";
    wrapper.style.gap = "10px";
    wrapper.style.padding = "0px";
    wrapper.style.background = "none";
    wrapper.style.borderRadius = "var(--border-radius)";
    container.appendChild(wrapper);

    const stopBtn = document.createElement("button");
    stopBtn.textContent = "◻";
    Object.assign(stopBtn.style, {
        padding: "10px",
        border: "none",
        borderRadius: "var(--border-radius)",
        background: "rgba(255, 0, 0, 0.6)",
        color: "var(--text-color)",
        cursor: "pointer",
        transition: "background 0.2s",
        display: "none",
    });
    stopBtn.onmouseover = () => (stopBtn.style.background = "rgba(255, 0, 0, 0.8)");
    stopBtn.onmouseout = () => (stopBtn.style.background = "rgba(255, 0, 0, 0.6)");
    wrapper.appendChild(stopBtn);

    let previousInstances = null;
    let currentStopHandler = null;

    function areInstancesEqual(a, b) {
        if (!Array.isArray(a) || !Array.isArray(b)) return false;
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (a[i].id !== b[i].id || a[i].pid !== b[i].pid) return false;
        }
        return true;
    }

    async function refreshInstances() {
        const instances = await ipcRenderer.invoke("get-running-instances");
        if (previousInstances !== null && areInstancesEqual(instances, previousInstances)) return;
        previousInstances = Array.isArray(instances) ? instances.slice() : [];

        // Clear previous instance elements
        wrapper.querySelectorAll(".instance-element").forEach(el => el.remove());

        // Reset stop button visibility and handler
        stopBtn.style.display = "none";
        if (currentStopHandler) {
            stopBtn.removeEventListener("click", currentStopHandler);
            currentStopHandler = null;
        }

        if (!instances || instances.length === 0) {
            const label = document.createElement("span");
            label.textContent = "No running instances";
            label.className = "instance-element";
            label.style.color = "var(--text-color)";
            label.style.opacity = "0.8";
            Object.assign(label.style, {
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                flexShrink: "0",
            });
            wrapper.insertBefore(label, stopBtn);
            return;
        }

        stopBtn.style.display = "inline-block";

        // Count how many processes per ID
        const countPerId = {};
        for (const inst of instances) {
            countPerId[inst.id] = (countPerId[inst.id] || 0) + 1;
        }

        const multipleProcesses =
            instances.length > 1 || Object.values(countPerId).some(c => c > 1);

        if (!multipleProcesses) {
            // Single instance display
            const inst = instances[0];
            const profile = await ipcRenderer.invoke("get-profile-by-id", inst.id);
            const label = document.createElement("span");
            label.className = "instance-element";
            label.textContent = profile?.name || inst.id;
            label.style.color = "var(--text-color)";
            label.style.cursor = "pointer";
            Object.assign(label.style, {
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                flexShrink: "0",
            });
            label.onclick = () =>
                (window.location.href = `instances.html?i=${encodeURIComponent(inst.id)}`);
            wrapper.insertBefore(label, stopBtn);

            // Stop button handler for single instance
            currentStopHandler = async () => {
                await ipcRenderer.invoke("stop-instance-by-pid", inst.pid);
                await refreshInstances();
            };
            stopBtn.addEventListener("click", currentStopHandler);
        } else {
            // Multiple instances — dropdown
            const select = document.createElement("select");
            select.className = "instance-element";
            // Base style
            Object.assign(select.style, {
                marginTop: "15px",
                display: "flex",
                appearance: "none",
                background: "var(--toolbar-bg)",
                border: "none",
                color: "var(--text-color)",
                cursor: "pointer",
                font: "inherit",
                padding: "0px 24px 0px 0px",
                width: "auto",
                minWidth: "unset",
                boxShadow: "none",
                transition: "background 0.2s, color 0.2s",
            });

            function setArrow(down = true) {
                select.style.backgroundImage = down
                    ? "url('data:image/svg+xml;utf8,<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"10\" height=\"6\"><path fill=\"white\" d=\"M0 0l5 6 5-6z\"/></svg>')"
                    : "url('data:image/svg+xml;utf8,<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"10\" height=\"6\"><path fill=\"white\" d=\"M0 6l5-6 5 6z\"/></svg>')";
            }

            setArrow(true);

            // Arrow
            select.style.backgroundImage =
                "url('data:image/svg+xml;utf8,<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"10\" height=\"6\"><path fill=\"white\" d=\"M0 0l5 6 5-6z\"/></svg>')";
            select.style.backgroundRepeat = "no-repeat";
            select.style.backgroundPosition = "right 6px center";
            select.style.backgroundSize = "10px 6px";
            for (const inst of instances) {
                const profile = await ipcRenderer.invoke("get-profile-by-id", inst.id);
                const showPid = countPerId[inst.id] > 1;
                const opt = document.createElement("option");
                opt.value = `${inst.id}-${inst.pid}`;
                opt.textContent =
                    profile?.name
                        ? `${profile.name}${showPid ? ` (${inst.pid})` : ""}`
                        : `${inst.id}${showPid ? ` (${inst.pid})` : ""}`;
                select.appendChild(opt);
            }
            wrapper.insertBefore(select, stopBtn);
            let dropdownOpen = false;
            select.addEventListener("mousedown", e => {
            const rect = select.getBoundingClientRect();

            // If clicked in text area (not arrow), open instance page instead
            if (e.clientX < rect.right - 20) {
                e.preventDefault();
                const selectedVal = select.value;
                if (selectedVal) {
                    const [id] = selectedVal.split("-");
                    window.location.href = `instances.html?i=${encodeURIComponent(id)}`;
                }
                return;
            }

            // Otherwise toggle arrow state
            dropdownOpen = !dropdownOpen;
            setArrow(!dropdownOpen);
            });

            // Reset arrow when focus leaves dropdown
            select.addEventListener("blur", () => {
                dropdownOpen = false;
                setArrow(true);
            });
            // Stop handler for dropdown
            currentStopHandler = async () => {
                const selectedVal = select.value;
                if (!selectedVal) return;
                const [, pidStr] = selectedVal.split("-");
                const pid = parseInt(pidStr, 10);
                if (!Number.isFinite(pid)) return;
                await ipcRenderer.invoke("stop-instance-by-pid", pid);
                await refreshInstances();
            };
            stopBtn.addEventListener("click", currentStopHandler);
        }
    }

    // Initial + periodic updates
    await refreshInstances();
    setInterval(refreshInstances, 3000);
}

async function allowCracked(newValue, password) {
  const res = await ipcRenderer.invoke('update-allow-cracked-testing', { value: !!newValue, password });
  if (res && res.success) {
    console.log('Updated! new value: ' + res.value);
  } else {
    console.log('Failed to update: ' + (res?.error || 'Unknown error'));
  }
}

const title = document.querySelector('div.drag-region'); // only matches <div class="drag-region">

if (title && Math.random() < 0.1) {
  title.style.cursor = 'help';
  title.onclick = () => {
    shell.openExternal("https://youtu.be/XOq97dxiAfE");
  };
}
let settings;
let third;
async () => {
  settings = await ipcRenderer.invoke('get-settings')
  third = getSetting('thirdColor') || getMiddleColor(base, secondary);
};

function getSetting(key) {
  return settings[key] ?? defaultSettings[key];
}

createInstanceInfoBar(document.getElementById("instance-processes"));
