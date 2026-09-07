# ISHARA

Two-way ISL–speech translator kiosk for frontline government service points (RTOs, Aadhar/PAN centers, CSCs).

See [isl-kiosk/README.md](isl-kiosk/isl-kiosk/README.md) for the app structure and how to run it.

# Running ISHARA Locally

This project runs as four separate processes: a session server, a model service, and two frontend apps (citizen-facing and staff-facing). Start them in the order below, each in its own terminal tab.

## Prerequisites

- Node.js and pnpm installed
- Python virtual environment set up for the model service (see `OpenHands/` or `model-service/` setup instructions)

## 1. Start the session server (port 4000)

```bash
cd /workspaces/ISHARA/isl-kiosk/server
pwd
npm run dev
```

You should see: http://localhost:4000


Leave this terminal running. This server manages live session state and syncs both frontend apps over Socket.IO.

## 2. Start the model service (port 8000)

**Option A — using `model-service/`:**

```bash
cd /workspaces/ISHARA/isl-kiosk/model-service
pwd
uvicorn app:app --host 0.0.0.0 --port 8000
```

**Option B — using the OpenHands-based service:**

```bash
cd /workspaces/ISHARA/OpenHands
source .venv/bin/activate
.venv/bin/uvicorn isl_server:app --host 0.0.0.0 --port 8000
```

Watch the startup log for the checkpoint-loading confirmation before moving on. Leave this terminal running.

## 3. Start the citizen-facing app (vision-lab)

```bash
cd /workspaces/ISHARA/isl-kiosk/apps/vision-lab
pwd
pnpm dev
```

Open the forwarded local URL in your browser. This is the camera side, where a citizen signs.

## 4. Start the staff-facing app (voice-lab)

```bash
cd /workspaces/ISHARA/isl-kiosk/apps/voice-lab
pwd
pnpm dev
```

Open the forwarded local URL in a separate browser tab. This is the mic side, where staff speak.

## Startup order matters

Start the session server first, then the model service, then the two frontend apps last, since both apps connect to the server on load.

## Verify everything is running

Before opening the browser tabs, confirm both backend services are healthy:

```bash
curl http://localhost:4000/health
curl http://localhost:8000/health
```

Both should return a healthy response. If either fails, fix it before proceeding, the frontend apps won't work correctly against a dead backend.

## Using it

Once all four processes are running and both health checks pass, open the vision-lab and voice-lab browser tabs side by side. Signs recognized on the citizen side appear on the staff side, and messages sent from the staff side appear on the citizen side, in real time.