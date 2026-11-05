/**
 * Cliente SPA Monolito (Vanilla JS ES6+)
 * Theming centralizado en BD, subida fragmentada, recordatorios SMTP,
 * contactos y soporte WOPI para edición ofimática en línea.
 */

const CONFIG = {
    CHUNK_SIZE: 20 * 1024 * 1024,
    API_URL: window.location.origin
};

const OFFICE_EXTENSIONS = [
    ".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt",
    ".odt", ".ods", ".odp", ".rtf", ".txt", ".csv"
];

let pendingMfaId = "";

const state = {
    token: localStorage.getItem("pb_token") || "",
    user: JSON.parse(localStorage.getItem("pb_user") || "null"),
    currentView: "files",
    currentFolder: "",
    folderPath: [],
    contactsCache: [],
    calendarEventsCache: [],
    calendarView: "list",
    calendarMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
    settingsRecordId: null,
    wopiEnabled: false,
    uploadQueue: [],
    uploadInProgress: false,
    preferences: { folder_sort: "name", folder_direction: "asc", file_sort: "updated", file_direction: "desc", folders_first: true },
    pdf: { fileId: "", loadingTask: null, document: null, page: 1, scale: 1.15, annotations: [], highlightMode: false, rendering: false, renderQueued: false, openId: 0 }
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

    document.getElementById("calendar-list-view").addEventListener("click", () => {
        state.calendarView = "list";
        renderCalendar();
    });
    document.getElementById("calendar-month-view").addEventListener("click", () => {
        state.calendarView = "month";
        renderCalendar();
    });
    document.getElementById("calendar-previous-month").addEventListener("click", () => {
        state.calendarMonth = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth() - 1, 1);
        renderCalendar();
    });
    document.getElementById("calendar-next-month").addEventListener("click", () => {
        state.calendarMonth = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth() + 1, 1);
        renderCalendar();
    });

    // Administración
    document.getElementById("admin-customization-form").addEventListener("submit", handleSaveCustomization);
    document.getElementById("setting-accent-color").addEventListener("input", (e) => {
        document.getElementById("color-hex-label").textContent = e.target.value;
    });

    const wopiForm = document.getElementById("admin-wopi-form");
    if (wopiForm) {
        wopiForm.addEventListener("submit", handleSaveWopi);
    }

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
    document.getElementById("btn-close-wopi").addEventListener("click", closeWopiEditor);
    document.getElementById("trash-refresh").addEventListener("click", loadTrash);
    document.getElementById("files-sort-field").addEventListener("change", saveSortPreferences);
    document.getElementById("files-sort-direction").addEventListener("click", toggleSortDirection);
    document.getElementById("folders-first").addEventListener("change", saveSortPreferences);
    document.getElementById("pdf-close").addEventListener("click", closePdfViewer);
    document.getElementById("pdf-previous").addEventListener("click", () => changePdfPage(-1));
    document.getElementById("pdf-next").addEventListener("click", () => changePdfPage(1));
    document.getElementById("pdf-zoom-out").addEventListener("click", () => changePdfZoom(-0.15));
    document.getElementById("pdf-zoom-in").addEventListener("click", () => changePdfZoom(0.15));
    document.getElementById("pdf-highlight-toggle").addEventListener("click", togglePdfHighlightMode);
    document.getElementById("pdf-save-comment").addEventListener("click", savePdfComment);
    document.getElementById("pdf-annotation-layer").addEventListener("pointerdown", beginPdfHighlight);
    document.getElementById("pdf-annotation-layer").addEventListener("pointerup", finishPdfHighlight);

    const fileDropzone = document.getElementById("file-dropzone");
    const filePicker = document.getElementById("file-picker");
    if (fileDropzone && filePicker) {
        fileDropzone.addEventListener("click", () => filePicker.click());
        fileDropzone.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                filePicker.click();
            }
        });
        filePicker.addEventListener("change", () => {
            queueFiles(filePicker.files);
            filePicker.value = "";
        });
        ["dragenter", "dragover"].forEach(type => fileDropzone.addEventListener(type, (event) => {
            event.preventDefault();
            fileDropzone.classList.add("is-dragging");
        }));
        ["dragleave", "drop"].forEach(type => fileDropzone.addEventListener(type, (event) => {
            event.preventDefault();
            fileDropzone.classList.remove("is-dragging");
        }));
        fileDropzone.addEventListener("drop", (event) => queueFiles(event.dataTransfer.files));
    }
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
    if (pendingMfaId) payload.mfaId = pendingMfaId;

    try {
        const res = await fetch(`${CONFIG.API_URL}/api/collections/users/auth-with-password`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        const data = await res.json();

        if (data.mfaId && !totpCode) {
            pendingMfaId = data.mfaId;
            totpGroup.style.display = "block";
            errBox.textContent = "Introduce el código de 6 dígitos de tu aplicación TOTP.";
            errBox.style.display = "block";
            return;
        }

        if (!res.ok) throw new Error(data.message || "Credenciales incorrectas.");

        setSession(data.token, data.record);
        pendingMfaId = "";

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

async function showDashboard() {
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

    await loadPreferences();
    switchView("files");
    loadQuota();
}

function getHeaders(isJson = true) {
    const headers = { "Authorization": state.token };
    if (isJson) headers["Content-Type"] = "application/json";
    return headers;
}

async function loadPreferences() {
    try {
        const res = await fetch(`${CONFIG.API_URL}/api/collections/user_preferences/records?filter=${encodeURIComponent(`owner='${state.user.id}'`)}&perPage=1`, { headers: getHeaders() });
        const data = await res.json();
        if (data.items?.[0]) state.preferences = { ...state.preferences, ...data.items[0] };
    } catch (_) {}
    document.getElementById("files-sort-field").value = state.preferences.file_sort;
    document.getElementById("folders-first").checked = state.preferences.folders_first !== false;
    updateSortDirectionLabel();
}

async function saveSortPreferences() {
    const field = document.getElementById("files-sort-field").value;
    state.preferences.file_sort = field;
    state.preferences.folders_first = document.getElementById("folders-first").checked;
    const payload = {
        owner: state.user.id,
        folder_sort: state.preferences.folder_sort,
        folder_direction: state.preferences.folder_direction,
        file_sort: state.preferences.file_sort,
        file_direction: state.preferences.file_direction,
        folders_first: state.preferences.folders_first
    };
    try {
        const existing = await fetch(`${CONFIG.API_URL}/api/collections/user_preferences/records?filter=${encodeURIComponent(`owner='${state.user.id}'`)}&perPage=1`, { headers: getHeaders() });
        const existingData = await existing.json();
        const id = existingData.items?.[0]?.id;
        await fetch(`${CONFIG.API_URL}/api/collections/user_preferences/records${id ? `/${id}` : ""}`, {
            method: id ? "PATCH" : "POST", headers: getHeaders(), body: JSON.stringify(payload)
        });
        loadFiles();
    } catch (err) {
        alert(`No se pudieron guardar las preferencias: ${err.message}`);
    }
}

function toggleSortDirection() {
    state.preferences.file_direction = state.preferences.file_direction === "asc" ? "desc" : "asc";
    updateSortDirectionLabel();
    saveSortPreferences();
}

function updateSortDirectionLabel() {
    const label = document.getElementById("files-sort-direction");
    if (label) label.textContent = state.preferences.file_direction === "asc" ? "A → Z" : "Z → A";
}

async function recordActivity(resourceType, resourceId, action, details = "") {
    try {
        await fetch(`${CONFIG.API_URL}/api/custom/file-activity`, {
            method: "POST",
            headers: getHeaders(),
            body: JSON.stringify({ resourceType, resourceId, action, details })
        });
    } catch (_) {}
}

async function withResourceLock(resourceType, resourceId, operation) {
    const lockRes = await fetch(`${CONFIG.API_URL}/api/custom/locks/acquire`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({ resourceType, resourceId })
    });
    const lockData = await lockRes.json().catch(() => ({}));
    if (!lockRes.ok) {
        throw new Error(lockData.error || "El recurso está siendo editado por otro usuario.");
    }

    try {
        return await operation(lockData.token);
    } finally {
        await fetch(`${CONFIG.API_URL}/api/custom/locks/release`, {
            method: "POST",
            headers: getHeaders(),
            body: JSON.stringify({ resourceType, resourceId, token: lockData.token })
        });
    }
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
        trash: "Papelera",
        calendar: "Calendario",
        contacts: "Contactos",
        admin: "Administración"
    };
    document.getElementById("current-view-title").textContent = titles[viewName] || "Nube";

    renderTopbarActions(viewName);

    if (viewName === "files") loadFiles();
    if (viewName === "trash") loadTrash();
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
// 3. ARCHIVOS Y WOPI
// ==========================================

async function loadFiles() {
    renderBreadcrumbs();
    const tbody = document.getElementById("files-list");
    tbody.innerHTML = `<tr><td colspan="6" class="text-center">Cargando elementos...</td></tr>`;

    try {
        const folderFilter = state.currentFolder ? `parent = '${state.currentFolder}' && (trashed = false || trashed = null)` : "parent = '' && (trashed = false || trashed = null)";
        const fileFilter = state.currentFolder ? `folder = '${state.currentFolder}' && (trashed = false || trashed = null)` : "folder = '' && (trashed = false || trashed = null)";
        const folderSort = `${state.preferences.folder_direction === "desc" ? "-" : ""}${state.preferences.folder_sort}`;
        const fileSort = `${state.preferences.file_direction === "desc" ? "-" : ""}${state.preferences.file_sort}`;

        const [foldersRes, filesRes] = await Promise.all([
            fetch(`${CONFIG.API_URL}/api/collections/folders/records?filter=${encodeURIComponent(`(${folderFilter})`)}&sort=${folderSort}`, { headers: getHeaders() }),
            fetch(`${CONFIG.API_URL}/api/collections/files/records?filter=${encodeURIComponent(`(${fileFilter})`)}&sort=${fileSort}`, { headers: getHeaders() })
        ]);

        const foldersData = await getCollectionData(foldersRes, "las carpetas");
        const filesData = await getCollectionData(filesRes, "los archivos");

        tbody.innerHTML = "";

        if (foldersData.items.length === 0 && filesData.items.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" class="text-center">Carpeta vacía</td></tr>`;
            return;
        }

        foldersData.items.forEach(folder => {
            const tr = document.createElement("tr");
            tr.className = "folder-row";
            tr.innerHTML = `
                <td><strong>📁 <a href="#" class="folder-link" data-id="${folder.id}" data-name="${escapeHtml(folder.name)}">${escapeHtml(folder.name)}</a></strong></td>
                <td>—</td>
                <td>Carpeta</td>
                <td>${folder.is_group ? "Grupo" : "Personal"}</td>
                <td>${formatDate(folder.created)}</td>
                <td class="text-right">
                    <button class="btn btn-secondary btn-sm folder-settings-btn" title="Ajustes de carpeta">⚙️</button>
                    <button class="btn btn-secondary btn-sm" onclick="deleteFolder('${folder.id}')">🗑️</button>
                </td>
            `;
            tbody.appendChild(tr);
            tr.querySelector(".folder-settings-btn").addEventListener("click", () => modalFolderSettings(folder));
        });

        tbody.querySelectorAll(".folder-link").forEach(a => {
            a.addEventListener("click", (e) => {
                e.preventDefault();
                openFolder(a.dataset.id, a.dataset.name);
            });
        });

        filesData.items.forEach(file => {
            const tr = document.createElement("tr");
            tr.className = "file-row";
            const fileNameLower = file.name.toLowerCase();
            const isOfficeDoc = OFFICE_EXTENSIONS.some(ext => fileNameLower.endsWith(ext));

            let editBtn = "";
            if (isOfficeDoc && state.wopiEnabled) {
                editBtn = `<button class="btn btn-primary btn-sm" style="margin-right:0.25rem;" onclick="launchWopiEditor('${file.id}')" title="Editar en línea con Collabora/OnlyOffice">📝 Editar</button>`;
            }

            tr.innerHTML = `
                <td>📄 ${escapeHtml(file.name)}</td>
                <td>${formatBytes(file.size)}</td>
                <td>Fichero</td>
                <td>${file.is_group ? "Grupo" : "Personal"}</td>
                <td>${formatDate(file.created)}</td>
                <td class="text-right">
                    ${editBtn}
                    ${fileNameLower.endsWith(".pdf") ? `<button type="button" class="open-pdf-btn btn btn-secondary btn-sm" data-file-id="${escapeHtml(file.id)}" data-storage-name="${escapeHtml(file.file)}" data-file-name="${escapeHtml(file.name)}" title="Abrir visor PDF">👁️</button>` : ""}
                    <button type="button" class="file-settings-btn btn btn-secondary btn-sm" title="Ajustes del archivo">⚙️</button>
                    <button type="button" class="download-file-btn btn btn-secondary btn-sm"
                        data-file-id="${escapeHtml(file.id)}"
                        data-storage-name="${escapeHtml(file.file)}"
                        data-file-name="${escapeHtml(file.name)}"
                        title="Descargar">⬇️</button>
                    <button class="btn btn-secondary btn-sm" onclick="trashFile('${file.id}')">🗑️</button>
                </td>
            `;
            tbody.appendChild(tr);

            tr.querySelector(".download-file-btn").addEventListener("click", (event) => {
                const button = event.currentTarget;
                downloadFile(button.dataset.fileId, button.dataset.storageName, button.dataset.fileName);
            });
            const pdfButton = tr.querySelector(".open-pdf-btn");
            if (pdfButton) {
                pdfButton.addEventListener("click", (event) => {
                    const button = event.currentTarget;
                    openPdfViewer(button.dataset.fileId, button.dataset.storageName, button.dataset.fileName);
                });
            }
            tr.querySelector(".file-settings-btn").addEventListener("click", () => modalFileSettings(file));
        });
        if (!state.preferences.folders_first) {
            tbody.querySelectorAll(".file-row").forEach(row => tbody.appendChild(row));
            tbody.querySelectorAll(".folder-row").forEach(row => tbody.appendChild(row));
        }
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="6" class="text-center alert-error">Error al cargar: ${err.message}</td></tr>`;
    }
}

async function openPdfViewer(fileId, storageName, fileName) {
    if (!window.pdfjsLib) return alert("El visor PDF no está disponible.");
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    const pdf = state.pdf;
    const operationId = ++pdf.openId;
    pdf.loadingTask?.destroy();
    pdf.loadingTask = null;
    pdf.document = null;
    pdf.fileId = fileId;
    pdf.page = 1;
    pdf.scale = 1.15;
    pdf.annotations = [];
    pdf.highlightMode = false;
    document.getElementById("pdf-title").textContent = fileName;
    document.getElementById("pdf-modal").style.display = "flex";
    document.getElementById("pdf-loading").style.display = "block";
    document.getElementById("pdf-canvas").style.display = "none";
    updatePdfToolbar();
    try {
        const fileUrl = `${CONFIG.API_URL}/api/files/files/${fileId}/${encodeURIComponent(storageName)}?token=${encodeURIComponent(state.token)}`;
        pdf.loadingTask = window.pdfjsLib.getDocument({ url: fileUrl });
        pdf.document = await pdf.loadingTask.promise;
        if (operationId !== pdf.openId) return;
        await loadPdfAnnotations(operationId);
        await renderPdfPage();
    } catch (err) {
        if (operationId !== pdf.openId) return;
        closePdfViewer();
        alert(`Error al abrir el PDF: ${err.message}`);
    }
}

function closePdfViewer() {
    state.pdf.openId += 1;
    state.pdf.loadingTask?.destroy();
    state.pdf.loadingTask = null;
    state.pdf.document = null;
    document.getElementById("pdf-modal").style.display = "none";
}

async function renderPdfPage() {
    const pdf = state.pdf;
    if (!pdf.document) return;
    if (pdf.rendering) {
        pdf.renderQueued = true;
        return;
    }
    pdf.rendering = true;
    try {
        const page = await pdf.document.getPage(pdf.page);
        const viewport = page.getViewport({ scale: pdf.scale });
        const canvas = document.getElementById("pdf-canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.display = "block";
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        document.getElementById("pdf-loading").style.display = "none";
        renderPdfAnnotations();
        updatePdfToolbar();
    } finally {
        pdf.rendering = false;
        if (pdf.renderQueued) {
            pdf.renderQueued = false;
            renderPdfPage();
        }
    }
}

function updatePdfToolbar() {
    const pdf = state.pdf;
    document.getElementById("pdf-page-label").textContent = pdf.document ? `Página ${pdf.page} / ${pdf.document.numPages}` : "Cargando...";
    document.getElementById("pdf-previous").disabled = !pdf.document || pdf.page <= 1;
    document.getElementById("pdf-next").disabled = !pdf.document || pdf.page >= pdf.document.numPages;
    document.getElementById("pdf-highlight-toggle").classList.toggle("btn-primary", pdf.highlightMode);
}

function changePdfPage(delta) {
    if (!state.pdf.document) return;
    state.pdf.page = Math.max(1, Math.min(state.pdf.document.numPages, state.pdf.page + delta));
    renderPdfPage();
}

function changePdfZoom(delta) {
    state.pdf.scale = Math.max(0.6, Math.min(2.5, state.pdf.scale + delta));
    renderPdfPage();
}

function togglePdfHighlightMode() {
    state.pdf.highlightMode = !state.pdf.highlightMode;
    document.getElementById("pdf-annotation-layer").classList.toggle("is-highlight-mode", state.pdf.highlightMode);
    updatePdfToolbar();
}

function beginPdfHighlight(event) {
    if (!state.pdf.highlightMode || event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    event.currentTarget.dataset.startX = String(event.clientX - rect.left);
    event.currentTarget.dataset.startY = String(event.clientY - rect.top);
    event.currentTarget.setPointerCapture(event.pointerId);
}

async function finishPdfHighlight(event) {
    const layer = event.currentTarget;
    if (!state.pdf.highlightMode || !layer.dataset.startX) return;
    const rect = layer.getBoundingClientRect();
    const startX = Number(layer.dataset.startX);
    const startY = Number(layer.dataset.startY);
    const endX = event.clientX - rect.left;
    const endY = event.clientY - rect.top;
    delete layer.dataset.startX;
    delete layer.dataset.startY;
    const x = Math.min(startX, endX) / rect.width;
    const y = Math.min(startY, endY) / rect.height;
    const width = Math.abs(endX - startX) / rect.width;
    const height = Math.abs(endY - startY) / rect.height;
    if (width > 0.01 && height > 0.01) await savePdfAnnotation({ type: "highlight", x, y, width, height });
}

async function savePdfComment() {
    const input = document.getElementById("pdf-comment-input");
    const text = input.value.trim();
    if (!text) return;
    await savePdfAnnotation({ type: "comment", text });
    input.value = "";
}

async function savePdfAnnotation(annotation) {
    try {
        const res = await fetch(`${CONFIG.API_URL}/api/collections/file_annotations/records`, {
            method: "POST",
            headers: getHeaders(),
            body: JSON.stringify({ file: state.pdf.fileId, owner: state.user.id, page: state.pdf.page, type: annotation.type, text: annotation.text || "", x: annotation.x || 0, y: annotation.y || 0, width: annotation.width || 0, height: annotation.height || 0, color: annotation.type === "comment" ? "#2563eb" : "#facc15" })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || data.error || "No se pudo guardar la anotación.");
        state.pdf.annotations.push(data);
        renderPdfAnnotations();
    } catch (err) {
        alert(err.message);
    }
}

async function loadPdfAnnotations(operationId = state.pdf.openId) {
    const filter = `file = '${state.pdf.fileId}'`;
    const res = await fetch(`${CONFIG.API_URL}/api/collections/file_annotations/records?filter=${encodeURIComponent(filter)}&sort=page,created`, { headers: getHeaders() });
    const data = await getCollectionData(res, "las anotaciones");
    if (operationId !== state.pdf.openId) return;
    state.pdf.annotations = data.items;
}

function renderPdfAnnotations() {
    const pdf = state.pdf;
    const layer = document.getElementById("pdf-annotation-layer");
    const list = document.getElementById("pdf-annotations-list");
    const canvas = document.getElementById("pdf-canvas");
    layer.style.width = `${canvas.width}px`;
    layer.style.height = `${canvas.height}px`;
    layer.innerHTML = "";
    list.innerHTML = "";
    pdf.annotations.filter(item => Number(item.page) === pdf.page).forEach(item => {
        if (item.type === "highlight") {
            const mark = document.createElement("div");
            mark.className = "pdf-highlight";
            mark.style.left = `${Number(item.x) * 100}%`;
            mark.style.top = `${Number(item.y) * 100}%`;
            mark.style.width = `${Number(item.width) * 100}%`;
            mark.style.height = `${Number(item.height) * 100}%`;
            layer.appendChild(mark);
        }
        const card = document.createElement("div");
        card.className = "pdf-annotation-card";
        card.innerHTML = `<strong>${item.type === "highlight" ? "Subrayado" : "Comentario"}</strong><span>${escapeHtml(item.text || `Página ${item.page}`)}</span>`;
        list.appendChild(card);
    });
}

async function downloadFile(fileId, storageName, fileName) {
    let writable;
    try {
        if ("showSaveFilePicker" in window) {
            const fileHandle = await window.showSaveFilePicker({ suggestedName: fileName });
            writable = await fileHandle.createWritable();
        }

        const res = await fetch(`${CONFIG.API_URL}/api/files/files/${fileId}/${encodeURIComponent(storageName)}`, {
            headers: getHeaders(false)
        });
        if (!res.ok) throw new Error("No se pudo descargar el fichero.");

        if (writable && res.body) {
            const reader = res.body.getReader();
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    await writable.write(value);
                }
                await writable.close();
            } catch (err) {
                await writable.abort();
                throw err;
            }
            return;
        }

        const blobUrl = URL.createObjectURL(await res.blob());
        const link = document.createElement("a");
        link.href = blobUrl;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
    } catch (err) {
        if (writable) await writable.abort().catch(() => {});
        alert(err.message);
    }
}

async function launchWopiEditor(fileId) {
    try {
        const res = await fetch(`${CONFIG.API_URL}/api/custom/wopi-token`, {
            method: "POST",
            headers: getHeaders(),
            body: JSON.stringify({ fileId: fileId })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "No se pudo iniciar el editor");

        document.getElementById("wopi-doc-title").textContent = `Editando: ${data.fileName}`;
        const iframe = document.getElementById("wopi-iframe");
        iframe.src = data.editorUrl;
        document.getElementById("wopi-modal").style.display = "flex";
    } catch (err) {
        alert("Error WOPI: " + err.message);
    }
}

function closeWopiEditor() {
    const iframe = document.getElementById("wopi-iframe");
    iframe.src = "about:blank";
    document.getElementById("wopi-modal").style.display = "none";
    loadFiles();
    loadQuota();
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
    try {
        await withResourceLock("files", fileId, async (lockToken) => {
            const headers = { ...getHeaders(), "X-Resource-Lock": lockToken };
            const res = await fetch(`${CONFIG.API_URL}/api/collections/files/records/${fileId}`, {
                method: "PATCH",
                headers,
                body: JSON.stringify({ trashed: true, trashed_at: new Date().toISOString() })
            });
            if (!res.ok) throw new Error("No se pudo mover el archivo a la papelera.");
            await recordActivity("file", fileId, "trash");
        });
        loadFiles();
        loadQuota();
    } catch (err) {
        alert(err.message);
    }
}

async function deleteFolder(folderId) {
    if (!confirm("¿Eliminar esta carpeta?")) return;
    try {
        await withResourceLock("folders", folderId, async (lockToken) => {
            const res = await fetch(`${CONFIG.API_URL}/api/custom/file-trash/folders/${folderId}/trash`, {
                method: "POST",
                headers: getHeaders(false)
            });
            if (!res.ok) throw new Error("No se pudo eliminar la carpeta.");
            await recordActivity("folder", folderId, "trash", "Contenido enviado a papelera");
        });
        loadFiles();
    } catch (err) {
        alert(err.message);
    }
}

async function loadTrash() {
        const tbody = document.getElementById("trash-list");
        tbody.innerHTML = `<tr><td colspan="5" class="text-center">Cargando papelera...</td></tr>`;
        try {
            const res = await fetch(`${CONFIG.API_URL}/api/custom/file-trash`, { headers: getHeaders(false) });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "No se pudo cargar la papelera.");
            tbody.innerHTML = "";
            if (!data.items.length) {
                tbody.innerHTML = `<tr><td colspan="5" class="text-center">La papelera está vacía.</td></tr>`;
                return;
            }
            data.items.forEach(item => {
                const tr = document.createElement("tr");
                tr.innerHTML = `
                    <td>${item.type === "folder" ? "📁" : "📄"} ${escapeHtml(item.name)}</td>
                    <td>${item.type === "folder" ? "Carpeta" : "Archivo"}</td>
                    <td>${item.type === "folder" ? "—" : formatBytes(item.size)}</td>
                    <td>${formatDate(item.trashedAt)}</td>
                    <td class="text-right">
                        <button class="btn btn-secondary btn-sm restore-trash-btn">↩️ Restaurar</button>
                        <button class="btn btn-danger btn-sm purge-trash-btn">Eliminar definitivamente</button>
                    </td>`;
                tr.querySelector(".restore-trash-btn").onclick = () => restoreTrashItem(item);
                tr.querySelector(".purge-trash-btn").onclick = () => purgeTrashItem(item);
                tbody.appendChild(tr);
            });
        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="5" class="text-center alert-error">${escapeHtml(err.message)}</td></tr>`;
        }
}

async function restoreTrashItem(item) {
        try {
            const res = await fetch(`${CONFIG.API_URL}/api/custom/file-trash/${item.type === "file" ? "files" : "folders"}/${item.id}/restore`, { method: "POST", headers: getHeaders(false) });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "No se pudo restaurar.");
            await recordActivity(item.type, item.id, "restore");
            loadTrash();
            if (state.currentView === "files") loadFiles();
        } catch (err) { alert(err.message); }
}

