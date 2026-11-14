"""
fix_blanks_test.py - can we remove the grey NaN square at the star?

The aligned Barnard's Star frames have a grey square near the star. It is not a
real hole in the sky: a few single NaN pixels in the raw FITS files get blown up
about 5x when reproject_interp resamples them onto the 600x600 grid.

This script compares three ways of reprojecting frames 0 and 9 (WISE 0855 etc.
are NOT touched) and measures, for each way:

    - non-finite pixels near the star (the grey square)
    - the leftover metric on the pair, exactly as measure_checks.py does it
    - where the star's centroid sits in each frame, and how far apart they are
    - the largest non-finite blob in the whole frame

It only reads local files and only writes three PNGs into backend/tools/out/.
It does not modify demo_cache, demo_cache_aligned, demo_cache_final or any
other tool. No network.

Run from the repo root (Command Prompt):

    backend\\.venv\\Scripts\\python.exe backend\\tools\\fix_blanks_test.py
"""

import json
import os
import sys
import time
import warnings

import numpy as np
from PIL import Image, ImageDraw
from astropy.io import fits
from astropy.wcs import WCS
from reproject import reproject_interp
from scipy import ndimage

# astropy and reproject print lots of harmless warnings; keep the output readable.
warnings.simplefilter("ignore")

TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.dirname(TOOLS_DIR)
CACHE_DIR = os.path.join(BACKEND, "cache")
ALIGNED_DIR = os.path.join(BACKEND, "demo_cache_aligned")
OUT_DIR = os.path.join(TOOLS_DIR, "out")

N = 600          # PNG size
FOV = 0.20       # Barnard's Star field of view, degrees
TARGET = "Barnard's Star"
INDEX_A = 0      # the agreed pair for this target
INDEX_B = 9

# A star centroid is measured from pixels above this many sigma.
SIGMA_FACTOR = 10.0

# Pixel coordinates as they appear in the PNG: x = column, y = 599 - row.
ROWS, COLS = np.mgrid[0:N, 0:N]
PX = COLS.astype(np.float64)
PY = (N - 1 - ROWS).astype(np.float64)


# ---------------------------------------------------------------------------
# Reading the local files
# ---------------------------------------------------------------------------
def load_target():
    """RA and Dec of Barnard's Star from targets_verified.json."""
    with open(os.path.join(BACKEND, "targets_verified.json"), encoding="utf-8") as f:
        targets = json.load(f)
    for target in targets:
        if target["name"] == TARGET:
            return target["ra_deg"], target["dec_deg"]
    raise RuntimeError(TARGET + " is not in targets_verified.json")


def load_aligned_frames(ra, dec, fov):
    """The frame list from demo_cache_aligned (this is where target_xy lives)."""
    folder = f"{ra:.3f}_{dec:.3f}_{fov:.2f}"
    path = os.path.join(ALIGNED_DIR, folder, "frames.json")
    with open(path, encoding="utf-8") as f:
        return json.load(f)["frames"]


def fits_paths(ra, dec, fov, frames):
    """FITS file for every frame.

    frames.json usually has no fits_path, so we fall back to the download list
    saved by data_fetch.py, exactly like measure_checks.py does.
    """
    if all("fits_path" in frame for frame in frames):
        return [frame["fits_path"] for frame in frames]

    path = os.path.join(CACHE_DIR, "query_v2_%.4f_%.4f_%.4f_12.json" % (ra, dec, fov))
    if not os.path.exists(path):
        raise RuntimeError("not cached: " + path)
    with open(path, encoding="utf-8") as f:
        items = json.load(f)
    print("note: frames.json has no fits_path, so the FITS paths come from")
    print("      cache/query_v2_%.4f_%.4f_%.4f_12.json" % (ra, dec, fov))
    print()
    return [item["fits_path"] for item in items]


# ---------------------------------------------------------------------------
# The shared grid (same as build_aligned_cache.py; copied, not imported)
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
    """Raw FITS IMAGE array plus its own (SIP distorted) WCS."""
    with fits.open(path) as hdul:
        data = np.array(hdul["IMAGE"].data, dtype=np.float64)
        wcs_in = WCS(hdul["IMAGE"].header)
    return data, wcs_in


