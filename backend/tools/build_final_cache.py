"""
build_final_cache.py - build backend/demo_cache_final/ by copying from the two existing
caches, following Manish's per-target rule.

There are three ways a target can end up in demo_cache_final (see USE_ALIGNED below):

    False            copy the original frames from backend/demo_cache and drop target_xy
    True             copy the aligned frames from backend/demo_cache_aligned, unchanged
    "fill+bilinear"  like aligned, but the raw FITS NaN pixels are filled first so the
                     star does not get a grey square; PNGs are reprojected again

For both aligned modes one more rule applies: a frame whose 50x50 star window has no
data at all (a bad source cutout, not a fill problem) loses its target_xy in the
written frames.json. The PNG, the filename, the date and every other field stay. That
way the frontend never draws a marker into empty space. The frame itself is kept
because the demo shows dates, not a star marker.

Nothing is downloaded. The two source folders are only read, never written.
Only backend/demo_cache_final is deleted and rebuilt.

Run from the repo root (Command Prompt):

    backend\\.venv\\Scripts\\python.exe backend\\tools\\build_final_cache.py
"""

import json
import os
import shutil
import sys
import warnings

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS
from reproject import reproject_interp

warnings.simplefilter("ignore")

TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.dirname(TOOLS_DIR)
if BACKEND not in sys.path:
    sys.path.insert(0, BACKEND)

from convert import array_to_png  # noqa: E402  (project file: array -> PNG)

USE_ALIGNED = {
    "Barnard's Star": "fill+bilinear",   # variant (c) from fix_blanks_test.py; display only
    "WISE 0855": False,
    "Epsilon Indi B": True,
    "RW Aurigae": True,
    "R Draconis": False,
}
# False            -> copy from backend/demo_cache, remove every target_xy key
# True             -> copy from backend/demo_cache_aligned as-is, keep target_xy
# "fill+bilinear"  -> copy PNGs from demo_cache_aligned BUT first, for each frame,
#                     reload the raw FITS array, replace up to 5 passes of NaN with
#                     the median of finite 5x5 neighbours, then reproject_interp
#                     (bilinear) and save as PNG. Then write frames.json with the
#                     same target_xy the aligned folder has. The variant is
#                     display-only: pixel values inside the star core are invented.
# Rule: aligned only when leftover ratio is low AND the star has no grey square.

CACHE_DIR = os.path.join(BACKEND, "cache")
ALIGNED_DIR = os.path.join(BACKEND, "demo_cache_aligned")
PLAIN_DIR = os.path.join(BACKEND, "demo_cache")
FINAL_DIR = os.path.join(BACKEND, "demo_cache_final")

N = 600  # PNG size, same as the rest of the project

# The star window that both tools look at, and the point where "no star here" starts.
WINDOW = 50
EMPTY_WINDOW_PX = (WINDOW * WINDOW) // 2   # 1250 of 2500 px: half the box has no data

FOVS = {
    "WISE 0855": 0.20,
    "Barnard's Star": 0.20,
    "Epsilon Indi B": 0.15,
    "RW Aurigae": 0.20,
    "R Draconis": 0.20,
}

SAID_NO_FITS_PATH = [False]  # the "no fits_path" note is printed only once


# ---------------------------------------------------------------------------
# Small file helpers
# ---------------------------------------------------------------------------
def folder_for(ra, dec, fov):
    """Folder name rule: 3 decimals for RA and Dec, 2 for the FOV."""
    return f"{ra:.3f}_{dec:.3f}_{fov:.2f}"


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def write_json(path, data):
    """Write UTF-8, LF line endings, plain ASCII."""
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, indent=2)
        f.write("\n")


def load_proper_motion_names():
    """Names that have an entry in proper_motion.json (these frames need target_xy)."""
    path = os.path.join(BACKEND, "proper_motion.json")
    if not os.path.exists(path):
        return set()
    return {entry["name"] for entry in load_json(path)}