async function purgeTrashItem(item) {
        if (!confirm("Esta acción no se puede deshacer. ¿Continuar?")) return;
        try {
            const type = item.type === "file" ? "files" : "folders";
            const res = await fetch(`${CONFIG.API_URL}/api/custom/file-trash/${type}/${item.id}`, { method: "DELETE", headers: getHeaders(false) });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "No se pudo eliminar definitivamente.");
            loadTrash();
        } catch (err) { alert(err.message); }
}

// ==========================================
// 4. SUBIDA POR BLOQUES (CHUNKING)
// ==========================================

function triggerFileSelect() {
    document.getElementById("file-picker")?.click();
}

function queueFiles(fileList) {
    const files = Array.from(fileList || []).filter(file => file.size > 0);
    if (files.length === 0) return;

    state.uploadQueue.push(...files.map(file => ({ file, folderId: state.currentFolder })));
    if (!state.uploadInProgress) {
        processUploadQueue();
    }
}

async function processUploadQueue() {
    if (state.uploadInProgress) return;
    state.uploadInProgress = true;
    try {
        while (state.uploadQueue.length > 0) {
            const queued = state.uploadQueue.shift();
            await uploadFileInChunks(queued.file, queued.folderId);
        }
    } finally {
        state.uploadInProgress = false;
        document.getElementById("upload-modal").style.display = "none";
        loadFiles();
        loadQuota();
    }
}

