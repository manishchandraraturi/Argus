# ARGUS // Pitch Deck Outline

### Slide 1: Title & Purpose
- **ARGUS**: Real-time visual analysis interface for SPHEREx infrared all-sky surveys.
- Enables astronomers to inspect candidate moving objects without downloading gigabytes of FITS files.

### Slide 2: The Challenge
- SPHEREx maps the sky in 102 infrared bands every 6 months, creating massive multi-epoch data.
- Raw images contain instrument artifacts, pointing jitter, and chromatic variations across bands.

### Slide 3: The ARGUS Pipeline
- Pairs observations within 0.2µm to avoid false brightness residuals across epochs.
- Aligns temporal baselines and computes difference images to highlight candidate moving objects.

### Slide 4: Interactive Inspection UI
- Offers 0.5x–4x blinking, difference mode, and catalog expected position rings.
- Built-in 30-second guided demo provides one-click walkthrough for reviewers.

### Slide 5: Barnard's Star: motion check
- Direction agrees (5.2 deg), size does not (measured 17.58 px vs predicted 9.33 px, about 1.9x).
- Candidate visible by eye; status transparently reported as unconfirmed.

### Slide 6: Dual Architecture & Reliability
- Pre-cached survey cache guarantees sub-30ms loads for 5 benchmark targets.
- Live background query engine connects to NASA/IPAC IRSA (about 1 to 2 minutes when NASA responds, may be slower or throttled).

### Slide 7: Next Steps & Team
- Future work: sub-pixel WCS reprojection, PSF matching, and automated catalog cross-checks.
- Co-developed with Antigravity (Gemini) and Claude for the SPHEREx Challenge.
