import type { RateLimitConfig } from "./types.ts";

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Hidastaa kutsutahtia ihmismäisellä satunnaisviiveellä ja pitää pidemmän
 * tauon joka N. kutsun jälkeen, jotta VR:n WAF/rate-limit ei laukea.
 */
export class RateLimiter {
  private n = 0;
  constructor(private cfg: RateLimitConfig) {}

  async wait(): Promise<void> {
    this.n++;
    if (this.cfg.longPauseEveryN > 0 && this.n % this.cfg.longPauseEveryN === 0) {
      await sleep(this.cfg.longPauseMs);
      return;
    }
    const span = Math.max(0, this.cfg.maxDelayMs - this.cfg.minDelayMs);
    const delay = this.cfg.minDelayMs + Math.floor(Math.random() * (span + 1));
    await sleep(delay);
  }
}
