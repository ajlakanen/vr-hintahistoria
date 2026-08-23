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
- **Käyttöliittymä** lukee datansa aina samoista poluista, `data/manifest.json` (seuratut
  suunnat) ja `data/route-<id>.json` (yhden reitin lähdöt ja hintahistoria). GitHub Pagesissa
  ne ovat esirenderöityjä tiedostoja (`npm run export`), omalla palvelimella (`npm run serve`)
  sama sisältö lasketaan lennossa kannasta. Selaimessa ei siis ole moodin tunnistusta eikä
  kahta koodipolkua. Muoto on `RouteBlob` tiedostossa [src/db.ts](src/db.ts), ja sen rakentaa
  molemmissa tapauksissa sama funktio `buildRouteBlob`.

## Tietokanta

Relaatiotietokanta (SQLite), jossa on kolme taulua:

| Taulu           | Sisältö                                                                       |
| --------------- | ----------------------------------------------------------------------------- |
| `routes`        | Seurattavat reitit (lähtö/määränpää, asemanimet)                              |
| `prices`        | Kunkin lähdön **nykyinen** hinta (päivitetään paikallaan)                     |
| `price_history` | Append-only aikasarja: yksi rivi per (reitti, lähtöpäivä, lähtö, keräyspäivä) |

## Käyttöliittymä

Näkymä vastaa ensin kysymykseen "milloin kannattaa matkustaa": kuukausikalenterissa jokainen
päivä näyttää sen päivän halvimman lähdön hintana ja taustavärinä. Päivän
valinta avaa sivupaneeliin päivän lähdöt (oletuksena halvin ensin) ja valitun lähdön
booking-käyrän.

Muutama toteutuksen kannalta olennainen valinta:

- **Kalenteri lasketaan selaimessa** lähtöriveistä, ei kannassa esisummattuna. Syy on
  lähtöaikasuodatin: jos käyttäjä rajaa matkustusajan esim. aamuun, päivän halvin hinta on
  laskettava pelkistä aamulähdöistä. Esisummattu kalenteri lupaisi hinnan, jota ei voi ostaa.
  Siksi `RouteBlob` sisältää vain lähdöt ja historian — ei valmista kalenteria.
- **Vain varattavissa olevat lähdöt** (`available = 1`) kelpaavat päivän halvimmaksi, jottei
  loppuunmyydyn lähdön vanha hinta näytä tarjoukselta.
- **Menneet lähtöpäivät jätetään pois** kaikkialta: kalenterista, tunnusluvuista ja
  lähtömäärästä. Kuukausiruudukossa mennyt päivä säilyttää paikkansa himmeänä numerona,
  jottei viikonpäiväsarakkeiden kohdistus rikkoudu. Kannassa voi olla vanhoja päiviä, koska
  `pruneTravelDatesBefore` ajetaan vasta keräyksen yhteydessä.
- **Väriskaala** on vihreä → keltainen → punainen, mutta näkyvyys seuraa edullisuutta: halvin
  päivä on kylläinen vihreä laatta ja kallein sulautuu taustaan. Askelmat on laskettu
  OKLCh-avaruudessa niin, että kirkkaus muuttuu tasaisesti läpi skaalan — järjestys säilyy
  siis myös punavihersokealle, ja hinta lukee joka tapauksessa numerona jokaisessa ruudussa.
- **Kaksi erillistä väriroolia.** Käyttöliittymän oma sävy on kylmä sininen (aksentti,
  valinnat, linkit, booking-käyrä) ja neutraalit on viritetty samaan suuntaan. Hintaskaalan
  vihreä–punainen on varattu pelkästään datalle. Sama jako pätee pieniin merkintöihin:
  "halvin"-merkki lainaa skaalan halvinta askelmaa, valintarengas on sävytön. Näin mikään
  väri ei tarkoita kahta asiaa.
- **Ei kaaviokirjastoa.** Booking-käyrä piirretään inline-SVG:nä, joten sivulla ei ole
  ulkoisia riippuvuuksia eikä CDN-latausta. Ainoa ulkoinen resurssi on Google Fonts; sen voi
  halutessaan korvata itse tarjoiltavilla fonteilla.
- **Selaimeen tallennetaan** valittu reitti, teema, lähtöaikaikkuna ja lajittelu
  (`localStorage`, polkuun sidottu etuliite `vrhh:<pathname>:`).

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

Export kirjoittaa täsmälleen ne polut joita sivu muutenkin lukee, joten Pages-julkaisu ja
paikallinen palvelin käyttäytyvät identtisesti. Pages tarjoilee sivun osoitteesta
`https://<käyttäjä>.github.io/vr-hintahistoria/`. Päivitä julkaisu ajamalla `export` + `deploy`
uudelleen keräyksen jälkeen.

## Huomioita

- **Kohteliaisuus:** ajo on tahallaan hidas (satunnaisviive + tauot), jotta VR:n palvelinta ei
  kuormiteta liikaa eikä WAF laukea. Älä kasvata tahtia tarpeettomasti.
- **Skeeman varmistus:** ensimmäisellä ajolla tallentuu näyte API-vastauksesta kansioon
  `debug/`. Jos hinnat eivät tallennu, tarkista näytteestä kenttänimet ja säädä tarvittaessa
  jäsentäjää tiedostossa [src/scraper.ts](src/scraper.ts) (funktio `parseOption`).
- Hinnat ovat aikuisen perushintoja ilman alennuksia/lisävalintoja.
