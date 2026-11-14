"""
server.py - ARGUS frames server (FastAPI).

Run from the backend folder:
    uvicorn server:app --reload --port 8000

MOCK mode is ON unless the environment variable MOCK is exactly "0".
    Mock : makes fake frames with numpy + Pillow (no internet, no astropy needed)
    Real : MOCK=0 -> calls data_fetch.fetch_cutouts (Shreesha) and converts each FITS with convert.fits_to_png

Test URL:
    http://localhost:8000/frames?ra=133.795&dec=-7.245&fov=0.1

Contract (API.md):
    GET /health -> {"status": "ok"}
    GET /frames?ra=&dec=&fov= -> {"frames": [{"date", "image_url", "detector", "wavelength_um", "flags"}], "mock": bool}
    Frames are sorted by date. Any failure -> HTTP 502 {"error": "short message"}.

Extras on top of the contract (the frontend has to know about them):
    demo_cache/ : pre-fetched real frames are served first (RA, Dec rounded to 3 decimals, FOV to 2), no IRSA call.
    Slow live fetch (MOCK=0, position not in demo_cache): the fetch runs in the background and /frames answers
        {"frames": [], "mock": false, "status": "fetching", "message": "...", "elapsed_seconds": N}
    until it is done. The frontend shows the message and asks again every few seconds.

The file has two parts: (1) plain functions that make/convert frames, (2) the web app.
"""
import hashlib
import json
import os
import re
import threading
import time
from datetime import date, timedelta
from pathlib import Path
from urllib.parse import quote

import numpy as np

from convert import array_to_png

# ── Settings ──────────────────────────────────────────────────────────────────
BASE_DIR = Path(__file__).resolve().parent
PNG_DIR = BASE_DIR / "cache" / "png"
N_FRAMES = 9
FRAME_SIZE = 600
START_DATE = date(2026, 1, 1)
STEP_DAYS = 30
MAX_FOV_DEG = 10.0
DEMO_DIR = BASE_DIR / os.environ.get("DEMO_DIR", "demo_cache")      # pre-fetched real frames for the demo targets (see CACHE_FORMAT.md)
FETCH_MESSAGE = ("Fetching new frames from IRSA. This can take many minutes right now. "
                 "Keep this page open, it will update when the frames are ready.")

_cache = {}                 # (mode, ra, dec, fov) -> list of frame dicts
_lock = threading.Lock()    # so two requests for the same place do not build the files twice
_jobs = {}                  # live (real mode) fetches running in the background: key -> job dict
_warned = set()             # demo_cache warnings, printed only once each


def is_mock():
    """MOCK is ON when the env variable MOCK is not "0"."""
    return os.environ.get("MOCK", "1") != "0"


def cache_key(ra, dec, fov):
    return (round(ra, 5), round(dec, 5), round(fov, 5))


def file_stem(mode, key):
    digest = hashlib.sha1(f"{mode}|{key}".encode()).hexdigest()[:12]
    return f"{mode}_{digest}"


# ── Part 1a: MOCK frames ──────────────────────────────────────────────────────
def _add_star(img, x, y, flux, sigma):
    """Add one gaussian star to img (small stamp, so it is fast)."""
    h, w = img.shape
    r = int(sigma * 5) + 1
    x0, x1 = max(0, int(x) - r), min(w, int(x) + r + 1)
    y0, y1 = max(0, int(y) - r), min(h, int(y) + r + 1)
    if x0 >= x1 or y0 >= y1:
        return
    yy, xx = np.mgrid[y0:y1, x0:x1]
    img[y0:y1, x0:x1] += flux * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * sigma ** 2))