async function uploadFileInChunks(file, folderId) {
    const modal = document.getElementById("upload-modal");
    const nameEl = document.getElementById("upload-filename");
    const fillEl = document.getElementById("upload-progress-fill");
    const bytesEl = document.getElementById("upload-bytes-stat");
    const pctEl = document.getElementById("upload-percentage-stat");
    const subtextEl = document.getElementById("upload-chunk-stat");
    const queueEl = document.getElementById("upload-queue-stat");

    modal.style.display = "flex";
    nameEl.textContent = `Subiendo: ${file.name}`;
    fillEl.style.width = "0%";
    bytesEl.textContent = `0 MB / ${formatMB(file.size)} MB`;
    pctEl.textContent = "0.0%";
    subtextEl.textContent = "Iniciando fragmentación...";
    queueEl.textContent = state.uploadQueue.length
        ? `${state.uploadQueue.length} archivo(s) más en cola`
        : "";

    const uploadId = "upl_" + Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
    const totalChunks = Math.ceil(file.size / CONFIG.CHUNK_SIZE);
    if (totalChunks < 1) {
        modal.style.display = "none";
        alert("No se puede subir un archivo vacío.");
        return;
    }
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
        formData.append("folderId", folderId || "");
        formData.append("chunk", chunkBlob, file.name);

        subtextEl.textContent = `Enviando fragmento ${i + 1} de ${totalChunks}...`;

        try {
            let res;
            let lastError;
            for (let attempt = 1; attempt <= 3; attempt += 1) {
                try {
                    res = await fetch(`${CONFIG.API_URL}/api/custom/upload-chunk`, {
                        method: "POST",
                        headers: { "Authorization": state.token },
                        body: formData
                    });
                    if (res.ok) break;

                    const responseText = await res.text();
                    let errData = {};
                    try {
                        errData = responseText ? JSON.parse(responseText) : {};
                    } catch (_) {
                        errData = {};
                    }
                    lastError = new Error(
                        errData.error ||
                        errData.message ||
                        responseText ||
                        `Error HTTP ${res.status} al enviar el fragmento.`
                    );
                } catch (err) {
                    lastError = err;
                }

                if (attempt < 3) {
                    subtextEl.textContent = `Reintentando fragmento ${i + 1}...`;
                    await new Promise(resolve => setTimeout(resolve, attempt * 1000));
                }
            }
            if (!res || !res.ok) throw lastError || new Error("Error en el fragmento.");

            bytesUploaded += chunkBlob.size;
            const percentage = ((bytesUploaded / file.size) * 100).toFixed(1);

            fillEl.style.width = `${percentage}%`;
            bytesEl.textContent = `${formatMB(bytesUploaded)} MB / ${formatMB(file.size)} MB`;
            pctEl.textContent = `${percentage}%`;
        } catch (err) {
            alert(`Error en la subida: ${err.message}`);
            subtextEl.textContent = `Error: ${err.message}`;
            return;
        }
    }

    subtextEl.textContent = "Ensamblando y verificando integridad...";
    await new Promise(resolve => setTimeout(resolve, 600));
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
        const data = await getCollectionData(res, "los eventos");
        state.calendarEventsCache = data.items;
        renderCalendar();
    } catch (err) {
        container.innerHTML = `<p class="alert-error">Error al cargar la agenda: ${err.message}</p>`;
    }
}

