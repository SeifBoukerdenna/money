FROM node:22-alpine
WORKDIR /app

RUN corepack enable

COPY . .
RUN pnpm install --no-frozen-lockfile

EXPOSE 3000
CMD ["pnpm", "--filter", "web", "dev"]
