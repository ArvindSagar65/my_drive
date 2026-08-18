# my_drive

Self-hosted cloud storage: files live on **your** disk (MinIO), you sign in with Google or GitHub, and you open the same Drive-like UI from a laptop or phone.

This machine is the datacenter. A public URL is only the front door.

```
Phone / other PC ──HTTPS──▶ Express (React UI + API)
                              │
                              ├─ Firebase Auth (identity only)
                              └─ MinIO S3 API ── per-user buckets ── local disk
```

---

## What you need

| Requirement | Notes |
| --- | --- |
| A computer that can stay on | Mini PC, NAS, home server, or a laptop you leave plugged in. Phones are bad hosts. |
| Docker | For MinIO |
| Node.js 20+ | For the API and (optional) frontend dev server |
| ffmpeg | Video thumbnails (`sudo pacman -S ffmpeg` / `sudo apt install ffmpeg`) |
| A Firebase project | Free Spark plan is enough for login |

Ports used: **9000** (MinIO), **9001** (MinIO console), **5000** (my_drive), **3000** (optional React dev UI).

---

## Setup on a personal device or home server

Do these on the machine that will **store the files**.

### 1. Install Docker and Node

- Docker Engine + Compose plugin: [https://docs.docker.com/engine/install/](https://docs.docker.com/engine/install/)
- Node.js 20+: [https://nodejs.org/](https://nodejs.org/)
- ffmpeg (for video previews)

Confirm:

```bash
docker compose version
node -v
ffmpeg -version
```

### 2. Get the code

```bash
git clone <your-repo-url> my_drive
cd my_drive
```

### 3. Start object storage (MinIO)

```bash
docker compose up -d minio
```

MinIO console: [http://localhost:9001](http://localhost:9001)

Default login (change this before exposing the node):

- user: `admin`
- password: `arjun1388`

To use your own keys, edit `docker-compose.yml` **and** `backend/.env` so they match.

### 4. Create a Firebase project (login only)

Files are **not** stored in Google Cloud. Firebase is only “who are you?”

1. Open [Firebase Console](https://console.firebase.google.com/) → Add project.
2. Project settings → **General** → Your apps → add a **Web** app. Copy the config (`apiKey`, `authDomain`, `projectId`, …).
3. **Authentication** → Sign-in method → enable **Google**. Enable **GitHub** if you want it (needs a GitHub OAuth app).
4. Authentication → Settings → **Authorized domains** → keep `localhost`. Later you will add your public hostname.
5. Project settings → **Service accounts** → Generate new private key. Save the JSON as:

```text
backend/firebase-admin-key.json
```

Never commit that file.

### 5. Configure the backend

```bash
cp backend/.env.example backend/.env
```

Edit `backend/.env`:

```env
PORT=5000
FIREBASE_ADMIN_SDK=./firebase-admin-key.json
MINIO_ENDPOINT=http://localhost:9000
MINIO_ACCESS_KEY=admin
MINIO_SECRET_KEY=arjun1388
MINIO_REGION=ap-south-1
DEFAULT_STORAGE_GB=5
MAX_STORAGE_GB=1024
```

If MinIO runs on another host, set `MINIO_ENDPOINT` to that URL.

### 6. Configure the frontend (for local `npm start` on port 3000)

```bash
cp my-drive-frontend/.env.example my-drive-frontend/.env
```

Paste your Firebase **web** config into `my-drive-frontend/.env`:

```env
REACT_APP_API_URL=http://localhost:5000
REACT_APP_FIREBASE_API_KEY=...
REACT_APP_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
REACT_APP_FIREBASE_PROJECT_ID=...
REACT_APP_FIREBASE_STORAGE_BUCKET=...
REACT_APP_FIREBASE_MESSAGING_SENDER_ID=...
REACT_APP_FIREBASE_APP_ID=...
```

When the UI is served **from the backend** (step 8), the API URL is the same origin, so phones work without `localhost`.

### 7. Install dependencies

```bash
cd backend && npm install && cd ..
cd my-drive-frontend && npm install && cd ..
```

### 8. Build the UI and start the app

**Everyday / “this is my server” mode** (one process, port 5000):

```bash
npm run build
cd backend && npm start
```

Leave this terminal open. You should see `my_drive running on http://localhost:5000`.

**Developer mode** (React hot reload on 3000, API on 5000):

```bash
# terminal A
cd backend && npm start

# terminal B
cd my-drive-frontend && npm start
```

Open [http://localhost:3000](http://localhost:3000).

### 9. First login and bucket size

1. Sign in with Google (or GitHub).
2. The server creates **one MinIO bucket for that account**.
3. On the dashboard, set **how many GB of this disk** the account may use. The limit cannot exceed free space.

Health checks:

```bash
curl http://localhost:5000/health
curl http://localhost:5000/ready
```

`/ready` should show `"objectStore": true` if MinIO is up.

### 10. Optional: CLI (`mydrive push`)

Uploads use **S3 multipart** (8 MB parts, resumable). The browser can send many files at once; the CLI can push a whole folder.

In the web UI: account menu → **Copy CLI token**. Then:

```bash
node cli/mydrive.js login --token <paste-the-token> --api http://localhost:5000
node cli/mydrive.js push ./photos
node cli/mydrive.js ls
```

If you used `npm run expose`, pass that public URL as `--api`. Tokens expire; copy a fresh one if login fails.

The web drop zone accepts **multiple files of any type**. Interrupted uploads resume from the last finished part (browser `localStorage`, or run `push` again after fixing the network — the CLI currently restarts the object; the browser resumes).

---

## Use it on the same Wi‑Fi

On the storage machine:

```bash
hostname -I
```

On your phone (same Wi‑Fi), open:

```text
http://<that-ip>:5000
```

Add that LAN IP (or hostname) to Firebase **Authorized domains** if Google sign-in blocks it.

The backend already listens on `0.0.0.0`.

---

## Use it from anywhere (phone on mobile data)

The storage machine must stay on.

### Quick tunnel (changes URL each time)

From the **repo root**, with the app already running on port 5000:

```bash
npm run expose
```

Copy the `https://….trycloudflare.com` URL.

1. Open it on your phone.
2. Firebase → Authentication → Authorized domains → add `something.trycloudflare.com` (the hostname only).
3. If Google still refuses login, Google Cloud Console → APIs & Services → Credentials → your OAuth client → **Authorized JavaScript origins** → add the same `https://….trycloudflare.com`.

Bookmark the URL or “Add to Home Screen”.

### Stable URL (recommended for a real server)

Use a named [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/) with a domain you own, or Tailscale Funnel. Point it at `http://localhost:5000`. Add that domain to Firebase authorized domains **once**.

Do **not** port-forward MinIO (`9000`/`9001`) to the internet. Only publish port **5000**.

---

## Day-2 operations

| Task | Command / action |
| --- | --- |
| Stop MinIO | `docker compose stop minio` |
| Start MinIO | `docker compose up -d minio` |
| Stop the app | Ctrl+C in the `npm start` terminal |
| Data location | MinIO volume `minio_data`; file catalog `backend/data/metadata.json` |
| Change default quota | `DEFAULT_STORAGE_GB` in `backend/.env` |
| Backups | Copy the MinIO volume **and** `backend/data/` |

If the computer sleeps, the public URL dies. Disable sleep on a dedicated node.

Gaps versus Drive/Nextcloud and a backlog of possible improvements live in [docs/limitations-and-improvements.md](docs/limitations-and-improvements.md).