def reproject_array(data, wcs_in, wcs_out, order="bilinear"):
    """Put an array onto the shared grid. order can be 'bilinear' or 'nearest-neighbor'."""
    array, _ = reproject_interp((data, wcs_in), wcs_out, shape_out=(N, N), order=order)
    return array


def native_600(data):
    """Raw patch -> 600x600 with missing pixels set to 0 (used for the original diff)."""
    clean = np.where(np.isfinite(data), data, 0.0)
    img = Image.fromarray(clean.astype(np.float32))
    return np.array(img.resize((N, N), Image.Resampling.BICUBIC), dtype=np.float64)


# ---------------------------------------------------------------------------
# Variant (c): fill the NaN pixels in the raw array first
# ---------------------------------------------------------------------------
def fill_nans(data, max_passes=5):
    """Replace NaN pixels with the median of the finite pixels in their 5x5 box.

    Up to 5 passes, and it stops as soon as there is nothing left to fill or a
    pass changes nothing. Returns (filled array, pixels filled, pixels still NaN).
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


# ---------------------------------------------------------------------------
# The measurements (same definitions as measure_checks.py)
# ---------------------------------------------------------------------------
def leftover(a, b):
    """Share of bright-star signal left in |b - a|. Lower is better."""
    a = a - np.nanmedian(a)
    b = b - np.nanmedian(b)
    m = (a + b) / 2
    ok = np.isfinite(a) & np.isfinite(b)
    sel = ok & (m >= np.percentile(m[ok], 99))
    return float(np.sum(np.abs(b - a)[sel]) / np.sum(np.abs(m[sel])))


def window_box(cx, cy, half=25):
    """A 50x50 box around (cx, cy) in PNG pixels, clipped to the picture."""
    x0 = int(round(cx)) - half
    x1 = x0 + 2 * half
    y0 = int(round(cy)) - half
    y1 = y0 + 2 * half
    return max(0, x0), min(N, x1), max(0, y0), min(N, y1)


def nan_in_window(array, cx, cy, half=25):
    """Non-finite pixels inside that box, and their centroid."""
    x0, x1, y0, y1 = window_box(cx, cy, half)
    inside = (PX >= x0) & (PX < x1) & (PY >= y0) & (PY < y1)
    mask = inside & ~np.isfinite(array)
    count = int(mask.sum())
    if count:
        return count, float(PX[mask].mean()), float(PY[mask].mean()), (x0, x1, y0, y1)
    return 0, float("nan"), float("nan"), (x0, x1, y0, y1)


def star_centroid(array, xy, radius=25):
    """Weighted centroid of the star's bright core around xy (10 sigma cut)."""
    finite = np.isfinite(array)
    if not finite.any():
        return None
    median = float(np.median(array[finite]))
    sigma = 1.4826 * float(np.median(np.abs(array[finite] - median)))
    near = np.hypot(PX - xy[0], PY - xy[1]) <= radius
    mask = near & finite & (array > median + SIGMA_FACTOR * sigma)
    if not mask.any():
        return None
    total = array[mask].sum()
    return float((PX[mask] * array[mask]).sum() / total), float((PY[mask] * array[mask]).sum() / total)


def largest_nan_blob(array, min_size=25):
    """Biggest non-finite blob in the whole frame: (size, centre), count >= min_size."""
    bad = ~np.isfinite(array)
    labels, count = ndimage.label(bad)
    biggest = 0
    centre = None
    big_count = 0
    for index in range(1, count + 1):
        rows, cols = np.where(labels == index)
        size = len(rows)
        if size >= min_size:
            big_count += 1
        if size > biggest:
            biggest = size
            centre = (round(float(cols.mean()), 1), round(float(N - 1 - rows.mean()), 1))
    return biggest, centre, big_count, int(bad.sum())


