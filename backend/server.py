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
import logging
import os
import re
import threading
import time
from datetime import date, timedelta
from pathlib import Path
from urllib.parse import quote

import numpy as np

from convert import array_to_png

logger = logging.getLogger("argus.server")

# ── Settings ──────────────────────────────────────────────────────────────────
BASE_DIR = Path(__file__).resolve().parent
PNG_DIR = BASE_DIR / "cache" / "png"
LIVE_PNG_DIR = PNG_DIR / "live"
LIVE_CACHE_DIR = BASE_DIR / "cache" / "live_json"
FITS_DIR = BASE_DIR / "cache" / "fits"
N_FRAMES = 9
FRAME_SIZE = 600
START_DATE = date(2026, 1, 1)
STEP_DAYS = 30
MAX_FOV_DEG = 10.0
DEMO_DIR = BASE_DIR / os.environ.get("DEMO_DIR", "demo_cache_final" if (BASE_DIR / "demo_cache_final").is_dir() else "demo_cache")      # pre-fetched real frames for the demo targets (see CACHE_FORMAT.md)
FETCH_MESSAGE = ("Fetching new frames from IRSA. This can take many minutes right now. "
                 "Keep this page open, it will update when the frames are ready.")

_cache = {}                 # (mode, ra, dec, fov) -> list of frame dicts
_lock = threading.Lock()    # so two requests for the same place do not build the files twice
_jobs = {}                  # live (real mode) fetches running in the background: key -> job dict
_live_memory_cache = {}     # live_key -> {"frames": [...], "finished_at": float}
_warned = set()             # demo_cache warnings, printed only once each

PNG_DIR.mkdir(parents=True, exist_ok=True)
LIVE_PNG_DIR.mkdir(parents=True, exist_ok=True)
LIVE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
FITS_DIR.mkdir(parents=True, exist_ok=True)
DEMO_DIR.mkdir(parents=True, exist_ok=True)


def is_mock():
    """MOCK is ON when the env variable MOCK is not "0"."""
    return os.environ.get("MOCK", "1") != "0"


def is_live_enabled():
    """ENABLE_LIVE defaults to 1. When 0, uncached positions return 404."""
    return os.environ.get("ENABLE_LIVE", "1") != "0"


def get_live_max_jobs():
    try:
        return int(os.environ.get("LIVE_MAX_JOBS", "1"))
    except (ValueError, TypeError):
        return 1


def get_live_job_max_s():
    try:
        return float(os.environ.get("LIVE_JOB_MAX_S", "300"))
    except (ValueError, TypeError):
        return 300.0


def cache_key(ra, dec, fov):
    return (round(ra, 5), round(dec, 5), round(fov, 5))


def live_key(ra, dec, fov):
    """RA with 3 decimals, Dec with 3 decimals, FOV with 2 decimals."""
    return (round(float(ra), 3), round(float(dec), 3), round(abs(float(fov)), 2))


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


# ── Part 1d: cache, background live fetch, and cleanup ────────────────────────
def cleanup_live_cache(max_age_s=3600, max_bytes=200 * 1024 * 1024):
    """
    Delete live PNG and FITS files older than 1 hour (3600s),
    and keep the live cache under 200 MB.
    Also evict memory cache entries older than 30 minutes (1800s).
    """
    now = time.time()
    with _lock:
        expired_keys = [
            k for k, v in _live_memory_cache.items()
            if now - v.get("finished_at", 0) > 1800
        ]
        for k in expired_keys:
            del _live_memory_cache[k]

    live_files = []
    if LIVE_PNG_DIR.exists():
        for p in LIVE_PNG_DIR.iterdir():
            if p.is_file() and not p.name.startswith("."):
                live_files.append(p)
    if FITS_DIR.exists():
        for p in FITS_DIR.iterdir():
            if p.is_file() and not p.name.startswith("."):
                live_files.append(p)

    surviving = []
    for f in live_files:
        try:
            mtime = f.stat().st_mtime
            if now - mtime > max_age_s:
                f.unlink(missing_ok=True)
            else:
                surviving.append((f, f.stat().st_size, mtime))
        except OSError:
            pass

    total_size = sum(sz for _, sz, _ in surviving)
    if total_size > max_bytes:
        surviving.sort(key=lambda x: x[2])  # oldest mtime first
        for f, sz, _ in surviving:
            try:
                f.unlink(missing_ok=True)
                total_size -= sz
                if total_size <= max_bytes:
                    break
            except OSError:
                pass


