/// <reference path="../pb_data/types.d.ts" />

/**
 * Subida reanudable por fragmentos.
 *
 * Guardar fragmentos y finalizar son operaciones separadas. Así los
 * fragmentos pueden llegar reintentados o fuera de orden sin perder progreso.
 */

const UPLOAD_MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024;
const UPLOAD_MAX_CHUNK_SIZE = 32 * 1024 * 1024;

function uploadError(message, status = 400) {
    const error = new Error(message);
    error.status = status;
    return error;
}

function getUploadParams(c) {
    const uploadId = c.formValue("uploadId");
    const chunkIndex = Number.parseInt(c.formValue("chunkIndex"), 10);
    const totalChunks = Number.parseInt(c.formValue("totalChunks"), 10);
    const fileName = c.formValue("fileName");
    const folderId = c.formValue("folderId") || "";

    if (!uploadId || !/^[a-zA-Z0-9_-]{10,64}$/.test(uploadId)) {
        throw uploadError("Identificador de subida inválido o inseguro.");
    }
    if (!Number.isInteger(chunkIndex) || !Number.isInteger(totalChunks) ||
        chunkIndex < 0 || totalChunks < 1 || chunkIndex >= totalChunks || totalChunks > 1000) {
        throw uploadError("Parámetros de fragmentación fuera de límites.");
    }
    if (!fileName || fileName.length > 255 || fileName.includes("..") ||
        fileName.includes("/") || fileName.includes("\\")) {
        throw uploadError("Nombre de archivo inválido.");
    }

    return { uploadId, chunkIndex, totalChunks, fileName, folderId };
}

function saveMultipartChunk(chunkFile, chunkPath, ownerId, uploadId, chunkIndex) {
    const tempKey = `__chunk_uploads/${ownerId}/${uploadId}/${chunkIndex}.part`;
    let fsys;
    let reader;
    let uploaded = false;

    try {
        fsys = $app.newFilesystem();
        fsys.uploadMultipart(chunkFile, tempKey);
        uploaded = true;
        reader = fsys.getReader(tempKey);

        const buffer = new Uint8Array(1024 * 1024);
        let bytesRead;
        let firstWrite = true;
        while ((bytesRead = reader.read(buffer)) > 0) {
            const bytes = buffer.slice(0, bytesRead);
            if (firstWrite) {
                $os.writeFile(chunkPath, bytes, 420);
                firstWrite = false;
            } else {
                const appendPath = `${chunkPath}.append`;
                $os.writeFile(appendPath, bytes, 420);
                $os.cmd(
                    "sh", "-c", 'cat "$1" >> "$2"',
                    "append-upload-chunk", appendPath, chunkPath
                ).run();
                $os.remove(appendPath);
            }
        }
        if (firstWrite) throw uploadError("El fragmento recibido está vacío.");
    } finally {
        reader?.close();
        if (fsys) {
            if (uploaded) {
                try {
                    fsys.delete(tempKey);
                } finally {
                    fsys.close();
                }
            } else {
                fsys.close();
            }
        }
    }
}

function validateUploadFile(c) {
    const chunkFile = c.formFile("chunk");
    if (!chunkFile) throw uploadError("No se ha recibido el fragmento binario.");
    return chunkFile;
}

function getChunkDirectory(ownerId, uploadId) {
    return `/tmp/pb_chunks/${ownerId}_${uploadId}`;
}

function ensureChunkDirectory(ownerId, uploadId) {
    const chunkDir = getChunkDirectory(ownerId, uploadId);
    $os.mkdirAll(chunkDir, 493);
    return chunkDir;
}

function validateChunkSize(chunkPath) {
    const stat = $os.stat(chunkPath);
    if (!stat || stat.size() < 1 || stat.size() > UPLOAD_MAX_CHUNK_SIZE) {
        throw uploadError("El fragmento supera el tamaño máximo permitido.", 413);
    }
}

function assertUploadParts(chunkDir, totalChunks) {
    for (let i = 0; i < totalChunks; i++) {
        if (!$os.stat(`${chunkDir}/${i}.part`)) {
            throw uploadError(`Falta el bloque ${i} para poder completar el archivo.`);
        }
    }
}

function assembleUpload(chunkDir, fileName, totalChunks) {
    const assembledPath = `${chunkDir}/${fileName}`;
    let totalLength = 0;

    for (let i = 0; i < totalChunks; i++) {
        const partStat = $os.stat(`${chunkDir}/${i}.part`);
        totalLength += partStat.size();
        if (totalLength > UPLOAD_MAX_FILE_SIZE) {
            throw uploadError("El archivo supera el límite máximo de 10 GB.", 413);
        }
    }

    $os.writeFile(assembledPath, [], 420);
    for (let i = 0; i < totalChunks; i++) {
        $os.cmd(
            "sh", "-c", 'cat "$1" >> "$2"',
            "append-chunk", `${chunkDir}/${i}.part`, assembledPath
        ).run();
    }

    const assembledStat = $os.stat(assembledPath);
    if (!assembledStat || assembledStat.size() !== totalLength) {
        throw uploadError("El archivo ensamblado no coincide con el tamaño esperado.", 500);
    }
    return { assembledPath, totalLength };
}

