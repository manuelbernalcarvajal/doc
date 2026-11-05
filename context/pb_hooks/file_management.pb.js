/// <reference path="../pb_data/types.d.ts" />

const fileManagementResources = ["files", "folders"];

function managementAccess(record, user) {
    return record && user && (user.getString("role") === "admin"
        || record.getString("owner") === user.id
        || (record.getBool("is_group") && record.getString("group") === user.getString("user_group")));
}

function managementUser(c) {
    return c.get("authRecord");
}

function logFileActivity(actor, resourceType, resourceId, action, resourceName, details) {
    try {
        const resource = $app.dao().findRecordById(resourceType === "file" ? "files" : "folders", resourceId);
        const owner = $app.dao().findRecordById("users", resource.getString("owner"));
        const activity = new Record($app.dao().findCollectionByNameOrId("file_activity"));
        activity.set("owner", owner.id);
        activity.set("actor", actor.id);
        activity.set("resource_type", resourceType);
        activity.set("resource_id", resourceId);
        activity.set("action", action);
        activity.set("resource_name", resourceName || resource.getString("name"));
        activity.set("details", details || "");
        $app.dao().saveRecord(activity);
    } catch (error) {
        console.error("[ACTIVITY] No se pudo registrar la actividad:", error.message);
    }
}

function childFiles(folderId) {
    return $app.dao().findRecordsByFilter("files", "folder = {:folder}", "", 10000, 0, { folder: folderId });
}

function childFolders(folderId) {
    return $app.dao().findRecordsByFilter("folders", "parent = {:parent}", "", 10000, 0, { parent: folderId });
}

function markFolderTree(folder, trashed, timestamp, actor) {
    folder.set("trashed", trashed);
    folder.set("trashed_at", trashed ? timestamp : null);
    $app.dao().saveRecord(folder);
    logFileActivity(actor, "folder", folder.id, trashed ? "trash" : "restore", folder.getString("name"), "Operación recursiva");
    for (let file of childFiles(folder.id)) {
        file.set("trashed", trashed);
        file.set("trashed_at", trashed ? timestamp : null);
        $app.dao().saveRecord(file);
        logFileActivity(actor, "file", file.id, trashed ? "trash" : "restore", file.getString("name"), "Operación recursiva");
    }
    for (let child of childFolders(folder.id)) markFolderTree(child, trashed, timestamp, actor);
}

routerAdd("GET", "/api/custom/file-trash", (c) => {
    const user = managementUser(c);
    const trashedFiles = $app.dao().findRecordsByFilter("files", "trashed = true", "-trashed_at", 10000, 0);
    const trashedFolders = $app.dao().findRecordsByFilter("folders", "trashed = true", "-trashed_at", 10000, 0);
    const items = [];
    for (let file of trashedFiles) {
        if (managementAccess(file, user)) items.push({ id: file.id, type: "file", name: file.getString("name"), size: file.getInt("size"), trashedAt: file.getString("trashed_at"), owner: file.getString("owner") });
    }
    for (let folder of trashedFolders) {
        if (managementAccess(folder, user)) items.push({ id: folder.id, type: "folder", name: folder.getString("name"), trashedAt: folder.getString("trashed_at"), owner: folder.getString("owner") });
    }
    return c.json(200, { items: items });
}, $apis.requireRecordAuth());

routerAdd("POST", "/api/custom/file-trash/:resourceType/:resourceId/restore", (c) => {
    const user = managementUser(c);
    const resourceType = c.pathParam("resourceType");
    const resourceId = c.pathParam("resourceId");
    if (!fileManagementResources.includes(resourceType)) return c.json(400, { error: "Tipo de recurso no válido." });
    let record;
    try {
        record = $app.dao().findRecordById(resourceType, resourceId);
    } catch (_) {
        return c.json(404, { error: "Recurso no encontrado." });
    }
    if (!managementAccess(record, user)) return c.json(403, { error: "No tienes permiso para restaurar este recurso." });
    if (resourceType === "files") {
        record.set("trashed", false);
        record.set("trashed_at", null);
        $app.dao().saveRecord(record);
        logFileActivity(user, "file", record.id, "restore", record.getString("name"), "");
    } else {
        markFolderTree(record, false, null, user);
    }
    return c.json(200, { restored: true });
}, $apis.requireRecordAuth());

