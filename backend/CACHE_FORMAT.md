# Demo cache format (backend/demo_cache)

Written by backend/precache_demo.py (Shreesha). Read by server.py (Vaish).

## Folder name

One folder per pre-cached target:

    backend/demo_cache/<ra>_<dec>_<fov>/

RA and Dec are rounded to 3 decimals and FOV to 2 decimals. In Python:

    f"{ra:.3f}_{dec:.3f}_{fov:.2f}"

Example: backend/demo_cache/133.795_-7.245_0.20/

The server must round an incoming request the same way before looking for the folder.

## Files in each folder

- frames.json
- one PNG per frame, named <folder name>_<NN>.png, for example 133.795_-7.245_0.20_00.png
  (the folder name is in the file name so names stay unique if all images are served from one flat folder)

PNGs are 600x600 grayscale, made with convert.fits_to_png(..., size=600).

## frames.json

    {
      "frames": [
        {"date": "2025-05-06", "filename": "133.795_-7.245_0.20_00.png",
         "detector": 5, "wavelength_um": 4.032, "flags": ""}
      ],
      "mock": false,
      "target": "WISE 0855"
    }

Same as the /frames response, with ONE difference: each frame has "filename"
instead of "image_url", because the URL depends on the host. The server builds
image_url from filename the same way it does today ({base}images/{filename}).

- frames are sorted by date
- "mock" is always false
- "target" is only a label and can be ignored
- detector and wavelength_um can be null

## Suggested server logic (Vaish decides)

In get_frames(ra, dec, fov): round the request, check whether
backend/demo_cache/<folder>/frames.json exists. If yes, return those frames
without calling IRSA, and serve the PNGs from that folder. If no, use the
live fetch as before.

## The 5 demo targets

| Target | RA | Dec | FOV | Folder |
|---|---|---|---|---|
| WISE 0855 | 133.795132 | -7.245146 | 0.20 | 133.795_-7.245_0.20 |
| Barnard's Star | 269.452077 | 4.693365 | 0.20 | 269.452_4.693_0.20 |
| Epsilon Indi B | 331.044147 | -56.782844 | 0.15 | 331.044_-56.783_0.15 |
| RW Aurigae | 76.956067 | 30.401326 | 0.20 | 76.956_30.401_0.20 |
| R Draconis | 248.167611 | 66.754979 | 0.20 | 248.168_66.755_0.20 |

Coordinates come from backend/targets_verified.json.

## Final demo cache: backend/demo_cache_final

This folder is made by `backend/tools/build_final_cache.py` and checked by
`backend/tools/check_final_cache.py`. Both run offline: they only read what is
already on this computer (`backend/cache` holds the FITS files downloaded
earlier). A target with no local download is skipped with "not cached"; nothing
is fetched.

Same folder names and file names as above, with two differences:

1. The PNGs are put on one shared sky grid (TAN, 600x600, pixel scale fov/600
degrees, north up, east left), so the stars stay in the same pixels in every
frame and blinking shows only what really moved.
2. Every frame has `target_xy`: the pixel position of the object in that frame
(origin top-left, x to the right, y down), predicted from the catalog position
and the proper motion in `backend/proper_motion.json`.

`frames.json` looks like this:

    {
      "frames": [
        {
          "date": "2025-05-06",
          "filename": "133.795_-7.245_0.20_00.png",
          "detector": 5,
          "wavelength_um": 4.032,
          "flags": "",
          "target_xy": [400.5, 290.9]
        }
      ],
      "mock": false,
      "target": "WISE 0855"
    }

- frames are sorted by date
- "mock" is always false
- detector and wavelength_um can be null
- target_xy is left out when the position has no entry in `proper_motion.json`,
  or when the predicted point falls outside the picture

How to build and check it (Command Prompt, from the repo root):

    backend\.venv\Scripts\python.exe backend\tools\build_final_cache.py
    backend\.venv\Scripts\python.exe backend\tools\check_final_cache.py

`server.py` does not read this folder yet; it still serves `backend/demo_cache`.

target_xy can be absent on a frame that came from an aligned source when the star falls outside that frame's footprint (bad source cutout). The frontend must hide the marker whenever target_xy is absent, regardless of source.
