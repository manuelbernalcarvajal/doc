/// <reference path="../pb_data/types.d.ts" />

/**
 * Endpoint de subida por fragmentos (Chunking) para eludir el límite de 100 MB de Cloudflare
 * y dar soporte a redes lentas o inestables sin pérdida de datos.
 *
 * Ruta: POST /api/custom/upload-chunk
 */
routerAdd("POST", "/api/custom/upload-chunk", (c) => {
    const MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024;
    const MAX_CHUNK_SIZE = 32 * 1024 * 1024;

    // 1. Verificación de sesión activa
    const authRecord = c.get("authRecord");
    if (!authRecord) {
        return c.json(401, { error: "Acceso no autorizado: requiere sesión activa." });
    }

    // 2. Extracción y validación estricta de parámetros
    const uploadId = c.formValue("uploadId");
    const chunkIndex = parseInt(c.formValue("chunkIndex"), 10);
    const totalChunks = parseInt(c.formValue("totalChunks"), 10);
    const fileName = c.formValue("fileName");
    const folderId = c.formValue("folderId") || "";

    // Blindaje contra Path Traversal: solo UUID v4 / alfanumérico seguro
    if (!uploadId || !/^[a-zA-Z0-9_-]{10,64}$/.test(uploadId)) {
        return c.json(400, { error: "Identificador de subida (uploadId) inválido o inseguro." });
    }

    if (isNaN(chunkIndex) || isNaN(totalChunks) || chunkIndex < 0 || chunkIndex >= totalChunks || totalChunks > 1000) {
        return c.json(400, { error: "Parámetros de fragmentación fuera de límites." });
    }

    if (!fileName || fileName.includes("..") || fileName.includes("/")) {
        return c.json(400, { error: "Nombre de archivo inválido." });
    }

    // 3. Captura del archivo fragmentado
    const chunkFile = c.formFile("chunk");
    if (!chunkFile) {
        return c.json(400, { error: "No se ha recibido el fragmento binario." });
    }

    const chunkDir = `/tmp/pb_chunks/${uploadId}`;
    $os.mkdirAll(chunkDir, 493);

    // Guardado del fragmento en disco temporal
    const chunkPath = `${chunkDir}/${chunkIndex}.part`;
    c.saveUploadedFile(chunkFile, chunkPath);
    const chunkStat = $os.stat(chunkPath);
    if (!chunkStat || chunkStat.size() > MAX_CHUNK_SIZE) {
        $os.removeAll(chunkDir);
        return c.json(413, { error: "El fragmento supera el tamaño máximo permitido." });
    }

    // 4. Si aún quedan fragmentos pendientes, confirmamos recepción
    if (chunkIndex + 1 < totalChunks) {
        return c.json(200, {
            status: "chunk_saved",
            chunkIndex: chunkIndex,
            totalChunks: totalChunks
        });
    }

    // 5. Ensamblado final cuando llega el último fragmento
    for (let i = 0; i < totalChunks; i++) {
        if (!$os.stat(`${chunkDir}/${i}.part`)) {
            return c.json(400, { error: `Falta el bloque ${i} para poder completar el archivo.` });
        }
    }

    const assembledPath = `${chunkDir}/${fileName}`;

    try {
        // Calcula el tamaño sin cargar todos los fragmentos en memoria.
        let totalLength = 0;
        for (let i = 0; i < totalChunks; i++) {
            const partStat = $os.stat(`${chunkDir}/${i}.part`);
            totalLength += partStat.size();
            if (totalLength > MAX_FILE_SIZE) {
                throw new Error("El archivo supera el límite máximo de 10 GB.");
            }
        }

        const quota = authRecord.getInt("storage_quota");
        if (quota > 0) {
            const existingFiles = $app.dao().findRecordsByFilter(
                "files",
                "owner = {:owner} && (trashed = false || trashed = null)",
                "",
                10000,
                0,
                { owner: authRecord.id }
            );
            let usedBytes = 0;
            for (let existing of existingFiles) {
                usedBytes += existing.getInt("size");
            }
            if (usedBytes + totalLength > quota) {
                throw new Error("La cuota de almacenamiento del usuario ha sido excedida.");
            }
        }

        // Ensambla en disco: solo un proceso cat y un fragmento pasan por cada iteración.
        $os.writeFile(assembledPath, [], 420);
        for (let i = 0; i < totalChunks; i++) {
            const append = $os.cmd(
                "sh",
                "-c",
                'cat "$1" >> "$2"',
                "append-chunk",
                `${chunkDir}/${i}.part`,
                assembledPath
            );
            append.run();
        }

        const assembledStat = $os.stat(assembledPath);
        if (!assembledStat || assembledStat.size() !== totalLength) {
            throw new Error("El archivo ensamblado no coincide con el tamaño esperado.");
        }

        // 6. Creación del registro en PocketBase (despacho automático al S3 cifrado)
        const collection = $app.dao().findCollectionByNameOrId("files");
        const record = new Record(collection);

        record.set("owner", authRecord.id);
        record.set("name", fileName);
        if (folderId) {
            const folder = $app.dao().findRecordById("folders", folderId);
            const folderIsGroup = folder.getBool("is_group");
            const folderGroup = folder.getString("group");
            const sameOwner = folder.getString("owner") === authRecord.id;
            const sameGroup = folderIsGroup && folderGroup && folderGroup === authRecord.getString("user_group");
            if (!sameOwner && !sameGroup && authRecord.getString("role") !== "admin") {
                throw new Error("No tienes permiso para subir archivos en esta carpeta.");
            }
            record.set("folder", folderId);
            if (folderIsGroup && folderGroup) {
                record.set("is_group", true);
                record.set("group", folderGroup);
            }
        }
        record.set("size", totalLength);
        record.set("trashed", false);

        const fileObj = $filesystem.fileFromPath(assembledPath);
        record.set("file", fileObj);

        $app.dao().saveRecord(record);

        // 7. Purgado inmediato del directorio temporal
        $os.removeAll(chunkDir);

        return c.json(200, {
            status: "completed",
            recordId: record.id,
            name: fileName,
            size: totalLength
        });
    } catch (err) {
        $os.removeAll(chunkDir);
        return c.json(500, { error: "Fallo durante el ensamblado o guardado: " + err.message });
    }
}, $apis.requireRecordAuth());
