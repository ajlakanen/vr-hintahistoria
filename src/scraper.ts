import { chromium, type BrowserContext, type Page, type Response } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PROJECT_ROOT } from "./config.ts";
import { log } from "./logger.ts";
import type { JourneyPrice, Passenger } from "./types.ts";

const BASE = "https://www.vr.fi/kertalippu-menomatkan-hakutulokset";

// Analytiikka / kolmannet osapuolet, joita ei tarvita hintahakuun (EI awswaf.com!).
const BLOCKED_HOSTS = [
  "googletagmanager.com",
  "google-analytics.com",
  "analytics.google.com",
  "doubleclick.net",
  "connect.facebook.net",
  "facebook.com",
  "tiktok.com",
  "hotjar",
  "cookiebot",
  "onetrust",
  "clarity.ms",
  "ingest.sentry.io",
  "nr-data.net",
];

/**
 * Päättää estetäänkö pyyntö liikenteen säästämiseksi. EI estä: pääsivua, sovelluksen
 * JS/CSS:ää (_next/static), AWS WAF -haastetta (awswaf.com) eikä hintahakua
 * (/api/trpc/journey.searchJourney).
 */
export function shouldAbortRequest(resourceType: string, url: string): boolean {
  if (resourceType === "image" || resourceType === "media" || resourceType === "font") return true;
  // Next.js RSC-prefetchit muille sivuille (valikon linkit) — turhia hintahaulle.
  if (url.includes("_rsc=")) return true;
  // Analytiikka ja kolmannet osapuolet.
  if (BLOCKED_HOSTS.some((h) => url.includes(h))) return true;
  // VR:n omat ei-hintaan liittyvät kutsut.
  if (url.includes("/api/latest/notifications")) return true;
  if (url.includes("/api/trpc/disruptions")) return true;
  return false;
}
// Hintahaku menee VR.fi:n tRPC-rajapintaan (ei /graphql):
//   GET /api/trpc/journey.searchJourney?batch=1&input=...
const API_MARKER = "journey.searchJourney";
const USER_DATA_DIR = join(PROJECT_ROOT, "browser-data");
const DEBUG_DIR = join(PROJECT_ROOT, "debug");

/**
 * Selainpohjainen scraper. Käyttää oikeaa Chromiumia, jotta AWS WAF -haaste
 * ratkeaa automaattisesti, ja kaappaa sivun oman searchJourney-vastauksen.
 */
export class VrScraper {
  private ctx: BrowserContext | null = null;
  private page: Page | null = null;
  private debugSaved = false;
  // Onko WAF-token jo hankittu (sivulataus tehty)? Tämän jälkeen voidaan käyttää
  // kevyttä suoraa API-kutsua, joka uudelleenkäyttää selaimen evästeitä.
  private warmed = false;

  constructor(private headless: boolean) {}

  async init(): Promise<void> {
    mkdirSync(USER_DATA_DIR, { recursive: true });
    this.ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: this.headless,
      locale: "fi-FI",
      timezoneId: "Europe/Helsinki",
      viewport: { width: 1366, height: 900 },
      // Tarvitaan kun ajetaan Docker-kontissa / palvelimella (root, ei /dev/shm tilaa).
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    this.page = await this.ctx.newPage();
    // Estetään turhat pyynnöt (resurssit, prefetchit, analytiikka) liikenteen säästämiseksi.
    await this.page.route("**/*", (route) => {
      if (shouldAbortRequest(route.request().resourceType(), route.request().url())) {
        return route.abort();
      }
      return route.continue();
    });
  }

  async close(): Promise<void> {
    await this.ctx?.close();
    this.ctx = null;
    this.page = null;
  }

  private buildUrl(from: string, to: string, date: string, passengers: Passenger[]): string {
    const params = new URLSearchParams();
    params.set("from", from);
    params.set("to", to);
    params.set("outboundDate", date);
    let url = `${BASE}?${params.toString()}`;
    passengers.forEach((p, i) => {
      url += `&passengers[${i}][type]=${encodeURIComponent(p.type)}`;
    });
    return url;
  }

