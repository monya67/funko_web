const API_BASE = '/api';

// DOM Elements
const loginView = document.getElementById('login-view');
const dashboardView = document.getElementById('dashboard-view');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const logoutBtn = document.getElementById('logout-btn');

// Tabs
const navItems = document.querySelectorAll('.nav-item');
const tabContents = document.querySelectorAll('.tab-content');

// Modals
const modalOverlay = document.getElementById('modal-overlay');
const createClientBtn = document.getElementById('new-client-btn');
const createOrderBtn = document.getElementById('new-order-btn');
const createClientModal = document.getElementById('create-client-modal');
const createOrderModal = document.getElementById('create-order-modal');
const editOrderModal = document.getElementById('edit-order-modal');
const photoViewerModal = document.getElementById('photo-viewer-modal');
const confirmDeleteModal = document.getElementById('confirm-delete-modal');
const closeBtns = document.querySelectorAll('.close-modal');

// Tables
const ordersTableBody = document.querySelector('#orders-table tbody');
const archivedTableBody = document.querySelector('#archived-table tbody');
const clientsTableBody = document.querySelector('#clients-table tbody');
const accountingTableBody = document.querySelector('#accounting-table tbody');

const accountingSearch = document.getElementById('accounting-search');
let accountingSort = { key: 'id', desc: true };

// Forms
const createClientForm = document.getElementById('create-client-form');
const createOrderForm = document.getElementById('create-order-form');
const editOrderForm = document.getElementById('edit-order-form');

// State
let token = localStorage.getItem('funko_token');
let currentRole = null;
let allOrders = []; // active + archived combined for lookups
let rawActiveOrders = [];
let rawArchivedOrders = [];
let ordersSort = { key: 'id', desc: true };
let archivedSort = { key: 'id', desc: true };
let deleteTargetId = null;

// Init
function init() {
    if (token) {
        showDashboard();
    } else {
        showLogin();
    }
}

function showLogin() {
    loginView.classList.remove('hidden');
    dashboardView.classList.add('hidden');
    setTimeout(() => loginView.style.opacity = '1', 30);
}

function showDashboard() {
    loginView.style.opacity = '0';
    setTimeout(() => {
        loginView.classList.add('hidden');
        dashboardView.classList.remove('hidden');
        loadDashboardData();
        startHeartbeat();
    }, 400);
}

function updateRoleUI(role) {
    currentRole = role;
    const adminElements = document.querySelectorAll('.admin-only');
    if (role === 'admin') {
        adminElements.forEach(el => el.classList.remove('hidden'));
    } else {
        adminElements.forEach(el => el.classList.add('hidden'));
    }
}

function updateOnlineBadge(count) {
    const el = document.getElementById('online-count');
    if (el) el.textContent = count || 1;
}

let heartbeatInterval = null;
function startHeartbeat() {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(async () => {
        if (!token) return;
        try {
            const data = await fetchAPI('/ping', { method: 'POST' });
            if (data && data.online_count) {
                updateOnlineBadge(data.online_count);
            }
        } catch (e) {
            // Ignore heartbeat errors
        }
    }, 20000);
}

