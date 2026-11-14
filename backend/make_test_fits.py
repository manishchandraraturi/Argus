"""
make_test_fits.py - create a FAKE FITS file so you can test convert.py without real SPHEREx data.

Run (from the backend folder):
    python make_test_fits.py
It writes test_data/test_field.fits with three extensions:
    PRIMARY  (no image data, like many real files)
    IMAGE    64 x 64 star field with a few NaN pixels   <- convert.py should pick this one
    MASK     64 x 64 integer flags (not an image we want)
"""
import sys
from pathlib import Path

import numpy as np

SIZE = 64          # small on purpose: real SPHEREx pixels are ~6 arcsec, so small patches have few pixels
N_STARS = 28


def make_field(seed=42, size=SIZE, n_stars=N_STARS, n_nan=6):
    """Return a float32 star field with some NaN pixels. Pure numpy, no astropy needed."""
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:size, 0:size]
    img = rng.normal(1.0, 0.05, (size, size))            # sky background + noise
    for _ in range(n_stars):
        x, y = rng.uniform(2, size - 2, 2)
        flux = 10 ** rng.uniform(0.3, 2.0)                # a few bright stars, many faint ones
        sigma = rng.uniform(0.8, 1.3)
        img += flux * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * sigma ** 2))
    # NaN pixels: a few scattered ones plus a small bad column segment
    bad = rng.integers(0, size, (n_nan, 2))
    for by, bx in bad:
        img[by, bx] = np.nan
    img[10:14, 30] = np.nan
    return img.astype(np.float32)


def main(out_path=None):
    from astropy.io import fits   # imported here so make_field() can be used without astropy

    out = Path(out_path) if out_path else Path(__file__).parent / "test_data" / "test_field.fits"
    out.parent.mkdir(parents=True, exist_ok=True)

    image = make_field()
    mask = np.zeros(image.shape, dtype=np.int16)
    mask[np.isnan(image)] = 1

    hdr = fits.Header()
    hdr["OBJECT"] = "FAKE TEST FIELD"
    hdr["COMMENT"] = "Synthetic data made by make_test_fits.py. Not real SPHEREx data."

    hdul = fits.HDUList([
        fits.PrimaryHDU(header=hdr),
        fits.ImageHDU(image, name="IMAGE"),
        fits.ImageHDU(mask, name="MASK"),
    ])
    hdul.writeto(out, overwrite=True)
    print(f"Wrote {out}  (IMAGE shape {image.shape}, NaN pixels: {int(np.isnan(image).sum())})")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else None)
