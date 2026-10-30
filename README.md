# 🏛️ Monolito Nube — Guía Rápida de Despliegue

Nube privada todo en uno (almacenamiento, agenda, libreta de contactos y co-edición ofimática) empaquetada en un único contenedor **efímero y con cifrado Zero-Knowledge (AES-256)**.

Al estar la imagen precompilada y publicada en GitHub Container Registry, **no necesitas Git ni clonar el código fuente**. Solo necesitas Docker y dos archivos en una carpeta: `docker-compose.yml` y `.env`.

---

## 📋 Requisitos Previos

1. **Docker y Docker Compose** instalados en el servidor:
   ```bash
   sudo apt-get update
   sudo apt-get install -y docker.io docker-compose-plugin
   ```
   Para otras distribuciones, instala Docker siguiendo la documentación oficial de tu sistema operativo.
2. **Un Bucket S3 vacío** creado en tu proveedor (Cloudflare R2, Backblaze B2, AWS S3, etc.) con el nombre que elijas (ej: `mi-nube-datos`).
3. **Un Dominio o Subdominio** apuntando a la IP de tu servidor (para que Caddy genere el certificado SSL automático), o `localhost` si pruebas en tu máquina.

---

## 🚀 Despliegue en 3 Pasos

### 1. Crear la carpeta de trabajo
En tu terminal o servidor:

```bash
mkdir nube && cd nube
```

### 2. Crear el archivo `docker-compose.yml`
Crea el archivo `docker-compose.yml`:

```yaml
services:
  monolito:
    image: ghcr.io/manuelbernalcarvajal/doc:latest
    container_name: nube_monolito
    restart: unless-stopped
    init: true
    ports:
      - "80:80"
      - "443:443"
    env_file:
      - .env

    # =========================================================================
    # Persistencia local (Elige UNA de las dos opciones):
    # =========================================================================

    # Opción A: En disco duro estándar (Recomendado)
    volumes:
      - pb_data:/pb_data
      - caddy_data:/data
      - caddy_config:/config

    # Opción B: Modo RAM Pura (Comenta 'volumes' y descomenta 'tmpfs')
    # tmpfs:
    #   - /pb_data:size=2G,mode=1777

    stop_grace_period: 30s
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1/"]
      interval: 30s
      timeout: 10s
      retries: 5
      start_period: 60s

volumes:
  pb_data:
    driver: local
  caddy_data:
  caddy_config:
```

### 3. Crear el archivo `.env`
Genera dos contraseñas aleatorias para el cifrado AES-256 ejecutando dos veces:
```bash
openssl rand -base64 32
```

Crea tu archivo `.env` y rellena tus datos:

```env
# Dominio para HTTPS automático (o localhost para local)
MY_DOMAIN=nube.tudominio.com
INITIAL_ADMIN_PASSWORD=cambia_esta_clave_por_una_larga_y_unica
# === DATOS DE TU PROVEEDOR S3 EXTERNO ===
# En Cloudflare R2: https://<account_id>.r2.cloudflarestorage.com
# En Backblaze B2:  https://s3.<region>.backblazeb2.com
# En AWS S3:         https://s3.<region>.amazonaws.com
EXTERNAL_S3_PROVIDER=Other
EXTERNAL_S3_ENDPOINT=https://tu-cuenta.r2.cloudflarestorage.com
EXTERNAL_S3_REGION=auto
EXTERNAL_S3_BUCKET=mi-nube-datos
EXTERNAL_S3_ACCESS_KEY_ID=tu_access_key
EXTERNAL_S3_SECRET_ACCESS_KEY=tu_secret_key

# === CIFRADO ZERO-KNOWLEDGE (AES-256) ===
# ¡IMPORTANTE! Si pierdes estas claves, los datos en el S3 son IRRECUPERABLES
CRYPT_PASSWORD=tu_clave_openssl_1
CRYPT_PASSWORD2=tu_clave_openssl_2

```

---

## 🏁 Arrancar el Sistema

Inicia el contenedor en segundo plano:

```bash
docker compose up -d
```

Docker descargará automáticamente la imagen oficial desde GitHub Packages y levantará los 5 servicios internos. Puedes comprobar los registros en tiempo real:

```bash
docker compose logs -f
```

---

## 🔑 Primer Inicio de Sesión

1. Entra desde tu navegador a `https://nube.tudominio.com` (o `http://localhost`).
2. Autentícate con el usuario `admin` y la contraseña definida en `INITIAL_ADMIN_PASSWORD`.
3. **Cambio forzado de clave:** La app te exigirá inmediatamente escribir tu contraseña personal nueva antes de permitirte entrar.
4. *(Recomendado)* Activa 2FA si tu configuración de PocketBase lo permite.

---

## ⚙️ Configuración desde el Panel de Administración

Dentro de la aplicación, el usuario administrador tiene acceso a la pestaña **⚙️ Administración**:

* **Personalización de Marca:** Cambia el nombre de la app, selecciona icono corporativo (⚖️, 📁, 🏛️, etc.) y elige el color de énfasis. Se almacena en la base de datos central y se sincroniza al S3.
* **Suite Ofimática en Línea (WOPI):** Activa la casilla e introduce la URL de tu servidor Collabora u OnlyOffice (ej: `https://collabora.tudominio.com`) para editar y co-editar documentos `.docx`, `.xlsx` u `.odt` en tiempo real desde la nube.
* **Servidor de Correo (SMTP):** Configura los datos de tu servidor de correo para que el cron de la app envíe recordatorios automáticos por email 30 minutos antes de cada evento de agenda.
* **Usuarios y Cuotas:** Crea nuevas cuentas de usuario (que nacerán con contraseña temporal obligatoria de un solo uso) y asigna límites de almacenamiento en GB.

---

## 🆘 Recuperación ante Destrucción Total

Si tu servidor físico se quema, desaparece o borras la máquina:

1. Levanta un servidor nuevo con Docker.
2. Crea una carpeta vacía y coloca tu `docker-compose.yml`.
3. Pega tu archivo `.env` de respaldo.
4. Ejecuta:
   ```bash
   docker compose up -d
   ```
5. **Fin.** Litestream y Rclone detectan que el disco local está limpio, descargan la base de datos y conectan los archivos binarios del S3 cifrado en menos de 10 segundos.