def make_mock_frames(ra, dec, stem, png_dir=None, n_frames=N_FRAMES, size=FRAME_SIZE):
    """
    9 PNG frames, 600x600. The star field is fixed and seeded from ra/dec.
    One extra dot moves a little each frame. Dates are 30 days apart.
    """
    png_dir = Path(png_dir or PNG_DIR)
    png_dir.mkdir(parents=True, exist_ok=True)
    seed = int(hashlib.sha1(f"{ra:.5f}|{dec:.5f}".encode()).hexdigest()[:8], 16)
    rng = np.random.default_rng(seed)

    # fixed background stars
    stars = [(rng.uniform(10, size - 10), rng.uniform(10, size - 10),
              10 ** rng.uniform(0.2, 1.8), rng.uniform(1.2, 2.6)) for _ in range(140)]
    base = np.zeros((size, size))
    for x, y, flux, sigma in stars:
        _add_star(base, x, y, flux, sigma)

    # the mover: starts near the middle, walks a few pixels per frame
    angle = rng.uniform(0, 2 * np.pi)
    step = 9.0
    dx, dy = np.cos(angle) * step, np.sin(angle) * step
    cx, cy = size / 2 + rng.uniform(-40, 40), size / 2 + rng.uniform(-40, 40)
    start_x, start_y = cx - dx * (n_frames - 1) / 2, cy - dy * (n_frames - 1) / 2

    frames = []
    for i in range(n_frames):
        img = base.copy()
        _add_star(img, start_x + dx * i, start_y + dy * i, 160.0, 3.2)
        img += np.random.default_rng(seed + 1000 + i).normal(0, 0.05, img.shape)   # tiny noise
        filename = f"{stem}_{i}.png"
        array_to_png(img, png_dir / filename, size=size)
        frames.append({"date": (START_DATE + timedelta(days=STEP_DAYS * i)).isoformat(),
                       "filename": filename, "url_path": f"images/{filename}",
                       "detector": 1, "wavelength_um": 1.2, "flags": ""})
    return frames


# ── Part 1b: REAL frames (needs Shreesha's data_fetch) ─────────────────────
def make_real_frames(ra, dec, fov, stem, png_dir=None):
    """
    Contract with Shreesha (API.md):
        data_fetch.fetch_cutouts(ra_deg, dec_deg, fov_deg, max_frames=12)
            -> list of {date, detector, fits_path, wavelength_um, flags}
        convert.fits_to_png(fits_path, png_path, size=600) -> png_path
    Any error is passed up and becomes a 502. Returns [] when there are no cutouts.
    Frames are sorted by date.
    """
    try:
        from data_fetch import fetch_cutouts
    except Exception as e:
        raise RuntimeError(f"cannot import data_fetch: {e}")
    from convert import fits_to_png        # needs astropy, so only imported in real mode

    cutouts = fetch_cutouts(ra, dec, fov)
    if not cutouts:
        return []

    png_dir = Path(png_dir or PNG_DIR)
    png_dir.mkdir(parents=True, exist_ok=True)
    frames = []
    for i, item in enumerate(cutouts):
        fits_path = item.get("fits_path")
        if not fits_path:
            raise RuntimeError(f"cutout {i} has no fits_path")
        filename = f"{stem}_{i}.png"
        fits_to_png(fits_path, png_dir / filename, size=FRAME_SIZE)
        frames.append({"date": item.get("date"), "filename": filename, "url_path": f"images/{filename}",
                       "detector": item.get("detector"),
                       "wavelength_um": item.get("wavelength_um"), "flags": item.get("flags")})
    frames.sort(key=lambda f: (f["date"] is None, f["date"] or ""))    # sorted by date, missing dates last
    return frames


# ── Part 1c: demo_cache (pre-fetched real frames, no IRSA call) ───────────────
def demo_key(ra, dec, fov):
    """RA and Dec rounded to 3 decimals, FOV to 2 (as agreed with Shreesha)."""
    return (round(ra, 3), round(dec, 3), round(abs(fov), 2))


def _warn_once(message):
    if message not in _warned:
        _warned.add(message)
        print("[demo_cache] " + message)


