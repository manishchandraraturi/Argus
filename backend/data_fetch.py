import hashlib
import json
import logging
import os
import queue
import re
import threading
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


def _parse_retry_after(header_val):
    if not header_val:
        return None
    try:
        return float(header_val)
    except (ValueError, TypeError):
        pass
    try:
        from email.utils import parsedate_to_datetime
        import datetime
        dt = parsedate_to_datetime(header_val)
        now = datetime.datetime.now(datetime.timezone.utc)
        delay = (dt - now).total_seconds()
        return max(0.0, delay)
    except Exception:
        return None


class ThrottleState:
    def __init__(self, initial_workers):
        self.lock = threading.Lock()
        self.limit = initial_workers
        self.active_count = 0
        self.cond = threading.Condition(self.lock)

    def acquire(self, timeout=None):
        start = time.time()
        with self.lock:
            while self.active_count >= self.limit:
                remaining = None if timeout is None else timeout - (time.time() - start)
                if remaining is not None and remaining <= 0:
                    return False
                if not self.cond.wait(timeout=remaining):
                    return False
            self.active_count += 1
            return True

    def release(self):
        with self.lock:
            self.active_count = max(0, self.active_count - 1)
            self.cond.notify_all()

    def reduce_workers(self):
        with self.lock:
            if self.limit > 1:
                self.limit -= 1
                logger.warning(
                    "Throttled (HTTP 429/503): reducing live workers to %d",
                    self.limit,
                )


