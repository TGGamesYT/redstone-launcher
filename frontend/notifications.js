class NotificationPopup {
  constructor() {
    this.createStyles();
  }

  createStyles() {
    if (document.getElementById('notification-popup-styles')) return;
    
    const style = document.createElement('style');
    style.id = 'notification-popup-styles';
    style.textContent = `
      .notification-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.7);
        display: flex;
        justify-content: center;
        align-items: center;
        z-index: 10000;
      }

      .notification-modal {
        background: var(--secondary-color);
        border: 2px solid var(--base-color);
        border-radius: var(--border-radius);
        padding: 30px;
        max-width: 500px;
        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
        animation: slideIn 0.3s ease;
      }

      @keyframes slideIn {
        from {
          transform: translateY(-20px);
          opacity: 0;
        }
        to {
          transform: translateY(0);
          opacity: 1;
        }
      }

      .notification-modal h2 {
        margin: 0 0 15px 0;
        color: var(--base-color);
        font-size: 1.5em;
      }

      .notification-modal p {
        margin: 10px 0;
        color: var(--text-color);
        line-height: 1.5;
      }

      .notification-buttons {
        display: flex;
        gap: 10px;
        margin-top: 25px;
        justify-content: flex-end;
      }

      .notification-buttons button {
        padding: 10px 20px;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-weight: bold;
        font-family: inherit;
        transition: all 0.2s;
      }

      .notification-btn-ok {
        background: var(--base-color);
        color: var(--text-color);
      }

      .notification-btn-ok:hover {
        background: var(--third-color);
        transform: translateY(-2px);
      }

      .notification-btn-info {
        background: var(--third-color);
        color: var(--text-color);
      }

      .notification-btn-info:hover {
        background: var(--base-color);
        transform: translateY(-2px);
      }

      .unread-badge {
        position: absolute;
        top: 5px;
        right: 5px;
        background: var(--base-color);
        color: var(--text-color);
        border-radius: 50%;
        width: 24px;
        height: 24px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 0.9em;
        font-weight: bold;
      }
    `;
    document.head.appendChild(style);
  }

  show(notification) {
    const overlay = document.createElement('div');
    overlay.className = 'notification-overlay';

    const modal = document.createElement('div');
    modal.className = 'notification-modal';

    const title = document.createElement('h2');
    title.textContent = notification.title;

    const message = document.createElement('p');
    message.textContent = notification.message;

    const buttonsDiv = document.createElement('div');
    buttonsDiv.className = 'notification-buttons';

    const okBtn = document.createElement('button');
    okBtn.className = 'notification-btn-ok';
    okBtn.textContent = 'OK';
    okBtn.onclick = () => {
      ipcRenderer.send('dismiss-notification', notification.id);
      overlay.remove();
    };

    buttonsDiv.appendChild(okBtn);

    if (notification.moreInfoUrl) {
      const infoBtn = document.createElement('button');
      infoBtn.className = 'notification-btn-info';
      infoBtn.textContent = 'More Info';
      infoBtn.onclick = () => {
        const { shell } = require('electron');
        shell.openExternal(notification.moreInfoUrl);
      };
      buttonsDiv.appendChild(infoBtn);
    }

    modal.appendChild(title);
    modal.appendChild(message);
    modal.appendChild(buttonsDiv);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }

  showBadge(count, element) {
    const existing = element.querySelector('.unread-badge');
    if (existing) existing.remove();

    if (count > 0) {
      const badge = document.createElement('div');
      badge.className = 'unread-badge';
      badge.textContent = count > 99 ? '99+' : count;
      element.style.position = 'relative';
      element.appendChild(badge);
    }
  }
}

const notificationPopup = new NotificationPopup();

async function checkAndShowNotifications() {
  const unread = await ipcRenderer.invoke('get-unread-notifications');
  
  unread.forEach((notif, index) => {
    setTimeout(() => {
      notificationPopup.show(notif);
    }, index * 500);
  });

  updateUnreadBadge();
}

async function updateUnreadBadge() {
  const unread = await ipcRenderer.invoke('get-unread-notifications');
  const updateButton = document.getElementById('update');
  
  if (updateButton && unread.length > 0) {
    notificationPopup.showBadge(unread.length, updateButton);
  }
}

ipcRenderer.on('notification-dismissed', () => {
  updateUnreadBadge();
});

window.addEventListener('DOMContentLoaded', () => {
  checkAndShowNotifications();
});
