# VPS deployment: eve-core + 24/7 LiveKit RTMP (ffmpeg)

Target example: **78.46.210.25** (replace with your VPS IP). Run these steps **on the VPS** over SSH. This doc maps 1:1 to the deployment checklist.

## 0. Prerequisites

- **DNS:** A hostname that resolves to the VPS **IPv4** (Let’s Encrypt needs a name, not only an IP). Example for **`live.eve.army`** while **`eve.army`** stays on another host (marketing site, etc.):
  1. Namecheap → **Domain List** → **Manage** on `eve.army` → **Advanced DNS**.
  2. Confirm nameservers are **Namecheap BasicDNS** (or your DNS host if using custom NS — then add the record there instead).
  3. **Add New Record** → **A Record** → **Host:** `live` (this is only the left part; the full name becomes **`live.eve.army`**).
  4. **Value:** your VPS IP (e.g. `78.46.210.25`).
  5. **TTL:** Automatic or 5 min — save.
  6. Do **not** change existing `@` or `www` records for `eve.army` unless you intend to; they can keep pointing at the main public site.
  7. Verify: `dig +short live.eve.army A` should print the VPS IP before you run certbot.
- **Nginx / certbot on the VPS** must use **`server_name live.eve.army`** (and certbot `-d live.eve.army`). Users open **`https://live.eve.army`** for EVE; **`https://eve.army`** is unchanged.
- **Stream key:** If it was ever exposed publicly, **rotate** it in pump.fun / LiveKit before production.
- This repo cloned to **`/opt/eve-core`** (or adjust paths in systemd units).

---

## 1. VPS baseline (todo: vps-base)

1. **SSH hardening**
   - Prefer SSH keys; disable password auth: `PasswordAuthentication no` in `/etc/ssh/sshd_config.d/`.
   - Optional: `AllowUsers eve`, non-default port, `fail2ban` for sshd.
   - `sudo systemctl reload ssh` (or `sshd`).

2. **Deploy user**
   - `sudo adduser eve` (no login password needed if key-only).
   - `sudo usermod -aG sudo eve` for initial setup; you can remove later.

3. **Firewall**
   ```bash
   sudo ufw default deny incoming
   sudo ufw default allow outgoing
   sudo ufw allow 22/tcp      # or your SSH port
   sudo ufw allow 80/tcp
   sudo ufw allow 443/tcp
   sudo ufw enable
   ```

4. **Time sync**
   - `sudo apt install -y chrony` and ensure `chrony` is active (`timedatectl` shows NTP sync).

---

## 2. Dependencies: Node, ffmpeg, nginx, certbot (todo: deps-nginx)

Ubuntu 22.04/24.04:

```bash
sudo apt update
sudo apt install -y ca-certificates curl git nginx certbot python3-certbot-nginx ffmpeg chrony
```

