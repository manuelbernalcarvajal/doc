/// <reference path="../pb_data/types.d.ts" />

/**
 * 1. Asegurar campo 'notified' en calendar_events al arrancar
 */
onAfterBootstrap((e) => {
    try {
        const calCol = $app.dao().findCollectionByNameOrId("calendar_events");
        if (!calCol.schema.getFieldByName("notified")) {
            const field = new SchemaField();
            field.name = "notified";
            field.type = "bool";
            field.required = false;
            calCol.schema.addField(field);
            $app.dao().saveCollection(calCol);
        }
    } catch (_) {}
});

/**
 * 2. Obtener configuración SMTP actual (Solo admin de la app)
 * Ruta: GET /api/custom/mail-settings
 */
routerAdd("GET", "/api/custom/mail-settings", (c) => {
    const authRecord = c.get("authRecord");
    if (!authRecord || authRecord.get("role") !== "admin") {
        return c.json(403, { error: "Acceso denegado: requiere rol admin." });
    }

    const settings = $app.dao().findSettings();
    return c.json(200, {
        enabled: !!settings.smtp.enabled,
        host: settings.smtp.host || "",
        port: settings.smtp.port || 587,
        username: settings.smtp.username || "",
        tls: !!settings.smtp.tls,
        sender_address: settings.meta.senderAddress || "",
        sender_name: settings.meta.senderName || "Nube Notificaciones"
    });
}, $apis.requireRecordAuth());

/**
 * 3. Guardar configuración SMTP (Solo admin de la app)
 * Ruta: POST /api/custom/mail-settings
 */
routerAdd("POST", "/api/custom/mail-settings", (c) => {
    const authRecord = c.get("authRecord");
    if (!authRecord || authRecord.get("role") !== "admin") {
        return c.json(403, { error: "Acceso denegado: requiere rol admin." });
    }

    const data = $apis.requestInfo(c).data;
    const settings = $app.dao().findSettings();

    settings.smtp.enabled = !!data.enabled;
    settings.smtp.host = data.host || "";
    settings.smtp.port = parseInt(data.port, 10) || 587;
    settings.smtp.username = data.username || "";
    if (data.password) {
        settings.smtp.password = data.password;
    }
    settings.smtp.tls = !!data.tls;

    settings.meta.senderAddress = data.sender_address || data.username || "";
    settings.meta.senderName = data.sender_name || "Nube Despacho";

    $app.dao().saveSettings(settings);

    return c.json(200, { status: "success", message: "Configuración SMTP actualizada correctamente." });
}, $apis.requireRecordAuth());

/**
 * 4. Envío de email de prueba
 * Ruta: POST /api/custom/mail-test
 */
routerAdd("POST", "/api/custom/mail-test", (c) => {
    const authRecord = c.get("authRecord");
    if (!authRecord || authRecord.get("role") !== "admin") {
        return c.json(403, { error: "Acceso denegado." });
    }

    const targetEmail = authRecord.getString("email");
    const settings = $app.dao().findSettings();

    if (!settings.smtp.enabled || !settings.smtp.host) {
        return c.json(400, { error: "El servidor SMTP no está activado ni configurado." });
    }

    try {
        const mailClient = $app.newMailClient();
        const message = new MailerMessage({
            from: {
                address: settings.meta.senderAddress,
                name: settings.meta.senderName
            },
            to: [{ address: targetEmail }],
            subject: "Prueba de conexión SMTP - Monolito",
            html: `<p>Hola <b>${authRecord.getString("email")}</b>,</p><p>El servidor SMTP está correctamente configurado y listo para emitir avisos de agenda.</p>`
        });

        mailClient.send(message);
        return c.json(200, { status: "success", message: `Mensaje de prueba enviado a ${targetEmail}` });
    } catch (err) {
        return c.json(500, { error: "Error al enviar correo de prueba: " + err.message });
    }
}, $apis.requireRecordAuth());

/**
 * 5. Daemon Cron: Notificador de Eventos (Cada 5 minutos)
 * Revisa eventos pendientes de notificar que inicien en los próximos 30 minutos
 */
cronAdd("calendar_reminder_worker", "*/5 * * * *", () => {
    const settings = $app.dao().findSettings();
    if (!settings.smtp.enabled || !settings.smtp.host) {
        return;
    }

    const now = new Date();
    const threshold = new Date(now.getTime() + 30 * 60 * 1000); // Próximos 30 minutos

    const nowStr = now.toISOString().replace("T", " ").substring(0, 19);
    const thresholdStr = threshold.toISOString().replace("T", " ").substring(0, 19);

    try {
        // Eventos futuros próximos que no hayan sido notificados
        const events = $app.dao().findRecordsByFilter(
            "calendar_events",
            "start_time >= {:now} && start_time <= {:threshold} && (notified = false || notified = null)",
            "start_time",
            50,
            0,
            { now: nowStr, threshold: thresholdStr }
        );

        const mailClient = $app.newMailClient();

        for (let evt of events) {
            const ownerId = evt.getString("owner");
            if (!ownerId) continue;

            const owner = $app.dao().findRecordById("users", ownerId);
            if (!owner || !owner.getString("email")) continue;

            const eventTitle = evt.getString("title");
            const eventTime = evt.getString("start_time");
            const location = evt.getString("location") ? `<p><b>Ubicación:</b> ${evt.getString("location")}</p>` : "";
            const desc = evt.getString("description") ? `<p><b>Detalles:</b> ${evt.getString("description")}</p>` : "";

            const message = new MailerMessage({
                from: {
                    address: settings.meta.senderAddress,
                    name: settings.meta.senderName
                },
                to: [{ address: owner.getString("email") }],
                subject: `Recordatorio: ${eventTitle}`,
                html: `
                    <h2>Recordatorio de Evento</h2>
                    <p>Tienes programado el evento <strong>${eventTitle}</strong> próximamente.</p>
                    <p><b>Fecha y Hora:</b> ${eventTime}</p>
                    ${location}
                    ${desc}
                `
            });

            mailClient.send(message);

            // Marcar como notificado para evitar duplicados
            evt.set("notified", true);
            $app.dao().saveRecord(evt);
        }
    } catch (err) {
        console.error("[CRON CALENDAR] Error en despacho de recordatorios:", err.message);
    }
});
