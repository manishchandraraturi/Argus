"""
check_final_cache.py - check backend/demo_cache_final/ against Manish's per-target rule.

The expected source of every folder comes from USE_ALIGNED in build_final_cache.py,
so there is only one place to edit that decision.

For each of the 5 demo targets it checks:

    - the folder and frames.json exist, mock is false, the target label matches
    - every frame has date, filename, detector, wavelength_um, flags
    - the PNG exists, is 600x600 and grayscale
    - frames are sorted by date
    - target_xy exists and points inside the picture. An aligned frame may only be
      missing it when there is no data at the star (see the star window below).
    - the agreed A/B pair points at real frames
    - there are no extra PNGs that frames.json does not mention
    - the 50x50 star window of every frame that went through reprojection. The box
      is placed at the target_xy that demo_cache_aligned says the star is at, which
      is the source of truth and does not depend on what the final JSON kept:

        FAIL  a NaN hole of 25 px or more inside covered data
              (this is the grey blank square we are hunting)
        FAIL  half or more of the window has no data, but the frame still has a
              target_xy (a marker pointing at empty sky)
        FAIL  the window is fully covered, but the frame has no target_xy
        WARN  half or more of the window has no data, and the frame has no
              target_xy (a bad source cutout, already handled by the build)
        WARN  the star sits right at the edge of the footprint (partly empty)
        OK    everything else

      PNGs cannot store NaN (convert.array_to_png fills it with the median), so the
      window is measured on the raw FITS files reprojected again, not on the PNG.
      For "fill+bilinear" the same NaN fill is applied first, so the number says
      what the viewer will really show.

    - original targets: no frame may have a target_xy, and coverage is only printed
      as an INFO line, using the aligned version of the same cutouts. Their grid is
      centred on the target RA/Dec, so the star window sits at the grid centre.

Exit code: 0 when nothing FAILed (WARN is allowed), 1 when anything failed.

Run from the repo root (Command Prompt):

    backend\\.venv\\Scripts\\python.exe backend\\tools\\check_final_cache.py
"""

import json
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
if TOOLS_DIR not in sys.path:
    sys.path.insert(0, TOOLS_DIR)

# Single source of truth for the per-target decision, plus the small reprojection
# helpers, so the checker and the builder cannot drift apart.
from build_final_cache import (  # noqa: E402
    FOVS,
    USE_ALIGNED,
    common_wcs,
    fill_nans,
    fits_paths_for,
    load_raw,
    reproject_frame,
    window_mask,
)

BACKEND = os.path.dirname(TOOLS_DIR)
FINAL_DIR = os.path.join(BACKEND, "demo_cache_final")
ALIGNED_DIR = os.path.join(BACKEND, "demo_cache_aligned")

N = 600

WINDOW = 50                    # the box we look at around the star, in PNG pixels
WINDOW_PX = WINDOW * WINDOW    # 2500: every fraction below is over this
HOLE_MIN_PX = 25               # a hole this big inside covered data is a grey square
NO_COVERAGE_FRAC = 0.50        # half the window empty counts as "no data at the star"

# Every original frame sits on a grid centred on the target, so the star is here.
STAR_CENTRE_XY = [(N - 1) / 2.0, (N - 1) / 2.0]

# The agreed blink pair per target (0-based, same as _NN in the PNG name).
PAIRS = {
    "WISE 0855": (1, 6),
    "Barnard's Star": (0, 9),
    "Epsilon Indi B": (1, 9),
    "RW Aurigae": (1, 9),
    "R Draconis": (0, 11),
}

REQUIRED_KEYS = ("date", "filename", "detector", "wavelength_um", "flags")


def source_name(mode):
    """\"original\" / \"aligned\" / \"aligned+fill\" for the report."""
    if mode is False:
        return "original"
    return "aligned" if mode is True else "aligned+fill"


def folder_for(ra, dec, fov):
    return f"{ra:.3f}_{dec:.3f}_{fov:.2f}"