// Auth
loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    
    loginError.textContent = '';
    const btn = loginForm.querySelector('button');
    btn.textContent = 'Вход...';
    
    try {
        const formData = new URLSearchParams();
        formData.append('username', username);
        formData.append('password', password);

        const res = await fetch(`${API_BASE}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: formData
        });

        if (!res.ok) {
            const errData = await res.json();
            throw new Error(errData.detail || 'Неверный логин или пароль');
        }

        const data = await res.json();
        token = data.access_token;
        localStorage.setItem('funko_token', token);
        showDashboard();
    } catch (err) {
        loginError.textContent = err.message;
    } finally {
        btn.textContent = 'Войти';
    }
});

logoutBtn.addEventListener('click', () => {
    token = null;
    currentRole = null;
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    localStorage.removeItem('funko_token');
    // Clear all rendered data so nothing flashes on next login
    ordersTableBody.innerHTML = '';
    archivedTableBody.innerHTML = '';
    clientsTableBody.innerHTML = '';
    if (accountingTableBody) accountingTableBody.innerHTML = '';
    allOrders = [];
    rawActiveOrders = [];
    rawArchivedOrders = [];
    showLogin();
});

// Navigation
navItems.forEach(item => {
    item.addEventListener('click', (e) => {
        e.preventDefault();
        navItems.forEach(nav => nav.classList.remove('active'));
        item.classList.add('active');
        
        const targetId = item.getAttribute('data-tab') + '-tab';
        tabContents.forEach(tab => {
            tab.id === targetId ? tab.classList.remove('hidden') : tab.classList.add('hidden');
        });
    });
});

function getDeviceId() {
    let devId = sessionStorage.getItem('funko_device_id');
    if (!devId) {
        devId = 'dev_' + Math.random().toString(36).substring(2) + Date.now().toString(36);
        sessionStorage.setItem('funko_device_id', devId);
    }
    return devId;
}

// API
async function fetchAPI(endpoint, options = {}) {
    if (!token) return logoutBtn.click();
    
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Device-ID': getDeviceId(),
        ...options.headers
    };
    
    const res = await fetch(`${API_BASE}${endpoint}`, { ...options, headers });
    if (res.status === 401 || res.status === 403) {
        logoutBtn.click();
        throw new Error('Сессия истекла');
    }
    const data = await res.json();
    if (!res.ok) {
        throw new Error(data.detail || 'Ошибка');
    }
    return data;
}

async function loadDashboardData() {
    try {
        const data = await fetchAPI('/dashboard');
        updateRoleUI(data.role);
        if (data.online_count) updateOnlineBadge(data.online_count);
        rawActiveOrders = data.orders || [];
        rawArchivedOrders = data.archived || [];
        allOrders = [...rawActiveOrders, ...rawArchivedOrders];
        
        renderOrders();
        renderArchivedOrders();
        
        if (data.role === 'admin') {
            renderClients(data.clients);
            renderAccounting();
        }
    } catch (err) {
        console.error(err);
    }
}

function formatDisplayDate(dateStr) {
    if (!dateStr) return '—';
    dateStr = dateStr.trim();
    if (!dateStr) return '—';

    // If YYYY-MM-DD or YYYY-MM-DD HH:MM
    if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
        const parts = dateStr.split(' ')[0].split('-');
        return `${parts[2]}.${parts[1]}.${parts[0]}`;
    }
    // If DD.MM.YYYY HH:MM -> strip time
    if (/^\d{2}\.\d{2}\.\d{4}/.test(dateStr)) {
        return dateStr.split(' ')[0];
    }
    return dateStr;
}

// Render active orders with filter & sort support
function renderOrders() {
    ordersTableBody.innerHTML = '';
    const emptyMsg = document.getElementById('no-orders');
    const role = currentRole;
    
    let orders = [...rawActiveOrders];

    // Filters
    const yearVal = document.getElementById('orders-year-filter')?.value;
    const monthVal = document.getElementById('orders-month-filter')?.value;
    if (yearVal || monthVal) {
        orders = orders.filter(o => {
            if (!o.order_date) return false;
            const formatted = formatDisplayDate(o.order_date); // DD.MM.YYYY
            if (formatted.includes('.')) {
                const parts = formatted.split('.'); // [DD, MM, YYYY]
                const matchYear = !yearVal || parts[2] === yearVal;
                const matchMonth = !monthVal || parts[1] === monthVal;
                return matchYear && matchMonth;
            }
            return false;
        });
    }

    const statusCheckboxes = document.querySelectorAll('#orders-status-content input[type="checkbox"]:checked');
    const selectedStatuses = Array.from(statusCheckboxes).map(cb => cb.value);
    if (selectedStatuses.length > 0) {
        orders = orders.filter(o => selectedStatuses.includes(o.status));
    }

    const clientVal = parseInt(document.getElementById('orders-client-filter')?.value);
    if (!isNaN(clientVal)) {
        orders = orders.filter(o => o.client_id === clientVal);
    }

    const priceMin = parseFloat(document.getElementById('orders-price-min')?.value);
    if (!isNaN(priceMin)) {
        orders = orders.filter(o => o.total_price >= priceMin);
    }

    const priceMax = parseFloat(document.getElementById('orders-price-max')?.value);
    if (!isNaN(priceMax)) {
        orders = orders.filter(o => o.total_price <= priceMax);
    }

    const paidMin = parseFloat(document.getElementById('orders-paid-min')?.value);
    if (!isNaN(paidMin)) {
        orders = orders.filter(o => o.paid_amount >= paidMin);
    }

    const paidMax = parseFloat(document.getElementById('orders-paid-max')?.value);
    if (!isNaN(paidMax)) {
        orders = orders.filter(o => o.paid_amount <= paidMax);
    }

    const q = document.getElementById('orders-search')?.value.toLowerCase().trim();
    if (q) {
        orders = orders.filter(o => 
            o.id.toString().includes(q) || 
            (o.client_id && o.client_id.toString().includes(q)) || 
            o.items.toLowerCase().includes(q)
        );
    }
    
    // Sorting
    orders.sort((a, b) => {
        let valA, valB;
        if (ordersSort.key === 'id') { valA = a.id; valB = b.id; }
        else if (ordersSort.key === 'date') { valA = a.order_date || ''; valB = b.order_date || ''; }
        else if (ordersSort.key === 'client') { valA = a.client_id || 0; valB = b.client_id || 0; }
        else if (ordersSort.key === 'price') { valA = a.total_price; valB = b.total_price; }
        else if (ordersSort.key === 'paid') { valA = a.paid_amount || 0; valB = b.paid_amount || 0; }
        else if (ordersSort.key === 'status') { valA = a.status || ''; valB = b.status || ''; }
        if (valA < valB) return ordersSort.desc ? 1 : -1;
        if (valA > valB) return ordersSort.desc ? -1 : 1;
        return 0;
    });

    if (orders.length === 0) {
        emptyMsg.classList.remove('hidden');
        return;
    }
    emptyMsg.classList.add('hidden');
    
    orders.forEach((order, i) => {
        const tr = document.createElement('tr');
        tr.className = 'row-animate';
        tr.style.animationDelay = `${i * 0.04}s`;
        
        let html = '';
        if (role === 'admin') {
            html += `<td><input type="checkbox" class="order-row-checkbox" value="${order.id}" style="cursor: pointer;" onchange="updateMassEditPanel('orders')"></td>`;
        }
        html += `<td>${order.id}</td>`;
        html += `<td style="white-space: nowrap; font-size: 0.85rem; color: var(--gray-light);">${formatDisplayDate(order.order_date)}</td>`;
        if (role === 'admin') {
            html += `<td class="admin-only">${order.client_id}</td>`;
        }
        
        html += order.photo_id
            ? `<td><img src="/api/photos/${order.photo_id}" style="width: 50px; height: 50px; object-fit: cover; border-radius: 5px; cursor: pointer; transition: transform 0.2s;" onclick="viewPhoto('${order.photo_id}')" onmouseover="this.style.transform='scale(1.1)'" onmouseout="this.style.transform='scale(1)'"></td>`
            : `<td style="color: var(--gray-light);">—</td>`;
        
        html += `
            <td>${order.items.replace(/\n/g, '<br>')}</td>
            <td>${order.total_price.toLocaleString('ru')}</td>
            <td>${order.paid_amount.toLocaleString('ru')}</td>
            <td><span class="status-badge">${order.status}</span></td>
        `;
        
        if (role === 'admin') {
            html += `
                <td class="admin-only actions-cell">
                    <button class="edit-btn" onclick="openEditModal(${order.id})">Редактировать</button>
                    <button class="archive-btn" onclick="archiveOrder(${order.id})">В архив</button>
                    <button class="delete-btn" onclick="confirmDelete(${order.id})">Удалить</button>
                </td>
            `;
        }
        
        tr.innerHTML = html;
        ordersTableBody.appendChild(tr);
    });
}

// Render archived orders
function renderArchivedOrders() {
    archivedTableBody.innerHTML = '';
    const emptyMsg = document.getElementById('no-archived');
    const role = currentRole;
    let orders = [...rawArchivedOrders];

    // Filters
    const yearVal = document.getElementById('archived-year-filter')?.value;
    const monthVal = document.getElementById('archived-month-filter')?.value;
    if (yearVal || monthVal) {
        orders = orders.filter(o => {
            if (!o.order_date) return false;
            const formatted = formatDisplayDate(o.order_date);
            if (formatted.includes('.')) {
                const parts = formatted.split('.');
                const matchYear = !yearVal || parts[2] === yearVal;
                const matchMonth = !monthVal || parts[1] === monthVal;
                return matchYear && matchMonth;
            }
            return false;
        });
    }

    const statusCheckboxes = document.querySelectorAll('#archived-status-content input[type="checkbox"]:checked');
    const selectedStatuses = Array.from(statusCheckboxes).map(cb => cb.value);
    if (selectedStatuses.length > 0) {
        orders = orders.filter(o => selectedStatuses.includes(o.status));
    }

    const clientVal = parseInt(document.getElementById('archived-client-filter')?.value);
    if (!isNaN(clientVal)) {
        orders = orders.filter(o => o.client_id === clientVal);
    }

    const priceMin = parseFloat(document.getElementById('archived-price-min')?.value);
    if (!isNaN(priceMin)) {
        orders = orders.filter(o => o.total_price >= priceMin);
    }

    const priceMax = parseFloat(document.getElementById('archived-price-max')?.value);
    if (!isNaN(priceMax)) {
        orders = orders.filter(o => o.total_price <= priceMax);
    }

    const paidMin = parseFloat(document.getElementById('archived-paid-min')?.value);
    if (!isNaN(paidMin)) {
        orders = orders.filter(o => o.paid_amount >= paidMin);
    }

    const paidMax = parseFloat(document.getElementById('archived-paid-max')?.value);
    if (!isNaN(paidMax)) {
        orders = orders.filter(o => o.paid_amount <= paidMax);
    }

    const q = document.getElementById('archived-search')?.value.toLowerCase().trim();
    if (q) {
        orders = orders.filter(o => 
            o.id.toString().includes(q) || 
            (o.client_id && o.client_id.toString().includes(q)) || 
            o.items.toLowerCase().includes(q)
        );
    }

    // Sorting
    orders.sort((a, b) => {
        let valA, valB;
        if (archivedSort.key === 'id') { valA = a.id; valB = b.id; }
        else if (archivedSort.key === 'date') { valA = a.order_date || ''; valB = b.order_date || ''; }
        else if (archivedSort.key === 'client') { valA = a.client_id || 0; valB = b.client_id || 0; }
        else if (archivedSort.key === 'price') { valA = a.total_price; valB = b.total_price; }
        else if (archivedSort.key === 'paid') { valA = a.paid_amount || 0; valB = b.paid_amount || 0; }
        else if (archivedSort.key === 'status') { valA = a.status || ''; valB = b.status || ''; }
        if (valA < valB) return archivedSort.desc ? 1 : -1;
        if (valA > valB) return archivedSort.desc ? -1 : 1;
        return 0;
    });

    if (orders.length === 0) {
        emptyMsg.classList.remove('hidden');
        return;
    }
    emptyMsg.classList.add('hidden');
    
    orders.forEach((order, i) => {
        const tr = document.createElement('tr');
        tr.className = 'row-animate';
        tr.style.animationDelay = `${i * 0.04}s`;
        
        let html = '';
        if (role === 'admin') {
            html += `<td><input type="checkbox" class="archived-row-checkbox" value="${order.id}" style="cursor: pointer;" onchange="updateMassEditPanel('archived')"></td>`;
        }
        html += `<td>${order.id}</td>`;
        html += `<td style="white-space: nowrap; font-size: 0.85rem; color: var(--gray-light);">${formatDisplayDate(order.order_date)}</td>`;
        if (role === 'admin') {
            html += `<td class="admin-only">${order.client_id}</td>`;
        }
        
        html += order.photo_id
            ? `<td><img src="/api/photos/${order.photo_id}" style="width: 50px; height: 50px; object-fit: cover; border-radius: 5px; cursor: pointer; transition: transform 0.2s;" onclick="viewPhoto('${order.photo_id}')" onmouseover="this.style.transform='scale(1.1)'" onmouseout="this.style.transform='scale(1)'"></td>`
            : `<td style="color: var(--gray-light);">—</td>`;
        
        html += `
            <td>${order.items.replace(/\n/g, '<br>')}</td>
            <td>${order.total_price.toLocaleString('ru')}</td>
            <td>${order.paid_amount.toLocaleString('ru')}</td>
            <td><span class="status-badge archived-badge">${order.status}</span></td>
        `;
        
        if (role === 'admin') {
            html += `
                <td class="admin-only actions-cell">
                    <button class="edit-btn" onclick="unarchiveOrder(${order.id})">Восстановить</button>
                    <button class="delete-btn" onclick="confirmDelete(${order.id})">Удалить</button>
                </td>
            `;
        }
        
        tr.innerHTML = html;
        archivedTableBody.appendChild(tr);
    });
}

// Render clients
function renderClients(clients) {
    clientsTableBody.innerHTML = '';
    clients.forEach((client, i) => {
        const tr = document.createElement('tr');
        tr.className = 'row-animate';
        tr.style.animationDelay = `${i * 0.04}s`;
        tr.innerHTML = `
            <td>${client.id}</td>
            <td>${client.password}</td>
            <td>${client.user_tg_id || '—'}</td>
        `;
        clientsTableBody.appendChild(tr);
    });
}

// Global state for toggles
window.marginMode = 'rub'; // 'rub' or 'percent'
window.taxesExpanded = false;

window.toggleMarginMode = function() {
    window.marginMode = window.marginMode === 'rub' ? 'percent' : 'rub';
    document.getElementById('margin-mode-indicator').textContent = window.marginMode === 'rub' ? '(₽)' : '(%)';
    renderAccounting();
};

window.toggleTaxes = function(e) {
    e.stopPropagation();
    window.taxesExpanded = !window.taxesExpanded;
    document.getElementById('taxes-toggle-icon').textContent = window.taxesExpanded ? '[-]' : '[+]';
    document.querySelectorAll('.tax-column').forEach(el => {
        if (window.taxesExpanded) {
            el.classList.remove('hidden');
        } else {
            el.classList.add('hidden');
        }
    });
};

function renderAccounting() {
    if (!accountingTableBody) return;
    accountingTableBody.innerHTML = '';
    const emptyMsg = document.getElementById('no-accounting');
    
    let filteredOrders = allOrders;
    
    // Search
    if (accountingSearch && accountingSearch.value) {
        const q = accountingSearch.value.toLowerCase();
        filteredOrders = filteredOrders.filter(o => 
            o.id.toString().includes(q) || o.items.toLowerCase().includes(q)
        );
    }
    
    if (filteredOrders.length === 0) {
        emptyMsg.classList.remove('hidden');
        return;
    }
    emptyMsg.classList.add('hidden');
    
    // Calculate fields and sort
    const processed = filteredOrders.map(o => {
        const cost = o.cost_price || 0;
        const delivery = o.delivery_cost || 0;
        const usn = o.total_price * 0.06;
        const checks = o.total_price * 0.015;
        const acquiring = o.total_price * 0.02;
        const totalTax = usn + checks + acquiring;
        
        let marginVal = o.total_price - cost - delivery - totalTax;
        let marginDisplay = '';
        if (window.marginMode === 'percent') {
            const pct = o.total_price > 0 ? (marginVal / o.total_price) * 100 : 0;
            marginDisplay = pct.toFixed(1) + '%';
            marginVal = pct; // for sorting
        } else {
            marginDisplay = marginVal.toLocaleString('ru') + ' ₽';
        }
        
        return { ...o, cost, delivery, usn, checks, acquiring, totalTax, marginVal, marginDisplay };
    });
    
    processed.sort((a, b) => {
        let valA, valB;
        if (accountingSort.key === 'id') { valA = a.id; valB = b.id; }
        else if (accountingSort.key === 'date') { valA = a.order_date || ''; valB = b.order_date || ''; }
        else if (accountingSort.key === 'price') { valA = a.total_price; valB = b.total_price; }
        else if (accountingSort.key === 'cost') { valA = a.cost; valB = b.cost; }
        else if (accountingSort.key === 'delivery') { valA = a.delivery; valB = b.delivery; }
        else if (accountingSort.key === 'margin') { valA = a.marginVal; valB = b.marginVal; }
        else { valA = a.id; valB = b.id; }
        
        if (valA < valB) return accountingSort.desc ? 1 : -1;
        if (valA > valB) return accountingSort.desc ? -1 : 1;
        return 0;
    });

    processed.forEach((order, i) => {
        const tr = document.createElement('tr');
        tr.className = 'row-animate';
        tr.style.animationDelay = `${i * 0.04}s`;
        
        let photoHtml = order.photo_id
            ? `<td><img src="/api/photos/${order.photo_id}" style="width: 50px; height: 50px; object-fit: cover; border-radius: 5px; cursor: pointer; transition: transform 0.2s;" onclick="viewPhoto('${order.photo_id}')" onmouseover="this.style.transform='scale(1.1)'" onmouseout="this.style.transform='scale(1)'"></td>`
            : `<td style="color: var(--gray-light);">—</td>`;
            
        tr.innerHTML = `
            <td>${order.id}</td>
            <td>${formatDisplayDate(order.order_date)}</td>
            ${photoHtml}
            <td>${order.items.replace(/\n/g, '<br>')}</td>
            <td>${order.cost.toLocaleString('ru')}</td>
            <td>${order.delivery.toLocaleString('ru')}</td>
            <td>${(order.paid_amount || 0).toLocaleString('ru')}</td>
            <td style="color: #ff9999; font-weight: bold;">${order.totalTax.toLocaleString('ru', {maximumFractionDigits:0})}</td>
            <td class="tax-column ${window.taxesExpanded ? '' : 'hidden'}">${order.usn.toLocaleString('ru', {maximumFractionDigits:0})}</td>
            <td class="tax-column ${window.taxesExpanded ? '' : 'hidden'}">${order.checks.toLocaleString('ru', {maximumFractionDigits:0})}</td>
            <td class="tax-column ${window.taxesExpanded ? '' : 'hidden'}">${order.acquiring.toLocaleString('ru', {maximumFractionDigits:0})}</td>
            <td style="color: ${order.marginVal >= 0 ? '#00ff88' : '#ff4d4d'}; font-weight: bold;">
                ${order.marginDisplay}
            </td>
        `;
        accountingTableBody.appendChild(tr);
    });
}

if (accountingSearch) {
    accountingSearch.addEventListener('input', renderAccounting);
}

['orders-status-filter', 'orders-client-filter', 'orders-month-filter', 'orders-price-min', 'orders-price-max', 'orders-paid-min', 'orders-paid-max', 'orders-search'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
        el.addEventListener('input', renderOrders);
        el.addEventListener('change', renderOrders);
    }
});

['archived-status-filter', 'archived-client-filter', 'archived-month-filter', 'archived-price-min', 'archived-price-max', 'archived-paid-min', 'archived-paid-max', 'archived-search'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
        el.addEventListener('input', renderArchivedOrders);
        el.addEventListener('change', renderArchivedOrders);
    }
});

document.querySelectorAll('#orders-table th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
        const key = th.getAttribute('data-sort');
        if (ordersSort.key === key) {
            ordersSort.desc = !ordersSort.desc;
        } else {
            ordersSort.key = key;
            ordersSort.desc = true;
        }
        renderOrders();
    });
});

document.querySelectorAll('#archived-table th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
        const key = th.getAttribute('data-sort');
        if (archivedSort.key === key) {
            archivedSort.desc = !archivedSort.desc;
        } else {
            archivedSort.key = key;
            archivedSort.desc = true;
        }
        renderArchivedOrders();
    });
});

document.querySelectorAll('#accounting-table th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
        const key = th.getAttribute('data-sort');
        if (accountingSort.key === key) {
            accountingSort.desc = !accountingSort.desc;
        } else {
            accountingSort.key = key;
            accountingSort.desc = true;
        }
        renderAccounting();
    });
});

// Modals
function openModal(modal) {
    modalOverlay.classList.remove('hidden');
    modal.classList.remove('hidden');
}

function closeModals() {
    modalOverlay.classList.add('hidden');
    document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
}

createClientBtn.addEventListener('click', () => openModal(createClientModal));
createOrderBtn.addEventListener('click', () => {
    openModal(createOrderModal);
    const dateInput = document.getElementById('order-date');
    if (dateInput && !dateInput.value) {
        const now = new Date();
        const yyyy = now.getFullYear();
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const dd = String(now.getDate()).padStart(2, '0');
        dateInput.value = `${yyyy}-${mm}-${dd}`;
    }
});
closeBtns.forEach(btn => btn.addEventListener('click', closeModals));

// Photo Viewer
window.viewPhoto = async function(photoId) {
    openModal(photoViewerModal);
    const imgEl = document.getElementById('photo-viewer-image');
    const loadingEl = document.getElementById('photo-loading');
    
    imgEl.classList.add('hidden');
    imgEl.src = '';
    loadingEl.classList.remove('hidden');
    loadingEl.textContent = 'Загрузка...';

    try {
        const res = await fetch(`${API_BASE}/photos/${photoId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        if (!res.ok) throw new Error('Не удалось загрузить фото');
        
        const blob = await res.blob();
        imgEl.src = URL.createObjectURL(blob);
        imgEl.classList.remove('hidden');
        loadingEl.classList.add('hidden');
    } catch (err) {
        loadingEl.textContent = 'Ошибка загрузки: ' + err.message;
    }
};

// Archive / Unarchive
window.archiveOrder = async function(orderId) {
    try {
        await fetchAPI(`/orders/${orderId}/archive`, { method: 'POST' });
        loadDashboardData();
    } catch (err) {
        alert(err.message);
    }
};

window.unarchiveOrder = async function(orderId) {
    try {
        await fetchAPI(`/orders/${orderId}/unarchive`, { method: 'POST' });
        loadDashboardData();
    } catch (err) {
        alert(err.message);
    }
};

// Delete with confirmation
window.confirmDelete = function(orderId) {
    deleteTargetId = orderId;
    document.getElementById('delete-order-id-display').textContent = orderId;
    openModal(confirmDeleteModal);
};

document.getElementById('confirm-delete-btn').addEventListener('click', async () => {
    if (!deleteTargetId) return;
    try {
        await fetchAPI(`/orders/${deleteTargetId}`, { method: 'DELETE' });
        deleteTargetId = null;
        closeModals();
        loadDashboardData();
    } catch (err) {
        alert(err.message);
    }
});

// Edit Order
window.openEditModal = function(orderId) {
    const order = allOrders.find(o => o.id === orderId);
    if (!order) return;
    
    document.getElementById('edit-order-id-display').textContent = order.id;
    document.getElementById('edit-order-id').value = order.id;
    document.getElementById('edit-order-items').value = order.items;
    document.getElementById('edit-order-price').value = order.total_price;
    document.getElementById('edit-order-paid').value = order.paid_amount;
    document.getElementById('edit-order-status').value = order.status;
    document.getElementById('edit-order-photo-id').value = order.photo_id || '';
    
    document.getElementById('edit-order-date').value = order.order_date || '';
    document.getElementById('edit-order-cost-price').value = order.cost_price || 0;
    document.getElementById('edit-order-delivery-cost').value = order.delivery_cost || 0;
    
    openModal(editOrderModal);
};

editOrderForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const orderId = document.getElementById('edit-order-id').value;
    const payload = {
        items: document.getElementById('edit-order-items').value,
        total_price: parseInt(document.getElementById('edit-order-price').value),
        paid_amount: parseInt(document.getElementById('edit-order-paid').value),
        status: document.getElementById('edit-order-status').value,
        photo_id: document.getElementById('edit-order-photo-id').value,
        order_date: document.getElementById('edit-order-date').value,
        cost_price: parseInt(document.getElementById('edit-order-cost-price').value) || 0,
        delivery_cost: parseInt(document.getElementById('edit-order-delivery-cost').value) || 0
    };
    
    try {
        await fetchAPI(`/orders/${orderId}`, {
            method: 'PUT',
            body: JSON.stringify(payload)
        });
        closeModals();
        loadDashboardData();
    } catch (err) {
        alert(err.message);
    }
});

