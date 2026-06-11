# Node 22 tarvitaan sisäänrakennettuun node:sqlite-moduuliin (>= 22.5).
FROM node:22-bookworm-slim

WORKDIR /app

# Riippuvuudet ensin (parempi Docker-välimuistitus).
COPY package*.json ./
RUN npm ci --ignore-scripts

# Chromium + tarvittavat käyttöjärjestelmäkirjastot Playwrightille.
RUN npx playwright install --with-deps chromium

# Sovelluksen lähdekoodi.
COPY . .

ENV NODE_ENV=production
ENV PORT=5173
EXPOSE 5173

# Oletuksena käynnistää web-käyttöliittymän. Keräys ajetaan erillisellä
# komennolla:  docker compose run --rm web npm run scrape
CMD ["npm", "run", "serve"]
