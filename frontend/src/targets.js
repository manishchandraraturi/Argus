// ─── Target Catalog & Coordinates ─────────────────────────────────────────────
// Verified coordinates and FOVs for ARGUS survey targets.

export const TARGET_TODO_COORDINATES = {
  "Barnard's Star": {
    ra: 269.452,
    dec: 4.693,
    fov: 0.20,
    frames: 14,
    dist1: "0.20 DEG",
    dist2: "0.10 DEG",
    bestPair: [0, 9],
    caption: "High proper-motion star. Compare the first and last frames: a bright/dark pair appears at the predicted position.",
  },
  "Epsilon Indi B": {
    ra: 331.044,
    dec: -56.783,
    fov: 0.15,
    frames: 11,
    dist1: "0.15 DEG",
    dist2: "0.08 DEG",
    bestPair: [1, 9],
    caption: "Faint candidate near the predicted position. Weak signal.",
  },
  "RW Aurigae": {
    ra: 76.956,
    dec: 30.401,
    fov: 0.20,
    frames: 16,
    dist1: "0.20 DEG",
    dist2: "0.10 DEG",
    bestPair: [1, 9],
    caption: "Variable star. No motion claim is made.",
    isVariable: true,
  },
  "R Draconis": {
    ra: 248.168,
    dec: 66.755,
    fov: 0.20,
    frames: 7,
    dist1: "0.20 DEG",
    dist2: "0.10 DEG",
    bestPair: [0, 11],
    caption: "Variable star. No motion claim is made.",
    isVariable: true,
  },
};

export const TARGETS = {
  "Barnard's Star": {
    name: "BARNARD'S STAR",
    ...TARGET_TODO_COORDINATES["Barnard's Star"],
    profile: "HIGH PROPER MOTION",
  },
  "WISE 0855": {
    name: "WISE 0855",
    ra: 133.795,
    dec: -7.245,
    fov: 0.20,
    frames: 9,
    dist1: "0.20 DEG",
    dist2: "0.10 DEG",
    profile: "BROWN DWARF CANDIDATE",
    bestPair: [1, 6],
    caption: "No catalog motion available in this demo.",
  },
  "Epsilon Indi B": {
    name: "EPSILON INDI B",
    ...TARGET_TODO_COORDINATES["Epsilon Indi B"],
    profile: "BINARY SUBSTELLAR",
  },
  "RW Aurigae": {
    name: "RW AURIGAE",
    ...TARGET_TODO_COORDINATES["RW Aurigae"],
    profile: "T TAURI VARIABLE",
  },
  "R Draconis": {
    name: "R DRACONIS",
    ...TARGET_TODO_COORDINATES["R Draconis"],
    profile: "KNOWN VARIABLE STAR",
  },
};

/**
 * Find target info by name or coordinates.
 *
 * @param {string} [name]
 * @param {number} [ra]
 * @param {number} [dec]
 * @returns {object|null}
 */
export function getTargetInfo(name = '', ra = null, dec = null) {
  if (name && TARGETS[name]) return TARGETS[name];
  const norm = (name || '').toUpperCase().trim();
  const entry = Object.values(TARGETS).find(t => {
    const tNorm = t.name.toUpperCase().trim();
    if (norm && (tNorm === norm || norm.includes(tNorm) || tNorm.includes(norm))) return true;
    if (typeof ra === 'number' && typeof dec === 'number') {
      return Math.abs(t.ra - ra) < 0.05 && Math.abs(t.dec - dec) < 0.05;
    }
    return false;
  });
  return entry || null;
}

/**
 * Returns default pair [indexA, indexB] (0-based) for a target.
 * Uses bestPair if both indexes are within [0, framesLength - 1].
 * If either index is out of range, falls back to first and last frame [0, framesLength - 1].
 *
 * @param {string|object} targetOrName
 * @param {number} [framesLength=9]
 * @returns {[number, number]}
 */
export function getDefaultPairForTarget(targetOrName, framesLength = 9) {
  const target = typeof targetOrName === 'string' ? getTargetInfo(targetOrName) : targetOrName;
  const bestPair = target?.bestPair;
  const lastIdx = Math.max(0, framesLength - 1);
  if (Array.isArray(bestPair) && bestPair.length === 2) {
    const [pA, pB] = bestPair;
    if (pA >= 0 && pA < framesLength && pB >= 0 && pB < framesLength) {
      return [pA, pB];
    }
  }
  return [0, lastIdx];
}

/**
 * Returns caption text for the target.
 *
 * @param {string|object} targetOrName
 * @returns {string}
 */
export function getCaptionForTarget(targetOrName) {
  const target = typeof targetOrName === 'string' ? getTargetInfo(targetOrName) : targetOrName;
  return target?.caption || "Stars stay still. Watch for a dot that shifts.";
}

/**
 * Checks whether a given position and FOV matches one of the 5 pre-cached demo targets.
 *
 * @param {number} ra - Right ascension in degrees
 * @param {number} dec - Declination in degrees
 * @param {number|string} fov - Field of view in degrees
 * @returns {boolean}
 */
export function isCachedDemoTarget(ra, dec, fov) {
  const fovNum = typeof fov === 'number' ? fov : parseFloat(fov);
  const raNum = typeof ra === 'number' ? ra : parseFloat(ra);
  const decNum = typeof dec === 'number' ? dec : parseFloat(dec);
  return Object.values(TARGETS).some(t => {
    return Math.abs(t.ra - raNum) < 0.01 &&
           Math.abs(t.dec - decNum) < 0.01 &&
           Math.abs(t.fov - fovNum) < 0.005;
  });
}
