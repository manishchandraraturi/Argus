# ARGUS // SPHEREx Challenge Submission

## 1. Executive Summary

ARGUS is a celestial observation and temporal inspection interface for NASA's SPHEREx mission. SPHEREx maps the entire sky in 102 infrared spectral bands every six months, generating vast volumes of time-series observations. 

ARGUS addresses the data accessibility challenge for astronomers and citizen scientists: instead of downloading gigabytes of raw FITS files, users explore a 3D celestial sphere, target coordinate loci, and inspect time-series cutouts via interactive blinking (0.5x–4x) and difference imaging. By pairing frames at closely matched wavelengths (within 0.2µm), ARGUS suppresses false color differentials, highlights candidate moving objects across 6-to-17 month survey baselines, and transparently compares observations against catalog astrometry.

---

## 2. Architecture Diagram

```
 +-----------------------------------------------------------------------------------------+
 |                                  ARGUS CLIENT (Browser)                                |
 |                                                                                         |
 |  +-----------------------+     +------------------------+     +----------------------+  |
 |  |  Three.js Sky Sphere  |     |   HUD Controller       |     |  Time-Series Viewer  |  |
 |  |  - Celestial mapping  | <-> |   - Target selection   | <-> |  - 0.5x-4x Blinking  |  |
 |  |  - Real Earth globe   |     |   - Location bar state |     |  - Difference engine |  |
 |  |  - Coordinate probe   |     |   - Guided 30s demo    |     |  - Motion check HUD  |  |
 |  +-----------------------+     +------------------------+     +----------------------+  |
 +-------------------------------------------|---------------------------------------------+
                                             | HTTP / REST (api.js)
                                             v
 +-----------------------------------------------------------------------------------------+
 |                                 ARGUS BACKEND (FastAPI)                                 |
 |                                                                                         |
 |  +-------------------------+   +--------------------------+   +----------------------+  |
 |  |   Pre-cached Survey     |   |   Live Fetch Worker      |   |  FITS Preprocessing  |  |
 |  |   - 5 featured targets  |   |   - Async job scheduler  |   |  - WCS alignment     |  |
 |  |   - < 30ms latency      |   |   - Parallel downloads   |   |  - Bandpass matching |  |
 |  |   - Zero-cloud fallback |   |   - Progress streaming   |   |  - PNG quantization  |  |
 |  +-------------------------+   +--------------------------+   +----------------------+  |
 +-------------------------------------------|---------------------------------------------+
                                             | HTTPS API
                                             v
                            [ NASA/IPAC IRSA Archive API ]
```

---

## 3. What Makes ARGUS Different

1. **Spectral-Temporal Difference Imaging**: Unlike simple image viewers that compare arbitrary frames, ARGUS groups SPHEREx observations by wavelength (within 0.2µm). This eliminates false chromatic residuals caused by bandpass discrepancies and highlights candidate moving objects.
2. **Transparent Ground-Truth Astrometry**: ARGUS never over-claims. For Barnard's Star, the interface compares predicted catalog motion (9.33 px) against difference-image centroids (17.58 px): direction agrees (5.2 deg) but size does not (about 1.9x). The candidate moving object is visible by eye, but unconfirmed by automated centroid rules.
3. **Dual Execution Engine**: Provides instant (< 30ms) exploration of 5 pre-cached benchmark targets, combined with a background fetch engine querying live NASA/IPAC IRSA archives for custom coordinates (about 1 to 2 minutes when NASA responds, may be slower or throttled).
4. **Detector Artifact Awareness**: Raw Level 2 survey data includes edge boundaries and detector artifacts. ARGUS displays explicit on-screen warning labels (e.g. for Epsilon Indi B) and provides an optional telescope lens aperture mask.

---

## 4. Technical Verification & Scientific Rigor

- **Barnard's Star Motion Check**: Direction agrees (5.2 deg), size does not (measured 17.58 px vs predicted 9.33 px, about 1.9x). The candidate moving object is visible by eye, but unconfirmed by automated centroid rules.
- **Offline & Benchmark Availability**: All 5 benchmark targets load from local cache in under 30ms with `FORBID_IRSA=1`.
- **Live Query Timing**: Live fetch jobs against NASA's archive take about 1 to 2 minutes when NASA responds, but may be slower or throttled under heavy upstream load.
- **Artifact Transparency**: Detector boundaries and cosmic rays in Level 2 images are explicitly disclosed rather than hidden or artificially altered.
