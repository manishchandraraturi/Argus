import { getFrames, API_BASE, getApiBase, getSelectedTarget, setSelectedTarget, findMatchingCachedTarget } from './api.js';
import { generateSimFrames } from './simFrames.js';
import { TARGETS, getDefaultPairForTarget, getCaptionForTarget, getTargetInfo, isCachedDemoTarget } from './targets.js';
import { FEATURES, VIGNETTE_DEFAULT } from './config.js';
import validationData from './validation.json';

// ─── Coordinate Formatting Utilities ──────────────────────────────────────────
export function formatRA(raDeg) {
  const norm = ((raDeg % 360) + 360) % 360;
  const totalHours = norm / 15;
  const h = Math.floor(totalHours);
  const m = Math.floor((totalHours - h) * 60);
  const s = ((totalHours - h) * 60 - m) * 60;
  const pad = (n) => String(n).padStart(2, '0');
  const hms = `${pad(h)}h ${pad(m)}m ${s.toFixed(1).padStart(4, '0')}s`;
  return `${hms} (${norm.toFixed(3)}°)`;
}

export function formatDec(decDeg) {
  const sign = decDeg >= 0 ? '+' : '-';
  const abs = Math.abs(decDeg);
  const d = Math.floor(abs);
  const m = Math.floor((abs - d) * 60);
  const s = ((abs - d) * 60 - m) * 60;
  const pad = (n) => String(n).padStart(2, '0');
  const dms = `${sign}${pad(d)}° ${pad(m)}' ${s.toFixed(1).padStart(4, '0')}"`;
  return `${dms} (${decDeg.toFixed(3)}°)`;
}

// ─── Difference Image & Client-side Candidate Finder ─────────────────────────
export function computeDifference(imageDataA, imageDataB, gain = 2.0) {
  const W = 600;
  const H = 600;
  const totalPixels = W * H;

  const rawDiff = new Float32Array(totalPixels);
  const diffCanvas = document.createElement('canvas');
  diffCanvas.width = W;
  diffCanvas.height = H;
  const diffCtx = diffCanvas.getContext('2d');
  const outImgData = diffCtx.createImageData(W, H);
  const outData = outImgData.data;

  const dataA = imageDataA.data;
  const dataB = imageDataB.data;

  for (let i = 0; i < totalPixels; i++) {
    const p = i * 4;
    // Luminance subtraction |B - A|
    const diff = Math.abs(dataB[p] - dataA[p]);
    rawDiff[i] = diff;
    const amplified = Math.min(255, Math.round(diff * gain));
    outData[p]     = amplified;
    outData[p + 1] = amplified;
    outData[p + 2] = amplified;
    outData[p + 3] = 255;
  }
  diffCtx.putImageData(outImgData, 0, 0);

  // 1. Separable 5x5 Gaussian/box blur
  const blurred = new Float32Array(totalPixels);
  const temp = new Float32Array(totalPixels);

  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      let sum = 0, count = 0;
      for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx;
        if (nx >= 0 && nx < W) {
          sum += rawDiff[row + nx];
          count++;
        }
      }
      temp[row + x] = sum / count;
    }
  }

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let sum = 0, count = 0;
      for (let dy = -2; dy <= 2; dy++) {
        const ny = y + dy;
        if (ny >= 0 && ny < H) {
          sum += temp[ny * W + x];
          count++;
        }
      }
      blurred[y * W + x] = sum / count;
    }
  }

  // 2. Mean and standard deviation (sigma)
  let sum = 0;
  for (let i = 0; i < totalPixels; i++) {
    sum += blurred[i];
  }
  const mean = sum / totalPixels;

  let varSum = 0;
  for (let i = 0; i < totalPixels; i++) {
    const d = blurred[i] - mean;
    varSum += d * d;
  }
  const sigma = Math.sqrt(varSum / totalPixels);
  const threshold = mean + 4.0 * Math.max(sigma, 0.5);

  // 3. Find local maxima separated by at least 12px
  const rawCandidates = [];
  const margin = 15;

  for (let y = margin; y < H - margin; y++) {
    const row = y * W;
    for (let x = margin; x < W - margin; x++) {
      const val = blurred[row + x];
      if (val <= threshold) continue;

      let isLocalMax = true;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (blurred[(y + dy) * W + (x + dx)] > val) {
            isLocalMax = false;
            break;
          }
        }
        if (!isLocalMax) break;
      }

      if (isLocalMax) {
        rawCandidates.push({
          x,
          y,
          value: val,
          sigmaAbove: ((val - mean) / Math.max(sigma, 0.1)).toFixed(1),
        });
      }
    }
  }

  // Sort descending by intensity
  rawCandidates.sort((a, b) => b.value - a.value);

  // Non-maximum suppression with 12px distance threshold (keep at most 5 strongest)
  const candidates = [];
  for (const cand of rawCandidates) {
    const isClose = candidates.some(existing => {
      return Math.hypot(cand.x - existing.x, cand.y - existing.y) < 12;
    });
    if (!isClose) {
      candidates.push({
        id: candidates.length + 1,
        ...cand,
      });
      if (candidates.length >= 5) break;
    }
  }

  // Compute test metrics: mean in star-free area vs at candidate mover
  let starFreeSum = 0;
  let starFreeCount = 0;
  // Sample top-left corner area (10 to 60, 10 to 60)
  for (let sy = 10; sy < 60; sy++) {
    for (let sx = 10; sx < 60; sx++) {
      starFreeSum += rawDiff[sy * W + sx];
      starFreeCount++;
    }
  }
  const starFreeMean = starFreeSum / Math.max(1, starFreeCount);

  let moverMean = 0;
  if (candidates.length > 0) {
    const c = candidates[0];
    let mSum = 0;
    let mCount = 0;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        mSum += rawDiff[(c.y + dy) * W + (c.x + dx)];
        mCount++;
      }
    }
    moverMean = mSum / Math.max(1, mCount);
  }

  return {
    diffCanvas,
    candidates,
    mean,
    sigma,
    threshold,
    metrics: {
      starFreeMean: parseFloat(starFreeMean.toFixed(2)),
      moverMean: parseFloat(moverMean.toFixed(2)),
    },
  };
}