def fits_paths_for(ra, dec, fov, frames, quiet=False):
    """FITS file for each frame index.

    frames.json holds only "filename", so the paths come from the download list
    saved by data_fetch.py. That list is in the same order as the frame numbers.
    """
    if all("fits_path" in frame for frame in frames):
        return [frame["fits_path"] for frame in frames]

    if not quiet and not SAID_NO_FITS_PATH[0]:
        print("note: frames.json has no fits_path, so the FITS paths come from")
        print("      cache/query_v2_%.4f_%.4f_%.4f_12.json" % (ra, dec, fov))
        SAID_NO_FITS_PATH[0] = True

    path = os.path.join(CACHE_DIR, "query_v2_%.4f_%.4f_%.4f_12.json" % (ra, dec, fov))
    if not os.path.exists(path):
        raise RuntimeError("not cached: " + path)
    return [item["fits_path"] for item in load_json(path)]


def frame_index(filename):
    """_07.png -> 7 (the number in the file name is the frame index)."""
    return int(filename.rsplit("_", 1)[1].split(".")[0])


# ---------------------------------------------------------------------------
# Reprojection pieces (copied from build_aligned_cache.py / fix_blanks_test.py)
# ---------------------------------------------------------------------------
def common_wcs(ra, dec, fov):
    """TAN projection, 600x600, pixel scale fov/600 degrees, north up, east left."""
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra, dec]
    w.wcs.crpix = [(N + 1) / 2, (N + 1) / 2]
    pixel_scale = fov / N
    w.wcs.cdelt = [-pixel_scale, pixel_scale]
    return w


def load_raw(path):
    """Raw FITS IMAGE array plus its own WCS."""
    with fits.open(path) as hdul:
        data = np.array(hdul["IMAGE"].data, dtype=np.float64)
        wcs_in = WCS(hdul["IMAGE"].header)
    return data, wcs_in


def fill_nans(data, max_passes=5):
    """Replace NaN pixels with the median of the finite pixels in their 5x5 box.

    Same five-pass rule as fix_blanks_test.py variant (c): stop as soon as no NaN
    is left, or a pass changes nothing.
    """
    array = data.copy()
    filled = 0
    for _ in range(max_passes):
        bad = ~np.isfinite(array)
        if not bad.any():
            break

        new = array.copy()
        changed = 0
        for r, c in zip(*np.where(bad)):
            r0, r1 = max(0, r - 2), min(array.shape[0], r + 3)
            c0, c1 = max(0, c - 2), min(array.shape[1], c + 3)
            block = array[r0:r1, c0:c1]
            good = block[np.isfinite(block)]
            if good.size:
                new[r, c] = float(np.median(good))
                changed += 1
        array = new
        filled += changed
        if changed == 0:
            break

    return array, filled, int((~np.isfinite(array)).sum())


def reproject_frame(data, wcs_in, wcs_out):
    """The bilinear reproject_interp call used by fix_blanks_test.py variant (c)."""
    array, _ = reproject_interp((data, wcs_in), wcs_out, shape_out=(N, N), order="bilinear")
    return array


# ---------------------------------------------------------------------------
# The 50x50 star window
# ---------------------------------------------------------------------------
def window_mask(xy, size=N):
    """A True/False map of the 50x50 box around a target_xy, in array (row, col) order.

    target_xy is written the way the PNG shows the star: x to the right, y counted
    from the top. array_to_png() flips the array (FITS row 0 is the bottom), so
    array row = size - 1 - y. check_final_cache.py imports this so both tools use
    exactly the same box.
    """
    rows, cols = np.mgrid[0:size, 0:size]
    py = (size - 1 - rows).astype(np.float64)
    x0 = int(round(xy[0])) - WINDOW // 2
    y0 = int(round(xy[1])) - WINDOW // 2
    return ((cols >= x0) & (cols < x0 + WINDOW) &
            (py >= y0) & (py < y0 + WINDOW))


def usable_xy(frame):
    """The frame's target_xy as a pair of numbers, or None when it has none."""
    xy = frame.get("target_xy")
    if isinstance(xy, list) and len(xy) == 2:
        return xy
    return None


