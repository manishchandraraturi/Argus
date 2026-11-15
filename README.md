# ARGUS // SEE WHAT MOVES

**Interactive SPHEREx sky survey and celestial motion inspection interface.**  
Built for astronomers and citizen scientists inspecting infrared time-series observations.  
Pulls raw FITS survey cutouts, aligns temporal baselines, and highlights candidate moving objects via difference imaging.

---

## Featured Survey Targets

| Target | Object Type | Observation Span | Result & Status |
|---|---|---|---|
| **Barnard's Star** | High Proper Motion Red Dwarf | Aug 2025 – Sep 2026 (13 months) | Direction agrees (5.2 deg), size does not (17.58 px vs 9.33 px); visible by eye, unconfirmed |
| **WISE 0855** | Sub-stellar Brown Dwarf | May 2025 – Dec 2025 (7 months) | Faint infrared source; raw detector artifacts present |
| **Epsilon Indi B** | Binary Brown Dwarf | Apr 2025 – Sep 2026 (17 months) | Detector edge artifact labeled; weak residual candidate near predicted locus |
| **RW Aurigae** | Classical T Tauri Variable | Sep 2025 – Sep 2026 (12 months) | Variable star baseline; brightness fluctuation consistent with catalog |
| **R Draconis** | Mira-type Variable Giant | Jun 2025 – Sep 2026 (15 months) | Variable star baseline; periodic amplitude variation consistent with catalog |

---

## Technical Pipeline & Outcomes

| Capability | Status | Implementation Details |
|---|---|---|
| **Pre-cached Demo Viewer** | What Worked | Instant (< 30ms) access to pre-aligned SPHEREx survey cutouts with zero external dependencies |
| **Live IRSA Queries** | What Worked | Live coordinate querying against NASA/IPAC IRSA archive with parallel cutout retrieval (about 1 to 2 minutes when NASA responds, may be slower or throttled) |
| **Visual Blinking & Difference Imaging** | What Worked | 0.5x to 4x temporal blinking and pixel difference computation with adjustable contrast gain |
| **Detector Artifact Handling** | What Was Hard | Level 2 SPHEREx images retain edge cutoffs and dead pixel columns; addressed via transparent artifact HUD tags and optional lens aperture masking |
| **Sub-pixel Frame Registration** | What Was Hard | Cross-epoch pointing jitter requires sub-pixel WCS reprojection to prevent subtraction residuals on bright field stars |
| **Archive Latency & Timeouts** | What Was Hard | Upstream IRSA server latency spikes and 502 gateway responses mitigated by 20s timeouts and fast fails |
| **Automated Centroid Matching** | What Didn't Work Yet | Direction agrees (5.2 deg) but size does not (measured 17.58 px vs predicted 9.33 px, about 1.9x); unconfirmed by automated rule |

---

## Limitations

1. **Astrometric Verification**: Automated motion detection is an early prototype. 1 of 5 targets shows a visible candidate (unconfirmed; direction agrees at 5.2 deg, size does not); 0 of 5 automated centroid checks pass.
2. **Bandpass Variations**: Difference imaging is optimized for identical or near-identical wavelengths (within 0.2µm). Cross-band pairs introduce chromatic residuals.
3. **Raw Data Artifacts**: SPHEREx Level 2 data contains instrumental detector boundaries, cosmic rays, and stray light.
4. **Live Query Throughput**: Live fetch queries NASA's IRSA server in real time; operations take about 1 to 2 minutes when NASA responds, but may be slower or throttled under heavy load.

---

## Quick Start

### Prerequisites
- Python 3.10+
- Node.js 18+

### One-Command Demo
On Windows, double-click `start_demo.bat` or run:
```cmd
start_demo.bat
```
This boots the FastAPI backend, starts the Vite frontend, and opens `http://localhost:5173` in your browser.

---

## Credits & Disclosures

- Co-developed with **Antigravity** and **Claude AI** for the SPHEREx Challenge.
- Astronomical data courtesy of NASA/IPAC Infrared Science Archive (IRSA) and the SPHEREx mission.
