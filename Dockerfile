# =========================================================================
# AngoConnect — Next.js production Dockerfile (multi-stage)
# =========================================================================
# Build:  docker build -t angoconnect-app .
# Run:    docker run -p 3000:3000 --env-file .env.production angoconnect-app
# =========================================================================

FROM node:20-alpine AS base
RUN apk add --no-cache libc6-compat
WORKDIR /app

# --- deps --------------------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci --legacy-peer-deps

# --- build -------------------------------------------------------------------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Build-time placeholder envs (next build colecciona páginas — precisa de
# valores existentes para não rebentar; em runtime são substituídos pelas
# env vars reais do Coolify).
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_PUBLIC_SUPABASE_URL=https://placeholder.local
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder
ENV SUPABASE_SERVICE_ROLE_KEY=placeholder
ENV STRIPE_SECRET_KEY=
ENV ANTHROPIC_API_KEY=
ENV NEXT_PUBLIC_APP_URL=https://angoconnect.flowzaa.com
# Sentry: build sem auth token e sem org/project — silenciar erros de upload
# e qualquer erro de plugin (build local não usa Sentry; só prod runtime).
ENV SENTRY_AUTH_TOKEN=
ENV SENTRY_DISABLE_AUTO_UPLOAD=true
ENV SENTRY_DSN=
ENV NEXT_PUBLIC_SENTRY_DSN=
# Heap até 2GB (Coolify VPS pode ter RAM limitada — next build OOM = exit 1)
ENV NODE_OPTIONS="--max-old-space-size=2048"
RUN npm run build

# --- runtime -----------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Standalone output não está configurado por agora — copia node_modules + .next
# em modo regular (mais simples, ainda fica magro).
COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./package.json
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/next.config.mjs ./next.config.mjs

USER nextjs
EXPOSE 3000
ENV PORT=3000

# Healthcheck para Coolify/Traefik (rota pública adicionada hoje).
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["npm", "run", "start"]
