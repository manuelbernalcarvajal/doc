/// <reference path="../pb_data/types.d.ts" />

/**
 * Implementación del protocolo WOPI (Web Application Open Platform Interface)
 * Permite la visualización y co-edición en tiempo real mediante Collabora Online,
 * OnlyOffice o EuroOffice sin almacenar estado fuera del S3 cifrado.
 */

// Los tokens de sesión son efímeros; los bloqueos se persisten en resource_locks.
const wopiSessions = {};

/**
 * 1. Generar token de sesión efímero para abrir el editor
 * POST /api/custom/wopi-token
 */
routerAdd("POST", "/api/custom/wopi-token", (c) => {
    const authRecord = c.get("authRecord");
    if (!authRecord) return c.json(401, { error: "No autenticado." });

    const data = $apis.requestInfo(c).data;
    const fileId = data.fileId;
    if (!fileId) return c.json(400, { error: "Falta el identificador del archivo." });

    const file = $app.dao().findRecordById("files", fileId);
    if (!file) return c.json(404, { error: "Archivo no encontrado." });

    // Verificación de permisos según RBAC
    const isOwner = file.getString("owner") === authRecord.id;
    const isGroupMember = file.getBool("is_group") && file.getString("group") === authRecord.getString("user_group");
    const isAdmin = authRecord.getString("role") === "admin";

    if (!isOwner && !isGroupMember && !isAdmin) {
        return c.json(403, { error: "Acceso denegado a este documento." });
    }

    // Comprobar si WOPI está activado en los ajustes generales
    const settingsList = $app.dao().findRecordsByFilter("app_settings", "1=1", "", 1, 0);
    const settings = settingsList.length > 0 ? settingsList[0] : null;

    if (!settings || !settings.getBool("wopi_enabled") || !settings.getString("wopi_server_url")) {
        return c.json(400, { error: "La suite ofimática (WOPI) no está configurada o se encuentra desactivada." });
    }

    // Token aleatorio seguro de sesión (duración: 12 horas)
    const token = $security.randomString(32);
    wopiSessions[token] = {
        fileId: fileId,
        userId: authRecord.id,
        userName: authRecord.getString("name") || authRecord.getString("username") || authRecord.getString("email").split("@")[0],
        canWrite: true,
        exp: Date.now() + 1000 * 60 * 60 * 12
    };

    // Determinar la URL pública de este monolito accesible por el motor ofimático
    let publicUrl = settings.getString("wopi_public_url").trim();
    if (!publicUrl) {
        const proto = c.request().header.get("X-Forwarded-Proto") || "http";
        publicUrl = `${proto}://${c.request().host}`;
    }
    publicUrl = publicUrl.replace(/\/+$/, "");

    const wopiSrc = `${publicUrl}/wopi/files/${fileId}`;
    let serverUrl = settings.getString("wopi_server_url").trim();

    // Normalización de endpoints para Collabora / EuroOffice si solo se indicó el dominio
    if (!serverUrl.includes(".html") && !serverUrl.includes("action")) {
        serverUrl = `${serverUrl.replace(/\/+$/, "")}/browser/dist/cool.html`;
    }

    const separator = serverUrl.includes("?") ? "&" : "?";
    const editorUrl = `${serverUrl}${separator}WOPISrc=${encodeURIComponent(wopiSrc)}&access_token=${token}`;

    return c.json(200, {
        editorUrl: editorUrl,
        fileName: file.getString("name")
    });
}, $apis.requireRecordAuth());

/**
 * Validador de token de acceso WOPI
 */
function getWopiSession(c) {
    const token = c.queryParam("access_token") || (c.request().header.get("Authorization") || "").replace("Bearer ", "").trim();
    if (!token) return null;
    const session = wopiSessions[token];
    if (!session || session.exp < Date.now()) return null;
    return session;
}

function getWopiLock(fileId) {
    return findActiveResourceLock("files", fileId);
}

/**
 * 2. WOPI: CheckFileInfo (Metadatos y capacidades del documento)
 * GET /wopi/files/:fileId
 */
routerAdd("GET", "/wopi/files/:fileId", (c) => {
    const session = getWopiSession(c);
    if (!session) return c.json(401, { error: "Token WOPI no válido o expirado." });

    const fileId = c.pathParam("fileId");
    if (session.fileId !== fileId) return c.json(403, { error: "Token no coincide con el archivo." });

    const file = $app.dao().findRecordById("files", fileId);
    if (!file) return c.json(404, { error: "Archivo no encontrado." });

    return c.json(200, {
        BaseFileName: file.getString("name"),
        OwnerId: file.getString("owner"),
        Size: file.getInt("size"),
        UserId: session.userId,
        UserFriendlyName: session.userName,
        UserCanWrite: session.canWrite,
        UserCanNotWriteRelative: true,
        SupportsUpdate: true,
        SupportsLocks: true,
        SupportsGetLock: true,
        Version: file.updated
    });
});

/**
 * 3. WOPI: Negociación de bloqueos (Locks)
 * POST /wopi/files/:fileId
 */
