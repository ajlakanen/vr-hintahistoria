# Pystytys VPS:lle (Docker)

Tämä ohje pystyttää koko järjestelmän yhdelle pienelle Linux-VPS:lle: web-käyttöliittymä
pyörii jatkuvasti ja hintojen keräys ajetaan kerran päivässä cronilla. Kaikki ajetaan
Docker-kontissa, joten Chromium ja sen riippuvuudet tulevat valmiina.

## 1. Hanki VPS

Suositus: **vähintään 2 GB RAM** (Chromium on raskas). Esim.:
- Hetzner **CX22** (x86, 2 vCPU / 4 GB, ~4,5 €/kk) tai **CAX11** (ARM, ~4 €/kk)
- DigitalOcean / Vultr / Linode vastaava

Käyttöjärjestelmäksi **Ubuntu 24.04 LTS**.

> ⚠️ **WAF-riski:** VR:n AWS WAF voi suhtautua konesali-IP:hen epäluuloisemmin kuin
> kotiyhteyteen. Tee kohdan 5 yhden reitin testi heti — jos se toimii, kaikki toimii.

## 2. Asenna Docker

```bash
ssh root@PALVELIMEN_IP

curl -fsSL https://get.docker.com | sh
docker --version
docker compose version
```

## 3. Vie koodi palvelimelle

Jos käytät gitiä:
```bash
git clone <repo-url> /opt/vr-price-checker
cd /opt/vr-price-checker
```

Tai kopioi paikallisesta hakemistosta (Windows PowerShell):
```powershell
scp -r . root@PALVELIMEN_IP:/opt/vr-price-checker
```
(älä kopioi `node_modules`, `data`, `browser-data` -kansioita — ne luodaan palvelimella)

## 4. Rakenna image

```bash
cd /opt/vr-price-checker
docker compose build      # lataa Chromiumin, kestää muutaman minuutin
```

## 5. Alusta reitit + testaa WAF yhdellä reitillä

```bash
# Reitit kantaan (asemanimet Digitrafficista)
docker compose run --rm web npm run seed
```

**WAF-savutesti** (varmista että keräys toimii konesali-IP:stä ennen koko ajoa):
muokkaa väliaikaisesti `config.json` → jätä `routes`-listaan vain yksi reitti ja aseta
`"daysAhead": 1`, sitten:
```bash
docker compose run --rm web npm run scrape
docker compose run --rm web npm run report -- JY SK
```
Jos näet hintoja → WAF ei estä, palauta `config.json` ennalleen ja jatka. Jos näet vain
"yritys epäonnistui" -varoituksia → konesali-IP on todennäköisesti estetty (ks. alempaa).

## 6. Käynnistä web-käyttöliittymä

```bash
docker compose up -d
docker compose logs -f web      # näet: "Käyttöliittymä käynnissä: http://0.0.0.0:5173"
```

Avaa selaimessa: **http://PALVELIMEN_IP:5173**

## 7. Aja keräys + ajasta päivittäin

Aja ensimmäinen täysi keräys (taustalla, kestää tunteja rate-limitin takia):
```bash
docker compose run --rm web npm run scrape
```

Päivittäinen ajastus host-cronilla — avaa `crontab -e` ja lisää:
```cron
30 3 * * * cd /opt/vr-price-checker && /usr/bin/docker compose run --rm web npm run scrape >> /var/log/vr-scrape.log 2>&1
```
Tämä ajaa keräyksen joka yö klo 03:30. Web-UI lukee samaa kantaa elävänä, joten uudet
hinnat näkyvät heti.

Edistymisen voi tarkistaa milloin tahansa:
```bash
docker compose run --rm web npm run progress
```

## 8. Tietoturva (suositus)

UI on auki portissa 5173 kaikille. Vähintään:
```bash
# Salli vain SSH ja UI-portti
ufw allow OpenSSH
ufw allow 5173/tcp
ufw enable
```
Parempi: laita eteen **nginx + Let's Encrypt (TLS)** ja halutessasi HTTP Basic Auth, ja
sulje 5173 ulkoa (`ufw deny 5173`). Web-UI on vain luku, mutta julkista nettiä vasten
kannattaa silti suojata.

## Jos konesali-IP on estetty (WAF)

Vaihtoehdot, kasvavassa vaivannäön järjestyksessä:
1. Kokeile toista VPS-tarjoajaa / IP:tä (eri pilvien IP-maine vaihtelee).
2. Lisää keräyksen viiveitä `config.json`:n `rateLimit`-lohkossa.
3. Reititä liikenne **asuinkäyttäjä-proxyn** kautta (lisää kustannusta) — Playwrightin
   `launchPersistentContext`-kutsuun voi lisätä `proxy`-asetuksen [src/scraper.ts](src/scraper.ts).

## Päivitykset

```bash
cd /opt/vr-price-checker
git pull                       # tai kopioi uudet tiedostot
docker compose build
docker compose up -d
```
Data (`data/`) ja selainprofiili (`browser-data/`) säilyvät volumeissa.
