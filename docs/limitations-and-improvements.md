# Limitations and improvements

Notes that do not belong in the setup README: honest gaps versus similar products, and ideas that would make this project stand out.

## What this project is missing vs similar products

Compared to **Google Drive / Dropbox**: no clients for desktop sync, no sharing links with expiry, no offline, no version history, no search inside file contents, no collaboration.

Compared to **Nextcloud / Seafile**: no calendar/contacts, no apps ecosystem, no built-in users (you rely on Google/GitHub), no WebDAV, catalog is a JSON file (not a real DB). Multipart/resumable upload for large files is implemented (browser + CLI).

Compared to **Syncthing**: this is not peer-to-peer folder sync. If the node is off, nothing is reachable.

Compared to **Immich / PhotoPrism**: no photo timeline, faces, or mobile backup daemon.

Honest gaps for a “cloud storage” demo:

1. **No real backup/replication** — one disk, one copy.
2. **No share links** — you cannot send `anyone with the link can view`.
3. **No desktop/mobile sync agent** — browser and a small `mydrive` CLI only.
4. **Catalog is not durable at scale** — `metadata.json` is fine for one person, not a team.
5. **Tunnel URLs are fragile** unless you add a domain.
6. **No audit log / trash restore** — delete is close to gone.
7. **No encryption at rest** beyond whatever the disk already has.

---

## Changes that would make it stand out

Pick a few and go deep. Do not clone Nextcloud.

**Highest impact for a portfolio**

1. **Share links** — time-limited, password-optional tokens; `GET /s/:token` streams from MinIO. Interviewers understand this immediately.
2. **Trash + versions** — MinIO versioning or a `trash/` prefix and restore UI.
3. **SQLite or Postgres catalog** — replace JSON; add migrations. That’s how real control planes work.
4. **PWA + “Add to Home Screen”** that works offline for the file *list* (cache API).
5. **Richer CLI sync** — `mydrive push` already uploads a folder; add pull, watch, and true resume on the CLI.

**Cloud-knowledge flex (use sparingly)**

- Lifecycle rules: auto-delete incomplete multipart, expire trash after 30 days.
- Storage classes / a second MinIO (or B2) as **async replica**.
- Prometheus metrics (`my_drive_upload_bytes`, `my_drive_quota_ratio`).
- OpenAPI spec generated from the Express routes.
- Terraform or a single `make up` that includes named Cloudflare tunnel.

**Product flex**

- Encrypted-at-rest option (client-side keys; server stores ciphertext). Privacy story vs Drive.
- Per-device “this laptop is a node” agent (hard; don’t start here).
- WebDAV so existing apps (DAVx5, rclone) can mount it.

The distinctive story to tell: **tenant-isolated S3 buckets on hardware you own, identity from Firebase, quota bound to real free disk, API as the only public surface.** Share links + a proper catalog would make that story complete.