def _get_finished_live_frames(key, stem):
    """
    Checks memory cache (up to 30 min) and disk cache (up to 1 hour).
    Returns list of frame dicts if valid, or None.
    """
    now = time.time()
    with _lock:
        mem = _live_memory_cache.get(key)
        if mem:
            if now - mem.get("finished_at", 0) <= 1800:
                frames = mem.get("frames", [])
                if frames and all((PNG_DIR / f["filename"]).is_file() for f in frames):
                    return frames
            else:
                del _live_memory_cache[key]

    disk_file = LIVE_CACHE_DIR / f"{stem}.json"
    if disk_file.is_file():
        try:
            mtime = disk_file.stat().st_mtime
            if now - mtime <= 3600:
                frames = json.loads(disk_file.read_text(encoding="utf-8"))
                if frames and all((PNG_DIR / f["filename"]).is_file() for f in frames):
                    with _lock:
                        _live_memory_cache[key] = {"frames": frames, "finished_at": mtime}
                    return frames
        except Exception:
            pass
    return None


def _fake_mock_live(ra, dec, fov, on_frame, progress_cb, max_frames=6):
    """
    Fake live cutout generator when MOCK_LIVE=1.
    Produces 6 sample frames, one per second, so the whole job flow can be tested without IRSA.
    """
    total = max_frames
    if progress_cb:
        progress_cb(0, total)

    FITS_DIR.mkdir(parents=True, exist_ok=True)

    for i in range(total):
        time.sleep(1.0)
        d = date(2026, 1, 1) + timedelta(days=30 * i)
        sample_fits = FITS_DIR / f"mock_sample_{i}.fits"
        if not sample_fits.exists():
            from astropy.io import fits
            data = np.zeros((100, 100), dtype=np.float32)
            data[30 + i * 5 : 50 + i * 5, 30 + i * 5 : 50 + i * 5] = 100.0
            hdu = fits.PrimaryHDU()
            img_hdu = fits.ImageHDU(data=data, name="IMAGE")
            hdul = fits.HDUList([hdu, img_hdu])
            hdul.writeto(sample_fits, overwrite=True)

        item = {
            "date": d.isoformat(),
            "detector": 1 + (i % 3),
            "fits_path": str(sample_fits),
            "wavelength_um": round(1.2 + 0.1 * i, 2),
            "flags": "",
        }
        if on_frame:
            on_frame(item)
        if progress_cb:
            progress_cb(i + 1, total)