function renderCalendar() {
    const listContainer = document.getElementById("calendar-events-list");
    const monthGrid = document.getElementById("calendar-month-grid");
    const monthNavigation = document.getElementById("calendar-month-navigation");
    const listButton = document.getElementById("calendar-list-view");
    const monthButton = document.getElementById("calendar-month-view");

    listContainer.style.display = state.calendarView === "list" ? "grid" : "none";
    monthGrid.style.display = state.calendarView === "month" ? "grid" : "none";
    monthNavigation.style.display = state.calendarView === "month" ? "flex" : "none";
    listButton.classList.toggle("btn-primary", state.calendarView === "list");
    listButton.classList.toggle("btn-secondary", state.calendarView !== "list");
    monthButton.classList.toggle("btn-primary", state.calendarView === "month");
    monthButton.classList.toggle("btn-secondary", state.calendarView !== "month");

    if (state.calendarView === "month") {
        renderCalendarMonth(monthGrid);
        return;
    }

    listContainer.innerHTML = "";
    if (state.calendarEventsCache.length === 0) {
        listContainer.innerHTML = "<p>No hay eventos registrados.</p>";
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
        listContainer.appendChild(card);
    });
}

function renderCalendarMonth(container) {
    const year = state.calendarMonth.getFullYear();
    const month = state.calendarMonth.getMonth();
    const monthLabel = state.calendarMonth.toLocaleDateString("es-ES", { month: "long", year: "numeric" });
    document.getElementById("calendar-month-label").textContent =
        monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1);

    const firstDay = new Date(year, month, 1);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const startOffset = (firstDay.getDay() + 6) % 7;
    const weekdayLabels = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
    container.innerHTML = weekdayLabels.map(day => `<div class="calendar-weekday">${day}</div>`).join("");

    for (let index = 0; index < startOffset + daysInMonth; index += 1) {
        const dayNumber = index - startOffset + 1;
        const cell = document.createElement("div");
        cell.className = "calendar-day";
        if (dayNumber < 1) {
            cell.classList.add("calendar-day-muted");
            container.appendChild(cell);
            continue;
        }

        const dayDate = new Date(year, month, dayNumber);
        const dayEvents = state.calendarEventsCache.filter(evt => {
            const start = new Date(evt.start_time);
            const end = new Date(evt.end_time || evt.start_time);
            return dayDate <= end && new Date(year, month, dayNumber + 1) > start;
        });

        cell.innerHTML = `<div class="calendar-day-number">${dayNumber}</div>`;
        dayEvents.forEach(evt => {
            const event = document.createElement("div");
            event.className = "calendar-day-event";
            event.title = `${evt.title} · ${formatDateTime(evt.start_time)}`;
            event.textContent = evt.title;
            cell.appendChild(event);
        });
        container.appendChild(cell);
    }
}