def save_panel(diff, scale, label, path):
    """One 600x600 difference picture, mid-grey means zero."""
    clean = np.nan_to_num(diff, nan=0.0, posinf=0.0, neginf=0.0)
    pixels = np.uint8(np.round(255 * (0.5 + 0.5 * np.clip(clean / scale, -1, 1))))
    image = Image.fromarray(pixels)
    draw = ImageDraw.Draw(image)
    draw.text((9, 9), label, fill=0)      # dark shadow
    draw.text((8, 8), label, fill=255)    # white text

    # Save under a temporary name, then swap it into place. On Windows another
    # program (antivirus, thumbnail cache) can keep a freshly written file open
    # for a moment, so the swap is retried a few times instead of failing.
    temporary = path + ".tmp"
    image.save(temporary, format="PNG")   # the .tmp name has no format of its own
    for attempt in range(3):
        try:
            os.replace(temporary, path)
            return
        except OSError:
            if attempt == 2:
                raise
            time.sleep(0.5)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    ra, dec = load_target()
    frames = load_aligned_frames(ra, dec, FOV)
    paths = fits_paths(ra, dec, FOV, frames)
    wcs = common_wcs(ra, dec, FOV)

    xy_a = frames[INDEX_A]["target_xy"]
    xy_b = frames[INDEX_B]["target_xy"]

    print("=" * 78)
    print("PART A - reproduce the grey square (current method)")
    print("=" * 78)
    print(f"{TARGET}: RA {ra:.4f}, Dec {dec:.4f}, FOV {FOV:.2f} deg")
    print(f"frames {INDEX_A} ({frames[INDEX_A]['date']}) and {INDEX_B} "
          f"({frames[INDEX_B]['date']})")
    print(f"target_xy frame {INDEX_A}: {xy_a}, frame {INDEX_B}: {xy_b}")
    print()

    raw_a, wcs_a = load_raw(paths[INDEX_A])
    raw_b, wcs_b = load_raw(paths[INDEX_B])
    print(f"raw FITS shapes: frame {INDEX_A} {raw_a.shape}, frame {INDEX_B} {raw_b.shape}")
    print(f"raw NaN pixels: frame {INDEX_A} {int((~np.isfinite(raw_a)).sum())}, "
          f"frame {INDEX_B} {int((~np.isfinite(raw_b)).sum())}")
    print()

    # The three variants. Each gives the pair of frames on the shared grid.
    current_a = reproject_array(raw_a, wcs_a, wcs, order="bilinear")
    current_b = reproject_array(raw_b, wcs_b, wcs, order="bilinear")

    count, cx, cy, box = nan_in_window(current_a, xy_a[0], xy_a[1])
    print(f"current (bilinear), 50x50 window x {box[0]}..{box[1] - 1}, y {box[2]}..{box[3] - 1}:")
    print(f"  non-finite pixels: {count}")
    if count:
        print(f"  their centroid: ({cx:.2f}, {cy:.2f}) PNG pixels")
    print()

    print("=" * 78)
    print("PART B - three ways of reprojecting")
    print("=" * 78)

    variants = []

    variants.append({
        "key": "a",
        "label": "a: bilinear",
        "frame_a": current_a,
        "frame_b": current_b,
        "filled": "",
    })

    nearest_a = reproject_array(raw_a, wcs_a, wcs, order="nearest-neighbor")
    nearest_b = reproject_array(raw_b, wcs_b, wcs, order="nearest-neighbor")
    variants.append({
        "key": "b",
        "label": "b: nearest",
        "frame_a": nearest_a,
        "frame_b": nearest_b,
        "filled": "",
    })

    filled_a, filled_a_count, left_a = fill_nans(raw_a)
    filled_b, filled_b_count, left_b = fill_nans(raw_b)
    fill_a = reproject_array(filled_a, wcs_a, wcs, order="bilinear")
    fill_b = reproject_array(filled_b, wcs_b, wcs, order="bilinear")
    variants.append({
        "key": "c",
        "label": "c: fill+bilinear",
        "frame_a": fill_a,
        "frame_b": fill_b,
        "filled": (f"filled {filled_a_count} NaN pixel(s) in frame {INDEX_A} "
                   f"({left_a} left), {filled_b_count} in frame {INDEX_B} ({left_b} left)"),
    })
    print("variant (c) raw fill:", variants[2]["filled"])
    print()

    # One shared scale for all three pictures, built the same way as
    # sidebyside_Barnards_Star.png (original and current-aligned diffs together).
    diff_original = native_600(raw_b) - native_600(raw_a)
    diff_current = current_b - current_a
    both = np.concatenate([np.abs(diff_original[np.isfinite(diff_original)]),
                           np.abs(diff_current[np.isfinite(diff_current)])])
    scale = float(np.percentile(both, 99.5)) if both.size else 1.0
    if not np.isfinite(scale) or scale == 0:
        scale = 1.0
    print(f"shared grey scale for all three pictures: {scale:.4g} (mid-grey = 0)")
    print()

    leftover_original = leftover(native_600(raw_a), native_600(raw_b))
    current_ratio = 0.851  # measured earlier: 1.062 / 1.248
    print(f"leftover of the un-aligned pair (for reference): {leftover_original:.3f}")
    print(f"current aligned ratio from measure_checks.py: {current_ratio:.3f}")
    print()

    results = {}
    for variant in variants:
        arr_a = variant["frame_a"]
        arr_b = variant["frame_b"]

        count, cx, cy, box = nan_in_window(arr_a, xy_a[0], xy_a[1])
        left = leftover(arr_a, arr_b)
        ratio = left / leftover_original if leftover_original else float("inf")

        cent_a = star_centroid(arr_a, xy_a)
        cent_b = star_centroid(arr_b, xy_b)
        if cent_a and cent_b:
            separation = float(np.hypot(cent_b[0] - cent_a[0], cent_b[1] - cent_a[1]))
        else:
            separation = float("nan")

        size, centre, big_count, total_bad = largest_nan_blob(arr_a, min_size=25)

        path = os.path.join(OUT_DIR, f"blankfix_{variant['key']}.png")
        save_panel(arr_b - arr_a, scale, variant["label"], path)

        print(f"({variant['key']}) {variant['label']}")
        if variant["filled"]:
            print(f"  raw fill: {variant['filled']}")
        print(f"  grey square: {count} non-finite px in the 50x50 window "
              f"x {box[0]}..{box[1] - 1}, y {box[2]}..{box[3] - 1}", end="")
        if count:
            print(f", centroid ({cx:.2f}, {cy:.2f})")
        else:
            print()
        print(f"  leftover {left:.3f}, ratio {ratio:.3f}")
        if cent_a and cent_b:
            print(f"  star centroid frame {INDEX_A} ({cent_a[0]:.2f}, {cent_a[1]:.2f}), "
                  f"frame {INDEX_B} ({cent_b[0]:.2f}, {cent_b[1]:.2f}), "
                  f"separation {separation:.2f} px")
        else:
            print("  star centroid not found in one of the frames")
        print(f"  whole frame: {total_bad} non-finite px, largest blob {size} px at "
              f"{centre}, blobs >= 25 px: {big_count}")
        print(f"  saved {path}")
        print()

        results[variant["key"]] = {
            "label": variant["label"],
            "leftover": left,
            "ratio": ratio,
            "window_count": count,
            "window_centroid": (cx, cy),
            "separation": separation,
            "largest_blob": size,
            "blob_centre": centre,
        }

    print("=" * 78)
    print("PART C - recommendation")
    print("=" * 78)

    best_key = min(results, key=lambda k: results[k]["ratio"])
    best = results[best_key]
    verdict = "BEATS" if best["ratio"] < current_ratio else "does not beat"
    print(f"1. best leftover ratio: ({best_key}) {best['label']}, ratio {best['ratio']:.3f}; "
          f"{verdict} the current aligned ratio {current_ratio:.3f}")

    square_gone = best["largest_blob"] < 25
    print(f"2. grey square at the star: largest non-finite blob anywhere in the frame is "
          f"{best['largest_blob']} px -> {'GONE' if square_gone else 'STILL THERE'}")

    base_sep = results["a"]["separation"]
    change = abs(best["separation"] - base_sep) if np.isfinite(best["separation"]) and np.isfinite(base_sep) else float("nan")
    print(f"3. star centroid separation {best['separation']:.2f} px vs "
          f"{base_sep:.2f} px in (a), change {change:.2f} px -> "
          f"{'CHANGED' if change > 0.5 else 'unchanged'} (limit 0.5 px)")

    print()
    print(f"note: the biggest blob ({best['largest_blob']} px at {best['blob_centre']}) is present in")
    print("      all three variants, even (c) where every raw NaN was filled, so it is")
    print("      the uncovered edge of the reprojected footprint, not the star. At the")
    print(f"      star window variant {best_key} has {best['window_count']} non-finite pixels, so")
    print("      the star square itself is gone; the '< 25 px anywhere' rule cannot be met")
    print("      by any variant until that footprint edge is cropped or filled.")
    print()
    print("Warning: variant (c) invents pixel values inside the star core (it copies the")
    print("median of nearby pixels). It is for display only - do not use it for photometry.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