routerAdd("POST", "/wopi/files/:fileId", (c) => {
    const session = getWopiSession(c);
    if (!session) return c.json(401, { error: "Token no válido." });

    const fileId = c.pathParam("fileId");
    if (session.fileId !== fileId) return c.json(403, { error: "Token no coincide con el archivo." });

    const override = c.request().header.get("X-WOPI-Override");
    const lockToken = c.request().header.get("X-WOPI-Lock") || "";
    const current = getWopiLock(fileId);

    if (override === "GET_LOCK") {
        c.response().header().set("X-WOPI-Lock", current ? current.getString("token") : "");
        return c.json(200, {});
    }

    if (!lockToken) {
        c.response().header().set("X-WOPI-Lock", current ? current.getString("token") : "");
        return c.json(400, { error: "Falta X-WOPI-Lock." });
    }

    if (override === "LOCK") {
        if (current && (current.getString("token") !== lockToken || current.getString("owner") !== session.userId)) {
            c.response().header().set("X-WOPI-Lock", current.getString("token"));
            return c.json(409, { error: "El archivo ya está bloqueado." });
        }
        const lock = current || new Record($app.dao().findCollectionByNameOrId("resource_locks"));
        const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
        lock.set("resource_type", "files");
        lock.set("resource_id", fileId);
        lock.set("token", lockToken);
        lock.set("owner", session.userId);
        lock.set("expires_at", expiresAt);
        $app.dao().saveRecord(lock);
        c.response().header().set("X-WOPI-Lock", lockToken);
        return c.json(200, {});
    }

    if (!current || current.getString("token") !== lockToken || current.getString("owner") !== session.userId) {
        c.response().header().set("X-WOPI-Lock", current ? current.getString("token") : "");
        return c.json(409, { error: "El token de bloqueo no coincide." });
    }

    if (override === "REFRESH_LOCK") {
        current.set("expires_at", new Date(Date.now() + 30 * 60 * 1000).toISOString());
        $app.dao().saveRecord(current);
        c.response().header().set("X-WOPI-Lock", lockToken);
        return c.json(200, {});
    }

    if (override === "UNLOCK") {
        $app.dao().deleteRecord(current);
        c.response().header().set("X-WOPI-Lock", "");
        return c.json(200, {});
    }

    return c.json(400, { error: "Operación WOPI no soportada." });
});

/**
 * 4. WOPI: GetFile (Entrega del binario al motor de renderizado)
 * GET /wopi/files/:fileId/contents
 */
routerAdd("GET", "/wopi/files/:fileId/contents", (c) => {
    const session = getWopiSession(c);
    if (!session) return c.json(401, { error: "Token no válido o caducado." });

    const fileId = c.pathParam("fileId");
    if (session.fileId !== fileId) return c.json(403, { error: "Token no coincide con el archivo." });

    const file = $app.dao().findRecordById("files", fileId);
    if (!file) return c.json(404, { error: "Archivo no encontrado." });

    // Emisión de token temporal para lectura de archivos protegidos
    const user = $app.dao().findRecordById("users", session.userId);
    const fileToken = user ? user.newFileToken() : "";

    const fileUrl = `/api/files/files/${file.id}/${file.getString("file")}?token=${fileToken}`;
    return c.redirect(302, fileUrl);
});

/**
 * 5. WOPI: PutFile (Guardado automático tras cambios individuales o colaborativos)
 * POST /wopi/files/:fileId/contents
 */
routerAdd("POST", "/wopi/files/:fileId/contents", (c) => {
    const session = getWopiSession(c);
    if (!session) return c.json(401, { error: "Token no válido o caducado." });
    if (!session.canWrite) return c.json(403, { error: "Documento en modo solo lectura." });

    const fileId = c.pathParam("fileId");
    if (session.fileId !== fileId) return c.json(403, { error: "Token inválido." });

    const file = $app.dao().findRecordById("files", fileId);
    if (!file) return c.json(404, { error: "Archivo no encontrado." });

    const currentLock = getWopiLock(fileId);
    const writeLockToken = c.request().header.get("X-WOPI-Lock") || "";
    if (!currentLock || currentLock.getString("token") !== writeLockToken
        || currentLock.getString("owner") !== session.userId) {
        c.response().header().set("X-WOPI-Lock", currentLock ? currentLock.getString("token") : "");
        return c.json(409, { error: "El archivo está bloqueado." });
    }

    const tempDir = `/tmp/wopi_${fileId}_${Date.now()}`;
    const tempPath = `${tempDir}/document.tmp`;
    $os.mkdirAll(tempDir, 493);
    $os.writeFile(tempPath, [], 420);

    try {
        const body = c.request().body;
        const bufferSize = 1024 * 1024;
        const chunkBuffer = new Array(bufferSize);
        let chunkIndex = 0;
        let totalBytes = 0;
        let bytesRead;

        do {
            bytesRead = body.read(chunkBuffer);
            if (bytesRead > 0) {
                const chunkPath = `${tempDir}/${chunkIndex}.part`;
                $os.writeFile(chunkPath, chunkBuffer.slice(0, bytesRead), 420);
                const append = $os.cmd(
                    "sh",
                    "-c",
                    'cat "$1" >> "$2"',
                    "append-wopi-chunk",
                    chunkPath,
                    tempPath
                );
                append.run();
                $os.remove(chunkPath);
                totalBytes += bytesRead;
                chunkIndex += 1;
            }
        } while (bytesRead > 0);

        const fileObj = $filesystem.fileFromPath(tempPath);
        file.set("file", fileObj);
        file.set("size", totalBytes);
        $app.dao().saveRecord(file);

        return c.json(200, {
            ItemVersion: file.updated
        });
    } catch (err) {
        return c.json(500, { error: "Error al guardar documento: " + err.message });
    } finally {
        $os.removeAll(tempDir);
    }
});
