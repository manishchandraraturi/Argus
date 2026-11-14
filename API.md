# ARGUS API contract

## Endpoints

### `GET /health`
Returns server health status:
```json
{"status": "ok"}
```

### `GET /frames?ra=<deg>&dec=<deg>&fov=<deg>[&cached_only=1]`
Query sky image frames for a given field of view.

- **Parameters**:
  - `ra`: Right Ascension in degrees (0 to 360).
  - `dec`: Declination in degrees (-90 to 90).
  - `fov`: Field of view in degrees (>0 to 10.0).
  - `cached_only`: Optional ("1" or "true"). When set, uncached positions return HTTP 404 `{"error": "not cached"}` immediately without querying or initiating live acquisition.

#### Response: Cached / Ready Frames (HTTP 200)
```json
{
  "frames": [
    {
      "date": "YYYY-MM-DD",
      "image_url": "http://localhost:8000/images/abc.png",
      "detector": 1,
      "wavelength_um": 1.2,
      "flags": "",
      "aligned": false,
      "target_xy": [300, 300]
    }
  ],
  "mock": false,
  "live": true
}
```
- `frames`: Array of frames sorted chronologically by date.
  - `date`: Frame observation date (`YYYY-MM-DD`).
  - `image_url`: Full URL to the converted 600x600 grayscale PNG image.
  - `detector`: Optional detector index/identifier.
  - `wavelength_um`: Optional center wavelength in micrometers.
  - `flags`: Optional data quality flags.
  - `aligned`: Boolean (`false` on all live frames).
  - `target_xy`: Optional `[x, y]` pixel coordinates in the 600x600 image. Appears only on demo cached targets; never present on live frames.
- `mock`: `true` only for synthetic mock frames; `false` for demo cached or live frames.
- `live`: `true` for frames obtained via live acquisition; omitted for demo cached frames.

#### Response: Background Live Fetch in Progress (HTTP 200)
When an uncached position is queried without `cached_only=1`, a background job is started or joined:
```json
{
  "status": "fetching",
  "message": "Fetching new frames from IRSA. This can take many minutes right now. Keep this page open, it will update when the frames are ready.",
  "elapsed_seconds": 12,
  "progress": {
    "done": 2,
    "total": 6
  },
  "frames": [],
  "mock": false
}
```
- `status`: `"fetching"` while background acquisition is active.
- `message`: User-facing status string.
- `elapsed_seconds`: Time in seconds since the background job started.
- `progress`: Object indicating acquisition progress:
  - `done`: Number of frames downloaded and converted so far.
  - `total`: Total number of candidate frames.
- Requests with the same key share the running job.

#### Response: Concurrency Limit (HTTP 429)
When the active live job limit (`LIVE_MAX_JOBS`, default 1) is reached and a request arrives for a different key:
```json
{
  "error": "busy",
  "retry_after": 45
}
```
- Includes HTTP header `Retry-After: <seconds>`.

#### Response: Uncached or Disabled (HTTP 404)
When `cached_only=1` is requested for an uncached position, or when `ENABLE_LIVE=0`:
```json
{
  "error": "not cached"
}
```

#### Response: Error (HTTP 502)
When data acquisition, conversion, or server processing fails:
```json
{
  "error": "short error message"
}
```

### `GET /resolve?name=<text>`
(Optional, later)
```json
{"name": "...", "ra": 123.456, "dec": 45.678}
```

## Environment Configuration

- `MOCK`: When `"1"` (default), generates synthetic mock frames unless overridden by `MOCK_LIVE`. When `"0"`, runs in real mode.
- `ENABLE_LIVE`: Default `1`. When `0`, uncached positions return HTTP 404 `{"error": "not cached"}` immediately.
- `MOCK_LIVE`: When `1`, simulates live cutout acquisition producing 6 sample frames (one per second) for testing without IRSA.
- `LIVE_MAX_JOBS`: Maximum concurrent background acquisition jobs (default `1`).
- `LIVE_JOB_MAX_S`: Maximum duration for a background job in seconds (default `180`).
- `DEMO_DIR`: Directory containing pre-cached demo targets (defaults to `demo_cache`).
- `FORBID_IRSA`: When `"1"`, network calls to IRSA raise an error immediately.

## Python Contract Between Backend Files

- `data_fetch.fetch_cutouts(ra_deg, dec_deg, fov_deg, max_frames=12, no_cache=False, on_frame=None, progress_cb=None)` -> list of `{date, detector, fits_path, wavelength_um, flags}`
- `convert.fits_to_png(fits_path, png_path, size=600)` -> `png_path`
