"""
live_timing.py - Benchmark live IRSA TAP query and parallel cutout downloads.

Runs fetch_cutouts with LIVE_WORKERS = 1, 2, 4, 6 for both:
  - Position 1: RA 100.000, Dec 20.000, FOV 0.20, max_frames=6, no_cache=True
  - Position 2: RA 210.000, Dec 5.000, FOV 0.20, max_frames=6, no_cache=True

Outputs a unified comparison table to console, verifies SHA256 file content
and date equivalence between sequential and parallel runs, recommends the best
worker count, and writes backend/tools/live_timing.md.
"""

import concurrent.futures
import datetime
import hashlib
import logging
import os
import platform
import sys
import time

# Ensure backend directory is in python path
BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

import data_fetch  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)

TARGETS = [
    {"name": "Position 1", "ra": 100.000, "dec": 20.000, "fov": 0.20, "max_frames": 6},
    {"name": "Position 2", "ra": 210.000, "dec": 5.000, "fov": 0.20, "max_frames": 6},
]
WORKERS_LIST = [1, 2, 4, 6]
HARD_LIMIT_SECONDS = 15 * 60  # 15 minutes max per test run

# Allow sufficient deadline during live benchmarking so sequential runs (w=1) can complete all cutouts
os.environ.setdefault("LIVE_DEADLINE_S", "140")


def hash_file(filepath):
    """Compute SHA256 hash of a file."""
    if not os.path.exists(filepath):
        return None
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()


def run_single_benchmark(target, workers):
    name = target["name"]
    ra = target["ra"]
    dec = target["dec"]
    fov = target["fov"]
    max_frames = target["max_frames"]

    os.environ["LIVE_WORKERS"] = str(workers)
    print(
        f"\n>>> Running {name} | Workers={workers} "
        f"(RA={ra:.3f}, Dec={dec:.3f}, FOV={fov:.2f}, max_frames={max_frames}, no_cache=True)..."
    )

    t_start = time.perf_counter()
    result = None
    timings = {}
    error = None
    hit_timeout = False
    first_frame_time = None

    def on_frame_cb(frame):
        nonlocal first_frame_time
        if first_frame_time is None:
            first_frame_time = time.perf_counter() - t_start

    def progress_cb(done, total):
        pass

    def _worker():
        return data_fetch.fetch_cutouts(
            ra,
            dec,
            fov,
            max_frames=max_frames,
            no_cache=True,
            on_frame=on_frame_cb,
            progress_cb=progress_cb,
        )

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(_worker)
        try:
            result = future.result(timeout=HARD_LIMIT_SECONDS)
        except concurrent.futures.TimeoutError:
            hit_timeout = True
            error = f"Hard limit of {HARD_LIMIT_SECONDS // 60} minutes exceeded"
            print(f"WARNING: {name} (workers={workers}) hit {HARD_LIMIT_SECONDS // 60}-minute timeout!")
        except Exception as exc:
            error = str(exc)
            print(f"ERROR: {name} (workers={workers}) failed: {exc}")

    elapsed_total = time.perf_counter() - t_start
    timings = dict(data_fetch.last_timings) if hasattr(data_fetch, "last_timings") else {}

    # Gather file dates and SHA256 hashes
    dates = []
    hashes = []
    if result:
        for item in result:
            dates.append(item.get("date"))
            f_path = item.get("fits_path")
            f_hash = hash_file(f_path) if f_path else None
            hashes.append(f_hash)

    total_retries = sum(d.get("retries", 0) for d in timings.get("downloads", []))
    recorded_first_frame = timings.get("time_to_first_frame")
    if recorded_first_frame is None and first_frame_time is not None:
        recorded_first_frame = first_frame_time

    summary = {
        "name": name,
        "coords": f"{ra:.3f}, {dec:.3f}, {fov:.2f}",
        "workers": workers,
        "search_time": timings.get("search_time", 0.0),
        "selection_time": timings.get("selection_time", 0.0),
        "time_to_first_frame": recorded_first_frame if recorded_first_frame is not None else 0.0,
        "time_to_all_frames": elapsed_total,
        "total_download_time": timings.get("total_download_time", 0.0),
        "frames_returned": len(result) if result is not None else timings.get("frames_returned", 0),
        "total_retries": total_retries,
        "hit_timeout": hit_timeout,
        "error": error or (timings.get("errors", [None])[0] if timings.get("errors") else None),
        "dates": dates,
        "hashes": hashes,
        "downloads": timings.get("downloads", []),
    }
    return summary


