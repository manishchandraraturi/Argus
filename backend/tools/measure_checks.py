"""
measure_checks.py - measure how well the aligned frames line up, using local data only.

No network. It reads:
    backend/demo_cache_aligned/<folder>/frames.json   (target_xy + frame list)
    backend/cache/query_v2_<ra>_<dec>_<fov>_12.json   (where the FITS files are)
    backend/cache/fits/*.fits                         (the raw cutouts)
    backend/targets_verified.json                     (RA / Dec)

and it writes:
    backend/tools/measure_results.txt                 (the same text it prints)
    backend/tools/out/sidebyside_<target>.png         (original vs aligned difference)

Two questions are answered:

    PART A  Barnard's Star, frames 0 and 9: did the object really move by the
            amount we predicted? Compare the predicted pixel shift (from
            target_xy) with the shift measured from the difference image.

    PART B  For all 5 targets: are the aligned frames cleaner than the original
            ones (the "leftover" metric), and did reprojection create any blank
            holes in the middle of the picture?

Run from the repo root (Command Prompt):

    backend\\.venv\\Scripts\\python.exe backend\\tools\\measure_checks.py
"""

import json
import os
import sys
import warnings

import numpy as np
from PIL import Image, ImageDraw
from astropy.io import fits
from astropy.wcs import WCS
from reproject import reproject_interp
from scipy import ndimage

# astropy/reproject print harmless warnings about SIP and NaNs. Keep output clean.
warnings.simplefilter("ignore")

TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.dirname(TOOLS_DIR)
CACHE_DIR = os.path.join(BACKEND, "cache")
ALIGNED_DIR = os.path.join(BACKEND, "demo_cache_aligned")
OUT_DIR = os.path.join(TOOLS_DIR, "out")
RESULTS_PATH = os.path.join(TOOLS_DIR, "measure_results.txt")

N = 600  # PNG size, same as the rest of the project

# Field of view per target (degrees).
FOVS = {
    "WISE 0855": 0.20,
    "Barnard's Star": 0.20,
    "Epsilon Indi B": 0.15,
    "RW Aurigae": 0.20,
    "R Draconis": 0.20,
}

# The agreed blink pair per target (0-based, same number as _NN in the PNG name).
PAIRS = {
    "WISE 0855": (1, 6),
    "Barnard's Star": (0, 9),
    "Epsilon Indi B": (1, 9),
    "RW Aurigae": (1, 9),
    "R Draconis": (0, 11),
}

LINES = []          # everything we print is also kept here, so we can save it
SAID_NO_FITS_PATH = [False]  # small flag, so a note is printed only once


def log(text=""):
    """Print a line and remember it for measure_results.txt."""
    print(text)
    LINES.append(text)


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------
def folder_name(ra, dec, fov):
    """Folder name rule: 3 decimals for RA and Dec, 2 for the FOV."""
    return f"{ra:.3f}_{dec:.3f}_{fov:.2f}"


def load_targets():
    """Read targets_verified.json and keep the file order."""
    with open(os.path.join(BACKEND, "targets_verified.json"), encoding="utf-8") as f:
        return json.load(f)


def load_aligned_frames(ra, dec, fov):
    """The frames listed in demo_cache_aligned/<folder>/frames.json."""
    path = os.path.join(ALIGNED_DIR, folder_name(ra, dec, fov), "frames.json")
    with open(path, encoding="utf-8") as f:
        return json.load(f)["frames"]


def fits_paths(ra, dec, fov, aligned_frames):
    """FITS file for every frame index.

    frames.json normally stores only "filename", not the FITS path, so we read
    the path list that data_fetch.py saved when it downloaded these frames.
    That list is in the same order, so index N is the same frame N.
    """
    if all("fits_path" in frame for frame in aligned_frames):
        return [frame["fits_path"] for frame in aligned_frames]

    if not SAID_NO_FITS_PATH[0]:
        log("note: demo_cache_aligned frames.json has no fits_path, so the FITS")
        log("      paths come from cache/query_v2_*.json (the same files the")
        log("      aligned cache was built from).")
        log()
        SAID_NO_FITS_PATH[0] = True

    path = os.path.join(CACHE_DIR, "query_v2_%.4f_%.4f_%.4f_12.json" % (ra, dec, fov))
    if not os.path.exists(path):
        raise RuntimeError("not cached: %s" % path)
    with open(path, encoding="utf-8") as f:
        items = json.load(f)
    return [item["fits_path"] for item in items]


