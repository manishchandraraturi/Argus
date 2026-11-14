import { generateSimFrames } from './simFrames.js';

export const API_BASE = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_BASE) || '';
export const ALLOW_LIVE_FETCH = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_ALLOW_LIVE_FETCH === 'true') || false;

export function getApiBase() {
  if (typeof window !== 'undefined' && typeof window.__ARGUS_API_BASE === 'string') {
    return window.__ARGUS_API_BASE;
  }
  return API_BASE;
}

// ─── Warm-up ping for free-tier hosting (Render) ───────────────────────────
if (typeof window !== 'undefined') {
  const warmup = () => {
    const base = getApiBase();
    if (base) {
      try {
        fetch(`${base}/health`).catch(() => {});
      } catch (_) {}
    }
  };
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', warmup, { once: true });
  } else {
    warmup();
  }
}

export function getAllowLiveFetch() {
  if (typeof window !== 'undefined' && typeof window.__ARGUS_ALLOW_LIVE_FETCH === 'boolean') {
    return window.__ARGUS_ALLOW_LIVE_FETCH;
  }
  return ALLOW_LIVE_FETCH;
}

// ─── Pre-cached Survey Targets ─────────────────────────────────────────────
export const CACHED_TARGETS = [
  { name: "WISE 0855", ra: 133.795, dec: -7.245, fov: 0.20 },
  { name: "Barnard's Star", ra: 269.452, dec: 4.693, fov: 0.20 },
  { name: "Epsilon Indi B", ra: 331.044, dec: -56.783, fov: 0.15 },
  { name: "RW Aurigae", ra: 76.956, dec: 30.401, fov: 0.20 },
  { name: "R Draconis", ra: 248.168, dec: 66.755, fov: 0.20 },
];

/**
 * Checks if coordinates and FOV are within 0.005 degrees of a pre-cached target.
 * If matched, returns that target object so cached data can be used with zero live fetch.
 *
 * @param {number|string} ra
 * @param {number|string} dec
 * @param {number|string} fov
 * @returns {object|null}
 */
export function findMatchingCachedTarget(ra, dec, fov) {
  const raNum = typeof ra === 'number' ? ra : parseFloat(ra);
  const decNum = typeof dec === 'number' ? dec : parseFloat(dec);
  const fovNum = typeof fov === 'number' ? fov : parseFloat(fov);
  if (isNaN(raNum) || isNaN(decNum) || isNaN(fovNum)) return null;

  return CACHED_TARGETS.find(t => {
    const dRa = Math.abs(t.ra - raNum);
    const dDec = Math.abs(t.dec - decNum);
    const dFov = Math.abs(t.fov - fovNum);
    return dRa <= 0.005 && dDec <= 0.005 && dFov < 0.001;
  }) || null;
}

// ─── Selected Target Global State ──────────────────────────────────────────
export let selectedTarget = null;

export function setSelectedTarget(target) {
  selectedTarget = target;
  if (typeof window !== 'undefined') {
    window.selectedTarget = target;
    window.__selectedTarget = target;
    window.currentTarget = target;
  }
}

export function getSelectedTarget() {
  if (typeof window !== 'undefined' && (window.selectedTarget || window.__selectedTarget || window.currentTarget)) {
    return window.selectedTarget || window.__selectedTarget || window.currentTarget;
  }
  return selectedTarget;
}

/**
 * Helper to delay with AbortSignal support.
 *
 * @param {number} ms
 * @param {AbortSignal|null} [signal]
 * @returns {Promise<void>}
 */
