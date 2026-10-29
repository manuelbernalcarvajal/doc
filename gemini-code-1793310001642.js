/**
 * Cliente SPA Monolito (Vanilla JS ES6+)
 * Comunicación directa con la API REST de PocketBase y el hook de fragmentación.
 */

const CONFIG = {
    CHUNK_SIZE: 20 * 1024 * 1024, // 20 MB por fragmento (compatible con proxies y redes móviles)
    API_URL: window.location.origin
};

const state = {
    token: localStorage.getItem("pb_token") || "",
    user: JSON.parse(localStorage.getItem("pb_user") || "null"),
    currentView: "files",
    currentFolder: "",
    folderPath: [], // Historial de navegación para breadcrumbs [{id, name}]
    contactsCache: [],
    calendarEventsCache: []
};

// ==========================================
// 1. INICIALIZACIÓN Y GESTIÓN DE SESIÓN
// ==========================================

document.addEventListener("DOMContentLoaded", () => {
    applyCustomization();
    initEventListeners();

    if (state.token && state.user) {
        verifySession();
    } else {
        showAuth();
    }
});

function initEventListeners() {
    // Formulario de login
    document.getElementById("login-form").addEventListener("submit", handleLogin);

    // Navegación lateral
    document.querySelectorAll(".nav-item").forEach(btn => {
        btn.addEventListener("click", () => switchView(btn.dataset.view));
    });

    // Cierre de sesión
    document.getElementById("btn-logout").addEventListener("click", handleLogout);

    // Búsqueda de contactos en tiempo real
    document.getElementById("contact-search").addEventListener("input", (e) => {
        renderContacts(e.target.value.toLowerCase());
    });

    // Personalización en administración
    document.getElementById("admin-customization-form").addEventListener("submit", handleSaveCustomization);
    document.getElementById("setting-accent-color").addEventListener("input", (e) => {
        document.getElementById("color-hex-label").textContent = e.target.value;
    });

    // Cierre de modal genérico
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
        showDashboard();
    } catch (_) {
        handleLogout();
    }
}

