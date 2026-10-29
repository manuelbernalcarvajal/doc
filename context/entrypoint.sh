#!/bin/bash
set -e

echo "[1/4] Configurando rclone dinámicamente..."
mkdir -p /root/.config/rclone
cat <<EOF > /root/.config/rclone/rclone.conf
[raw_s3]
type = s3
provider = ${EXTERNAL_S3_PROVIDER}
endpoint = ${EXTERNAL_S3_ENDPOINT}
access_key_id = ${EXTERNAL_S3_ACCESS_KEY_ID}
secret_access_key = ${EXTERNAL_S3_SECRET_ACCESS_KEY}
region = ${EXTERNAL_S3_REGION}

[crypt_remote]
type = crypt
remote = raw_s3:${EXTERNAL_S3_BUCKET}
password = $(rclone obscure "${CRYPT_PASSWORD}")
password2 = $(rclone obscure "${CRYPT_PASSWORD2}")
filename_encryption = standard
directory_name_encryption = true
EOF

echo "[2/4] Arrancando rclone serve s3 temporal para tareas previas..."
rclone serve s3 crypt_remote:monolith-data \
    --addr 127.0.0.1:9000 \
    --auth-key "monolith_internal,monolith_internal_secret_98765" \
    --vfs-cache-mode off \
    --buffer-size 0 &
RCLONE_PID=$!

# Esperar a que el puerto 9000 responda
echo "Esperando que el gateway S3 interno esté disponible..."
while ! nc -z 127.0.0.1 9000; do
    sleep 0.2
done
echo "S3 interno operativo."

echo "[3/4] Comprobando integridad y persistencia..."
mkdir -p /pb_data
if [ ! -f /pb_data/data.db ]; then
    echo "¡Base de datos local no encontrada! Iniciando restauración automática con Litestream..."
    litestream restore -if-replica-exists -config /etc/litestream.yml /pb_data/data.db || true
    if [ -f /pb_data/data.db ]; then
        echo "Base de datos recuperada con éxito."
    else
        echo "No hay réplica en S3. Se iniciará una base de datos limpia."
    fi
else
    echo "Base de datos local encontrada. Omitiendo restore."
fi

# Paramos el rclone temporal; supervisord tomará el control definitivo
kill $RCLONE_PID
wait $RCLONE_PID 2>/dev/null || true

echo "[4/4] Cediento el control a supervisord..."
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf
