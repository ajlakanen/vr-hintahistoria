# Julkaisu (GitHub Actions)

Keräys ja julkaisu pyörivät GitHub Actionsissa — ei omaa palvelinta.

## Miten se toimii

- **`.github/workflows/scrape.yml`** ajaa keräyksen joka yö (cron `30 1 * * *` UTC, ~04:30 Suomen aikaa).
  Putki: nouda kanta `data`-haarasta → `scrape` → WAL-checkpoint → `export` → työnnä kanta takaisin → `deploy` (gh-pages).
- **Tila:** `prices.db` elää `data`-haarassa (force-push, yksi commit). Sivu julkaistaan `gh-pages`-haaraan.
- Repo on julkinen → Actions-minuutit ilmaisia.

## Käsiajot

```bash
gh workflow run scrape.yml                 # täysi ajo heti
gh workflow run scrape.yml -f daysAhead=2  # kevyt testiajo (rajattu)
gh workflow run waf-smoketest.yml          # yhden reitin WAF-testi
gh run list --workflow=scrape.yml          # ajohistoria
```

## Reittien muutos

Muokkaa `config.json` → committaa `main`iin. `seed` ajetaan osana workflowta, joten uudet reitit tulevat mukaan seuraavassa ajossa.

## Paikallinen ajo (valinnainen)

```bash
npm ci
npm run seed && npm run scrape && npm run export && npm run deploy
```

> Vanhempi VPS/Docker-pohjainen ajo on korvattu tällä. `Dockerfile`/`docker-compose.yml` ovat yhä repossa jos haluat ajaa kontissa.
