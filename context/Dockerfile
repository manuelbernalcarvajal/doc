FROM caddy:2-alpine AS caddy_bin
FROM litestream/litestream:0.3.13 AS litestream_bin
FROM rclone/rclone:latest AS rclone_bin

FROM alpine:3.20

# Instalar supervisor, netcat (para el healthcheck del entrypoint), curl, ca-certificates y bash
RUN apk add --no-cache supervisor bash curl ca-certificates netcat-openbsd tzdata

# Copiar binarios compilados de fuentes oficiales
COPY --from=caddy_bin /usr/bin/caddy /usr/local/bin/caddy
COPY --from=litestream_bin /usr/local/bin/litestream /usr/local/bin/litestream
COPY --from=rclone_bin /usr/local/bin/rclone /usr/local/bin/rclone

# Descargar PocketBase
ARG PB_VERSION=0.22.20
ADD https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_amd64.zip /tmp/pb.zip
RUN unzip /tmp/pb.zip -d /usr/local/bin/ && rm /tmp/pb.zip && chmod +x /usr/local/bin/pocketbase

# Configuración de carpetas
RUN mkdir -p /pb_data /pb_hooks /pb_public /etc/caddy /etc/supervisor/conf.d

# Archivos de configuración
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY litestream.yml /etc/litestream.yml
COPY Caddyfile /etc/caddy/Caddyfile
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Exponer puertos web
EXPOSE 80 443

ENTRYPOINT ["/entrypoint.sh"]
