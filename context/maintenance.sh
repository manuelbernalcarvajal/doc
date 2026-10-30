#!/bin/sh
set -e

# Esperar 60 segundos al arranque inicial para no interferir con la restauración de Litestream
sleep 60

echo "[maintenance] Demonio de mantenimiento del sistema y S3 iniciado."

while true; do
    echo "[maintenance] Iniciando pase de mantenimiento nocturno..."

    # 1. Purga de subidas multipartes incompletas en el bucket S3 externo
    if [ -f "/tmp/rclone.conf" ] && [ -n "$EXTERNAL_S3_BUCKET" ]; then
        echo "[maintenance] Purgando fragmentos incompletos en el bucket S3 remoto (${EXTERNAL_S3_BUCKET})..."
        rclone --config /tmp/rclone.conf cleanup "raw_s3:${EXTERNAL_S3_BUCKET}" 2>&1 | sed -u 's/^/[maintenance-rclone] /' || true
    fi

    # 2. Vaciado de caches temporales de Rclone en memoria/disco
    if [ -d "/root/.cache/rclone" ]; then
        rm -rf /root/.cache/rclone/*
    fi

    # 3. Purga de archivos temporales de sistema con más de 24h
    find /tmp -maxdepth 2 -type f -mtime +1 -delete 2>/dev/null || true

    echo "[maintenance] Mantenimiento finalizado. Próxima ejecución en 24 horas."
    
    # Pausa de 24 horas (86400 segundos)
    sleep 86400
done
