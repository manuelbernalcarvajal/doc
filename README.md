# 🏛️ Monolito Nube — Guía de Despliegue y Operación

Sistema de almacenamiento en la nube, agenda, libreta de contactos y suite ofimática en un único contenedor monolítico efímero.

La arquitectura opera bajo el principio de **conocimiento cero (Zero-Knowledge)** y **tolerancia total a destrucción**: los datos y la base de datos SQLite se replican en tiempo real cifrados con AES-256 a cualquier proveedor compatible con S3 (Cloudflare R2, Backblaze B2, AWS S3, MinIO, etc.). El servidor físico o VPS puede destruirse en cualquier momento y reconstruirse al 100% en segundos únicamente con el archivo `.env`.

---

## 🏗️ Arquitectura del Sistema

```
                  Internet (Puerto 80 / 443)
                             │
                             ▼
               [ Caddy (Reverse Proxy + SSL) ]
                             │
             ┌───────────────┴───────────────┐
             ▼                               ▼
    [ Panel Público SPA ]           [ API PocketBase ]
     pb_public (Vanilla JS)                 │
                                    ┌────────┴────────┐
                                    ▼                 ▼
                             [ SQLite WAL ]   [ Gateway S3 Local ]
                                    │          127.0.0.1:9000
                                    ▼                 │
                              [ Litestream ]          ▼
                                    │          [ Rclone Crypt ]
                                    │         (AES-256-GCM / CTR)
                                    └────────┬────────┘
                                             ▼
                             [ Proveedor S3 Externo ]
                           (Cloudflare R2, B2, AWS S3)
```

1. **Caddy:** Gestiona certificados SSL automáticos de Let's Encrypt y bloquea totalmente el acceso externo a las rutas administrativas internas (`/_/*`).
2. **PocketBase:** Motor central con base de datos SQLite embebida, gestión de usuarios, permisos RLS, tareas programadas (cron) y API REST.
3. **Litestream:** Lee el archivo WAL de transacciones de SQLite y replica cada cambio al instante hacia el bucket en la nube.
4. **Rclone Crypt:** Expone un endpoint S3 local (`127.0.0.1:9000`). Cifra al vuelo con contraseñas maestras los archivos antes de enviarlos a tu proveedor de almacenamiento.
5. **Supervisor & Demonio de Mantenimiento:** Orquesta los 5 procesos en segundo plano, purga residuos temporales cada 24 horas y redirige los registros directamente a la consola de Docker (sin saturar memoria con logs).

---

## 📋 Requisitos Previos

Antes de arrancar el sistema necesitas tres cosas:

1. **Docker y Docker Compose** instalados en tu máquina o servidor Linux:
   ```bash
   curl -fsSL https://get.docker.com | sh
   ```
2. **Un Bucket S3 en tu proveedor preferido:**
   * **Cloudflare R2** (Recomendado: 10 GB gratis al mes, sin costes de descarga).
   * **Backblaze B2** (10 GB gratis al mes, costes de almacenamiento muy bajos).
   * **AWS S3 / Wasabi / Scaleway / MinIO**.
   * *Importante:* Crea el bucket vacío desde el panel de tu proveedor antes del primer arranque (por ejemplo, con el nombre `mi-despacho-backups`).
3. **Un Dominio o Subdominio (Opcional para HTTPS):**
   * Apunta un registro DNS de tipo `A` hacia la IP pública de tu servidor (ej: `nube.midominio.com`).
   * Si vas a probar en local, puedes usar simplemente `localhost`.

---

## 🚀 Paso a Paso: Despliegue en 5 Minutos

### Paso 1: Clonar el Repositorio

```bash
git clone https://github.com/manuelbernalcarvajal/doc.git
cd doc
```

### Paso 2: Crear y Configurar el Archivo `.env`

Copia la plantilla base:

```bash
cp .env.example .env
```

Genera dos contraseñas maestras de alta entropía para el cifrado AES-256 ejecutando este comando dos veces en tu terminal:

```bash
openssl rand -base64 32
```

Abre el archivo `.env` con tu editor preferido (`nano .env`) y completa las variables:

