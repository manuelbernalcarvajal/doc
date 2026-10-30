/// <reference path="../pb_data/types.d.ts" />

const LOCKABLE_RESOURCES = ["files", "folders", "calendar_events", "contacts"];
const GENERIC_LOCK_TTL_SECONDS = 15 * 60;

function findActiveResourceLock(resourceType, resourceId) {
    const locks = $app.dao().findRecordsByFilter(
        "resource_locks",
        "resource_type = {:type} && resource_id = {:id}",
        "",
        1,
        0,
        { type: resourceType, id: resourceId }
    );
    if (locks.length === 0) return null;

    const lock = locks[0];
    if (new Date(lock.getString("expires_at")).getTime() <= Date.now()) {
        $app.dao().deleteRecord(lock);
        return null;
    }
    return lock;
}

function findLockableResource(resourceType, resourceId) {
    if (!LOCKABLE_RESOURCES.includes(resourceType)) return null;
    try {
        return $app.dao().findRecordById(resourceType, resourceId);
    } catch (_) {
        return null;
    }
}

function canAccessLockableResource(record, authRecord) {
    if (!record || !authRecord) return false;
    if (authRecord.getString("role") === "admin") return true;
    if (record.getString("owner") === authRecord.id) return true;
    return record.getBool("is_group")
        && record.getString("group")
        && record.getString("group") === authRecord.getString("user_group");
}

function lockResponse(c, status, body) {
    return c.json(status, body);
}

routerAdd("POST", "/api/custom/locks/acquire", (c) => {
    const authRecord = c.get("authRecord");
    if (!authRecord) return lockResponse(c, 401, { error: "No autenticado." });

    const data = $apis.requestInfo(c).data;
    const resourceType = String(data.resourceType || "");
    const resourceId = String(data.resourceId || "");
    const requestedToken = String(data.token || "");
    const ttl = Math.min(Math.max(parseInt(data.ttlSeconds, 10) || GENERIC_LOCK_TTL_SECONDS, 30), 3600);
    const resource = findLockableResource(resourceType, resourceId);

    if (!resource) return lockResponse(c, 404, { error: "Recurso no encontrado o no bloqueable." });
    if (!canAccessLockableResource(resource, authRecord)) {
        return lockResponse(c, 403, { error: "No tienes permiso para bloquear este recurso." });
    }

    const current = findActiveResourceLock(resourceType, resourceId);
    if (current && current.getString("owner") !== authRecord.id) {
        return lockResponse(c, 409, {
            error: "El recurso está bloqueado por otro usuario.",
            expiresAt: current.getString("expires_at")
        });
    }
    if (current && requestedToken && current.getString("token") !== requestedToken) {
        return lockResponse(c, 409, { error: "El token de bloqueo no coincide." });
    }

    const token = current ? current.getString("token") : $security.randomString(48);
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    const lock = current || new Record($app.dao().findCollectionByNameOrId("resource_locks"));
    lock.set("resource_type", resourceType);
    lock.set("resource_id", resourceId);
    lock.set("token", token);
    lock.set("owner", authRecord.id);
    lock.set("expires_at", expiresAt);
    try {
        $app.dao().saveRecord(lock);
    } catch (e) {
        return lockResponse(c, 409, { error: "El recurso acaba de ser bloqueado por otro usuario." });
    }

    return lockResponse(c, 200, { token: token, expiresAt: expiresAt });
}, $apis.requireRecordAuth());

routerAdd("POST", "/api/custom/locks/release", (c) => {
    const authRecord = c.get("authRecord");
    if (!authRecord) return lockResponse(c, 401, { error: "No autenticado." });

    const data = $apis.requestInfo(c).data;
    const resourceType = String(data.resourceType || "");
    const resourceId = String(data.resourceId || "");
    const token = String(data.token || "");
    const lock = findActiveResourceLock(resourceType, resourceId);

    if (!lock) return lockResponse(c, 200, { released: false });
    if (lock.getString("owner") !== authRecord.id || lock.getString("token") !== token) {
        return lockResponse(c, 409, { error: "El token de bloqueo no coincide." });
    }
    $app.dao().deleteRecord(lock);
    return lockResponse(c, 200, { released: true });
}, $apis.requireRecordAuth());

routerAdd("GET", "/api/custom/locks/status", (c) => {
    const authRecord = c.get("authRecord");
    if (!authRecord) return lockResponse(c, 401, { error: "No autenticado." });

    const resourceType = String(c.queryParam("resourceType") || "");
    const resourceId = String(c.queryParam("resourceId") || "");
    const lock = findActiveResourceLock(resourceType, resourceId);
    if (!lock) return lockResponse(c, 200, { locked: false });

    return lockResponse(c, 200, {
        locked: true,
        ownedByCurrentUser: lock.getString("owner") === authRecord.id,
        expiresAt: lock.getString("expires_at")
    });
}, $apis.requireRecordAuth());

cronAdd("clean_expired_resource_locks", "*/5 * * * *", () => {
    try {
        const locks = $app.dao().findRecordsByFilter("resource_locks", "expires_at < {:now}", "", 500, 0, {
            now: new Date().toISOString()
        });
        for (let lock of locks) $app.dao().deleteRecord(lock);
    } catch (e) {
        console.error("[LOCKS] Error al limpiar bloqueos expirados:", e.message);
    }
});

function enforceResourceLock(e) {
    if (!e.collection || !LOCKABLE_RESOURCES.includes(e.collection.name) || !e.record) return;

    const info = $apis.requestInfo(e.httpContext);
    const authRecord = info.authRecord;
    const lock = findActiveResourceLock(e.collection.name, e.record.id);
    if (!lock) return;

    const requestToken = e.httpContext.request().header.get("X-Resource-Lock") || "";
    if (!authRecord
        || lock.getString("owner") !== authRecord.id
        || lock.getString("token") !== requestToken) {
        throw new Error("El recurso está bloqueado. Debes presentar el token de bloqueo válido.");
    }
}

onRecordBeforeUpdateRequest(enforceResourceLock);
onRecordBeforeDeleteRequest(enforceResourceLock);
