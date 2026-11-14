"""
check_cached.py - verify cached demo targets and uncached 404 behavior against ARGUS frames server.

Checks:
  - Each of the 5 demo targets:
      * HTTP 200
      * mock is False
      * frame count matches backend/demo_cache_final/<target>/frames.json
      * target_xy appears exactly on the frames where frames.json has it
      * every image_url returns HTTP 200 with an image content-type
      * response time is under 1.0 second
  - Uncached position (ra=100, dec=20, fov=0.20, cached_only=1):
      * HTTP 404
      * response time is under 1.0 second
  - Prints a PASS/FAIL table and exits with code 0 on success, 1 on failure.

Usage:
  python backend/tools/check_cached.py [BASE_URL]
Default BASE_URL is http://localhost:8000.
"""

import argparse
import json
import os
import socket
import sys
import time

import requests

# Avoid 2-second IPv6 fallback delay on Windows when connecting to 'localhost'
_orig_getaddrinfo = socket.getaddrinfo


def _patched_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    if host == "localhost":
        return _orig_getaddrinfo("127.0.0.1", port, family, type, proto, flags)
    return _orig_getaddrinfo(host, port, family, type, proto, flags)


socket.getaddrinfo = _patched_getaddrinfo

TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.dirname(TOOLS_DIR)
DEMO_FINAL_DIR = os.path.join(BACKEND_DIR, "demo_cache_final")

TARGETS = [
    {
        "name": "WISE 0855",
        "ra": 133.795,
        "dec": -7.245,
        "fov": 0.20,
        "folder": "133.795_-7.245_0.20",
    },
    {
        "name": "Barnard's Star",
        "ra": 269.452,
        "dec": 4.693,
        "fov": 0.20,
        "folder": "269.452_4.693_0.20",
    },
    {
        "name": "Epsilon Indi B",
        "ra": 331.044,
        "dec": -56.783,
        "fov": 0.15,
        "folder": "331.044_-56.783_0.15",
    },
    {
        "name": "RW Aurigae",
        "ra": 76.956,
        "dec": 30.401,
        "fov": 0.20,
        "folder": "76.956_30.401_0.20",
    },
    {
        "name": "R Draconis",
        "ra": 248.168,
        "dec": 66.755,
        "fov": 0.20,
        "folder": "248.168_66.755_0.20",
    },
]

UNCACHED = {
    "name": "Uncached (probe)",
    "ra": 100,
    "dec": 20,
    "fov": 0.20,
}


def parse_args():
    parser = argparse.ArgumentParser(description="Check cached targets against ARGUS frames server.")
    parser.add_argument(
        "base_url",
        nargs="?",
        default="http://localhost:8000",
        help="Base URL of ARGUS frames server (default: http://localhost:8000)",
    )
    return parser.parse_args()


