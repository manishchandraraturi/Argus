// ─── 30-Second Guided Demo for ARGUS ──────────────────────────────────────────
// Walkthrough showcasing Barnard's Star: landing -> probe -> target pick -> viewer
// -> blink best pair -> difference image -> motion check HUD card.

let isRunning = false;
let abortHandler = null;
let isSynthetic = false;

function createOrGetBanner() {
  let banner = document.getElementById('argus-guided-demo-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'argus-guided-demo-banner';
    banner.className = 'guided-demo-banner';
    banner.textContent = 'GUIDED DEMO (ESC TO EXIT)';
    document.body.appendChild(banner);
  }
  banner.style.display = 'block';
  return banner;
}

function createOrGetCaption() {
  let caption = document.getElementById('argus-guided-demo-caption');
  if (!caption) {
    caption = document.createElement('div');
    caption.id = 'argus-guided-demo-caption';
    caption.className = 'guided-demo-bottom-caption';
    document.body.appendChild(caption);
  }
  caption.style.display = 'block';
  return caption;
}

function hideOverlays() {
  const banner = document.getElementById('argus-guided-demo-banner');
  if (banner) banner.style.display = 'none';
  const caption = document.getElementById('argus-guided-demo-caption');
  if (caption) caption.style.display = 'none';
}

function setCaptionText(text) {
  const caption = createOrGetCaption();
  caption.textContent = text;
}

function safeClick(el) {
  if (!el) return;
  isSynthetic = true;
  try {
    el.click();
  } finally {
    setTimeout(() => {
      isSynthetic = false;
    }, 50);
  }
}

export function isDemoRunning() {
  return isRunning;
}

export function stopGuidedDemo(reason = 'User aborted') {
  if (!isRunning) return;
  console.log(`[demo] Guided demo stopped: ${reason}`);
  isRunning = false;
  hideOverlays();

  if (abortHandler) {
    abortHandler();
    abortHandler = null;
  }
}

