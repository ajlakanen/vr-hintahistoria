import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { DATA_DIR, DB_PATH } from "./config.ts";
import type { JourneyPrice, RouteRow } from "./types.ts";

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  // Odota lukon vapautumista jopa 5 s ennen "database is locked" -virhettä. Estää
  // törmäykset, kun web-UI lukee kantaa samalla kun scrape kirjoittaa (WAL sallii
  // rinnakkaisen lukijan + yhden kirjoittajan, mutta lyhyet lukkohetket ovat silti mahdollisia).
  db.exec("PRAGMA busy_timeout = 5000;");
  initSchema(db);
  return db;
}

function initSchema(d: DatabaseSync): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS routes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      from_code  TEXT NOT NULL,
      to_code    TEXT NOT NULL,
      from_name  TEXT,
      to_name    TEXT,
      active     INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (from_code, to_code)
    );

    -- Nykyinen (tuorein) hinta per lähtö. Päivitetään paikallaan.
    -- available: 1 = varattavissa, 0 = loppuunmyyty / ei enää varattavissa (hinta on
    -- viimeksi tiedetty hinta). Lähiajan lähtö voi myydä loppuun seurannan aikana.
    CREATE TABLE IF NOT EXISTS prices (
      route_id       INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
      travel_date    TEXT NOT NULL,
      departure_time TEXT NOT NULL,
      train_number   TEXT,
      train_type     TEXT,
      price          REAL NOT NULL,
      currency       TEXT NOT NULL DEFAULT 'EUR',
      available      INTEGER NOT NULL DEFAULT 1,
      updated_at     TEXT NOT NULL,
      PRIMARY KEY (route_id, travel_date, departure_time, train_number)
    );

    -- Aikasarja (booking-käyrä) "store-on-change"-muodossa: yksi rivi = SEGMENTTI, jonka
    -- aikana hinta ja saatavuus pysyivät samana. scrape_date = segmentin alku (ensimmäinen
    -- keräyspäivä tällä hinnalla), last_scrape_date = segmentin loppu (viimeisin keräyspäivä,
    -- jolloin sama hinta vielä havaittiin). Muuttumaton keräys vain pidentää segmenttiä, eikä
    -- lisää uutta riviä -> kanta ei paisu (VR:n hinnat ovat tahmeita). Näyttöä varten segmentit
    -- laajennetaan takaisin päiväkohtaiseksi sarjaksi (expandHistorySegments).
    -- available kertoo oliko lähtö varattavissa segmentin aikana.
    CREATE TABLE IF NOT EXISTS price_history (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      route_id         INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
      travel_date      TEXT NOT NULL,
      departure_time   TEXT NOT NULL,
      train_number     TEXT,
      price            REAL NOT NULL,
      currency         TEXT NOT NULL DEFAULT 'EUR',
      available        INTEGER NOT NULL DEFAULT 1,
      scrape_date      TEXT NOT NULL,
      last_scrape_date TEXT,
      scraped_at       TEXT NOT NULL,
      UNIQUE (route_id, travel_date, departure_time, train_number, scrape_date)
    );

    CREATE INDEX IF NOT EXISTS idx_history_lookup
      ON price_history (route_id, travel_date, departure_time);
    CREATE INDEX IF NOT EXISTS idx_history_scrape
      ON price_history (route_id, scrape_date);
  `);

  // Migraatio vanhoille kannoille: lisää 'available'-sarake jos se puuttuu.
  addColumnIfMissing(d, "prices", "available", "INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing(d, "price_history", "available", "INTEGER NOT NULL DEFAULT 1");

  // Migraatio store-on-change-muotoon: lisää segmentin loppu. Vanhat päiväkohtaiset rivit
  // ovat yhden päivän segmenttejä (last_scrape_date = scrape_date). Mitään ei poisteta.
  if (addColumnIfMissing(d, "price_history", "last_scrape_date", "TEXT")) {
    d.exec("UPDATE price_history SET last_scrape_date = scrape_date WHERE last_scrape_date IS NULL");
  }
}

/** Lisää sarakkeen tauluun jos sitä ei vielä ole. Palauttaa true jos sarake lisättiin. */
function addColumnIfMissing(d: DatabaseSync, table: string, column: string, def: string): boolean {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return false;
  d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  return true;
}

export function upsertRoute(
  fromCode: string,
  toCode: string,
  fromName: string | null,
  toName: string | null
): number {
  const d = getDb();
  d.prepare(
    `INSERT INTO routes (from_code, to_code, from_name, to_name)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (from_code, to_code)
     DO UPDATE SET from_name = excluded.from_name,
                   to_name   = excluded.to_name,
                   active    = 1`
  ).run(fromCode, toCode, fromName, toName);
  const row = d
    .prepare("SELECT id FROM routes WHERE from_code = ? AND to_code = ?")
    .get(fromCode, toCode) as { id: number };
  return row.id;
}

export function getActiveRoutes(): RouteRow[] {
  return getDb()
    .prepare("SELECT * FROM routes WHERE active = 1 ORDER BY from_code, to_code")
    .all() as unknown as RouteRow[];
}

export function getRouteByCodes(fromCode: string, toCode: string): RouteRow | undefined {
  return getDb()
    .prepare("SELECT * FROM routes WHERE from_code = ? AND to_code = ?")
    .get(fromCode, toCode) as unknown as RouteRow | undefined;
}

/**
 * Palauttaa tuoreimman scrape-hetken (scraped_at, UTC ISO) annetulle reitti+lähtöpäivä
 * -yhdistelmälle, tai null jos sitä ei ole vielä kertaakaan haettu. Käytetään keräyksen
 * jatkamiseen: tuoretta yhdistelmää ei haeta uudestaan.
 */
export function lastScrapedAt(routeId: number, travelDate: string): string | null {
  const row = getDb()
    .prepare(
      `SELECT MAX(scraped_at) AS last
       FROM price_history
       WHERE route_id = ? AND travel_date = ?`
    )
    .get(routeId, travelDate) as { last: string | null } | undefined;
  return row?.last ?? null;
}

/**
 * Poistaa menneiden päivien hinnat/hintahistorian, jotta kanta ei kasva rajatta.
 * cutoffDate pidetään mukana (eli poistetaan vain travel_date < cutoffDate).
 */
export function pruneTravelDatesBefore(cutoffDate: string): {
  pricesDeleted: number;
  historyDeleted: number;
} {
  const d = getDb();
  const historyRes = d.prepare(`DELETE FROM price_history WHERE travel_date < ?`).run(cutoffDate) as {
    changes?: number;
  };
  const pricesRes = d.prepare(`DELETE FROM prices WHERE travel_date < ?`).run(cutoffDate) as {
    changes?: number;
  };
  return {
    pricesDeleted: pricesRes.changes ?? 0,
    historyDeleted: historyRes.changes ?? 0,
  };
}

/**
 * Kirjaa yhden booking-käyrän pisteen "store-on-change"-periaatteella: jos lähdön hinta ja
 * saatavuus ovat samat kuin sen viimeisimmässä segmentissä, vain pidennetään segmenttiä
 * (last_scrape_date -> scrapeDate) eikä lisätä uutta riviä. Muutoksella (tai ensihavainnolla)
 * lisätään uusi segmentti. Palauttaa true jos uusi segmentti syntyi (= hinta/saatavuus muuttui).
 *
 * COALESCE(train_number,'') sietää sekä uudet ("") että vanhat (NULL) junanumerot.
 */
function recordHistoryPoint(
  d: DatabaseSync,
  routeId: number,
  travelDate: string,
  departureTime: string,
  trainNumber: string | null,
  price: number,
  currency: string,
  available: number,
  scrapeDate: string,
  now: string
): boolean {
  const tn = trainNumber ?? "";
  const last = d
    .prepare(
      `SELECT id, price, available, scrape_date, last_scrape_date
       FROM price_history
       WHERE route_id = ? AND travel_date = ? AND departure_time = ? AND COALESCE(train_number,'') = ?
       ORDER BY scrape_date DESC LIMIT 1`
    )
    .get(routeId, travelDate, departureTime, tn) as
    | { id: number; price: number; available: number; scrape_date: string; last_scrape_date: string | null }
    | undefined;

  if (last && last.price === price && last.available === available) {
    // Muuttumaton -> pidennä viimeisintä segmenttiä (ei uutta riviä). Päivitä myös scraped_at,
    // jotta lastScrapedAt (freshness) pysyy tuoreena. Ei siirretä loppua taaksepäin.
    const end = last.last_scrape_date ?? last.scrape_date;
    if (scrapeDate >= end) {
      d.prepare(`UPDATE price_history SET last_scrape_date = ?, scraped_at = ? WHERE id = ?`)
        .run(scrapeDate, now, last.id);
    }
    return false;
  }

  // Muutos tai ensimmäinen havainto -> uusi segmentti. Saman päivän toistohaku (sama scrape_date)
  // ylikirjoittaa pisteen tuoreimmalla arvolla.
  d.prepare(
    `INSERT INTO price_history
       (route_id, travel_date, departure_time, train_number, price, currency, available, scrape_date, last_scrape_date, scraped_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (route_id, travel_date, departure_time, train_number, scrape_date)
     DO UPDATE SET price            = excluded.price,
                   available        = excluded.available,
                   last_scrape_date = excluded.last_scrape_date,
                   scraped_at       = excluded.scraped_at`
  ).run(routeId, travelDate, departureTime, tn, price, currency, available, scrapeDate, scrapeDate, now);
  return true;
}

/**
 * Tallentaa yhden lähdön hinnan: päivittää 'prices' (upsert) ja kirjaa booking-käyrän pisteen
 * store-on-change-periaatteella. Palauttaa true jos hinta/saatavuus muuttui (uusi segmentti).
 */
export function recordPrice(routeId: number, p: JourneyPrice, scrapeDate: string): boolean {
  const d = getDb();
  const now = new Date().toISOString();
  // train_number on osa avainta -> ei NULL (NULLit ovat SQLitessä keskenään erillisiä).
  const trainNumber = p.trainNumber ?? "";
  // Tuloksissa hinnalla näkyvä lähtö on ostettavissa -> available=1 (myös NOT_BOOKABLE-
  // lähijunat: niihin ei voi varata paikkaa, mutta lipun voi ostaa). Loppuunmyynti (=ei voi
  // enää ostaa) tunnistetaan vain katoamisesta, ei tästä. Jos lähtö oli aiemmin merkitty
  // loppuunmyydyksi ja palaa tuloksiin, available palautuu takaisin 1:ksi.
  const available = 1;

  d.prepare(
    `INSERT INTO prices
       (route_id, travel_date, departure_time, train_number, train_type, price, currency, available, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (route_id, travel_date, departure_time, train_number)
     DO UPDATE SET train_type   = excluded.train_type,
                   price        = excluded.price,
                   currency     = excluded.currency,
                   available    = excluded.available,
                   updated_at   = excluded.updated_at`
  ).run(
    routeId,
    p.travelDate,
    p.departureTime,
    trainNumber,
    p.trainType,
    p.price,
    p.currency,
    available,
    now
  );

  return recordHistoryPoint(
    d,
    routeId,
    p.travelDate,
    p.departureTime,
    trainNumber,
    p.price,
    p.currency,
    available,
    scrapeDate,
    now
  );
}

/**
 * Merkitsee loppuunmyydyiksi ne reitin lähtöpäivän lähdöt, jotka olivat aiemmin
 * varattavissa (available=1) mutta jotka EIVÄT enää löydy tuoreesta hakutuloksesta
 * (presentKeys). Säilyttää viimeksi tiedetyn hinnan, mutta asettaa available=0 ja
 * kirjaa yhden "ei varattavissa" -pisteen booking-käyrään (price_history) tälle
 * keräyspäivälle. Palauttaa loppuunmyydyiksi merkittyjen lähtöjen määrän.
 *
 * presentKeys: joukko avaimia muotoa `${departure_time} ${train_number}`, missä
 * train_number on tyhjä merkkijono jos sitä ei ole (sama normalisointi kuin prices-taulussa).
 */
export function markDeparturesSoldOut(
  routeId: number,
  travelDate: string,
  presentKeys: Set<string>,
  scrapeDate: string
): number {
  const d = getDb();
  const now = new Date().toISOString();
  const existing = d
    .prepare(
      `SELECT departure_time, train_number, price, currency
       FROM prices
       WHERE route_id = ? AND travel_date = ? AND available = 1`
    )
    .all(routeId, travelDate) as {
    departure_time: string;
    train_number: string | null;
    price: number;
    currency: string;
  }[];

  const markPrice = d.prepare(
    `UPDATE prices SET available = 0, updated_at = ?
     WHERE route_id = ? AND travel_date = ? AND departure_time = ? AND train_number = ?`
  );

  let count = 0;
  for (const row of existing) {
    const trainNumber = row.train_number ?? "";
    if (presentKeys.has(`${row.departure_time} ${trainNumber}`)) continue;
    markPrice.run(now, routeId, travelDate, row.departure_time, trainNumber);
    // Loppuunmyynti = saatavuus muuttuu 1 -> 0: store-on-change kirjaa siitä uuden segmentin
    // (ja seuraavat samanlaiset keräyspäivät vain pidentävät sitä).
    recordHistoryPoint(
      d,
      routeId,
      travelDate,
      row.departure_time,
      trainNumber,
      row.price,
      row.currency,
      0,
      scrapeDate,
      now
    );
    count++;
  }
  return count;
}

/** Yksi näytettävä booking-käyrän piste (yhden keräyspäivän hinta/saatavuus). */
export interface HistoryPoint {
  scrapeDate: string;
  price: number;
  currency: string;
  available: number;
}

/** Tallennettu segmentti: vakiohinta välillä [scrapeDate, lastScrapeDate]. */
export interface HistorySegment extends HistoryPoint {
  lastScrapeDate: string | null;
}

/** Päivät "YYYY-MM-DD" välillä [start, end] (mukaan lukien). UTC-pohjainen askellus. */
function eachDateInclusive(start: string, end: string): string[] {
  if (end < start) return [start];
  const out: string[] = [];
  const cur = new Date(start + "T00:00:00Z");
  const last = new Date(end + "T00:00:00Z");
  while (cur <= last) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

/**
 * Laajentaa store-on-change-segmentit takaisin päiväkohtaiseksi sarjaksi näyttöä varten:
 * jokainen segmentti [scrapeDate, lastScrapeDate] tuottaa pisteen joka päivälle samalla
 * hinnalla/saatavuudella. Näin booking-käyrä piirtyy täsmälleen kuten ennenkin, vaikka kanta
 * tallentaa vain muutoskohdat. Segmentit oletetaan järjestetyiksi scrape_date-nousevasti.
 */
export function expandHistorySegments(segments: HistorySegment[]): HistoryPoint[] {
  const out: HistoryPoint[] = [];
  for (const s of segments) {
    for (const date of eachDateInclusive(s.scrapeDate, s.lastScrapeDate ?? s.scrapeDate)) {
      out.push({ scrapeDate: date, price: s.price, currency: s.currency, available: s.available });
    }
  }
  return out;
}