routerAdd("DELETE", "/api/custom/file-trash/:resourceType/:resourceId", (c) => {
    const user = managementUser(c);
    const resourceType = c.pathParam("resourceType");
    const resourceId = c.pathParam("resourceId");
    if (!fileManagementResources.includes(resourceType)) return c.json(400, { error: "Tipo de recurso no válido." });
    let record;
    try {
        record = $app.dao().findRecordById(resourceType, resourceId);
    } catch (_) {
        return c.json(404, { error: "Recurso no encontrado." });
    }
    if (!managementAccess(record, user) || !record.getBool("trashed")) return c.json(403, { error: "No tienes permiso para vaciar este recurso." });
    if (resourceType === "folders") {
        for (let child of childFolders(record.id)) {
            if (child.getBool("trashed")) $app.dao().deleteRecord(child);
        }
        for (let file of childFiles(record.id)) {
            if (file.getBool("trashed")) $app.dao().deleteRecord(file);
        }
    }
    logFileActivity(user, resourceType === "files" ? "file" : "folder", record.id, "purge", record.getString("name"), "");
    $app.dao().deleteRecord(record);
    return c.json(200, { purged: true });
}, $apis.requireRecordAuth());

routerAdd("GET", "/api/custom/file-activity", (c) => {
    const user = managementUser(c);
    const resourceId = String(c.queryParam("resourceId") || "");
    const filter = resourceId
        ? "resource_id = {:id} && (owner = {:owner} || actor = {:owner})"
        : "owner = {:owner} || actor = {:owner}";
    const records = $app.dao().findRecordsByFilter("file_activity", filter, "-created", 200, 0, { id: resourceId, owner: user.id });
    return c.json(200, { items: records.map(item => ({
        id: item.id,
        resourceType: item.getString("resource_type"),
        resourceId: item.getString("resource_id"),
        action: item.getString("action"),
        resourceName: item.getString("resource_name"),
        details: item.getString("details"),
        created: item.created
    })) });
}, $apis.requireRecordAuth());

routerAdd("POST", "/api/custom/file-activity", (c) => {
    const user = managementUser(c);
    const data = $apis.requestInfo(c).data;
    const resourceType = data.resourceType === "folder" ? "folder" : "file";
    const resourceId = String(data.resourceId || "");
    if (!resourceId || !["upload", "rename", "move", "trash", "restore", "edit", "download"].includes(String(data.action || ""))) {
        return c.json(400, { error: "Actividad no válida." });
    }
    let resource;
    try {
        resource = $app.dao().findRecordById(resourceType === "file" ? "files" : "folders", resourceId);
    } catch (_) {
        return c.json(404, { error: "Recurso no encontrado." });
    }
    if (!managementAccess(resource, user)) return c.json(403, { error: "No tienes permiso para registrar actividad." });
    logFileActivity(user, resourceType, resourceId, String(data.action), resource.getString("name"), String(data.details || ""));
    return c.json(200, { recorded: true });
}, $apis.requireRecordAuth());

onRecordBeforeDeleteRequest((e) => {
    if (e.collection && ["files", "folders"].includes(e.collection.name)) {
        throw new Error("Los archivos y carpetas deben enviarse a la papelera antes de eliminarse definitivamente.");
    }
});

routerAdd("POST", "/api/custom/file-trash/:resourceType/:resourceId/trash", (c) => {
    const user = managementUser(c);
    const resourceType = c.pathParam("resourceType");
    const resourceId = c.pathParam("resourceId");
    if (!fileManagementResources.includes(resourceType)) return c.json(400, { error: "Tipo de recurso no válido." });
    let record;
    try {
        record = $app.dao().findRecordById(resourceType, resourceId);
    } catch (_) {
        return c.json(404, { error: "Recurso no encontrado." });
    }
    if (!managementAccess(record, user)) return c.json(403, { error: "No tienes permiso para enviar este recurso a la papelera." });
    if (resourceType === "folders") {
        markFolderTree(record, true, new Date().toISOString(), user);
    } else {
        record.set("trashed", true);
        record.set("trashed_at", new Date().toISOString());
        $app.dao().saveRecord(record);
        logFileActivity(user, "file", record.id, "trash", record.getString("name"), "");
    }
    return c.json(200, { trashed: true });
}, $apis.requireRecordAuth());
