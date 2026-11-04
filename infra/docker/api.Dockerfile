# Build context: repository root.
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN pnpm install --frozen-lockfile --filter "@clipforge/api..."
RUN pnpm --filter @clipforge/contracts build && pnpm --filter @clipforge/api build

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build /repo ./
WORKDIR /repo/apps/api
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --retries=10 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
