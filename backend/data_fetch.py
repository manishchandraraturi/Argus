import hashlib
import json
import logging
import os
import re
import time
import warnings
from concurrent.futures import ThreadPoolExecutor

import astropy.units as u
import numpy as np
import pyvo
import requests
from astropy import log as astropy_log
from astropy.io import fits
from astropy.time import Time
from astropy.wcs import WCS

astropy_log.setLevel("WARNING")  # hides the harmless SIP INFO message
logger = logging.getLogger(__name__)

# Module-level timing dictionary recording metrics of the most recent run
last_timings = {}

TAP_URL = "https://irsa.ipac.caltech.edu/TAP"
BASE_URL = "https://irsa.ipac.caltech.edu/"
TIMEOUT = 60
WAVE_WINDOW_UM = 0.2  # keep frames whose true wavelengths fit inside this window

CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache")
FITS_DIR = os.path.join(CACHE_DIR, "fits")


class DataFetchError(Exception):
    pass


def _clean(value):
    """Turn masked or missing table values into None."""
    if value is None or value is np.ma.masked:
        return None
    return value


def _detector_from_uri(uri):
    # File names look like ..._0116_1D3_spx_... where D3 = detector 3
    match = re.search(r"_\dD(\d)_spx", uri)
    return int(match.group(1)) if match else None


def _query_rows(ra, dec):
    if os.environ.get("FORBID_IRSA") == "1":
        raise DataFetchError("IRSA disabled")
    query = f"""
    SELECT a.uri, p.time_bounds_lower, p.quality_flag
    FROM spherex.plane p
    JOIN spherex.artifact a ON p.planeid = a.planeid
    WHERE CONTAINS(POINT('ICRS',{ra},{dec}), p.poly)=1
      AND a.producttype = 'science'
    ORDER BY p.time_bounds_lower
    """
    try:
        service = pyvo.dal.TAPService(TAP_URL)
        table = service.run_sync(query, timeout=TIMEOUT).to_table()
    except Exception as err:
        raise DataFetchError(f"IRSA query failed: {err}")

    rows = []
    for r in table:
        mjd = _clean(r["time_bounds_lower"])
        if mjd is None:
            continue
        flag = _clean(r["quality_flag"])
        rows.append({
            "uri": str(r["uri"]),
            "mjd": float(mjd),
            "detector": _detector_from_uri(str(r["uri"])),
            "flags": str(flag) if flag is not None else None,
        })
    return rows


def _spread(items, n, key):
    """Pick n items spread evenly over the sorted list."""
    items = sorted(items, key=key)
    if len(items) <= n:
        return items
    if n == 1:
        return [items[0]]
    step = (len(items) - 1) / (n - 1)
    return [items[round(i * step)] for i in range(n)]


def _pick_candidates(rows, n):
    """Use the detector with the most images, spread over the dates."""
    if not rows or n < 1:
        return []
    by_detector = {}
    for r in rows:
        by_detector.setdefault(r["detector"], []).append(r)
    best = max(by_detector.values(), key=len)
    return _spread(best, n, key=lambda r: r["mjd"])


def _download_single(job, no_cache=False):
    if os.environ.get("FORBID_IRSA") == "1":
        raise DataFetchError("IRSA disabled")
    url, path = job
    url_tail = url.split("/")[-1]
    start_ts = time.time()
    t0 = time.perf_counter()

    if os.path.exists(path) and not no_cache:
        file_size = os.path.getsize(path)
        end_ts = time.time()
        elapsed = time.perf_counter() - t0
        info = {
            "url_tail": url_tail,
            "start": start_ts,
            "end": end_ts,
            "bytes": file_size,
            "retries": 0,
            "duration": elapsed,
            "success": True,
            "cached": True,
        }
        logger.info(
            "Download %s (cached): start=%.3f, end=%.3f, bytes=%d, retries=0, duration=%.3fs",
            url_tail,
            start_ts,
            end_ts,
            file_size,
            elapsed,
        )
        return True, info

    retries = 0
    downloaded_bytes = 0
    success = False
    err_msg = None
    for attempt in range(4):
        try:
            resp = requests.get(url, timeout=TIMEOUT)
            if resp.status_code in (429, 500, 502, 503, 504):
                retries += 1
                time.sleep(3 * (attempt + 1))  # server busy: wait and retry
                continue
            resp.raise_for_status()
            downloaded_bytes = len(resp.content)
            with open(path + ".part", "wb") as f:
                f.write(resp.content)
            os.replace(path + ".part", path)
            success = True
            break
        except requests.RequestException as e:
            retries += 1
            err_msg = str(e)
            time.sleep(3 * (attempt + 1))

    end_ts = time.time()
    elapsed = time.perf_counter() - t0
    info = {
        "url_tail": url_tail,
        "start": start_ts,
        "end": end_ts,
        "bytes": downloaded_bytes,
        "retries": retries,
        "duration": elapsed,
        "success": success,
        "cached": False,
        "error": err_msg if not success else None,
    }
    logger.info(
        "Download %s: start=%.3f, end=%.3f, bytes=%d, retries=%d, duration=%.3fs",
        url_tail,
        start_ts,
        end_ts,
        downloaded_bytes,
        retries,
        elapsed,
    )
    return success, info


def _download(job):
    good, _ = _download_single(job)
    return good


def _measure_wavelength(path):
    """True wavelength (um) at the centre of the cutout, or None."""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            with fits.open(path) as hdul:
                ny, nx = hdul["IMAGE"].data.shape
                wcs = WCS(hdul["IMAGE"].header, fobj=hdul, key="W")
                out = wcs.pixel_to_world(nx / 2, ny / 2)
                return round(float(out[0].to(u.um).value), 4)
    except Exception:
        return None


