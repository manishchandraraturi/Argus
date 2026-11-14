import { TARGETS, isCachedDemoTarget } from './targets.js';
import { API_BASE, ALLOW_LIVE_FETCH, getApiBase, getAllowLiveFetch, getRequestUrl, getFrames, setSelectedTarget, getSelectedTarget, findMatchingCachedTarget } from './api.js';

// ─── 11. ARGUS Brand Constant ─────────────────────────────────────────────────
export const PROJECT_NAME = "ARGUS";

// ─── Utility ──────────────────────────────────────────────────────────────────
function easeOutQuad(t) {
  return t * (2 - t);
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function randRange(min, max) {
  return min + Math.random() * (max - min);
}

// ─── 12. Scramble Glitch for ARGUS ───────────────────────────────────────────
export function scrambleArgus(element, finalWord = "ARGUS", duration = 400) {
  if (!element) return Promise.resolve();
  const glyphs = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789§$%#@&?';
  const len = finalWord.length;
  const totalSteps = 8;
  const stepDelay = Math.max(25, Math.floor(duration / totalSteps));
  let step = 0;

  return new Promise((resolve) => {
    const timer = setInterval(() => {
      step++;
      const settledCount = Math.floor((step / totalSteps) * (len + 1));

      const chars = [];
      for (let i = 0; i < len; i++) {
        if (i < settledCount) {
          chars.push(finalWord[i]);
        } else {
          chars.push(glyphs[(Math.random() * glyphs.length) | 0]);
        }
      }
      element.innerHTML = `<span class="argus-letter-a">${chars[0]}</span>${chars.slice(1).join('')}`;

      if (step >= totalSteps) {
        clearInterval(timer);
        element.innerHTML = `<span class="argus-letter-a">A</span>RGUS`;
        resolve();
      }
    }, stepDelay);
  });
}

// ─── Scramble Helper for Buttons ──────────────────────────────────────────────
export function scrambleButtonText(element, finalText = 'INITIALIZING...', duration = 250) {
  if (!element) return Promise.resolve();
  const glyphs = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789§$%#@&?';
  const len = finalText.length;
  const totalSteps = 6;
  const stepDelay = Math.max(20, Math.floor(duration / totalSteps));
  let step = 0;

  return new Promise((resolve) => {
    const timer = setInterval(() => {
      step++;
      const settledCount = Math.floor((step / totalSteps) * (len + 1));
      let str = '';
      for (let i = 0; i < len; i++) {
        if (i < settledCount) {
          str += finalText[i];
        } else {
          str += glyphs[(Math.random() * glyphs.length) | 0];
        }
      }
      element.textContent = str;
      if (step >= totalSteps) {
        clearInterval(timer);
        element.textContent = finalText;
        resolve();
      }
    }, stepDelay);
  });
}

// ─── Typewriter Effect ────────────────────────────────────────────────────────
export function typewriteText(element, text, speed = 20) {
  return new Promise((resolve) => {
    if (!element) return resolve();
    element.textContent = '';
    let i = 0;
    const timer = setInterval(() => {
      element.textContent += text.charAt(i);
      i++;
      if (i >= text.length) {
        clearInterval(timer);
        resolve();
      }
    }, speed);
  });
}

// ─── Number Counter Animation ─────────────────────────────────────────────────
export function animateValue(element, start, end, duration = 300, decimals = 3, suffix = '') {
  if (!element) return;
  let startTime = null;

  function update(now) {
    if (startTime === null) startTime = now;
    const elapsed = now - startTime;
    const progress = Math.min(Math.max(0.0, elapsed / duration), 1.0);
    const eased = easeOutQuad(progress);
    const current = start + (end - start) * eased;

    const formatted = decimals > 0 ? current.toFixed(decimals) : Math.round(current).toString();
    element.textContent = formatted + suffix;

    if (progress < 1.0) {
      requestAnimationFrame(update);
    } else {
      const finalFormatted = decimals > 0 ? end.toFixed(decimals) : Math.round(end).toString();
      element.textContent = finalFormatted + suffix;
    }
  }

  requestAnimationFrame(update);
}

// ─── 1. Flicker Pixels Controller (~350 squares, 2-3px, loose 90px grid) ──────
function initFlickerPixels(canvas) {
  const ctx = canvas.getContext('2d');
  let width = (canvas.width = window.innerWidth);
  let height = (canvas.height = window.innerHeight);

  const pixels = [];
  const step = 90;
  const cols = Math.ceil(width / step) + 1;
  const rows = Math.ceil(height / step) + 1;

  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const countInCell = 2 + (Math.random() < 0.4 ? 1 : 0);
      for (let k = 0; k < countInCell; k++) {
        const x = c * step + randRange(-38, 38);
        const y = r * step + randRange(-38, 38);
        const isCyan = Math.random() < 0.16;

        pixels.push({
          x,
          y,
          size: Math.random() < 0.5 ? 2 : 3,
          color: isCyan ? '#4fc3f7' : '#e9eef5',
          opacity: randRange(0.05, 0.60),
          targetOpacity: randRange(0.05, 0.60),
          nextChange: performance.now() + randRange(80, 300),
          vanished: false,
          vanishUntil: 0,
        });
      }
    }
  }

  function resize() {
    width = canvas.width = window.innerWidth;
    height = canvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resize);

  function render(now) {
    ctx.clearRect(0, 0, width, height);

    for (let i = 0; i < pixels.length; i++) {
      const p = pixels[i];

      if (p.vanished) {
        if (now > p.vanishUntil) {
          p.vanished = false;
          p.opacity = randRange(0.1, 0.5);
          p.nextChange = now + randRange(80, 300);
        } else {
          continue;
        }
      } else if (Math.random() < 0.0006) {
        p.vanished = true;
        p.vanishUntil = now + randRange(1000, 2000);
        continue;
      }

      if (now > p.nextChange) {
        p.opacity = p.targetOpacity;
        p.targetOpacity = randRange(0.05, 0.60);
        p.nextChange = now + randRange(80, 300);
      } else {
        p.opacity += (p.targetOpacity - p.opacity) * 0.15;
      }

      ctx.fillStyle = p.color;
      ctx.globalAlpha = p.opacity;
      ctx.fillRect(p.x, p.y, p.size, p.size);
    }
    ctx.globalAlpha = 1.0;
  }

  return { render };
}

