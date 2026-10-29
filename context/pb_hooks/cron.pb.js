/// <reference path="../pb_data/types.d.ts" />

/**
 * 1. Purga nocturna de fragmentos huérfanos (cada día a las 03:00 AM)
 * Si una subida masiva se cortó a mitad y el usuario nunca la reanudó,
 * se eliminan los trozos temporales tras 24 horas para evitar saturar el disco.
 */
cronAdd("clean_orphan_chunks", "0 3 * * *", () => {
    const chunkDir = "/tmp/pb_chunks";
    try {
        const entries = $os.readDir(chunkDir);
        const now = new Date().getTime();
        const maxAgeMs = 24 * 60 * 60 * 1000; // 24 horas

        for (let entry of entries) {
            if (entry.isDir()) {
                const targetDir = chunkDir + "/" + entry.name();
                const stat = $os.stat(targetDir);
                // Si la carpeta temporal tiene más de un día sin actividad, se destruye
                if (stat && (now - new Date(stat.modTime()).getTime() > maxAgeMs)) {
                    $os.removeAll(targetDir);
                }
            }
        }
    } catch (e) {
        // Silencioso si el directorio /tmp/pb_chunks aún no existe
    }
});

/**
 * 2. Optimización y consolidación de SQLite (cada día a las 04:00 AM)
 * Ejecuta un checkpoint pasivo del WAL para evitar que crezca de forma desmedida
 * y corre PRAGMA optimize para que el optimizador de consultas de SQLite esté al día.
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
 * 3. Vaciado automático de papelera (cada día a las 05:00 AM)
 * Borra definitivamente los ficheros que lleven más de 30 días marcados como borrados.
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
            100, // En lotes de 100 para no ahogar memoria
            0,
            { cutoff: thirtyDaysAgo }
        );

        for (let record of trashedFiles) {
            $app.dao().deleteRecord(record);
        }
    } catch (e) {
        // Silencioso si la colección 'files' aún no se ha inicializado
    }
});
