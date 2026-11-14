# ARGUS Regression Test Suite & Verification Checklist

This document details the regression testing procedure for ARGUS backend and frontend, ensuring pre-cached real data serves properly without contacting IRSA and that frontend builds and UI flows perform as expected.

---

## 1. Automated Backend Cache Regression Check

### (a) Start the Backend Server

Start the backend with `FORBID_IRSA=1`, `MOCK=0`, and `DEMO_DIR=demo_cache_final`:

#### Windows PowerShell:
```powershell
$env:FORBID_IRSA="1"; $env:MOCK="0"; $env:DEMO_DIR="demo_cache_final"; python -m uvicorn server:app --app-dir backend --port 8000
```

#### Windows Command Prompt (cmd):
```cmd
set FORBID_IRSA=1 && set MOCK=0 && set DEMO_DIR=demo_cache_final && python -m uvicorn server:app --app-dir backend --port 8000
```

#### Linux / macOS (bash / zsh):
```bash
FORBID_IRSA=1 MOCK=0 DEMO_DIR=demo_cache_final python -m uvicorn server:app --app-dir backend --port 8000
```

### (b) Run the Cache Verification Tool

In another terminal, run:

```bash
python backend/tools/check_cached.py
```
*(Optionally specify custom base URL: `python backend/tools/check_cached.py http://localhost:8000`)*

The script checks all 5 demo targets:
1. **WISE 0855**: RA `133.795`, Dec `-7.245`, FOV `0.20`
2. **Barnard's Star**: RA `269.452`, Dec `4.693`, FOV `0.20`
3. **Epsilon Indi B**: RA `331.044`, Dec `-56.783`, FOV `0.15`
4. **RW Aurigae**: RA `76.956`, Dec `30.401`, FOV `0.20`
5. **R Draconis**: RA `248.168`, Dec `66.755`, FOV `0.20`

And verifies:
- HTTP status 200
- `"mock": false`
- Frame count equals the count in `backend/demo_cache_final/<folder>/frames.json`
- Every `image_url` returns HTTP 200 with an `image/*` content type
- `target_xy` appears exactly on the frames where `frames.json` has it
- Response time takes under 1.0 second
- Uncached position (`ra=100`, `dec=20`, `fov=0.20`, `cached_only=1`) returns HTTP 404 in under 1.0 second
- Exits with exit code `0` on success, `1` on any failure

---

## 2. Frontend Production Build

Run from repository root:

```bash
cd frontend
npm run build
```

**Requirement**: `npm run build` must pass cleanly with zero errors.

---

## 3. 2-Minute Manual Checklist

For each of the 5 targets (**Barnard's Star**, **WISE 0855**, **EPSILON INDI B**, **RW AURIGAE**, **R DRACONIS**):

1. Click **START PROBING** on the landing screen.
2. Select **PICK A TARGET** and click the target card.
3. Click **CONFIRM LOCATION** in the confirmation bar.
4. Click **LOAD SKY IMAGES**.
5. Verify:
   - [ ] The green **SPHEREX DATA** badge appears in the viewer in under 3 seconds.
   - [ ] The frame count matches the target's frame count:
     - **Barnard's Star**: 10 frames
     - **WISE 0855**: 11 frames
     - **Epsilon Indi B**: 10 frames
     - **RW Aurigae**: 12 frames
     - **R Draconis**: 12 frames
   - [ ] The green ring labeled `EXPECTED POSITION (catalog proper motion)` shows on every target whose frames.json has target_xy (currently all 5).
   - [ ] Click **BLINK** mode: verify Blink alternates between frame A and frame B smoothly at the selected speed.
