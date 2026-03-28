document.getElementById('showCredits').addEventListener('click', () => {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.8);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10000;
        backdrop-filter: blur(4px);
    `;

    const modal = document.createElement('div');
    modal.style.cssText = `
        background: var(--menu-bg, #004400);
        border: 3px solid var(--border-dark, #ffff00);
        padding: 30px;
        max-width: 400px;
        width: 90%;
        text-align: center;
        box-shadow: 8px 8px 0 rgba(0,0,0,0.5);
        font-family: var(--text-font, 'Comic Sans MS', cursive);
        color: var(--text-color, #ffffff);
    `;

    modal.innerHTML = `
        <h2 style="color: var(--secondary-color, #00ff00); margin-top: 0;">Credits</h2>
        <div style="margin: 20px 0; line-height: 1.6;">
            <p><strong>Lead Developer</strong><br>Muaves</p>
            <p><strong>UI Design</strong><br>Redstone Team</p>
            <p><strong>Special thanks to </strong><br><a href="https://discord.com/users/1101951825353125948" target="_blank">The Blue Panda</a> for making the logo</p>
            <p><strong>April Fools music download: </strong><br><a href="https://github.com/Muaves/uploadzoo/raw/refs/heads/main/April_Fools.mp3" target="_blank">Click here for download!</a></p>
        </div>
        <button id="closeCredits" style="
            background: var(--third-color, #006600);
            border: 2px solid var(--secondary-color, #00ff00);
            color: var(--text-color, #ffff00);
            padding: 8px 20px;
            cursor: pointer;
            text-transform: uppercase;
        ">Close</button>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    document.getElementById('closeCredits').onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
});