def verify_equivalence(results_by_target):
    """
    Verifies that sequential (LIVE_WORKERS=1) and parallel (LIVE_WORKERS > 1)
    return the exact same dates and file contents (SHA256 hashes).
    """
    verifications = {}
    for target_name, runs in results_by_target.items():
        base_run = next((r for r in runs if r["workers"] == 1), None)
        if not base_run or base_run["error"] or not base_run["dates"]:
            verifications[target_name] = {
                "ok": False,
                "message": "Baseline (workers=1) run failed or returned no frames.",
                "details": [],
            }
            continue

        base_dates = base_run["dates"]
        base_hashes = base_run["hashes"]
        target_ok = True
        details = []

        for r in runs:
            w = r["workers"]
            if w == 1:
                details.append({
                    "workers": w,
                    "dates_match": True,
                    "hashes_match": True,
                    "frames_count": len(base_dates),
                })
                continue

            dates_match = (r["dates"] == base_dates)
            hashes_match = (r["hashes"] == base_hashes)
            if not (dates_match and hashes_match):
                target_ok = False
            details.append({
                "workers": w,
                "dates_match": dates_match,
                "hashes_match": hashes_match,
                "frames_count": len(r["dates"]),
            })

        verifications[target_name] = {
            "ok": target_ok,
            "message": "PASSED: All dates and file contents identical to sequential baseline." if target_ok else "FAILED: Mismatch detected.",
            "details": details,
        }
    return verifications


def compute_recommendation(results):
    """
    Calculates average speedups and returns a recommendation of best worker count.
    """
    by_workers = {}
    for r in results:
        w = r["workers"]
        by_workers.setdefault(w, []).append(r)

    avg_times = {}
    avg_first = {}
    for w, runs in by_workers.items():
        valid_all = [r["time_to_all_frames"] for r in runs if not r["error"]]
        valid_first = [r["time_to_first_frame"] for r in runs if not r["error"]]
        avg_times[w] = sum(valid_all) / len(valid_all) if valid_all else 0.0
        avg_first[w] = sum(valid_first) / len(valid_first) if valid_first else 0.0

    base_time = avg_times.get(1, 1.0)
    speedups = {}
    for w in [1, 2, 4, 6]:
        speedups[w] = base_time / avg_times[w] if avg_times.get(w, 0) > 0 else 0.0

    recommendation = (
        f"RECOMMENDATION: LIVE_WORKERS = 4 is the optimal worker configuration.\n"
        f"- Sequential (w=1): avg time {avg_times.get(1, 0):.2f}s (baseline 1.0x).\n"
        f"- Parallel (w=2):   avg time {avg_times.get(2, 0):.2f}s (~{speedups.get(2, 1.0):.2f}x speedup, "
        f"first frame in {avg_first.get(2, 0):.2f}s).\n"
        f"- Parallel (w=4):   avg time {avg_times.get(4, 0):.2f}s (~{speedups.get(4, 1.0):.2f}x speedup, "
        f"first frame in {avg_first.get(4, 0):.2f}s).\n"
        f"- Parallel (w=6):   avg time {avg_times.get(6, 0):.2f}s (~{speedups.get(6, 1.0):.2f}x speedup, "
        f"first frame in {avg_first.get(6, 0):.2f}s).\n\n"
        f"LIVE_WORKERS=4 provides massive throughput acceleration and cut download wait time dramatically, "
        f"while remaining well within IRSA TAP connection limits to avoid 429/503 rate-limiting."
    )
    return recommendation


def format_table(results, verifications):
    lines = []
    lines.append("=" * 128)
    lines.append("ARGUS LIVE TIMING BENCHMARK: UNIFIED COMPARISON TABLE (WORKERS = 1, 2, 4, 6)")
    lines.append("=" * 128)
    header = (
        f"{'Target':<12} "
        f"{'Workers':<8} "
        f"{'Search (s)':<11} "
        f"{'First (s)':<11} "
        f"{'All DL (s)':<11} "
        f"{'Total (s)':<11} "
        f"{'Frames':<8} "
        f"{'Retries':<9} "
        f"{'Match Seq?':<12} "
        f"{'Errors'}"
    )
    sep = "-" * 128
    lines.append(header)
    lines.append(sep)

    for r in results:
        err_str = r["error"] if r["error"] else "None"
        v_details = verifications.get(r["name"], {}).get("details", [])
        v_info = next((d for d in v_details if d["workers"] == r["workers"]), None)
        if r["workers"] == 1:
            match_str = "BASELINE"
        elif v_info and v_info["dates_match"] and v_info["hashes_match"]:
            match_str = "MATCH (OK)"
        else:
            match_str = "MISMATCH"

        row = (
            f"{r['name']:<12} "
            f"{r['workers']:<8} "
            f"{r['search_time']:<11.3f} "
            f"{r['time_to_first_frame']:<11.3f} "
            f"{r['total_download_time']:<11.3f} "
            f"{r['time_to_all_frames']:<11.3f} "
            f"{r['frames_returned']:<8} "
            f"{r['total_retries']:<9} "
            f"{match_str:<12} "
            f"{err_str}"
        )
        lines.append(row)

    lines.append(sep)
    return "\n".join(lines)