function assertQuota(authRecord, totalLength) {
    const quota = authRecord.getInt("storage_quota");
    if (quota <= 0) return;

    const existingFiles = $app.dao().findRecordsByFilter(
        "files",
        "owner = {:owner} && (trashed = false || trashed = null)",
        "",
        10000,
        0,
        { owner: authRecord.id }
    );
    let usedBytes = 0;
    for (const existing of existingFiles) usedBytes += existing.getInt("size");
    if (usedBytes + totalLength > quota) {
        throw uploadError("La cuota de almacenamiento del usuario ha sido excedida.", 413);
    }
}

function createFileRecord(authRecord, fileName, folderId, assembledPath, totalLength) {
    const collection = $app.dao().findCollectionByNameOrId("files");
    const record = new Record(collection);
    record.set("owner", authRecord.id);
    record.set("name", fileName);
    record.set("size", totalLength);
    record.set("trashed", false);

    if (folderId) {
        const folder = $app.dao().findRecordById("folders", folderId);
        const folderIsGroup = folder.getBool("is_group");
        const folderGroup = folder.getString("group");
        const sameOwner = folder.getString("owner") === authRecord.id;
        const sameGroup = folderIsGroup && folderGroup &&
            folderGroup === authRecord.getString("user_group");
        if (!sameOwner && !sameGroup && authRecord.getString("role") !== "admin") {
            throw uploadError("No tienes permiso para subir archivos en esta carpeta.", 403);
        }
        record.set("folder", folderId);
        if (folderIsGroup && folderGroup) {
            record.set("is_group", true);
            record.set("group", folderGroup);
        }
    }

    record.set("file", $filesystem.fileFromPath(assembledPath));
    $app.dao().saveRecord(record);
    if (typeof logFileActivity === "function") {
        logFileActivity(
            authRecord, "file", record.id, "upload", fileName,
            `Subida de ${totalLength} bytes`
        );
    }
    return record;
}

function uploadResponseError(c, error) {
    const status = Number.isInteger(error?.status) ? error.status : 500;
    return c.json(status, {
        error: error?.message ? error.message : String(error)
    });
}

routerAdd("POST", "/api/custom/upload-chunk", (c) => {
    let chunkDir = "";
    try {
        const authRecord = c.get("authRecord");
        if (!authRecord) return c.json(401, { error: "Se requiere una sesión activa." });

        const params = getUploadParams(c);
        const chunkFile = validateUploadFile(c);
        chunkDir = ensureChunkDirectory(authRecord.id, params.uploadId);
        const chunkPath = `${chunkDir}/${params.chunkIndex}.part`;

        // Sobrescribir el mismo índice hace que los reintentos sean idempotentes.
        saveMultipartChunk(
            chunkFile, chunkPath, authRecord.id, params.uploadId, params.chunkIndex
        );
        validateChunkSize(chunkPath);

        return c.json(200, {
            status: "chunk_saved",
            chunkIndex: params.chunkIndex,
            totalChunks: params.totalChunks
        });
    } catch (error) {
        // No borrar el directorio: un error de red o un reintento no debe
        // obligar a empezar de cero.
        return uploadResponseError(c, error);
    }
}, $apis.requireRecordAuth());

routerAdd("POST", "/api/custom/upload-complete", (c) => {
    let chunkDir = "";
    try {
        const authRecord = c.get("authRecord");
        if (!authRecord) return c.json(401, { error: "Se requiere una sesión activa." });

        const uploadId = c.formValue("uploadId");
        const fileName = c.formValue("fileName");
        const folderId = c.formValue("folderId") || "";
        const totalChunks = Number.parseInt(c.formValue("totalChunks"), 10);

        if (!uploadId || !/^[a-zA-Z0-9_-]{10,64}$/.test(uploadId) ||
            !Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > 1000 ||
            !fileName || fileName.length > 255 || fileName.includes("..") ||
            fileName.includes("/") || fileName.includes("\\")) {
            throw uploadError("Datos de finalización inválidos.");
        }

        chunkDir = getChunkDirectory(authRecord.id, uploadId);
        const chunkDirectoryStat = $os.stat(chunkDir);
        if (!chunkDirectoryStat) throw uploadError("No existe una subida pendiente.");
        assertUploadParts(chunkDir, totalChunks);
        const assembled = assembleUpload(chunkDir, fileName, totalChunks);
        assertQuota(authRecord, assembled.totalLength);
        const record = createFileRecord(
            authRecord, fileName, folderId, assembled.assembledPath, assembled.totalLength
        );

        $os.removeAll(chunkDir);
        return c.json(200, {
            status: "completed",
            recordId: record.id,
            name: fileName,
            size: assembled.totalLength
        });
    } catch (error) {
        if (chunkDir && error?.status === 500) $os.removeAll(chunkDir);
        return uploadResponseError(c, error);
    }
}, $apis.requireRecordAuth());
