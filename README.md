# VR hintahistoria

Hakee VR:n kaukoliikenteen aikuisen peruslippujen hinnat päivittäin ja tallentaa
ne SQLite-tietokantaan, jotta hintojen kehitystä voi seurata ajan suhteen.
Mukana selainpohjainen käyttöliittymä hintahistorian tarkasteluun.

🔗 **Julkinen näkymä:** https://ajlakanen.github.io/vr-hintahistoria/

Ohjelma kerää hinnat eri reiteille seuraavien 60 päivän ajalta, tallentaa sekä
tuoreimman hinnan että aikasarjan (näkee miten hinta muuttuu lähtöpäivän
lähestyessä). Käyttöliittymän voi ajaa joko omaa backendia vasten tai julkaista
staattisena GitHub Pages -sivuna.

Toteutuksen tekniset yksityiskohdat löytyvät tiedostosta [specs.md](specs.md).

## Käyttöönotto omalla koneella

Vaatii **Node.js ≥ 22.5** (käyttää sisäänrakennettua `node:sqlite`-moduulia).

```powershell
npm install            # asentaa riippuvuudet + lataa Chromiumin (Playwright)
```

Sen jälkeen:

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

## Keräyksen ajastus

Keräys kannattaa ajaa kerran päivässä. Muutama vaihtoehto:

- **GitHub Actions** – kätevin tapa pitää keräys käynnissä ilman omaa konetta.
  Ilmainen tiettyyn käyttörajaan asti, ja Actionsin IP läpäisee VR:n botisuojauksen.
- **Oma VPS** – jos haluat myös web-UI:n jatkuvasti verkossa, katso Docker-pohjainen
  ohje tiedostossa [DEPLOY.md](DEPLOY.md).
- **Windows Task Scheduler** – paikallinen ajastus omalla koneella; esimerkki on
  [specs.md](specs.md):ssä.

