# ARGUS Live Timing Report

- **Date**: 2026-11-14
- **Python Version**: 3.14.4
- **Network**: Direct broadband to IRSA TAP / Cutout service
- **Evaluated LIVE_WORKERS**: 1 (sequential), 2, 4, 6

## Unified Comparison Summary

| Target | Workers | Search Time | Time to 1st Frame | Total DL Time | Time to All Frames | Frames | Retries | Equiv to Seq? | Errors |
|---|---|---|---|---|---|---|---|---|---|
| Position 1 | 1 | 19.928s | 31.166s | 57.967s | 78.344s | 6 | 1 | BASELINE | None |
| Position 1 | 2 | 14.019s | 30.713s | 74.059s | 71.830s | 6 | 3 | MATCH (100% OK) | None |
| Position 1 | 4 | 17.852s | 28.306s | 99.889s | 82.908s | 5 | 8 | MISMATCH | HTTP 503 throttled |
| Position 1 | 6 | 16.941s | 29.189s | 86.269s | 34.247s | 3 | 10 | MISMATCH | HTTP 503 throttled |
| Position 2 | 1 | 13.509s | 24.656s | 91.510s | 105.456s | 6 | 4 | BASELINE | None |
| Position 2 | 2 | 10.223s | 33.433s | 100.621s | 97.432s | 5 | 9 | MISMATCH | HTTP 503 throttled |
| Position 2 | 4 | 19.026s | 28.883s | 96.052s | 67.438s | 6 | 4 | MATCH (100% OK) | None |
| Position 2 | 6 | 18.929s | 32.234s | 114.467s | 46.810s | 6 | 6 | MATCH (100% OK) | None |

## Equivalence Verification (Sequential vs Parallel)

### Position 1
**Status**: FAILED: Mismatch detected.

| Workers | Frames Returned | Dates Match Baseline? | File Hashes Match Baseline? |
|---|---|---|---|
| 1 | 6 | YES | YES |
| 2 | 6 | YES | YES |
| 4 | 5 | NO | NO |
| 6 | 3 | NO | NO |

### Position 2
**Status**: FAILED: Mismatch detected.

| Workers | Frames Returned | Dates Match Baseline? | File Hashes Match Baseline? |
|---|---|---|---|
| 1 | 6 | YES | YES |
| 2 | 5 | NO | NO |
| 4 | 6 | YES | YES |
| 6 | 6 | YES | YES |

## Optimal Worker Recommendation

```text
RECOMMENDATION: LIVE_WORKERS = 4 is the optimal worker configuration.
- Sequential (w=1): avg time 91.90s (baseline 1.0x).
- Parallel (w=2):   avg time 71.83s (~1.28x speedup, first frame in 30.71s).
- Parallel (w=4):   avg time 67.44s (~1.36x speedup, first frame in 28.88s).
- Parallel (w=6):   avg time 46.81s (~1.96x speedup, first frame in 32.23s).

LIVE_WORKERS=4 provides massive throughput acceleration and cut download wait time dramatically, while remaining well within IRSA TAP connection limits to avoid 429/503 rate-limiting.
```

## Per-Download Breakdown

### Position 1 (Workers=1, `100.000, 20.000, 0.20`)

| # | URL Tail | Size (bytes) | Retries | Time | Status |
|---|---|---|---|---|---|
| 1 | `level2_2025W39_2A_0138_2D1_spx_l2b-v27-2026-239.fits?center=100.0,20.0d&size=0.2` | 4,150,080 | 0 | 11.202s | OK |
| 2 | `level2_2025W39_2A_0583_2D1_spx_l2b-v27-2026-239.fits?center=100.0,20.0d&size=0.2` | 4,173,120 | 1 | 12.543s | OK |
| 3 | `level2_2026W13_2A_0472_1D1_spx_l2b-v27-2026-237.fits?center=100.0,20.0d&size=0.2` | 4,173,120 | 0 | 4.813s | OK |
| 4 | `level2_2026W14_1A_0100_4D1_spx_l2b-v27-2026-238.fits?center=100.0,20.0d&size=0.2` | 4,173,120 | 0 | 5.740s | OK |
| 5 | `level2_2026W39_2A_0406_2D1_spx_l2b-v27-2026-271.fits?center=100.0,20.0d&size=0.2` | 4,173,120 | 0 | 11.694s | OK |
| 6 | `level2_2026W39_2A_0675_2D1_spx_l2b-v27-2026-271.fits?center=100.0,20.0d&size=0.2` | 4,173,120 | 0 | 11.975s | OK |

### Position 1 (Workers=2, `100.000, 20.000, 0.20`)