async function deleteCalendarEvent(id) {
    if (!confirm("¿Eliminar este evento?")) return;
    let lockToken = "";
    try {
        const lockRes = await fetch(`${CONFIG.API_URL}/api/custom/locks/acquire`, {
            method: "POST",
            headers: getHeaders(),
            body: JSON.stringify({
                resourceType: "calendar_events",
                resourceId: id
            })
        });
        const lockData = await lockRes.json();
        if (!lockRes.ok) throw new Error(lockData.error || "El evento está siendo editado por otro usuario.");
        lockToken = lockData.token;

        const deleteRes = await fetch(`${CONFIG.API_URL}/api/collections/calendar_events/records/${id}`, {
            method: "DELETE",
            headers: {
                ...getHeaders(),
                "X-Resource-Lock": lockToken
            }
        });
        if (!deleteRes.ok) {
            const error = await deleteRes.json().catch(() => ({}));
            throw new Error(error.message || error.error || "No se pudo eliminar el evento.");
        }
        loadCalendar();
    } catch (err) {
        alert(err.message);
    } finally {
        if (lockToken) {
            await fetch(`${CONFIG.API_URL}/api/custom/locks/release`, {
                method: "POST",
                headers: getHeaders(),
                body: JSON.stringify({
                    resourceType: "calendar_events",
                    resourceId: id,
                    token: lockToken
                })
            });
        }
    }
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
    try {
        await withResourceLock("contacts", id, async (lockToken) => {
            const res = await fetch(`${CONFIG.API_URL}/api/collections/contacts/records/${id}`, {
                method: "DELETE",
                headers: { ...getHeaders(), "X-Resource-Lock": lockToken }
            });
            if (!res.ok) throw new Error("No se pudo eliminar el contacto.");
        });
        loadContacts();
    } catch (err) {
        alert(err.message);
    }
}

