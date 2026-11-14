"""
live_timing.py - Benchmark live IRSA TAP query and cutout downloads.

Runs fetch_cutouts(100.000, 20.000, 0.20, max_frames=6, no_cache=True)
then fetch_cutouts(210.000, 5.000, 0.20, max_frames=6, no_cache=True)
one after the other, with a 15-minute hard limit per position.

Outputs a timing table to console and writes backend/tools/live_timing.md.
"""

import concurrent.futures
import datetime
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
HARD_LIMIT_SECONDS = 15 * 60  # 15 minutes


def run_single_position(target):
    name = target["name"]
    ra = target["ra"]
    dec = target["dec"]
    fov = target["fov"]
    max_frames = target["max_frames"]

    print(f"\n>>> Running {name} (RA={ra:.3f}, Dec={dec:.3f}, FOV={fov:.2f}, max_frames={max_frames}, no_cache=True)...")
    start_time = time.perf_counter()
    result = None
    timings = {}
    error = None
    hit_timeout = False

    def _worker():
        return data_fetch.fetch_cutouts(ra, dec, fov, max_frames=max_frames, no_cache=True)

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(_worker)
        try:
            result = future.result(timeout=HARD_LIMIT_SECONDS)
        except concurrent.futures.TimeoutError:
            hit_timeout = True
            error = f"Hard limit of {HARD_LIMIT_SECONDS // 60} minutes exceeded"
            print(f"WARNING: {name} hit {HARD_LIMIT_SECONDS // 60}-minute timeout!")
        except Exception as exc:
            error = str(exc)
            print(f"ERROR: {name} failed: {exc}")

    elapsed_total = time.perf_counter() - start_time
    timings = dict(data_fetch.last_timings) if hasattr(data_fetch, "last_timings") else {}

    # Total retries across all downloads
    total_retries = sum(d.get("retries", 0) for d in timings.get("downloads", []))

    summary = {
        "name": name,
        "coords": f"{ra:.3f}, {dec:.3f}, {fov:.2f}",
        "search_time": timings.get("search_time", 0.0),
        "selection_time": timings.get("selection_time", 0.0),
        "downloads": timings.get("downloads", []),
        "total_download_time": timings.get("total_download_time", 0.0),
        "total_time": elapsed_total,
        "frames_returned": len(result) if result is not None else timings.get("frames_returned", 0),
        "total_retries": total_retries,
        "hit_timeout": hit_timeout,
        "error": error or (timings.get("errors", [None])[0] if timings.get("errors") else None),
    }
    return summary


def format_table(results):
    lines = []
    lines.append("=" * 115)
    lines.append("ARGUS LIVE TIMING BENCHMARK TABLE")
    lines.append("=" * 115)
    header = (
        f"{'Target':<12} "
        f"{'Coordinates':<20} "
        f"{'Search (s)':<12} "
        f"{'Select (s)':<12} "
        f"{'DLs Time (s)':<14} "
        f"{'Total (s)':<12} "
        f"{'Frames':<8} "
        f"{'Retries':<9} "
        f"{'Error'}"
    )
    sep = "-" * 115
    lines.append(header)
    lines.append(sep)

    for r in results:
        err_str = r["error"] if r["error"] else "None"
        row = (
            f"{r['name']:<12} "
            f"{r['coords']:<20} "
            f"{r['search_time']:<12.3f} "
            f"{r['selection_time']:<12.3f} "
            f"{r['total_download_time']:<14.3f} "
            f"{r['total_time']:<12.3f} "
            f"{r['frames_returned']:<8} "
            f"{r['total_retries']:<9} "
            f"{err_str}"
        )
        lines.append(row)

    lines.append(sep)

    # Detailed per-download breakdown
    lines.append("\nDOWNLOAD BREAKDOWN:")
    for r in results:
        lines.append(f"\n[{r['name']} - {r['coords']}]:")
        dls = r["downloads"]
        if not dls:
            lines.append("  (No downloads recorded)")
            continue
        dl_header = f"  {'#':<3} {'URL Tail':<40} {'Bytes':<10} {'Retries':<8} {'Time (s)':<10} {'Status'}"
        lines.append(dl_header)
        lines.append("  " + "-" * 80)
        for idx, d in enumerate(dls, 1):
            tail = d["url_tail"]
            if len(tail) > 38:
                tail = tail[:35] + "..."
            status = "OK" if d.get("success") else "FAIL"
            lines.append(
                f"  {idx:<3} {tail:<40} {d.get('bytes', 0):<10} {d.get('retries', 0):<8} {d.get('duration', 0.0):<10.3f} {status}"
            )

    return "\n".join(lines)


def write_markdown_report(results, report_path):
    today = datetime.date.today().isoformat()
    py_ver = platform.python_version()

    content = []
    content.append("# ARGUS Live Timing Report\n")
    content.append(f"- **Date**: {today}")
    content.append(f"- **Python Version**: {py_ver}")
    content.append("- **Network: (fill in)**")
    content.append(f"- **LIVE_WORKERS**: {os.environ.get('LIVE_WORKERS', '1')} (sequential execution)\n")
    content.append("## Timing Summary\n")
    content.append("| Target | Coordinates | Search Time | Selection Time | Total Download Time | Total Time | Frames Returned | Retries | Errors |")
    content.append("|---|---|---|---|---|---|---|---|---|")

    for r in results:
        err_str = r["error"] if r["error"] else "None"
        content.append(
            f"| {r['name']} | `{r['coords']}` | {r['search_time']:.3f}s | {r['selection_time']:.3f}s | "
            f"{r['total_download_time']:.3f}s | {r['total_time']:.3f}s | {r['frames_returned']} | {r['total_retries']} | {err_str} |"
        )

    content.append("\n## Per-Download Breakdown\n")
    for r in results:
        content.append(f"### {r['name']} (`{r['coords']}`)\n")
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
    for t in TARGETS:
        res = run_single_position(t)
        results.append(res)

    table_text = format_table(results)
    print("\n" + table_text)

    report_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "live_timing.md")
    write_markdown_report(results, report_path)


if __name__ == "__main__":
    main()