async function handleLogin(e) {
    e.preventDefault();
    const email = document.getElementById("login-email").value.trim();
    const password = document.getElementById("login-password").value;
    const totpCode = document.getElementById("login-totp").value.trim();
    const errBox = document.getElementById("login-error");
    const totpGroup = document.getElementById("totp-group");

    errBox.style.display = "none";

    const payload = { identity: email, password: password };
    if (totpCode) payload.mfaCode = totpCode;

    try {
        const res = await fetch(`${CONFIG.API_URL}/api/collections/users/auth-with-password`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        const data = await res.json();

        // Si la cuenta tiene MFA activado y falta el código
        if (data.mfaId && !totpCode) {
            totpGroup.style.display = "block";
            errBox.textContent = "Introduce el código de 6 dígitos de tu aplicación autenticadora.";
            errBox.style.display = "block";
            return;
        }

        if (!res.ok) throw new Error(data.message || "Credenciales incorrectas.");

        setSession(data.token, data.record);
        showDashboard();
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

    // Datos del usuario en barra lateral
    const name = state.user.name || state.user.email.split("@")[0];
    document.getElementById("user-display-name").textContent = name;
    document.getElementById("user-initial").textContent = name.charAt(0).toUpperCase();
    document.getElementById("user-display-role").textContent = state.user.role || "user";

    // Mostrar menú de administración si corresponde
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

        // Listar carpetas
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

        // Listar archivos
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
// 4. SUBIDA POR BLOQUES (CHUNKING ROBUSTO)
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
    subtextEl.textContent = "Calculando bloques...";

    const uploadId = "upl_" + Math.random().toString(36).substring(2, 12) + Date.now().toString(36);
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
// 7. ADMINISTRACIÓN Y PERSONALIZACIÓN
// ==========================================

async function loadAdminData() {
    const tbody = document.getElementById("admin-users-list");
    tbody.innerHTML = `<tr><td colspan="4" class="text-center">Cargando usuarios...</td></tr>`;

    try {
        const res = await fetch(`${CONFIG.API_URL}/api/collections/users/records?sort=-created`, {
            headers: getHeaders()
        });
        const data = await res.json();
        tbody.innerHTML = "";

        data.items.forEach(u => {
            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td>${escapeHtml(u.email)}</td>
                <td><span class="user-role-badge">${u.role || "user"}</span></td>
                <td>${u.storage_quota ? formatBytes(u.storage_quota) : "Ilimitada"}</td>
                <td class="text-right">
                    <button class="btn btn-secondary btn-sm" onclick="editUserQuota('${u.id}', ${u.storage_quota || 0})">Cuota</button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="4" class="text-center alert-error">Error: ${err.message}</td></tr>`;
    }
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

function handleSaveCustomization(e) {
    e.preventDefault();
    const name = document.getElementById("setting-app-name").value.trim();
    const icon = document.getElementById("setting-app-icon").value;
    const color = document.getElementById("setting-accent-color").value;

    localStorage.setItem("app_name", name);
    localStorage.setItem("app_icon", icon);
    localStorage.setItem("app_color", color);

    applyCustomization();
    alert("Personalización guardada con éxito.");
}

function applyCustomization() {
    const name = localStorage.getItem("app_name") || "Nube Monolito";
    const icon = localStorage.getItem("app_icon") || "📁";
    const color = localStorage.getItem("app_color") || "#2563eb";

    document.getElementById("page-title").textContent = name;
    document.getElementById("login-app-title").textContent = name;
    document.getElementById("nav-app-title").textContent = name;
    document.getElementById("login-app-icon").textContent = icon;
    document.getElementById("nav-app-icon").textContent = icon;

    document.documentElement.style.setProperty("--accent", color);

    // Ajuste de brillo para el hover
    document.documentElement.style.setProperty("--accent-hover", adjustBrightness(color, -20));

    // Reflejar en inputs del formulario de administración
    const inputName = document.getElementById("setting-app-name");
    const inputIcon = document.getElementById("setting-app-icon");
    const inputColor = document.getElementById("setting-accent-color");
    const labelColor = document.getElementById("color-hex-label");

    if (inputName) inputName.value = name;
    if (inputIcon) inputIcon.value = icon;
    if (inputColor) inputColor.value = color;
    if (labelColor) labelColor.textContent = color;
}

// ==========================================
// 8. MODALES Y FORMULARIOS RÁPIDOS
// ==========================================

function openModal(title, contentHtml) {
    document.getElementById("modal-title").textContent = title;
    document.getElementById("modal-body").innerHTML = contentHtml;
    document.getElementById("generic-modal").style.display = "flex";
}

function closeModal() {
    document.getElementById("generic-modal").style.display = "none";
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
                <label>Nombre</label>
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
                <label>Empresa</label>
                <input type="text" id="contact-company">
            </div>
            <div class="form-group">
                <label>
                    <input type="checkbox" id="contact-is-group"> Visible para todo el grupo
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
                <label>Título</label>
                <input type="text" id="event-title" required>
            </div>
            <div class="form-group">
                <label>Inicio</label>
                <input type="datetime-local" id="event-start" required>
            </div>
            <div class="form-group">
                <label>Fin</label>
                <input type="datetime-local" id="event-end" required>
            </div>
            <div class="form-group">
                <label>Ubicación</label>
                <input type="text" id="event-location">
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
// 9. UTILIDADES Y FORMATO
// ==========================================

async function loadQuota() {
    try {
        const res = await fetch(`${CONFIG.API_URL}/api/collections/files/records?filter=(owner='${state.user.id}' && trashed=false)&fields=size`, {
            headers: getHeaders()
        });
        const data = await res.json();
        const totalUsed = data.items.reduce((acc, f) => acc + (f.size || 0), 0);

        const quota = state.user.storage_quota || 10737418240; // 10 GB por defecto
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