def expected_xy_map(ra, dec, fov):
    """filename -> [x, y] from demo_cache_aligned, where the star really is.

    The final frames.json may have dropped a target_xy on purpose, so the star
    position has to come from the aligned source, not from the file we check.
    """
    path = os.path.join(ALIGNED_DIR, folder_for(ra, dec, fov), "frames.json")
    if not os.path.isfile(path):
        return {}
    with open(path, encoding="utf-8") as f:
        frames = json.load(f)["frames"]
    out = {}
    for frame in frames:
        xy = frame.get("target_xy")
        if isinstance(xy, list) and len(xy) == 2:
            out[frame["filename"]] = xy
    return out


def frame_star_stats(ra, dec, fov, frames, star_xy, mode):
    """Reproject every frame once and describe its star window.

    star_xy: filename -> [x, y] (demo_cache_aligned). Frames that are not in there
    (the originals) fall back to the grid centre, which is the target itself.
    """
    paths = fits_paths_for(ra, dec, fov, frames, quiet=True)
    wcs = common_wcs(ra, dec, fov)
    stats = []

    for frame in frames:
        filename = frame["filename"]
        index = int(filename.rsplit("_", 1)[1].split(".")[0])
        raw, wcs_in = load_raw(paths[index])
        cutout = f"{raw.shape[1]}x{raw.shape[0]}"   # NAXIS1 x NAXIS2, width x height

        if mode == "fill+bilinear":
            raw, _, _ = fill_nans(raw)
        array = reproject_frame(raw, wcs_in, wcs)
        finite = np.isfinite(array)

        xy = star_xy.get(filename, STAR_CENTRE_XY)
        window = window_mask(xy)
        nan_px = int((window & ~finite).sum())

        # A hole is empty sky fully surrounded by data; empty sky that reaches the
        # edge of the frame is just the edge of the footprint.
        holes = ndimage.binary_fill_holes(finite) & ~finite
        inside = holes & window
        hole_px = 0
        if inside.any():
            labels, _count = ndimage.label(inside)
            hole_px = int(np.bincount(labels.ravel())[1:].max())

        stats.append({
            "index": index,
            "date": frame.get("date") or "",
            "filename": filename,
            "nan_px": nan_px,
            "coverage": float(finite.mean()),
            "hole_px": hole_px,
            "cutout": cutout,
        })

    return stats


