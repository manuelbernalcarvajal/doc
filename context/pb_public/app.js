/**
 * Cliente SPA Monolito (Vanilla JS ES6+)
 * Theming corporativo centralizado en base de datos, subida por fragmentos,
 * recordatorios SMTP de agenda, contactos y control de claves.
 */

const CONFIG = {
    CHUNK_SIZE: 20 * 1024 * 1024, // 20 MB por fragmento
    API_URL: window.location.origin
};

const state = {
    token: localStorage.getItem("pb_token") || "",
    user: JSON.parse(localStorage.getItem("pb_user") || "null"),
    currentView: "files",
    currentFolder: "",
    folderPath: [],
    contactsCache: [],
    calendarEventsCache: [],
    settingsRecordId: null
};

// ==========================================
// 1. INICIALIZACIÓN Y SESIÓN
// ==========================================

document.addEventListener("DOMContentLoaded", () => {
    fetchGlobalTheme();
    initEventListeners();

    if (state.token && state.user) {
        verifySession();
    } else {
        showAuth();
    }
});

function initEventListeners() {
    document.getElementById("login-form").addEventListener("submit", handleLogin);

    document.querySelectorAll(".nav-item").forEach(btn => {
        btn.addEventListener("click", () => switchView(btn.dataset.view));
    });

    document.getElementById("btn-logout").addEventListener("click", handleLogout);

    document.getElementById("contact-search").addEventListener("input", (e) => {
        renderContacts(e.target.value.toLowerCase());
    });

    // Administración
    document.getElementById("admin-customization-form").addEventListener("submit", handleSaveCustomization);
    document.getElementById("setting-accent-color").addEventListener("input", (e) => {
        document.getElementById("color-hex-label").textContent = e.target.value;
    });

    const smtpForm = document.getElementById("admin-smtp-form");
    if (smtpForm) {
        smtpForm.addEventListener("submit", handleSaveSmtp);
        document.getElementById("btn-test-smtp").addEventListener("click", handleTestSmtp);
    }

    const btnNewUser = document.getElementById("btn-new-user");
    if (btnNewUser) {
        btnNewUser.addEventListener("click", modalNewUser);
    }

    document.getElementById("modal-close").addEventListener("click", closeModal);
}

async function verifySession() {
    try {
        const res = await fetch(`${CONFIG.API_URL}/api/collections/users/auth-refresh`, {
            method: "POST",
            headers: getHeaders()
        });
        if (!res.ok) throw new Error("Sesión caducada");
        const data = await res.json();
        setSession(data.token, data.record);

        if (data.record.force_password_change) {
            modalForcePasswordChange();
        } else {
            showDashboard();
        }
    } catch (_) {
        handleLogout();
    }
}