  /** tRPC-hintahaun suora URL (sama jonka sivun sovellus muodostaa). */
  private buildTrpcUrl(from: string, to: string, date: string, passengers: Passenger[]): string {
    const input = {
      "0": {
        locale: "fi",
        arrivalStation: to,
        departureStation: from,
        departureTime: date,
        passengers: passengers.map((p) => ({
          key: randomUUID(),
          type: p.type,
          wheelchair: false,
          vehicles: [],
        })),
        placeTypes: ["SEAT", "CABIN_SEAT", "CABIN_BED"],
        filters: [],
      },
    };
    return (
      "https://www.vr.fi/api/trpc/journey.searchJourney?batch=1&input=" +
      encodeURIComponent(JSON.stringify(input))
    );
  }

  /**
   * Hakee yhden reitin yhden päivän lähdöt hintoineen.
   *
   * Ensimmäinen haku tehdään sivulatauksella (ratkaisee WAF-haasteen, hankkii tokenin).
   * Sen jälkeen käytetään kevyttä suoraa API-kutsua (~95 % vähemmän liikennettä), joka
   * uudelleenkäyttää selaimen evästeitä. Jos suora kutsu epäonnistuu (token vanhentunut
   * tai estetty), palataan automaattisesti sivulataukseen — mikään ei riko.
   */
  async fetchJourneys(
    from: string,
    to: string,
    date: string,
    passengers: Passenger[],
    timeoutMs = 30000
  ): Promise<JourneyPrice[]> {
    if (!this.ctx) throw new Error("Scraperia ei ole alustettu (init).");

    if (this.warmed) {
      try {
        return await this.fetchViaApi(from, to, date, passengers, timeoutMs);
      } catch (e) {
        log.warn(`Suora API-kutsu epäonnistui (${(e as Error).message}) — päivitetään token sivulatauksella.`);
        this.warmed = false;
      }
    }

    const journeys = await this.fetchViaPage(from, to, date, passengers, timeoutMs);
    this.warmed = true;
    return journeys;
  }

  /** Kevyt suora kutsu tRPC-rajapintaan, käyttää selaimen WAF-evästettä. */
  private async fetchViaApi(
    from: string,
    to: string,
    date: string,
    passengers: Passenger[],
    timeoutMs: number
  ): Promise<JourneyPrice[]> {
    const res = await this.ctx!.request.get(this.buildTrpcUrl(from, to, date, passengers), {
      timeout: timeoutMs,
      headers: {
        accept: "*/*",
        referer: "https://www.vr.fi/kertalippu-menomatkan-hakutulokset",
        "x-trpc-source": "client",
      },
    });
    if (!res.ok()) throw new Error(`API vastasi ${res.status()}`);
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new Error("API-vastaus ei ollut JSON (mahd. WAF-haaste)");
    }
    const result = parseCaptured([json]);
    if (!result.ok) throw new Error("API-vastausta ei voitu jäsentää");
    return result.journeys;
  }

  /** Raskaampi varatie: lataa hakusivun selaimella ja kaappaa sen API-vastauksen. */
  private async fetchViaPage(
    from: string,
    to: string,
    date: string,
    passengers: Passenger[],
    timeoutMs: number
  ): Promise<JourneyPrice[]> {
    if (!this.page) throw new Error("Scraperia ei ole alustettu (init).");
    const page = this.page;
    const captured: unknown[] = [];

    const handler = async (resp: Response) => {
      if (!resp.url().includes(API_MARKER)) return;
      if (resp.status() !== 200) return;
      try {
        captured.push(await resp.json());
      } catch {
        /* ei-JSON vastaus */
      }
    };
    page.on("response", handler);

    try {
      await page.goto(this.buildUrl(from, to, date, passengers), {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs,
      });

      const deadline = Date.now() + timeoutMs;
      let result: { ok: boolean; journeys: JourneyPrice[] } = { ok: false, journeys: [] };
      while (Date.now() < deadline) {
        result = parseCaptured(captured);
        if (result.ok) break;
        await page.waitForTimeout(400);
      }

      if (!this.debugSaved && captured.length > 0) {
        this.saveDebug(captured, from, to, date);
        this.debugSaved = true;
      }
      if (!result.ok) {
        throw new Error("searchJourney-vastausta ei saatu (mahd. WAF-haaste tai aikakatkaisu).");
      }
      return result.journeys;
    } finally {
      page.off("response", handler);
    }
  }

  private saveDebug(captured: unknown[], from: string, to: string, date: string): void {
    try {
      mkdirSync(DEBUG_DIR, { recursive: true });
      const file = join(DEBUG_DIR, `searchJourney-${from}-${to}-${date}.json`);
      writeFileSync(file, JSON.stringify(captured, null, 2), "utf8");
      log.info(`Tallennettiin vastauksen näyte: ${file}`);
    } catch {
      /* debug-tallennus ei saa kaataa ajoa */
    }
  }
}

