import { log } from "./logger.ts";

const STATIONS_URL = "https://rata.digitraffic.fi/api/v1/metadata/stations";

interface DtStation {
  stationName: string;
  stationShortCode: string;
  passengerTraffic: boolean;
  countryCode: string;
}

/**
 * Hakee asemametadatan Digitrafficista (avoin rajapinta, ei WAF-suojausta).
 * Palauttaa map: stationShortCode -> siisti asemanimi.
 */
export async function fetchStationNames(): Promise<Map<string, string>> {
  log.info("Haetaan asemametadata Digitrafficista…");
  const res = await fetch(STATIONS_URL, {
    headers: {
      // Digitraffic suosittelee yksilöivää User-tunnistetta.
      "Digitraffic-User": "vr-price-checker",
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`Digitraffic vastasi ${res.status} ${res.statusText}`);
  }
  const stations = (await res.json()) as DtStation[];
  const map = new Map<string, string>();
  for (const s of stations) {
    if (s.countryCode !== "FI") continue;
    // Siistitään " asema" -pääte pois (esim. "Helsinki asema" -> "Helsinki").
    const name = s.stationName.replace(/\s+asema$/i, "").trim();
    map.set(s.stationShortCode, name);
  }
  log.info(`Saatiin ${map.size} aseman nimet.`);
  return map;
}