async function handleLogin(e) {
    e.preventDefault();
    const identity = document.getElementById("login-email").value.trim();
    const password = document.getElementById("login-password").value;
    const totpCode = document.getElementById("login-totp").value.trim();
    const errBox = document.getElementById("login-error");
    const totpGroup = document.getElementById("totp-group");

    errBox.style.display = "none";

    const payload = { identity: identity, password: password };
    if (totpCode) payload.mfaCode = totpCode;

    try {
        const res = await fetch(`${CONFIG.API_URL}/api/collections/users/auth-with-password`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        const data = await res.json();

        if (data.mfaId && !totpCode) {
            totpGroup.style.display = "block";
            errBox.textContent = "Introduce el código de 6 dígitos de tu aplicación TOTP.";
            errBox.style.display = "block";
            return;
        }

        if (!res.ok) throw new Error(data.message || "Credenciales incorrectas.");

        setSession(data.token, data.record);

        if (data.record.force_password_change) {
            modalForcePasswordChange();
        } else {
            showDashboard();
        }
    } catch (err) {
        errBox.textContent = err.message;
        errBox.style.display = "block";
    }
}

function setSession(token, user) {
    state.token = token;
    state.user = user;
    localStorage.setItem("pb_token", token);
    localStorage.setItem("pb_user", JSON.stringify(user));
}

function handleLogout() {
    state.token = "";
    state.user = null;
    localStorage.removeItem("pb_token");
    localStorage.removeItem("pb_user");
    showAuth();
}

function showAuth() {
    document.getElementById("auth-container").style.display = "flex";
    document.getElementById("app-container").style.display = "none";
}

function showDashboard() {
    document.getElementById("auth-container").style.display = "none";
    document.getElementById("app-container").style.display = "flex";

    const name = state.user.name || state.user.username || state.user.email.split("@")[0];
    document.getElementById("user-display-name").textContent = name;
    document.getElementById("user-initial").textContent = name.charAt(0).toUpperCase();
    document.getElementById("user-display-role").textContent = state.user.role || "user";

    if (state.user.role === "admin") {
        document.getElementById("nav-admin").style.display = "flex";
    } else {
        document.getElementById("nav-admin").style.display = "none";
    }

    switchView("files");
    loadQuota();
}

function getHeaders(isJson = true) {
    const headers = { "Authorization": state.token };
    if (isJson) headers["Content-Type"] = "application/json";
    return headers;
}

// ==========================================
// 2. NAVEGACIÓN Y VISTAS
// ==========================================

function switchView(viewName) {
    state.currentView = viewName;

    document.querySelectorAll(".nav-item").forEach(item => {
        item.classList.toggle("active", item.dataset.view === viewName);
    });

    document.querySelectorAll(".view-pane").forEach(pane => {
        pane.classList.remove("active");
    });

    const activePane = document.getElementById(`view-${viewName}`);
    if (activePane) activePane.classList.add("active");

    const titles = {
        files: "Archivos",
        calendar: "Calendario",
        contacts: "Contactos",
        admin: "Administración"
    };
    document.getElementById("current-view-title").textContent = titles[viewName] || "Nube";

    renderTopbarActions(viewName);

    if (viewName === "files") loadFiles();
    if (viewName === "calendar") loadCalendar();
    if (viewName === "contacts") loadContacts();
    if (viewName === "admin") loadAdminData();
}

function renderTopbarActions(viewName) {
    const container = document.getElementById("topbar-actions");
    container.innerHTML = "";

    if (viewName === "files") {
        const btnUpload = document.createElement("button");
        btnUpload.className = "btn btn-primary btn-sm";
        btnUpload.innerHTML = "⬆️ Subir Archivo";
        btnUpload.onclick = triggerFileSelect;

        const btnNewFolder = document.createElement("button");
        btnNewFolder.className = "btn btn-secondary btn-sm";
        btnNewFolder.innerHTML = "📁 Nueva Carpeta";
        btnNewFolder.onclick = modalNewFolder;

        container.appendChild(btnNewFolder);
        container.appendChild(btnUpload);
    } else if (viewName === "calendar") {
        const btnNewEvent = document.createElement("button");
        btnNewEvent.className = "btn btn-primary btn-sm";
        btnNewEvent.innerHTML = "➕ Nuevo Evento";
        btnNewEvent.onclick = modalNewEvent;
        container.appendChild(btnNewEvent);
    } else if (viewName === "contacts") {
        const btnNewContact = document.createElement("button");
        btnNewContact.className = "btn btn-primary btn-sm";
        btnNewContact.innerHTML = "➕ Nuevo Contacto";
        btnNewContact.onclick = modalNewContact;
        container.appendChild(btnNewContact);
    }
}

// ==========================================
// 3. ARCHIVOS Y CARPETAS
// ==========================================

async function loadFiles() {
    renderBreadcrumbs();
    const tbody = document.getElementById("files-list");
    tbody.innerHTML = `<tr><td colspan="6" class="text-center">Cargando elementos...</td></tr>`;

    try {
        const folderFilter = state.currentFolder ? `parent = '${state.currentFolder}'` : "parent = ''";
        const fileFilter = state.currentFolder ? `folder = '${state.currentFolder}' && trashed = false` : "folder = '' && trashed = false";

        const [foldersRes, filesRes] = await Promise.all([
            fetch(`${CONFIG.API_URL}/api/collections/folders/records?filter=(${folderFilter})&sort=name`, { headers: getHeaders() }),
            fetch(`${CONFIG.API_URL}/api/collections/files/records?filter=(${fileFilter})&sort=-created`, { headers: getHeaders() })
        ]);

        const foldersData = await foldersRes.json();
        const filesData = await filesRes.json();

        tbody.innerHTML = "";

        if (foldersData.items.length === 0 && filesData.items.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" class="text-center">Carpeta vacía</td></tr>`;
            return;
        }

        foldersData.items.forEach(folder => {
            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td><strong>📁 <a href="#" class="folder-link" data-id="${folder.id}" data-name="${escapeHtml(folder.name)}">${escapeHtml(folder.name)}</a></strong></td>
                <td>—</td>
                <td>Carpeta</td>
                <td>${folder.is_group ? "Grupo" : "Personal"}</td>
                <td>${formatDate(folder.created)}</td>
                <td class="text-right">
                    <button class="btn btn-secondary btn-sm" onclick="deleteFolder('${folder.id}')">🗑️</button>
                </td>
            `;
            tbody.appendChild(tr);
        });

        tbody.querySelectorAll(".folder-link").forEach(a => {
            a.addEventListener("click", (e) => {
                e.preventDefault();
                openFolder(a.dataset.id, a.dataset.name);
            });
        });

        filesData.items.forEach(file => {
            const tr = document.createElement("tr");
            const fileUrl = `${CONFIG.API_URL}/api/files/files/${file.id}/${file.file}?token=${state.token}`;
            tr.innerHTML = `
                <td>📄 ${escapeHtml(file.name)}</td>
                <td>${formatBytes(file.size)}</td>
                <td>Fichero</td>
                <td>${file.is_group ? "Grupo" : "Personal"}</td>
                <td>${formatDate(file.created)}</td>
                <td class="text-right">
                    <a href="${fileUrl}" target="_blank" download="${escapeHtml(file.name)}" class="btn btn-secondary btn-sm">⬇️</a>
                    <button class="btn btn-secondary btn-sm" onclick="trashFile('${file.id}')">🗑️</button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="6" class="text-center alert-error">Error al cargar: ${err.message}</td></tr>`;
    }
}

function openFolder(folderId, folderName) {
    state.currentFolder = folderId;
    state.folderPath.push({ id: folderId, name: folderName });
    loadFiles();
}

function renderBreadcrumbs() {
    const container = document.getElementById("file-breadcrumbs");
    container.innerHTML = `<span class="crumb-root">Inicio</span>`;
    container.querySelector(".crumb-root").onclick = () => {
        state.currentFolder = "";
        state.folderPath = [];
        loadFiles();
    };

    state.folderPath.forEach((item, index) => {
        const sep = document.createElement("span");
        sep.textContent = " / ";
        const crumb = document.createElement("span");
        crumb.className = "crumb-item";
        crumb.textContent = item.name;
        crumb.onclick = () => {
            state.currentFolder = item.id;
            state.folderPath = state.folderPath.slice(0, index + 1);
            loadFiles();
        };
        container.appendChild(sep);
        container.appendChild(crumb);
    });
}

async function trashFile(fileId) {
    if (!confirm("¿Mover este archivo a la papelera?")) return;
    await fetch(`${CONFIG.API_URL}/api/collections/files/records/${fileId}`, {
        method: "PATCH",
        headers: getHeaders(),
        body: JSON.stringify({ trashed: true, trashed_at: new Date().toISOString() })
    });
    loadFiles();
    loadQuota();
}

async function deleteFolder(folderId) {
    if (!confirm("¿Eliminar esta carpeta?")) return;
    await fetch(`${CONFIG.API_URL}/api/collections/folders/records/${folderId}`, {
        method: "DELETE",
        headers: getHeaders()
    });
    loadFiles();
}

// ==========================================
// 4. SUBIDA POR BLOQUES (CHUNKING)
// ==========================================

function triggerFileSelect() {
    const input = document.createElement("input");
    input.type = "file";
    input.onchange = (e) => {
        const file = e.target.files[0];
        if (file) uploadFileInChunks(file);
    };
    input.click();
}

async function uploadFileInChunks(file) {
    const modal = document.getElementById("upload-modal");
    const nameEl = document.getElementById("upload-filename");
    const fillEl = document.getElementById("upload-progress-fill");
    const bytesEl = document.getElementById("upload-bytes-stat");
    const pctEl = document.getElementById("upload-percentage-stat");
    const subtextEl = document.getElementById("upload-chunk-stat");

    modal.style.display = "flex";
    nameEl.textContent = `Subiendo: ${file.name}`;
    fillEl.style.width = "0%";
    bytesEl.textContent = `0 MB / ${formatMB(file.size)} MB`;
    pctEl.textContent = "0.0%";
    subtextEl.textContent = "Iniciando fragmentación...";

    const uploadId = "upl_" + Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
    const totalChunks = Math.ceil(file.size / CONFIG.CHUNK_SIZE);
    let bytesUploaded = 0;

    for (let i = 0; i < totalChunks; i++) {
        const start = i * CONFIG.CHUNK_SIZE;
        const end = Math.min(start + CONFIG.CHUNK_SIZE, file.size);
        const chunkBlob = file.slice(start, end);

        const formData = new FormData();
        formData.append("uploadId", uploadId);
        formData.append("chunkIndex", i.toString());
        formData.append("totalChunks", totalChunks.toString());
        formData.append("fileName", file.name);
        formData.append("folderId", state.currentFolder);
        formData.append("chunk", chunkBlob);

        subtextEl.textContent = `Enviando fragmento ${i + 1} de ${totalChunks}...`;

        try {
            const res = await fetch(`${CONFIG.API_URL}/api/custom/upload-chunk`, {
                method: "POST",
                headers: { "Authorization": state.token },
                body: formData
            });

            if (!res.ok) {
                const errData = await res.json();
                throw new Error(errData.error || "Error en el fragmento.");
            }

            bytesUploaded += chunkBlob.size;
            const percentage = ((bytesUploaded / file.size) * 100).toFixed(1);

            fillEl.style.width = `${percentage}%`;
            bytesEl.textContent = `${formatMB(bytesUploaded)} MB / ${formatMB(file.size)} MB`;
            pctEl.textContent = `${percentage}%`;
        } catch (err) {
            alert(`Error en la subida: ${err.message}`);
            modal.style.display = "none";
            return;
        }
    }

    subtextEl.textContent = "Ensamblando y verificando integridad...";
    setTimeout(() => {
        modal.style.display = "none";
        loadFiles();
        loadQuota();
    }, 600);
}

// ==========================================
// 5. CALENDARIO
// ==========================================

async function loadCalendar() {
    const container = document.getElementById("calendar-events-list");
    container.innerHTML = "<p>Cargando eventos...</p>";

    try {
        const res = await fetch(`${CONFIG.API_URL}/api/collections/calendar_events/records?sort=start_time`, {
            headers: getHeaders()
        });
        const data = await res.json();
        state.calendarEventsCache = data.items;
        renderCalendar();
    } catch (err) {
        container.innerHTML = `<p class="alert-error">Error al cargar la agenda: ${err.message}</p>`;
    }
}

function renderCalendar() {
    const container = document.getElementById("calendar-events-list");
    container.innerHTML = "";

    if (state.calendarEventsCache.length === 0) {
        container.innerHTML = "<p>No hay eventos registrados.</p>";
        return;
    }

    state.calendarEventsCache.forEach(evt => {
        const card = document.createElement("div");
        card.className = "card-item";
        card.innerHTML = `
            <div class="card-title">${escapeHtml(evt.title)}</div>
            <div class="card-date">📅 ${formatDateTime(evt.start_time)} - ${formatDateTime(evt.end_time)}</div>
            ${evt.location ? `<div style="font-size:0.8125rem; margin-top:0.25rem;">📍 ${escapeHtml(evt.location)}</div>` : ""}
            ${evt.description ? `<p style="font-size:0.8125rem; color:var(--text-muted); margin-top:0.5rem;">${escapeHtml(evt.description)}</p>` : ""}
            <div style="margin-top:0.75rem; text-align:right;">
                <button class="btn btn-secondary btn-sm" onclick="deleteCalendarEvent('${evt.id}')">Eliminar</button>
            </div>
        `;
        container.appendChild(card);
    });
}

async function deleteCalendarEvent(id) {
    if (!confirm("¿Eliminar este evento?")) return;
    await fetch(`${CONFIG.API_URL}/api/collections/calendar_events/records/${id}`, {
        method: "DELETE",
        headers: getHeaders()
    });
    loadCalendar();
}

// ==========================================
// 6. CONTACTOS
// ==========================================

async function loadContacts() {
    const tbody = document.getElementById("contacts-list");
    tbody.innerHTML = `<tr><td colspan="6" class="text-center">Cargando libreta...</td></tr>`;

    try {
        const res = await fetch(`${CONFIG.API_URL}/api/collections/contacts/records?sort=name`, {
            headers: getHeaders()
        });
        const data = await res.json();
        state.contactsCache = data.items;
        renderContacts();
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="6" class="text-center alert-error">Error: ${err.message}</td></tr>`;
    }
}

function renderContacts(query = "") {
    const tbody = document.getElementById("contacts-list");
    tbody.innerHTML = "";

    const filtered = state.contactsCache.filter(c => {
        const match = `${c.name} ${c.email || ""} ${c.company || ""}`.toLowerCase();
        return match.includes(query);
    });

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="text-center">No se encontraron contactos</td></tr>`;
        return;
    }

    filtered.forEach(contact => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td><strong>${escapeHtml(contact.name)}</strong></td>
            <td>${contact.email ? `<a href="mailto:${escapeHtml(contact.email)}">${escapeHtml(contact.email)}</a>` : "—"}</td>
            <td>${contact.phone ? escapeHtml(contact.phone) : "—"}</td>
            <td>${contact.company ? escapeHtml(contact.company) : "—"}</td>
            <td>${contact.is_group ? "Grupo" : "Personal"}</td>
            <td class="text-right">
                <button class="btn btn-secondary btn-sm" onclick="deleteContact('${contact.id}')">🗑️</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

async function deleteContact(id) {
    if (!confirm("¿Eliminar este contacto?")) return;
    await fetch(`${CONFIG.API_URL}/api/collections/contacts/records/${id}`, {
        method: "DELETE",
        headers: getHeaders()
    });
    loadContacts();
}

// ==========================================
// 7. ADMINISTRACIÓN (USUARIOS, SMTP, THEMING GLOBAL)
// ==========================================

async function loadAdminData() {
    const tbody = document.getElementById("admin-users-list");
    tbody.innerHTML = `<tr><td colspan="5" class="text-center">Cargando usuarios...</td></tr>`;

    try {
        const res = await fetch(`${CONFIG.API_URL}/api/collections/users/records?sort=-created`, {
            headers: getHeaders()
        });
        const data = await res.json();
        tbody.innerHTML = "";

        data.items.forEach(u => {
            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td>${escapeHtml(u.email || u.username)}</td>
                <td><span class="user-role-badge">${u.role || "user"}</span></td>
                <td>${u.storage_quota ? formatBytes(u.storage_quota) : "Ilimitada"}</td>
                <td>${u.force_password_change ? "⚠️ Pendiente" : "✅ Al día"}</td>
                <td class="text-right">
                    <button class="btn btn-secondary btn-sm" onclick="editUserQuota('${u.id}', ${u.storage_quota || 0})">Cuota</button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="5" class="text-center alert-error">Error: ${err.message}</td></tr>`;
    }

    loadSmtpSettings();
}

async function editUserQuota(userId, currentQuota) {
    const currentGB = currentQuota > 0 ? (currentQuota / (1024 * 1024 * 1024)).toFixed(0) : 0;
    const newGB = prompt("Introduce el límite de cuota en Gigabytes (0 para ilimitado):", currentGB);
    if (newGB === null) return;

    const bytes = parseInt(newGB, 10) * 1024 * 1024 * 1024;
    await fetch(`${CONFIG.API_URL}/api/collections/users/records/${userId}`, {
        method: "PATCH",
        headers: getHeaders(),
        body: JSON.stringify({ storage_quota: bytes })
    });
    loadAdminData();
}

async function loadSmtpSettings() {
    try {
        const res = await fetch(`${CONFIG.API_URL}/api/custom/mail-settings`, {
            headers: getHeaders()
        });
        if (!res.ok) return;
        const data = await res.json();

        document.getElementById("smtp-enabled").checked = data.enabled;
        document.getElementById("smtp-host").value = data.host || "";
        document.getElementById("smtp-port").value = data.port || 587;
        document.getElementById("smtp-user").value = data.username || "";
        document.getElementById("smtp-sender-address").value = data.sender_address || "";
        document.getElementById("smtp-sender-name").value = data.sender_name || "";
        document.getElementById("smtp-tls").checked = data.tls;
    } catch (_) {}
}

async function handleSaveSmtp(e) {
    e.preventDefault();
    const payload = {
        enabled: document.getElementById("smtp-enabled").checked,
        host: document.getElementById("smtp-host").value.trim(),
        port: parseInt(document.getElementById("smtp-port").value, 10),
        username: document.getElementById("smtp-user").value.trim(),
        password: document.getElementById("smtp-pass").value,
        sender_address: document.getElementById("smtp-sender-address").value.trim(),
        sender_name: document.getElementById("smtp-sender-name").value.trim(),
        tls: document.getElementById("smtp-tls").checked
    };

    const res = await fetch(`${CONFIG.API_URL}/api/custom/mail-settings`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (res.ok) {
        alert("Configuración de correo guardada con éxito.");
        document.getElementById("smtp-pass").value = "";
    } else {
        alert("Error al guardar: " + data.error);
    }
}

async function handleTestSmtp() {
    const btn = document.getElementById("btn-test-smtp");
    btn.textContent = "Probando...";
    btn.disabled = true;

    try {
        const res = await fetch(`${CONFIG.API_URL}/api/custom/mail-test`, {
            method: "POST",
            headers: getHeaders()
        });
        const data = await res.json();
        if (res.ok) {
            alert(data.message);
        } else {
            alert("Fallo en la prueba: " + data.error);
        }
    } catch (err) {
        alert("Error de conexión: " + err.message);
    } finally {
        btn.textContent = "Probar Envío";
        btn.disabled = false;
    }
}

// ==========================================
// 8. THEMING GLOBAL (PERSISTENTE EN SERVIDOR)
// ==========================================

async function fetchGlobalTheme() {
    try {
        // Lectura pública desde la colección app_settings
        const res = await fetch(`${CONFIG.API_URL}/api/collections/app_settings/records?perPage=1`);
        if (res.ok) {
            const data = await res.json();
            if (data.items && data.items.length > 0) {
                const s = data.items[0];
                state.settingsRecordId = s.id;
                renderTheme(s.app_name, s.app_icon, s.accent_color);
                return;
            }
        }
    } catch (_) {}
    renderTheme("Nube Monolito", "📁", "#2563eb");
}

function renderTheme(name, icon, color) {
    document.getElementById("page-title").textContent = name;
    document.getElementById("login-app-title").textContent = name;
    document.getElementById("nav-app-title").textContent = name;
    document.getElementById("login-app-icon").textContent = icon;
    document.getElementById("nav-app-icon").textContent = icon;

    document.documentElement.style.setProperty("--accent", color);
    document.documentElement.style.setProperty("--accent-hover", adjustBrightness(color, -20));

    const inputName = document.getElementById("setting-app-name");
    const inputIcon = document.getElementById("setting-app-icon");
    const inputColor = document.getElementById("setting-accent-color");
    const labelColor = document.getElementById("color-hex-label");

    if (inputName) inputName.value = name;
    if (inputIcon) inputIcon.value = icon;
    if (inputColor) inputColor.value = color;
    if (labelColor) labelColor.textContent = color;
}

async function handleSaveCustomization(e) {
    e.preventDefault();
    const name = document.getElementById("setting-app-name").value.trim();
    const icon = document.getElementById("setting-app-icon").value;
    const color = document.getElementById("setting-accent-color").value;

    if (!state.settingsRecordId) {
        try {
            const check = await fetch(`${CONFIG.API_URL}/api/collections/app_settings/records?perPage=1`);
            const d = await check.json();
            if (d.items && d.items[0]) state.settingsRecordId = d.items[0].id;
        } catch (_) {}
    }

    try {
        const res = await fetch(`${CONFIG.API_URL}/api/collections/app_settings/records/${state.settingsRecordId}`, {
            method: "PATCH",
            headers: getHeaders(),
            body: JSON.stringify({
                app_name: name,
                app_icon: icon,
                accent_color: color
            })
        });

        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.message || "Error al guardar el tema");
        }

        renderTheme(name, icon, color);
        alert("Personalización corporativa guardada con éxito en el servidor.");
    } catch (err) {
        alert("Fallo al guardar: " + err.message);
    }
}

// ==========================================
// 9. MODALES Y FORMULARIOS
// ==========================================

function openModal(title, contentHtml, canClose = true) {
    document.getElementById("modal-title").textContent = title;
    document.getElementById("modal-body").innerHTML = contentHtml;
    document.getElementById("modal-close").style.display = canClose ? "block" : "none";
    document.getElementById("generic-modal").style.display = "flex";
}

function closeModal() {
    document.getElementById("generic-modal").style.display = "none";
}

function modalForcePasswordChange() {
    openModal("Cambio Obligatorio de Contraseña", `
        <p style="font-size:0.875rem; color:var(--text-muted); margin-bottom:1rem;">
            Tu cuenta tiene una clave temporal o requiere actualización por seguridad. Introduce una nueva contraseña (mínimo 8 caracteres).
        </p>
        <form id="form-force-pass">
            <div class="form-group">
                <label>Nueva Contraseña</label>
                <input type="password" id="new-password" minlength="8" required autofocus>
            </div>
            <div class="form-group">
                <label>Confirmar Nueva Contraseña</label>
                <input type="password" id="new-password-confirm" minlength="8" required>
            </div>
            <button type="submit" class="btn btn-primary btn-block">Establecer Nueva Contraseña</button>
            <div id="pass-change-error" class="alert-error" style="display: none; margin-top:0.75rem;"></div>
        </form>
    `, false);

    document.getElementById("form-force-pass").onsubmit = async (e) => {
        e.preventDefault();
        const p1 = document.getElementById("new-password").value;
        const p2 = document.getElementById("new-password-confirm").value;
        const errEl = document.getElementById("pass-change-error");

        if (p1 !== p2) {
            errEl.textContent = "Las contraseñas no coinciden.";
            errEl.style.display = "block";
            return;
        }

        try {
            const res = await fetch(`${CONFIG.API_URL}/api/collections/users/records/${state.user.id}`, {
                method: "PATCH",
                headers: getHeaders(),
                body: JSON.stringify({
                    password: p1,
                    passwordConfirm: p2,
                    force_password_change: false
                })
            });

            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.message || "Error al actualizar clave.");
            }

            state.user.force_password_change = false;
            setSession(state.token, state.user);
            closeModal();
            showDashboard();
            alert("Contraseña actualizada con éxito.");
        } catch (err) {
            errEl.textContent = err.message;
            errEl.style.display = "block";
        }
    };
}