def _run_live_job(key, ra, dec, fov, stem):
    """
    Runs in a background thread: live fetch and streaming PNG conversion.
    Fails only if fewer than 3 PNGs exist.
    """
    t_start = time.time()
    try:
        LIVE_PNG_DIR.mkdir(parents=True, exist_ok=True)
        LIVE_CACHE_DIR.mkdir(parents=True, exist_ok=True)

        try:
            workers = int(os.environ.get("LIVE_WORKERS", "4"))
        except (ValueError, TypeError):
            workers = 4
        workers = max(1, min(workers, 6))
        os.environ["LIVE_WORKERS"] = str(workers)

        job_max = int(get_live_job_max_s())
        os.environ.setdefault("LIVE_DEADLINE_S", str(job_max))

        msg_start = f"[live_job] START: key={key} ra={ra} dec={dec} fov={fov} using LIVE_WORKERS={workers} (deadline={job_max}s)"
        print(msg_start)
        logger.info(msg_start)

        converted_frames = []
        conv_lock = threading.Lock()

        def _on_frame(item):
            fits_path = item.get("fits_path")
            if not fits_path or not os.path.exists(fits_path):
                print(f"[live_job] Missing fits_path: {fits_path}")
                return
            idx = len(converted_frames)
            d_str = item.get("date") or f"frame_{idx}"
            png_name = f"{stem}_{idx}_{d_str}.png"
            png_path = LIVE_PNG_DIR / png_name
            try:
                from convert import fits_to_png
                fits_to_png(fits_path, png_path, size=FRAME_SIZE)
                with conv_lock:
                    converted_frames.append({
                        "date": item.get("date"),
                        "filename": f"live/{png_name}",
                        "url_path": f"images/live/{png_name}",
                        "detector": item.get("detector"),
                        "wavelength_um": item.get("wavelength_um"),
                        "flags": item.get("flags"),
                        "aligned": False,
                    })
            except Exception as e:
                print(f"[live_job] Warning: failed to convert {fits_path} to PNG: {e}")

        def _progress_cb(done, total):
            with _lock:
                if key in _jobs:
                    _jobs[key]["progress"] = {"done": done, "total": total}

        if os.environ.get("MOCK_LIVE") == "1":
            _fake_mock_live(ra, dec, fov, on_frame=_on_frame, progress_cb=_progress_cb, max_frames=6)
        else:
            try:
                from data_fetch import fetch_cutouts
            except Exception as e:
                raise RuntimeError(f"cannot import data_fetch: {e}")
            fetch_cutouts(
                ra, dec, fov,
                max_frames=12,
                on_frame=_on_frame,
                progress_cb=_progress_cb,
            )

        if len(converted_frames) < 3:
            raise RuntimeError(f"live fetch incomplete: only {len(converted_frames)} frames converted (minimum 3 required)")

        converted_frames.sort(key=lambda f: (f["date"] is None, f["date"] or ""))

        # Persist to disk
        disk_file = LIVE_CACHE_DIR / f"{stem}.json"
        tmp_disk = LIVE_CACHE_DIR / f"{stem}.json.tmp.{os.getpid()}"
        with open(tmp_disk, "w", encoding="utf-8") as f:
            json.dump(converted_frames, f, indent=2)
        os.replace(tmp_disk, disk_file)

        now = time.time()
        elapsed = round(now - t_start, 2)
        msg_finish = f"[live_job] FINISHED: key={key} converted {len(converted_frames)} frames in {elapsed}s using LIVE_WORKERS={workers}"
        print(msg_finish)
        logger.info(msg_finish)

        with _lock:
            if key in _jobs:
                _jobs[key].update(
                    state="done",
                    frames=converted_frames,
                    finished_at=now,
                )
            _live_memory_cache[key] = {
                "frames": converted_frames,
                "finished_at": now,
            }
        cleanup_live_cache()
    except Exception as e:
        elapsed = round(time.time() - t_start, 2)
        msg_fail = f"[live_job] FAILED: key={key} after {elapsed}s: {e}"
        print(msg_fail)
        logger.error(msg_fail)
        with _lock:
            if key in _jobs:
                _jobs[key].update(
                    state="error",
                    error=str(e) or e.__class__.__name__,
                    finished_at=time.time(),
                )


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