def check_target(name, ra, dec, fov):
    """Check one folder. Returns a dict with the counts and the lines to print."""
    mode = USE_ALIGNED.get(name, False)
    aligned = mode is True or mode == "fill+bilinear"

    result = {
        "name": name,
        "mode": mode,
        "aligned": aligned,
        "frames": 0,
        "with_xy": 0,
        "holes": 0,
        "nocov": 0,
        "fails": [],
        "warns": [],
        "info": None,
    }

    folder_name = folder_for(ra, dec, fov)
    folder = os.path.join(FINAL_DIR, folder_name)
    json_path = os.path.join(folder, "frames.json")

    if not os.path.isdir(folder):
        result["fails"].append(f"FAIL {name}: folder {folder_name} is missing")
        return result
    if not os.path.isfile(json_path):
        result["fails"].append(f"FAIL {name}: {folder_name}/frames.json is missing")
        return result

    with open(json_path, encoding="utf-8") as f:
        data = json.load(f)

    frames = data.get("frames")
    if not isinstance(frames, list) or not frames:
        result["fails"].append(f"FAIL {name}: frames.json has no frames list")
        return result

    result["frames"] = len(frames)

    if data.get("mock") is not False:
        result["fails"].append(f"FAIL {name}: mock should be false")
    if data.get("target") != name:
        result["fails"].append(
            f"FAIL {name}: target label is {data.get('target')!r}, expected {name!r}"
        )

    total_bytes = 0
    seen_files = set()
    dates = []

    for i, frame in enumerate(frames):
        for key in REQUIRED_KEYS:
            if key not in frame:
                result["fails"].append(f"FAIL {name} frame {i}: missing {key}")

        filename = frame.get("filename")
        if not filename:
            continue
        seen_files.add(filename)
        png_path = os.path.join(folder, filename)

        if not os.path.isfile(png_path):
            result["fails"].append(f"FAIL {name} frame {i}: PNG is missing: {filename}")
            continue

        total_bytes += os.path.getsize(png_path)
        try:
            with Image.open(png_path) as img:
                if img.size != (N, N):
                    result["fails"].append(
                        f"FAIL {name} {filename}: {img.size[0]}x{img.size[1]}, expected {N}x{N}"
                    )
                if img.mode != "L":
                    result["fails"].append(
                        f"FAIL {name} {filename}: mode {img.mode}, expected grayscale L"
                    )
        except Exception as err:
            result["fails"].append(f"FAIL {name} {filename}: cannot be opened: {err}")

        if frame.get("date"):
            dates.append(frame["date"])

        # target_xy: forbidden on the originals, and on aligned frames only allowed
        # when it points inside the picture. Whether it SHOULD be there is decided
        # by the star window below.
        xy = frame.get("target_xy")
        if not aligned:
            if "target_xy" in frame:
                result["fails"].append(
                    f"FAIL {name} frame {i}: original source but has a target_xy"
                )
        elif xy is not None:
            if not (isinstance(xy, list) and len(xy) == 2):
                result["fails"].append(
                    f"FAIL {name} frame {i}: target_xy should have 2 numbers, got {xy!r}"
                )
            elif not (0 <= xy[0] <= N - 1 and 0 <= xy[1] <= N - 1):
                result["fails"].append(
                    f"FAIL {name} frame {i}: target_xy {xy} is outside the {N}x{N} picture"
                )

    result["with_xy"] = sum(
        1 for frame in frames
        if isinstance(frame.get("target_xy"), list) and len(frame["target_xy"]) == 2
    )

    if dates != sorted(dates):
        result["fails"].append(f"FAIL {name}: frames are not sorted by date")

    # The A/B pair we blink on stage must point at real frames.
    a, b = PAIRS[name]
    if b >= len(frames):
        result["fails"].append(
            f"FAIL {name}: pair {a}/{b} needs {b + 1} frames but there are {len(frames)}"
        )

    # Extra PNGs are confusing (old experiments left behind).
    on_disk = {f for f in os.listdir(folder) if f.lower().endswith(".png")}
    extra = sorted(on_disk - seen_files)
    if extra:
        result["fails"].append(
            f"FAIL {name}: {len(extra)} PNG(s) in the folder are not in frames.json: {extra[:3]}"
        )

    result["bytes"] = total_bytes

    # ---- the star window ---------------------------------------------------
    stats = frame_star_stats(ra, dec, fov, frames, expected_xy_map(ra, dec, fov), mode)

    if not aligned:
        # Nothing to fail on, but the same numbers are useful to know.
        covered = [stat["coverage"] for stat in stats]
        empty = [f"{stat['index']:02d}" for stat in stats
                 if stat["nan_px"] / float(WINDOW_PX) >= NO_COVERAGE_FRAC]
        result["info"] = (
            f"INFO {name} (original, aligned reference): covered_fraction per frame "
            f"min {min(covered):.3f} max {max(covered):.3f}; "
            f"frames with no coverage at the star: "
            + (", ".join(empty) if empty else "none")
        )
        return result

    has_xy = {frame["filename"]: "target_xy" in frame for frame in frames}

    for stat in stats:
        frac = stat["nan_px"] / float(WINDOW_PX)
        label = f"{name} frame {stat['index']:02d} ({stat['date']})"

        if stat["hole_px"] >= HOLE_MIN_PX:
            result["holes"] += 1
            result["fails"].append(
                f"FAIL {label}: {stat['hole_px']} px NaN hole (grey square) inside "
                f"covered data at the star"
            )

        if frac >= NO_COVERAGE_FRAC:
            result["nocov"] += 1
            if has_xy[stat["filename"]]:
                result["fails"].append(
                    f"FAIL {label}: target_xy is set but the star window has no data "
                    f"({stat['nan_px']}/{WINDOW_PX} px non-finite)"
                )
            else:
                empty_text = ("star window 100% empty"
                              if stat["nan_px"] == WINDOW_PX else "star window mostly empty")
                result["warns"].append(
                    f"WARN {label}: {empty_text} ({stat['nan_px']}/{WINDOW_PX} px "
                    f"non-finite); footprint covers {stat['coverage'] * 100:.1f}% of the "
                    f"{N}x{N} grid; no data at the star, so target_xy is removed in "
                    f"demo_cache_final. Source cutout is {stat['cutout']} and off target. "
                    f"Needs re-download."
                )
        elif stat["nan_px"] == 0 and not has_xy[stat["filename"]]:
            result["fails"].append(
                f"FAIL {label}: no target_xy although the star is covered"
            )
        elif stat["nan_px"] > 0:
            result["warns"].append(
                f"WARN {label}: star near the edge of the footprint "
                f"({stat['nan_px']}/{WINDOW_PX} px non-finite)"
            )

    # If most frames have no star at all, the target itself is wrong.
    if result["nocov"] * 2 > result["frames"]:
        result["fails"].append(
            f"FAIL {name}: {result['nocov']} of {result['frames']} frames have no "
            f"coverage at the star"
        )

    return result