function modalNewUser() {
    openModal("Crear Nuevo Usuario", `
        <form id="form-create-user">
            <div class="form-group">
                <label>Correo Electrónico</label>
                <input type="email" id="new-user-email" required>
            </div>
            <div class="form-group">
                <label>Contraseña Temporal (mínimo 8 caracteres)</label>
                <input type="password" id="new-user-pass" minlength="8" value="Temporal1234!" required>
            </div>
            <div class="form-group">
                <label>Rol en la Aplicación</label>
                <select id="new-user-role">
                    <option value="user">Usuario Estándar</option>
                    <option value="admin">Administrador</option>
                </select>
            </div>
            <div class="form-group">
                <label>Cuota de Almacenamiento (GB, 0 = ilimitado)</label>
                <input type="number" id="new-user-quota" value="10">
            </div>
            <p style="font-size:0.75rem; color:var(--text-muted); margin-bottom:1rem;">
                * El usuario estará obligado a cambiar esta contraseña en su primer inicio de sesión.
            </p>
            <button type="submit" class="btn btn-primary btn-block">Crear Cuenta</button>
        </form>
    `);

    document.getElementById("form-create-user").onsubmit = async (e) => {
        e.preventDefault();
        const email = document.getElementById("new-user-email").value.trim();
        const pass = document.getElementById("new-user-pass").value;
        const role = document.getElementById("new-user-role").value;
        const quotaGB = parseInt(document.getElementById("new-user-quota").value, 10) || 0;

        const res = await fetch(`${CONFIG.API_URL}/api/collections/users/records`, {
            method: "POST",
            headers: getHeaders(),
            body: JSON.stringify({
                email: email,
                password: pass,
                passwordConfirm: pass,
                role: role,
                storage_quota: quotaGB * 1024 * 1024 * 1024,
                force_password_change: true,
                emailVisibility: true
            })
        });

        if (res.ok) {
            closeModal();
            loadAdminData();
            alert(`Usuario ${email} creado correctamente con clave temporal.`);
        } else {
            const err = await res.json();
            alert("Error al crear usuario: " + JSON.stringify(err.data || err.message));
        }
    };
}

