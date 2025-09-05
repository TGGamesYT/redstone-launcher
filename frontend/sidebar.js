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
    li.appendChild(img);

    const span = document.createElement('span');
    span.textContent = username;
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

  // Add each instance
  instances.forEach(instance => {
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
function maxApp() {ipcRenderer.send("max-app")}

  ipcRenderer.send("get-players");
  ipcRenderer.on("players-list", (event, newPlayers) => { players = newPlayers; updateLoginIcon(); });
  ipcRenderer.on("players-updated", (event, newPlayers) => { players = newPlayers; updateLoginIcon(); });

updateSideBar()