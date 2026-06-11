# VR hintahistoria

Ohjelman tarkoitus on hakea kunkin mahdollisen matkan hinta päivittäin, ja tallentaa ne tietokantaan. Näin voidaan myöhemmin hakea hintahistoriaa ja analysoida hintojen kehitystä.

Ohjelmalla on tarkoitus selvittää, miten VR:n hinnat kehittyvät eri reiteillä ajan suhteen. 

## Miten tieto haetaan

Tieto haetaan VR:n verkkosivulta HTTP-pyyntöjen avulla. Esimerkiksi yhden aikuisen matka Jyväskylästä Seinäjoelle haetaan seuraavalla HTTP-pyynnöllä:

``` 
https://www.vr.fi/kertalippu-menomatkan-hakutulokset?from=JY&to=SK&outboundDate=2026-06-11&passengers[0][type]=ADULT
```

Reitillä on tuona päivänä viisi eri ajankohtaa. Tallennetaan kustakin ajankohdasta hinta tietokantaan, jotta voidaan myöhemmin hakea hintahistoriaa.

Mahdollisia alennuksia tai muita lisävalintoja (esim. paikan valinta, matkustusluokka) ei huomioida tässä vaiheessa, vaan keskitytään vain perushintaan.

## Mitä tietoja haetaan

Kullekin reitille ja kullekin lähdölle haetaan hintatiedot seuraavien 60 päivän ajalta. 

## Tietokanta

Tietokanta on relaatiotietokanta, jossa on kolme taulua: `routes`, `prices` ja `price_history`.

- `routes`-taulu sisältää reittitiedot (lähtö- ja saapumispaikka).
- `prices`-taulu sisältää kunkin reitin nykyisen hinnan.

## Huomioitavaa

VR todennäköisesti rajoittaa HTTP-pyyntöjen määrää, joten on tärkeää huomioida mahdolliset rajoitukset ja varmistaa, että ohjelma ei aiheuta liiallista kuormitusta VR:n palvelimille.