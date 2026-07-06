# Deploy — OVHcloud VPS

Production = één OVH VPS met Docker Compose, vier services:

| Service | Wat | Poort |
|---|---|---|
| `web` | Next.js (`npm run start`) | intern 3000 |
| `bot` | AI-CPU bot-runner (`npm run bot -- --watch`, polt Postgres direct) | — |
| `cleanup` | Janitor: ruimt runtime-rows van games >24u finished op (elke 6u) | — |
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

## Deployen / updaten — via GitHub Releases (CI/CD)

**Productie-deploys lopen via releases.** Een GitHub Release publiceren
(`gh release create v0.x.y --generate-notes` of via de site) triggert
`.github/workflows/deploy.yml`: eerst `supabase db push` naar hosted (over de
pooler-URL uit het `SUPABASE_DB_URL`-secret), daarna checkt de VPS de
release-tag uit en rebuildt de compose-stack. CI (`ci.yml`) draait op elke
push/PR de volledige suite tegen een lokale Supabase in de runner.

Secrets (GitHub → Settings → Secrets and variables → Actions):
`SUPABASE_DB_URL`, `VPS_HOST`, `VPS_SSH_KEY` (dedicated deploy-key; de publieke
helft staat in `~ubuntu/.ssh/authorized_keys` op de VPS).

Let op: de VPS staat na een release-deploy op de **tag** (detached HEAD). Het
oude handmatige pad werkt nog steeds, maar dan eerst terug naar master:

```bash
cd /opt/leylinesync
git checkout master && git pull
docker compose up -d --build
```

Migraties horen bij de release; los pushen kan nog altijd vanaf de dev-machine
met `supabase db push` (alleen `supabase/migrations/` — zie README over de
hosted/local-split), **vóór** de app-update als de code nieuwe RPC's verwacht.

## Beheer

```bash
docker compose ps                  # status
docker compose logs -f web         # app-logs
docker compose logs -f bot         # bot-runner
docker compose restart bot         # bot herstarten zonder web te raken
```

- De bot draait permanent en polt; zonder actieve CPU-speler doet hij niets.
  Voor CPU-seats op hosted moet er eenmalig een bot-auth-user bestaan
  (`scripts/create-bot-user.mjs`); voeg daarna `"--bot", "<auth-user-id>"` toe
  aan het bot-command in `compose.yml`.
- De `cleanup`-service draait `scripts/cleanup-runner.mjs --watch`: elke 6 uur
  worden runtime-rows (kaarten/stack/effects/log) verwijderd van games die >24u
  geleden finished zijn. Uitslag/history blijft staan. Handmatig testen kan met
  `npm run cleanup:sessions -- --dry-run`.
