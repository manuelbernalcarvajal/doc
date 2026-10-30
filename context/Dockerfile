FROM caddy:2.8.4-alpine@sha256:b95ed06fbc6d74d24a40902090c8cc6086ce7d08ba60a3a7e8e62bf164a9d7bb AS caddy_bin
FROM litestream/litestream:0.3.13@sha256:a932d9801f9d8f11ed0566aa105ef866c097c00ef1191b88a8aa0ff8e78b4071 AS litestream_bin
FROM rclone/rclone:1.68.2@sha256:41388051445353047e007aa8978ebe224a1efdd6edc55fb746656d19ddf59de2 AS rclone_bin

FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc

# 1. Dependencias del sistema
RUN apk add --no-cache supervisor bash curl ca-certificates netcat-openbsd tzdata unzip

# 2. Binarios oficiales de alta velocidad
COPY --from=caddy_bin /usr/bin/caddy /usr/local/bin/caddy
COPY --from=litestream_bin /usr/local/bin/litestream /usr/local/bin/litestream
COPY --from=rclone_bin /usr/local/bin/rclone /usr/local/bin/rclone

# 3. Descarga e instalación de PocketBase
ADD https://github.com/pocketbase/pocketbase/releases/download/v0.22.20/pocketbase_0.22.20_linux_amd64.zip /tmp/pb.zip
RUN echo "f430bd045e0981ca6ecec91cea9bbaf10fcfcf541f48e984b1d7069940010635  /tmp/pb.zip" | sha256sum -c - \
    && unzip /tmp/pb.zip -d /usr/local/bin/ \
    && rm /tmp/pb.zip \
    && chmod +x /usr/local/bin/pocketbase

# 4. Estructura de directorios base
RUN mkdir -p /pb_data /pb_hooks /pb_public /etc/caddy

# 5. Código de la aplicación (Hooks backend y SPA frontend)
COPY pb_hooks /pb_hooks
COPY pb_public /pb_public

# 6. Archivos de configuración de servicios
COPY supervisord.conf /etc/supervisord.conf
COPY litestream.yml /etc/litestream.yml
COPY Caddyfile /etc/caddy/Caddyfile

# 7. Scripts de ciclo de vida y permisos
COPY entrypoint.sh /entrypoint.sh
COPY maintenance.sh /maintenance.sh
RUN chmod +x /entrypoint.sh /maintenance.sh

# Puertos web HTTP y HTTPS
EXPOSE 80 443

ENTRYPOINT ["/entrypoint.sh"]