function modalNewFolder() {
    openModal("Nueva Carpeta", `
        <form id="form-new-folder">
            <div class="form-group">
                <label>Nombre de la carpeta</label>
                <input type="text" id="folder-name-input" required autofocus>
            </div>
            <div class="form-group">
                <label>
                    <input type="checkbox" id="folder-is-group"> Compartir con el grupo
                </label>
            </div>
            <button type="submit" class="btn btn-primary btn-block">Crear</button>
        </form>
    `);

    document.getElementById("form-new-folder").onsubmit = async (e) => {
        e.preventDefault();
        const name = document.getElementById("folder-name-input").value.trim();
        const isGroup = document.getElementById("folder-is-group").checked;

        await fetch(`${CONFIG.API_URL}/api/collections/folders/records`, {
            method: "POST",
            headers: getHeaders(),
            body: JSON.stringify({
                name: name,
                owner: state.user.id,
                parent: state.currentFolder || null,
                is_group: isGroup,
                group: isGroup ? state.user.user_group : null
            })
        });

        closeModal();
        loadFiles();
    };
}

function modalNewContact() {
    openModal("Nuevo Contacto", `
        <form id="form-new-contact">
            <div class="form-group">
                <label>Nombre Completo</label>
                <input type="text" id="contact-name" required>
            </div>
            <div class="form-group">
                <label>Correo Electrónico</label>
                <input type="email" id="contact-email">
            </div>
            <div class="form-group">
                <label>Teléfono</label>
                <input type="tel" id="contact-phone">
            </div>
            <div class="form-group">
                <label>Empresa / Organización</label>
                <input type="text" id="contact-company">
            </div>
            <div class="form-group">
                <label>
                    <input type="checkbox" id="contact-is-group"> Contacto compartido de grupo
                </label>
            </div>
            <button type="submit" class="btn btn-primary btn-block">Guardar Contacto</button>
        </form>
    `);

    document.getElementById("form-new-contact").onsubmit = async (e) => {
        e.preventDefault();
        const isGroup = document.getElementById("contact-is-group").checked;
        await fetch(`${CONFIG.API_URL}/api/collections/contacts/records`, {
            method: "POST",
            headers: getHeaders(),
            body: JSON.stringify({
                name: document.getElementById("contact-name").value.trim(),
                email: document.getElementById("contact-email").value.trim(),
                phone: document.getElementById("contact-phone").value.trim(),
                company: document.getElementById("contact-company").value.trim(),
                owner: state.user.id,
                is_group: isGroup,
                group: isGroup ? state.user.user_group : null
            })
        });
        closeModal();
        loadContacts();
    };
}