def load_demo_index():
    """
    Look at every demo_cache/<folder>/frames.json and return {(ra, dec, fov): [frame dicts]}.
    The (ra, dec, fov) numbers are read from the folder name (3 numbers), or from the top of frames.json
    if it is an object with "ra", "dec", "fov". Each frame in frames.json has a "filename" (the PNG is in
    the same folder). Called on every request, so new folders that arrive with git pull are found
    without restarting the server.
    """
    index = {}
    if not DEMO_DIR.is_dir() or os.environ.get("DEMO_CACHE", "1") == "0":
        return index
    for folder in sorted(p for p in DEMO_DIR.iterdir() if p.is_dir()):
        frames_file = folder / "frames.json"
        if not frames_file.is_file():
            continue
        try:
            data = json.loads(frames_file.read_text(encoding="utf-8-sig"))
        except Exception as e:
            _warn_once(f"{folder.name}: frames.json could not be read ({e})")
            continue
        raw = data.get("frames") if isinstance(data, dict) else data
        if not isinstance(raw, list):
            _warn_once(f"{folder.name}: frames.json has no list of frames")
            continue

        key = None
        if isinstance(data, dict) and all(k in data for k in ("ra", "dec", "fov")):
            try:
                key = demo_key(float(data["ra"]), float(data["dec"]), float(data["fov"]))
            except (TypeError, ValueError):
                key = None
        if key is None:
            nums = re.findall(r"[-+]?\d+(?:\.\d+)?", folder.name)
            if len(nums) == 3:
                key = demo_key(float(nums[0]), float(nums[1]), float(nums[2]))
        if key is None:
            _warn_once(f"{folder.name}: could not read ra, dec, fov from the folder name")
            continue

        frames = []
        for item in raw:
            name = item.get("filename") if isinstance(item, dict) else None
            if not name or not (folder / name).is_file():
                _warn_once(f"{folder.name}: missing PNG for frame {name!r}, skipped")
                continue
            frames.append({"date": item.get("date"), "filename": name,
                           "url_path": f"demo/{quote(folder.name)}/{quote(name)}",
                           "detector": item.get("detector"), "wavelength_um": item.get("wavelength_um"),
                           "flags": item.get("flags")})
            txy = item.get("target_xy")
            if (isinstance(txy, list) and len(txy) == 2
                    and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in txy)):
                frames[-1]["target_xy"] = txy
        if frames:
            frames.sort(key=lambda f: (f["date"] is None, f["date"] or ""))
            index[key] = frames
    return index


# ── Part 1d: cache, background live fetch, and one entry point ────────────────
def _run_job(key, ra, dec, fov, stem):
    """Runs in a background thread: one live fetch can take many minutes."""
    try:
        frames = make_real_frames(ra, dec, fov, stem)
        with _lock:
            _jobs[key].update(state="done", frames=frames)
    except Exception as e:
        with _lock:
            _jobs[key].update(state="error", error=str(e) or e.__class__.__name__)


def get_frames(ra, dec, fov):
    """
    Returns {"frames": [...], "mock": bool, "pending": bool, "elapsed": seconds}.
    Order of work:
      1. demo_cache (pre-fetched real frames, no IRSA call)
      2. MOCK mode: fake frames
      3. real mode: finished results, else a background fetch (pending=True until it is done)
    """
    demo = load_demo_index().get(demo_key(ra, dec, fov))
    if demo:
        return {"frames": demo, "mock": False, "pending": False, "elapsed": 0}

    mock = is_mock()
    mode = "mock" if mock else "real"
    key = (mode,) + cache_key(ra, dec, fov)

    with _lock:
        cached = _cache.get(key)
        if cached and all((PNG_DIR / f["filename"]).exists() for f in cached):
            return {"frames": cached, "mock": mock, "pending": False, "elapsed": 0}

    if mock:
        with _lock:
            frames = make_mock_frames(ra, dec, file_stem(mode, key))
            _cache[key] = frames
        return {"frames": frames, "mock": True, "pending": False, "elapsed": 0}

    # ---- real mode: background job ----
    with _lock:
        job = _jobs.get(key)
        if job is None:
            job = {"state": "running", "started": time.time()}
            job["thread"] = threading.Thread(target=_run_job, args=(key, ra, dec, fov, file_stem(mode, key)),
                                             daemon=True)
            _jobs[key] = job
            job["thread"].start()
    job["thread"].join(timeout=2.0)          # quick errors (for example a missing module) show up at once

    with _lock:
        state = job["state"]
        if state == "running":
            return {"frames": [], "mock": False, "pending": True, "elapsed": int(time.time() - job["started"])}
        del _jobs[key]                        # finished: the next request starts fresh if needed
        if state == "error":
            raise RuntimeError(job["error"])
        frames = job["frames"]
        if frames:                            # do not cache an empty answer, so a later retry can find data
            _cache[key] = frames
        return {"frames": frames, "mock": False, "pending": False, "elapsed": 0}


