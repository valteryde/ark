# Ark: esbuild frontend + FastAPI (static + /api + /ws/ark)
FROM node:22-alpine AS frontend
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html tsconfig.json ./
COPY public ./public
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
COPY server/requirements.txt ./server/requirements.txt
RUN pip install --no-cache-dir -r server/requirements.txt
COPY server ./server
COPY --from=frontend /app/dist ./dist
ENV STATIC_ROOT=/app/dist
# Listen port (override at runtime, e.g. docker run -e PORT=8080 -p 8080:8080)
ENV PORT=8000
ENV ARK_DB_PATH=/data/ark.db
EXPOSE 8000
# Run as non-root for least-privilege security.
RUN useradd --system --no-create-home --uid 10001 arkuser && \
    mkdir -p /data && chown arkuser:arkuser /data
VOLUME ["/data"]
USER arkuser
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --app-dir server"]
