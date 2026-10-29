#!/bin/bash
set -e

echo "[1/4] Configurando rclone dinámicamente..."
mkdir -p /root/.config/rclone
cat <<EOF > /tmp/rclone.conf
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
chmod 600 /tmp/rclone.conf

echo "[2/4] Arrancando rclone serve s3 temporal para tareas previas..."
rclone --config /tmp/rclone.conf serve s3 crypt_remote:monolith-data \
    --addr 127.0.0.1:9000 \
    --auth-key "monolith_internal,monolith_internal_secret_98765" \
    --vfs-cache-mode off \
    --buffer-size 0 &
RCLONE_PID=$!

# Esperar a que el puerto 9000 responda
echo "Esperando que el gateway S3 interno esté disponible..."
while ! nc -z 127.0.0.1 9000; do
    if ! kill -0 "$RCLONE_PID" 2>/dev/null; then
        echo "El gateway S3 interno no pudo iniciarse." >&2
        exit 1
    fi
    sleep 0.2
done
echo "S3 interno operativo."

echo "[3/4] Comprobando integridad y persistencia..."
mkdir -p /pb_data
if [ ! -f /pb_data/data.db ]; then
    echo "¡Base de datos local no encontrada! Iniciando restauración automática con Litestream..."
    if ! litestream restore -if-replica-exists -config /etc/litestream.yml /pb_data/data.db; then
        echo "Error al restaurar la base de datos desde la réplica S3." >&2
        exit 1
    fi
    if [ -f /pb_data/data.db ]; then
        echo "Base de datos recuperada con éxito."
    else
        echo "No hay réplica en S3. Se iniciará una base de datos limpia."
    fi
else
    echo "Base de datos local encontrada. Omitiendo restore."
fi

# PocketBase crea sus colecciones internas durante las migraciones de `serve`.
# Ejecutarlas antes de cargar los hooks evita que el esquema personalizado
# consulte `_collections` antes de que exista en una instalación nueva.
echo "Aplicando migraciones internas de PocketBase..."
mkdir -p /tmp/pb_empty_hooks
/usr/local/bin/pocketbase serve \
    --http=127.0.0.1:8091 \
    --dir=/pb_data \
    --hooksDir=/tmp/pb_empty_hooks \
    --publicDir=/pb_public \
    >/tmp/pocketbase-migrations.log 2>&1 &
PB_MIGRATION_PID=$!

while ! nc -z 127.0.0.1 8091; do
    if ! kill -0 "$PB_MIGRATION_PID" 2>/dev/null; then
        cat /tmp/pocketbase-migrations.log >&2
        exit 1
    fi
    sleep 0.2
done

kill "$PB_MIGRATION_PID"
wait "$PB_MIGRATION_PID" 2>/dev/null || true

echo "Inicializando el esquema personalizado..."
/usr/local/bin/pocketbase serve \
    --http=127.0.0.1:8091 \
    --automigrate=false \
    --dir=/pb_data \
    --hooksDir=/pb_hooks \
    --publicDir=/pb_public \
    >/tmp/pocketbase-bootstrap.log 2>&1 &
PB_BOOTSTRAP_PID=$!

while ! nc -z 127.0.0.1 8091; do
    if ! kill -0 "$PB_BOOTSTRAP_PID" 2>/dev/null; then
        cat /tmp/pocketbase-bootstrap.log >&2
        exit 1
    fi
    sleep 0.2
done

kill "$PB_BOOTSTRAP_PID"
wait "$PB_BOOTSTRAP_PID" 2>/dev/null || true

# Paramos el rclone temporal; supervisord tomará el control definitivo
kill $RCLONE_PID
wait $RCLONE_PID 2>/dev/null || true

echo "[4/4] Cediento el control a supervisord..."
exec /usr/bin/supervisord -c /etc/supervisord.conf
