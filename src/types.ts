export interface Passenger {
  type: string; // esim. "ADULT"
}

export interface RouteSpec {
  from: string;
  to: string;
}

export interface RateLimitConfig {
  minDelayMs: number;
  maxDelayMs: number;
  longPauseEveryN: number;
  longPauseMs: number;
  maxRetries: number;
  retryBackoffMs: number;
}

export interface AppConfig {
  passengers: Passenger[];
  daysAhead: number;
  bothDirections: boolean;
  routes: RouteSpec[];
  rateLimit: RateLimitConfig;
  browser: { headless: boolean };
  server: { port: number };
}

export interface RouteRow {
  id: number;
  from_code: string;
  to_code: string;
  from_name: string | null;
  to_name: string | null;
  active: number;
}

/** Yhden lähdön kaapattu hintatieto. */
export interface JourneyPrice {
  travelDate: string; // YYYY-MM-DD
  departureTime: string; // HH:MM
  departureAt: string | null; // täysi ISO-aikaleima jos saatavilla
  trainNumber: string | null;
  trainType: string | null;
  price: number;
  currency: string;
}
