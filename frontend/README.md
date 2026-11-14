# ARGUS Frontend

Celestial observation interface for the ARGUS SPHEREx sky survey.

## Getting Started

### Development
```bash
npm install
npm run dev
```
Runs the Vite development server at `http://localhost:5173`.

### Production Build
```bash
npm run build
npm run preview
```
Compiles optimized assets to `dist/` with zero warnings or errors.

---

## Architecture & Key Files

| File | Purpose |
|------|---------|
| `src/sky.js` | Three.js celestial sphere, real-Earth globe, camera animations, and 3D coordinate mapping |
| `src/hud.js` | HUD overlay, menu/slider/type/target state machine, location bar controller |
| `src/hud.css` | Cyberpunk HUD aesthetics, responsive layouts, corner ticks, and animations |
| `src/targets.js` | Pre-defined astronomical target coordinates and metadata |
| `src/api.js` | Backend API integration client (`getFrames`) |

---

## `argus:probe` Event Contract

When a user confirms a location and clicks **LOAD SKY IMAGES**, the frontend dispatches a custom window event:

```javascript
window.dispatchEvent(new CustomEvent('argus:probe', {
  detail: {
    ra: 133.795,       // Right Ascension in DEGREES (0.0 to 360.0)
    dec: -7.245,       // Declination in DEGREES (-90.0 to +90.0)
    fov: 0.20,         // Field of View in degrees
    name: "WISE 0855"  // Target label / identifier
  }
}));
```

### Listening to the Event:
```javascript
window.addEventListener('argus:probe', (e) => {
  const { ra, dec, fov, name } = e.detail;
  console.log(`Probing target ${name} at RA=${ra}°, DEC=${dec}°, FOV=${fov}°`);
  // Trigger backend frame acquisition
});
```

---

## Backend API Integration

`src/api.js` exports `getFrames(ra, dec, fov)`:

```javascript
import { getFrames } from './src/api.js';

const data = await getFrames(133.795, -7.245, 0.20);
```

### Configuration
Set environment variables in `.env` (refer to `.env.example`):
```env
VITE_API_BASE=http://localhost:8000
VITE_ALLOW_LIVE_FETCH=false
```
- `VITE_API_BASE`: Base URL for the frames API. If empty or not set, `getFrames()` safely returns browser-generated simulation frames.
- `VITE_ALLOW_LIVE_FETCH`: Set to `true` to enable live fetching of non-cached coordinates from NASA/IRSA (default is `false`). When `true`, requesting an uncached position displays a confirmation dialog informing the user that live fetching takes 1 to 2 minutes, with options to FETCH REAL DATA, SIMULATED PREVIEW (INSTANT), or CANCEL. During live fetch, the client polls the server every 2 seconds, showing current progress ("n/N FRAMES"), server messages, elapsed time (MM:SS), and a CANCEL button. On completion, the viewer displays a `SPHEREX DATA (LIVE)` badge with a `NOT ALIGNED` tag, hides the catalog expected-position ring, and notes unaligned frame jitter in the caption. If the server is busy processing another job (HTTP 429), a busy message with retry countdown is presented. When `false`, positions without pre-cached data offer instant simulated preview with pre-loaded demo notice.

### Expected API Endpoint
```http
GET /frames?ra={ra}&dec={dec}&fov={fov}
GET /frames?ra={ra}&dec={dec}&fov={fov}&cached_only=1
```
- `&cached_only=1`: When present, checks if survey frames for the specified coordinates and FOV are already pre-loaded/cached. If not cached, the backend returns HTTP 404.

### Expected Response
```json
{
  "frames": 9,
  "images": [
    "https://domain.com/path/frame_1.jpg",
    "https://domain.com/path/frame_2.jpg"
  ],
  "target": {
    "ra": 133.795,
    "dec": -7.245,
    "fov": 0.20
  }
}
```

---

## Viewport Compatibility

Tested across standard desktop and laptop resolutions:
- **1440 × 800**: Full expansive view, centered globe, right HUD aligned.
- **1280 × 720**: Standard 720p HD layout, compact sidebars, zero text cutoffs.
- **1024 × 768**: 4:3 display mode, responsive typography and fluid slider tracks.

---

## Accessibility
- All interactive controls (buttons, inputs, sliders, cards) support standard keyboard navigation (`Tab`, `Shift+Tab`, `Enter`, `Space`, `Arrow` keys).
- Distinct amber `:focus-visible` outline rings with 2px offset on all active elements.
- ARIA roles and semantic HTML structure across HUD cards and forms.
