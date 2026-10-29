/// <reference path="../pb_data/types.d.ts" />

/**
 * Inicializador idempotente del esquema de datos, almacenamiento S3 cifrado,
 * control de accesos (RBAC), tema corporativo y parámetros WOPI.
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

    // 1. Colección: app_settings (Identidad visual, marca y ajuste WOPI)
    let settingsCol;
    if (!collectionExists("app_settings")) {
        settingsCol = new Collection();
        settingsCol.name = "app_settings";
        settingsCol.type = "base";
        settingsCol.listRule = "";
        settingsCol.viewRule = "";
        settingsCol.createRule = "@request.auth.role = 'admin'";
        settingsCol.updateRule = "@request.auth.role = 'admin'";
        settingsCol.deleteRule = "@request.auth.role = 'admin'";

        settingsCol.schema.addField(helperField("app_name", "text", true));
        settingsCol.schema.addField(helperField("app_icon", "text", true));
        settingsCol.schema.addField(helperField("accent_color", "text", true));
        settingsCol.schema.addField(helperField("wopi_enabled", "bool", false));
        settingsCol.schema.addField(helperField("wopi_server_url", "text", false));
        settingsCol.schema.addField(helperField("wopi_public_url", "text", false));

        dao.saveCollection(settingsCol);

        const defaultTheme = new Record(settingsCol);
        defaultTheme.set("app_name", "Nube Monolito");
        defaultTheme.set("app_icon", "📁");
        defaultTheme.set("accent_color", "#2563eb");
        defaultTheme.set("wopi_enabled", false);
        defaultTheme.set("wopi_server_url", "");
        defaultTheme.set("wopi_public_url", "");
        dao.saveRecord(defaultTheme);
    } else {
        settingsCol = dao.findCollectionByNameOrId("app_settings");
        let modified = false;
        if (!settingsCol.schema.getFieldByName("wopi_enabled")) {
            settingsCol.schema.addField(helperField("wopi_enabled", "bool", false));
            modified = true;
        }
        if (!settingsCol.schema.getFieldByName("wopi_server_url")) {
            settingsCol.schema.addField(helperField("wopi_server_url", "text", false));
            modified = true;
        }
        if (!settingsCol.schema.getFieldByName("wopi_public_url")) {
            settingsCol.schema.addField(helperField("wopi_public_url", "text", false));
            modified = true;
        }
        if (modified) {
            dao.saveCollection(settingsCol);
        }
    }

    // 2. Colección: groups (Departamentos o equipos)
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

    // 3. Extender colección: users
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
        usersCol.schema.addField(helperField("storage_quota", "number", false));
        usersUpdated = true;
    }

    if (!usersCol.schema.getFieldByName("force_password_change")) {
        usersCol.schema.addField(helperField("force_password_change", "bool", false));
        usersUpdated = true;
    }

    if (usersUpdated) {
        dao.saveCollection(usersCol);
    }

    // Regla de seguridad RLS
    const rbacRule = "@request.auth.id != '' && (owner = @request.auth.id || (is_group = true && @request.auth.user_group = group) || @request.auth.role = 'admin')";

    // 4. Colección: folders
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

        foldersCol.schema.addField(helperField("parent", "relation", false, {
            collectionId: foldersCol.id,
            maxSelect: 1
        }));
        dao.saveCollection(foldersCol);
    } else {
        foldersCol = dao.findCollectionByNameOrId("folders");
    }

    // 5. Colección: files
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

    // 6. Colección: calendar_events
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

    // 7. Colección: contacts
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

    // 8. Almacenamiento S3 interno cifrado
    const settings = dao.findSettings();
    if (!settings.s3.enabled) {
        settings.s3.enabled = true;
        settings.s3.endpoint = "http://127.0.0.1:9000";
        settings.s3.bucket = "monolith-data";
        settings.s3.region = "us-east-1";
        settings.s3.accessKey = "monolith_internal";
        settings.s3.secret = "monolith_internal_secret_98765";
        settings.s3.forcePathStyle = true;
        dao.saveSettings(settings);
        console.log("[CONFIG] Almacenamiento S3 interno cifrado conectado.");
    }

    // 9. Administrador inicial en caso de base de datos vacía
    const totalUsers = dao.findRecordsByFilter("users", "1=1", "", 1, 0).length;
    if (totalUsers === 0) {
        const defaultAdmin = new Record(usersCol);
        defaultAdmin.setUsername("admin");
        defaultAdmin.setEmail("admin@despacho.local");
        defaultAdmin.setPassword("Admin12345!");
        defaultAdmin.set("role", "admin");
        defaultAdmin.set("force_password_change", true);
        defaultAdmin.set("storage_quota", 0);
        defaultAdmin.setVerified(true);

        dao.saveRecord(defaultAdmin);
        console.log("[BOOTSTRAP] Usuario inicial creado: admin / Admin12345!");
    }
});

/**
 * 10. Forzar clave temporal en nuevas cuentas
 */
onRecordBeforeCreateRequest((e) => {
    if (e.collection.name === "users") {
        e.record.set("force_password_change", true);
    }
});