def common_wcs(ra, dec, fov):
    """The shared sky grid from build_aligned_cache.py (copied, not imported).

    TAN projection, 600x600, each pixel is fov/600 degrees, north up, east left.
    """
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra, dec]
    w.wcs.crpix = [(N + 1) / 2, (N + 1) / 2]
    pixel_scale = fov / N
    w.wcs.cdelt = [-pixel_scale, pixel_scale]
    return w


def aligned(fits_path, wcs_out):
    """Reproject one FITS IMAGE onto the shared grid. NaN outside the footprint."""
    with fits.open(fits_path) as hdul:
        data = np.array(hdul["IMAGE"].data, dtype=np.float64)
        wcs_in = WCS(hdul["IMAGE"].header)
    array, _ = reproject_interp((data, wcs_in), wcs_out, shape_out=(N, N))
    return array


def native(fits_path):
    """The raw FITS IMAGE as a plain 2D float array (a small patch, about 117x117)."""
    with fits.open(fits_path) as hdul:
        return np.array(hdul["IMAGE"].data, dtype=np.float64)


def native_600(data):
    """Raw patch -> 600x600 for comparing with the aligned version.

    Missing pixels become 0 (as the brief says), then a bicubic resize.
    """
    clean = np.where(np.isfinite(data), data, 0.0)
    img = Image.fromarray(clean.astype(np.float32))
    return np.array(img.resize((N, N), Image.Resampling.BICUBIC), dtype=np.float64)


def arcsec_per_pixel(fov):
    """One pixel covers fov/600 degrees, and 1 degree is 3600 arcseconds."""
    return fov * 3600.0 / N


