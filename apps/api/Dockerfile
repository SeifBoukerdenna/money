FROM node:22-alpine
WORKDIR /app

RUN corepack enable

COPY . .
RUN pnpm install --no-frozen-lockfile

EXPOSE 4000
CMD ["pnpm", "--filter", "api", "dev"]
