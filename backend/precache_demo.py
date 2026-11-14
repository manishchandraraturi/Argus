import contextlib
import io
import json
import os
import time

from convert import fits_to_png
from data_fetch import fetch_cutouts, DataFetchError

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "demo_cache")

# FOV in degrees, agreed with Manish
FOVS = {
    "WISE 0855": 0.20,
    "Barnard's Star": 0.20,
    "Epsilon Indi B": 0.15,
    "RW Aurigae": 0.20,
    "R Draconis": 0.20,
}

with open(os.path.join(HERE, "targets_verified.json"), encoding="utf-8") as f:
    targets = json.load(f)

total_bytes = 0
for t in targets:
    name, ra, dec = t["name"], t["ra_deg"], t["dec_deg"]
    fov = FOVS.get(name, 0.20)
    folder = f"{ra:.3f}_{dec:.3f}_{fov:.2f}"
    folder_path = os.path.join(OUT_DIR, folder)
    print(f"[{name}] folder {folder} ...", flush=True)
    start = time.time()
    try:
        cutouts = fetch_cutouts(ra, dec, fov)
    except DataFetchError as err:
        print(f"[{name}] FAILED: {err}", flush=True)
        continue
    if not cutouts:
        print(f"[{name}] no images cover this spot", flush=True)
        continue

    os.makedirs(folder_path, exist_ok=True)
    frames = []
    for i, c in enumerate(cutouts):
        filename = f"{folder}_{i:02d}.png"
        png_path = os.path.join(folder_path, filename)
        try:
            with contextlib.redirect_stdout(io.StringIO()):  # hides convert.py's chatter
                fits_to_png(c["fits_path"], png_path, size=600)
        except Exception as err:
            print(f"  frame {i} skipped: {err}", flush=True)
            continue
        total_bytes += os.path.getsize(png_path)
        frames.append({
            "date": c["date"],
            "filename": filename,
            "detector": c["detector"],
            "wavelength_um": c["wavelength_um"],
            "flags": c["flags"] or "",
        })

    with open(os.path.join(folder_path, "frames.json"), "w", encoding="utf-8") as f:
        json.dump({"frames": frames, "mock": False, "target": name}, f, indent=2)
    print(f"[{name}] {len(frames)} frames saved [{round(time.time() - start, 1)}s]", flush=True)

print(f"Done. PNG total: {round(total_bytes / 1e6, 1)} MB in {OUT_DIR}")