def check_cached_target(session, base_url, target):
    name = target["name"]
    ra = target["ra"]
    dec = target["dec"]
    fov = target["fov"]
    folder = target["folder"]

    ref_json_path = os.path.join(DEMO_FINAL_DIR, folder, "frames.json")
    if not os.path.isfile(ref_json_path):
        return {
            "name": name,
            "coords": f"{ra:.3f}, {dec:.3f}, {fov:.2f}",
            "status_code": "ERR",
            "mock": "N/A",
            "frames": "0/0",
            "target_xy": "N/A",
            "images": "N/A",
            "time_sec": 0.0,
            "passed": False,
            "errors": [f"Missing reference frames.json at {ref_json_path}"],
        }

    with open(ref_json_path, "r", encoding="utf-8-sig") as f:
        ref_data = json.load(f)
    ref_frames = ref_data.get("frames", ref_data) if isinstance(ref_data, dict) else ref_data

    url = f"{base_url}/frames?ra={ra}&dec={dec}&fov={fov:.2f}&cached_only=1"

    errors = []
    t0 = time.perf_counter()
    try:
        resp = session.get(url, timeout=5)
    except Exception as e:
        elapsed = time.perf_counter() - t0
        return {
            "name": name,
            "coords": f"{ra:.3f}, {dec:.3f}, {fov:.2f}",
            "status_code": "CONN_FAIL",
            "mock": "N/A",
            "frames": "N/A",
            "target_xy": "N/A",
            "images": "N/A",
            "time_sec": elapsed,
            "passed": False,
            "errors": [f"Connection error to {url}: {e}"],
        }
    elapsed = time.perf_counter() - t0

    if elapsed >= 1.0:
        errors.append(f"Response time {elapsed:.3f}s exceeds 1.0s limit")

    if resp.status_code != 200:
        errors.append(f"Expected HTTP 200, got HTTP {resp.status_code}")
        return {
            "name": name,
            "coords": f"{ra:.3f}, {dec:.3f}, {fov:.2f}",
            "status_code": str(resp.status_code),
            "mock": "N/A",
            "frames": "N/A",
            "target_xy": "N/A",
            "images": "N/A",
            "time_sec": elapsed,
            "passed": False,
            "errors": errors,
        }

    try:
        data = resp.json()
    except Exception as e:
        errors.append(f"Invalid JSON response: {e}")
        return {
            "name": name,
            "coords": f"{ra:.3f}, {dec:.3f}, {fov:.2f}",
            "status_code": str(resp.status_code),
            "mock": "N/A",
            "frames": "N/A",
            "target_xy": "N/A",
            "images": "N/A",
            "time_sec": elapsed,
            "passed": False,
            "errors": errors,
        }

    mock_val = data.get("mock")
    if mock_val is not False:
        errors.append(f"Expected mock=False, got mock={mock_val}")

    frames = data.get("frames", [])
    expected_count = len(ref_frames)
    actual_count = len(frames)
    if actual_count != expected_count:
        errors.append(f"Frame count mismatch: got {actual_count}, expected {expected_count}")

    # Check target_xy alignment per frame
    matched_xy_count = 0
    total_xy_checks = min(actual_count, expected_count)
    for i in range(total_xy_checks):
        act_f = frames[i]
        exp_f = ref_frames[i]
        act_has_xy = "target_xy" in act_f and act_f["target_xy"] is not None
        exp_has_xy = "target_xy" in exp_f and exp_f["target_xy"] is not None
        if act_has_xy != exp_has_xy:
            errors.append(
                f"Frame {i} ({act_f.get('date')}): target_xy presence mismatch "
                f"(actual={act_has_xy}, expected={exp_has_xy})"
            )
        else:
            if act_has_xy and exp_has_xy:
                if act_f["target_xy"] != exp_f["target_xy"]:
                    errors.append(
                        f"Frame {i}: target_xy value mismatch (actual={act_f['target_xy']}, expected={exp_f['target_xy']})"
                    )
                else:
                    matched_xy_count += 1
            else:
                matched_xy_count += 1

    # Check image_url for each frame
    images_ok_count = 0
    for i, f_item in enumerate(frames):
        img_url = f_item.get("image_url")
        if not img_url:
            errors.append(f"Frame {i} missing image_url")
            continue
        try:
            img_resp = session.get(img_url, stream=True, timeout=5)
            if img_resp.status_code != 200:
                errors.append(f"Frame {i} image HTTP {img_resp.status_code} at {img_url}")
                continue
            ct = img_resp.headers.get("content-type", "").lower()
            if not ("image" in ct):
                errors.append(f"Frame {i} non-image content-type '{ct}' at {img_url}")
                continue
            images_ok_count += 1
        except Exception as e:
            errors.append(f"Frame {i} failed to fetch image {img_url}: {e}")

    passed = (len(errors) == 0)
    return {
        "name": name,
        "coords": f"{ra:.3f}, {dec:.3f}, {fov:.2f}",
        "status_code": str(resp.status_code),
        "mock": str(mock_val),
        "frames": f"{actual_count}/{expected_count}",
        "target_xy": f"{matched_xy_count}/{total_xy_checks}",
        "images": f"{images_ok_count}/{actual_count} OK",
        "time_sec": elapsed,
        "passed": passed,
        "errors": errors,
    }