```env
# Dominio de tu servidor (o localhost para entornos de prueba sin SSL)
MY_DOMAIN=nube.tudominio.com

# === CREDENCIALES DEL PROVEEDOR S3 EXTERNO ===
# En Cloudflare R2: https://<account_id>.r2.cloudflarestorage.com
# En Backblaze B2:  https://s3.<region>.backblazeb2.com
# En AWS S3:         https://s3.<region>.amazonaws.com
EXTERNAL_S3_ENDPOINT=https://tu-id-cuenta.r2.cloudflarestorage.com
EXTERNAL_S3_REGION=auto
EXTERNAL_S3_BUCKET=mi-despacho-backups
EXTERNAL_S3_ACCESS_KEY=tu_access_key_del_proveedor
EXTERNAL_S3_SECRET_KEY=tu_secret_key_del_proveedor

# === CIFRADO ZERO-KNOWLEDGE (AES-256) ===
# ¡MUY IMPORTANTE! Si pierdes estas dos claves, los datos en la nube son IRRECUPERABLES
CRYPT_PASSWORD=clave_generada_con_openssl_1
CRYPT_PASSWORD2=clave_generada_con_openssl_2

# === CREDENCIALES INTERNAS (NO MODIFICAR) ===
INTERNAL_S3_ENDPOINT=http://127.0.0.1:9000
INTERNAL_S3_BUCKET=monolith-data
INTERNAL_S3_ACCESS_KEY=monolith_internal
INTERNAL_S3_SECRET_KEY=monolith_internal_secret_98765
```

> ⚠️ **REGLA DE ORO:** Guarda una copia de seguridad de tu archivo `.env` en un gestor de contraseñas seguro (como Bitwarden o 1Password). Con este archivo puedes levantar tu sistema desde cero aunque tu servidor físico quede destruido.

---

### Paso 3: Iniciar el Contenedor

Ejecuta el despliegue con Docker Compose:

```bash
docker compose up -d
```

Si deseas compilar la imagen directamente desde el código fuente en lugar de descargarla desde el registro, utiliza:

```bash
docker compose up --build -d
```

Para verificar que todos los servicios arrancaron correctamente y ver los registros en tiempo real:

```bash
docker compose logs -f
```

Deberías ver cómo se inician los 5 módulos:
```text
monolith | [rclone]      Serving S3 on 127.0.0.1:9000
monolith | [pocketbase]  Server started at http://127.0.0.1:8090
monolith | [litestream]  replicate: /pb_data/data.db to s3://monolith-data/data.db
monolith | [caddy]       serving initial configuration
monolith | [maintenance] Demonio de mantenimiento iniciado.
```

---

### Paso 4: Primer Acceso y Cambio de Contraseña

1. Abre tu navegador web y dirígete a:
   * En servidor con dominio: `https://nube.tudominio.com`
   * En local: `http://localhost`
2. Inicia sesión con las credenciales maestras iniciales de fábrica:
   * **Usuario:** `admin` (o `admin@despacho.local`)
   * **Contraseña temporal:** `Admin12345!`
3. **Cambio forzado de seguridad:** El sistema detectará la clave provisional y te impedirá navegar hasta que establezcas tu contraseña definitiva personal (mínimo 8 caracteres).

---

## ⚙️ Configuración Tras el Primer Acceso

Una vez dentro de la aplicación con la cuenta de administrador:

### 1. Activar el Doble Factor de Autenticación (TOTP)
Dirígete a tu perfil o apartado de seguridad y activa TOTP. Escanea el código con tu aplicación de confianza (Google Authenticator, Microsoft Authenticator, Ente Auth o Bitwarden). A partir de ese momento, ningún inicio de sesión se permitirá sin el código dinámico de 6 dígitos.

### 2. Personalizar la Marca y Colores Corporativos
En el menú lateral, pulsa en **⚙️ Administración > Personalización de Marca**:
* Cambia el nombre de la nube (ej: *Despacho Jurídico Gómez & Asociados*).
* Elige el logotipo o icono corporativo (📁, ⚖️, 🏛️, 💼, 🛡️, ⚡).
* Selecciona tu color de énfasis con la paleta interactiva.
* Pulsa **Guardar Identidad**: los cambios se guardan en la base de datos central en SQLite y se sincronizan al instante en la nube para todos los dispositivos y la pantalla de acceso.

