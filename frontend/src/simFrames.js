// ─── Deterministic Seeded PRNG (Mulberry32) ──────────────────────────────────
function createRNG(seedStr) {
  let h = 2166136261 >>> 0;
  const str = String(seedStr);
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  }
  let a = h >>> 0;
  return function() {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Target Kind Classification ───────────────────────────────────────────────
export function detectTargetKind(name, ra, dec) {
  const norm = (name || '').toUpperCase().trim();
  if (norm.includes('WISE') || norm.includes('0855') || (Math.abs(ra - 133.795) < 0.1 && Math.abs(dec - -7.245) < 0.1)) {
    return 'WISE 0855';
  }
  if (norm.includes('BARNARD') || (Math.abs(ra - 269.452) < 0.1 && Math.abs(dec - 4.693) < 0.1)) {
    return "Barnard's Star";
  }
  if (norm.includes('EPSILON') || norm.includes('INDI') || (Math.abs(ra - 331.044) < 0.1 && Math.abs(dec - -56.783) < 0.1)) {
    return 'Epsilon Indi B';
  }
  if (norm.includes('AURIGAE') || norm.includes('RW') || (Math.abs(ra - 76.956) < 0.1 && Math.abs(dec - 30.401) < 0.1)) {
    return 'RW Aurigae';
  }
  if (norm.includes('DRACONIS') || (Math.abs(ra - 248.168) < 0.1 && Math.abs(dec - 66.755) < 0.1)) {
    return 'R Draconis';
  }
  return 'OTHER';
}

// ─── Draw Gaussian Star Profile into Float Luminance Buffer ───────────────────
function stampGaussian(lum, w, h, cx, cy, peak, sigma) {
  const radius = Math.ceil(sigma * 3.5);
  const minX = Math.max(0, Math.floor(cx - radius));
  const maxX = Math.min(w - 1, Math.ceil(cx + radius));
  const minY = Math.max(0, Math.floor(cy - radius));
  const maxY = Math.min(h - 1, Math.ceil(cy + radius));
  const twoSigmaSq = 2 * sigma * sigma;

  for (let y = minY; y <= maxY; y++) {
    const dy = y - cy;
    const dySq = dy * dy;
    const rowOffset = y * w;
    for (let x = minX; x <= maxX; x++) {
      const dx = x - cx;
      const distSq = dx * dx + dySq;
      const intensity = peak * Math.exp(-distSq / twoSigmaSq);
      lum[rowOffset + x] += intensity;
    }
  }
}

/**
 * Generate 9 simulated sky frames of 600x600 in browser canvas with seeded RNG.
 *
 * @param {number} ra - Right ascension in degrees
 * @param {number} dec - Declination in degrees
 * @param {number} fov - Field of view in degrees (default 0.20)
 * @param {string} name - Target name
 * @param {function} [onProgress] - Optional callback (loadedCount, total)
 * @param {AbortSignal} [signal] - Optional abort signal
 * @returns {Promise<{frames: Array, source: 'simulated'}>}
 */
export async function generateSimFrames(ra, dec, fov = 0.20, name = '', onProgress = null, signal = null) {
  const targetKind = detectTargetKind(name, ra, dec);
  const seedKey = targetKind !== 'OTHER'
    ? targetKind
    : `${Math.round(ra * 100)}_${Math.round(dec * 100)}`;
  
  const rng = createRNG(seedKey);

  const W = 600;
  const H = 600;
  const TOTAL_FRAMES = 9;

  // 1. Generate Fixed Starfield (~120 stars) with seeded RNG
  const starCount = 120;
  const staticStars = [];
  for (let i = 0; i < starCount; i++) {
    const sx = 20 + rng() * 560;
    const sy = 20 + rng() * 560;
    // Power law distribution for realistic stellar magnitudes
    const brightness = 35 + Math.pow(rng(), 2.4) * 210;
    const sigma = 0.8 + rng() * 1.0;
    staticStars.push({ x: sx, y: sy, brightness, sigma });
  }

  // Pre-calculate target mover trajectories across 9 frames
  const moverTrajectory = [];
  const secondaryMoverTrajectory = [];
  const variableBrightness = [];

  if (targetKind === 'WISE 0855') {
    // One bright dot moving along a straight path
    const startX = 240;
    const startY = 290;
    const dx = 10;
    const dy = 4;
    for (let f = 0; f < TOTAL_FRAMES; f++) {
      moverTrajectory.push({
        x: startX + f * dx,
        y: startY + f * dy,
        brightness: 235,
        sigma: 1.3,
      });
    }
  } else if (targetKind === "Barnard's Star") {
    // High proper motion: moves faster than WISE 0855
    const startX = 180;
    const startY = 210;
    const dx = 20;
    const dy = 10;
    for (let f = 0; f < TOTAL_FRAMES; f++) {
      moverTrajectory.push({
        x: startX + f * dx,
        y: startY + f * dy,
        brightness: 245,
        sigma: 1.4,
      });
    }
  } else if (targetKind === 'Epsilon Indi B') {
    // Two close dots moving together
    const startX = 220;
    const startY = 260;
    const dx = 12;
    const dy = 6;
    for (let f = 0; f < TOTAL_FRAMES; f++) {
      const cx = startX + f * dx;
      const cy = startY + f * dy;
      moverTrajectory.push({
        x: cx - 4,
        y: cy - 3,
        brightness: 220,
        sigma: 1.1,
      });
      secondaryMoverTrajectory.push({
        x: cx + 5,
        y: cy + 4,
        brightness: 195,
        sigma: 1.0,
      });
    }
  } else if (targetKind === 'RW Aurigae') {
    // T Tauri variable star: NO motion, brightness changes
    const curve = [75, 105, 150, 205, 245, 195, 140, 95, 70];
    for (let f = 0; f < TOTAL_FRAMES; f++) {
      variableBrightness.push({
        x: 300,
        y: 300,
        brightness: curve[f],
        sigma: 1.3,
      });
    }
  } else if (targetKind === 'R Draconis') {
    // Known variable star
    const curve = [50, 80, 135, 215, 255, 210, 145, 85, 52];
    for (let f = 0; f < TOTAL_FRAMES; f++) {
      variableBrightness.push({
        x: 300,
        y: 300,
        brightness: curve[f],
        sigma: 1.4,
      });
    }
  } else {
    // Any other coordinates: one random mover
    const startX = 160 + rng() * 280;
    const startY = 160 + rng() * 280;
    let vx = -14 + rng() * 28;
    let vy = -14 + rng() * 28;
    if (Math.hypot(vx, vy) < 8) {
      vx = 10;
      vy = 8;
    }
    for (let f = 0; f < TOTAL_FRAMES; f++) {
      moverTrajectory.push({
        x: startX + f * vx,
        y: startY + f * vy,
        brightness: 225,
        sigma: 1.2,
      });
    }
  }

  // Monthly date sequence
  const baseDate = new Date(Date.UTC(2025, 0, 15));
  const frames = [];

  // Deterministic noise generator so each frame has realistic CCD sensor noise
  const frameNoiseRNG = createRNG(seedKey + '_noise');

  for (let f = 0; f < TOTAL_FRAMES; f++) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    const fDate = new Date(Date.UTC(2025, f, 15));
    const dateStr = fDate.toISOString().split('T')[0];

    // Allocate 600x600 luminance buffer
    const lum = new Float32Array(W * H);
    // Base sky background ~ 10.0
    lum.fill(10.0);

    // 1. Stamp identical static stars
    for (let i = 0; i < staticStars.length; i++) {
      const s = staticStars[i];
      stampGaussian(lum, W, H, s.x, s.y, s.brightness, s.sigma);
    }

    // 2. Stamp target mover(s) or variable star
    if (moverTrajectory[f]) {
      const m = moverTrajectory[f];
      stampGaussian(lum, W, H, m.x, m.y, m.brightness, m.sigma);
    }
    if (secondaryMoverTrajectory[f]) {
      const m = secondaryMoverTrajectory[f];
      stampGaussian(lum, W, H, m.x, m.y, m.brightness, m.sigma);
    }
    if (variableBrightness[f]) {
      const v = variableBrightness[f];
      stampGaussian(lum, W, H, v.x, v.y, v.brightness, v.sigma);
    }

    // 3. Create canvas and rasterize into ImageData with slight Gaussian/uniform noise
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(W, H);
    const data = imgData.data;

    for (let i = 0; i < W * H; i++) {
      // Noise with mean 0, range approx -2.5 to +2.5
      const noise = (frameNoiseRNG() + frameNoiseRNG() - 1.0) * 2.8;
      const pixelVal = Math.max(0, Math.min(255, Math.round(lum[i] + noise)));
      const p = i * 4;
      data[p]     = pixelVal;
      data[p + 1] = pixelVal;
      data[p + 2] = pixelVal;
      data[p + 3] = 255;
    }

    ctx.putImageData(imgData, 0, 0);

    // Convert to Blob URL
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const imageUrl = URL.createObjectURL(blob);

    const moverPos = moverTrajectory[f] ? { x: moverTrajectory[f].x, y: moverTrajectory[f].y } : null;
    const staticStarSample = { x: staticStars[12].x, y: staticStars[12].y };

    frames.push({
      frameIndex: f + 1,
      totalFrames: TOTAL_FRAMES,
      date: dateStr,
      image_url: imageUrl,
      imageData: imgData, // preserved in memory for fast difference rendering
      detector: `DETECTOR ${((f % 3) + 1)}`,
      wavelength_um: (2.4 + (f * 0.1)).toFixed(1),
      flags: 0,
      targetKind,
      moverPos,
      staticStarSample,
      target_xy: moverPos ? [Math.round(moverPos.x), Math.round(moverPos.y)] : undefined,
    });

    if (typeof onProgress === 'function') {
      onProgress(f + 1, TOTAL_FRAMES);
    }
  }

  return {
    frames,
    source: 'simulated',
    mock: true,
  };
}
