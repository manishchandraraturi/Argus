import time
import requests
from data_fetch import _query_rows, BASE_URL

RA, DEC, SIZE = 133.7951, -7.2451, 0.1001  # odd size, so nothing is cached

t = time.time()
rows = _query_rows(RA, DEC)
print(f"TAP query: {round(time.time() - t, 1)} s, {len(rows)} rows")

for r in rows[:3]:
    url = f"{BASE_URL}{r['uri']}?center={RA},{DEC}d&size={SIZE}"
    t = time.time()
    resp = requests.get(url, timeout=120)
    print(f"download: HTTP {resp.status_code}, {len(resp.content)} bytes, {round(time.time() - t, 1)} s")