### 3. Configurar Notificaciones por Correo (SMTP)
En **⚙️ Administración > Servidor de Correo (SMTP)**:
* Activa la casilla de verificación.
* Introduce los datos de tu servidor SMTP (Mailgun, SendGrid, Brevo, Gmail o tu servidor de correo corporativo).
* Pulsa **Probar** para comprobar el envío y guarda la configuración.
* *Resultado:* Cada 5 minutos, el demonio interno revisa los eventos de la agenda y envía avisos automáticos a los usuarios 30 minutos antes del inicio de sus citas.

### 4. Co-Edición Ofimática en Vivo (WOPI)
Si dispones de una instancia de **Collabora Online** u **OnlyOffice**:
* En **⚙️ Administración > Editor Ofimático en Línea (WOPI)**, activa el servicio e introduce la URL de tu servidor de oficina (ej: `https://collabora.tudominio.com`).
* En la lista de archivos, cualquier documento `.docx`, `.xlsx`, `.pptx` u `.odt` mostrará el botón **📝 Editar**. Al pulsarlo, se abrirá el editor a pantalla completa con soporte de co-edición multiusuario en tiempo real.

---

## 🛡️ Escenario "RAM Pura" (Alta Seguridad y Disco Efímero)

Si deseas la máxima velocidad y garantizar que en el disco físico de tu servidor no quede ningún rastro permanente, puedes ejecutar el sistema montando los datos directamente en la memoria RAM del equipo.

En tu archivo `docker-compose.yml`, sustituye el volumen local por la directiva `tmpfs`:

```yaml
    # Comentar el volumen físico:
    # - ./pb_data:/pb_data

    # Operar íntegramente sobre la memoria RAM (hasta 2 GB):
    tmpfs:
      - /pb_data:size=2G,mode=1777
```

**¿Cómo funciona la persistencia en RAM?**
1. Al reiniciar la máquina o recrear el contenedor, la memoria RAM se borra por completo.
2. `entrypoint.sh` arranca un gateway de Rclone efímero, detecta que `/pb_data/data.db` no existe y lanza automáticamente:
   ```bash
   litestream restore -config /etc/litestream.yml /pb_data/data.db
   ```
3. Litestream descarga y reconstruye la base de datos desde el S3 cifrado en 2-5 segundos.
4. Los archivos binarios nunca tocan la RAM: se leen y escriben en streaming directamente desde el proveedor S3 externo descifrándose al vuelo.

---

## 🆘 Recuperación ante Desastres (Disaster Recovery)

Si tu servidor arde, es cancelado o decides migrar de proveedor de VPS:

1. Contrata un servidor nuevo en cualquier parte del mundo.
2. Instala Docker.
3. Clona el repositorio:
   ```bash
   git clone https://github.com/manuelbernalcarvajal/doc.git && cd doc
   ```
4. Pega tu archivo `.env` de respaldo.
5. Lanza el contenedor:
   ```bash
   docker compose up -d
   ```
6. **Listo.** No hay que hacer nada más. El sistema se restaura solo a partir del bucket en la nube y vuelve a estar operativo en el mismo estado en que lo dejaste.

---

## 🛠️ Comandos de Mantenimiento Frecuentes

* **Ver registros de todos los servicios unificados:**
  ```bash
  docker compose logs -f
  ```
* **Filtrar registros solo de un servicio concreto:**
  ```bash
  docker compose logs -f | grep "\[pocketbase\]"
  docker compose logs -f | grep "\[litestream\]"
  docker compose logs -f | grep "\[rclone\]"
  ```
* **Detener el sistema ordenadamente:**
  ```bash
  docker compose down
  ```
* **Actualizar a la última versión:**
  ```bash
  docker compose pull
  docker compose up -d
  ```
* **Acceso de emergencia al panel nativo de PocketBase:**  
  Por motivos de seguridad, Caddy bloquea la ruta `/_/` desde Internet. Para entrar a las tripas del motor:
  1. Abre un túnel SSH en tu equipo local:
     ```bash
     ssh -L 8090:127.0.0.1:8090 usuario@ip-servidor
     ```
  2. Navega en tu navegador a: `http://127.0.0.1:8090/_/`
