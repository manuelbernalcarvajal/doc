/// <reference path="../pb_data/types.d.ts" />

/**
 * 1. Purga nocturna de fragmentos temporales huérfanos (03:00 AM)
 * Si una subida por bloques se interrumpió y pasaron más de 24h,
 * destruye los datos de /tmp para no saturar memoria o disco.
 */
cronAdd("clean_orphan_chunks", "0 3 * * *", () => {
    const chunkDir = "/tmp/pb_chunks";
    try {
        const entries = $os.readDir(chunkDir);
        const now = new Date().getTime();
        const maxAgeMs = 24 * 60 * 60 * 1000;

        for (let entry of entries) {
            if (entry.isDir()) {
                const targetDir = chunkDir + "/" + entry.name();
                const stat = $os.stat(targetDir);
                if (stat && (now - new Date(stat.modTime()).getTime() > maxAgeMs)) {
                    $os.removeAll(targetDir);
                }
            }
        }
    } catch (_) {}
});

/**
 * 2. Consolidación y optimización de SQLite (04:00 AM)
 * Checkpoint pasivo del WAL para mantener la réplica de Litestream al día
 * y optimización de los índices del motor relacional.
 */
cronAdd("sqlite_optimize", "0 4 * * *", () => {
    try {
        $app.dao().db().newQuery("PRAGMA wal_checkpoint(PASSIVE);").execute();
        $app.dao().db().newQuery("PRAGMA optimize;").execute();
    } catch (e) {
        console.error("[CRON] Error al optimizar SQLite:", e.message);
    }
});

/**
 * 3. Vaciado definitivo de papelera tras 30 días (05:00 AM)
 */
cronAdd("purge_trash", "0 5 * * *", () => {
    try {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
            .toISOString()
            .replace("T", " ")
            .substring(0, 19);

        const trashedFiles = $app.dao().findRecordsByFilter(
            "files",
            "trashed = true && trashed_at < {:cutoff}",
            "-created",
            100,
            0,
            { cutoff: thirtyDaysAgo }
        );

        for (let record of trashedFiles) {
            $app.dao().deleteRecord(record);
        }
    } catch (_) {}
});

/**
 * 4. Recolector de huérfanos en cascada (05:30 AM)
 * Se ejecuta tras la purga de papelera. Comprueba si existen archivos o subcarpetas
 * cuyo padre asignado ya no existe en la colección 'folders'.
 * Si el padre aún existe (esté o no en papelera), NO se toca.
 */
cronAdd("purge_orphan_records", "30 5 * * *", () => {
    const dao = $app.dao();

    try {
        // 1. Detección y purga de archivos huérfanos
        // Seleccionamos archivos vinculados a alguna carpeta
        const filesWithFolder = dao.findRecordsByFilter(
            "files",
            "folder != '' && folder != null",
            "",
            500,
            0
        );

        for (let file of filesWithFolder) {
            const parentFolderId = file.getString("folder");
            try {
                // Si la carpeta padre existe en la tabla, no es huérfano (incluso si está en papelera)
                dao.findRecordById("folders", parentFolderId);
            } catch (_) {
                // La carpeta padre ya fue destruida físicamente: el archivo es huérfano real
                dao.deleteRecord(file);
            }
        }

        // 2. Detección y purga de subcarpetas huérfanas
        const foldersWithParent = dao.findRecordsByFilter(
            "folders",
            "parent != '' && parent != null",
            "",
            500,
            0
        );

        for (let folder of foldersWithParent) {
            const parentFolderId = folder.getString("parent");
            try {
                dao.findRecordById("folders", parentFolderId);
            } catch (_) {
                // La carpeta padre no existe: se elimina la subcarpeta huérfana
                dao.deleteRecord(folder);
            }
        }
    } catch (e) {
        console.error("[CRON ORPHANS] Fallo en la recolección de huérfanos:", e.message);
    }
});
