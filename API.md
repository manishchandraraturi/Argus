# ARGUS API contract
GET /health -> {"status":"ok"}
GET /frames?ra=<deg>&dec=<deg>&fov=<deg>
 -> {"frames":[{"date":"YYYY-MM-DD","image_url":"http://localhost:8000/images/abc.png","detector":1,"wavelength_um":1.2,"flags":"","target_xy":[300,300]}],"mock":false}
Frames sorted by date. wavelength_um, flags, and target_xy ([x,y] pixel coordinates in 600x600 image) are optional. "mock" is true only for fake frames. On failure: HTTP 502 {"error":"short message"}.
GET /resolve?name=<text> -> {"name":"...","ra":<deg>,"dec":<deg>} (optional, later)
Python contract between backend files:
data_fetch.fetch_cutouts(ra_deg, dec_deg, fov_deg, max_frames=12) -> list of {date, detector, fits_path, wavelength_um, flags}
convert.fits_to_png(fits_path, png_path, size=600) -> png_path
