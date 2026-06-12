# VR hintahistoria

Hakee VR:n kaukoliikenteen aikuisen peruslippujen hinnat päivittäin ja tallentaa
ne SQLite-tietokantaan, jotta hintojen kehitystä voi seurata ajan suhteen.
Mukana selainpohjainen käyttöliittymä hintahistorian tarkasteluun.

🔗 **Julkinen näkymä:** https://ajlakanen.github.io/vr-hintahistoria/ (staattinen GitHub Pages -julkaisu, päivittyy kun data julkaistaan).

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
- Jokainen ajo päivittää taulun `prices` (tuorein hinta per lähtö) ja lisää rivin tauluun
  `price_history` (aikasarja → näkee miten hinta muuttuu lähtöpäivän lähestyessä).
- **Keräyksen jatkaminen:** jos ajo katkeaa, seuraava ajo ohittaa reitti+lähtöpäivät,
  jotka on jo haettu alle `freshnessHours` tuntia sitten (oletus 5 h) — se jatkaa siitä
  mihin jäi sen sijaan että aloittaisi alusta. `0` = hae aina kaikki.
- **Käyttöliittymä** toimii kahdessa moodissa: elävää API-backendia (`npm run serve`) vasten,
  tai täysin staattisena GitHub Pages -julkaisuna (`npm run export`), jolloin `app.js` lukee
  esirenderöityjä JSON-tiedostoja eikä serveriä tarvita lainkaan.

## Tietokanta

| Taulu           | Sisältö                                                                       |
| --------------- | ----------------------------------------------------------------------------- |
| `routes`        | Seurattavat reitit (lähtö/määränpää, asemanimet)                              |
| `prices`        | Kunkin lähdön **nykyinen** hinta (päivitetään paikallaan)                     |
| `price_history` | Append-only aikasarja: yksi rivi per (reitti, lähtöpäivä, lähtö, keräyspäivä) |

## Asennus

Vaatii **Node.js ≥ 22.5** (käyttää sisäänrakennettua `node:sqlite`-moduulia).

```powershell
npm install            # asentaa riippuvuudet + lataa Chromiumin (Playwright)
```

## Käyttö

```powershell
# 1) Alusta reitit config.json:sta (täyttää asemanimet Digitrafficista)
npm run seed

# 2) Aja hintojen keräys (kestää: ~reitit × 60 päivää, rate-limitattu)
npm run scrape

# 2b) Seuraa keräyksen edistymistä (toisessa ikkunassa, milloin tahansa)
npm run progress

# 3) Käynnistä käyttöliittymä ja avaa selaimessa http://localhost:5173
npm run serve

# (valinnainen) pikaraportti komentoriviltä
npm run report -- HKI TPE
```

## Reittien muokkaus

Muokkaa [config.json](config.json):n `routes`-listaa (asemakoodit, esim. `HKI`, `TPE`, `JY`).
`bothDirections: true` kerää automaattisesti molemmat suunnat. Aja `npm run seed` uudelleen
muutosten jälkeen.

> **Kuorma:** jokainen reitti × 60 päivää = oma haku. Pidä reittilista maltillisena.
> Rate limit -asetukset (viiveet, tauot) ovat `config.json`:n `rateLimit`-lohkossa.

## Päivittäinen ajastus (Windows Task Scheduler)

Luo tehtävä joka ajaa keräyksen kerran päivässä (esim. yöllä):

```powershell
$node = (Get-Command node).Source
$proj = "C:\MyTemp\Projektit\vr-price-checker"
$action  = New-ScheduledTaskAction -Execute $node `
  -Argument "$proj\node_modules\tsx\dist\cli.mjs $proj\src\scrape.ts" -WorkingDirectory $proj
$trigger = New-ScheduledTaskTrigger -Daily -At 3:30AM
Register-ScheduledTask -TaskName "VR-hintakeraily" -Action $action -Trigger $trigger
```

Vaihtoehtoisesti tee pieni `scrape.cmd` (`cd /d <proj> && npm run scrape`) ja ajasta se.

## Pystytys palvelimelle (VPS, jatkuva ajo)

Jos haluat järjestelmän pyörimään verkossa ilman omaa konetta, katso **[DEPLOY.md](DEPLOY.md)**
— Docker-pohjainen ohje pienelle Linux-VPS:lle (web-UI jatkuvasti päällä + päivittäinen
keräys cronilla, Chromium valmiina kontissa).

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
- Hinnat ovat aikuisen perushintoja ilman alennuksia/lisävalintoja (specin mukaisesti).
```
