# Сборка Mini App и запуск бота + API в одном контейнере.
# Код и dist лежат в /usr/src/app, а не в /app: Bothost монтирует /app с исходниками,
# поэтому собранные файлы там были бы затёрты.

FROM node:20-alpine AS frontend
WORKDIR /usr/src/app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:20-alpine
WORKDIR /usr/src/app
ENV NODE_ENV=production
ENV PORT=3000

COPY backend/package.json backend/package-lock.json ./backend/
RUN cd backend && npm ci --omit=dev

COPY backend/ ./backend/
COPY --from=frontend /usr/src/app/frontend/dist ./frontend/dist

# Постоянные файлы Bothost (сейчас не используются: база в Supabase).
RUN mkdir -p /app/data

EXPOSE 3000
CMD ["node", "backend/src/index.js"]