**Node.js LTS (20 or 22)** — example with NodeSource (check current instructions on [nodejs.org](https://nodejs.org/)):

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v
```

Verify **rtmps** support:

```bash
ffmpeg -protocols 2>&1 | grep -E 'tls|rtmp'
```

---

## 3. Deploy eve-core + systemd + nginx (todo: deploy-next)

1. **Clone and install**
   ```bash
   sudo mkdir -p /opt/eve-core
   sudo chown eve:eve /opt/eve-core
   sudo -u eve -H git clone https://github.com/eve-army/eve-core.git /opt/eve-core
   cd /opt/eve-core
   npm ci
   ```

2. **Build**
   - Try **without** WASM first (faster on typical glibc VPS):
     ```bash
     NODE_ENV=production npm run build
     ```
   - If the build crashes (e.g. SWC bus error), set in `/etc/eve-core/app.env`:
     `NEXT_TEST_WASM=1` and use the same for build — see root `package.json` `build` script, or run:
     `NEXT_TEST_WASM=1 npm run build`.

3. **App secrets**
   ```bash
   sudo mkdir -p /etc/eve-core
   sudo cp deploy/app.env.example /etc/eve-core/app.env
   sudo nano /etc/eve-core/app.env   # fill keys
   sudo chmod 600 /etc/eve-core/app.env
   sudo chown root:root /etc/eve-core/app.env
   ```
   systemd loads this file via `EnvironmentFile`; Next also picks compatible vars from the environment.

4. **systemd — eve-core**
   ```bash
   sudo cp /opt/eve-core/deploy/systemd/eve-core.service /etc/systemd/system/
   sudo sed -i 's|ExecStart=.*node |ExecStart='$(command -v node)' |' /etc/systemd/system/eve-core.service   # optional: fix Node path
   sudo systemctl daemon-reload
   sudo systemctl enable --now eve-core
   journalctl -u eve-core -f
   ```

5. **Nginx** (HTTP first — valid `nginx -t` before certificates)
   ```bash
   sudo cp /opt/eve-core/deploy/nginx-eve-core.conf /etc/nginx/sites-available/eve-core
   sudo sed -i 's/YOUR_DOMAIN/live.eve.army/g' /etc/nginx/sites-available/eve-core
   sudo ln -sf /etc/nginx/sites-available/eve-core /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   ```

6. **TLS** — certbot adds `:443` and certificates to the active vhost:
   ```bash
   sudo certbot --nginx -d live.eve.army
   ```
   Then enable “force HTTPS” in the generated config if you want plain HTTP to redirect only.

---

## 4. LiveKit RTMP publisher (todo: ffmpeg-rtmp)

1. **Confirm RTMP ingest URL** in pump.fun / LiveKit (path varies). Set **one** of:
   - `RTMP_URL=rtmps://...full...`
   - or `RTMP_BASE` + `RTMP_STREAM_KEY` (see `deploy/rtmp.env.example`).

2. **Secrets**
   ```bash
   sudo cp /opt/eve-core/deploy/rtmp.env.example /etc/eve-core/rtmp.env
   sudo nano /etc/eve-core/rtmp.env
   sudo chmod 600 /etc/eve-core/rtmp.env
   ```

3. **Script permissions**
   ```bash
   sudo chmod +x /opt/eve-core/deploy/scripts/livekit-publish.sh
   ```

4. **systemd — ffmpeg**
   ```bash
   sudo cp /opt/eve-core/deploy/systemd/eve-livekit-rtmp.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now eve-livekit-rtmp
   journalctl -u eve-livekit-rtmp -f
   ```

5. **Input modes** (`INPUT_MODE` in `rtmp.env`):
   - `lavfi` — test pattern + tone (default; proves ingress).
   - `loop` — set `INPUT_FILE=/path/to/video.mp4`.
   - `black` — black video + silent AAC.

6. **CPU / bandwidth:** Lower load with `VIDEO_SIZE=854x480`, `VIDEO_FPS=24`, lower `VIDEO_BITRATE` in `rtmp.env`.

---

## 5. Verification & ops (todo: ops-verify)

| Check | Command / action |
|--------|-------------------|
| Next responds | `curl -sI https://live.eve.army` → `200` |
| EVE UI | Browser: `https://live.eve.army/eve` or `/pumpfun` redirect |
| SSE / chat | Connect a mint; `/api/pumpchat` should stay open (nginx timeouts raised) |
| RTMP | pump.fun / LiveKit viewer shows the ffmpeg feed |
| Survive reboot | `sudo reboot` then `systemctl is-active eve-core eve-livekit-rtmp` |
| Logs | `journalctl -u eve-core -u eve-livekit-rtmp --since today` |

---

## 6. Updating the app

```bash
cd /opt/eve-core
sudo -u eve git pull
sudo -u eve npm ci
sudo -u eve npm run build    # add NEXT_TEST_WASM=1 if required
sudo systemctl restart eve-core
```

ffmpeg service is independent; restart only if you change `rtmp.env` or the script.

---

## Files in this directory

| File | Purpose |
|------|---------|
| [VPS-SETUP.md](./VPS-SETUP.md) | This guide |
| [app.env.example](./app.env.example) | Template for `/etc/eve-core/app.env` |
| [rtmp.env.example](./rtmp.env.example) | Template for `/etc/eve-core/rtmp.env` |
| [nginx-eve-core.conf](./nginx-eve-core.conf) | Reverse proxy + SSE-friendly timeouts |
| [systemd/eve-core.service](./systemd/eve-core.service) | Next.js service |
| [systemd/eve-livekit-rtmp.service](./systemd/eve-livekit-rtmp.service) | ffmpeg publisher |
| [scripts/livekit-publish.sh](./scripts/livekit-publish.sh) | ffmpeg command (lavfi / loop / black) |
