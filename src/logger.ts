function ts(): string {
  // Käytetään paikallista aikaa luettavuuden vuoksi.
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export const log = {
  info: (...args: unknown[]) => console.log(`[${ts()}] INFO `, ...args),
  warn: (...args: unknown[]) => console.warn(`[${ts()}] WARN `, ...args),
  error: (...args: unknown[]) => console.error(`[${ts()}] ERROR`, ...args),
};
