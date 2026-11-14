import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
DEMO = os.path.join(HERE, "demo_cache")

# Same FOVs as precache_demo.py and the frontend
FOVS = {
    "WISE 0855": 0.20,
    "Barnard's Star": 0.20,
    "Epsilon Indi B": 0.15,
    "RW Aurigae": 0.20,
    "R Draconis": 0.20,
}

with open(os.path.join(HERE, "targets_verified.json"), encoding="utf-8") as f:
    targets = json.load(f)

lines = ["Cache-only check of backend/demo_cache (no network)."]
for t in targets:
    name, ra, dec = t["name"], t["ra_deg"], t["dec_deg"]
    fov = FOVS[name]
    folder = f"{ra:.3f}_{dec:.3f}_{fov:.2f}"
    path = os.path.join(DEMO, folder, "frames.json")
    if not os.path.exists(path):
        lines.append(f"{name}: MISSING {folder}/frames.json")
        continue
    with open(path, encoding="utf-8") as f:
        frames = json.load(f)["frames"]

    problems = []
    for i, fr in enumerate(frames):
        for key in ("date", "detector", "wavelength_um", "filename"):
            if fr.get(key) is None:
                problems.append(f"frame {i} missing {key}")
        png = os.path.join(DEMO, folder, fr.get("filename") or "")
        if not os.path.isfile(png):
            problems.append(f"frame {i} PNG file missing")
    dates = [fr["date"] for fr in frames if fr.get("date")]
    if dates != sorted(dates):
        problems.append("frames not sorted by date")

    waves = [fr["wavelength_um"] for fr in frames if fr.get("wavelength_um") is not None]
    dets = sorted({fr["detector"] for fr in frames if fr.get("detector") is not None})
    wave_txt = f"{min(waves)}-{max(waves)} um (spread {round(max(waves) - min(waves), 3)})" if waves else "unknown"
    first = dates[0] if dates else "?"
    last = dates[-1] if dates else "?"
    lines.append(
        f"{name} (FOV {fov:.2f}, folder {folder}): {len(frames)} frames, {first} to {last}, "
        f"detectors {dets}, wavelength {wave_txt}, problems: {'; '.join(problems) if problems else 'none'}"
    )

text = "\n".join(lines) + "\n"
print(text)
with open(os.path.join(HERE, "test_results.txt"), "w", encoding="utf-8") as out:
    out.write(text)
print("Saved test_results.txt")