// ─── 1b. Fine 1px Grain (Neutral Grey) & Glitch Strips ────────────────────────
function initGrainAndGlitch(canvas) {
  const ctx = canvas.getContext('2d');
  // High-res tiled pattern for crisp 1px neutral grey grains
  const nw = 512;
  const nh = 512;
  const noiseCanvas = document.createElement('canvas');
  noiseCanvas.width = nw;
  noiseCanvas.height = nh;
  const noiseCtx = noiseCanvas.getContext('2d');
  const imgData = noiseCtx.createImageData(nw, nh);
  const data32 = new Uint32Array(imgData.data.buffer);

  let lastNoiseTime = 0;
  const noiseInterval = 1000 / 12; // 12fps

  let nextGlitchTime = performance.now() + randRange(2000, 4000);
  let glitchActive = false;
  let glitchEndTime = 0;
  let glitchStrips = [];

  function generateNoise() {
    const len = data32.length;
    for (let i = 0; i < len; i++) {
      const v = (Math.random() * 255) | 0;
      // Pure monochrome neutral grey (v, v, v)
      data32[i] = (255 << 24) | (v << 16) | (v << 8) | v;
    }
    noiseCtx.putImageData(imgData, 0, 0);
  }

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  function render(now) {
    if (now - lastNoiseTime > noiseInterval) {
      lastNoiseTime = now;
      generateNoise();
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Render repeating 1:1 pixel grain pattern
    const pattern = ctx.createPattern(noiseCanvas, 'repeat');
    if (pattern) {
      ctx.fillStyle = pattern;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    // Glitch bands every 2-4 seconds
    if (!glitchActive && now > nextGlitchTime) {
      glitchActive = true;
      glitchEndTime = now + 80;
      const numStrips = 1 + (Math.random() < 0.5 ? 1 : 0);
      glitchStrips = [];
      for (let s = 0; s < numStrips; s++) {
        glitchStrips.push({
          y: randRange(60, canvas.height - 80),
          h: randRange(2, 6),
          shift: (Math.random() < 0.5 ? -1 : 1) * randRange(4, 20),
        });
      }
    }

    if (glitchActive) {
      if (now > glitchEndTime) {
        glitchActive = false;
        nextGlitchTime = now + randRange(2000, 4000);
      } else {
        const fade = (glitchEndTime - now) / 80;
        ctx.fillStyle = `rgba(233, 238, 245, ${0.18 * fade})`;
        for (const strip of glitchStrips) {
          ctx.fillRect(strip.shift, strip.y, canvas.width, strip.h);
        }
      }
    }
  }

  return { render };
}

// ─── 3. Data Streams: Monospace Hex Columns Mutating Randomly ─────────────────
function initDataStreams() {
  const streamBR = document.getElementById('stream-br');
  const streamLM = document.getElementById('stream-lm');
  const streamTC = document.getElementById('stream-tc');

  const hexChars = '0123456789ABCDEF';

  function makeHexBlock(lines, cols) {
    const arr = [];
    for (let r = 0; r < lines; r++) {
      let line = '';
      for (let c = 0; c < cols; c++) {
        line += hexChars[(Math.random() * 16) | 0] + hexChars[(Math.random() * 16) | 0] + ' ';
      }
      arr.push(line.trim());
    }
    return arr;
  }

  const linesBR = makeHexBlock(8, 7);
  const linesLM = makeHexBlock(5, 4);
  const linesTC = makeHexBlock(2, 10);

  function mutateLine(arr) {
    const rIdx = (Math.random() * arr.length) | 0;
    const str = arr[rIdx];
    const cIdx = (Math.random() * str.length) | 0;
    if (str[cIdx] !== ' ') {
      arr[rIdx] = str.substring(0, cIdx) + hexChars[(Math.random() * 16) | 0] + str.substring(cIdx + 1);
    }
  }

  let lastMutate = 0;

  function update(now) {
    if (now - lastMutate > 65) {
      lastMutate = now;
      mutateLine(linesBR);
      mutateLine(linesLM);
      mutateLine(linesTC);

      if (streamBR) streamBR.textContent = linesBR.join('\n');
      if (streamLM) streamLM.textContent = linesLM.join('\n');
      if (streamTC) streamTC.textContent = linesTC.join('\n');
    }
  }

  return { update };
}

// ─── 3b. Floating Readout Labels near Nodes / Markers ─────────────────────────
function initFloatingReadouts() {
  const readouts = document.querySelectorAll('.floating-readout');
  const states = Array.from(readouts).map(() => ({
    nextToggle: performance.now() + randRange(400, 1500),
    visible: Math.random() < 0.7,
  }));

  function update(now) {
    if (document.body.classList.contains('screen-probe')) return;
    readouts.forEach((el, i) => {
      const s = states[i];
      if (now > s.nextToggle) {
        s.visible = !s.visible;
        s.nextToggle = now + randRange(400, 1800);
        el.style.opacity = s.visible ? (0.45 + Math.random() * 0.45).toString() : '0.0';
      }
    });
  }

  return { update };
}

// ─── 7. Text Glitch: Jitter 2-3px for 100ms with Red/Cyan Split ───────────────
function initTextGlitch() {
  const boxes = document.querySelectorAll('.hud-box');
  let nextGlitch = performance.now() + randRange(3000, 6000);
  let activeBox = null;
  let glitchEnd = 0;

  function update(now) {
    if (!activeBox && now > nextGlitch) {
      activeBox = boxes[(Math.random() * boxes.length) | 0];
      if (activeBox) {
        activeBox.classList.add('text-glitch-active');
        glitchEnd = now + 100;
      }
    }

    if (activeBox && now > glitchEnd) {
      activeBox.classList.remove('text-glitch-active');
      activeBox = null;
      nextGlitch = now + randRange(3000, 6000);
    }
  }

  return { update };
}

// ─── Main HUD Initialization ──────────────────────────────────────────────────
export function initHUD(sky) {
  // Elements
  const elProjectTitle = document.getElementById('hud-project-title');
  const elUtcClock = document.getElementById('hud-utc-clock');
  const elTargetName = document.getElementById('hud-target-name');
  const elStatusRow = document.querySelector('.hud-status-row');
  const elRa = document.getElementById('val-ra');
  const elDec = document.getElementById('val-dec');
  const elFov = document.getElementById('val-fov');
  const elFrames = document.getElementById('val-frames');
  const elDist1 = document.getElementById('val-dist1');
  const elDist2 = document.getElementById('val-dist2');
  const elProfile = document.getElementById('hud-profile-label');
  const elFeedTitle = document.getElementById('hud-feed-title');
  const elRecord = document.getElementById('hud-record-label');
  const elScanTitle = document.getElementById('hud-scan-title');

  const btnStartProbing = document.getElementById('btn-start-probing');
  const probeBtnText = document.getElementById('probe-btn-text');
  const btnProbeBack = document.getElementById('btn-probe-back');

  const wrap = document.getElementById('wrap');
  const lockReticle = document.getElementById('target-lock-reticle');
  const bootOverlay = document.getElementById('boot-overlay');

  const elArgusTitle = document.getElementById('argus-title');

  const defaultTarget = Object.values(TARGETS)[0] || {
    name: "BARNARD'S STAR",
    ra: 269.452,
    dec: 4.693,
    fov: 0.20,
    frames: 14,
  };

  let currentTarget = {
    ...defaultTarget,
  };
  setSelectedTarget(currentTarget);
  if (typeof window !== 'undefined') {
    window.selectedTarget = currentTarget;
    window.__selectedTarget = currentTarget;
    window.currentTarget = currentTarget;
  }
  if (sky && typeof sky.setProbeCoordinates === 'function') {
    sky.setProbeCoordinates(defaultTarget.ra, defaultTarget.dec);
  }
  if (sky && typeof sky.centerOnTarget === 'function') {
    sky.centerOnTarget(defaultTarget.ra, defaultTarget.dec, 0);
  }

  // ─── Screen Manager ('landing' | 'probe' | 'viewer') ──────────────────────────
  let currentScreen = 'landing';

  function setScreen(screen, updateHash = true) {
    if (screen !== 'landing' && screen !== 'probe' && screen !== 'viewer') return;
    currentScreen = screen;

    if (screen === 'viewer') {
      document.body.classList.remove('screen-probe');
      document.body.classList.add('screen-viewer');
      if (sky && typeof sky.setScreenMode === 'function') {
        sky.setScreenMode('viewer', 500);
      }
      if (sky && typeof sky.centerOnTarget === 'function') {
        sky.centerOnTarget(probeState.ra, probeState.dec, 0);
      }
      if (updateHash && !window.location.hash.startsWith('#viewer')) {
        window.location.hash = '#viewer';
      }
    } else if (screen === 'probe') {
      document.body.classList.remove('screen-viewer');
      document.body.classList.add('screen-probe');
      if (sky && typeof sky.setScreenMode === 'function') {
        sky.setScreenMode('probe', 700);
      }
      if (updateHash && !window.location.hash.startsWith('#probe')) {
        window.location.hash = '#probe';
      }
    } else {
      document.body.classList.remove('screen-viewer');
      document.body.classList.remove('screen-probe');
      if (sky && typeof sky.setScreenMode === 'function') {
        sky.setScreenMode('landing', 700);
      }
      if (updateHash && (window.location.hash.startsWith('#probe') || window.location.hash.startsWith('#viewer'))) {
        history.pushState(null, '', window.location.pathname + window.location.search);
      }
    }
  }

  window.setScreen = setScreen;

  if (elArgusTitle) elArgusTitle.innerHTML = '<span class="argus-letter-a">A</span>RGUS';

  // Initialize Canvas Layers
  const flickerCanvas = document.getElementById('flicker-canvas');
  const grainCanvas = document.getElementById('grain-glitch-canvas');

  const flickerController = flickerCanvas ? initFlickerPixels(flickerCanvas) : null;
  const grainController   = grainCanvas ? initGrainAndGlitch(grainCanvas) : null;
  const dataStreams       = initDataStreams();
  const floatingReadouts  = initFloatingReadouts();
  const textGlitch        = initTextGlitch();

  // ── 11. Boot Sequence (2s) ─────────────────────────────────────────────────
  function runIntroAnimations() {
    if (elProfile) typewriteText(elProfile, 'BUILDING PROFILE...', 15);
    if (elFeedTitle) typewriteText(elFeedTitle, 'PROCESSING SKY GRID', 18);
    if (elRecord) typewriteText(elRecord, 'RECORD: INFRARED SURVEY', 14);
    if (elScanTitle) typewriteText(elScanTitle, 'REGIONAL SCAN', 18);

    if (elTargetName) {
      typewriteText(elTargetName, 'AWAITING TARGET', 20);
    }

    if (elRa) elRa.textContent = '--';
    if (elDec) elDec.textContent = '--';
    if (elFov) elFov.textContent = '--';
    if (elFrames) elFrames.textContent = '--';

    if (elDist1) animateValue(elDist1, 0, 0.20, 150, 2, ' DEG');
    if (elDist2) animateValue(elDist2, 0, 0.10, 150, 2, ' DEG');
  }

  // Dismiss boot overlay after scanline sweep (~1.8s) & trigger ARGUS sequence
  setTimeout(() => {
    if (bootOverlay) {
      bootOverlay.classList.add('boot-done');
    }
    // Scramble letters glitch then settle into ARGUS
    if (elArgusTitle) {
      scrambleArgus(elArgusTitle, PROJECT_NAME, 650);
    }
    runIntroAnimations();
  }, 1800);

  // ── 12. Target-Lock Animation ───────────────────────────────────────────────
  function triggerTargetLock(targetData) {
    if (elStatusRow) {
      elStatusRow.innerHTML = `<span class="status-dot" style="background:#e8a317;box-shadow:0 0 8px #e8a317;"></span><span style="color:#e8a317;">LOCKING...</span>`;
    }

    if (lockReticle) {
      lockReticle.style.left = '50%';
      lockReticle.style.top = '50%';
      lockReticle.className = 'target-lock-reticle active locking';
    }

    setTimeout(() => {
      if (lockReticle) {
        lockReticle.className = 'target-lock-reticle active locked';
      }
      if (elStatusRow) {
        elStatusRow.innerHTML = `<span class="status-dot" style="background:#e8a317;box-shadow:0 0 10px #e8a317;"></span><span style="color:#e8a317;">LOCK ACQUIRED</span>`;
      }
    }, 750);

    setTimeout(() => {
      if (lockReticle) {
        lockReticle.className = 'target-lock-reticle';
      }
      if (elStatusRow) {
        elStatusRow.innerHTML = `<span class="status-dot"></span><span>STATUS ACTIVE</span>`;
      }
    }, 2200);
  }

  // ── 7. Target Selection & Camera Rotation ──────────────────────────────────
  function selectTarget(targetData) {
    const targetObj = { ...targetData };
    currentTarget = targetObj;
    currentTargetName = targetData.name;
    probeState.ra = targetData.ra;
    probeState.dec = targetData.dec;
    probeState.fov = targetData.fov || 0.20;
    setSelectedTarget(targetObj);
    if (typeof window !== 'undefined') {
      window.selectedTarget = targetObj;
      window.__selectedTarget = targetObj;
      window.currentTarget = targetObj;
    }

    triggerTargetLock(targetData);

    if (sky && typeof sky.rotateTo === 'function') {
      sky.rotateTo(targetData.ra, targetData.dec, 900);
    }

    if (elTargetName) {
      typewriteText(elTargetName, targetData.name, 20);
    }

    const curRaVal = parseFloat(elRa?.textContent) || 0;
    const curDecVal = parseFloat(elDec?.textContent) || 0;
    const curFovVal = parseFloat(elFov?.textContent) || 0;
    const curFramesVal = parseInt(elFrames?.textContent, 10) || 0;

    animateValue(elRa, curRaVal, targetData.ra, 350, 3);
    animateValue(elDec, curDecVal, targetData.dec, 350, 3);
    animateValue(elFov, curFovVal, targetData.fov || 0.20, 300, 2);
    animateValue(elFrames, curFramesVal, targetData.frames || 9, 280, 0);

    const d1Num = parseFloat(targetData.dist1) || 0.20;
    const d2Num = parseFloat(targetData.dist2) || 0.10;
    animateValue(elDist1, 0, d1Num, 350, 2, ' DEG');
    animateValue(elDist2, 0, d2Num, 350, 2, ' DEG');

    if (sky && typeof sky.setMarkers === 'function') {
      sky.setMarkers([
        {
          id: targetData.name,
          ra: targetData.ra,
          dec: targetData.dec,
        },
      ]);
    }
  }

  // ── START PROBING Button Click & Transition ─────────────────────────────────
  let isTransitioning = false;

  if (btnStartProbing) {
    btnStartProbing.addEventListener('click', async () => {
      if (isTransitioning || currentScreen === 'probe') return;
      isTransitioning = true;
      btnStartProbing.classList.add('flash-active');

      if (probeBtnText) {
        await scrambleButtonText(probeBtnText, 'INITIALIZING...', 250);
      } else {
        await new Promise((r) => setTimeout(r, 250));
      }

      setScreen('probe');

      setTimeout(() => {
        btnStartProbing.classList.remove('flash-active');
        if (probeBtnText) probeBtnText.textContent = 'START PROBING';
        isTransitioning = false;
      }, 700);
    });
  }

  // ── Section F: Back to Landing Sequence ──────────────────────────────────────
  let isReturningToLanding = false;
  const scanlineSweep = document.getElementById('landing-scanline-sweep');
  const probePanelCard = document.getElementById('probe-panel-card');

  async function runBackToLandingSequence(btnTrigger) {
    if (isReturningToLanding) return;
    isReturningToLanding = true;

    // 1. Button flashes amber, text becomes "RETURNING..."
    if (btnTrigger) {
      btnTrigger.classList.add('returning');
      btnTrigger.textContent = 'RETURNING...';
    }

    // 2. Fullscreen amber scan line sweeps once across screen (700ms)
    if (scanlineSweep) {
      scanlineSweep.classList.remove('sweeping');
      void scanlineSweep.offsetWidth;
      scanlineSweep.classList.add('sweeping');
    }

    // 3. Card ticks contract, content fades (200ms), card collapses to thin line (scaleY) & fades
    if (probePanelCard) {
      probePanelCard.classList.add('collapsing');
    }

    // 4. Sky sphere dots/lines implode to center while Earth scales back to full size (total ~900ms)
    if (sky && typeof sky.setScreenMode === 'function') {
      sky.setScreenMode('landing', 900);
    }

    // 5. Corner blocks fly in with typewriter text, START PROBING button fades in
    setTimeout(() => {
      document.body.classList.remove('screen-probe');
      currentScreen = 'landing';
      runIntroAnimations();
    }, 700);

    setTimeout(() => {
      if (probePanelCard) {
        probePanelCard.classList.remove('collapsing');
      }
      if (btnTrigger) {
        btnTrigger.classList.remove('returning');
        btnTrigger.innerHTML = '<span class="back-bracket">&lt;</span> BACK';
      }
      if (scanlineSweep) {
        scanlineSweep.classList.remove('sweeping');
      }
      isReturningToLanding = false;
      setPanelView('menu', false);
    }, 950);
  }

  // ── Keyboard Navigation (Esc steps back one level) ──────────────────────────
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && currentScreen === 'probe') {
      if (sky && typeof sky.registerUserInput === 'function') {
        sky.registerUserInput();
      }
      if (currentPanelView === 'sliders' || currentPanelView === 'type' || currentPanelView === 'known') {
        setLocBarState('editing');
        setPanelView('menu');
      } else if (currentPanelView === 'menu') {
        const btnMenuBack = document.getElementById('btn-menu-back');
        runBackToLandingSequence(btnMenuBack);
      }
    }
  });

  // ── 10. Click on Globe to Drop Marker & Fill Coordinates (Landing Mode) ────
  window.addEventListener('globeclick', (e) => {
    if (currentScreen !== 'landing') return;
    const { ra, dec } = e.detail;
    const targetData = {
      name: 'USER COORD',
      ra,
      dec,
      fov: 0.20,
      frames: 12,
      dist1: '0.20 DEG',
      dist2: '0.10 DEG',
    };
    selectTarget(targetData);
  });

  // ─── PROBE SCREEN CONTROLLER: MULTI-VIEW CELESTIAL POSITIONING SYSTEM ───────
  function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  // Central Single Source of Truth for Probe Coordinates
  const probeState = {
    ra: defaultTarget.ra,
    dec: defaultTarget.dec,
    fov: defaultTarget.fov,
    isUserDraggingSlider: false,
  };

  let raUnit = 'h'; // 'h' or 'deg'
  let currentPanelView = 'menu';
  let lastActiveMode = 'sliders'; // 'sliders' | 'type' | 'known'
  let currentTargetName = defaultTarget.name;

  let sliderUpdateCount = 0;
  let lastSliderUpdateSec = performance.now();
  let sliderUpdatesPerSec = 60;

  // Prevent any pointer events inside probe-panel from propagating to the 3D globe / canvas
  const probePanelEl = document.getElementById('probe-panel');
  if (probePanelEl) {
    ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'mousedown', 'mousemove', 'mouseup', 'click'].forEach(evt => {
      probePanelEl.addEventListener(evt, (e) => {
        e.stopPropagation();
      });
    });
  }

  function formatRaHMS(deg) {
    deg = ((deg % 360) + 360) % 360;
    const hours = deg / 15;
    const h = Math.floor(hours);
    const remM = (hours - h) * 60;
    const m = Math.floor(remM);
    const s = (remM - m) * 60;
    const pad2 = (n) => String(n).padStart(2, '0');
    const sStr = s.toFixed(1).padStart(4, '0');
    return `RA ${pad2(h)}h ${pad2(m)}m ${sStr}s  =  ${deg.toFixed(3)} deg`;
  }

  function formatDecDMS(deg) {
    const sign = deg >= 0 ? '+' : '-';
    const abs = Math.abs(deg);
    const d = Math.floor(abs);
    const remM = (abs - d) * 60;
    const m = Math.floor(remM);
    const s = (remM - m) * 60;
    const pad2 = (n) => String(n).padStart(2, '0');
    const sStr = s.toFixed(1).padStart(4, '0');
    return `DEC ${sign}${pad2(d)}d ${pad2(m)}m ${sStr}s`;
  }

  // ── Views State Machine ─────────────────────────────────────────────────────
  const views = {
    menu:    document.getElementById('view-menu'),
    sliders: document.getElementById('view-sliders'),
    type:    document.getElementById('view-type'),
    known:   document.getElementById('view-known'),
  };

  // ── Location Bar Containers (one per view) ──────────────────────────────────
  const locBarContainers = {
    sliders: document.getElementById('location-bar-sliders'),
    type:    document.getElementById('location-bar-type'),
    known:   document.getElementById('location-bar-known'),
  };

  // ── Location Bar State Machine ──────────────────────────────────────────────
  // States: 'editing' | 'pending' | 'confirmed' | 'loading'
  let locationBarState = 'editing';
  let locationBarActiveView = null; // 'sliders' | 'type' | 'known'
  let activeHudAbortController = null;

  // Single shared location bar DOM element
  const locationBarEl = document.createElement('div');
  locationBarEl.id = 'location-bar';
  locationBarEl.className = 'location-bar';

  locationBarEl.innerHTML = `
    <div class="locbar-editing">
      <button type="button" class="probe-action-btn" id="locbar-primary-btn">
        <span class="corner-tick tl"></span><span class="corner-tick tr"></span>
        <span class="corner-tick bl"></span><span class="corner-tick br"></span>
        <span id="locbar-primary-label">CONFIRM LOCATION</span>
      </button>
    </div>
    <div class="locbar-pending" style="display:none">
      <div class="locbar-coords">
        <div class="locbar-name-line" id="locbar-name-line"></div>
        <div class="locbar-coord-line" id="locbar-ra-line"></div>
        <div class="locbar-coord-line" id="locbar-dec-line"></div>
        <div class="locbar-fov-line" id="locbar-fov-line">FOV 0.20 deg</div>
      </div>
      <div class="locbar-actions">
        <button type="button" class="probe-action-btn" id="locbar-confirm-btn">
          <span class="corner-tick tl"></span><span class="corner-tick tr"></span>
          <span class="corner-tick bl"></span><span class="corner-tick br"></span>
          <span>CONFIRM LOCATION</span>
        </button>
        <button type="button" class="hud-card-back-btn" id="locbar-change-btn">CHANGE</button>
      </div>
    </div>
    <div class="locbar-confirmed" style="display:none">
      <div class="locbar-confirmed-tag" id="locbar-confirmed-tag">✓ LOCATION CONFIRMED — INSTANT REAL DATA</div>
      <div class="locbar-cache-status" id="locbar-cache-status">INSTANT REAL DATA</div>
      <div class="locbar-actions">
        <button type="button" class="probe-action-btn locbar-load-btn" id="locbar-load-btn">
          <span class="corner-tick tl"></span><span class="corner-tick tr"></span>
          <span class="corner-tick bl"></span><span class="corner-tick br"></span>
          <span id="locbar-load-label">LOAD SKY IMAGES</span>
        </button>
        <button type="button" class="hud-card-back-btn" id="locbar-edit-btn">EDIT LOCATION</button>
      </div>
    </div>
  `;

  function renderLocBar() {
    const editDiv      = locationBarEl.querySelector('.locbar-editing');
    const pendingDiv   = locationBarEl.querySelector('.locbar-pending');
    const confirmedDiv = locationBarEl.querySelector('.locbar-confirmed');
    const primaryLabel = locationBarEl.querySelector('#locbar-primary-label');

    // In 'known' mode, editing state has no button (cards are clicked directly)
    if (locationBarState === 'editing' && locationBarActiveView === 'known') {
      editDiv.style.display = 'none';
    } else {
      editDiv.style.display = locationBarState === 'editing' ? 'block' : 'none';
    }

    pendingDiv.style.display   = locationBarState === 'pending' ? 'block' : 'none';
    confirmedDiv.style.display = (locationBarState === 'confirmed' || locationBarState === 'loading') ? 'block' : 'none';

    if (locationBarState === 'editing') {
      if (primaryLabel) {
        primaryLabel.textContent = locationBarActiveView === 'type' ? 'LOAD LOCATION' : 'CONFIRM LOCATION';
      }
    }

    if (locationBarState === 'pending') {
      const nameLine = locationBarEl.querySelector('#locbar-name-line');
      const raLine   = locationBarEl.querySelector('#locbar-ra-line');
      const decLine  = locationBarEl.querySelector('#locbar-dec-line');
      const fovLine  = locationBarEl.querySelector('#locbar-fov-line');
      if (nameLine) nameLine.textContent = currentTargetName;
      if (raLine) raLine.textContent = formatRaHMS(probeState.ra);
      if (decLine) decLine.textContent = formatDecDMS(probeState.dec);
      const fovNum = typeof probeState.fov === 'number' ? probeState.fov : 0.20;
      if (fovLine) fovLine.textContent = `FOV ${fovNum.toFixed(2)} deg`;
    }

    // Dim the view content above the bar when confirmed
    ['sliders', 'type', 'known'].forEach(vName => {
      const vEl = views[vName];
      const contentWrapper = vEl?.querySelector('.locbar-content-wrapper');
      if (contentWrapper) {
        contentWrapper.classList.toggle('locbar-confirmed-mode', (locationBarActiveView === vName) && (locationBarState === 'confirmed' || locationBarState === 'loading'));
      }
    });

    const loadBtn = locationBarEl.querySelector('#locbar-load-btn');
    const loadLabel = locationBarEl.querySelector('#locbar-load-label');
    if (loadBtn && loadLabel) {
      if (locationBarState === 'loading') {
        loadLabel.textContent = 'LOADING...';
        loadBtn.classList.add('loading');
      } else {
        loadLabel.textContent = 'LOAD SKY IMAGES';
        loadBtn.classList.remove('loading');
      }
    }
  }

  function showNotCachedDialog(target) {
    const dialogEl = document.getElementById('hud-not-cached-dialog');
    if (!dialogEl) return;

    const coordsEl = dialogEl.querySelector('#not-cached-dialog-coords');
    if (coordsEl) {
      const decSign = target.dec >= 0 ? '+' : '';
      coordsEl.textContent = `RA ${target.ra.toFixed(3)}° // DEC ${decSign}${target.dec.toFixed(3)}° // FOV ${target.fov.toFixed(2)}°`;
    }

    const titleEl = dialogEl.querySelector('.hud-modal-title');
    const descEl = dialogEl.querySelector('.hud-modal-desc');
    const btnSimPreview = dialogEl.querySelector('#btn-dialog-sim-preview');
    const btnLiveFetch = dialogEl.querySelector('#btn-dialog-live-fetch');
    const liveContainer = dialogEl.querySelector('#dialog-live-fetch-container');
    const noticeEl = dialogEl.querySelector('#dialog-live-notice');
    const btnCancel = dialogEl.querySelector('#btn-dialog-cancel');
    const actionsEl = dialogEl.querySelector('.hud-modal-actions');

    const allowLive = getAllowLiveFetch();

    if (allowLive) {
      if (titleEl) titleEl.textContent = 'REAL DATA IS NOT PRE-LOADED FOR THIS SPOT';
      if (descEl) descEl.textContent = 'A LIVE FETCH TAKES ABOUT 1 TO 2 MINUTES AND CAN TAKE LONGER.';
      if (btnLiveFetch) {
        btnLiveFetch.style.display = 'flex';
        const span = btnLiveFetch.querySelector('span:not(.corner-tick)') || btnLiveFetch;
        span.textContent = 'FETCH REAL DATA';
      }
      if (noticeEl) noticeEl.style.display = 'none';
      if (actionsEl && liveContainer && btnSimPreview) {
        actionsEl.insertBefore(liveContainer, btnSimPreview);
      }
    } else {
      // Keep today's behavior when VITE_ALLOW_LIVE_FETCH is not true
      if (titleEl) titleEl.textContent = 'REAL DATA IS NOT PRE-LOADED FOR THIS SPOT';
      if (descEl) descEl.textContent = 'This sky location has not been pre-cached in the local SPHEREX demo survey database.';
      if (btnLiveFetch) btnLiveFetch.style.display = 'none';
      if (noticeEl) {
        noticeEl.style.display = 'block';
        noticeEl.textContent = 'Live fetching for new positions is only available on the demo laptop. Real data is pre-loaded for the 5 demo targets.';
      }
      if (actionsEl && liveContainer && btnSimPreview) {
        actionsEl.insertBefore(btnSimPreview, liveContainer);
      }
    }

    function closeDialog() {
      dialogEl.style.display = 'none';
    }

    // Button: SIMULATED PREVIEW (INSTANT)
    if (btnSimPreview) {
      btnSimPreview.onclick = () => {
        closeDialog();
        setLocBarState('editing');
        if (typeof window.setScreen === 'function') {
          window.setScreen('viewer', false);
        }
        window.dispatchEvent(new CustomEvent('argus:probe', {
          detail: {
            ra: target.ra,
            dec: target.dec,
            fov: target.fov,
            name: target.name,
            forceSimulated: true,
          },
        }));
      };
    }

    // Button: FETCH REAL DATA
    if (btnLiveFetch) {
      btnLiveFetch.onclick = () => {
        closeDialog();
        setLocBarState('editing');
        if (typeof window.setScreen === 'function') {
          window.setScreen('viewer', false);
        }
        window.dispatchEvent(new CustomEvent('argus:probe', {
          detail: {
            ra: target.ra,
            dec: target.dec,
            fov: target.fov,
            name: target.name,
            liveFetch: true,
          },
        }));
      };
    }

    if (btnCancel) {
      btnCancel.onclick = () => {
        closeDialog();
      };
    }

    dialogEl.style.display = 'flex';
  }

  function updateConfirmBarCacheStatus(ra, dec, fov) {
    const fovNum = typeof fov === 'number' ? fov : parseFloat(fov);
    const cachedMatch = findMatchingCachedTarget(ra, dec, fovNum);
    const isCached = Boolean(cachedMatch || isCachedDemoTarget(ra, dec, fovNum));

    const cacheStatusEl = locationBarEl.querySelector('#locbar-cache-status');
    const confirmedTagEl = locationBarEl.querySelector('#locbar-confirmed-tag');

    if (cacheStatusEl) {
      cacheStatusEl.textContent = isCached
        ? 'INSTANT REAL DATA'
        : 'NO PRE-LOADED DATA, SIMULATED PREVIEW OR SLOW LIVE FETCH';
      cacheStatusEl.className = isCached ? 'locbar-cache-status cached' : 'locbar-cache-status not-cached';
    }
    if (confirmedTagEl) {
      confirmedTagEl.textContent = isCached
        ? '✓ LOCATION CONFIRMED — INSTANT REAL DATA'
        : '✓ LOCATION CONFIRMED — NO PRE-LOADED DATA, SIMULATED PREVIEW OR SLOW LIVE FETCH';
      confirmedTagEl.className = isCached ? 'locbar-confirmed-tag cached' : 'locbar-confirmed-tag not-cached';
    }
  }

  function setLocBarState(newState) {
    if (newState !== 'loading' && activeHudAbortController) {
      activeHudAbortController.abort();
      activeHudAbortController = null;
    }
    locationBarState = newState;
    renderLocBar();

    if (newState === 'confirmed') {
      updateConfirmBarCacheStatus(probeState.ra, probeState.dec, probeState.fov);
    }

    const markerEl = document.getElementById('probe-sky-marker');
    if (markerEl) {
      if (newState === 'confirmed') {
        markerEl.classList.remove('locked');
        void markerEl.offsetWidth; // force reflow
        markerEl.classList.add('locked');
      } else {
        markerEl.classList.remove('locked');
      }
    }
  }

  function attachLocBarEvents() {
    // Primary button (editing state)
    const primaryBtn = locationBarEl.querySelector('#locbar-primary-btn');
    primaryBtn?.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (locationBarActiveView === 'type') {
        // Validate type inputs first
        const valid = validateTypeInputs();
        if (!valid) return;
        probeState.ra = valid.ra;
        probeState.dec = valid.dec;
        probeState.fov = 0.20;
        currentTargetName = 'TYPED COORDS';
        setLocBarState('pending');
        if (sky && typeof sky.flyTo === 'function') {
          await sky.flyTo(probeState.ra, probeState.dec, 900);
        }
        return;
      } else if (locationBarActiveView === 'sliders') {
        probeState.fov = 0.20;
      } else if (locationBarActiveView === 'known') {
        // known: primary btn not really used (cards trigger)
        return;
      }
      // sliders: go to pending
      setLocBarState('pending');
    });

    // Confirm button (pending state)
    const confirmBtn = locationBarEl.querySelector('#locbar-confirm-btn');
    confirmBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      setLocBarState('confirmed');
    });

    // Change button (pending → editing)
    const changeBtn = locationBarEl.querySelector('#locbar-change-btn');
    changeBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      setLocBarState('editing');
    });

    // Load button (confirmed → loading → editing)
    const loadBtn = locationBarEl.querySelector('#locbar-load-btn');
    loadBtn?.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (locationBarState !== 'confirmed') return;
      setLocBarState('loading');

      let fovValue = typeof probeState.fov === 'number' ? probeState.fov : 0.20;
      let raValue = probeState.ra;
      let decValue = probeState.dec;
      let targetName = currentTargetName;

      // If coordinates are within 0.005 degrees of a cached target AND FOV matches, snap to cached target
      const cachedMatch = findMatchingCachedTarget(raValue, decValue, fovValue);
      if (cachedMatch) {
        raValue = cachedMatch.ra;
        decValue = cachedMatch.dec;
        fovValue = cachedMatch.fov;
        if (!targetName || targetName === 'CUSTOM SPOT' || targetName === 'TYPED COORDS') {
          targetName = cachedMatch.name;
        }
      }

      const currentSelected = {
        name: targetName,
        ra: raValue,
        dec: decValue,
        fov: fovValue,
        ...(currentTarget || {}),
      };
      setSelectedTarget(currentSelected);
      if (typeof window !== 'undefined') {
        window.selectedTarget = currentSelected;
        window.__selectedTarget = currentSelected;
        window.currentTarget = currentSelected;
      }

      // 3. If VITE_API_BASE is empty:
      const apiBase = getApiBase();
      if (!apiBase) {
        setLocBarState('editing');
        if (typeof window.setScreen === 'function') {
          window.setScreen('viewer', false);
        }
        window.dispatchEvent(new CustomEvent('argus:probe', {
          detail: {
            ra: raValue,
            dec: decValue,
            fov: fovValue,
            name: targetName,
            forceSimulated: true,
          },
        }));
        return;
      }

      if (activeHudAbortController) {
        activeHudAbortController.abort();
      }
      activeHudAbortController = new AbortController();
      const signal = activeHudAbortController.signal;

      // Call getFrames with cachedOnly
      try {
        const result = await getFrames(raValue, decValue, fovValue, {
          cachedOnly: true,
          name: targetName,
          signal,
          onProgress: (info) => {
            if (info && (info.status === 'fetching' || typeof info === 'object')) {
              const msg = info.message || 'FETCHING REAL DATA...';
              const sec = typeof info.elapsed_seconds === 'number' ? Math.max(0, Math.floor(info.elapsed_seconds)) : 0;
              const mins = Math.floor(sec / 60);
              const secs = sec % 60;
              const elapsedStr = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

              const cacheStatusEl = locationBarEl.querySelector('#locbar-cache-status');
              if (cacheStatusEl) {
                cacheStatusEl.textContent = `${msg} [${elapsedStr}]`;
              }
              const loadLabel = locationBarEl.querySelector('#locbar-load-label');
              if (loadLabel) {
                loadLabel.textContent = `${msg} (${elapsedStr})`;
              }
            }
          },
        });

        // Succeeded! Continue as now (badge SPHEREX DATA)
        setLocBarState('editing');
        if (typeof window.setScreen === 'function') {
          window.setScreen('viewer', false);
        }
        window.dispatchEvent(new CustomEvent('argus:probe', {
          detail: {
            ra: raValue,
            dec: decValue,
            fov: fovValue,
            name: targetName,
            preloadedResult: result,
          },
        }));
      } catch (err) {
        if (signal.aborted || err.name === 'AbortError') {
          return;
        }
        if (err.isNotCached || err.status === 404) {
          // Server answered 404 "not cached": show HUD dialog
          setLocBarState('confirmed');
          showNotCachedDialog({
            ra: raValue,
            dec: decValue,
            fov: fovValue,
            name: targetName,
          });
        } else {
          // Backend unreachable or network error: go straight to simulated preview with the label
          console.warn('Backend unreachable or error, falling back straight to simulated preview:', err);
          setLocBarState('editing');
          if (typeof window.setScreen === 'function') {
            window.setScreen('viewer', false);
          }
          window.dispatchEvent(new CustomEvent('argus:probe', {
            detail: {
              ra: raValue,
              dec: decValue,
              fov: fovValue,
              name: targetName,
              forceSimulated: true,
            },
          }));
        }
      }
    });

    // Edit Location button (confirmed → pending)
    const editBtn = locationBarEl.querySelector('#locbar-edit-btn');
    editBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      setLocBarState('pending');
    });
  }

  attachLocBarEvents();

  function injectLocBar(viewName) {
    locationBarActiveView = viewName;
    const container = locBarContainers[viewName];
    if (container) {
      container.appendChild(locationBarEl);
    }
    renderLocBar();
  }

  function setPanelView(targetView, animate = true) {
    if (!views[targetView]) return;

    if (targetView === 'sliders' || targetView === 'type' || targetView === 'known') {
      lastActiveMode = targetView;
      if (targetView === 'sliders' || targetView === 'type') {
        probeState.fov = 0.20;
      }
      // Reset location bar to editing when switching modes (but not on back)
      setLocBarState('editing');
      injectLocBar(targetView);
    }

    if (sky && typeof sky.registerUserInput === 'function') {
      sky.registerUserInput();
    }
    if (sky && typeof sky.setTargetExists === 'function') {
      sky.setTargetExists(targetView !== 'menu');
    }

    const prevEl = views[currentPanelView];
    const nextEl = views[targetView];
    currentPanelView = targetView;

    if (!animate) {
      Object.values(views).forEach(v => {
        if (v) v.style.display = 'none';
      });
      nextEl.style.display = 'flex';
      syncCurrentViewUI();
      return;
    }

    // 250ms slide + fade with tiny glitch jitter
    if (prevEl && prevEl !== nextEl) {
      prevEl.style.opacity = '0';
      prevEl.style.transform = 'translateX(-10px)';
      setTimeout(() => {
        prevEl.style.display = 'none';
        prevEl.style.opacity = '1';
        prevEl.style.transform = 'translateX(0)';

        nextEl.style.display = 'flex';
        nextEl.classList.add('glitch-transitioning');
        syncCurrentViewUI();
        setTimeout(() => {
          nextEl.classList.remove('glitch-transitioning');
        }, 250);
      }, 150);
    } else {
      nextEl.style.display = 'flex';
      syncCurrentViewUI();
    }
  }

  function syncCurrentViewUI() {
    if (currentPanelView === 'sliders') {
      syncSlidersUI();
    } else if (currentPanelView === 'type') {
      syncTypeUI();
    }
  }

  // ── A. MENU CONTROLLER ──────────────────────────────────────────────────────
  document.querySelectorAll('.probe-menu-card').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.getAttribute('data-mode');
      setPanelView(mode);
    });
  });

  const btnMenuBack = document.getElementById('btn-menu-back');
  if (btnMenuBack) {
    btnMenuBack.addEventListener('click', () => {
      runBackToLandingSequence(btnMenuBack);
    });
  }

  // "CHANGE MODE" Links & Back buttons
  document.querySelectorAll('.probe-change-mode-link, #btn-sliders-back, #btn-type-back, #btn-known-back').forEach(btn => {
    btn.addEventListener('click', () => {
      setLocBarState('editing');
      setPanelView('menu');
    });
  });

  // ── B. SLIDERS CONTROLLER (Custom Pointer-Captured Sliders) ─────────────────
  const sliderRaHitarea   = document.getElementById('slider-ra-hitarea');
  const sliderRaTrack     = document.getElementById('slider-ra-track');
  const sliderRaFill      = document.getElementById('slider-ra-fill');
  const sliderRaThumb     = document.getElementById('slider-ra-thumb');
  const sliderReadoutRa   = document.getElementById('slider-readout-val-ra');
  const btnSliderUnitRa   = document.getElementById('slider-btn-unit-ra');
  const sliderUnitH       = document.getElementById('slider-unit-h');
  const sliderUnitDeg     = document.getElementById('slider-unit-deg');
  const btnRaStepMinus    = document.getElementById('btn-ra-step-minus');
  const btnRaStepPlus     = document.getElementById('btn-ra-step-plus');

  const sliderDecHitarea  = document.getElementById('slider-dec-hitarea');
  const sliderDecTrack    = document.getElementById('slider-dec-track');
  const sliderDecFill     = document.getElementById('slider-dec-fill');
  const sliderDecThumb    = document.getElementById('slider-dec-thumb');
  const sliderReadoutDec  = document.getElementById('slider-readout-val-dec');
  const btnDecStepMinus   = document.getElementById('btn-dec-step-minus');
  const btnDecStepPlus    = document.getElementById('btn-dec-step-plus');

  const slidersReadoutRa  = document.getElementById('sliders-readout-ra');
  const slidersReadoutDec = document.getElementById('sliders-readout-dec');
  const slidersBtnInfo    = document.getElementById('sliders-btn-info');
  const slidersInfoBox    = document.getElementById('sliders-info-box');
  const btnSlidersLoad    = document.getElementById('btn-sliders-load');

  function syncSlidersUI({ sync3D = true } = {}) {
    const hours = (probeState.ra % 360) / 15;
    const raFraction = raUnit === 'h' ? hours / 24 : (probeState.ra % 360) / 360;
    const raPct = Math.max(0, Math.min(100, raFraction * 100));

    if (sliderRaFill) sliderRaFill.style.width = raPct.toFixed(2) + '%';
    if (sliderRaThumb) sliderRaThumb.style.left = raPct.toFixed(2) + '%';

    if (sliderReadoutRa) {
      if (raUnit === 'h') {
        sliderReadoutRa.textContent = (hours < 10 ? '0' : '') + hours.toFixed(2);
      } else {
        sliderReadoutRa.textContent = probeState.ra.toFixed(2);
      }
    }

    const decFraction = (probeState.dec + 90) / 180;
    const decPct = Math.max(0, Math.min(100, decFraction * 100));

    if (sliderDecFill) sliderDecFill.style.width = decPct.toFixed(2) + '%';
    if (sliderDecThumb) sliderDecThumb.style.left = decPct.toFixed(2) + '%';

    if (sliderReadoutDec) {
      sliderReadoutDec.textContent = (probeState.dec >= 0 ? '+' : '') + probeState.dec.toFixed(2);
    }

    if (slidersReadoutRa) slidersReadoutRa.textContent = formatRaHMS(probeState.ra);
    if (slidersReadoutDec) slidersReadoutDec.textContent = formatDecDMS(probeState.dec);

    if (sync3D && sky && typeof sky.setProbeCoordinates === 'function') {
      sky.setProbeCoordinates(probeState.ra, probeState.dec);
    }

    // Rate counter
    sliderUpdateCount++;
    const now = performance.now();
    if (now - lastSliderUpdateSec >= 1000) {
      sliderUpdatesPerSec = sliderUpdateCount;
      sliderUpdateCount = 0;
      lastSliderUpdateSec = now;
    }
  }

  // Pointer-capture slider helper
  function setupPointerSlider(hitarea, track, thumb, onFractionChange) {
    if (!hitarea || !track || !thumb) return;
    let isTracking = false;

    function handlePointer(clientX) {
      const rect = track.getBoundingClientRect();
      if (!rect.width) return;
      const frac = clamp((clientX - rect.left) / rect.width, 0, 1);
      if (sky && typeof sky.registerUserInput === 'function') sky.registerUserInput();
      onFractionChange(frac);
    }

    function onPointerDown(e) {
      e.stopPropagation();
      e.preventDefault();
      isTracking = true;
      probeState.isUserDraggingSlider = true;
      hitarea.classList.add('dragging');
      try {
        thumb.setPointerCapture(e.pointerId);
      } catch (_) {
        try { hitarea.setPointerCapture(e.pointerId); } catch (_) {}
      }
      handlePointer(e.clientX);
    }

    function onPointerMove(e) {
      if (!isTracking) return;
      e.stopPropagation();
      handlePointer(e.clientX);
    }

    function onPointerUp(e) {
      if (!isTracking) return;
      isTracking = false;
      probeState.isUserDraggingSlider = false;
      hitarea.classList.remove('dragging');
      try { thumb.releasePointerCapture(e.pointerId); } catch (_) {}
      try { hitarea.releasePointerCapture(e.pointerId); } catch (_) {}
    }

    thumb.addEventListener('pointerdown', onPointerDown);
    track.addEventListener('pointerdown', onPointerDown);
    hitarea.addEventListener('pointerdown', onPointerDown);

    thumb.addEventListener('pointermove', onPointerMove);
    track.addEventListener('pointermove', onPointerMove);
    hitarea.addEventListener('pointermove', onPointerMove);

    thumb.addEventListener('pointerup', onPointerUp);
    thumb.addEventListener('pointercancel', onPointerUp);
    track.addEventListener('pointerup', onPointerUp);
    track.addEventListener('pointercancel', onPointerUp);
    hitarea.addEventListener('pointerup', onPointerUp);
    hitarea.addEventListener('pointercancel', onPointerUp);

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  }

  // RA Slider dragging
  setupPointerSlider(sliderRaHitarea, sliderRaTrack, sliderRaThumb, (frac) => {
    if (raUnit === 'h') {
      const h = frac * 24;
      probeState.ra = ((h * 15 % 360) + 360) % 360;
    } else {
      probeState.ra = frac * 360;
    }
    probeState.fov = 0.20;
    currentTargetName = 'CUSTOM SPOT';
    syncSlidersUI();
  });

  // DEC Slider dragging
  setupPointerSlider(sliderDecHitarea, sliderDecTrack, sliderDecThumb, (frac) => {
    probeState.dec = clamp(-90 + frac * 180, -90, 90);
    probeState.fov = 0.20;
    currentTargetName = 'CUSTOM SPOT';
    syncSlidersUI();
  });

  // Unit toggle
  if (btnSliderUnitRa) {
    btnSliderUnitRa.addEventListener('click', () => {
      if (sky && typeof sky.registerUserInput === 'function') sky.registerUserInput();
      if (raUnit === 'h') {
        raUnit = 'deg';
        sliderUnitH?.classList.replace('unit-active', 'unit-inactive');
        sliderUnitDeg?.classList.replace('unit-inactive', 'unit-active');
      } else {
        raUnit = 'h';
        sliderUnitH?.classList.replace('unit-inactive', 'unit-active');
        sliderUnitDeg?.classList.replace('unit-active', 'unit-inactive');
      }
      syncSlidersUI();
    });
  }

  // Fine-step +/- buttons with hold-and-repeat
  setupStepper(btnRaStepMinus, (mult) => {
    const stepDeg = (raUnit === 'h' ? 0.15 : 0.1) * mult;
    probeState.ra = ((probeState.ra - stepDeg) % 360 + 360) % 360;
    probeState.fov = 0.20;
    currentTargetName = 'CUSTOM SPOT';
    syncSlidersUI();
  });
  setupStepper(btnRaStepPlus, (mult) => {
    const stepDeg = (raUnit === 'h' ? 0.15 : 0.1) * mult;
    probeState.ra = ((probeState.ra + stepDeg) % 360 + 360) % 360;
    probeState.fov = 0.20;
    currentTargetName = 'CUSTOM SPOT';
    syncSlidersUI();
  });
  setupStepper(btnDecStepMinus, (mult) => {
    probeState.dec = clamp(probeState.dec - 0.05 * mult, -90, 90);
    probeState.fov = 0.20;
    currentTargetName = 'CUSTOM SPOT';
    syncSlidersUI();
  });
  setupStepper(btnDecStepPlus, (mult) => {
    probeState.dec = clamp(probeState.dec + 0.05 * mult, -90, 90);
    probeState.fov = 0.20;
    currentTargetName = 'CUSTOM SPOT';
    syncSlidersUI();
  });

  // Keyboard navigation for sliders
  window.addEventListener('keydown', (e) => {
    if (currentPanelView !== 'sliders') return;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;

    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'PageUp' || e.key === 'PageDown') {
      if (sky && typeof sky.registerUserInput === 'function') sky.registerUserInput();
      const mult = (e.key === 'PageUp' || e.key === 'PageDown') ? 10 : 1;
      const dir = (e.key === 'ArrowRight' || e.key === 'PageUp') ? 1 : -1;
      const stepDeg = (raUnit === 'h' ? 0.01 * 15 : 0.1) * mult;
      probeState.ra = ((probeState.ra + dir * stepDeg) % 360 + 360) % 360;
      probeState.fov = 0.20;
      syncSlidersUI();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (sky && typeof sky.registerUserInput === 'function') sky.registerUserInput();
      const dir = e.key === 'ArrowUp' ? 1 : -1;
      probeState.dec = clamp(probeState.dec + dir * 0.1, -90, 90);
      probeState.fov = 0.20;
      syncSlidersUI();
    }
  });

  // Info toggle
  slidersBtnInfo?.addEventListener('click', () => {
    if (sky && typeof sky.registerUserInput === 'function') sky.registerUserInput();
    const isHidden = slidersInfoBox.style.display === 'none' || !slidersInfoBox.style.display;
    slidersInfoBox.style.display = isHidden ? 'block' : 'none';
    slidersBtnInfo.classList.toggle('active', isHidden);
  });

  // "LOAD SKY IMAGES" in sliders mode -> now handled by location bar

  // ── C. TYPE COORDS CONTROLLER (76px Boxes & Steppers) ───────────────────────
  const typeInputRa     = document.getElementById('type-input-ra');
  const typeInputDec    = document.getElementById('type-input-dec');
  const btnTypeUnitRa   = document.getElementById('type-btn-unit-ra');
  const typeUnitH       = document.getElementById('type-unit-h');
  const typeUnitDeg     = document.getElementById('type-unit-deg');
  const btnTypeRaUp     = document.getElementById('btn-type-ra-up');
  const btnTypeRaDown   = document.getElementById('btn-type-ra-down');
  const btnTypeDecUp    = document.getElementById('btn-type-dec-up');
  const btnTypeDecDown  = document.getElementById('btn-type-dec-down');
  const typeErrorMsg    = document.getElementById('type-error-msg');
  const typeExampleLine = document.getElementById('type-example-line');
  const btnTypeLoad     = document.getElementById('btn-type-load');

  function syncTypeUI() {
    if (typeInputRa) {
      if (raUnit === 'h') {
        const h = (probeState.ra % 360) / 15;
        typeInputRa.value = (h < 10 ? '0' : '') + h.toFixed(2);
      } else {
        typeInputRa.value = probeState.ra.toFixed(2);
      }
    }
    if (typeInputDec) {
      typeInputDec.value = (probeState.dec >= 0 ? '+' : '') + probeState.dec.toFixed(2);
    }
    clearTypeError();
  }

  function setTypeError(msg) {
    if (typeErrorMsg) {
      typeErrorMsg.textContent = msg;
      typeErrorMsg.style.display = 'block';
    }
  }

  function clearTypeError() {
    if (typeErrorMsg) {
      typeErrorMsg.textContent = '';
      typeErrorMsg.style.display = 'none';
    }
    typeInputRa?.parentElement?.classList.remove('error');
    typeInputDec?.parentElement?.classList.remove('error');
    typeInputRa?.classList.remove('error');
    typeInputDec?.classList.remove('error');
  }

  function validateTypeInputs() {
    clearTypeError();
    const valRa = parseFloat(typeInputRa?.value.trim());
    const valDec = parseFloat(typeInputDec?.value.trim());

    if (isNaN(valRa)) {
      setTypeError('INVALID RA VALUE');
      typeInputRa?.classList.add('error');
      typeInputRa?.parentElement?.classList.add('error');
      return null;
    }
    if (raUnit === 'h' && (valRa < 0 || valRa > 24)) {
      setTypeError('RA OUT OF RANGE: 0 TO 24 h');
      typeInputRa?.classList.add('error');
      typeInputRa?.parentElement?.classList.add('error');
      return null;
    }
    if (raUnit === 'deg' && (valRa < 0 || valRa > 360)) {
      setTypeError('RA OUT OF RANGE: 0 TO 360 deg');
      typeInputRa?.classList.add('error');
      typeInputRa?.parentElement?.classList.add('error');
      return null;
    }

    if (isNaN(valDec)) {
      setTypeError('INVALID DEC VALUE');
      typeInputDec?.classList.add('error');
      typeInputDec?.parentElement?.classList.add('error');
      return null;
    }
    if (valDec < -90 || valDec > 90) {
      setTypeError('DEC OUT OF RANGE: -90 TO +90 deg');
      typeInputDec?.classList.add('error');
      typeInputDec?.parentElement?.classList.add('error');
      return null;
    }

    const degRa = raUnit === 'h' ? valRa * 15 : valRa;
    return { ra: degRa, dec: valDec };
  }

  // Stepper Hold & Repeat Helper
  function setupStepper(btn, onStep) {
    if (!btn) return;
    let timer = null;
    let stepCount = 0;
    let shiftHeld = false;

    function doStep() {
      if (sky && typeof sky.registerUserInput === 'function') sky.registerUserInput();
      const mult = shiftHeld ? 10 : 1;
      onStep(mult);
    }

    btn.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      shiftHeld = e.shiftKey;
      try { btn.setPointerCapture(e.pointerId); } catch (_) {}
      doStep();
      stepCount = 0;

      timer = setTimeout(function repeat() {
        stepCount++;
        doStep();
        const t = Math.min(1, stepCount / 15);
        const interval = 83.3 - t * (83.3 - 25);
        timer = setTimeout(repeat, interval);
      }, 400);
    });

    const stop = (e) => {
      if (timer) { clearTimeout(timer); timer = null; }
      try { btn.releasePointerCapture(e.pointerId); } catch (_) {}
    };
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointerleave', stop);
    btn.addEventListener('pointercancel', stop);
    btn.addEventListener('lostpointercapture', stop);
    window.addEventListener('pointerup', stop);

    window.addEventListener('keydown', (e) => { if (e.key === 'Shift') shiftHeld = true; });
    window.addEventListener('keyup', (e) => { if (e.key === 'Shift') shiftHeld = false; });
  }

  setupStepper(btnTypeRaUp, (mult) => {
    const step = 0.01 * mult;
    const cur = parseFloat(typeInputRa?.value) || 0;
    const next = cur + step;
    const max = raUnit === 'h' ? 24 : 360;
    const clamped = Math.min(max, next);
    if (typeInputRa) typeInputRa.value = (clamped < 10 && raUnit === 'h' ? '0' : '') + clamped.toFixed(2);
    clearTypeError();
  });

  setupStepper(btnTypeRaDown, (mult) => {
    const step = 0.01 * mult;
    const cur = parseFloat(typeInputRa?.value) || 0;
    const next = cur - step;
    const clamped = Math.max(0, next);
    if (typeInputRa) typeInputRa.value = (clamped < 10 && raUnit === 'h' ? '0' : '') + clamped.toFixed(2);
    clearTypeError();
  });

  setupStepper(btnTypeDecUp, (mult) => {
    const step = 0.01 * mult;
    const cur = parseFloat(typeInputDec?.value) || 0;
    const next = Math.min(90, cur + step);
    if (typeInputDec) typeInputDec.value = (next >= 0 ? '+' : '') + next.toFixed(2);
    clearTypeError();
  });

  setupStepper(btnTypeDecDown, (mult) => {
    const step = 0.01 * mult;
    const cur = parseFloat(typeInputDec?.value) || 0;
    const next = Math.max(-90, cur - step);
    if (typeInputDec) typeInputDec.value = (next >= 0 ? '+' : '') + next.toFixed(2);
    clearTypeError();
  });

  // Wheel & Arrow keys on Type Inputs
  [typeInputRa, typeInputDec].forEach(input => {
    if (!input) return;
    input.addEventListener('wheel', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (sky && typeof sky.registerUserInput === 'function') sky.registerUserInput();
      const mult = e.shiftKey ? 10 : 1;
      const dir = e.deltaY < 0 ? 1 : -1;
      const step = 0.01 * mult * dir;
      const cur = parseFloat(input.value) || 0;
      input.value = (cur + step).toFixed(2);
      clearTypeError();
    }, { passive: false });

    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (sky && typeof sky.registerUserInput === 'function') sky.registerUserInput();
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const mult = e.shiftKey ? 10 : 1;
        const dir = e.key === 'ArrowUp' ? 1 : -1;
        const step = 0.01 * mult * dir;
        const cur = parseFloat(input.value) || 0;
        input.value = (cur + step).toFixed(2);
        clearTypeError();
      }
    });
  });

  // Unit toggle for Type Coords
  btnTypeUnitRa?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (sky && typeof sky.registerUserInput === 'function') sky.registerUserInput();
    if (raUnit === 'h') {
      raUnit = 'deg';
      typeUnitH?.classList.replace('unit-active', 'unit-inactive');
      typeUnitDeg?.classList.replace('unit-inactive', 'unit-active');
    } else {
      raUnit = 'h';
      typeUnitH?.classList.replace('unit-inactive', 'unit-active');
      typeUnitDeg?.classList.replace('unit-active', 'unit-inactive');
    }
    syncTypeUI();
  });

  // Clickable example line
  typeExampleLine?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (sky && typeof sky.registerUserInput === 'function') sky.registerUserInput();
    probeState.ra = 133.795; // 08.92 h
    probeState.dec = -7.25;
    probeState.fov = 0.20;
    currentTargetName = 'WISE 0855';
    syncTypeUI();
  });

  // "LOAD LOCATION" button -> now handled by location bar primary button

  // ── D. PICK A TARGET CONTROLLER (5 Stacked 68px Cards) ──────────────────────
  const probeKnownList = document.getElementById('probe-known-list');
  if (probeKnownList) {
    probeKnownList.innerHTML = '';
    Object.values(TARGETS).forEach(t => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'probe-target-card';
      const hours = (t.ra / 15).toFixed(2);
      const decSign = t.dec >= 0 ? '+' : '';
      card.innerHTML = `
        <div class="target-card-info">
          <div class="target-card-name">
            <span>${t.name}</span>
            <span class="target-card-tag-instant">INSTANT</span>
          </div>
          <div class="target-card-profile">${t.profile || 'MISSION TARGET'}</div>
        </div>
        <div class="target-card-coords">
          <span>RA ${hours}h</span>
          <span>DEC ${decSign}${t.dec.toFixed(2)}°</span>
          <span>FOV ${t.fov.toFixed(2)}°</span>
        </div>
      `;
      card.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (sky && typeof sky.registerUserInput === 'function') sky.registerUserInput();
        probeKnownList.querySelectorAll('.probe-target-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');

        const targetObj = { ...t };
        setSelectedTarget(targetObj);
        if (typeof window !== 'undefined') {
          window.selectedTarget = targetObj;
          window.__selectedTarget = targetObj;
          window.currentTarget = targetObj;
        }
        currentTarget = targetObj;
        currentTargetName = t.name;
        probeState.ra = t.ra;
        probeState.dec = t.dec;
        probeState.fov = t.fov;

        setLocBarState('pending');
        if (sky && typeof sky.flyTo === 'function') {
          await sky.flyTo(probeState.ra, probeState.dec, 900);
        }
      });
      probeKnownList.appendChild(card);
    });
  }

  // ── E. CONFIRM LOCATION — now handled by location bar state machine ──────────

  // Listen to probemarkerchange event from 3D sphere drag (only if user is not actively dragging slider)
  window.addEventListener('probemarkerchange', (e) => {
    if (probeState.isUserDraggingSlider) return;
    const { ra, dec } = e.detail;
    probeState.ra = ra;
    probeState.dec = dec;
    probeState.fov = 0.20;
    currentTargetName = 'CUSTOM SPOT';
    syncCurrentViewUI();
  });

  // ── URL Hash Support (#probe&ra=..&dec=..) ──────────────────────────────────
  function checkUrlHash() {
    const hash = window.location.hash;
    if (hash.startsWith('#probe')) {
      const paramsPart = hash.replace(/^#probe[?&]?/, '');
      if (paramsPart) {
        const urlParams = new URLSearchParams(paramsPart.replace(/&/g, '&'));
        const rVal = urlParams.get('ra');
        const dVal = urlParams.get('dec');
        if (rVal !== null && !isNaN(parseFloat(rVal))) {
          probeState.ra = ((parseFloat(rVal) % 360) + 360) % 360;
        }
        if (dVal !== null && !isNaN(parseFloat(dVal))) {
          probeState.dec = Math.max(-90, Math.min(90, parseFloat(dVal)));
        }
      }
      syncCurrentViewUI();
      setScreen('probe', false);
    } else if (hash.startsWith('#viewer') || window.location.search.includes('ra=')) {
      // Handled by viewer
      return;
    } else {
      setScreen('landing', false);
    }
  }

  window.addEventListener('hashchange', checkUrlHash);
  syncCurrentViewUI();
  checkUrlHash();

  // Expose HUD helpers for verification
  window.__argusHUD = {
    getPanelView: () => currentPanelView,
    setPanelView: (v) => setPanelView(v),
    getLastActiveMode: () => lastActiveMode,
    getCoords: () => ({ ra: probeState.ra, dec: probeState.dec, fov: probeState.fov, name: currentTargetName }),
    getProbeState: () => probeState,
    getLocBarState: () => locationBarState,
    setLocBarState: (s) => setLocBarState(s),
    getSelectedTarget: () => window.selectedTarget || currentTarget,
    showNotCachedDialog,
    updateConfirmBarCacheStatus,
    getSliderUpdatesPerSec: () => sliderUpdatesPerSec,
    triggerBackToLanding: () => runBackToLandingSequence(btnMenuBack),
  };

  // ── HUD Master Animation Loop (60fps, paused on tab hidden) ────────────────
  let hudFrameId;
  let nextFlickerTime = 0;

  function hudLoop(now) {
    hudFrameId = requestAnimationFrame(hudLoop);

    if (document.hidden) return;

    // 5. Live UTC Clock
    if (elUtcClock) {
      const d = new Date();
      elUtcClock.textContent = 'UTC ' + d.toISOString().substr(11, 12);
    }

    // 1. Flicker Pixels
    if (flickerController) flickerController.render(now);

    // 1b. Grain & Glitch
    if (grainController) grainController.render(now);

    // Subtle 1-2% whole-screen brightness flicker
    if (wrap && now > nextFlickerTime) {
      nextFlickerTime = now + randRange(150, 450);
      wrap.classList.toggle('screen-flicker-active', Math.random() < 0.22);
    }

    // 3. Monospace Data Streams
    if (dataStreams) dataStreams.update(now);

    // 3b. Floating Readouts
    if (floatingReadouts) floatingReadouts.update(now);

    // 7. Text Glitch
    if (textGlitch) textGlitch.update(now);
  }

  hudLoop(performance.now());

  return {
    selectTarget,
    runIntroAnimations,
    setScreen,
    dispose: () => cancelAnimationFrame(hudFrameId),
  };
}
