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
}

// Example after loading settings
ipcRenderer.invoke('get-settings').then(settings => {
  applyTheme(settings);
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
  selectedPlayerId = await getSelectedPlayer()
  const li = document.getElementById('players-login');
  li.innerHTML = ''; // clear existing content

  const player = players.find(p => p.id === selectedPlayerId);

  if (player) {
    const username = player.type === 'microsoft' ? (player.auth?.name ?? 'MS Account') : (player.username ?? 'Cracked');

    const img = document.createElement('img');
    img.src = `https://minotar.net/helm/${encodeURIComponent(username)}/24`;
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
    // fallback: show login icon and text
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

  ipcRenderer.send("get-players");
  ipcRenderer.on("players-list", (event, newPlayers) => { players = newPlayers; updateLoginIcon(); });
  ipcRenderer.on("players-updated", (event, newPlayers) => { players = newPlayers; updateLoginIcon(); });


  document.addEventListener("DOMContentLoaded", async () => {
  const updateEl = document.getElementById("update");
  const updateText = document.getElementById("updateText");
  if (!updateEl) return;

  // Ask backend if update exists
  const result = await ipcRenderer.invoke("check-for-updates");

  if (!result.updateAvailable) {
    updateEl.style.display = "none";
    return;
  }

  // Show button
  updateEl.style.display = "block";
  updateText.innerText = `Update to ${result.latest}`;

  updateEl.onclick = async () => {
    updateText.innerText = "Updating...";
    const res = await ipcRenderer.invoke("download-and-install", result.url, result.latest);
    if (!res.success) {
      updateEl.updateText = "Update failed!";
      console.error(res.error);
    }
  };
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

// ------------------ NEWS ------------------
async function loadNews() {
  try {
    const res = await fetch('https://redstone-launcher.com/news.json');
    const newsObj = await res.json();
    const newsArr = Object.values(newsObj).filter(n => new Date(n.showuntil) >= new Date());
    let idx = 0;
    let autoSwitch = true;
    let autoTimer;

    const newsContent = document.getElementById('news-content');
    const newsDots = document.getElementById('news-dots');

    // Create dots
    newsDots.innerHTML = "";
    newsArr.forEach((_, i) => {
      const dot = document.createElement('div');
      dot.classList.add('news-dot');
      if (i === 0) dot.classList.add('active');
      dot.onclick = () => {
        idx = i;
        showNews();
        pauseAutoAdvance();
      };
      newsDots.appendChild(dot);
    });

    function showNews() {
  if (newsArr.length === 0) return;
  const news = newsArr[idx];

  // Add flip animation
  newsContent.classList.add('news-flip');

  setTimeout(() => {
    newsContent.innerHTML = `
      <img src="${news.img}" />
      <h3>${news.title}</h3>
      <p>${news.summary}</p>
    `;
    newsContent.classList.remove('news-flip');
  }, 300); // half of transition duration for smooth effect

  // Update dots
  document.querySelectorAll('.news-dot').forEach((d, j) => {
    d.classList.toggle('active', j === idx);
  });
}

    function nextNews() {
      idx = (idx + 1) % newsArr.length;
      showNews();
    }

    function startAutoAdvance() {
      autoSwitch = true;
      clearInterval(autoTimer);
      autoTimer = setInterval(() => {
        if (autoSwitch) nextNews();
      }, 10000);
    }

    function pauseAutoAdvance() {
      autoSwitch = false;
      clearInterval(autoTimer);
      // Resume after 30 seconds
      setTimeout(() => startAutoAdvance(), 30000);
    }

    showNews();
    startAutoAdvance();

    // Allow mouse scroll to switch manually
    newsContent.addEventListener('wheel', (e) => {
      e.preventDefault();
      pauseAutoAdvance();
      if (e.deltaY > 0) nextNews();
      else {
        idx = (idx - 1 + newsArr.length) % newsArr.length;
        showNews();
      }
    });

    // Clicking on news -> modal or external link
    document.getElementById('news').onclick = () => {
      const news = newsArr[idx]; // use current index
      if (news.redirects) {
        shell.openExternal(news.redirectUrl);
      } else {
        // Show modal instead of new window
        const modal = document.getElementById('news-modal');
        const body = document.getElementById('news-modal-body');
        body.innerHTML = `<h2>${news.title}</h2>${news.description}`;
        modal.style.display = 'flex';
      }
    };


    // Close modal handler
    document.getElementById('news-modal-close').onclick = () => {
      document.getElementById('news-modal').style.display = 'none';
    };

    // Close when clicking outside the content
    window.onclick = (e) => {
      const modal = document.getElementById('news-modal');
      if (e.target === modal) modal.style.display = 'none';
    };
  } catch (e) {
    console.error('Failed to load news', e);
  }
}

loadNews();

// ------------------ PROJECT OF THE WEEK ------------------
async function loadPotW() {
  try {
    const res = await fetch('https://redstone-launcher.com/PotW.json');
    const potwObj = await res.json();
    const [title, url] = Object.entries(potwObj)[0];
    const projectName = url.split('/').pop();
    const modRes = await fetch(`https://api.modrinth.com/v2/project/${projectName}`);
    const modObj = await modRes.json();
    const icon = modObj.icon_url || "https://tggamesyt.dev/assets/redstone_launcher_defaulticon.png";

    document.getElementById('potw-icon').src = icon;
    document.getElementById('potw-title').textContent = projectName;
    document.getElementById('potw').onclick = () => shell.openExternal(url);
  } catch(e) { console.error('Failed to load PotW', e); }
}
loadPotW();


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

createInstanceInfoBar(document.getElementById("instance-processes"));
