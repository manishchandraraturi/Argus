# ARGUS backend (Shreesha: data_fetch.py, Vaish: server.py and convert.py)

A small FastAPI server that gives the frontend a list of image frames for a place in the sky. The contract is in `API.md` at the top of the repo.

* **Mock mode** (default): makes fake frames with numpy + Pillow. No internet, no real data.
* **Real mode** (`MOCK=0`): calls `fetch_cutouts` (Shreesha), converts each FITS file to a PNG with `convert.py`.

## Files

| File | What it does |
|---|---|
| `server.py` | The FastAPI server (`/health`, `/frames`, `/images`) |
| `data_fetch.py` | Shreesha: `fetch_cutouts(ra_deg, dec_deg, fov_deg, max_frames=12)` gets the real FITS cutouts |
| `convert.py` | `fits_to_png(fits_path, png_path, size=600)`: FITS to grayscale PNG |
| `make_test_fits.py` | Makes a fake FITS file for testing (`test_data/test_field.fits`) |
| `targets_verified.json` | Target coordinates checked against SIMBAD (see its `source` fields) |
| `requirements.txt` | Python packages |
| `cache/png/` | Created automatically. Generated PNGs. Not committed. |

## 1. Set up (once)

Open a terminal in the `backend` folder.

```
python -m venv .venv
```

Activate it:

* Windows Command Prompt: `.venv\Scripts\activate`
* Windows PowerShell: `.venv\Scripts\Activate.ps1`
* Mac / Linux: `source .venv/bin/activate`

Then:

```
pip install -r requirements.txt
```

(If PowerShell blocks the activate script, run `Set-ExecutionPolicy -Scope Process Bypass` once in that window, or use Command Prompt.)

## 2. Test the FITS converter

```
python make_test_fits.py
python convert.py test_data/test_field.fits test_out.png
```

You should see the list of FITS extensions, the line `-> using extension named IMAGE`, and then `Saved test_out.png`.
Open `test_out.png`: a black 600 x 600 picture with white blobs (stars). A small dark notch is where NaN pixels were filled in.

## 3. Run the server in MOCK mode

```
uvicorn server:app --reload --port 8000
```

Test in the browser:

* http://localhost:8000/health  (expect `{"status":"ok"}`)
* http://localhost:8000/frames?ra=133.795&dec=-7.245&fov=0.1
* Copy any `image_url` from the answer into the address bar to see the PNG.
* http://localhost:8000/docs  (FastAPI's automatic test page)

Press **Ctrl+C** in the terminal to stop the server.

### What the server returns (matches `API.md`)

`GET /health` returns `{"status":"ok"}`.

`GET /frames?ra=&dec=&fov=` returns:

```json
{
  "frames": [
    {"date": "2026-01-01", "image_url": "http://localhost:8000/images/mock_xxxxxxxxxxxx_0.png",
     "detector": 1, "wavelength_um": 1.2, "flags": ""}
  ],
  "mock": true
}
```

* Frames are sorted by date. `wavelength_um` and `flags` are left out when unknown.
* `mock` is `true` only for fake frames. Mock mode makes 9 frames, 30 days apart, 600 x 600 grayscale PNG.
* Any failure (including bad or missing `ra`, `dec`, `fov`): HTTP 502 and `{"error": "short message"}`.
* Real mode and no data found: `{"frames": [], "mock": false}`.
* `GET /resolve?name=` (name to coordinates) is optional in `API.md` and is not built yet.

## 4. Run in REAL mode (only after Shreesha says `data_fetch` works)

`server.py` imports `data_fetch.py` from the `backend` folder, as agreed in `API.md`:

```
data_fetch.fetch_cutouts(ra_deg, dec_deg, fov_deg, max_frames=12)
    -> list of {date, detector, fits_path, wavelength_um, flags}
convert.fits_to_png(fits_path, png_path, size=600) -> png_path
```

For each cutout the server converts `fits_path` to a PNG in `cache/png` and returns the frame, sorted by date.
If `fetch_cutouts` raises an error, the server answers 502 with that message.

Command Prompt:

```
set MOCK=0
uvicorn server:app --reload --port 8000
```

PowerShell:

```
$env:MOCK="0"
uvicorn server:app --reload --port 8000
```

To go back to mock mode, close that terminal and open a new one (or run `set MOCK=1` / `$env:MOCK="1"`).

## 5. Use it with the frontend

In a second terminal:

```
cd frontend
npm install
```

Create `frontend/.env` containing exactly this line (do **not** commit it):

```
VITE_API_BASE=http://localhost:8000
```

Then `npm run dev` and open the link it prints. Restart `npm run dev` after any change to `.env`.

## Test URLs

| URL | Expect |
|---|---|
| `/health` | `{"status":"ok"}` |
| `/frames?ra=133.795&dec=-7.245&fov=0.1` | 9 frames |
| `/frames?ra=269.452&dec=4.693&fov=0.12` | 9 frames (Barnard's Star) |
| `/frames?ra=400&dec=0&fov=0.1` | HTTP 502 and `{"error": "ra must be 0 to 360"}` |
| `/frames?ra=10` | HTTP 502 and `{"error": "missing dec"}` |

## Common problems

* **`uvicorn` is not recognized**: the virtual environment is not active, or `pip install -r requirements.txt` did not finish.
* **`ModuleNotFoundError: astropy`**: run `pip install -r requirements.txt` again (only `convert.py` and real mode need it).
* **Browser shows a CORS error**: check the frontend `VITE_API_BASE` matches the server address exactly, with no trailing slash.
* **Port 8000 already in use**: close the other terminal running uvicorn, or use `--port 8001` and change `VITE_API_BASE`.