function delayWithSignal(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const abortErr = new Error(signal.reason || 'Aborted');
      abortErr.name = 'AbortError';
      return reject(abortErr);
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      const abortErr = new Error(signal?.reason || 'Aborted');
      abortErr.name = 'AbortError';
      reject(abortErr);
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Builds the exact request URL for fetching frames.
 * Formats RA and DEC with 3 decimals, and FOV with 2 decimals.
 * Appends &cached_only=1 when cachedOnly is true.
 *
 * @param {number|string} ra
 * @param {number|string} dec
 * @param {number|string} fov
 * @param {string|null} [baseUrl=null]
 * @param {boolean|object} [options={}]
 * @returns {string}
 */
export function getRequestUrl(ra, dec, fov = 0.20, baseUrl = null, options = {}) {
  const raNum = typeof ra === 'number' ? ra : parseFloat(ra);
  const decNum = typeof dec === 'number' ? dec : parseFloat(dec);
  const fovNum = typeof fov === 'number' ? fov : parseFloat(fov);
  const base = baseUrl !== null ? baseUrl : getApiBase();
  const cachedOnly = typeof options === 'boolean' ? options : Boolean(options?.cachedOnly);
  const query = `ra=${raNum.toFixed(3)}&dec=${decNum.toFixed(3)}&fov=${fovNum.toFixed(2)}${cachedOnly ? '&cached_only=1' : ''}`;
  return `${base}/frames?${query}`;
}

/**
 * Fetch or generate sky image frames for the given coordinates and FOV.
 *
 * @param {number} ra  - Right Ascension in degrees (0–360)
 * @param {number} dec - Declination in degrees (−90 to +90)
 * @param {number|string} [fov=0.20] - Field of view in degrees (formatted with 2 decimals)
 * @param {object|string} [optionsOrName={}] - Options object ({cachedOnly, name, onProgress, signal}) or target name string
 * @param {function} [onProgress] - Optional progress callback (loadedCount, total)
 * @param {AbortSignal} [signal] - Optional abort signal for cancellation
 * @returns {Promise<{frames: Array<{date: string, image_url: string, detector: string, wavelength_um?: string|number, flags?: number}>, source: 'simulated'|'api', mock: boolean}>}
 */
export async function getFrames(ra, dec, fov = 0.20, optionsOrName = {}, onProgress = null, signal = null) {
  let cachedOnly = false;
  let name = '';
  let prog = onProgress;
  let sig = signal;
  let onStatus = null;

  if (typeof optionsOrName === 'object' && optionsOrName !== null) {
    cachedOnly = Boolean(optionsOrName.cachedOnly);
    name = optionsOrName.name || '';
    if (optionsOrName.onProgress) prog = optionsOrName.onProgress;
    if (optionsOrName.signal) sig = optionsOrName.signal;
    if (optionsOrName.onStatus) onStatus = optionsOrName.onStatus;
  } else if (typeof optionsOrName === 'string') {
    name = optionsOrName;
  }

  const selected = getSelectedTarget();
  let effectiveRa = (typeof ra === 'number') ? ra : (ra !== undefined && ra !== null && !isNaN(parseFloat(ra)) ? parseFloat(ra) : (selected?.ra ?? 269.452));
  let effectiveDec = (typeof dec === 'number') ? dec : (dec !== undefined && dec !== null && !isNaN(parseFloat(dec)) ? parseFloat(dec) : (selected?.dec ?? 4.693));
  let effectiveFov = (typeof fov === 'number') ? fov : (fov !== undefined && fov !== null && !isNaN(parseFloat(fov)) ? parseFloat(fov) : (selected?.fov ?? 0.20));
  let effectiveName = name || selected?.name || '';

  // If coordinates are within 0.005 degrees of a cached target AND FOV matches, snap to cached target
  const cachedMatch = findMatchingCachedTarget(effectiveRa, effectiveDec, effectiveFov);
  if (cachedMatch) {
    effectiveRa = cachedMatch.ra;
    effectiveDec = cachedMatch.dec;
    effectiveFov = cachedMatch.fov;
    if (!effectiveName || effectiveName === 'CUSTOM SPOT' || effectiveName === 'TYPED COORDS') {
      effectiveName = cachedMatch.name;
    }
  }

  const formattedRa = effectiveRa.toFixed(3);
  const formattedDec = effectiveDec.toFixed(3);
  const formattedFov = effectiveFov.toFixed(2);

  const apiBase = getApiBase();
  if (apiBase) {
    const cachedQuery = cachedOnly ? '&cached_only=1' : '';
    const url = `${apiBase}/frames?ra=${formattedRa}&dec=${formattedDec}&fov=${formattedFov}${cachedQuery}`;

    try {
      let data;
      while (true) {
        if (sig?.aborted) {
          const abortErr = new Error(sig.reason || 'Aborted');
          abortErr.name = 'AbortError';
          throw abortErr;
        }

        // Wake-up timer (4s) and timeout (90s)
        let wakeupTimer = null;
        let timeoutTimer = null;
        let answered = false;
        let timedOut = false;

        const fetchController = new AbortController();
        const onCallerAbort = () => {
          fetchController.abort(sig?.reason || 'Aborted');
        };
        if (sig) {
          sig.addEventListener('abort', onCallerAbort, { once: true });
        }

        wakeupTimer = setTimeout(() => {
          if (!answered) {
            const wakeupMsg = 'SERVER IS WAKING UP (FREE HOSTING). THIS CAN TAKE UP TO A MINUTE';
            if (typeof onStatus === 'function') {
              onStatus({ status: 'fetching', message: wakeupMsg });
            }
            if (typeof prog === 'function') {
              prog({ status: 'fetching', message: wakeupMsg });
            }
          }
        }, 4000);

        timeoutTimer = setTimeout(() => {
          if (!answered) {
            timedOut = true;
            const toErr = new Error('Server request timed out after 90 seconds');
            toErr.name = 'TimeoutError';
            fetchController.abort(toErr);
          }
        }, 90000);

        let res;
        try {
          res = await fetch(url, { signal: fetchController.signal });
        } catch (fetchErr) {
          if (timedOut) {
            const err = new Error('Server request timed out after 90 seconds');
            err.isUnreachable = true;
            throw err;
          }
          throw fetchErr;
        } finally {
          answered = true;
          if (wakeupTimer) clearTimeout(wakeupTimer);
          if (timeoutTimer) clearTimeout(timeoutTimer);
          if (sig) sig.removeEventListener('abort', onCallerAbort);
        }
        if (res.status === 404) {
          const notCachedErr = new Error('not cached');
          notCachedErr.status = 404;
          notCachedErr.isNotCached = true;
          throw notCachedErr;
        }
        if (res.status === 429) {
          let retryAfter = 30;
          try {
            const errData = await res.json();
            if (errData && typeof errData.retry_after === 'number') {
              retryAfter = Math.max(1, Math.round(errData.retry_after));
            }
          } catch {
            const retryHeader = res.headers ? res.headers.get('Retry-After') : null;
            if (retryHeader) {
              const parsed = parseInt(retryHeader, 10);
              if (!isNaN(parsed)) retryAfter = Math.max(1, parsed);
            }
          }
          const busyErr = new Error(`SERVER BUSY, TRY AGAIN IN ${retryAfter} s`);
          busyErr.status = 429;
          busyErr.isBusy = true;
          busyErr.retryAfter = retryAfter;
          throw busyErr;
        }
        if (!res.ok) {
          let errMsg = `API HTTP ${res.status}: ${res.statusText}`;
          try {
            const errJson = await res.json();
            if (errJson && errJson.error) {
              errMsg = errJson.error;
            } else if (errJson && errJson.detail) {
              errMsg = errJson.detail;
            }
          } catch {}
          const httpErr = new Error(errMsg);
          httpErr.status = res.status;
          throw httpErr;
        }
        data = await res.json();
        if (!data || data.status !== 'fetching' || (data.frames && data.frames.length > 0)) break;
        if (typeof onStatus === 'function') {
          onStatus(data);
        }
        if (typeof prog === 'function') {
          prog({
            status: 'fetching',
            message: data.message,
            elapsed_seconds: data.elapsed_seconds,
            ...data,
          }, data.elapsed_seconds);
        }
        await delayWithSignal(2000, sig);
      }
      // Handle both { frames: [...] } and array responses
      const frameList = Array.isArray(data) ? data : (data.frames || []);
      const formattedFrames = frameList.map((f, idx) => {
        if (typeof f === 'string') {
          return {
            date: new Date(Date.UTC(2025, idx, 15)).toISOString().split('T')[0],
            image_url: f,
            detector: `DETECTOR ${((idx % 3) + 1)}`,
            wavelength_um: 2.4,
          };
        }
        return {
          date: f.date || new Date(Date.UTC(2025, idx, 15)).toISOString().split('T')[0],
          image_url: f.image_url || f.url || f.image || '',
          detector: f.detector || `DETECTOR ${((idx % 3) + 1)}`,
          wavelength_um: f.wavelength_um || 2.4,
          flags: f.flags || 0,
          target_xy: Array.isArray(f.target_xy) && f.target_xy.length === 2 ? f.target_xy : undefined,
        };
      });

      return {
        frames: formattedFrames,
        source: 'api',
        mock: Boolean(data && data.mock === true),
        live: Boolean(data && data.live === true),
        aligned: Boolean(data && data.aligned === true),
      };
    } catch (err) {
      if (err.name === 'AbortError') {
        throw err;
      }
      // If 404 "not cached", rethrow so caller shows the HUD dialog
      if (err.isNotCached || err.status === 404) {
        throw err;
      }
      // If 429 busy, rethrow so caller shows busy error with RETRY button
      if (err.isBusy || err.status === 429) {
        throw err;
      }
      // Re-throw so caller (HUD or Viewer) can immediately transition to simulated preview or error state
      err.isUnreachable = true;
      throw err;
    }
  }

  // 3. Fall back to browser-rendered seeded simulation frames (no API is set)
  const sim = await generateSimFrames(effectiveRa, effectiveDec, effectiveFov, effectiveName, prog, sig);
  return {
    ...sim,
    mock: true,
  };
}