def star_window_stat(array, xy):
    """Describe one reprojected frame: how empty the star window is, how much it covers.

    array is the frame on the shared 600x600 grid (NaN where there is no data).
    """
    finite = np.isfinite(array)
    empty_px = 0 if xy is None else int((window_mask(xy) & ~finite).sum())
    return {"empty_px": empty_px, "covered": float(finite.mean())}


# ---------------------------------------------------------------------------
# Validation of one finished folder
# ---------------------------------------------------------------------------
def validate(name, mode, final_folder, frames, source_count, proper_motion_names):
    """Return a list of problems; an empty list means the folder is good."""
    problems = []
    path = os.path.join(final_folder, "frames.json")
    with open(path, encoding="utf-8") as f:
        text = f.read()

    # (a) frames that came from demo_cache must not have target_xy anywhere
    if mode is False:
        for i, frame in enumerate(frames):
            if "target_xy" in frame:
                problems.append(f"frame {i} still has target_xy")
        if '"target_xy"' in text:
            problems.append('the written frames.json still contains "target_xy"')

    # (b) an aligned / fill frame that does have a target_xy must point inside the
    #     picture. Frames without one are allowed: the star is not covered by that
    #     frame's footprint, so the build removed the marker on purpose.
    if mode is True or mode == "fill+bilinear":
        if name in proper_motion_names:
            for i, frame in enumerate(frames):
                xy = frame.get("target_xy")
                if xy is None:
                    continue
                if not (isinstance(xy, list) and len(xy) == 2):
                    problems.append(f"frame {i} has an unusable target_xy")
                elif not (0 <= xy[0] <= 599 and 0 <= xy[1] <= 599):
                    problems.append(f"frame {i} target_xy {xy} is outside 0..599")

    # (c) every listed PNG must be there
    for i, frame in enumerate(frames):
        filename = frame.get("filename")
        if not filename or not os.path.isfile(os.path.join(final_folder, filename)):
            problems.append(f"frame {i} file is missing: {filename}")

    # (d) frames sorted by date
    dates = [frame.get("date") or "" for frame in frames]
    if dates != sorted(dates):
        problems.append("frames are not sorted by date")

    # (e) same number of frames as the source
    if len(frames) != source_count:
        problems.append(f"{len(frames)} frames written but the source has {source_count}")

    return problems