def is_cached(ra, dec, fov):
    """True when /frames can answer at once: demo_cache, or a live fetch that already finished."""
    if demo_key(ra, dec, fov) in load_demo_index():
        return True
    with _lock:
        return ("real",) + cache_key(ra, dec, fov) in _cache


def parse_number(name, text):
    if text is None or str(text).strip() == "":
        raise ValueError(f"missing {name}")
    try:
        value = float(text)
    except ValueError:
        raise ValueError(f"{name} must be a number")
    if value != value or value in (float("inf"), float("-inf")):
        raise ValueError(f"{name} must be a number")
    return value


# ══ Part 2: the web app ═══════════════════════════════════════════════════════
from typing import Optional                                    # noqa: E402

from fastapi import FastAPI, Request                            # noqa: E402
from fastapi.middleware.cors import CORSMiddleware              # noqa: E402
from fastapi.responses import JSONResponse                      # noqa: E402
from fastapi.staticfiles import StaticFiles                     # noqa: E402

PNG_DIR.mkdir(parents=True, exist_ok=True)
DEMO_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="ARGUS frames server")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.mount("/images", StaticFiles(directory=str(PNG_DIR)), name="images")
app.mount("/demo", StaticFiles(directory=str(DEMO_DIR)), name="demo")


@app.get("/health")
def health():
    return {"status": "ok"}


def _error(message):
    """Every failure is HTTP 502 with {"error": "short message"} (see API.md)."""
    return JSONResponse(status_code=502, content={"error": str(message)[:200] or "unknown error"})


@app.get("/frames")
def frames(request: Request,
           ra: Optional[str] = None, dec: Optional[str] = None, fov: Optional[str] = None,
           cached_only: Optional[str] = None):
    # 1) check the inputs
    try:
        ra_v = parse_number("ra", ra)
        dec_v = parse_number("dec", dec)
        fov_v = parse_number("fov", fov)
        if not 0 <= ra_v < 360:
            raise ValueError("ra must be 0 to 360")
        if not -90 <= dec_v <= 90:
            raise ValueError("dec must be -90 to 90")
        if not 0 < fov_v <= MAX_FOV_DEG:
            raise ValueError(f"fov must be above 0 and at most {MAX_FOV_DEG}")
    except ValueError as e:
        return _error(e)

    # 1b) cached_only=1: real mode answers 404 when the position is not already cached (no IRSA call)
    if cached_only in ("1", "true") and not is_mock() and not is_cached(ra_v, dec_v, fov_v):
        return JSONResponse(status_code=404, content={"error": "not cached"})

    # 2) build or fetch the frames
    try:
        result = get_frames(ra_v, dec_v, fov_v)
    except Exception as e:
        return _error(str(e) or e.__class__.__name__)

    if result["pending"]:      # slow live fetch still running: the frontend should show the message and ask again
        return {"frames": [], "mock": False, "status": "fetching",
                "message": FETCH_MESSAGE, "elapsed_seconds": result["elapsed"]}
    frame_list, mock = result["frames"], result["mock"]
    if not frame_list:
        return {"frames": [], "mock": mock}

    # 3) build image_url from the base URL of this request (e.g. http://localhost:8000/)
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme
    host = request.headers.get("x-forwarded-host") or request.headers.get("host")
    if host:
        base = f"{proto}://{host}/"
    else:
        base = str(request.base_url)
        if not base.endswith("/"):
            base += "/"
    out = []
    for f in frame_list:
        item = {"date": f["date"], "image_url": base + f["url_path"]}
        for key in ("detector", "wavelength_um", "flags"):     # optional fields: left out when unknown
            if f.get(key) is not None:
                item[key] = f[key]
        txy = f.get("target_xy")                                # only when a list of 2 numbers
        if (isinstance(txy, list) and len(txy) == 2
                and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in txy)):
            item["target_xy"] = txy
        out.append(item)
    return {"frames": out, "mock": mock}