// ---------- jäsentäjä ----------

/**
 * tRPC-batch-vastaus on muotoa: [ { result: { data: { status, options: [...] } } } ].
 * Palauttaa ok=true heti kun saadaan onnistunut vastaus (myös tyhjä options on validi
 * "ei junia" -tilanne).
 */
function parseCaptured(captured: unknown[]): { ok: boolean; journeys: JourneyPrice[] } {
  for (const json of captured) {
    const data = extractData(json);
    if (!data) continue;
    if (data.status && data.status !== "success") continue;
    const options = Array.isArray(data.options) ? data.options : [];
    const journeys = options
      .map(parseOption)
      .filter((x): x is JourneyPrice => x !== null);
    return { ok: true, journeys: dedupe(journeys) };
  }
  return { ok: false, journeys: [] };
}

function extractData(json: unknown): { status?: string; options?: unknown[] } | null {
  // Batch: taulukon ensimmäinen alkio. Joskus voi olla suora objekti.
  const entry = Array.isArray(json) ? json[0] : json;
  const data = (entry as any)?.result?.data;
  if (data && typeof data === "object") return data;
  return null;
}

function parseOption(o: unknown): JourneyPrice | null {
  if (!o || typeof o !== "object") return null;
  const opt = o as Record<string, any>;

  const departureAt: string | undefined = opt.departureTime;
  const cents = typeof opt.totalPrice === "number" ? opt.totalPrice : null;
  if (cents === null || cents <= 0 || !departureAt) return null;

  const firstLeg = Array.isArray(opt.legs) && opt.legs.length > 0 ? opt.legs[0] : null;

  // HUOM: availability.seatAvailability="NOT_BOOKABLE" tarkoittaa vain ettei lähtöön voi
  // tehdä PAIKANVARAUSTA (esim. lähijunat, trainType "LOL") — lipun voi silti ostaa. Se ei
  // siis ole loppuunmyynti. Ainoa "ei voi enää ostaa" -signaali on, että lähtö katoaa
  // hakutuloksista kokonaan (ks. markDeparturesSoldOut). Tuloksissa hinnalla näkyvä lähtö
  // on siis aina ostettavissa.
  return {
    travelDate: departureAt.slice(0, 10),
    departureTime: departureAt.slice(11, 16),
    departureAt,
    trainNumber: firstLeg?.trainNumber != null ? String(firstLeg.trainNumber) : null,
    trainType: firstLeg?.trainType ?? null,
    price: Math.round(cents) / 100, // sentit -> eurot
    currency: "EUR",
  };
}

function dedupe(list: JourneyPrice[]): JourneyPrice[] {
  const seen = new Set<string>();
  const out: JourneyPrice[] = [];
  for (const j of list) {
    const key = `${j.departureTime}|${j.trainNumber ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(j);
  }
  return out.sort((a, b) => a.departureTime.localeCompare(b.departureTime));
}
