/// <reference path="../pb_data/types.d.ts" />

/**
 * Inicializador idempotente del esquema de datos y control de accesos (RBAC).
 * Se ejecuta automáticamente al arrancar PocketBase. Si las colecciones ya existen, no hace nada.
 */
onAfterBootstrap((e) => {
    const dao = $app.dao();

    const helperField = (name, type, required = false, options = {}) => {
        const field = new SchemaField();
        field.name = name;
        field.type = type;
        field.required = !!required;
        field.options = options;
        return field;
    };

    const collectionExists = (name) => {
        try {
            dao.findCollectionByNameOrId(name);
            return true;
        } catch (_) {
            return false;
        }
    };

    // 1. Colección: groups (Departamentos o equipos)
    let groupsCol;
    if (!collectionExists("groups")) {
        groupsCol = new Collection();
        groupsCol.name = "groups";
        groupsCol.type = "base";
        groupsCol.listRule = "@request.auth.id != ''";
        groupsCol.viewRule = "@request.auth.id != ''";
        groupsCol.createRule = "@request.auth.role = 'admin'";
        groupsCol.updateRule = "@request.auth.role = 'admin'";
        groupsCol.deleteRule = "@request.auth.role = 'admin'";

        groupsCol.schema.addField(helperField("name", "text", true, { min: 1, max: 100 }));
        groupsCol.schema.addField(helperField("description", "text", false));

        dao.saveCollection(groupsCol);
    } else {
        groupsCol = dao.findCollectionByNameOrId("groups");
    }

    // 2. Extender colección del sistema: users
    const usersCol = dao.findCollectionByNameOrId("users");
    let usersUpdated = false;

    if (!usersCol.schema.getFieldByName("role")) {
        usersCol.schema.addField(helperField("role", "select", true, {
            maxSelect: 1,
            values: ["admin", "user"]
        }));
        usersUpdated = true;
    }

    if (!usersCol.schema.getFieldByName("user_group")) {
        usersCol.schema.addField(helperField("user_group", "relation", false, {
            collectionId: groupsCol.id,
            maxSelect: 1
        }));
        usersUpdated = true;
    }

    if (!usersCol.schema.getFieldByName("storage_quota")) {
        // Cuota en bytes (por defecto 10 GB: 10737418240; 0 = ilimitado)
        usersCol.schema.addField(helperField("storage_quota", "number", false));
        usersUpdated = true;
    }

    if (usersUpdated) {
        dao.saveCollection(usersCol);
    }

    // Regla común de seguridad: Propietario O Miembro del Grupo O Admin de la App
    const rbacRule = "@request.auth.id != '' && (owner = @request.auth.id || (is_group = true && @request.auth.user_group = group) || @request.auth.role = 'admin')";

    // 3. Colección: folders (Estructura de carpetas)
    let foldersCol;
    if (!collectionExists("folders")) {
        foldersCol = new Collection();
        foldersCol.name = "folders";
        foldersCol.type = "base";
        foldersCol.listRule = rbacRule;
        foldersCol.viewRule = rbacRule;
        foldersCol.createRule = "@request.auth.id != '' && owner = @request.auth.id";
        foldersCol.updateRule = rbacRule;
        foldersCol.deleteRule = rbacRule;

        foldersCol.schema.addField(helperField("name", "text", true, { min: 1, max: 255 }));
        foldersCol.schema.addField(helperField("owner", "relation", true, {
            collectionId: usersCol.id,
            maxSelect: 1
        }));
        foldersCol.schema.addField(helperField("group", "relation", false, {
            collectionId: groupsCol.id,
            maxSelect: 1
        }));
        foldersCol.schema.addField(helperField("is_group", "bool", false));

        dao.saveCollection(foldersCol);

        // Relación autoreferenciada para carpetas anidadas
        foldersCol.schema.addField(helperField("parent", "relation", false, {
            collectionId: foldersCol.id,
            maxSelect: 1
        }));
        dao.saveCollection(foldersCol);
    } else {
        foldersCol = dao.findCollectionByNameOrId("folders");
    }

    // 4. Colección: files (Metadatos y almacenamiento de ficheros)
    if (!collectionExists("files")) {
        const filesCol = new Collection();
        filesCol.name = "files";
        filesCol.type = "base";
        filesCol.listRule = rbacRule;
        filesCol.viewRule = rbacRule;
        filesCol.createRule = "@request.auth.id != '' && owner = @request.auth.id";
        filesCol.updateRule = rbacRule;
        filesCol.deleteRule = rbacRule;

        filesCol.schema.addField(helperField("name", "text", true, { min: 1, max: 255 }));
        filesCol.schema.addField(helperField("file", "file", true, {
            maxSelect: 1,
            maxSize: 10737418240 // 10 GB
        }));
        filesCol.schema.addField(helperField("size", "number", false));
        filesCol.schema.addField(helperField("owner", "relation", true, {
            collectionId: usersCol.id,
            maxSelect: 1
        }));
        filesCol.schema.addField(helperField("folder", "relation", false, {
            collectionId: foldersCol.id,
            maxSelect: 1
        }));
        filesCol.schema.addField(helperField("group", "relation", false, {
            collectionId: groupsCol.id,
            maxSelect: 1
        }));
        filesCol.schema.addField(helperField("is_group", "bool", false));
        filesCol.schema.addField(helperField("trashed", "bool", false));
        filesCol.schema.addField(helperField("trashed_at", "date", false));

        dao.saveCollection(filesCol);
    }

    // 5. Colección: calendar_events (Agenda individual y compartida)
    if (!collectionExists("calendar_events")) {
        const calCol = new Collection();
        calCol.name = "calendar_events";
        calCol.type = "base";
        calCol.listRule = rbacRule;
        calCol.viewRule = rbacRule;
        calCol.createRule = "@request.auth.id != '' && owner = @request.auth.id";
        calCol.updateRule = rbacRule;
        calCol.deleteRule = rbacRule;

        calCol.schema.addField(helperField("title", "text", true, { min: 1, max: 200 }));
        calCol.schema.addField(helperField("description", "text", false));
        calCol.schema.addField(helperField("start_time", "date", true));
        calCol.schema.addField(helperField("end_time", "date", true));
        calCol.schema.addField(helperField("is_all_day", "bool", false));
        calCol.schema.addField(helperField("location", "text", false));
        calCol.schema.addField(helperField("owner", "relation", true, {
            collectionId: usersCol.id,
            maxSelect: 1
        }));
        calCol.schema.addField(helperField("group", "relation", false, {
            collectionId: groupsCol.id,
            maxSelect: 1
        }));
        calCol.schema.addField(helperField("is_group", "bool", false));

        dao.saveCollection(calCol);
    }

    // 6. Colección: contacts (Libreta de contactos)
    if (!collectionExists("contacts")) {
        const contactsCol = new Collection();
        contactsCol.name = "contacts";
        contactsCol.type = "base";
        contactsCol.listRule = rbacRule;
        contactsCol.viewRule = rbacRule;
        contactsCol.createRule = "@request.auth.id != '' && owner = @request.auth.id";
        contactsCol.updateRule = rbacRule;
        contactsCol.deleteRule = rbacRule;

        contactsCol.schema.addField(helperField("name", "text", true, { min: 1, max: 150 }));
        contactsCol.schema.addField(helperField("email", "email", false));
        contactsCol.schema.addField(helperField("phone", "text", false));
        contactsCol.schema.addField(helperField("company", "text", false));
        contactsCol.schema.addField(helperField("notes", "text", false));
        contactsCol.schema.addField(helperField("owner", "relation", true, {
            collectionId: usersCol.id,
            maxSelect: 1
        }));
        contactsCol.schema.addField(helperField("group", "relation", false, {
            collectionId: groupsCol.id,
            maxSelect: 1
        }));
        contactsCol.schema.addField(helperField("is_group", "bool", false));

        dao.saveCollection(contactsCol);
    }

    console.log("[SCHEMA] Colecciones y reglas RBAC verificadas/inicializadas con éxito.");
});