def status_of(result):
    """OK, OK* (warnings only) or FAIL."""
    if result["fails"]:
        return "FAIL"
    if result["warns"]:
        return "OK*"
    return "OK"


def main():
    targets_path = os.path.join(BACKEND, "targets_verified.json")
    if not os.path.isfile(targets_path):
        print("targets_verified.json not found in", BACKEND)
        return 1
    with open(targets_path, encoding="utf-8") as f:
        targets = json.load(f)

    if not os.path.isdir(FINAL_DIR):
        print("demo_cache_final does not exist yet.")
        print("Build it first:  backend\\.venv\\Scripts\\python.exe backend\\tools\\build_final_cache.py")
        return 1

    print("Checking", FINAL_DIR)
    print()

    results = []
    total_frames = 0
    total_bytes = 0

    for target in targets:
        name = target["name"]
        if name not in FOVS:
            continue
        result = check_target(name, target["ra_deg"], target["dec_deg"], FOVS[name])
        results.append(result)
        total_frames += result["frames"]
        total_bytes += result.get("bytes", 0)

    header = (f"{'':<5}{'target':<17}{'source':<14}{'frames':>7}  "
              f"{'xy':<8}{'holes':<8}{'no-coverage':<12}")
    print(header)
    print("-" * len(header))
    for result in results:
        status = status_of(result)
        print(f"{status:<5}{result['name']:<17}{source_name(result['mode']):<14}"
              f"{result['frames']:>4} frames  "
              f"{result['with_xy']}/{result['frames']:<5}"
              f"{result['holes']:<8}{result['nocov']:<12}")

    fails = [line for result in results for line in result["fails"]]
    warns = [line for result in results for line in result["warns"]]
    infos = [result["info"] for result in results if result["info"]]

    if fails:
        print()
        for line in fails:
            print(line)
    if warns:
        print()
        for line in warns:
            print(line)
    if infos:
        print()
        for line in infos:
            print(line)

    failed_targets = sum(1 for result in results if result["fails"])
    code = 1 if failed_targets else 0

    print()
    print(f"{total_frames} frames checked, {round(total_bytes / 1e6, 1)} MB of PNGs")
    print(f"SUMMARY: {len(results)} targets, {failed_targets} FAIL, {len(warns)} WARN. "
          f"CHECK_EXIT={code}")
    return code


if __name__ == "__main__":
    sys.exit(main())
