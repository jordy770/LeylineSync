# Deploy — OVHcloud VPS

Production = één OVH VPS met Docker Compose, drie services:

| Service | Wat | Poort |
|---|---|---|
| `web` | Next.js (`npm run start`) | intern 3000 |
| `bot` | AI-CPU bot-runner (`npm run bot`, polt Postgres direct) | — |
| `caddy` | Reverse proxy + automatische HTTPS (Let's Encrypt) | 80/443 |

Supabase blijft het **hosted** project (DB/auth/realtime); de VPS draait alleen de app.
Realtime-websockets lopen rechtstreeks browser ↔ Supabase, niet via de VPS.

## Eenmalige VPS-setup (Ubuntu 24.04)

```bash
# als root op de VPS
apt update && apt upgrade -y
curl -fsSL https://get.docker.com | sh

# firewall: alleen ssh + http(s)
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw enable

git clone <repo-url> /opt/leylinesync
cd /opt/leylinesync
cp .env.example .env   # en invullen — zie hieronder
```

### `.env` invullen

- `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` — uit het
  Supabase-dashboard (zelfde waarden als lokaal `.env.local`, maar dan van het
  hosted project). **Build-time**: na wijzigen opnieuw builden.
- `DATABASE_URL` — Supabase Dashboard → Connect → **Session pooler** (poort 5432).
  De transaction pooler (6543) is ongeschikt: de bot gebruikt een langlevende
  sessie. OVH VPS'en hebben IPv4; de directe `db.<ref>.supabase.co`-host is
  IPv6-only, dus gebruik de pooler.
- `ANTHROPIC_API_KEY` — voor deck-doctor + AI-scriptgenerator (mag leeg blijven;
  die twee features geven dan een nette fout).
- `APP_DOMAIN` — bijv. `app.dweemo.nl`.

### DNS (Cloudflare)

1. A-record `app.dweemo.nl` → VPS-IP, **DNS only (grijs wolkje)**.
2. `docker compose up -d --build` en wachten tot Caddy zijn certificaat heeft
   (`docker compose logs caddy`).
3. Optioneel daarna het wolkje op proxied zetten met SSL-mode **Full (strict)**.

De bestaande Cloudflare **Tunnel** (dev, `.cloudflared/config.yml`) blijft puur
voor de dev-machine; de VPS heeft hem niet nodig.

## Deployen / updaten

```bash
cd /opt/leylinesync
git pull
docker compose up -d --build   # rebuild + rolling restart van gewijzigde services
```

Database-migraties gaan zoals altijd via `supabase db push` (vanaf de dev-machine,
alleen `supabase/migrations/` — zie README over de hosted/local-split), **vóór** de
app-update als de code nieuwe RPC's verwacht.

## Beheer

```bash
docker compose ps                  # status
docker compose logs -f web         # app-logs
docker compose logs -f bot         # bot-runner
docker compose restart bot         # bot herstarten zonder web te raken
```

- De bot draait permanent en polt; zonder actieve CPU-speler doet hij niets.
- `cleanup_finished_session`-cron: nog niet ingericht (open item) — kan later als
  vierde compose-service of host-cron.