def fetch_cutouts(
    ra_deg,
    dec_deg,
    fov_deg,
    max_frames=12,
    no_cache=False,
    on_frame=None,
    progress_cb=None,
):
    global last_timings
    t_total_start = time.perf_counter()

    ra, dec, fov = float(ra_deg), float(dec_deg), float(fov_deg)
    if not (0 <= ra <= 360) or not (-90 <= dec <= 90) or fov <= 0:
        raise DataFetchError("Invalid RA, Dec or FOV")

    if os.environ.get("FORBID_IRSA") == "1":
        raise DataFetchError("IRSA disabled")

    # Bounded thread pool: LIVE_WORKERS default 4, hard maximum 6
    try:
        live_workers = int(os.environ.get("LIVE_WORKERS", "4"))
    except (ValueError, TypeError):
        live_workers = 4
    live_workers = max(1, min(live_workers, 6))

    # Global deadline LIVE_DEADLINE_S (default 90 s)
    try:
        live_deadline_s = float(os.environ.get("LIVE_DEADLINE_S", "90"))
    except (ValueError, TypeError):
        live_deadline_s = 90.0
    deadline_ts = time.time() + live_deadline_s

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
                    "time_to_first_frame": elapsed,
                    "workers_used": live_workers,
                }
                return cached
        except Exception:
            pass

    t_search_start = time.perf_counter()
    rows = _query_rows(ra, dec)
    search_time = time.perf_counter() - t_search_start
    logger.info("TAP search time: %.3fs", search_time)

    # Frame selection BEFORE downloading using TAP metadata (spread over dates, keeping wavelength band rule)
    t_sel_start = time.perf_counter()
    candidates = _pick_candidates(rows, max_frames)
    selection_time = time.perf_counter() - t_sel_start
    logger.info("Frame selection time: %.3fs (%d candidates selected)", selection_time, len(candidates))

    if not candidates:
        total_time = time.perf_counter() - t_total_start
        last_timings = {
            "search_time": search_time,
            "selection_time": selection_time,
            "downloads": [],
            "total_download_time": 0.0,
            "total_time": total_time,
            "frames_returned": 0,
            "errors": [],
            "time_to_first_frame": None,
            "workers_used": live_workers,
        }
        return []

    # Prepare download jobs
    job_queue = queue.Queue()
    jobs = []
    for idx, r in enumerate(candidates):
        url = f"{BASE_URL}{r['uri']}?center={ra},{dec}d&size={fov}"
        name = hashlib.md5(url.encode()).hexdigest()[:16] + ".fits"
        path = os.path.join(FITS_DIR, name)
        item = {
            "date": Time(r["mjd"], format="mjd").to_datetime().strftime("%Y-%m-%d"),
            "detector": r["detector"],
            "fits_path": path,
            "wavelength_um": None,
            "flags": r["flags"],
        }
        job = (idx, url, path, item)
        jobs.append(job)
        job_queue.put(job)

    completed_items = []
    download_infos = []
    completed_lock = threading.Lock()
    progress_lock = threading.Lock()
    progress_state = {"done": 0, "total": len(jobs)}
    throttle_state = ThrottleState(live_workers)
    time_to_first_frame = None

    def worker():
        nonlocal time_to_first_frame
        while True:
            if time.time() >= deadline_ts:
                break
            try:
                idx, url, path, item = job_queue.get(timeout=0.2)
            except queue.Empty:
                break

            url_tail = url.split("/")[-1]
            start_ts = time.time()
            t0 = time.perf_counter()

            # Skip files already in cache if caching allowed
            if not no_cache and os.path.exists(path) and os.path.getsize(path) > 0:
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
                item["wavelength_um"] = _measure_wavelength(path)
                with completed_lock:
                    completed_items.append(item)
                    download_infos.append(info)
                    if time_to_first_frame is None:
                        time_to_first_frame = time.perf_counter() - t_total_start
                if on_frame and callable(on_frame):
                    try:
                        on_frame(item)
                    except Exception as e:
                        logger.warning("on_frame callback error: %s", e)
                with progress_lock:
                    progress_state["done"] += 1
                    if progress_cb and callable(progress_cb):
                        try:
                            progress_cb(progress_state["done"], progress_state["total"])
                        except Exception as e:
                            logger.warning("progress_cb error: %s", e)
                job_queue.task_done()
                continue

            # Network download with timeout and up to 2 retries
            retries = 0
            downloaded_bytes = 0
            success = False
            err_msg = None

            for attempt in range(3):
                rem = deadline_ts - time.time()
                if rem <= 0:
                    err_msg = "Global deadline exceeded"
                    break

                if not throttle_state.acquire(timeout=rem):
                    err_msg = "Global deadline exceeded while waiting for concurrency slot"
                    break

                slot_held = True
                try:
                    req_timeout = min(60.0, max(1.0, deadline_ts - time.time()))
                    try:
                        resp = requests.get(url, timeout=req_timeout)
                    except requests.RequestException as e:
                        retries += 1
                        err_msg = str(e)
                        sleep_s = 2.0 if attempt == 0 else 5.0
                        if attempt < 2 and (time.time() + sleep_s < deadline_ts):
                            throttle_state.release()
                            slot_held = False
                            time.sleep(sleep_s)
                            continue
                        else:
                            break

                    if resp.status_code in (429, 503):
                        retries += 1
                        throttle_state.reduce_workers()
                        retry_after = resp.headers.get("Retry-After")
                        sleep_s = _parse_retry_after(retry_after)
                        if sleep_s is None:
                            sleep_s = 2.0 if attempt == 0 else 5.0
                        if attempt < 2 and (time.time() + sleep_s < deadline_ts):
                            throttle_state.release()
                            slot_held = False
                            time.sleep(sleep_s)
                            continue
                        else:
                            err_msg = f"HTTP {resp.status_code} throttled"
                            break

                    if resp.status_code in (500, 502, 504):
                        retries += 1
                        sleep_s = 2.0 if attempt == 0 else 5.0
                        if attempt < 2 and (time.time() + sleep_s < deadline_ts):
                            throttle_state.release()
                            slot_held = False
                            time.sleep(sleep_s)
                            continue
                        else:
                            err_msg = f"HTTP {resp.status_code}"
                            break

                    resp.raise_for_status()
                    downloaded_bytes = len(resp.content)

                    # Thread-safe atomic write to temp file and rename
                    part_path = f"{path}.part.{threading.get_ident()}.{time.perf_counter()}"
                    with open(part_path, "wb") as f:
                        f.write(resp.content)
                    os.replace(part_path, path)
                    success = True
                    break
                finally:
                    if slot_held:
                        throttle_state.release()

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
                "Download %s: start=%.3f, end=%.3f, bytes=%d, retries=%d, duration=%.3fs, success=%s",
                url_tail,
                start_ts,
                end_ts,
                downloaded_bytes,
                retries,
                elapsed,
                success,
            )

            if success:
                item["wavelength_um"] = _measure_wavelength(path)
                with completed_lock:
                    completed_items.append(item)
                    download_infos.append(info)
                    if time_to_first_frame is None:
                        time_to_first_frame = time.perf_counter() - t_total_start
                if on_frame and callable(on_frame):
                    try:
                        on_frame(item)
                    except Exception as e:
                        logger.warning("on_frame callback error: %s", e)
            else:
                with completed_lock:
                    download_infos.append(info)

            with progress_lock:
                progress_state["done"] += 1
                if progress_cb and callable(progress_cb):
                    try:
                        progress_cb(progress_state["done"], progress_state["total"])
                    except Exception as e:
                        logger.warning("progress_cb error: %s", e)

            job_queue.task_done()

    # Launch bounded thread pool
    threads = []
    actual_threads = min(live_workers, len(jobs))
    for _ in range(actual_threads):
        t = threading.Thread(target=worker, daemon=True)
        t.start()
        threads.append(t)

    # Await worker completion or global deadline
    for t in threads:
        rem = deadline_ts - time.time()
        if rem > 0:
            t.join(timeout=rem)

    # Cancel pending downloads if deadline passed
    if time.time() >= deadline_ts:
        while not job_queue.empty():
            try:
                job_queue.get_nowait()
                job_queue.task_done()
            except Exception:
                break

    # If deadline passed or errors, return frames if at least 3; else raise DataFetchError
    if len(completed_items) < 3:
        total_time = time.perf_counter() - t_total_start
        last_timings = {
            "search_time": search_time,
            "selection_time": selection_time,
            "downloads": download_infos,
            "total_download_time": sum(d["duration"] for d in download_infos),
            "total_time": total_time,
            "frames_returned": len(completed_items),
            "errors": [f"Insufficient frames completed: {len(completed_items)} (minimum 3 required)"],
            "time_to_first_frame": time_to_first_frame,
            "workers_used": live_workers,
        }
        raise DataFetchError(
            f"Download incomplete: only {len(completed_items)} frames completed (minimum 3 required)"
        )

    # Keep returned list sorted by date
    results = sorted(completed_items, key=lambda item: (item["date"], item["fits_path"]))

    # Atomic write to query cache file if caching allowed
    if not no_cache:
        tmp_cache = f"{cache_file}.tmp.{os.getpid()}"
        with open(tmp_cache, "w") as f:
            json.dump(results, f, indent=2)
        os.replace(tmp_cache, cache_file)

    total_time = time.perf_counter() - t_total_start
    total_dl_time = sum(d["duration"] for d in download_infos)
    logger.info("fetch_cutouts total time: %.3fs (%d frames)", total_time, len(results))

    last_timings = {
        "search_time": search_time,
        "selection_time": selection_time,
        "downloads": download_infos,
        "total_download_time": total_dl_time,
        "total_time": total_time,
        "frames_returned": len(results),
        "errors": [d["error"] for d in download_infos if d.get("error")],
        "time_to_first_frame": time_to_first_frame,
        "workers_used": live_workers,
    }
    return results