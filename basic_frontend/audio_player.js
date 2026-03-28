const AUDIO_SRC = 'April_Fools.mp3';
const DELAY_MS = 15000;

const launcherAudio = new Audio(AUDIO_SRC);
launcherAudio.loop = true;
launcherAudio.volume = localStorage.getItem('rs_volume') || 0.5;

const playerHTML = `
<div id="rs-player" style="position:fixed; bottom:20px; right:20px; width:150px; background:#222; border:2px solid #ffff00; color:white; padding:10px; cursor:move; z-index:9999; font-family:monospace; text-align:center; display:none; user-select:none;">
    <div style="font-weight:bold; color:#ffffff; margin-bottom:5px;">APRIL FOOLS</div>
    <span id="rs-status">Waiting...</span>
    <div style="margin-top:8px; display:flex; flex-direction:column; gap:5px;">
        <input type="range" id="rs-volume" min="0" max="1" step="0.01" value="${launcherAudio.volume}" style="width:100%;">
        <button id="rs-toggle" style="background:#444; border:1px solid #ffff00; color:white; cursor:pointer;">STOP</button>
    </div>
</div>`;

document.body.insertAdjacentHTML('beforeend', playerHTML);

const rsPlayer = document.getElementById('rs-player');
const rsStatus = document.getElementById('rs-status');
const rsToggle = document.getElementById('rs-toggle');
const rsVolume = document.getElementById('rs-volume');

let volTimeout;

function initPlayer() {
    const startTime = localStorage.getItem('rs_start_time');
    const now = Date.now();

    if (!startTime) {
        localStorage.setItem('rs_start_time', now);
        setTimeout(() => {
            localStorage.setItem('rs_active', 'true');
            showAndPlay(true);
        }, DELAY_MS);
    } else {
        const elapsed = now - parseInt(startTime);
        if (localStorage.getItem('rs_active') === 'true' || elapsed >= DELAY_MS) {
            localStorage.setItem('rs_active', 'true');
            showAndPlay(false);
        } else {
            setTimeout(() => {
                localStorage.setItem('rs_active', 'true');
                showAndPlay(true);
            }, DELAY_MS - elapsed);
        }
    }
}

function showAndPlay(fromStart) {
    rsPlayer.style.display = 'block';
    
    if (fromStart) {
        launcherAudio.currentTime = 0;
    } else {
        launcherAudio.currentTime = parseFloat(localStorage.getItem('rs_time') || 0);
    }
    
    launcherAudio.play().catch(() => {
        const autoPlayOnInteract = () => {
            launcherAudio.play();
            document.removeEventListener('click', autoPlayOnInteract);
        };
        document.addEventListener('click', autoPlayOnInteract);
    });
}

rsVolume.oninput = (e) => {
    launcherAudio.volume = e.target.value;
    localStorage.setItem('rs_volume', e.target.value);
    
    clearTimeout(volTimeout);
    volTimeout = setTimeout(() => {
        launcherAudio.volume = 0.5;
        rsVolume.value = 0.5;
        localStorage.setItem('rs_volume', 0.5);
    }, 2000);
};

rsToggle.onclick = () => {
    if (launcherAudio.paused) {
        launcherAudio.play();
    } else {
        launcherAudio.pause();
    }
};

launcherAudio.onplay = () => { rsStatus.innerText = "▶ PLAYING"; rsToggle.innerText = "STOP"; };
launcherAudio.onpause = () => { rsStatus.innerText = "⏸ PAUSED"; rsToggle.innerText = "PLAY"; };

setInterval(() => {
    if (!launcherAudio.paused) {
        localStorage.setItem('rs_time', launcherAudio.currentTime);
    }
}, 500);

let active = false, iX, iY;
rsPlayer.onmousedown = (e) => {
    if (e.target === rsVolume || e.target === rsToggle) return;
    active = true;
    iX = e.clientX - rsPlayer.offsetLeft;
    iY = e.clientY - rsPlayer.offsetTop;
};

document.onmousemove = (e) => {
    if (active) {
        rsPlayer.style.left = (e.clientX - iX) + "px";
        rsPlayer.style.top = (e.clientY - iY) + "px";
        rsPlayer.style.bottom = "auto";
        rsPlayer.style.right = "auto";
    }
};

document.onmouseup = () => active = false;

initPlayer();