function modalNewEvent() {
    openModal("Nuevo Evento de Agenda", `
        <form id="form-new-event">
            <div class="form-group">
                <label>Título del Evento</label>
                <input type="text" id="event-title" required>
            </div>
            <div class="form-group">
                <label>Fecha y Hora de Inicio</label>
                <input type="datetime-local" id="event-start" required>
            </div>
            <div class="form-group">
                <label>Fecha y Hora de Fin</label>
                <input type="datetime-local" id="event-end" required>
            </div>
            <div class="form-group">
                <label>Ubicación</label>
                <input type="text" id="event-location" placeholder="Despacho 2, Sala de Juntas...">
            </div>
            <div class="form-group">
                <label>Descripción / Notas</label>
                <textarea id="event-desc" rows="2" class="form-group"></textarea>
            </div>
            <div class="form-group">
                <label>
                    <input type="checkbox" id="event-is-group"> Evento de Grupo
                </label>
            </div>
            <button type="submit" class="btn btn-primary btn-block">Añadir al Calendario</button>
        </form>
    `);

    document.getElementById("form-new-event").onsubmit = async (e) => {
        e.preventDefault();
        const isGroup = document.getElementById("event-is-group").checked;
        await fetch(`${CONFIG.API_URL}/api/collections/calendar_events/records`, {
            method: "POST",
            headers: getHeaders(),
            body: JSON.stringify({
                title: document.getElementById("event-title").value.trim(),
                start_time: new Date(document.getElementById("event-start").value).toISOString(),
                end_time: new Date(document.getElementById("event-end").value).toISOString(),
                location: document.getElementById("event-location").value.trim(),
                description: document.getElementById("event-desc").value.trim(),
                owner: state.user.id,
                is_group: isGroup,
                group: isGroup ? state.user.user_group : null
            })
        });
        closeModal();
        loadCalendar();
    };
}