def _select_similar_wavelength(items, max_frames):
    """Keep the biggest group of frames inside WAVE_WINDOW_UM, spread over dates."""
    with_wl = sorted(
        (i for i in items if i["wavelength_um"] is not None),
        key=lambda i: i["wavelength_um"],
    )
    if not with_wl:
        return _spread(items, max_frames, key=lambda i: i["date"])
    best = []
    for start in with_wl:
        group = [
            i for i in with_wl
            if start["wavelength_um"] <= i["wavelength_um"] <= start["wavelength_um"] + WAVE_WINDOW_UM
        ]
        if len(group) > len(best):
            best = group
    return _spread(best, max_frames, key=lambda i: i["date"])


def fetch_cutouts(ra_deg, dec_deg, fov_deg, max_frames=12, no_cache=False):
    global last_timings
    t_total_start = time.perf_counter()

    ra, dec, fov = float(ra_deg), float(dec_deg), float(fov_deg)
    if not (0 <= ra <= 360) or not (-90 <= dec <= 90) or fov <= 0:
        raise DataFetchError("Invalid RA, Dec or FOV")

    if os.environ.get("FORBID_IRSA") == "1":
        raise DataFetchError("IRSA disabled")

    # Read LIVE_WORKERS env var at call time (default 1; keep sequential for now)
    try:
        live_workers = int(os.environ.get("LIVE_WORKERS", "1"))
    except (ValueError, TypeError):
        live_workers = 1

    os.makedirs(FITS_DIR, exist_ok=True)
    key = f"v2_{ra:.4f}_{dec:.4f}_{fov:.4f}_{max_frames}"
    cache_file = os.path.join(CACHE_DIR, f"query_{key}.json")

    # Cache hit: reuse saved result if all its files still exist (unless no_cache=True)
    if not no_cache and os.path.exists(cache_file):
        try:
            with open(cache_file) as f:
                cached = json.load(f)
            if all(os.path.exists(item["fits_path"]) for item in cached):
                elapsed = time.perf_counter() - t_total_start
                last_timings = {
                    "search_time": 0.0,
                    "selection_time": 0.0,
                    "downloads": [],
                    "total_download_time": 0.0,
                    "total_time": elapsed,
                    "frames_returned": len(cached),
                    "errors": [],
                }
                return cached
        except Exception:
            pass

    t_search_start = time.perf_counter()
    rows = _query_rows(ra, dec)
    search_time = time.perf_counter() - t_search_start
    logger.info("TAP search time: %.3fs", search_time)

    t_sel_start = time.perf_counter()
    candidates = _pick_candidates(rows, max_frames * 2)
    sel_time_pre = time.perf_counter() - t_sel_start
    if not candidates:
        total_time = time.perf_counter() - t_total_start
        last_timings = {
            "search_time": search_time,
            "selection_time": sel_time_pre,
            "downloads": [],
            "total_download_time": 0.0,
            "total_time": total_time,
            "frames_returned": 0,
            "errors": [],
        }
        return []

    items, jobs = [], []
    for r in candidates:
        url = f"{BASE_URL}{r['uri']}?center={ra},{dec}d&size={fov}"
        name = hashlib.md5(url.encode()).hexdigest()[:16] + ".fits"
        path = os.path.join(FITS_DIR, name)
        jobs.append((url, path))
        items.append({
            "date": Time(r["mjd"], format="mjd").to_datetime().strftime("%Y-%m-%d"),
            "detector": r["detector"],
            "fits_path": path,
            "wavelength_um": None,
            "flags": r["flags"],
        })

    # Sequential downloads (workers stay 1 for now; parallel in next phase)
    ok = []
    download_infos = []
    for job in jobs:
        good, d_info = _download_single(job, no_cache=no_cache)
        ok.append(good)
        download_infos.append(d_info)

    # Keep items and jobs matched if a download fails
    items = [item for item, good in zip(items, ok) if good]
    if not items:
        total_time = time.perf_counter() - t_total_start
        last_timings = {
            "search_time": search_time,
            "selection_time": sel_time_pre,
            "downloads": download_infos,
            "total_download_time": sum(d["duration"] for d in download_infos),
            "total_time": total_time,
            "frames_returned": 0,
            "errors": ["IRSA cutout service is busy, try again later"],
        }
        raise DataFetchError("IRSA cutout service is busy, try again later")

    t_sel2_start = time.perf_counter()
    for item in items:
        item["wavelength_um"] = _measure_wavelength(item["fits_path"])

    results = _select_similar_wavelength(items, max_frames)
    results.sort(key=lambda item: item["date"])
    sel_time_post = time.perf_counter() - t_sel2_start
    selection_time = sel_time_pre + sel_time_post
    logger.info("Frame selection time: %.3fs", selection_time)

    # Delete downloaded files we did not keep, to save disk space
    keep = {item["fits_path"] for item in results}
    for item in items:
        if item["fits_path"] not in keep and os.path.exists(item["fits_path"]):
            os.remove(item["fits_path"])

    if not no_cache:
        with open(cache_file, "w") as f:
            json.dump(results, f, indent=2)

    total_time = time.perf_counter() - t_total_start
    total_dl_time = sum(d["duration"] for d in download_infos)
    logger.info("fetch_cutouts total time: %.3fs", total_time)

    last_timings = {
        "search_time": search_time,
        "selection_time": selection_time,
        "downloads": download_infos,
        "total_download_time": total_dl_time,
        "total_time": total_time,
        "frames_returned": len(results),
        "errors": [d["error"] for d in download_infos if d.get("error")],
    }
    return results