// ─── Main Viewer Controller ───────────────────────────────────────────────────
export function initViewer(sky) {
  // Target cache to prevent redundant re-fetching
  const frameCache = new Map();

  // Internal viewer state
  const state = {
    ra: 133.795,
    dec: -7.245,
    fov: 0.20,
    entryFov: 0.20,
    name: 'WISE 0855',
    frames: [],
    source: 'simulated',
    mock: true,
    live: false,
    isLiveRequest: false,
    mode: 'PLAY', // 'PLAY' | 'BLINK' | 'DIFFERENCE'
    currentFrameIndex: 0, // 0-based index
    blinkFrameA: 0,
    blinkFrameB: 8,
    pairMode: 'best', // 'best' | 'firstlast'
    zoomLevel: 1, // 1 | 2 | 4
    panX: 0,
    panY: 0,
    showExpectedPosition: true,
    vignetteEnabled: (typeof VIGNETTE_DEFAULT === 'boolean' ? VIGNETTE_DEFAULT : false),
    diffGain: 2.0,
    isPlaying: true,
    speedMultiplier: 1.0, // 0.5x, 0.75x, 1x, 2x, 4x
    isLooping: true,
    preloadTimeMs: 0,
    candidates: [],
    diffResult: null,
    avgFrameTimeMs: 400,
  };

  // Performance measurement state
  let lastFrameTime = performance.now();
  let frameTimeHistory = [];

  // Create Viewer DOM Shell if not already present
  let viewerRoot = document.getElementById('viewer-screen');
  if (!viewerRoot) {
    viewerRoot = document.createElement('div');
    viewerRoot.id = 'viewer-screen';
    document.body.appendChild(viewerRoot);
  }

  viewerRoot.innerHTML = `
    <div class="viewer-layout">
      <!-- Left/Center Stage Column -->
      <div class="viewer-stage-column">
        <div class="viewer-stage-frame" id="viewer-stage-frame">
          <span class="corner-tick tl"></span>
          <span class="corner-tick tr"></span>
          <span class="corner-tick bl"></span>
          <span class="corner-tick br"></span>

          <!-- Viewport for Zoom & Pan -->
          <div class="stage-viewport" id="stage-viewport">
            <div class="stage-content" id="stage-content">
              <!-- Canvas for Frame Display -->
              <canvas class="viewer-canvas" id="viewer-display-canvas" width="600" height="600"></canvas>

              <!-- Faint Astrometry Crosshair Grid Overlay -->
              <div class="stage-astrometry-grid" id="stage-astrometry-grid"></div>

              <!-- Thin Center Crosshair -->
              <div class="viewer-crosshair-center"></div>

              <!-- Candidate Movers Layer (DIFFERENCE mode) -->
              <div class="stage-candidates-layer" id="stage-candidates-layer"></div>

              <!-- Expected Position Layer (Optional catalog proper motion target_xy) -->
              <div class="stage-expected-layer" id="stage-expected-layer">
                <div class="expected-position-marker" id="expected-position-marker" style="display: none;">
                  <div class="expected-ring"></div>
                  <div class="expected-label">EXPECTED POSITION (catalog proper motion)</div>
                </div>
              </div>
            </div>
          </div>

          <!-- Telescope Lens Vignette Overlay -->
          <div class="stage-lens-vignette" id="stage-lens-vignette"></div>

          <!-- Top Bar Overlays (Evenly spaced & aligned across the top) -->
          <div class="stage-top-bar" id="stage-top-bar">
            <div class="stage-overlay-tl" id="stage-frame-counter">FRAME 1/9</div>
            <div class="stage-source-badge simulated" id="stage-source-badge">
              <span class="stage-badge-dot"></span>
              <span id="stage-source-text">SIMULATED FRAMES</span>
            </div>
            <div class="stage-overlay-tr" id="stage-frame-date">2025-01-15</div>
          </div>

          <div class="stage-overlay-br" id="stage-detector-label">DETECTOR 1</div>

          <!-- Scale Bar at Bottom-Left (Equals 0.02 deg at current FOV) -->
          <div class="stage-scale-bar-container" id="stage-scale-bar-container">
            <div class="stage-scale-bar-line-wrap">
              <div class="stage-scale-bar-line" id="stage-scale-bar-line" style="width: 60px;"></div>
            </div>
            <div class="stage-scale-bar-label">0.02 deg</div>
          </div>

          <!-- Scanning & Preload Overlay -->
          <div class="viewer-loading-overlay" id="viewer-loading-overlay" style="display: none;">
            <div class="viewer-spinner"></div>
            <div class="viewer-scan-line-text" id="viewer-scan-text">SCANNING 9 FRAMES... 0/9</div>
            <div class="viewer-live-frames-count" id="viewer-live-frames-count" style="display: none;">0/6 FRAMES</div>
            <div class="viewer-progress-bar" id="viewer-progress-bar">
              <div class="viewer-progress-fill" id="viewer-progress-fill"></div>
            </div>
            <!-- Live NASA Fetch Additions (Elapsed Time Counter & Cancel Button) -->
            <div class="viewer-live-fetch-info" id="viewer-live-fetch-info" style="display: none;">
              <div class="viewer-elapsed-container" id="viewer-elapsed-container">
                <span class="viewer-elapsed-label">ELAPSED:</span>
                <span class="viewer-elapsed-time" id="viewer-elapsed-time">00:00</span>
              </div>
              <button type="button" class="hud-btn-44 viewer-btn-cancel" id="viewer-btn-cancel">CANCEL</button>
            </div>
          </div>

          <!-- Error Overlay with Retry / Simulated Fallback -->
          <div class="viewer-error-overlay" id="viewer-error-overlay" style="display: none;">
            <div class="viewer-error-title" id="viewer-error-title">FRAME ACQUISITION FAILED</div>
            <div class="viewer-error-desc" id="viewer-error-desc">Unable to retrieve SPHEREX survey frames from server.</div>
            <div class="viewer-error-actions">
              <button type="button" class="hud-btn-44" id="viewer-btn-retry">RETRY</button>
              <button type="button" class="hud-btn-44" id="viewer-btn-use-sim">SIMULATED PREVIEW (INSTANT)</button>
            </div>
          </div>
        </div>

        <!-- Stage Toolbar (Positioned cleanly below image stage, grouped logically) -->
        <div class="stage-toolbar" id="stage-toolbar">
          <div class="toolbar-group toolbar-group-view">
            <div class="stage-zoom-wrap" id="stage-zoom-wrap">
              <span class="stage-zoom-label">ZOOM</span>
              <div class="stage-zoom-pills">
                <button type="button" class="stage-zoom-btn active" data-zoom="1">1x</button>
                <button type="button" class="stage-zoom-btn" data-zoom="2">2x</button>
                <button type="button" class="stage-zoom-btn" data-zoom="4">4x</button>
              </div>
            </div>
            <button type="button" class="stage-toggle-btn active" id="btn-toggle-expected" title="Toggle catalog expected position ring">
              <span class="stage-check-icon">✓</span> EXPECTED POSITION
            </button>
            <button type="button" class="stage-toggle-btn" id="btn-toggle-vignette" title="Toggle telescope aperture mask overlay">
              VIGNETTE: OFF
            </button>
          </div>
          <div class="toolbar-group toolbar-group-action">
            <button type="button" class="stage-toggle-btn stage-action-btn" id="btn-save-image" title="Save current frame as PNG">
              <svg class="stage-btn-icon" viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                <path d="M.5 9.9a.5.5 0 0 1 .5.5v2.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5a.5.5 0 0 1 1 0v2.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2v-2.5a.5.5 0 0 1 .5-.5z"/>
                <path d="M7.646 11.854a.5.5 0 0 0 .708 0l3-3a.5.5 0 0 0-.708-.708L8.5 10.293V1.5a.5.5 0 0 0-1 0v8.793L5.354 8.146a.5.5 0 1 0-.708.708l3 3z"/>
              </svg>
              SAVE IMAGE
            </button>
          </div>
        </div>

        <!-- Detector Edge Artifact Warning (Epsilon Indi B only) -->
        <div class="viewer-artifact-warning" id="viewer-artifact-warning" style="display: none;">
          <span class="warning-icon">⚠</span> DETECTOR EDGE ARTIFACT, NOT AN OBJECT
        </div>

        <!-- Understage Explanation -->
        <div class="viewer-understage-text" id="viewer-understage-caption">High proper-motion star. Compare the first and last frames: a bright/dark pair appears at the predicted position.</div>

        <!-- Motion Check Validation Card (Barnard's Star only) -->
        <div class="viewer-scientific-proof-box motion-check-card" id="viewer-scientific-proof" style="display: none;">
          <span class="corner-tick tl"></span>
          <span class="corner-tick tr"></span>
          <span class="corner-tick bl"></span>
          <span class="corner-tick br"></span>
          <div class="proof-header">
            <span class="proof-badge-dot warning"></span>
            <span class="proof-badge-text">MOTION CHECK</span>
          </div>
          <div class="proof-content" id="viewer-scientific-proof-text"></div>
        </div>
      </div>

      <!-- Right Control Card (340px) -->
      <div class="viewer-control-card" id="viewer-control-card">
        <span class="corner-tick tl"></span>
        <span class="corner-tick tr"></span>
        <span class="corner-tick bl"></span>
        <span class="corner-tick br"></span>

        <!-- Target Info Header -->
        <div class="viewer-target-info">
          <div class="viewer-target-title-row">
            <span class="viewer-target-name" id="info-target-name">WISE 0855</span>
            <span class="viewer-target-type" id="info-target-type">SPHEREX SKY SURVEY</span>
          </div>
          <div class="viewer-target-coords">
            <div class="viewer-coord-item">
              <span>RA:</span>
              <span class="viewer-coord-val" id="info-val-ra">08h 55m 10.8s (133.795°)</span>
            </div>
            <div class="viewer-coord-item">
              <span>DEC:</span>
              <span class="viewer-coord-val" id="info-val-dec">-07° 14' 42.5" (-7.245°)</span>
            </div>
          </div>
        </div>

        <!-- Live Fetch Waiting Placeholder -->
        <div class="viewer-waiting-card" id="viewer-waiting-card">
          <div class="viewer-waiting-spinner"></div>
          <div class="viewer-waiting-title">WAITING FOR DATA</div>
          <div class="viewer-waiting-desc">Timeline and playback controls will activate once survey frames arrive.</div>
        </div>

        <!-- Mode Toggle (44px target) -->
        <div class="viewer-mode-selector">
          <button type="button" class="viewer-mode-btn active" data-mode="PLAY" id="btn-mode-play">PLAY</button>
          <button type="button" class="viewer-mode-btn" data-mode="BLINK" id="btn-mode-blink">BLINK A/B</button>
          <button type="button" class="viewer-mode-btn" data-mode="DIFFERENCE" id="btn-mode-diff">DIFFERENCE</button>
        </div>

        <!-- Mode Panel: PLAY -->
        <div class="viewer-mode-panel" id="panel-play">
          <div class="viewer-playback-row">
            <button type="button" class="hud-btn-44 btn-step-prev" id="btn-play-prev" title="Previous Frame (Left Arrow)">◀</button>
            <button type="button" class="hud-btn-44 btn-play-toggle" id="btn-play-toggle">❚❚ PAUSE</button>
            <button type="button" class="hud-btn-44 btn-step-next" id="btn-play-next" title="Next Frame (Right Arrow)">▶</button>
            <button type="button" class="hud-btn-44 btn-loop-toggle active" id="btn-loop-toggle" title="Toggle Loop">LOOP: ON</button>
          </div>

          <div class="viewer-slider-block">
            <div class="viewer-slider-header">
              <span>FRAME TIMELINE</span>
              <span id="slider-frame-label">FRAME 1 OF 9</span>
            </div>
            <div class="viewer-slider-track-wrap">
              <input type="range" class="viewer-frame-slider" id="viewer-frame-slider" min="1" max="9" step="1" value="1" />
              <div class="viewer-slider-ticks">
                <span>1</span><span>2</span><span>3</span><span>4</span><span>5</span><span>6</span><span>7</span><span>8</span><span>9</span>
              </div>
            </div>
          </div>

          <div class="viewer-speed-row">
            <span class="viewer-row-label">PLAY SPEED</span>
            <div class="speed-pills-wrap">
              <button type="button" class="speed-pill-btn" data-speed="0.5">0.5x</button>
              <button type="button" class="speed-pill-btn active" data-speed="1.0">1x</button>
              <button type="button" class="speed-pill-btn" data-speed="2.0">2x</button>
              <button type="button" class="speed-pill-btn" data-speed="4.0">4x</button>
            </div>
          </div>
        </div>

        <!-- Mode Panel: BLINK A/B -->
        <div class="viewer-mode-panel" id="panel-blink" style="display: none;">
          <div class="pair-toggle-row">
            <div class="pair-toggle-group">
              <button type="button" class="pair-toggle-btn active" data-pair-mode="best" id="btn-blink-pair-best">BEST PAIR</button>
              <button type="button" class="pair-toggle-btn" data-pair-mode="firstlast" id="btn-blink-pair-firstlast">FIRST AND LAST</button>
            </div>
          </div>

          <div class="blink-select-row">
            <div class="blink-select-col">
              <label for="select-blink-a" class="blink-label">FRAME A</label>
              <select id="select-blink-a" class="hud-select-44"></select>
            </div>
            <div class="blink-select-col">
              <label for="select-blink-b" class="blink-label">FRAME B</label>
              <select id="select-blink-b" class="hud-select-44"></select>
            </div>
          </div>

          <div class="blink-pair-info-label" id="blink-pair-info-label">
            A = frame 1 (...), B = frame 9 (...)
          </div>

          <div class="viewer-playback-row" style="margin-top: 10px;">
            <button type="button" class="hud-btn-44 btn-play-toggle" id="btn-blink-toggle" style="flex:1;">❚❚ PAUSE BLINK</button>
          </div>

          <div class="viewer-speed-row">
            <span class="viewer-row-label">BLINK RATE</span>
            <div class="speed-pills-wrap" id="blink-speed-pills">
              <button type="button" class="speed-pill-btn" data-speed="0.5">0.5x</button>
              <button type="button" class="speed-pill-btn active" data-speed="0.75">0.75x</button>
              <button type="button" class="speed-pill-btn" data-speed="1.0">1x</button>
              <button type="button" class="speed-pill-btn" data-speed="2.0">2x</button>
              <button type="button" class="speed-pill-btn" data-speed="4.0">4x</button>
            </div>
          </div>
        </div>

        <!-- Mode Panel: DIFFERENCE -->
        <div class="viewer-mode-panel" id="panel-diff" style="display: none;">
          <div class="pair-toggle-row">
            <div class="pair-toggle-group">
              <button type="button" class="pair-toggle-btn active" data-pair-mode="best" id="btn-diff-pair-best">BEST PAIR</button>
              <button type="button" class="pair-toggle-btn" data-pair-mode="firstlast" id="btn-diff-pair-firstlast">FIRST AND LAST</button>
            </div>
          </div>

          <div class="blink-select-row">
            <div class="blink-select-col">
              <label for="select-diff-a" class="blink-label">FRAME A (SUBTRAHEND)</label>
              <select id="select-diff-a" class="hud-select-44"></select>
            </div>
            <div class="blink-select-col">
              <label for="select-diff-b" class="blink-label">FRAME B (TARGET)</label>
              <select id="select-diff-b" class="hud-select-44"></select>
            </div>
          </div>

          <div class="diff-gain-row">
            <div class="diff-gain-header">
              <span>CONTRAST GAIN</span>
              <span class="diff-gain-readout" id="diff-gain-readout">2.0x</span>
            </div>
            <input type="range" class="viewer-frame-slider" id="diff-gain-slider" min="1.0" max="8.0" step="0.5" value="2.0" />
          </div>

          <div class="candidates-section">
            <div class="candidates-header" id="candidates-header">CANDIDATES (0)</div>
            <div class="candidates-list-wrap" id="candidates-list-wrap"></div>
            <div class="candidates-note" id="candidates-note">Automatic suggestions. May be noise. Check by eye.</div>
          </div>
        </div>

        <!-- FOV Steps Selector -->
        <div class="viewer-fov-block">
          <span class="viewer-row-label">FIELD OF VIEW (FOV)</span>
          <div class="viewer-fov-buttons">
            <button type="button" class="fov-step-btn" data-fov="0.05">0.05°</button>
            <button type="button" class="fov-step-btn" data-fov="0.10">0.10°</button>
            <button type="button" class="fov-step-btn active" data-fov="0.20">0.20°</button>
            <button type="button" class="fov-step-btn" data-fov="0.40">0.40°</button>
          </div>
          <div class="viewer-fov-note" id="viewer-fov-note">Cached demo targets load instantly. Other positions or FOV values fetch live NASA data (about 1 to 2 minutes when NASA's archive responds; may be slower or throttled).</div>
        </div>

        <!-- Navigation Buttons -->
        <div class="viewer-actions-row">
          <button type="button" class="hud-btn-44 viewer-btn-back" id="btn-viewer-back">&lt; BACK</button>
          <button type="button" class="hud-btn-44 viewer-btn-new-target" id="btn-viewer-new-target">NEW TARGET</button>
        </div>
      </div>
    </div>
  `;

  // Grab DOM Elements
  const displayCanvas        = document.getElementById('viewer-display-canvas');
  const stageViewport        = document.getElementById('stage-viewport');
  const stageContent         = document.getElementById('stage-content');
  const stageExpectedLayer   = document.getElementById('stage-expected-layer');
  const expectedPositionMarker = document.getElementById('expected-position-marker');
  const btnToggleExpected    = document.getElementById('btn-toggle-expected');
  const btnToggleVignette    = document.getElementById('btn-toggle-vignette');
  const btnSaveImage         = document.getElementById('btn-save-image');
  const stageLensVignette    = document.getElementById('stage-lens-vignette');
  const artifactWarningEl    = document.getElementById('viewer-artifact-warning');
  const understageCaption    = document.getElementById('viewer-understage-caption');
  const scientificProofBox   = document.getElementById('viewer-scientific-proof');
  const blinkPairInfoLabel   = document.getElementById('blink-pair-info-label');

  const stageFrameCounter    = document.getElementById('stage-frame-counter');
  const stageSourceBadge     = document.getElementById('stage-source-badge');
  const stageSourceText      = document.getElementById('stage-source-text');
  const stageFrameDate       = document.getElementById('stage-frame-date');
  const stageDetectorLabel   = document.getElementById('stage-detector-label');
  const stageScaleBarLine    = document.getElementById('stage-scale-bar-line');
  const stageCandidatesLayer = document.getElementById('stage-candidates-layer');
  const loadingOverlay       = document.getElementById('viewer-loading-overlay');
  const scanText             = document.getElementById('viewer-scan-text');
  const liveFramesCount      = document.getElementById('viewer-live-frames-count');
  const progressFill         = document.getElementById('viewer-progress-fill');
  const progressBar          = document.getElementById('viewer-progress-bar');
  const liveFetchInfo        = document.getElementById('viewer-live-fetch-info');
  const elapsedTimeEl        = document.getElementById('viewer-elapsed-time');
  const btnCancel            = document.getElementById('viewer-btn-cancel');
  const fovButtonsContainer  = document.querySelector('.viewer-fov-buttons');
  const errorOverlay         = document.getElementById('viewer-error-overlay');
  const errorTitle           = document.getElementById('viewer-error-title');
  const errorDesc            = document.getElementById('viewer-error-desc');
  const btnRetry             = document.getElementById('viewer-btn-retry');
  const btnUseSim            = document.getElementById('viewer-btn-use-sim');

  const infoTargetName       = document.getElementById('info-target-name');
  const infoValRa            = document.getElementById('info-val-ra');
  const infoValDec           = document.getElementById('info-val-dec');

  const viewerControlCard    = document.getElementById('viewer-control-card');
  const viewerWaitingCard    = document.getElementById('viewer-waiting-card');

  function setRightPanelWaiting(isWaiting) {
    if (viewerControlCard) {
      if (isWaiting) {
        viewerControlCard.classList.add('is-waiting');
      } else {
        viewerControlCard.classList.remove('is-waiting');
      }
    }
  }

  const btnModePlay          = document.getElementById('btn-mode-play');
  const btnModeBlink         = document.getElementById('btn-mode-blink');
  const btnModeDiff          = document.getElementById('btn-mode-diff');
  const panelPlay            = document.getElementById('panel-play');
  const panelBlink           = document.getElementById('panel-blink');
  const panelDiff            = document.getElementById('panel-diff');

  const btnPlayToggle        = document.getElementById('btn-play-toggle');
  const btnPlayPrev          = document.getElementById('btn-play-prev');
  const btnPlayNext          = document.getElementById('btn-play-next');
  const btnLoopToggle        = document.getElementById('btn-loop-toggle');
  const frameSlider          = document.getElementById('viewer-frame-slider');
  const sliderFrameLabel     = document.getElementById('slider-frame-label');

  const selectBlinkA         = document.getElementById('select-blink-a');
  const selectBlinkB         = document.getElementById('select-blink-b');
  const btnBlinkToggle       = document.getElementById('btn-blink-toggle');

  const selectDiffA          = document.getElementById('select-diff-a');
  const selectDiffB          = document.getElementById('select-diff-b');
  const diffGainSlider       = document.getElementById('diff-gain-slider');
  const diffGainReadout      = document.getElementById('diff-gain-readout');
  const candidatesHeader     = document.getElementById('candidates-header');
  const candidatesListWrap   = document.getElementById('candidates-list-wrap');

  const btnViewerBack        = document.getElementById('btn-viewer-back');
  const btnViewerNewTarget   = document.getElementById('btn-viewer-new-target');

  // Elapsed-time counter & live fetch cancellation controller
  let elapsedTimer = null;
  let fetchStartTime = null;
  let activeAbortController = null;
  let previousLoadedFov = 0.20;

  function startElapsedCounter() {
    stopElapsedCounter();
    fetchStartTime = performance.now();
    if (elapsedTimeEl) elapsedTimeEl.textContent = '00:00';
    elapsedTimer = setInterval(() => {
      if (!fetchStartTime) return;
      const totalSec = Math.floor((performance.now() - fetchStartTime) / 1000);
      const mins = Math.floor(totalSec / 60);
      const secs = totalSec % 60;
      if (elapsedTimeEl) {
        elapsedTimeEl.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
      }
    }, 500);
  }

  function stopElapsedCounter() {
    if (elapsedTimer) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
    fetchStartTime = null;
  }

  const standardFovSteps = [0.05, 0.10, 0.20, 0.40];

  function renderFovControl(entryFov, selectedFov = null) {
    if (!fovButtonsContainer) return;
    const entryNum = typeof entryFov === 'number' ? entryFov : parseFloat(entryFov);
    const activeFov = selectedFov !== null
      ? (typeof selectedFov === 'number' ? selectedFov : parseFloat(selectedFov))
      : entryNum;

    const isStandard = standardFovSteps.some(s => Math.abs(s - entryNum) < 0.005);
    const steps = isStandard
      ? [...standardFovSteps]
      : [...standardFovSteps, entryNum].sort((a, b) => a - b);

    fovButtonsContainer.innerHTML = '';
    steps.forEach(step => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'fov-step-btn';
      btn.dataset.fov = step.toFixed(2);
      btn.textContent = `${step.toFixed(2)}°`;
      if (Math.abs(step - activeFov) < 0.005) {
        btn.classList.add('active');
      }
      btn.addEventListener('click', async () => {
        const newFov = parseFloat(btn.dataset.fov);
        if (Math.abs(newFov - state.fov) < 0.001) return;

        fovButtonsContainer.querySelectorAll('.fov-step-btn').forEach(b => {
          b.classList.toggle('active', Math.abs(parseFloat(b.dataset.fov) - newFov) < 0.005);
        });

        await loadFramesForTarget(state.ra, state.dec, newFov, state.name, false);
      });
      fovButtonsContainer.appendChild(btn);
    });
  }
  renderFovControl(state.entryFov, state.fov);

  btnCancel?.addEventListener('click', () => {
    if (activeAbortController) {
      activeAbortController.abort();
      activeAbortController = null;
    }
    stopElapsedCounter();
    setRightPanelWaiting(false);
    loadingOverlay.style.display = 'none';
    errorOverlay.style.display = 'none';

    if (state.isLiveRequest) {
      goBackToProbeConfirmed();
    } else if (state.frames && state.frames.length > 0) {
      state.fov = previousLoadedFov;
      updateScaleBar();
      renderFovControl(state.entryFov, state.fov);
      renderCurrentFrame();
    } else {
      goBackToProbeConfirmed();
    }
  });

  // Update timeline slider, labels, and ticks dynamically based on state.frames.length
  function updateTimelineUI() {
    const totalFrames = (state.frames && state.frames.length) ? state.frames.length : (state.live ? 6 : 9);
    const activeNum = state.currentFrameIndex + 1;

    if (frameSlider) {
      frameSlider.min = '1';
      frameSlider.max = String(totalFrames);
      frameSlider.value = String(activeNum);
    }

    if (sliderFrameLabel) {
      sliderFrameLabel.textContent = `FRAME ${activeNum} OF ${totalFrames}`;
    }

    const ticksContainer = document.querySelector('.viewer-slider-ticks');
    if (ticksContainer) {
      ticksContainer.innerHTML = '';
      for (let i = 1; i <= totalFrames; i++) {
        const span = document.createElement('span');
        span.textContent = String(i);
        ticksContainer.appendChild(span);
      }
    }
  }

  // Populate Dropdowns for frames (1-based on screen)
  function populateFrameSelects() {
    const total = (state.frames && state.frames.length) ? state.frames.length : (state.live ? 6 : 9);
    [selectBlinkA, selectBlinkB, selectDiffA, selectDiffB].forEach(sel => {
      if (!sel) return;
      sel.innerHTML = '';
      for (let i = 1; i <= total; i++) {
        const opt = document.createElement('option');
        opt.value = String(i - 1);
        opt.textContent = `FRAME ${i}`;
        sel.appendChild(opt);
      }
    });
  }

  // Blink A/B Information Label: "A = frame X (date), B = frame Y (date)"
  function updateBlinkInfoLabel() {
    const frameA = state.frames && state.frames[state.blinkFrameA];
    const frameB = state.frames && state.frames[state.blinkFrameB];
    const numA = state.blinkFrameA + 1;
    const numB = state.blinkFrameB + 1;
    const dateA = frameA?.date || '...';
    const dateB = frameB?.date || '...';
    if (blinkPairInfoLabel) {
      blinkPairInfoLabel.textContent = `A = frame ${numA} (${dateA}), B = frame ${numB} (${dateB})`;
    }
  }

  // Apply Pair Mode: "best" or "firstlast"
  function applyPairMode(mode = state.pairMode) {
    state.pairMode = mode;
    document.querySelectorAll('.pair-toggle-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.pairMode === mode);
    });

    const framesLen = (state.frames && state.frames.length) ? state.frames.length : (state.live ? 6 : 9);
    let pair = [0, Math.max(0, framesLen - 1)];

    if (!state.live && mode === 'best') {
      pair = getDefaultPairForTarget(state.name, framesLen);
    } else {
      pair = [0, Math.max(0, framesLen - 1)];
    }

    state.blinkFrameA = Math.max(0, Math.min(pair[0], framesLen - 1));
    state.blinkFrameB = Math.max(0, Math.min(pair[1], framesLen - 1));

    if (selectBlinkA) selectBlinkA.value = String(state.blinkFrameA);
    if (selectBlinkB) selectBlinkB.value = String(state.blinkFrameB);
    if (selectDiffA)  selectDiffA.value  = String(state.blinkFrameA);
    if (selectDiffB)  selectDiffB.value  = String(state.blinkFrameB);

    updateBlinkInfoLabel();
    renderCurrentFrame();
  }

  function isVariableTarget(name, ra, dec) {
    if (!name && ra == null) return false;
    const targetInfo = getTargetInfo(name, ra, dec);
    if (targetInfo?.isVariable) return true;
    const upper = (name || '').toUpperCase();
    return upper.includes('RW AURIGAE') || upper.includes('R DRACONIS') || upper.includes('VARIABLE');
  }

  function isBarnardsStar(name, ra, dec) {
    if (name && /barnard/i.test(name)) return true;
    if (typeof ra === 'number' && typeof dec === 'number') {
      return Math.abs(ra - 269.452) < 0.02 && Math.abs(dec - 4.693) < 0.02;
    }
    return false;
  }

  function updateScientificProofBox() {
    if (!scientificProofBox) return;
    try {
      if (!FEATURES.validationCard) {
        scientificProofBox.style.display = 'none';
        return;
      }
      const isBarnard = isBarnardsStar(state.name, state.ra, state.dec);
      if (!isBarnard) {
        scientificProofBox.style.display = 'none';
        return;
      }
      const predPx = validationData.predicted_shift_px;
      const measPx = validationData.measured_shift_px;
      const dirDiff = validationData.direction_difference_deg;
      const ratio = (measPx / predPx).toFixed(1);
      const verdictText = `PARTIAL: direction agrees (${dirDiff} deg), size does not (measured ${measPx} px vs predicted ${predPx} px, about ${ratio}x). Not confirmed.`;
      const candidateSummary = validationData.candidate_summary || '1 of 5 targets shows a visible candidate (unconfirmed).';

      const proofContentEl = document.getElementById('viewer-scientific-proof-text');
      if (proofContentEl) {
        proofContentEl.innerHTML = `
          <div class="motion-check-line">Predicted shift (catalog proper motion): ${predPx} px</div>
          <div class="motion-check-line">Measured shift (difference-image centroids): ${measPx} px</div>
          <div class="motion-check-line">Direction difference: ${dirDiff} deg</div>
          <div class="motion-check-verdict warning">${verdictText}</div>
          <div class="motion-check-summary">${candidateSummary}</div>
        `;
      }
      scientificProofBox.style.display = 'flex';
    } catch (err) {
      console.error('[viewer] Failed to update motion check box:', err);
      scientificProofBox.style.display = 'none';
    }
  }

  function updateArtifactWarning() {
    if (!artifactWarningEl) return;
    try {
      const isEpsIndi = (state.name || '').toUpperCase().includes('EPSILON INDI');
      artifactWarningEl.style.display = isEpsIndi ? 'inline-flex' : 'none';
    } catch (err) {
      console.error('[viewer] Failed to update artifact warning:', err);
      artifactWarningEl.style.display = 'none';
    }
  }

  // Expected Position Ring (target_xy)
  function renderExpectedPosition() {
    const isVariable = isVariableTarget(state.name, state.ra, state.dec);
    if (btnToggleExpected) {
      btnToggleExpected.style.display = (state.live || isVariable) ? 'none' : '';
    }
    if (!expectedPositionMarker) return;
    if (state.live || isVariable || !state.showExpectedPosition) {
      expectedPositionMarker.style.display = 'none';
      return;
    }
    let activeIdx = state.currentFrameIndex;
    if (state.mode === 'BLINK') {
      activeIdx = (state.currentFrameIndex % 2 === 0) ? state.blinkFrameA : state.blinkFrameB;
    } else if (state.mode === 'DIFFERENCE') {
      activeIdx = state.blinkFrameB;
    }
    const curFrame = state.frames && state.frames[activeIdx];
    if (curFrame && Array.isArray(curFrame.target_xy) && curFrame.target_xy.length === 2) {
      const [x, y] = curFrame.target_xy;
      expectedPositionMarker.style.display = 'flex';
      expectedPositionMarker.style.left = `${(x / 600) * 100}%`;
      expectedPositionMarker.style.top = `${(y / 600) * 100}%`;
    } else {
      expectedPositionMarker.style.display = 'none';
    }
  }

  // Zoom & Pan Management (1x, 2x, 4x)
  function setZoom(level) {
    state.zoomLevel = level;
    document.querySelectorAll('.stage-zoom-btn').forEach(btn => {
      btn.classList.toggle('active', parseInt(btn.dataset.zoom, 10) === level);
    });

    if (level === 1) {
      state.panX = 0;
      state.panY = 0;
    } else {
      let activeIdx = state.currentFrameIndex;
      if (state.mode === 'BLINK') {
        activeIdx = (state.currentFrameIndex % 2 === 0) ? state.blinkFrameA : state.blinkFrameB;
      } else if (state.mode === 'DIFFERENCE') {
        activeIdx = state.blinkFrameB;
      }
      const curFrame = state.frames && state.frames[activeIdx];
      let cx = 300;
      let cy = 300;
      if (curFrame && Array.isArray(curFrame.target_xy) && curFrame.target_xy.length === 2) {
        cx = curFrame.target_xy[0];
        cy = curFrame.target_xy[1];
      }
      state.panX = 300 - cx * level;
      state.panY = 300 - cy * level;
    }
    applyZoomPan();
  }

  function applyZoomPan() {
    if (!stageContent || !stageViewport) return;
    stageContent.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoomLevel})`;
    if (state.zoomLevel > 1) {
      stageViewport.classList.add('can-pan');
    } else {
      stageViewport.classList.remove('can-pan');
    }
  }

  // Drag-to-pan on stage viewport
  let isDraggingStage = false;
  let dragStartX = 0;
  let dragStartY = 0;

  if (stageViewport) {
    stageViewport.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('.stage-candidate-marker')) return;
      if (state.zoomLevel <= 1) return;

      isDraggingStage = true;
      dragStartX = e.clientX - state.panX;
      dragStartY = e.clientY - state.panY;
      stageViewport.classList.add('is-panning');
      try {
        stageViewport.setPointerCapture(e.pointerId);
      } catch {}
    });

    stageViewport.addEventListener('pointermove', (e) => {
      if (!isDraggingStage) return;
      state.panX = e.clientX - dragStartX;
      state.panY = e.clientY - dragStartY;
      applyZoomPan();
    });

    const stopStageDrag = (e) => {
      if (!isDraggingStage) return;
      isDraggingStage = false;
      stageViewport.classList.remove('is-panning');
      try {
        stageViewport.releasePointerCapture(e.pointerId);
      } catch {}
    };

    stageViewport.addEventListener('pointerup', stopStageDrag);
    stageViewport.addEventListener('pointercancel', stopStageDrag);
  }

  // Toggle Expected Position Marker
  btnToggleExpected?.addEventListener('click', () => {
    state.showExpectedPosition = !state.showExpectedPosition;
    btnToggleExpected.classList.toggle('active', state.showExpectedPosition);
    const checkIcon = btnToggleExpected.querySelector('.stage-check-icon');
    if (checkIcon) checkIcon.textContent = state.showExpectedPosition ? '✓' : '';
    renderExpectedPosition();
  });

  // Apply Vignette Overlay State
  function applyVignetteState() {
    try {
      if (!FEATURES.vignetteToggle) {
        if (stageLensVignette) stageLensVignette.style.display = 'none';
        if (btnToggleVignette) btnToggleVignette.style.display = 'none';
        return;
      }
      if (stageLensVignette) {
        stageLensVignette.style.display = state.vignetteEnabled ? 'block' : 'none';
      }
      if (btnToggleVignette) {
        btnToggleVignette.classList.toggle('active', state.vignetteEnabled);
        btnToggleVignette.textContent = state.vignetteEnabled ? 'VIGNETTE: ON' : 'VIGNETTE: OFF';
      }
    } catch (err) {
      console.error('[viewer] Failed to apply vignette state:', err);
    }
  }

  btnToggleVignette?.addEventListener('click', () => {
    state.vignetteEnabled = !state.vignetteEnabled;
    applyVignetteState();
  });
  applyVignetteState();

  // Save Image Button (Downloads exact raw canvas pixels without vignette)
  btnSaveImage?.addEventListener('click', () => {
    try {
      if (!displayCanvas) return;
      const dataUrl = displayCanvas.toDataURL('image/png');
      const link = document.createElement('a');
      const targetName = (state.name || 'target').replace(/[^a-zA-Z0-9_-]/g, '_');
      link.download = `argus_${targetName}_frame_${state.currentFrameIndex + 1}.png`;
      link.href = dataUrl;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err) {
      console.error('[viewer] Failed to save image:', err);
    }
  });

  // Stage Zoom Pill Buttons (1x, 2x, 4x)
  document.querySelectorAll('.stage-zoom-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const level = parseInt(e.currentTarget.dataset.zoom, 10);
      setZoom(level);
    });
  });

  // Pair Mode Toggles (BEST PAIR / FIRST AND LAST)
  document.querySelectorAll('.pair-toggle-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const mode = e.currentTarget.dataset.pairMode;
      applyPairMode(mode);
    });
  });

  populateFrameSelects();

  // ─── Scale Bar Sizing ────────────────────────────────────────────────────────
  function updateScaleBar() {
    // Stage pixel width is 600px
    const stageWidth = 600;
    // Scale bar length = 0.02 degrees at current FOV
    const pxLength = (0.02 / state.fov) * stageWidth;
    stageScaleBarLine.style.width = `${Math.round(pxLength)}px`;
  }

  // ─── Process Loaded Frames from API, Cache, or Simulation ─────────────────
  async function processLoadedFrames(response, cacheKey) {
    const isLiveResponse = Boolean(response && (response.live === true || response.live === 'true' || response.data?.live === true));

    if (isLiveResponse) {
      state.live = true;
      state.source = 'api';
      state.mock = false;
      state.isLiveRequest = false;
      if (understageCaption) {
        understageCaption.textContent = "Live fetch: frames are not aligned, so Blink may jitter. For the clearest view use the 5 featured targets.";
      }
    } else {
      state.live = false;
      state.source = response.source || (response.mock ? 'simulated' : 'api');
      state.mock = Boolean(response.mock === true || state.source !== 'api');
      state.isLiveRequest = false;
      if (understageCaption) {
        understageCaption.textContent = getCaptionForTarget(state.name);
      }
    }
    updateScientificProofBox();
    updateArtifactWarning();

    const rawFrames = Array.isArray(response) ? response : (response.frames || []);

    // Ensure each frame has valid resolved image_url
    const base = getApiBase();
    rawFrames.forEach((frame) => {
      let imgUrl = frame.image_url || frame.url || frame.image || frame.url_path || '';
      if (imgUrl && typeof imgUrl === 'string' && !imgUrl.startsWith('http://') && !imgUrl.startsWith('https://') && !imgUrl.startsWith('data:') && !imgUrl.startsWith('blob:')) {
        const cleanBase = base ? base.replace(/\/+$/, '') : '';
        const cleanPath = imgUrl.startsWith('/') ? imgUrl : `/${imgUrl}`;
        imgUrl = cleanBase ? `${cleanBase}${cleanPath}` : cleanPath;
      }
      frame.image_url = imgUrl;
    });

    // Ensure all images are preloaded into HTMLImageElements and wait for them to load before drawing
    const preloadedImages = await Promise.all(rawFrames.map((frame, idx) => {
      return new Promise((resolve) => {
        if (!frame.image_url) {
          resolve(null);
          return;
        }
        const img = new Image();
        if (!frame.image_url.startsWith('data:') && !frame.image_url.startsWith('blob:')) {
          img.crossOrigin = 'anonymous';
        }
        img.onload = () => resolve(img);
        img.onerror = (err) => {
          console.warn(`[viewer] Failed to load frame ${idx + 1} image from: ${frame.image_url}`, err);
          resolve(null);
        };
        img.src = frame.image_url;
      });
    }));

    rawFrames.forEach((f, idx) => {
      f.loadedImage = preloadedImages[idx];
      if (f.loadedImage && f.loadedImage.naturalWidth > 0 && !f.imageData) {
        try {
          const offCanvas = document.createElement('canvas');
          offCanvas.width = 600;
          offCanvas.height = 600;
          const offCtx = offCanvas.getContext('2d');
          offCtx.drawImage(f.loadedImage, 0, 0, 600, 600);
          f.imageData = offCtx.getImageData(0, 0, 600, 600);
        } catch (_) {}
      }
    });

    state.frames = rawFrames;
    state.loadedTargetName = state.name;
    previousLoadedFov = state.fov;

    const totalFrames = state.frames.length;
    state.currentFrameIndex = Math.max(0, Math.min(state.currentFrameIndex, totalFrames - 1));

    if (cacheKey) {
      frameCache.set(cacheKey, {
        frames: state.frames,
        source: state.source,
        mock: state.mock,
        live: state.live,
      });
    }

    stopElapsedCounter();
    setRightPanelWaiting(false);
    loadingOverlay.style.display = 'none';
    errorOverlay.style.display = 'none';

    updateTimelineUI();
    populateFrameSelects();
    applyPairMode(state.live ? 'firstlast' : 'best');
    setZoom(1);
    renderCurrentFrame();
  }

  // ─── Preload & Render Images onto Display Canvas ────────────────────────────
  async function loadFramesForTarget(ra, dec, fov, name, isNewEntry = false, options = {}) {
    let fovNum = typeof fov === 'number' ? fov : parseFloat(fov);
    let effectiveRa = ra;
    let effectiveDec = dec;
    let effectiveName = name;

    // Snap to cached target if within 0.005 degrees and matching FOV
    const cachedMatch = findMatchingCachedTarget(effectiveRa, effectiveDec, fovNum);
    if (cachedMatch) {
      effectiveRa = cachedMatch.ra;
      effectiveDec = cachedMatch.dec;
      fovNum = cachedMatch.fov;
      if (!effectiveName || effectiveName === 'CUSTOM SPOT' || effectiveName === 'TYPED COORDS') {
        effectiveName = cachedMatch.name;
      }
    }

    state.ra = effectiveRa;
    state.dec = effectiveDec;
    state.fov = fovNum;
    const targetInfo = getTargetInfo(effectiveName, effectiveRa, effectiveDec) || getSelectedTarget();
    state.name = effectiveName || targetInfo?.name || "BARNARD'S STAR";

    if (sky) {
      if (typeof sky.setProbeCoordinates === 'function') {
        sky.setProbeCoordinates(effectiveRa, effectiveDec);
      }
      if (typeof sky.centerOnTarget === 'function') {
        sky.centerOnTarget(effectiveRa, effectiveDec, 0);
      }
    }

    const isLiveReq = Boolean(options.liveFetch || (options.preloadedResult && (options.preloadedResult.live === true || options.preloadedResult.live === 'true')));
    const isLive = Boolean(isLiveReq || options.live || window.isLive);
    state.isLiveRequest = Boolean(options.liveFetch);

    if (options.forceSimulated) {
      state.live = false;
      state.source = 'simulated';
      state.mock = true;
    } else if (isLiveReq) {
      state.live = true;
      state.source = 'api';
      state.mock = false;
    } else if (options.preloadedResult) {
      state.live = false;
      state.source = 'api';
      state.mock = false;
    }

    if (stageSourceBadge && stageSourceText) {
      if (state.live) {
        stageSourceBadge.className = 'stage-source-badge live';
        stageSourceText.innerHTML = 'SPHEREX DATA (LIVE) <span class="tag-not-aligned">NOT ALIGNED</span>';
      } else if (state.source === 'api' && state.mock !== true) {
        stageSourceBadge.className = 'stage-source-badge api';
        stageSourceText.textContent = 'SPHEREX DATA';
      } else {
        stageSourceBadge.className = 'stage-source-badge simulated';
        stageSourceText.textContent = 'SIMULATED FRAMES';
      }
    }

    if (understageCaption) {
      if (state.live) {
        understageCaption.textContent = "Live fetch: frames are not aligned, so Blink may jitter. For the clearest view use the 5 featured targets.";
      } else {
        understageCaption.textContent = getCaptionForTarget(state.name);
      }
    }
    updateScientificProofBox();
    updateArtifactWarning();

    const isVariable = isVariableTarget(state.name, state.ra, state.dec);
    if (btnToggleExpected) {
      btnToggleExpected.style.display = (state.live || isVariable) ? 'none' : '';
    }
    if ((state.live || isVariable) && expectedPositionMarker) {
      expectedPositionMarker.style.display = 'none';
    }

    if (isNewEntry || typeof state.entryFov !== 'number') {
      state.entryFov = fovNum;
    }

    renderFovControl(state.entryFov, state.fov);

    infoTargetName.textContent = state.name;
    infoValRa.textContent = formatRA(effectiveRa);
    infoValDec.textContent = formatDec(effectiveDec);

    updateScaleBar();

    const fovFormatted = fovNum.toFixed(2);
    const cacheKey = `${effectiveRa.toFixed(4)},${effectiveDec.toFixed(4)},${fovFormatted}`;

    // Force simulated frames preview directly
    if (options.forceSimulated) {
      stopElapsedCounter();
      setRightPanelWaiting(false);
      loadingOverlay.style.display = 'none';
      errorOverlay.style.display = 'none';
      const sim = await generateSimFrames(effectiveRa, effectiveDec, fovNum, state.name);
      await processLoadedFrames(sim, cacheKey);
      return;
    }

    // Preloaded result supplied directly from HUD load button or external caller
    if (options.preloadedResult) {
      stopElapsedCounter();
      setRightPanelWaiting(false);
      loadingOverlay.style.display = 'none';
      errorOverlay.style.display = 'none';
      await processLoadedFrames(options.preloadedResult, cacheKey);
      return;
    }

    if (frameCache.has(cacheKey)) {
      const cached = frameCache.get(cacheKey);
      if (!isLive || cached.live === true) {
        await processLoadedFrames(cached, null);
        return;
      }
    }

    if (activeAbortController) {
      activeAbortController.abort();
      activeAbortController = null;
    }
    activeAbortController = new AbortController();
    const signal = activeAbortController.signal;

    loadingOverlay.style.display = 'flex';
    errorOverlay.style.display = 'none';
    if (expectedPositionMarker) expectedPositionMarker.style.display = 'none';

    if (isLive) {
      setRightPanelWaiting(true);
      scanText.textContent = "FETCHING REAL DATA (about 1 to 2 minutes when NASA's archive responds; may be slower or throttled)...";
      if (progressBar) progressBar.style.display = 'none';
      if (liveFetchInfo) liveFetchInfo.style.display = 'flex';
      if (liveFramesCount) {
        liveFramesCount.style.display = 'block';
        liveFramesCount.textContent = 'FETCHING FRAMES...';
      }
      startElapsedCounter();
    } else {
      setRightPanelWaiting(false);
      scanText.textContent = 'SCANNING 9 FRAMES... 0/9';
      if (progressFill) progressFill.style.width = '0%';
      if (progressBar) progressBar.style.display = 'block';
      if (liveFetchInfo) liveFetchInfo.style.display = 'none';
      if (liveFramesCount) liveFramesCount.style.display = 'none';
      stopElapsedCounter();
    }

    const startTime = performance.now();
    let timeoutId = null;

    if (isLive) {
      // 20 minutes timeout
      timeoutId = setTimeout(() => {
        if (activeAbortController) {
          activeAbortController.abort(new Error("Live fetch timed out (NASA archive took too long to respond; may be throttled)"));
        }
      }, 20 * 60 * 1000);
    }

    try {
      const result = await getFrames(effectiveRa, effectiveDec, fovNum, {
        cachedOnly: !isLive,
        name: effectiveName,
        signal,
        onStatus: (d) => {
          setRightPanelWaiting(true);
          const serverMsg = d?.message || "FETCHING REAL DATA (about 1 to 2 minutes when NASA's archive responds; may be slower or throttled)...";
          scanText.textContent = serverMsg;
          if (d?.progress && typeof d.progress.done === 'number' && typeof d.progress.total === 'number') {
            const { done, total } = d.progress;
            if (liveFramesCount) {
              liveFramesCount.style.display = 'block';
              liveFramesCount.textContent = total > 0 ? `${done}/${total} FRAMES` : `${done} FRAMES`;
            }
          }
          if (typeof d?.elapsed_seconds === 'number') {
            const sec = Math.max(0, Math.floor(d.elapsed_seconds));
            const mins = Math.floor(sec / 60);
            const secs = sec % 60;
            if (elapsedTimeEl) {
              elapsedTimeEl.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
            }
            fetchStartTime = performance.now() - (sec * 1000);
          }
          if (progressBar) progressBar.style.display = 'none';
          if (liveFetchInfo) liveFetchInfo.style.display = 'flex';
          if (!elapsedTimer) {
            startElapsedCounter();
          }
        },
        onProgress: (info, total) => {
          if (info && (info.status === 'fetching' || typeof info === 'object')) {
            setRightPanelWaiting(true);
            const serverMsg = info.message || "FETCHING REAL DATA (about 1 to 2 minutes when NASA's archive responds; may be slower or throttled)...";
            scanText.textContent = serverMsg;
            if (info?.progress && typeof info.progress.done === 'number' && typeof info.progress.total === 'number') {
              const { done, total } = info.progress;
              if (liveFramesCount) {
                liveFramesCount.style.display = 'block';
                liveFramesCount.textContent = total > 0 ? `${done}/${total} FRAMES` : `${done} FRAMES`;
              }
            }
            if (typeof info.elapsed_seconds === 'number') {
              const sec = Math.max(0, Math.floor(info.elapsed_seconds));
              const mins = Math.floor(sec / 60);
              const secs = sec % 60;
              if (elapsedTimeEl) {
                elapsedTimeEl.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
              }
              fetchStartTime = performance.now() - (sec * 1000);
            }
            if (progressBar) progressBar.style.display = 'none';
            if (liveFetchInfo) liveFetchInfo.style.display = 'flex';
            if (!elapsedTimer) {
              startElapsedCounter();
            }
          } else if (typeof info === 'number') {
            if (!isLive) {
              scanText.textContent = `SCANNING 9 FRAMES... ${info}/${total}`;
              if (progressFill) progressFill.style.width = `${(info / total) * 100}%`;
            }
          }
        },
      });

      if (timeoutId) clearTimeout(timeoutId);
      if (signal.aborted) return;

      state.preloadTimeMs = performance.now() - startTime;
      await processLoadedFrames(result, cacheKey);
    } catch (err) {
      if (timeoutId) clearTimeout(timeoutId);
      stopElapsedCounter();
      setRightPanelWaiting(false);
      loadingOverlay.style.display = 'none';

      // 404 "not cached": show HUD dialog
      if (err.isNotCached || err.status === 404) {
        if (window.__argusHUD && typeof window.__argusHUD.showNotCachedDialog === 'function') {
          window.__argusHUD.showNotCachedDialog({
            ra: effectiveRa,
            dec: effectiveDec,
            fov: fovNum,
            name: effectiveName,
          });
        }
        return;
      }

      if (signal.aborted || err.name === 'AbortError') {
        loadingOverlay.style.display = 'none';
        errorOverlay.style.display = 'none';
        return;
      }

      if (err.isBusy || err.status === 429) {
        errorOverlay.style.display = 'flex';
        if (errorTitle) errorTitle.textContent = 'SERVER BUSY';
        const waitSec = err.retryAfter || 30;
        errorDesc.textContent = `SERVER BUSY, TRY AGAIN IN ${waitSec} s`;
        if (btnRetry) {
          btnRetry.style.display = 'inline-block';
          btnRetry.textContent = 'RETRY';
        }
        if (btnUseSim) {
          btnUseSim.style.display = 'inline-block';
        }
        return;
      }

      errorOverlay.style.display = 'flex';
      if (errorTitle) errorTitle.textContent = 'FRAME ACQUISITION FAILED';
      errorDesc.textContent = err.message || 'Unable to retrieve frames.';
      if (btnRetry) {
        btnRetry.style.display = 'inline-block';
        btnRetry.textContent = 'RETRY';
      }
      if (btnUseSim) {
        btnUseSim.style.display = 'inline-block';
      }
      console.warn('Frame acquisition error:', err);
    }
  }

  // ─── Render Frame on Canvas ──────────────────────────────────────────────────
  function renderCurrentFrame() {
    if (!state.frames || state.frames.length === 0) return;

    // Track frame timing for average frame time calculation
    const now = performance.now();
    const delta = now - lastFrameTime;
    lastFrameTime = now;
    if (delta > 20 && delta < 2000) {
      frameTimeHistory.push(delta);
      if (frameTimeHistory.length > 20) frameTimeHistory.shift();
      state.avgFrameTimeMs = frameTimeHistory.reduce((a, b) => a + b, 0) / frameTimeHistory.length;
    }

    // Source Badge: "SPHEREX DATA (LIVE)" with "NOT ALIGNED", "SPHEREX DATA", or "SIMULATED FRAMES"
    if (state.live) {
      stageSourceBadge.className = 'stage-source-badge live';
      stageSourceText.innerHTML = 'SPHEREX DATA (LIVE) <span class="tag-not-aligned">NOT ALIGNED</span>';
    } else if (state.source === 'api' && state.mock !== true) {
      stageSourceBadge.className = 'stage-source-badge api';
      stageSourceText.textContent = 'SPHEREX DATA';
    } else {
      stageSourceBadge.className = 'stage-source-badge simulated';
      stageSourceText.textContent = 'SIMULATED FRAMES';
    }

    const ctx = displayCanvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;

    if (state.mode === 'DIFFERENCE') {
      stageCandidatesLayer.style.display = 'block';
      const frameA = state.frames[state.blinkFrameA];
      const frameB = state.frames[state.blinkFrameB];
      if (!frameA || !frameB) return;

      const diffResult = computeDifference(frameA.imageData, frameB.imageData, state.diffGain);
      state.diffResult = diffResult;
      state.candidates = diffResult.candidates;

      ctx.clearRect(0, 0, 600, 600);
      ctx.drawImage(diffResult.diffCanvas, 0, 0);

      // Overlays
      stageFrameCounter.textContent = `DIFF |F${state.blinkFrameB + 1} - F${state.blinkFrameA + 1}|`;
      stageFrameDate.textContent = `${frameB.date} - ${frameA.date}`;
      stageDetectorLabel.textContent = `GAIN ${state.diffGain.toFixed(1)}x`;

      renderCandidates(diffResult.candidates);
      renderExpectedPosition();
      return;
    }

    // Clear candidates in PLAY and BLINK modes
    stageCandidatesLayer.style.display = 'none';
    stageCandidatesLayer.innerHTML = '';

    let activeIdx = state.currentFrameIndex;
    let labelPrefix = '';

    if (state.mode === 'BLINK') {
      activeIdx = (state.currentFrameIndex % 2 === 0) ? state.blinkFrameA : state.blinkFrameB;
      labelPrefix = (state.currentFrameIndex % 2 === 0) ? '[A] ' : '[B] ';
      updateBlinkInfoLabel();
    }

    const curFrame = state.frames[activeIdx];
    if (!curFrame) return;

    ctx.clearRect(0, 0, 600, 600);
    if (curFrame.loadedImage && curFrame.loadedImage.complete && curFrame.loadedImage.naturalWidth > 0) {
      ctx.drawImage(curFrame.loadedImage, 0, 0, 600, 600);
    } else if (curFrame.imageData) {
      ctx.putImageData(curFrame.imageData, 0, 0);
    } else if (curFrame.image_url) {
      const img = new Image();
      if (!curFrame.image_url.startsWith('data:') && !curFrame.image_url.startsWith('blob:')) {
        img.crossOrigin = 'anonymous';
      }
      img.onload = () => {
        curFrame.loadedImage = img;
        if (state.currentFrameIndex === activeIdx && state.mode !== 'DIFFERENCE') {
          ctx.clearRect(0, 0, 600, 600);
          ctx.drawImage(img, 0, 0, 600, 600);
        }
      };
      img.src = curFrame.image_url;
    }

    const totalFrames = (state.frames && state.frames.length) ? state.frames.length : (state.live ? 6 : 9);

    // Stage Overlay updates
    stageFrameCounter.textContent = `FRAME ${activeIdx + 1}/${totalFrames} ${labelPrefix}`;
    stageFrameDate.textContent = curFrame.date || '';
    stageDetectorLabel.textContent = curFrame.detector || 'DETECTOR 1';

    // Slider sync
    if (frameSlider && state.mode === 'PLAY') {
      frameSlider.value = String(activeIdx + 1);
      sliderFrameLabel.textContent = `FRAME ${activeIdx + 1} OF ${totalFrames}`;
    }

    renderExpectedPosition();
  }

  // ─── Render Candidate Movers on Stage & In Card ──────────────────────────────
  function renderCandidates(candidates) {
    stageCandidatesLayer.innerHTML = '';
    candidatesListWrap.innerHTML = '';
    candidatesHeader.textContent = `CANDIDATES (${candidates.length})`;

    if (candidates.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'candidates-note';
      empty.textContent = 'No candidate moving object above threshold.';
      candidatesListWrap.appendChild(empty);
      return;
    }

    candidates.forEach(c => {
      // Stage Marker (Pulsing Red Ring)
      const marker = document.createElement('div');
      marker.className = 'stage-candidate-marker';
      marker.style.left = `${(c.x / 600) * 100}%`;
      marker.style.top = `${(c.y / 600) * 100}%`;
      marker.innerHTML = `
        <div class="candidate-pulse-ring"></div>
        <div class="candidate-marker-tag">C${c.id}</div>
      `;
      marker.addEventListener('click', () => {
        highlightCandidate(c.id);
      });
      stageCandidatesLayer.appendChild(marker);

      // Card List Item
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'candidate-item-btn';
      btn.id = `candidate-item-${c.id}`;
      btn.innerHTML = `
        <span>CANDIDATE ${c.id}</span>
        <span style="color:var(--color-amber);">X:${c.x} Y:${c.y} (+${c.sigmaAbove}σ)</span>
      `;
      btn.addEventListener('click', () => {
        highlightCandidate(c.id);
      });
      candidatesListWrap.appendChild(btn);
    });
  }

  function highlightCandidate(id) {
    const listBtns = candidatesListWrap.querySelectorAll('.candidate-item-btn');
    listBtns.forEach(b => b.style.borderColor = '');
    const activeBtn = document.getElementById(`candidate-item-${id}`);
    if (activeBtn) activeBtn.style.borderColor = '#ffbe3b';
  }

  // ─── Playback Loop ──────────────────────────────────────────────────────────
  let playbackTimer = null;

  function scheduleNextFrame() {
    if (playbackTimer) clearTimeout(playbackTimer);
    if (!state.isPlaying) return;

    // Base interval 400ms at 1.0x speed
    const interval = Math.max(50, 400 / state.speedMultiplier);

    playbackTimer = setTimeout(() => {
      if (!state.isPlaying) return;

      if (state.mode === 'PLAY') {
        const total = (state.frames && state.frames.length) ? state.frames.length : (state.live ? 6 : 9);
        const nextIdx = state.currentFrameIndex + 1;
        if (nextIdx >= total) {
          if (state.isLooping) {
            state.currentFrameIndex = 0;
          } else {
            state.isPlaying = false;
            updatePlayButton();
            renderCurrentFrame();
            return;
          }
        } else {
          state.currentFrameIndex = nextIdx;
        }
      } else if (state.mode === 'BLINK') {
        state.currentFrameIndex = (state.currentFrameIndex + 1) % 2;
      }

      renderCurrentFrame();
      scheduleNextFrame();
    }, interval);
  }

  function updatePlayButton() {
    if (state.isPlaying) {
      btnPlayToggle.textContent = '❚❚ PAUSE';
      btnBlinkToggle.textContent = '❚❚ PAUSE BLINK';
    } else {
      btnPlayToggle.textContent = '▶ PLAY';
      btnBlinkToggle.textContent = '▶ PLAY BLINK';
    }
  }

  function togglePlayPause() {
    state.isPlaying = !state.isPlaying;
    updatePlayButton();
    if (state.isPlaying) {
      scheduleNextFrame();
    } else if (playbackTimer) {
      clearTimeout(playbackTimer);
    }
  }

  // ─── Mode Switching ──────────────────────────────────────────────────────────
  function setMode(newMode) {
    state.mode = newMode;
    [btnModePlay, btnModeBlink, btnModeDiff].forEach(b => b.classList.remove('active'));
    panelPlay.style.display = 'none';
    panelBlink.style.display = 'none';
    panelDiff.style.display = 'none';

    if (newMode === 'PLAY') {
      btnModePlay.classList.add('active');
      panelPlay.style.display = 'flex';
      if (state.isPlaying) scheduleNextFrame();
    } else if (newMode === 'BLINK') {
      btnModeBlink.classList.add('active');
      panelBlink.style.display = 'flex';
      state.speedMultiplier = 0.75;
      document.querySelectorAll('#blink-speed-pills .speed-pill-btn').forEach(b => {
        b.classList.toggle('active', parseFloat(b.dataset.speed) === 0.75);
      });
      updateBlinkInfoLabel();
      if (state.isPlaying) scheduleNextFrame();
    } else if (newMode === 'DIFFERENCE') {
      btnModeDiff.classList.add('active');
      panelDiff.style.display = 'flex';
      if (playbackTimer) clearTimeout(playbackTimer);
    }
    renderCurrentFrame();
  }

  // ─── Event Listeners ─────────────────────────────────────────────────────────
  // Mode Buttons
  btnModePlay.addEventListener('click', () => setMode('PLAY'));
  btnModeBlink.addEventListener('click', () => setMode('BLINK'));
  btnModeDiff.addEventListener('click', () => setMode('DIFFERENCE'));

  // Playback Buttons
  btnPlayToggle.addEventListener('click', togglePlayPause);
  btnBlinkToggle.addEventListener('click', togglePlayPause);

  btnPlayPrev.addEventListener('click', () => {
    const total = (state.frames && state.frames.length) ? state.frames.length : (state.live ? 6 : 9);
    state.currentFrameIndex = (state.currentFrameIndex - 1 + total) % total;
    renderCurrentFrame();
  });

  btnPlayNext.addEventListener('click', () => {
    const total = (state.frames && state.frames.length) ? state.frames.length : (state.live ? 6 : 9);
    state.currentFrameIndex = (state.currentFrameIndex + 1) % total;
    renderCurrentFrame();
  });

  btnLoopToggle.addEventListener('click', () => {
    state.isLooping = !state.isLooping;
    btnLoopToggle.classList.toggle('active', state.isLooping);
    btnLoopToggle.textContent = `LOOP: ${state.isLooping ? 'ON' : 'OFF'}`;
  });

  frameSlider.addEventListener('input', (e) => {
    state.currentFrameIndex = parseInt(e.target.value, 10) - 1;
    renderCurrentFrame();
  });

  // Speed Buttons
  document.querySelectorAll('.speed-pill-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const speed = parseFloat(e.currentTarget.dataset.speed);
      state.speedMultiplier = speed;
      document.querySelectorAll(`.speed-pill-btn[data-speed="${speed}"]`).forEach(b => {
        b.classList.add('active');
      });
      document.querySelectorAll(`.speed-pill-btn:not([data-speed="${speed}"])`).forEach(b => {
        b.classList.remove('active');
      });
      if (state.isPlaying) scheduleNextFrame();
    });
  });

  // Blink Selectors
  selectBlinkA.addEventListener('change', (e) => {
    state.blinkFrameA = parseInt(e.target.value, 10);
    if (selectDiffA) selectDiffA.value = e.target.value;
    updateBlinkInfoLabel();
    renderCurrentFrame();
  });

  selectBlinkB.addEventListener('change', (e) => {
    state.blinkFrameB = parseInt(e.target.value, 10);
    if (selectDiffB) selectDiffB.value = e.target.value;
    updateBlinkInfoLabel();
    renderCurrentFrame();
  });

  // Diff Selectors & Gain
  selectDiffA.addEventListener('change', (e) => {
    state.blinkFrameA = parseInt(e.target.value, 10);
    if (selectBlinkA) selectBlinkA.value = e.target.value;
    updateBlinkInfoLabel();
    renderCurrentFrame();
  });

  selectDiffB.addEventListener('change', (e) => {
    state.blinkFrameB = parseInt(e.target.value, 10);
    if (selectBlinkB) selectBlinkB.value = e.target.value;
    updateBlinkInfoLabel();
    renderCurrentFrame();
  });

  diffGainSlider.addEventListener('input', (e) => {
    const gain = parseFloat(e.target.value);
    state.diffGain = gain;
    diffGainReadout.textContent = `${gain.toFixed(1)}x`;
    renderCurrentFrame();
  });

  // Error Actions
  btnRetry.addEventListener('click', () => {
    errorOverlay.style.display = 'none';
    loadFramesForTarget(state.ra, state.dec, state.fov, state.name, false, {
      liveFetch: Boolean(state.isLiveRequest),
    });
  });

  btnUseSim.addEventListener('click', () => {
    // Force simulated frames fallback
    errorOverlay.style.display = 'none';
    loadFramesForTarget(state.ra, state.dec, state.fov, state.name, false, { forceSimulated: true });
  });

  // Navigation Buttons
  function goBackToProbeConfirmed() {
    if (activeAbortController) {
      activeAbortController.abort();
      activeAbortController = null;
    }
    stopElapsedCounter();
    setRightPanelWaiting(false);
    loadingOverlay.style.display = 'none';
    errorOverlay.style.display = 'none';
    if (playbackTimer) clearTimeout(playbackTimer);
    if (typeof window.setScreen === 'function') {
      window.setScreen('probe');
    }
    // Return to probe in the CONFIRMED state
    if (window.__argusHUD && typeof window.__argusHUD.setLocBarState === 'function') {
      window.__argusHUD.setLocBarState('confirmed');
    }
  }

  function goBackToProbeMenu() {
    stopElapsedCounter();
    setRightPanelWaiting(false);
    loadingOverlay.style.display = 'none';
    errorOverlay.style.display = 'none';
    if (playbackTimer) clearTimeout(playbackTimer);
    if (typeof window.setScreen === 'function') {
      window.setScreen('probe');
    }
    // Return to probe menu
    if (window.__argusHUD) {
      if (typeof window.__argusHUD.setPanelView === 'function') {
        window.__argusHUD.setPanelView('menu');
      }
      if (typeof window.__argusHUD.setLocBarState === 'function') {
        window.__argusHUD.setLocBarState('editing');
      }
    }
  }

  btnViewerBack.addEventListener('click', goBackToProbeConfirmed);
  btnViewerNewTarget.addEventListener('click', goBackToProbeMenu);

  // ─── Keyboard Navigation ─────────────────────────────────────────────────────
  window.addEventListener('keydown', (e) => {
    if (!document.body.classList.contains('screen-viewer')) return;

    const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
    if (activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select') return;

    if (e.code === 'Space') {
      e.preventDefault();
      togglePlayPause();
    } else if (e.code === 'ArrowLeft') {
      e.preventDefault();
      const total = (state.frames && state.frames.length) ? state.frames.length : (state.live ? 6 : 9);
      state.currentFrameIndex = (state.currentFrameIndex - 1 + total) % total;
      renderCurrentFrame();
    } else if (e.code === 'ArrowRight') {
      e.preventDefault();
      const total = (state.frames && state.frames.length) ? state.frames.length : (state.live ? 6 : 9);
      state.currentFrameIndex = (state.currentFrameIndex + 1) % total;
      renderCurrentFrame();
    } else if (e.key === 'b' || e.key === 'B') {
      e.preventDefault();
      const modes = ['PLAY', 'BLINK', 'DIFFERENCE'];
      const curIdx = modes.indexOf(state.mode);
      const nextMode = modes[(curIdx + 1) % modes.length];
      setMode(nextMode);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      goBackToProbeConfirmed();
    }
  });

  // ─── Entry Point from argus:probe Event ──────────────────────────────────────
  window.addEventListener('argus:probe', (e) => {
    const { ra, dec, fov, name, preloadedResult, forceSimulated, liveFetch, response } = e.detail || {};
    const selected = getSelectedTarget();
    const defaultTarget = Object.values(TARGETS)[0];
    const targetRa = (typeof ra === 'number') ? ra : (selected?.ra ?? defaultTarget.ra);
    const targetDec = (typeof dec === 'number') ? dec : (selected?.dec ?? defaultTarget.dec);
    const targetFov = (typeof fov === 'number') ? fov : (selected?.fov ?? defaultTarget.fov);
    const targetName = name || selected?.name || defaultTarget.name;

    // Transition to viewer (avoid hashchange reload)
    if (typeof window.setScreen === 'function') {
      window.setScreen('viewer', false);
    }

    state.entryFov = targetFov;
    const finalPreloaded = preloadedResult || response;
    const isLiveReq = Boolean(liveFetch || (finalPreloaded && (finalPreloaded.live === true || finalPreloaded.live === 'true')));
    loadFramesForTarget(targetRa, targetDec, targetFov, targetName, true, {
      preloadedResult: finalPreloaded,
      forceSimulated,
      liveFetch: isLiveReq,
    });
  });

  // ─── URL Query / Hash Detection on Load ──────────────────────────────────────
  function checkUrlForViewer() {
    const url = new URL(window.location.href);
    let qRa = url.searchParams.get('ra');
    let qDec = url.searchParams.get('dec');
    let qFov = url.searchParams.get('fov');
    let qName = url.searchParams.get('name');
    const hasHashViewer = window.location.hash.startsWith('#viewer');

    if (qRa === null && window.location.hash) {
      const hashParams = new URLSearchParams(window.location.hash.replace(/^#viewer[?&]?/, ''));
      if (hashParams.has('ra')) qRa = hashParams.get('ra');
      if (hashParams.has('dec')) qDec = hashParams.get('dec');
      if (hashParams.has('fov')) qFov = hashParams.get('fov');
      if (hashParams.has('name')) qName = hashParams.get('name');
    }

    if (qRa !== null && qDec !== null) {
      const ra = parseFloat(qRa);
      const dec = parseFloat(qDec);
      const fov = qFov !== null ? parseFloat(qFov) : 0.20;
      const targetObj = getTargetInfo(qName, ra, dec);
      const name = qName || targetObj?.name || 'CUSTOM SPOT';

      if (typeof window.setScreen === 'function') {
        window.setScreen('viewer', false);
      }
      state.entryFov = fov;
      loadFramesForTarget(ra, dec, fov, name, true);
    } else if (hasHashViewer && (!state.frames || state.frames.length === 0)) {
      const selected = getSelectedTarget() || Object.values(TARGETS)[0];
      const ra = selected?.ra ?? 269.452;
      const dec = selected?.dec ?? 4.693;
      const fov = selected?.fov ?? 0.20;
      const name = selected?.name || "BARNARD'S STAR";

      if (typeof window.setScreen === 'function') {
        window.setScreen('viewer', false);
      }
      state.entryFov = fov;
      loadFramesForTarget(ra, dec, fov, name, true);
    }
  }

  window.addEventListener('hashchange', () => {
    if (window.location.hash.startsWith('#viewer')) {
      const url = new URL(window.location.href);
      const hasSearch = url.searchParams.has('ra') && url.searchParams.has('dec');
      const hashPart = window.location.hash.replace(/^#viewer[?&]?/, '');
      const hashParams = new URLSearchParams(hashPart);
      const hasHashCoords = hashParams.has('ra') && hashParams.has('dec');
      if (hasSearch || hasHashCoords) {
        checkUrlForViewer();
      }
    }
  });

  checkUrlForViewer();

  // Expose verification API for automated testing & measurements
  window.__argusViewer = {
    getState: () => ({ ...state }),
    getSourceBadgeText: () => stageSourceText?.textContent || '',
    getSourceBadgeClass: () => stageSourceBadge?.className || '',
    getFrameCount: () => (state.frames ? state.frames.length : 0),
    getPreloadTime: () => Math.round(state.preloadTimeMs),
    getFov: () => state.fov,
    getEntryFov: () => state.entryFov,
    getFovSteps: () => Array.from(document.querySelectorAll('.fov-step-btn')).map(b => parseFloat(b.dataset.fov)),
    getActiveFov: () => {
      const b = document.querySelector('.fov-step-btn.active');
      return b ? parseFloat(b.dataset.fov) : null;
    },
    isLiveFetch: () => !isCachedDemoTarget(state.ra, state.dec, state.fov),
    cancelFetch: () => { btnCancel?.click(); },
    getElapsedText: () => elapsedTimeEl?.textContent || '',
    getMoverPositions: () => {
      if (!state.frames || state.frames.length < 2) return null;
      const lastIdx = state.frames.length - 1;
      return {
        frame1: state.frames[0].moverPos,
        frame9: state.frames[lastIdx].moverPos,
      };
    },
    getStaticStarPosition: () => {
      if (!state.frames || state.frames.length < 2) return null;
      const lastIdx = state.frames.length - 1;
      return {
        frame1: state.frames[0].staticStarSample,
        frame9: state.frames[lastIdx].staticStarSample,
      };
    },
    getDifferenceMetrics: () => {
      if (!state.diffResult) {
        // Run difference if not currently in diff mode
        if (state.frames && state.frames.length >= 2) {
          const lastIdx = state.frames.length - 1;
          const imgA = state.frames[0].imageData;
          const imgB = state.frames[lastIdx].imageData;
          if (imgA && imgB) {
            const res = computeDifference(imgA, imgB, state.diffGain);
            return res.metrics;
          }
        }
        return null;
      }
      return state.diffResult.metrics;
    },
    getCandidates: () => state.candidates || [],
    getScaleBarLength: (fov) => {
      return (0.02 / fov) * 600;
    },
    getAverageFrameTime: () => Math.round(state.avgFrameTimeMs),
    setMode: (m) => setMode(m),
    loadFrames: (r, d, f, n, options = {}) => loadFramesForTarget(r, d, f, n, true, options),
    getState: () => state,
    getBlinkPair: () => [state.blinkFrameA, state.blinkFrameB],
    getBlinkInfoText: () => blinkPairInfoLabel?.textContent || '',
    getZoomLevel: () => state.zoomLevel,
    getPan: () => [state.panX, state.panY],
    getCaptionText: () => understageCaption?.textContent || '',
    getExpectedPositionVisible: () => expectedPositionMarker?.style.display !== 'none',
    getScientificProofVisible: () => scientificProofBox ? (scientificProofBox.style.display !== 'none') : false,
    getScientificProofText: () => {
      const el = document.getElementById('viewer-scientific-proof-text');
      return el ? el.textContent.trim() : (scientificProofBox ? scientificProofBox.textContent.trim() : '');
    },
    getMotionCheckVisible: () => scientificProofBox ? (scientificProofBox.style.display !== 'none') : false,
    getMotionCheckText: () => {
      const el = document.getElementById('viewer-scientific-proof-text');
      return el ? el.textContent.trim() : (scientificProofBox ? scientificProofBox.textContent.trim() : '');
    },
    getVignetteEnabled: () => state.vignetteEnabled,
    toggleVignette: () => {
      btnToggleVignette?.click();
      return state.vignetteEnabled;
    },
    saveImage: () => {
      btnSaveImage?.click();
      return displayCanvas ? displayCanvas.toDataURL('image/png') : null;
    },
    getArtifactWarningVisible: () => {
      const el = document.getElementById('viewer-artifact-warning');
      return el ? el.style.display !== 'none' : false;
    },
    getArtifactWarningText: () => {
      const el = document.getElementById('viewer-artifact-warning');
      return el ? el.textContent.trim() : '';
    },
    isWaitingForData: () => viewerControlCard?.classList.contains('is-waiting') || false,
    setZoom: (z) => setZoom(z),
    setPairMode: (m) => applyPairMode(m),
    toggleExpectedPosition: () => btnToggleExpected?.click(),
  };

  window.viewerAPI = window.__argusViewer;
  return window.__argusViewer;
}
