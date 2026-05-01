
class LauncherPolish {
  constructor() {
    this.debounceTimers = new Map();
    this.initialize();
  }

  initialize() {
    
    this.applySmoothTransitions();
    
    
    this.optimizeScrolling();
    
    
    this.setupKeyboardShortcuts();
    
    
    this.optimizeAnimations();
    
    
    this.optimizeDOM();
    
    
    this.cacheDOMElements();
    
    console.log('✓ Launcher polish applied');
  }

  applySmoothTransitions() {
    
    document.body.style.opacity = '0';
    setTimeout(() => {
      document.body.style.transition = 'opacity 0.3s ease-out';
      document.body.style.opacity = '1';
    }, 50);
  }

  optimizeScrolling() {
    
    const passiveSupported = () => {
      let passiveSupported = false;
      try {
        const options = { get passive() { passiveSupported = true; return false; } };
        window.addEventListener('test', null, options);
        window.removeEventListener('test', null, options);
      } catch (err) { passiveSupported = false; }
      return passiveSupported;
    };

    if (passiveSupported()) {
      document.addEventListener('wheel', () => {}, { passive: true });
      document.addEventListener('touchmove', () => {}, { passive: true });
    }
  }

  setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      
      if (e.ctrlKey && e.key === '1' && !e.altKey) {
        window.location.href = 'index.html';
      }
      
      if (e.ctrlKey && e.key === '2' && !e.altKey) {
        window.location.href = 'instances.html';
      }
      
      if (e.ctrlKey && e.key === ',') {
        window.location.href = 'settings.html';
      }
      
      if ((e.key === 'F5' || (e.ctrlKey && e.key === 'r')) && !e.shiftKey) {
        e.preventDefault();
        
        if (typeof ipcRenderer !== 'undefined') {
          ipcRenderer.send('get-profiles');
        }
      }
    });
  }

  optimizeAnimations() {
    
    let animationId;
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
        }
      });
    }, { rootMargin: '50px' });

    
    document.querySelectorAll('[data-animate]').forEach(el => {
      observer.observe(el);
    });
  }

  optimizeDOM() {
    
    this.batchDOMUpdates = (updates) => {
      const fragment = document.createDocumentFragment();
      updates.forEach(update => fragment.appendChild(update));
      return fragment;
    };

    
    document.querySelectorAll('.profile-item, .instance-card-enhanced').forEach(el => {
      el.style.willChange = 'transform';
    });

    
    document.addEventListener('animationend', (e) => {
      e.target.style.willChange = 'auto';
    });
  }

  cacheDOMElements() {
    this.cachedElements = {
      toolbar: document.getElementById('toolbar'),
      sidebar: document.querySelector('.sidebar'),
      content: document.getElementById('content'),
      main: document.getElementById('main'),
    };
  }

  
  debounce(key, fn, delay = 300) {
    if (this.debounceTimers.has(key)) {
      clearTimeout(this.debounceTimers.get(key));
    }
    const timer = setTimeout(fn, delay);
    this.debounceTimers.set(key, timer);
  }

  
  throttle(fn, delay = 300) {
    let lastCall = 0;
    return function (...args) {
      const now = Date.now();
      if (now - lastCall >= delay) {
        lastCall = now;
        return fn(...args);
      }
    };
  }

  
  toast(message, type = 'info', duration = 3000) {
    const toast = document.createElement('div');
    toast.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: ${type === 'error' ? '#ef4444' : type === 'success' ? '#10b981' : '#3b82f6'};
      color: white;
      padding: 12px 16px;
      border-radius: 8px;
      z-index: 10000;
      animation: slideUp 0.3s ease-out;
      font-weight: 500;
      font-size: 14px;
      box-shadow: 0 8px 16px rgba(0, 0, 0, 0.3);
    `;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.animation = 'slideDown 0.3s ease-out';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  
  confirm(message, title = 'Confirm') {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.style.cssText = `
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.7);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10001;
        animation: fadeInOverlay 0.2s ease-out;
      `;

      const dialog = document.createElement('div');
      dialog.style.cssText = `
        background: var(--base-color, #b30c0c);
        padding: 20px;
        border-radius: 12px;
        min-width: 300px;
        animation: slideInModal 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
      `;

      dialog.innerHTML = `
        <h3 style="margin: 0 0 12px; font-size: 18px;">${title}</h3>
        <p style="margin: 0 0 20px; color: rgba(255, 255, 255, 0.7);">${message}</p>
        <div style="display: flex; gap: 8px; justify-content: flex-end;">
          <button id="cancel-btn" style="padding: 8px 16px; background: rgba(255, 255, 255, 0.1); border: none; color: white; border-radius: 6px; cursor: pointer; font-weight: 600;">Cancel</button>
          <button id="confirm-btn" style="padding: 8px 16px; background: var(--secondary-color, #ff4d4d); border: none; color: white; border-radius: 6px; cursor: pointer; font-weight: 600;">Confirm</button>
        </div>
      `;

      overlay.appendChild(dialog);
      document.body.appendChild(overlay);

      dialog.querySelector('#cancel-btn').onclick = () => {
        overlay.remove();
        resolve(false);
      };

      dialog.querySelector('#confirm-btn').onclick = () => {
        overlay.remove();
        resolve(true);
      };
    });
  }

  
  addRippleEffect(element) {
    element.addEventListener('click', (e) => {
      const ripple = document.createElement('span');
      const rect = element.getBoundingClientRect();
      const size = Math.max(rect.width, rect.height);
      const x = e.clientX - rect.left - size / 2;
      const y = e.clientY - rect.top - size / 2;

      ripple.style.cssText = `
        position: absolute;
        width: ${size}px;
        height: ${size}px;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.6);
        left: ${x}px;
        top: ${y}px;
        pointer-events: none;
        animation: ripple 0.6s ease-out;
      `;

      element.style.position = 'relative';
      element.style.overflow = 'hidden';
      element.appendChild(ripple);

      setTimeout(() => ripple.remove(), 600);
    });
  }

  
  lazyLoadImages() {
    if (!('IntersectionObserver' in window)) {
      
      document.querySelectorAll('img[data-src]').forEach(img => {
        img.src = img.dataset.src;
      });
      return;
    }

    const imageObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const img = entry.target;
          img.src = img.dataset.src;
          img.classList.add('loaded');
          observer.unobserve(img);
        }
      });
    });

    document.querySelectorAll('img[data-src]').forEach(img => imageObserver.observe(img));
  }

  
  monitorPerformance() {
    if (window.performance && window.performance.timing) {
      window.addEventListener('load', () => {
        const timing = window.performance.timing;
        const navigationStart = timing.navigationStart;
        const loadTime = timing.loadEventEnd - navigationStart;
        const paintTime = timing.responseEnd - navigationStart;

        console.log(`⏱ Page Load Time: ${loadTime}ms`);
        console.log(`⏱ First Paint Time: ${paintTime}ms`);

        if (loadTime > 3000) {
          console.warn('⚠ Page load time is high');
        }
      });
    }
  }
}


if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    window.launcherPolish = new LauncherPolish();
  });
} else {
  window.launcherPolish = new LauncherPolish();
}


const style = document.createElement('style');
style.textContent = `
  @keyframes slideUp {
    from { opacity: 0; transform: translateY(20px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes slideDown {
    from { opacity: 1; transform: translateY(0); }
    to { opacity: 0; transform: translateY(20px); }
  }
  @keyframes fadeInOverlay {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  @keyframes ripple {
    to { transform: scale(4); opacity: 0; }
  }
  .visible { animation: slideUp 0.5s ease-out; }
`;
document.head.appendChild(style);