// ==========================================
// 10. UTILIDADES Y FORMATO
// ==========================================

async function loadQuota() {
    try {
        const res = await fetch(`${CONFIG.API_URL}/api/collections/files/records?filter=(owner='${state.user.id}' && trashed=false)&fields=size`, {
            headers: getHeaders()
        });
        const data = await res.json();
        const totalUsed = data.items.reduce((acc, f) => acc + (f.size || 0), 0);

        const quota = state.user.storage_quota || 10737418240;
        document.getElementById("storage-quota-display").textContent = `${formatMB(totalUsed)} MB / ${formatMB(quota)} MB`;
    } catch (_) {}
}

function formatMB(bytes) {
    return (bytes / (1024 * 1024)).toFixed(1);
}

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function formatDate(isoStr) {
    if (!isoStr) return "—";
    return new Date(isoStr).toLocaleDateString();
}

function formatDateTime(isoStr) {
    if (!isoStr) return "—";
    const d = new Date(isoStr);
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function escapeHtml(str) {
    if (!str) return "";
    return str.replace(/[&<>"']/g, (m) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
    })[m]);
}

function adjustBrightness(hex, percent) {
    const num = parseInt(hex.replace("#", ""), 16);
    const amt = Math.round(2.55 * percent);
    const R = (num >> 16) + amt;
    const G = (num >> 8 & 0x00FF) + amt;
    const B = (num & 0x0000FF) + amt;
    return "#" + (
        0x1000000 +
        (R < 255 ? (R < 1 ? 0 : R) : 255) * 0x10000 +
        (G < 255 ? (G < 1 ? 0 : G) : 255) * 0x100 +
        (B < 255 ? (B < 1 ? 0 : B) : 255)
    ).toString(16).slice(1);
}