// ==========================================
// 7. ADMINISTRACIÓN
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
    loadWopiSettings();
}

async function editUserQuota(userId, currentQuota) {
    const currentGB = currentQuota > 0 ? (currentQuota / (1024 * 1024 * 1024)).toFixed(0) : 0;
    const newGB = prompt("Introduce la cuota en Gigabytes (0 para ilimitado):", currentGB);
    if (newGB === null) return;

    const bytes = parseInt(newGB, 10) * 1024 * 1024 * 1024;
    await fetch(`${CONFIG.API_URL}/api/collections/users/records/${userId}`, {
        method: "PATCH",
        headers: getHeaders(),
        body: JSON.stringify({ storage_quota: bytes })
    });
    loadAdminData();
}

async function loadWopiSettings() {
    try {
        const res = await fetch(`${CONFIG.API_URL}/api/collections/app_settings/records?perPage=1`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.items && data.items[0]) {
            const s = data.items[0];
            document.getElementById("wopi-enabled").checked = !!s.wopi_enabled;
            document.getElementById("wopi-server-url").value = s.wopi_server_url || "";
            document.getElementById("wopi-public-url").value = s.wopi_public_url || "";
            state.wopiEnabled = !!s.wopi_enabled;
        }
    } catch (_) {}
}

async function handleSaveWopi(e) {
    e.preventDefault();
    const enabled = document.getElementById("wopi-enabled").checked;
    const serverUrl = document.getElementById("wopi-server-url").value.trim();
    const publicUrl = document.getElementById("wopi-public-url").value.trim();

    try {
        const res = await fetch(`${CONFIG.API_URL}/api/collections/app_settings/records/${state.settingsRecordId}`, {
            method: "PATCH",
            headers: getHeaders(),
            body: JSON.stringify({
                wopi_enabled: enabled,
                wopi_server_url: serverUrl,
                wopi_public_url: publicUrl
            })
        });

        if (!res.ok) throw new Error("Fallo al guardar configuración WOPI");
        state.wopiEnabled = enabled;
        alert("Configuración WOPI actualizada con éxito.");
    } catch (err) {
        alert("Error: " + err.message);
    }
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
        btn.textContent = "Probar";
        btn.disabled = false;
    }
}