// Create Client
createClientForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const pwd = document.getElementById('new-client-password').value;
    try {
        await fetchAPI('/clients', {
            method: 'POST',
            body: JSON.stringify({ password: pwd })
        });
        closeModals();
        createClientForm.reset();
        loadDashboardData();
    } catch (err) {
        alert(err.message);
    }
});

// Create Order
createOrderForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
        client_id: parseInt(document.getElementById('order-client-id').value),
        items: document.getElementById('order-items').value,
        total_price: parseInt(document.getElementById('order-price').value),
        paid_amount: parseInt(document.getElementById('order-paid').value),
        photo_id: document.getElementById('order-photo-id').value,
        order_date: document.getElementById('order-date').value,
        cost_price: 0,
        delivery_cost: 0
    };
    
    try {
        await fetchAPI('/orders', {
            method: 'POST',
            body: JSON.stringify(payload)
        });
        closeModals();
        createOrderForm.reset();
        loadDashboardData();
        document.querySelector('[data-tab="orders"]').click();
    } catch (err) {
        alert(err.message);
    }
});

// Photo Upload Logic
async function handlePhotoUpload(e, targetInputId) {
    const file = e.target.files[0];
    if (!file) return;
    
    const label = e.target.previousElementSibling;
    const originalText = label.textContent;
    label.textContent = 'Загрузка...';
    
    const formData = new FormData();
    formData.append('file', file);
    
    try {
        const res = await fetch(`${API_BASE}/upload_photo`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`
            },
            body: formData
        });
        
        if (!res.ok) {
            const data = await res.json();
            throw new Error(data.detail || 'Ошибка загрузки');
        }
        
        const data = await res.json();
        document.getElementById(targetInputId).value = data.photo_id;
        label.textContent = 'Загружено ✓';
        setTimeout(() => label.textContent = originalText, 2000);
    } catch (err) {
        alert(err.message);
        label.textContent = 'Ошибка ✕';
        setTimeout(() => label.textContent = originalText, 2000);
    }
    
    e.target.value = ''; // Reset input
}

const orderPhotoUpload = document.getElementById('order-photo-upload');
if (orderPhotoUpload) orderPhotoUpload.addEventListener('change', (e) => handlePhotoUpload(e, 'order-photo-id'));

const editOrderPhotoUpload = document.getElementById('edit-order-photo-upload');
if (editOrderPhotoUpload) editOrderPhotoUpload.addEventListener('change', (e) => handlePhotoUpload(e, 'edit-order-photo-id'));

init();

// ====== NEW UI LOGIC ======
// Dropdowns
document.querySelectorAll('.multi-select-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const content = btn.nextElementSibling;
        content.classList.toggle('hidden');
    });
});

// Close dropdowns when clicking outside
document.addEventListener('click', (e) => {
    if (!e.target.closest('.multi-select-dropdown')) {
        document.querySelectorAll('.multi-select-content').forEach(content => {
            content.classList.add('hidden');
        });
    }
});

// Re-render when checkboxes in multi-select change
document.querySelectorAll('.multi-select-content input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
        const btn = cb.closest('.multi-select-dropdown').querySelector('.multi-select-btn');
        const checked = Array.from(cb.closest('.multi-select-content').querySelectorAll('input[type="checkbox"]:checked')).map(c => c.value);
        if (checked.length === 0) {
            btn.textContent = 'Все статусы';
        } else if (checked.length === 1) {
            btn.textContent = checked[0];
        } else {
            btn.textContent = `Выбрано: ${checked.length}`;
        }
        
        if (cb.closest('#orders-status-dropdown')) {
            renderOrders();
        } else if (cb.closest('#archived-status-dropdown')) {
            renderArchivedOrders();
        }
    });
});

// Select all logic
document.getElementById('orders-select-all')?.addEventListener('change', (e) => {
    document.querySelectorAll('.order-row-checkbox').forEach(cb => cb.checked = e.target.checked);
    updateMassEditPanel('orders');
});

document.getElementById('archived-select-all')?.addEventListener('change', (e) => {
    document.querySelectorAll('.archived-row-checkbox').forEach(cb => cb.checked = e.target.checked);
    updateMassEditPanel('archived');
});

window.updateMassEditPanel = function(tab) {
    let checkboxes = document.querySelectorAll(`.${tab}-row-checkbox:checked`);
    let panel = document.getElementById(`${tab}-mass-edit-panel`);
    let countSpan = document.getElementById(`${tab}-mass-edit-count`);
    
    if (!panel) return;
    
    if (checkboxes.length > 0) {
        panel.classList.remove('hidden');
        if (countSpan) countSpan.textContent = `Выбрано заказов: ${checkboxes.length}`;
    } else {
        panel.classList.add('hidden');
    }
};

// Mass edit API calls
['orders', 'archived'].forEach(tab => {
    const btn = document.getElementById(`${tab}-mass-edit-btn`);
    if (!btn) return;
    
    btn.addEventListener('click', async (e) => {
        const checkboxes = document.querySelectorAll(`.${tab}-row-checkbox:checked`);
        const select = document.getElementById(`${tab}-mass-edit-status`);
        const newStatus = select ? select.value : null;
        if (!newStatus) {
            alert('Выберите новый статус!');
            return;
        }
        
        const orderIds = Array.from(checkboxes).map(cb => parseInt(cb.value));
        if (orderIds.length === 0) return;
        
        btn.textContent = 'Загрузка...';
        btn.disabled = true;
        
        try {
            await Promise.all(orderIds.map(async id => {
                const order = allOrders.find(o => o.id === id);
                if (!order) return;
                const payload = {
                    client_id: order.client_id,
                    items: order.items,
                    total_price: order.total_price,
                    paid_amount: order.paid_amount,
                    status: newStatus,
                    photo_id: order.photo_id,
                    order_date: order.order_date,
                    cost_price: order.cost_price,
                    delivery_cost: order.delivery_cost
                };
                await fetchAPI(`/orders/${id}`, {
                    method: 'PUT',
                    body: JSON.stringify(payload)
                });
            }));
            
            // Clear selection
            const selectAll = document.getElementById(`${tab}-select-all`);
            if (selectAll) selectAll.checked = false;
            
            await loadDashboardData();
        } catch (err) {
            alert('Ошибка при массовом редактировании: ' + err.message);
        } finally {
            btn.textContent = 'Изменить статус';
            btn.disabled = false;
        }
    });
});

// Listeners for year filters
document.getElementById('orders-year-filter')?.addEventListener('change', renderOrders);
document.getElementById('archived-year-filter')?.addEventListener('change', renderArchivedOrders);