export async function startGuidedDemo() {
  if (isRunning) return;
  isRunning = true;
  console.log('[demo] Starting 30-second guided demo...');

  createOrGetBanner();
  setCaptionText('Initializing ARGUS survey flow...');

  let activeTimer = null;
  const abortPromise = new Promise((_, reject) => {
    abortHandler = () => {
      if (activeTimer) clearTimeout(activeTimer);
      reject(new Error('Demo aborted'));
    };
  });

  const sleep = (ms) => {
    return Promise.race([
      new Promise((resolve) => {
        activeTimer = setTimeout(resolve, ms);
      }),
      abortPromise,
    ]);
  };

  // Keyboard and click abort listeners
  const onKeyDown = (e) => {
    if (e.key === 'Escape' || e.key === 'Esc') {
      stopGuidedDemo('Esc key pressed');
    }
  };

  const onPointerDown = (e) => {
    if (isSynthetic) return;
    const demoBtn = document.getElementById('btn-guided-demo');
    if (demoBtn && demoBtn.contains(e.target)) return;
    stopGuidedDemo('User interaction detected');
  };

  window.addEventListener('keydown', onKeyDown, { capture: true });
  window.addEventListener('pointerdown', onPointerDown, { capture: true });

  const cleanupListeners = () => {
    window.removeEventListener('keydown', onKeyDown, { capture: true });
    window.removeEventListener('pointerdown', onPointerDown, { capture: true });
  };

  try {
    // 1. Landing Screen -> Click START PROBING
    const btnStart = document.getElementById('btn-start-probing');
    if (btnStart) {
      setCaptionText('Navigating celestial sphere: START PROBING');
      safeClick(btnStart);
      await sleep(1000);
    }

    // 2. Select PICK A TARGET menu option
    const pickTargetMenuBtn = document.querySelector('.probe-menu-card[data-mode="known"]') ||
                             document.querySelector('[data-mode="known"]');
    if (pickTargetMenuBtn) {
      setCaptionText('Selecting survey catalog: PICK A TARGET');
      safeClick(pickTargetMenuBtn);
      await sleep(800);
    }

    // 3. Find and select Barnard's Star card
    const targetCards = Array.from(document.querySelectorAll('.probe-target-card'));
    const barnardCard = targetCards.find((c) =>
      c.textContent.toUpperCase().includes('BARNARD')
    ) || targetCards[0];

    if (barnardCard) {
      setCaptionText("Target selected: Barnard's Star (High Proper Motion)");
      safeClick(barnardCard);
      await sleep(1000);
    }

    // 4. Confirm Location
    const confirmBtn = document.getElementById('locbar-confirm-btn') ||
                       document.querySelector('#location-bar-known #locbar-confirm-btn');
    if (confirmBtn) {
      safeClick(confirmBtn);
      await sleep(600);
    }

    // 5. Load Sky Images
    const loadBtn = document.getElementById('locbar-load-btn') ||
                     document.querySelector('#location-bar-known #locbar-load-btn');
    if (loadBtn) {
      setCaptionText("Acquiring SPHEREx survey frames...");
      safeClick(loadBtn);
    }

    // 6. Wait for Viewer to be active and frames loaded
    const startWait = performance.now();
    while (performance.now() - startWait < 10000) {
      if (!isRunning) return;
      const vAPI = window.__argusViewer;
      const state = vAPI?.getState();
      if (document.body.classList.contains('screen-viewer') && state?.frames?.length > 0 && !vAPI?.isWaitingForData()) {
        break;
      }
      await sleep(200);
    }
    await sleep(600);

    // 7. Best pair & BLINK mode at 0.75x for 6 seconds
    if (window.__argusViewer) {
      window.__argusViewer.setPairMode('best');
      window.__argusViewer.setMode('BLINK');

      const blinkRate075Btn = document.querySelector('#blink-speed-pills button[data-speed="0.75"]') ||
                              document.querySelector('.speed-pills-wrap button[data-speed="0.75"]');
      if (blinkRate075Btn) safeClick(blinkRate075Btn);

      const vState = window.__argusViewer.getState();
      const frames = vState?.frames || [];
      const pair = (typeof window.__argusViewer.getBlinkPair === 'function') 
        ? window.__argusViewer.getBlinkPair() 
        : [vState?.blinkFrameA || 0, vState?.blinkFrameB || Math.max(0, frames.length - 1)];
      const idxA = (typeof pair[0] === 'number' && pair[0] >= 0) ? pair[0] : 0;
      const idxB = (typeof pair[1] === 'number' && pair[1] >= 0) ? pair[1] : Math.max(0, frames.length - 1);
      const frameA = frames[idxA] || {};
      const frameB = frames[idxB] || {};

      const numA = idxA + 1;
      const numB = idxB + 1;
      const dateA = frameA.date || 'unknown';
      const dateB = frameB.date || 'unknown';

      let monthsApart = 0;
      if (frameA.date && frameB.date) {
        const d1 = new Date(frameA.date);
        const d2 = new Date(frameB.date);
        const diffDays = Math.abs(d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24);
        monthsApart = Math.round(diffDays / 30.4375);
      }

      const formatWl = (val) => {
        if (typeof val === 'number') return val.toFixed(2);
        if (typeof val === 'string' && !isNaN(parseFloat(val))) return parseFloat(val).toFixed(2);
        return String(val || '');
      };
      const wlA = formatWl(frameA.wavelength_um);
      const wlB = formatWl(frameB.wavelength_um);

      const blinkCaption = `Blinking frame ${numA} (${dateA}) and frame ${numB} (${dateB}): about ${monthsApart} months apart, ${wlA} and ${wlB} um`;
      setCaptionText(blinkCaption);
      await sleep(6000);

      // 8. DIFFERENCE mode for 4 seconds
      window.__argusViewer.setMode('DIFFERENCE');
      window.__argusViewer.setPairMode('best');
      setCaptionText("Difference image: bright and dark lobes show where the frames differ. Check near the green ring.");
      await sleep(4000);

      // 9. Show MOTION CHECK HUD card for 4 seconds
      setCaptionText("Motion check: direction agrees (5.2 deg), size does not. Not confirmed.");
      await sleep(4000);
    }

    console.log('[demo] Guided demo complete. Handing over full control.');
  } catch (err) {
    if (err.message !== 'Demo aborted') {
      console.warn('[demo] Error during guided demo:', err);
    }
  } finally {
    isRunning = false;
    cleanupListeners();
    hideOverlays();
  }
}