# ---------------------------------------------------------------------------
# Building one target
# ---------------------------------------------------------------------------
def build_target(name, ra, dec, fov, mode, proper_motion_names):
    folder = folder_for(ra, dec, fov)
    source_dir = PLAIN_DIR if mode is False else ALIGNED_DIR
    source_folder = os.path.join(source_dir, folder)
    source_json = os.path.join(source_folder, "frames.json")

    if not os.path.isfile(source_json):
        raise RuntimeError("source is missing: " + source_json)

    source_data = load_json(source_json)
    source_frames = source_data["frames"]
    final_folder = os.path.join(FINAL_DIR, folder)
    os.makedirs(final_folder, exist_ok=True)

    removed_lines = []

    if mode is False:
        # Copy the listed PNGs, then write frames.json minus every target_xy key.
        for frame in source_frames:
            shutil.copy2(os.path.join(source_folder, frame["filename"]),
                         os.path.join(final_folder, frame["filename"]))
        cleaned = dict(source_data)
        cleaned["frames"] = [
            {key: value for key, value in frame.items() if key != "target_xy"}
            for frame in source_frames
        ]
        write_json(os.path.join(final_folder, "frames.json"), cleaned)
    else:
        # Aligned / fill: every frame goes onto the shared 600x600 grid, so we can
        # look at the star window while we are at it.
        paths = fits_paths_for(ra, dec, fov, source_frames)
        wcs = common_wcs(ra, dec, fov)
        final_frames = []

        for frame in source_frames:
            index = frame_index(frame["filename"])
            raw, wcs_in = load_raw(paths[index])
            if mode == "fill+bilinear":
                raw, _, _ = fill_nans(raw)
            array = reproject_frame(raw, wcs_in, wcs)

            if mode == "fill+bilinear":
                # Rebuild the PNG from the filled array.
                array_to_png(array, os.path.join(final_folder, frame["filename"]), size=N)
            else:
                # Aligned source: the PNG on disk is already right, copy it.
                shutil.copy2(os.path.join(source_folder, frame["filename"]),
                             os.path.join(final_folder, frame["filename"]))

            new_frame = dict(frame)
            xy = usable_xy(new_frame)
            stat = star_window_stat(array, xy)
            if xy is not None and stat["empty_px"] >= EMPTY_WINDOW_PX:
                # No data at the star: keep the frame, drop the marker.
                del new_frame["target_xy"]
                empty_text = ("star window 100% empty" if stat["empty_px"] == WINDOW * WINDOW
                              else "star window mostly empty")
                removed_lines.append(
                    f"{name} frame {index:02d} ({frame.get('date')}): {empty_text} "
                    f"(covered {stat['covered'] * 100:.1f}%), "
                    f"target_xy removed from demo_cache_final"
                )
            final_frames.append(new_frame)

        if removed_lines:
            # frames.json changed, so write it out field by field.
            data = dict(source_data)
            data["frames"] = final_frames
            write_json(os.path.join(final_folder, "frames.json"), data)
        else:
            # Nothing removed: byte-for-byte copy, so the folder matches its source.
            shutil.copy2(source_json, os.path.join(final_folder, "frames.json"))

    # Validate what is actually on disk now.
    written = load_json(os.path.join(final_folder, "frames.json"))["frames"]
    problems = validate(name, mode, final_folder, written, len(source_frames), proper_motion_names)

    frames_with_xy = sum(
        1 for frame in written
        if isinstance(frame.get("target_xy"), list) and len(frame["target_xy"]) == 2
    )
    size_kb = sum(
        os.path.getsize(os.path.join(final_folder, name_in_folder))
        for name_in_folder in os.listdir(final_folder)
    ) / 1024.0

    return written, frames_with_xy, size_kb, problems, removed_lines


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    print("recreating backend/demo_cache_final")
    if os.path.isdir(FINAL_DIR):
        shutil.rmtree(FINAL_DIR)
    os.makedirs(FINAL_DIR)

    targets = load_json(os.path.join(BACKEND, "targets_verified.json"))
    proper_motion_names = load_proper_motion_names()

    header = (f"{'target':<18} | {'source':<16} | {'frames':>6} | "
              f"{'frames_with_xy':>21} | {'folder_size_kb':>14}")
    print(header)
    print("-" * len(header))

    source_map = []
    all_removed = []
    for target in targets:
        name = target["name"]
        if name not in FOVS:
            continue
        if name not in USE_ALIGNED:
            print(f"ERROR: {name}: no entry in USE_ALIGNED")
            return 1

        mode = USE_ALIGNED[name]
        source = "original" if mode is False else ("aligned" if mode is True else "aligned+fill")

        frames, frames_with_xy, size_kb, problems, removed = build_target(
            name, target["ra_deg"], target["dec_deg"], FOVS[name], mode, proper_motion_names
        )
        if problems:
            for problem in problems:
                print(f"ERROR: {name}: {problem}")
            return 1

        print(f"{name:<18} | {source:<16} | {len(frames):>6} | "
              f"{frames_with_xy:>21} | {size_kb:>14.1f}")
        source_map.append((name, source))
        all_removed.extend(removed)

    print()
    for line in all_removed:
        print(line)
    print(f"target_xy removed from {len(all_removed)} aligned frame(s)")

    total_png = 0
    for root, _dirs, files in os.walk(FINAL_DIR):
        for name_in_folder in files:
            if name_in_folder.lower().endswith(".png"):
                total_png += os.path.getsize(os.path.join(root, name_in_folder))

    total_mb = total_png / 1e6
    print()
    print(f"total PNG size: {total_mb:.2f} MB")
    if total_mb > 30:
        print("WARNING: the PNGs are over 30 MB, that is too big to hand over as-is")

    print()
    print("source map:")
    for name, source in source_map:
        print(f"  {name:<18} {source}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
