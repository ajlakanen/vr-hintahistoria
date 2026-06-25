# VR hintahistoria – tekniset yksityiskohdat

Ohjelman tarkoitus on hakea kunkin seurattavan matkan hinta päivittäin ja tallentaa
ne tietokantaan. Näin voidaan myöhemmin hakea hintahistoriaa ja analysoida, miten
VR:n hinnat kehittyvät eri reiteillä ajan suhteen.

Hinnat ovat aikuisen perushintoja ilman alennuksia tai lisävalintoja (esim. paikan
valinta, matkustusluokka) — keskitytään pelkkään perushintaan.

## Miten tämä toimii

- **Asemat ja reitit** alustetaan [Digitrafficista](https://www.digitraffic.fi/rautatieliikenne/)
  (avoin rajapinta, sisältää asemakoodit ja -nimet, mutta **ei hintoja**).
- **Hinnat** haetaan VR.fi:n omasta tRPC-rajapinnasta
  (`/api/trpc/journey.searchJourney`). VR.fi on Next.js-sovellus AWS WAF -botisuojauksella,
  joten haku tehdään **Playwrightilla** (oikea Chromium) — selain ratkaisee WAF-haasteen ja me
  kaappaamme sen oman API-vastauksen. Pelkkä HTTP-pyyntö ei toimi (WAF estää).
  Hinnat tulevat rajapinnasta sentteinä (esim. `4930` = 49,30 €).
- **Liikenteen säästö:** ensimmäinen haku tehdään selaimella (ratkaisee WAF-haasteen ja
  hankkii tokenin), minkä jälkeen haut tehdään kevyellä suoralla API-kutsulla joka
  uudelleenkäyttää selaimen evästeitä (~58 KB vs. ~1,6 MB sivulataus, **~96 % vähemmän**).
  Jos suora kutsu epäonnistuu (token vanhentunut/estetty), palataan automaattisesti
  sivulataukseen. Lisäksi turhat pyynnöt (prefetchit, analytiikka) estetään.
- Kullekin reitille haetaan hintatiedot seuraavien **60 päivän** ajalta. Yhdellä reitillä
  voi olla useita lähtöjä päivässä; kustakin lähdöstä tallennetaan hinta.
- Jokainen ajo päivittää taulun `prices` (tuorein hinta per lähtö) ja lisää rivin tauluun
  `price_history` (aikasarja → näkee miten hinta muuttuu lähtöpäivän lähestyessä).
- **Keräyksen jatkaminen:** jos ajo katkeaa, seuraava ajo ohittaa reitti+lähtöpäivät,
  jotka on jo haettu alle `freshnessHours` tuntia sitten (oletus 5 h) — se jatkaa siitä
  mihin jäi sen sijaan että aloittaisi alusta. `0` = hae aina kaikki.
- **Käyttöliittymä** toimii kahdessa moodissa: elävää API-backendia (`npm run serve`) vasten,
  tai täysin staattisena GitHub Pages -julkaisuna (`npm run export`), jolloin `app.js` lukee
  esirenderöityjä JSON-tiedostoja eikä serveriä tarvita lainkaan.

## Tietokanta

Relaatiotietokanta (SQLite), jossa on kolme taulua:

| Taulu           | Sisältö                                                                       |
| --------------- | ----------------------------------------------------------------------------- |
| `routes`        | Seurattavat reitit (lähtö/määränpää, asemanimet)                              |
| `prices`        | Kunkin lähdön **nykyinen** hinta (päivitetään paikallaan)                     |
| `price_history` | Append-only aikasarja: yksi rivi per (reitti, lähtöpäivä, lähtö, keräyspäivä) |

## Päivittäinen ajastus (Windows Task Scheduler)

Paikallinen ajastus omalla koneella — luo tehtävä joka ajaa keräyksen kerran päivässä
(esim. yöllä):

```powershell
$node = (Get-Command node).Source
$proj = "C:\MyTemp\Projektit\vr-price-checker"
$action  = New-ScheduledTaskAction -Execute $node `
  -Argument "$proj\node_modules\tsx\dist\cli.mjs $proj\src\scrape.ts" -WorkingDirectory $proj
$trigger = New-ScheduledTaskTrigger -Daily -At 3:30AM
Register-ScheduledTask -TaskName "VR-hintakeraily" -Action $action -Trigger $trigger
```

Vaihtoehtoisesti tee pieni `scrape.cmd` (`cd /d <proj> && npm run scrape`) ja ajasta se.

Verkossa pyörivään ajoon (GitHub Actions tai oma VPS) katso [DEPLOY.md](DEPLOY.md).

## Julkaisu GitHub Pagesiin (staattinen sivu)

Käyttöliittymän voi julkaista ilmaiseksi GitHub Pagesiin ilman elävää backendia: kannan
sisältö esirenderöidään staattisiksi JSON-tiedostoiksi, ja sivu lukee niitä. Scrape/parsinta
tapahtuu siellä missä ajat sen — ei julkisella palvelimella.

```powershell
npm run scrape      # (valinnainen) kerää tuoreet hinnat
npm run export      # kirjoittaa docs/-kansioon: manifest.json + per-reitti JSON + frontend
npm run deploy      # julkaisee docs/:n gh-pages-haaraan (force push → ei historian kertymää)
```

`app.js` tunnistaa staattisen datan (`data/manifest.json`) ja siirtyy automaattisesti
staattiseen moodiin. Pages tarjoilee sivun osoitteesta
`https://<käyttäjä>.github.io/vr-hintahistoria/`. Päivitä julkaisu ajamalla `export` + `deploy`
uudelleen keräyksen jälkeen.

## Huomioita

- **Kohteliaisuus:** ajo on tahallaan hidas (satunnaisviive + tauot), jotta VR:n palvelinta ei
  kuormiteta liikaa eikä WAF laukea. Älä kasvata tahtia tarpeettomasti.
- **Skeeman varmistus:** ensimmäisellä ajolla tallentuu näyte API-vastauksesta kansioon
  `debug/`. Jos hinnat eivät tallennu, tarkista näytteestä kenttänimet ja säädä tarvittaessa
  jäsentäjää tiedostossa [src/scraper.ts](src/scraper.ts) (funktio `parseOption`).
- Hinnat ovat aikuisen perushintoja ilman alennuksia/lisävalintoja.