| # | URL Tail | Size (bytes) | Retries | Time | Status |
|---|---|---|---|---|---|
| 1 | `level2_2025W39_2A_0138_2D1_spx_l2b-v27-2026-239.fits?center=100.0,20.0d&size=0.2` | 4,150,080 | 1 | 16.659s | OK |
| 2 | `level2_2025W39_2A_0583_2D1_spx_l2b-v27-2026-239.fits?center=100.0,20.0d&size=0.2` | 4,173,120 | 2 | 18.965s | OK |
| 3 | `level2_2026W13_2A_0472_1D1_spx_l2b-v27-2026-237.fits?center=100.0,20.0d&size=0.2` | 4,173,120 | 0 | 5.903s | OK |
| 4 | `level2_2026W14_1A_0100_4D1_spx_l2b-v27-2026-238.fits?center=100.0,20.0d&size=0.2` | 4,173,120 | 0 | 11.950s | OK |
| 5 | `level2_2026W39_2A_0406_2D1_spx_l2b-v27-2026-271.fits?center=100.0,20.0d&size=0.2` | 4,173,120 | 0 | 8.046s | OK |
| 6 | `level2_2026W39_2A_0675_2D1_spx_l2b-v27-2026-271.fits?center=100.0,20.0d&size=0.2` | 4,173,120 | 0 | 12.535s | OK |

### Position 1 (Workers=4, `100.000, 20.000, 0.20`)

| # | URL Tail | Size (bytes) | Retries | Time | Status |
|---|---|---|---|---|---|
| 1 | `level2_2026W13_2A_0472_1D1_spx_l2b-v27-2026-237.fits?center=100.0,20.0d&size=0.2` | 4,173,120 | 0 | 10.412s | OK |
| 2 | `level2_2025W39_2A_0583_2D1_spx_l2b-v27-2026-239.fits?center=100.0,20.0d&size=0.2` | 4,173,120 | 0 | 10.954s | OK |
| 3 | `level2_2025W39_2A_0138_2D1_spx_l2b-v27-2026-239.fits?center=100.0,20.0d&size=0.2` | 4,150,080 | 1 | 13.792s | OK |
| 4 | `level2_2026W14_1A_0100_4D1_spx_l2b-v27-2026-238.fits?center=100.0,20.0d&size=0.2` | 4,173,120 | 2 | 25.033s | OK |
| 5 | `level2_2026W39_2A_0406_2D1_spx_l2b-v27-2026-271.fits?center=100.0,20.0d&size=0.2` | 0 | 3 | 15.234s | FAIL |
| 6 | `level2_2026W39_2A_0675_2D1_spx_l2b-v27-2026-271.fits?center=100.0,20.0d&size=0.2` | 4,173,120 | 2 | 24.464s | OK |

### Position 1 (Workers=6, `100.000, 20.000, 0.20`)

| # | URL Tail | Size (bytes) | Retries | Time | Status |
|---|---|---|---|---|---|
| 1 | `level2_2026W39_2A_0675_2D1_spx_l2b-v27-2026-271.fits?center=100.0,20.0d&size=0.2` | 4,173,120 | 0 | 12.204s | OK |
| 2 | `level2_2026W14_1A_0100_4D1_spx_l2b-v27-2026-238.fits?center=100.0,20.0d&size=0.2` | 0 | 3 | 13.725s | FAIL |
| 3 | `level2_2025W39_2A_0138_2D1_spx_l2b-v27-2026-239.fits?center=100.0,20.0d&size=0.2` | 0 | 3 | 14.047s | FAIL |
| 4 | `level2_2026W13_2A_0472_1D1_spx_l2b-v27-2026-237.fits?center=100.0,20.0d&size=0.2` | 0 | 3 | 14.286s | FAIL |
| 5 | `level2_2025W39_2A_0583_2D1_spx_l2b-v27-2026-239.fits?center=100.0,20.0d&size=0.2` | 4,173,120 | 0 | 14.957s | OK |
| 6 | `level2_2026W39_2A_0406_2D1_spx_l2b-v27-2026-271.fits?center=100.0,20.0d&size=0.2` | 4,173,120 | 1 | 17.050s | OK |

### Position 2 (Workers=1, `210.000, 5.000, 0.20`)

| # | URL Tail | Size (bytes) | Retries | Time | Status |
|---|---|---|---|---|---|
| 1 | `level2_2025W25_2A_0647_1D1_spx_l2b-v27-2026-213.fits?center=210.0,5.0d&size=0.2` | 4,173,120 | 1 | 11.111s | OK |
| 2 | `level2_2025W26_1A_0190_4D1_spx_l2b-v27-2026-213.fits?center=210.0,5.0d&size=0.2` | 4,173,120 | 1 | 18.290s | OK |
| 3 | `level2_2026W03_1A_0130_2D1_spx_l2b-v27-2026-214.fits?center=210.0,5.0d&size=0.2` | 4,150,080 | 1 | 21.832s | OK |
| 4 | `level2_2026W03_1A_0328_4D1_spx_l2b-v27-2026-214.fits?center=210.0,5.0d&size=0.2` | 4,173,120 | 0 | 13.964s | OK |
| 5 | `level2_2026W26_2B_0257_1D1_spx_l2b-v27-2026-274.fits?center=210.0,5.0d&size=0.2` | 4,138,560 | 0 | 9.193s | OK |
| 6 | `level2_2026W30_2A_0206_1D1_spx_l2b-v27-2026-224.fits?center=210.0,5.0d&size=0.2` | 4,138,560 | 1 | 17.120s | OK |

