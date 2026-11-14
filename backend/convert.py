"""
convert.py - turn a FITS image into a grayscale PNG the browser can show.

    from convert import fits_to_png
    fits_to_png("test_data/test_field.fits", "out.png", size=600)

Command line test (from the backend folder):
    python convert.py test_data/test_field.fits out.png
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image


def array_to_png(data, png_path, size=600, stretch="asinh"):
    """
    Core of the conversion. Works on a plain 2D numpy array (no astropy needed), so it is easy to test.
    Steps: replace NaN/inf -> percentile clip (1 and 99.5) -> asinh or sqrt curve -> 0..255
           -> flip so north is up -> bicubic upscale to size x size -> save grayscale PNG.
    """
    data = np.asarray(data, dtype=np.float64)
    if data.ndim != 2:
        raise ValueError(f"expected a 2D image, got shape {data.shape}")

    finite = np.isfinite(data)
    if not finite.any():
        raise ValueError("image has no finite pixels (all NaN)")

    # 1) replace NaN / inf with the median of the good pixels so they do not wreck the stretch
    fill = float(np.median(data[finite]))
    clean = np.where(finite, data, fill)

    # 2) clip to the 1st and 99.5th percentile and scale to 0..1
    lo, hi = np.percentile(clean, [1, 99.5])
    if not hi > lo:                      # flat image: avoid dividing by zero
        hi = lo + 1.0
    norm = np.clip((clean - lo) / (hi - lo), 0.0, 1.0)

    # 3) stretch curve
    if stretch == "sqrt":
        curved = np.sqrt(norm)
    elif stretch == "asinh":
        a = 10.0                          # bigger a = brighter faint stars
        curved = np.arcsinh(a * norm) / np.arcsinh(a)
    else:
        raise ValueError("stretch must be 'asinh' or 'sqrt'")

    img8 = np.uint8(np.round(curved * 255))
    img8 = np.flipud(img8)                # FITS row 0 is the bottom of the sky image; PNG row 0 is the top

    # 4) upscale. Real SPHEREx pixels are large (~6 arcsec), so a small patch has few pixels. That is expected.
    im = Image.fromarray(img8, mode="L")
    im = im.resize((size, size), Image.Resampling.BICUBIC)

    png_path = Path(png_path)
    png_path.parent.mkdir(parents=True, exist_ok=True)
    im.save(png_path, format="PNG")
    return str(png_path)


def _pick_image_hdu(hdul):
    """Print every extension, then choose: the one named IMAGE, else the first 2D image."""
    print("FITS extensions:")
    for i, hdu in enumerate(hdul):
        shape = None if hdu.data is None else tuple(np.shape(hdu.data))
        print(f"  [{i}] name={hdu.name!r:12} type={type(hdu).__name__:12} shape={shape}")

    for hdu in hdul:                                   # preferred: extension called IMAGE
        if str(hdu.name).upper() == "IMAGE" and hdu.data is not None and np.squeeze(hdu.data).ndim == 2:
            print(f"-> using extension named IMAGE")
            return hdu
    for i, hdu in enumerate(hdul):                     # fallback: first 2D image
        if hdu.data is not None and np.squeeze(hdu.data).ndim == 2:
            print(f"-> no IMAGE extension, using first 2D image: [{i}] {hdu.name!r}")
            return hdu
    raise ValueError("no 2D image found in this FITS file")


def fits_to_png(fits_path, png_path, size=600):
    from astropy.io import fits    # imported here so array_to_png() can be tested without astropy

    with fits.open(fits_path) as hdul:
        hdu = _pick_image_hdu(hdul)
        data = np.squeeze(np.array(hdu.data, dtype=np.float64))   # copy out of the file before it closes
    return array_to_png(data, png_path, size=size, stretch="asinh")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("usage: python convert.py input.fits output.png [size]")
        sys.exit(1)
    out = fits_to_png(sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 600)
    print("Saved", out)
