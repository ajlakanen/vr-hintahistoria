# Julkaisu (GitHub Actions)

Keräys ja julkaisu pyörivät GitHub Actionsissa — ei omaa palvelinta.

## Miten se toimii

- **`.github/workflows/scrape.yml`** ajaa keräyksen joka yö (cron `30 1 * * *` UTC, ~04:30 Suomen aikaa).
  Putki: nouda kanta `data`-haarasta → `scrape` (siivoaa menneet travel_date-rivit) → checkpoint+VACUUM → `export` → työnnä kanta takaisin → `deploy` (gh-pages).
- **Tila:** `prices.db` pakataan tiedostoksi `prices.db.gz`, joka elää `data`-haarassa (force-push, yksi commit). Sivu julkaistaan `gh-pages`-haaraan.
- Repo on julkinen → Actions-minuutit ilmaisia.

## Käsiajot

```bash
gh workflow run scrape.yml                 # täysi ajo heti
gh workflow run scrape.yml -f daysAhead=2  # kevyt testiajo (rajattu)
gh workflow run waf-smoketest.yml          # yhden reitin WAF-testi
gh run list --workflow=scrape.yml          # ajohistoria
```

## Jos kannan työntö `data`-haaraan epäonnistuu

GitHub palauttaa joskus ohimenevän virheen pushissa (`remote: Internal Server Error`,
`! [remote rejected] data -> data`). Workflow yrittää pushia automaattisesti viisi kertaa
kasvavalla viiveellä. Jos kaikki yritykset epäonnistuvat, ajon keräämä kanta on silti
tallessa ajon artefaktina `prices-db-<run-id>` (säilyy 7 päivää) ja sivu on julkaistu
normaalisti. Palauta kanta käsin:

```bash
gh run download <run-id> -n prices-db-<run-id> -D /tmp/db   # lataa prices.db.gz
cd /tmp/db && git init -q && git checkout -q -b data
git add prices.db.gz && git commit -qm "DB update (run <run-id>, palautettu artefaktista)"
git push -f git@github.com:ajlakanen/vr-hintahistoria.git data
```

Jos palautusta ei tehdä, seuraava yöajo jatkaa edellisestä onnistuneesti työnnetystä
kannasta: yhden päivän havainnot jäävät puuttumaan, mutta mikään ei mene rikki.

## Reittien muutos

Muokkaa `config.json` → committaa `main`iin. `seed` ajetaan osana workflowta, joten uudet reitit tulevat mukaan seuraavassa ajossa.

## Paikallinen ajo (valinnainen)

```bash
npm ci
npm run seed && npm run scrape && npm run export && npm run deploy
```

> Vanhempi VPS/Docker-pohjainen ajo on korvattu tällä. `Dockerfile`/`docker-compose.yml` ovat yhä repossa jos haluat ajaa kontissa.