def describe_shift(dx, dy, fov):
    """Turn a pixel shift into pixels, arcseconds and a compass direction.

    In the PNG, x grows to the right and y grows downward. Because the grid has
    north up and east left: east = -dx, north = -dy.
    The angle is measured from north, turning towards east.
    """
    east = -dx
    north = -dy
    magnitude = float(np.hypot(dx, dy))
    angle = float(np.degrees(np.arctan2(east, north)) % 360.0)

    if magnitude < 1e-9:
        compass = "no move"
    else:
        names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
        compass = names[int(((angle + 22.5) % 360.0) // 45)]

    return {
        "dx": float(dx),
        "dy": float(dy),
        "east": float(east),
        "north": float(north),
        "mag_px": magnitude,
        "mag_arcsec": magnitude * arcsec_per_pixel(fov),
        "angle": angle,
        "compass": compass,
    }


def angle_gap(a, b):
    """Smallest angle between two directions, in degrees (0..180)."""
    diff = abs(a - b) % 360.0
    return min(diff, 360.0 - diff)


def leftover(a, b):
    """Share of bright-star signal left over in |b - a|. Lower is better.

    Copied exactly from the brief (align_check.py uses the same formula).
    """
    a = a - np.nanmedian(a)
    b = b - np.nanmedian(b)
    m = (a + b) / 2
    ok = np.isfinite(a) & np.isfinite(b)
    sel = ok & (m >= np.percentile(m[ok], 99))
    return float(np.sum(np.abs(b - a)[sel]) / np.sum(np.abs(m[sel])))


def raw_blank_stats(data):
    """Non-finite pixels and blobs of 2 px or more in a raw FITS array."""
    bad = ~np.isfinite(data)
    labels, count = ndimage.label(bad)
    sizes = np.bincount(labels.ravel())[1:] if count else np.array([])
    return int(bad.sum()), int((sizes >= 2).sum())


def aligned_blank_stats(array):
    """Non-finite pixels and big blobs inside rows and cols 100..499 of a 600x600 array.

    Centre is reported in PNG coordinates: x is the column, y is 599 - row.
    """
    bad = ~np.isfinite(array)
    core = bad[100:500, 100:500]
    labels, count = ndimage.label(core)
    big = []
    for index in range(1, count + 1):
        rows, cols = np.where(labels == index)
        if len(rows) >= 25:
            big.append((int(len(rows)), round(float(cols.mean()), 1), round(float(N - 1 - rows.mean()), 1)))
    return int(core.sum()), big


def difference_png(array):
    """Turn a signed difference into an 8-bit picture, mid-grey means zero."""
    return np.nan_to_num(array, nan=0.0, posinf=0.0, neginf=0.0)


# ---------------------------------------------------------------------------
# PART A: does the measured shift match the predicted shift?
# ---------------------------------------------------------------------------
def part_a(targets, log):
    log("=" * 78)
    log("PART A - Barnard's Star, frames 0 and 9 (predicted vs measured shift)")
    log("=" * 78)

    target = next(t for t in targets if t["name"] == "Barnard's Star")
    name, ra, dec = target["name"], target["ra_deg"], target["dec_deg"]
    fov = FOVS[name]
    index_a, index_b = PAIRS[name]

    frames = load_aligned_frames(ra, dec, fov)
    paths = fits_paths(ra, dec, fov, frames)
    wcs = common_wcs(ra, dec, fov)

    # 1. the two frames, on the shared grid
    frame_a = aligned(paths[index_a], wcs)
    frame_b = aligned(paths[index_b], wcs)
    log(f"frames {index_a} ({frames[index_a]['date']}) and {index_b} ({frames[index_b]['date']}), "
        f"FOV {fov:.2f} deg, {arcsec_per_pixel(fov):.2f} arcsec per pixel")

    # 2. predicted shift from target_xy
    xy_a = frames[index_a]["target_xy"]
    xy_b = frames[index_b]["target_xy"]
    predicted = describe_shift(xy_b[0] - xy_a[0], xy_b[1] - xy_a[1], fov)
    log(f"PREDICTED from target_xy: {xy_a} -> {xy_b}")
    log(f"  dx {predicted['dx']:+.2f} px (x right = west), dy {predicted['dy']:+.2f} px (y down = south)")
    log(f"  length {predicted['mag_px']:.2f} px = {predicted['mag_arcsec']:.2f} arcsec, "
        f"direction {predicted['compass']} ({predicted['angle']:.1f} deg from north towards east)")

    # 3. measured shift from the difference image
    diff = frame_b - frame_a
    finite = np.isfinite(diff)
    sigma = 1.4826 * np.median(np.abs(diff[finite] - np.median(diff[finite])))

    # pixel coordinates as they appear in the PNG: x = column, y = 599 - row
    rows, cols = np.mgrid[0:N, 0:N]
    x_img = cols.astype(np.float64)
    y_img = (N - 1 - rows).astype(np.float64)

    mid_x = (xy_a[0] + xy_b[0]) / 2.0
    mid_y = (xy_a[1] + xy_b[1]) / 2.0
    near_mid = np.hypot(x_img - mid_x, y_img - mid_y) <= 25.0

    positive = finite & near_mid & (diff > 5.0 * sigma)
    negative = finite & near_mid & (diff < -5.0 * sigma)

    log(f"MEASURED from the difference image (sigma {sigma:.4g}, threshold 5 sigma = {5.0 * sigma:.4g}):")
    log(f"  window: pixels within 25 px of the midpoint ({mid_x:.1f}, {mid_y:.1f})")
    log(f"  positive lobe {int(positive.sum())} px, negative lobe {int(negative.sum())} px, "
        f"non-finite pixels inside the window {int((~finite & near_mid).sum())}")

    if positive.sum() < 3 or negative.sum() < 3:
        log("  no clear pair (fewer than 3 pixels in one of the lobes)")
        log()
        return

    def centroid(mask):
        weights = np.abs(diff[mask])
        total = weights.sum()
        return float((x_img[mask] * weights).sum() / total), float((y_img[mask] * weights).sum() / total)

    pos_x, pos_y = centroid(positive)
    neg_x, neg_y = centroid(negative)
    # The object is brighter in frame B (positive lobe, at its new position) and
    # darker there in frame A (negative lobe, at its old position), so
    # positive minus negative is "where it went", the same as target_xy.
    measured = describe_shift(pos_x - neg_x, pos_y - neg_y, fov)

    log(f"  positive centroid ({pos_x:.2f}, {pos_y:.2f}), negative centroid ({neg_x:.2f}, {neg_y:.2f})")
    log(f"  dx {measured['dx']:+.2f} px, dy {measured['dy']:+.2f} px, "
        f"length {measured['mag_px']:.2f} px = {measured['mag_arcsec']:.2f} arcsec, "
        f"direction {measured['compass']} ({measured['angle']:.1f} deg)")

    # 4. residual
    residual_dx = measured["dx"] - predicted["dx"]
    residual_dy = measured["dy"] - predicted["dy"]
    residual = float(np.hypot(residual_dx, residual_dy))
    gap = angle_gap(measured["angle"], predicted["angle"])
    match = residual < 0.5 and gap < 20.0

    log(f"(measured - predicted) = ({residual_dx:+.2f}, {residual_dy:+.2f}) px, length {residual:.2f} px")
    log(f"direction difference {gap:.1f} deg")
    log("MATCH" if match else "NO MATCH")
    log(f"  rule: length < 0.5 px ({residual:.2f}) and direction difference < 20 deg ({gap:.1f})")
    log()


# ---------------------------------------------------------------------------
# PART B: leftover metric and blank holes for all 5 targets
# ---------------------------------------------------------------------------
def part_b(targets, log):
    log("=" * 78)
    log("PART B - leftover metric and blank holes, all 5 targets")
    log("=" * 78)

    os.makedirs(OUT_DIR, exist_ok=True)
    rows = []
    saved_pngs = []

    for target in targets:
        name, ra, dec = target["name"], target["ra_deg"], target["dec_deg"]
        if name not in FOVS:
            continue
        fov = FOVS[name]
        index_a, index_b = PAIRS[name]
        safe = name.replace(" ", "_").replace("'", "")

        frames = load_aligned_frames(ra, dec, fov)
        paths = fits_paths(ra, dec, fov, frames)
        wcs = common_wcs(ra, dec, fov)

        raw_a = native(paths[index_a])
        raw_b = native(paths[index_b])
        aligned_a = aligned(paths[index_a], wcs)
        aligned_b = aligned(paths[index_b], wcs)

        diff_original = native_600(raw_b) - native_600(raw_a)
        diff_aligned = aligned_b - aligned_a

        left_original = leftover(native_600(raw_a), native_600(raw_b))
        left_aligned = leftover(aligned_a, aligned_b)
        ratio = left_aligned / left_original if left_original else float("inf")

        log(f"[{name}] FOV {fov:.2f}, pair {index_a}/{index_b} "
            f"({frames[index_a]['date']} vs {frames[index_b]['date']}, "
            f"{len(frames)} frames)")

        # 2. the metric
        log(f"  leftover: original {left_original:.3f}, aligned {left_aligned:.3f}, "
            f"ratio {ratio:.3f}")

        # 3. blanks in the raw cutouts
        raw_a_px, raw_a_blobs = raw_blank_stats(raw_a)
        raw_b_px, raw_b_blobs = raw_blank_stats(raw_b)
        log(f"  raw FITS blanks: frame {index_a} {raw_a_px} px in {raw_a_blobs} blob(s) >=2 px, "
            f"frame {index_b} {raw_b_px} px in {raw_b_blobs} blob(s) >=2 px")

        # 3b. blanks after reprojection, middle of the picture only
        core_a_px, core_a_blobs = aligned_blank_stats(aligned_a)
        core_b_px, core_b_blobs = aligned_blank_stats(aligned_b)
        log(f"  aligned blanks in rows/cols 100..499: frame {index_a} {core_a_px} px, "
            f"{len(core_a_blobs)} blob(s) >=25 px {core_a_blobs}")
        log(f"                                        frame {index_b} {core_b_px} px, "
            f"{len(core_b_blobs)} blob(s) >=25 px {core_b_blobs}")

        # 4. summary
        cleaner = "YES" if ratio <= 0.75 else "NO"
        has_core_blob = bool(core_a_blobs or core_b_blobs)
        blanked_core = "YES" if has_core_blob else "NO"
        raw_has_blanks = bool(raw_a_px or raw_b_px)

        if has_core_blob and raw_has_blanks:
            blanks_from = "raw"
        elif has_core_blob:
            blanks_from = "reprojection"
        else:
            blanks_from = "none"
        log(f"  cleaner {cleaner}, blanked_core {blanked_core}, blanks_from {blanks_from}")
        log()

        rows.append({
            "name": name,
            "original": left_original,
            "aligned": left_aligned,
            "ratio": ratio,
            "cleaner": cleaner,
            "blanked_core": blanked_core,
            "blanks_from": blanks_from,
        })

        # 5. side-by-side picture: original difference on the left, aligned on the right
        both = np.concatenate([np.abs(diff_original[np.isfinite(diff_original)]),
                               np.abs(diff_aligned[np.isfinite(diff_aligned)])])
        scale = float(np.percentile(both, 99.5)) if both.size else 1.0
        if not np.isfinite(scale) or scale == 0:
            scale = 1.0

        def panel(array):
            d = difference_png(array)
            return np.uint8(np.round(255 * (0.5 + 0.5 * np.clip(d / scale, -1, 1))))

        canvas = Image.new("L", (2 * N, N), 0)
        canvas.paste(Image.fromarray(panel(diff_original)), (0, 0))
        canvas.paste(Image.fromarray(panel(diff_aligned)), (N, 0))
        draw = ImageDraw.Draw(canvas)
        for x0, label in ((0, "original"), (N, "aligned")):
            draw.text((x0 + 9, 9), label, fill=0)      # dark shadow
            draw.text((x0 + 8, 8), label, fill=255)    # white text
        out_path = os.path.join(OUT_DIR, f"sidebyside_{safe}.png")
        canvas.save(out_path)
        saved_pngs.append(out_path)
        log(f"  saved {out_path} (shared scale {scale:.4g}, mid-grey = 0)")
        log()

    return rows, saved_pngs


# ---------------------------------------------------------------------------
# The table, the suggestion, and the results file
# ---------------------------------------------------------------------------
def print_table(rows, log):
    log("=" * 78)
    log("SUMMARY")
    log("=" * 78)
    header = "target             | original | aligned | ratio | cleaner | blanked_core | blanks_from"
    log(header)
    log("-" * len(header))
    for row in rows:
        log(f"{row['name']:<18} | {row['original']:>8.3f} | {row['aligned']:>7.3f} | "
            f"{row['ratio']:>5.3f} | {row['cleaner']:<7} | {row['blanked_core']:<12} | {row['blanks_from']}")
    log()


def print_use_aligned(rows, log):
    """Manish's rule: use aligned only if it is cleaner AND has no blank core."""
    log("SUGGESTED USE_ALIGNED (aligned only when cleaner YES and blanked_core NO):")
    log("USE_ALIGNED = {")
    for row in rows:
        use = row["cleaner"] == "YES" and row["blanked_core"] == "NO"
        log(f'    "{row["name"]}": {use},')
    log("}")
    log()


def main():
    if not os.path.isdir(OUT_DIR):
        os.makedirs(OUT_DIR, exist_ok=True)

    log("measure_checks.py - read-only measurements on the local frames")
    log(f"backend folder: {BACKEND}")
    log()

    targets = load_targets()
    part_a(targets, log)
    rows, saved_pngs = part_b(targets, log)
    print_table(rows, log)
    print_use_aligned(rows, log)

    log("side-by-side images:")
    for path in saved_pngs:
        log("  " + path)
    log()
    log(f"results written to {RESULTS_PATH}")

    with open(RESULTS_PATH, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(LINES) + "\n")

    return 0


if __name__ == "__main__":
    sys.exit(main())
