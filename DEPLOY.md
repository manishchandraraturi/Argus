# ARGUS Deployment Guide

This guide details the deployment configuration for hosting the ARGUS backend on Render and the frontend on Vercel.

---

## 1. Backend Deployment (Render Web Service)

Deploy the Python FastAPI backend as a Render Web Service.

### Service Settings
- **Name**: `argus-backend` (or your choice)
- **Environment**: `Python`
- **Root Directory**: `backend`
- **Build Command**: `pip install -r requirements.txt`
- **Start Command**: `uvicorn server:app --host 0.0.0.0 --port $PORT`

### Environment Variables
Configure the following in the Render Dashboard (**Environment** tab):

| Variable Name | Value | Purpose |
|---|---|---|
| `MOCK` | `0` | Disables mock mode so pre-cached real astronomical frames are served |
| `DEMO_DIR` | `demo_cache_final` | Uses the verified, aligned demo cache for survey targets |
| `FORBID_IRSA` | `1` | Disables live external calls to IRSA in production |
| `PYTHON_VERSION` | `3.11.9` | Pins Python 3.11 runtime environment |

> [!WARNING]
> **Free-Tier Sleep Warning**: Render free spins down after 15 min of inactivity; the first request takes ~50s to wake up. The frontend includes an automatic warm-up ping and status notification for this behavior.

---

## 2. Frontend Deployment (Vercel)

Deploy the static Vite application to Vercel.

### Project Settings
- **Framework Preset**: `Vite`
- **Root Directory**: `frontend`
- **Build Command**: `npm run build`
- **Output Directory**: `dist`

### Environment Variables
Configure the following in the Vercel Project Settings (**Environment Variables** tab) before deploying:

- `VITE_API_BASE=https://<your-render-service>.onrender.com`
- `VITE_ALLOW_LIVE_FETCH=false`

| Variable Name | Value | Notes |
|---|---|---|
| `VITE_API_BASE` | `https://<your-render-service>.onrender.com` | Backend URL without trailing slash |
| `VITE_ALLOW_LIVE_FETCH` | `false` | Disables slow live fetching of uncached spots for public web deployment |

> [!IMPORTANT]
> **Build-time baking**: Vite embeds `VITE_*` environment variables into the client bundle at build time. Ensure `VITE_API_BASE` and `VITE_ALLOW_LIVE_FETCH` are saved in Vercel before triggering the build.

---

## 3. Verification After Deployment

1. **Backend Health**: Visit `https://<your-render-url>/health` — should return `{"status":"ok"}`.
2. **Cached Target Frames**: Visit `https://<your-render-url>/frames?ra=269.452&dec=4.693&fov=0.20&cached_only=1` — should return HTTP 200 with `mock: false` and `https://` image URLs.
3. **Frontend Application**: Open the Vercel URL in your browser, click **START PROBING**, pick **Barnard's Star**, click **CONFIRM LOCATION**, and click **LOAD SKY IMAGES**. Verify the green **SPHEREX DATA** badge loads within seconds.
