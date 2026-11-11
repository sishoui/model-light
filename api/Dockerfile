FROM node:22-alpine AS build
WORKDIR /app
# Prisma musl engines (openssl-3.0.x) need libc6-compat + openssl 3 shared libs
RUN apk add --no-cache libc6-compat openssl
COPY package.json package-lock.json* ./
RUN npm install
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# Runtime needs the same compat libs for the Prisma query engine
RUN apk add --no-cache libc6-compat openssl
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY prisma ./prisma
RUN npx prisma generate
COPY --from=build /app/dist ./dist
EXPOSE 8080
# Run migrations, then start.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