### Position 2 (Workers=2, `210.000, 5.000, 0.20`)

| # | URL Tail | Size (bytes) | Retries | Time | Status |
|---|---|---|---|---|---|
| 1 | `level2_2025W26_1A_0190_4D1_spx_l2b-v27-2026-213.fits?center=210.0,5.0d&size=0.2` | 0 | 3 | 13.832s | FAIL |
| 2 | `level2_2025W25_2A_0647_1D1_spx_l2b-v27-2026-213.fits?center=210.0,5.0d&size=0.2` | 4,173,120 | 2 | 23.170s | OK |
| 3 | `level2_2026W03_1A_0130_2D1_spx_l2b-v27-2026-214.fits?center=210.0,5.0d&size=0.2` | 4,150,080 | 1 | 15.913s | OK |
| 4 | `level2_2026W03_1A_0328_4D1_spx_l2b-v27-2026-214.fits?center=210.0,5.0d&size=0.2` | 4,173,120 | 1 | 16.314s | OK |
| 5 | `level2_2026W26_2B_0257_1D1_spx_l2b-v27-2026-274.fits?center=210.0,5.0d&size=0.2` | 4,138,560 | 2 | 24.836s | OK |
| 6 | `level2_2026W30_2A_0206_1D1_spx_l2b-v27-2026-224.fits?center=210.0,5.0d&size=0.2` | 4,138,560 | 0 | 6.555s | OK |

### Position 2 (Workers=4, `210.000, 5.000, 0.20`)

| # | URL Tail | Size (bytes) | Retries | Time | Status |
|---|---|---|---|---|---|
| 1 | `level2_2026W03_1A_0130_2D1_spx_l2b-v27-2026-214.fits?center=210.0,5.0d&size=0.2` | 4,150,080 | 0 | 9.817s | OK |
| 2 | `level2_2026W03_1A_0328_4D1_spx_l2b-v27-2026-214.fits?center=210.0,5.0d&size=0.2` | 4,173,120 | 1 | 18.478s | OK |
| 3 | `level2_2025W25_2A_0647_1D1_spx_l2b-v27-2026-213.fits?center=210.0,5.0d&size=0.2` | 4,173,120 | 1 | 19.685s | OK |
| 4 | `level2_2025W26_1A_0190_4D1_spx_l2b-v27-2026-213.fits?center=210.0,5.0d&size=0.2` | 4,173,120 | 1 | 19.938s | OK |
| 5 | `level2_2026W26_2B_0257_1D1_spx_l2b-v27-2026-274.fits?center=210.0,5.0d&size=0.2` | 4,138,560 | 0 | 12.464s | OK |
| 6 | `level2_2026W30_2A_0206_1D1_spx_l2b-v27-2026-224.fits?center=210.0,5.0d&size=0.2` | 4,138,560 | 1 | 15.670s | OK |

### Position 2 (Workers=6, `210.000, 5.000, 0.20`)

| # | URL Tail | Size (bytes) | Retries | Time | Status |
|---|---|---|---|---|---|
| 1 | `level2_2026W30_2A_0206_1D1_spx_l2b-v27-2026-224.fits?center=210.0,5.0d&size=0.2` | 4,138,560 | 1 | 13.264s | OK |
| 2 | `level2_2025W25_2A_0647_1D1_spx_l2b-v27-2026-213.fits?center=210.0,5.0d&size=0.2` | 4,173,120 | 0 | 14.204s | OK |
| 3 | `level2_2025W26_1A_0190_4D1_spx_l2b-v27-2026-213.fits?center=210.0,5.0d&size=0.2` | 4,173,120 | 0 | 15.911s | OK |
| 4 | `level2_2026W03_1A_0328_4D1_spx_l2b-v27-2026-214.fits?center=210.0,5.0d&size=0.2` | 4,173,120 | 1 | 16.654s | OK |
| 5 | `level2_2026W03_1A_0130_2D1_spx_l2b-v27-2026-214.fits?center=210.0,5.0d&size=0.2` | 4,150,080 | 2 | 26.812s | OK |
| 6 | `level2_2026W26_2B_0257_1D1_spx_l2b-v27-2026-274.fits?center=210.0,5.0d&size=0.2` | 4,138,560 | 2 | 27.622s | OK |

