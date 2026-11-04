# Build context: repository root.
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile --filter "@clipforge/web..."
# Rewrites are resolved at build time. In production on GCP the load balancer routes
# /api/v1/* to the API directly, so this only matters for docker-compose.
ARG API_INTERNAL_URL=http://api:4000
ENV API_INTERNAL_URL=$API_INTERNAL_URL NEXT_STANDALONE=1 NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @clipforge/contracts build && pnpm --filter @clipforge/web build

FROM node:22-slim
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