def _format_frames_response(request: Request, frame_list: list, mock: bool = False, live: bool = False):
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
        for key in ("detector", "wavelength_um", "flags"):
            if f.get(key) is not None:
                item[key] = f[key]
        if live:
            item["aligned"] = False
            # Live frames NEVER have target_xy
        else:
            txy = f.get("target_xy")
            if (isinstance(txy, list) and len(txy) == 2
                    and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in txy)):
                item["target_xy"] = txy
        out.append(item)
    resp = {"frames": out, "mock": mock}
    if live:
        resp["live"] = True
    return resp


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

    # 1b) cached demo targets (demo_cache_final)
    d_key = demo_key(ra_v, dec_v, fov_v)
    demo = load_demo_index().get(d_key)
    if demo:
        return _format_frames_response(request, demo, mock=False, live=False)

    l_key = live_key(ra_v, dec_v, fov_v)
    stem = f"live_{l_key[0]:.3f}_{l_key[1]:.3f}_{l_key[2]:.2f}"

    # 1c) cached_only=1: real mode answers 404 when the position is not already cached (no IRSA call)
    if cached_only in ("1", "true") and not is_mock() and not is_cached(ra_v, dec_v, fov_v):
        return JSONResponse(status_code=404, content={"error": "not cached"})

    # 1d) ENABLE_LIVE: when "0", an uncached position returns HTTP 404 {"error": "not cached"} immediately
    if not is_live_enabled():
        return JSONResponse(status_code=404, content={"error": "not cached"})

    # 1e) Check finished live cache
    cached_live = _get_finished_live_frames(l_key, stem)
    if cached_live:
        return _format_frames_response(request, cached_live, mock=False, live=True)

    # 1f) Legacy MOCK mode (when MOCK!=0 and MOCK_LIVE!=1):
    if is_mock() and os.environ.get("MOCK_LIVE") != "1":
        mode = "mock"
        key = (mode,) + cache_key(ra_v, dec_v, fov_v)
        with _lock:
            cached = _cache.get(key)
            if cached and all((PNG_DIR / f["filename"]).exists() for f in cached):
                return _format_frames_response(request, cached, mock=True, live=False)
            mock_frames = make_mock_frames(ra_v, dec_v, file_stem(mode, key))
            _cache[key] = mock_frames
        return _format_frames_response(request, mock_frames, mock=True, live=False)

    # 2) Live background job
    now = time.time()
    job_max_s = get_live_job_max_s()
    max_jobs = get_live_max_jobs()

    with _lock:
        job = _jobs.get(l_key)
        if job is not None:
            state = job["state"]
            if state == "fetching" and (now - job["started_at"] > job_max_s):
                job["state"] = "error"
                job["error"] = f"job exceeded maximum duration of {int(job_max_s)}s"
                state = "error"

            if state == "fetching":
                elapsed = int(now - job["started_at"])
                return JSONResponse(status_code=200, content={
                    "status": "fetching",
                    "message": job.get("message", FETCH_MESSAGE),
                    "elapsed_seconds": elapsed,
                    "progress": job.get("progress", {"done": 0, "total": 6}),
                    "frames": [],
                    "mock": False,
                })
            elif state == "done":
                done_frames = job["frames"]
                del _jobs[l_key]
                return _format_frames_response(request, done_frames, mock=False, live=True)
            elif state == "error":
                err_msg = job.get("error", "unknown error")
                del _jobs[l_key]
                return _error(err_msg)

        # Check concurrency for new job
        active_jobs = [
            j for j in _jobs.values()
            if j["state"] == "fetching" and (now - j["started_at"] <= job_max_s)
        ]

        if len(active_jobs) >= max_jobs:
            oldest = min(active_jobs, key=lambda j: j["started_at"])
            elapsed = now - oldest["started_at"]
            retry_after = max(1, int(job_max_s - elapsed))
            return JSONResponse(
                status_code=429,
                headers={"Retry-After": str(retry_after)},
                content={"error": "busy", "retry_after": retry_after},
            )

        # Start new job
        job = {
            "key": l_key,
            "state": "fetching",
            "started_at": now,
            "progress": {"done": 0, "total": 6},
            "message": FETCH_MESSAGE,
            "frames": [],
            "error": None,
        }
        t = threading.Thread(
            target=_run_live_job,
            args=(l_key, ra_v, dec_v, fov_v, stem),
            daemon=True,
        )
        job["thread"] = t
        _jobs[l_key] = job
        t.start()

        return JSONResponse(status_code=200, content={
            "status": "fetching",
            "message": FETCH_MESSAGE,
            "elapsed_seconds": 0,
            "progress": {"done": 0, "total": 6},
            "frames": [],
            "mock": False,
        })