// ==========================================
// 8. THEMING GLOBAL
// ==========================================

async function fetchGlobalTheme() {
    try {
        const res = await fetch(`${CONFIG.API_URL}/api/collections/app_settings/records?perPage=1`);
        if (res.ok) {
            const data = await res.json();
            if (data.items && data.items.length > 0) {
                const s = data.items[0];
                state.settingsRecordId = s.id;
                state.wopiEnabled = !!s.wopi_enabled;
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

        if (!res.ok) throw new Error("Error al guardar tema");
        renderTheme(name, icon, color);
        alert("Personalización corporativa guardada en el servidor.");
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

function modalFolderSettings(folder) {
    openModal("Ajustes de carpeta", `
        <form id="form-folder-settings">
            <div class="form-group">
                <label for="folder-settings-name">Nombre</label>
                <input type="text" id="folder-settings-name" value="${escapeHtml(folder.name)}" maxlength="255" required>
            </div>
            <label class="checkbox-row">
                <input type="checkbox" id="folder-settings-group" ${folder.is_group ? "checked" : ""}>
                Compartir con mi grupo
            </label>
            <p class="form-help">${state.user.user_group ? "Los miembros del grupo podrán ver su contenido." : "Tu usuario no pertenece a ningún grupo."}</p>
            <div class="modal-actions">
                <button type="button" class="btn btn-danger" id="folder-settings-delete">Eliminar</button>
                <button type="submit" class="btn btn-primary">Guardar cambios</button>
            </div>
        </form>
    `);

    const groupInput = document.getElementById("folder-settings-group");
    groupInput.disabled = !state.user.user_group;
    document.getElementById("form-folder-settings").onsubmit = async (event) => {
        event.preventDefault();
        const name = document.getElementById("folder-settings-name").value.trim();
        const isGroup = groupInput.checked;
        if (!name) return;
        try {
            await withResourceLock("folders", folder.id, async (lockToken) => {
                const res = await fetch(`${CONFIG.API_URL}/api/collections/folders/records/${folder.id}`, {
                    method: "PATCH",
                    headers: { ...getHeaders(), "X-Resource-Lock": lockToken },
                    body: JSON.stringify({
                        name,
                        is_group: isGroup,
                        group: isGroup ? state.user.user_group : null
                    })
                });
                if (!res.ok) throw new Error("No se pudieron guardar los ajustes de la carpeta.");
            });
                    await recordActivity("folder", folder.id, "rename", `Nombre: ${name}`);
                    closeModal();
            loadFiles();
        } catch (err) {
            alert(err.message);
        }
    };
    document.getElementById("folder-settings-delete").onclick = () => {
        closeModal();
        deleteFolder(folder.id);
    };
}

async function modalFileSettings(file) {
    let folders = [];
    try {
        const res = await fetch(`${CONFIG.API_URL}/api/collections/folders/records?sort=name&perPage=200`, { headers: getHeaders() });
        const data = await getCollectionData(res, "las carpetas");
        folders = data.items;
    } catch (err) {
        alert(err.message);
        return;
    }

    const folderOptions = [`<option value="">Raíz</option>`]
        .concat(folders.map(folder => `<option value="${escapeHtml(folder.id)}" ${folder.id === file.folder ? "selected" : ""}>${escapeHtml(folder.name)}</option>`))
        .join("");
    const foldersById = Object.fromEntries(folders.map(folder => [folder.id, folder]));
    openModal("Ajustes del archivo", `
        <form id="form-file-settings">
            <div class="form-group">
                <label for="file-settings-name">Nombre</label>
                <input type="text" id="file-settings-name" value="${escapeHtml(file.name)}" maxlength="255" required>
            </div>
            <div class="form-group">
                <label for="file-settings-folder">Carpeta</label>
                <select id="file-settings-folder">${folderOptions}</select>
            </div>
            <div class="modal-actions">
                <button type="button" class="btn btn-secondary" id="file-history-btn">Historial</button>
                <button type="submit" class="btn btn-primary">Guardar cambios</button>
            </div>
        </form>
    `);
    document.getElementById("file-history-btn").onclick = () => showFileHistory(file);
    document.getElementById("form-file-settings").onsubmit = async (event) => {
        event.preventDefault();
        const name = document.getElementById("file-settings-name").value.trim();
        const folderId = document.getElementById("file-settings-folder").value;
        if (!name) return;
        const selectedFolder = folderId ? foldersById[folderId] : null;
        try {
            await withResourceLock("files", file.id, async (lockToken) => {
                const res = await fetch(`${CONFIG.API_URL}/api/collections/files/records/${file.id}`, {
                    method: "PATCH",
                    headers: { ...getHeaders(), "X-Resource-Lock": lockToken },
                    body: JSON.stringify({
                        name,
                        folder: folderId || null,
                        is_group: !!selectedFolder?.is_group,
                        group: selectedFolder?.is_group ? selectedFolder.group : null
                    })
                });
                if (!res.ok) throw new Error("No se pudieron guardar los ajustes del archivo.");
            });
            await recordActivity("file", file.id, folderId !== file.folder ? "move" : "rename", `Nombre: ${name}`);
            closeModal();
            loadFiles();
        } catch (err) {
            alert(err.message);
        }

        async function showFileHistory(file) {
            try {
                const res = await fetch(`${CONFIG.API_URL}/api/custom/file-activity?resourceId=${encodeURIComponent(file.id)}`, { headers: getHeaders(false) });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || "No se pudo cargar el historial.");
                const labels = { upload: "Subido", rename: "Renombrado", move: "Movido", trash: "Enviado a papelera", restore: "Restaurado", edit: "Editado", download: "Descargado" };
                const items = data.items.length
                    ? data.items.map(item => `<div class="history-item"><strong>${labels[item.action] || item.action}</strong><span>${formatDate(item.created)}</span><small>${escapeHtml(item.details || "")}</small></div>`).join("")
                    : `<p class="form-help">Todavía no hay actividad registrada.</p>`;
                openModal(`Historial: ${file.name}`, `<div class="history-list">${items}</div>`);
            } catch (err) {
                alert(err.message);
            }
        }
    };
}

function modalForcePasswordChange() {
    openModal("Cambio Obligatorio de Contraseña", `
        <p style="font-size:0.875rem; color:var(--text-muted); margin-bottom:1rem;">
            Por seguridad, debes actualizar tu contraseña temporal (mínimo 8 caracteres).
        </p>
        <form id="form-force-pass">
            <div class="form-group">
                <label>Nueva Contraseña</label>
                <input type="password" id="new-password" minlength="8" required autofocus>
            </div>
            <div class="form-group">
                <label>Confirmar Contraseña</label>
                <input type="password" id="new-password-confirm" minlength="8" required>
            </div>
            <button type="submit" class="btn btn-primary btn-block">Guardar Nueva Contraseña</button>
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
            const res = await fetch(`${CONFIG.API_URL}/api/custom/change-password`, {
                method: "POST",
                headers: getHeaders(),
                body: JSON.stringify({
                    password: p1,
                    passwordConfirm: p2,
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
                <input type="password" id="new-user-pass" minlength="8" required>
            </div>
            <div class="form-group">
                <label>Rol</label>
                <select id="new-user-role">
                    <option value="user">Usuario Estándar</option>
                    <option value="admin">Administrador</option>
                </select>
            </div>
            <div class="form-group">
                <label>Cuota de Almacenamiento (GB, 0 = ilimitado)</label>
                <input type="number" id="new-user-quota" value="10">
            </div>
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
            alert(`Usuario ${email} creado correctamente.`);
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
                <input type="text" id="event-location" placeholder="Sala 1...">
            </div>
            <div class="form-group">
                <label>Notas</label>
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

        const quota = state.user.storage_quota || 0;
        const quotaLabel = quota > 0 ? `${formatMB(quota)} MB` : "Ilimitada";
        document.getElementById("storage-quota-display").textContent = `${formatMB(totalUsed)} MB / ${quotaLabel}`;
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

async function getCollectionData(response, resourceName) {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data.message || data.error || `No se pudieron cargar ${resourceName}.`);
    }
    if (!data || !Array.isArray(data.items)) {
        throw new Error(`La respuesta de ${resourceName} no tiene un formato válido.`);
    }
    return data;
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
