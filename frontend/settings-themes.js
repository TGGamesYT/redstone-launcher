/* ========================================
   THEME PRESET INJECTOR
   Adds theme presets to settings page
   ======================================== */

const THEME_PRESETS = {
  'redstone': { name: '🔴 Redstone (Default)', colors: ['#b30c0c', '#ff4d4d', '#d92d2d'] },
  'ocean': { name: '🌊 Ocean', colors: ['#0ea5e9', '#06b6d4', '#0284c7'] },
  'forest': { name: '🌲 Forest', colors: ['#059669', '#10b981', '#047857'] },
  'sunset': { name: '🌅 Sunset', colors: ['#f97316', '#fb923c', '#ea580c'] },
  'purple': { name: '💜 Purple', colors: ['#8b5cf6', '#a78bfa', '#7c3aed'] },
  'candy': { name: '🍬 Candy', colors: ['#ec4899', '#f472b6', '#db2777'] },
};

function injectThemePresets() {
  // Look for the appearance/theme section
  const settingsForm = document.querySelector('form') || document.querySelector('[data-section="appearance"]');
  
  if (!settingsForm) {
    console.warn('[Theme Injector] Could not find settings form');
    return;
  }

  // Create theme preset section
  const presetSection = document.createElement('div');
  presetSection.style.marginTop = '20px';
  presetSection.style.padding = '16px';
  presetSection.style.background = 'var(--card-bg, rgba(255, 255, 255, 0.05))';
  presetSection.style.borderRadius = 'var(--border-radius, 12px)';
  presetSection.style.border = '1px solid var(--border-color, rgba(255, 255, 255, 0.1))';

  const presetTitle = document.createElement('h4');
  presetTitle.textContent = '🎨 Quick Theme Presets';
  presetTitle.style.marginTop = '0';
  presetTitle.style.marginBottom = '12px';
  presetSection.appendChild(presetTitle);

  const presetContainer = document.createElement('div');
  presetContainer.style.display = 'grid';
  presetContainer.style.gridTemplateColumns = 'repeat(auto-fit, minmax(120px, 1fr))';
  presetContainer.style.gap = '8px';

  Object.entries(THEME_PRESETS).forEach(([key, preset]) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = preset.name;
    btn.style.padding = '10px';
    btn.style.background = `linear-gradient(135deg, ${preset.colors[1]}, ${preset.colors[0]})`;
    btn.style.border = 'none';
    btn.style.borderRadius = '8px';
    btn.style.color = 'white';
    btn.style.fontWeight = '600';
    btn.style.cursor = 'pointer';
    btn.style.transition = 'all 0.2s ease';
    btn.onclick = (e) => {
      e.preventDefault();
      applyThemePreset(key, preset.colors);
    };
    btn.onmouseover = () => btn.style.transform = 'translateY(-2px)';
    btn.onmouseout = () => btn.style.transform = 'translateY(0)';

    presetContainer.appendChild(btn);
  });

  presetSection.appendChild(presetContainer);
  
  // Try to append after the appearance section or at the end
  const appearanceSection = document.querySelector('[data-section="appearance"]');
  if (appearanceSection) {
    appearanceSection.parentElement?.insertBefore(presetSection, appearanceSection.nextSibling);
  } else {
    settingsForm.appendChild(presetSection);
  }
}

async function applyThemePreset(presetName, colors) {
  const { ipcRenderer } = require('electron');
  
  const settings = {
    baseColor: colors[0],
    secondaryColor: colors[1],
    thirdColor: colors[2],
    textColor: '#ffffff',
    font: 'Inter',
    borderRadius: 12,
    gradientEnabled: true,
    gradientColors: colors,
    gradientAngle: 135,
  };

  try {
    // Save to backend
    await ipcRenderer.invoke('save-settings', settings);
    
    // Save to localStorage
    localStorage.setItem('launcherTheme', JSON.stringify(settings));
    
    // Apply immediately
    applyThemeToDOM(settings);
    
    // Show success message
    const notif = document.createElement('div');
    notif.textContent = `✓ Theme "${presetName}" applied!`;
    notif.style.position = 'fixed';
    notif.style.bottom = '20px';
    notif.style.right = '20px';
    notif.style.background = 'var(--success-color, #10b981)';
    notif.style.color = 'white';
    notif.style.padding = '12px 16px';
    notif.style.borderRadius = '8px';
    notif.style.zIndex = '10000';
    notif.style.animation = 'slideUp 0.3s ease-out';
    document.body.appendChild(notif);
    
    setTimeout(() => notif.remove(), 2000);
  } catch (err) {
    console.error('Failed to apply theme preset:', err);
    alert('Failed to apply theme. Check console for details.');
  }
}

function applyThemeToDOM(settings) {
  const root = document.documentElement;
  
  root.style.setProperty('--base-color', settings.baseColor);
  root.style.setProperty('--secondary-color', settings.secondaryColor);
  root.style.setProperty('--third-color', settings.thirdColor);
  root.style.setProperty('--text-color', settings.textColor || '#ffffff');
  root.style.setProperty('--text-font', settings.font || 'Inter');
  root.style.setProperty('--border-radius', `${settings.borderRadius || 12}px`);
  root.style.setProperty('--gradient-angle', `${settings.gradientAngle || 180}deg`);

  if (settings.gradientEnabled && settings.gradientColors && settings.gradientColors.length > 0) {
    const gradientStr = `linear-gradient(${settings.gradientAngle || 180}deg, ${settings.gradientColors.join(', ')})`;
    root.style.setProperty('--app-gradient', gradientStr);
  } else {
    const defaultGradient = `linear-gradient(135deg, ${settings.secondaryColor}, ${settings.baseColor})`;
    root.style.setProperty('--app-gradient', defaultGradient);
  }
}

// Inject presets when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectThemePresets);
} else {
  injectThemePresets();
}

// Fallback - try again after a short delay
setTimeout(injectThemePresets, 500);