def check_uncached_position(session, base_url, uncached):
    name = uncached["name"]
    ra = uncached["ra"]
    dec = uncached["dec"]
    fov = uncached["fov"]

    url = f"{base_url}/frames?ra={ra}&dec={dec}&fov={fov:.2f}&cached_only=1"

    errors = []
    t0 = time.perf_counter()
    try:
        resp = session.get(url, timeout=5)
    except Exception as e:
        elapsed = time.perf_counter() - t0
        return {
            "name": name,
            "coords": f"{ra:.3f}, {dec:.3f}, {fov:.2f}",
            "status_code": "CONN_FAIL",
            "mock": "N/A",
            "frames": "N/A",
            "target_xy": "N/A",
            "images": "N/A",
            "time_sec": elapsed,
            "passed": False,
            "errors": [f"Connection error to {url}: {e}"],
        }
    elapsed = time.perf_counter() - t0

    if elapsed >= 1.0:
        errors.append(f"Response time {elapsed:.3f}s exceeds 1.0s limit")

    if resp.status_code != 404:
        errors.append(f"Expected HTTP 404, got HTTP {resp.status_code}")

    passed = (len(errors) == 0)
    return {
        "name": name,
        "coords": f"{ra:.3f}, {dec:.3f}, {fov:.2f}",
        "status_code": str(resp.status_code),
        "mock": "N/A",
        "frames": "N/A",
        "target_xy": "N/A",
        "images": "N/A",
        "time_sec": elapsed,
        "passed": passed,
        "errors": errors,
    }


def wait_for_server(session, base_url, timeout=10):
    health_url = f"{base_url}/health"
    start = time.time()
    while time.time() - start < timeout:
        try:
            r = session.get(health_url, timeout=1)
            if r.status_code == 200:
                return True
        except Exception:
            pass
        time.sleep(0.2)
    return False


def main():
    args = parse_args()
    base_url = args.base_url.rstrip("/")

    print("==========================================================================================================")
    print(f"ARGUS CACHE VERIFICATION: {base_url}")
    print(f"Cache folder reference: {DEMO_FINAL_DIR}")
    print("==========================================================================================================")

    session = requests.Session()
    # Ensure server is up and responsive before running timed checks
    wait_for_server(session, base_url)

    results = []
    for t in TARGETS:
        res = check_cached_target(session, base_url, t)
        results.append(res)

    uncached_res = check_uncached_position(session, base_url, UNCACHED)
    results.append(uncached_res)

    # Print table
    col_name = 18
    col_coords = 24
    col_http = 6
    col_mock = 7
    col_frames = 9
    col_txy = 11
    col_img = 12
    col_time = 10
    col_res = 8

    header = (
        f"{'Target':<{col_name}} "
        f"{'Coordinates':<{col_coords}} "
        f"{'HTTP':<{col_http}} "
        f"{'Mock':<{col_mock}} "
        f"{'Frames':<{col_frames}} "
        f"{'target_xy':<{col_txy}} "
        f"{'Images':<{col_img}} "
        f"{'Time':<{col_time}} "
        f"{'Result':<{col_res}}"
    )
    separator = "-" * len(header)

    print()
    print(separator)
    print(header)
    print(separator)

    all_passed = True
    for r in results:
        res_str = "PASS" if r["passed"] else "FAIL"
        if not r["passed"]:
            all_passed = False
        time_str = f"{r['time_sec']:.3f}s"
        row = (
            f"{r['name']:<{col_name}} "
            f"{r['coords']:<{col_coords}} "
            f"{r['status_code']:<{col_http}} "
            f"{r['mock']:<{col_mock}} "
            f"{r['frames']:<{col_frames}} "
            f"{r['target_xy']:<{col_txy}} "
            f"{r['images']:<{col_img}} "
            f"{time_str:<{col_time}} "
            f"{res_str:<{col_res}}"
        )
        print(row)

    print(separator)

    # Print failure details if any
    failed_results = [r for r in results if not r["passed"]]
    if failed_results:
        print("\nFAILURE DETAILS:")
        for r in failed_results:
            print(f"  [{r['name']}]:")
            for err in r["errors"]:
                print(f"    - {err}")
        print("\nOVERALL: FAIL\n")
        sys.exit(1)
    else:
        print("\nOVERALL: ALL CHECKS PASSED (6/6)\n")
        sys.exit(0)


if __name__ == "__main__":
    main()