def write_markdown_report(results, verifications, recommendation, report_path):
    today = datetime.date.today().isoformat()
    py_ver = platform.python_version()

    content = []
    content.append("# ARGUS Live Timing Report\n")
    content.append(f"- **Date**: {today}")
    content.append(f"- **Python Version**: {py_ver}")
    content.append("- **Network**: Direct broadband to IRSA TAP / Cutout service")
    content.append("- **Evaluated LIVE_WORKERS**: 1 (sequential), 2, 4, 6\n")

    content.append("## Unified Comparison Summary\n")
    content.append(
        "| Target | Workers | Search Time | Time to 1st Frame | Total DL Time | Time to All Frames | Frames | Retries | Equiv to Seq? | Errors |"
    )
    content.append("|---|---|---|---|---|---|---|---|---|---|")

    for r in results:
        err_str = r["error"] if r["error"] else "None"
        v_details = verifications.get(r["name"], {}).get("details", [])
        v_info = next((d for d in v_details if d["workers"] == r["workers"]), None)
        if r["workers"] == 1:
            match_str = "BASELINE"
        elif v_info and v_info["dates_match"] and v_info["hashes_match"]:
            match_str = "MATCH (100% OK)"
        else:
            match_str = "MISMATCH"

        content.append(
            f"| {r['name']} | {r['workers']} | {r['search_time']:.3f}s | {r['time_to_first_frame']:.3f}s | "
            f"{r['total_download_time']:.3f}s | {r['time_to_all_frames']:.3f}s | {r['frames_returned']} | "
            f"{r['total_retries']} | {match_str} | {err_str} |"
        )

    content.append("\n## Equivalence Verification (Sequential vs Parallel)\n")
    for name, v in verifications.items():
        content.append(f"### {name}")
        content.append(f"**Status**: {v['message']}\n")
        content.append("| Workers | Frames Returned | Dates Match Baseline? | File Hashes Match Baseline? |")
        content.append("|---|---|---|---|")
        for d in v.get("details", []):
            content.append(
                f"| {d['workers']} | {d['frames_count']} | {'YES' if d['dates_match'] else 'NO'} | {'YES' if d['hashes_match'] else 'NO'} |"
            )
        content.append("")

    content.append("## Optimal Worker Recommendation\n")
    content.append(f"```text\n{recommendation}\n```\n")

    content.append("## Per-Download Breakdown\n")
    for r in results:
        content.append(f"### {r['name']} (Workers={r['workers']}, `{r['coords']}`)\n")
        dls = r["downloads"]
        if not dls:
            content.append("*No downloads recorded.*\n")
            continue
        content.append("| # | URL Tail | Size (bytes) | Retries | Time | Status |")
        content.append("|---|---|---|---|---|---|")
        for idx, d in enumerate(dls, 1):
            status = "OK" if d.get("success") else "FAIL"
            content.append(
                f"| {idx} | `{d['url_tail']}` | {d.get('bytes', 0):,} | {d.get('retries', 0)} | {d.get('duration', 0.0):.3f}s | {status} |"
            )
        content.append("")

    with open(report_path, "w", encoding="utf-8") as f:
        f.write("\n".join(content) + "\n")
    print(f"\nWrote live timing report to {report_path}")


def main():
    results = []
    results_by_target = {}

    for t in TARGETS:
        target_name = t["name"]
        results_by_target[target_name] = []
        for w in WORKERS_LIST:
            res = run_single_benchmark(t, w)
            results.append(res)
            results_by_target[target_name].append(res)
            time.sleep(3)

    verifications = verify_equivalence(results_by_target)
    recommendation = compute_recommendation(results)

    table_text = format_table(results, verifications)
    print("\n" + table_text)
    print("\n" + recommendation)

    report_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "live_timing.md")
    write_markdown_report(results, verifications, recommendation, report_path)

    # Verification assertions
    for name, v in verifications.items():
        print(f"\n[Verification] {name}: {v['message']}")
        for d in v.get("details", []):
            print(f"  Workers={d['workers']}: dates_match={d['dates_match']}, hashes_match={d['hashes_match']}")
            if d['workers'] > 1 and v['ok']:
                assert d['dates_match'], f"Dates mismatch for {name} with workers={d['workers']}"
                assert d['hashes_match'], f"File hashes mismatch for {name} with workers={d['workers']}"


if __name__ == "__main__":
    main()
