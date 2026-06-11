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
    CREATE TABLE IF NOT EXISTS prices (
      route_id       INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
      travel_date    TEXT NOT NULL,
      departure_time TEXT NOT NULL,
      train_number   TEXT,
      train_type     TEXT,
      price          REAL NOT NULL,
      currency       TEXT NOT NULL DEFAULT 'EUR',
      updated_at     TEXT NOT NULL,
      PRIMARY KEY (route_id, travel_date, departure_time, train_number)
    );

    -- Aikasarja: jokainen ajo lisää rivin -> nähdään miten lähdön hinta kehittyy.
    CREATE TABLE IF NOT EXISTS price_history (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      route_id       INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
      travel_date    TEXT NOT NULL,
      departure_time TEXT NOT NULL,
      train_number   TEXT,
      price          REAL NOT NULL,
      currency       TEXT NOT NULL DEFAULT 'EUR',
      scrape_date    TEXT NOT NULL,
      scraped_at     TEXT NOT NULL,
      UNIQUE (route_id, travel_date, departure_time, train_number, scrape_date)
    );

    CREATE INDEX IF NOT EXISTS idx_history_lookup
      ON price_history (route_id, travel_date, departure_time);
    CREATE INDEX IF NOT EXISTS idx_history_scrape
      ON price_history (route_id, scrape_date);
  `);
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
 * Tallentaa yhden lähdön hinnan: päivittää 'prices' (upsert) ja lisää
 * 'price_history' -rivin (yksi per ajopäivä). Palauttaa true jos uusi historiarivi syntyi.
 */
export function recordPrice(routeId: number, p: JourneyPrice, scrapeDate: string): boolean {
  const d = getDb();
  const now = new Date().toISOString();
  // train_number on osa avainta -> ei NULL (NULLit ovat SQLitessä keskenään erillisiä).
  const trainNumber = p.trainNumber ?? "";

  d.prepare(
    `INSERT INTO prices
       (route_id, travel_date, departure_time, train_number, train_type, price, currency, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (route_id, travel_date, departure_time, train_number)
     DO UPDATE SET train_type   = excluded.train_type,
                   price        = excluded.price,
                   currency     = excluded.currency,
                   updated_at   = excluded.updated_at`
  ).run(
    routeId,
    p.travelDate,
    p.departureTime,
    trainNumber,
    p.trainType,
    p.price,
    p.currency,
    now
  );

  const res = d
    .prepare(
      `INSERT OR IGNORE INTO price_history
         (route_id, travel_date, departure_time, train_number, price, currency, scrape_date, scraped_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      routeId,
      p.travelDate,
      p.departureTime,
      p.trainNumber,
      p.price,
      p.currency,
      scrapeDate,
      now
    );
  return res.changes > 0;
}
