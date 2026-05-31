# Imagem oficial Apify com Node 20 (sem browser — orchestrator puro)
# Este Actor invoca outros Actors da Apify Store via Apify.call(), não navega directamente.
FROM apify/actor-node:20 AS builder

# Copy package files first (cache friendly)
COPY --chown=myuser package*.json tsconfig.json ./

# Install ALL deps incl. dev (precisamos do tsc para o build)
RUN npm install --include=dev --audit=false

# Copy source
COPY --chown=myuser src ./src

# Compile TypeScript -> dist/
RUN npm run build

# --- Runtime stage ---
FROM apify/actor-node:20

COPY --chown=myuser --from=builder /home/myuser/package*.json ./
COPY --chown=myuser --from=builder /home/myuser/dist ./dist
COPY --chown=myuser .actor ./.actor

# Install apenas prod deps
RUN npm install --omit=dev --omit=optional \
    && npm cache clean --force \
    && echo "Node:" \
    && node --version \
    && echo "NPM:" \
    && npm --version

CMD ["node", "dist/main.js"]
