FROM caddy:2-alpine AS caddy_bin
FROM litestream/litestream:0.3.13 AS litestream_bin
FROM rclone/rclone:latest AS rclone_bin

FROM alpine:3.20

# 1. Dependencias del sistema
RUN apk add --no-cache supervisor bash curl ca-certificates netcat-openbsd tzdata unzip

# 2. Binarios oficiales de alta velocidad
COPY --from=caddy_bin /usr/bin/caddy /usr/local/bin/caddy
COPY --from=litestream_bin /usr/local/bin/litestream /usr/local/bin/litestream
COPY --from=rclone_bin /usr/local/bin/rclone /usr/local/bin/rclone

# 3. Descarga e instalación de PocketBase
ARG PB_VERSION=0.22.20
ADD https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_amd64.zip /tmp/pb.zip
RUN unzip /tmp/pb.zip -d /usr/local/bin/ && rm /tmp/pb.zip && chmod +x /usr/local/bin/pocketbase

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
