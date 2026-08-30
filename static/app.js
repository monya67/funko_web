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

// Forms
const createClientForm = document.getElementById('create-client-form');
const createOrderForm = document.getElementById('create-order-form');
const editOrderForm = document.getElementById('edit-order-form');

// State
let token = localStorage.getItem('funko_token');
let currentRole = null;
let allOrders = [];
let rawActiveOrders = [];
let rawArchivedOrders = [];
let ordersSort = { key: 'id', desc: true };
let archivedSort = { key: 'id', desc: true };
let accountingSort = { key: 'id', desc: true };
let deleteTargetId = null;

// Global toggles
window.marginMode = 'rub';
window.taxesExpanded = false;

// Init
function init() {
    if (token) showDashboard();
    else showLogin();
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
    document.querySelectorAll('.admin-only').forEach(el => {
        role === 'admin' ? el.classList.remove('hidden') : el.classList.add('hidden');
    });
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
            if (data && data.online_count) updateOnlineBadge(data.online_count);
        } catch (e) {}
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
    if (!res.ok) throw new Error(data.detail || 'Ошибка');
    return data;
}

// Populate year filters from order data
function populateYearFilters(orders, archived) {
    const years = new Set();
    [...orders, ...archived].forEach(o => {
        if (o.order_date) {
            const d = formatDisplayDate(o.order_date);
            if (d.includes('.')) {
                const y = d.split('.')[2];
                if (y && y.length === 4) years.add(y);
            }
        }
    });
    const sortedYears = Array.from(years).sort().reverse();
    ['orders-year-filter', 'archived-year-filter', 'accounting-year-filter'].forEach(id => {
        const sel = document.getElementById(id);
        if (!sel) return;
        const currentVal = sel.value;
        sel.innerHTML = '<option value="">Год</option>';
        sortedYears.forEach(y => {
            const opt = document.createElement('option');
            opt.value = y;
            opt.textContent = y;
            sel.appendChild(opt);
        });
        if (currentVal) sel.value = currentVal;
    });
}

async function loadDashboardData() {
    try {
        const data = await fetchAPI('/dashboard');
        updateRoleUI(data.role);
        if (data.online_count) updateOnlineBadge(data.online_count);
        rawActiveOrders = data.orders || [];
        rawArchivedOrders = data.archived || [];
        allOrders = [...rawActiveOrders, ...rawArchivedOrders];
        populateYearFilters(rawActiveOrders, rawArchivedOrders);
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
    if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
        const parts = dateStr.split(' ')[0].split('-');
        return `${parts[2]}.${parts[1]}.${parts[0]}`;
    }
    if (/^\d{2}\.\d{2}\.\d{4}/.test(dateStr)) {
        return dateStr.split(' ')[0];
    }
    return dateStr;
}

function filterByDate(orders, yearId, monthId) {
    const yearVal = document.getElementById(yearId)?.value;
    const monthVal = document.getElementById(monthId)?.value;
    if (!yearVal && !monthVal) return orders;
    return orders.filter(o => {
        if (!o.order_date) return false;
        const formatted = formatDisplayDate(o.order_date);
        if (!formatted.includes('.')) return false;
        const parts = formatted.split('.');
        const matchYear = !yearVal || parts[2] === yearVal;
        const matchMonth = !monthVal || parts[1] === monthVal;
        return matchYear && matchMonth;
    });
}

// Status filter from multi-select checkboxes
function getSelectedStatuses(menuId) {
    const menu = document.getElementById(menuId);
    if (!menu) return [];
    return Array.from(menu.querySelectorAll('input[type=checkbox]:checked')).map(cb => cb.value);
}

function updateStatusBtn(btnId, selectedStatuses) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    if (selectedStatuses.length === 0) {
        btn.firstChild.nodeValue = 'Все статусы ';
    } else if (selectedStatuses.length === 1) {
        const short = selectedStatuses[0].length > 20 ? selectedStatuses[0].substring(0, 20) + '…' : selectedStatuses[0];
        btn.firstChild.nodeValue = short + ' ';
    } else {
        btn.firstChild.nodeValue = `Выбрано: ${selectedStatuses.length} `;
    }
}

function makePhotoCell(photoId) {
    if (photoId) {
        return `<td><img src="/api/photos/${photoId}" style="width:48px;height:48px;object-fit:cover;border-radius:5px;cursor:pointer;transition:transform 0.2s;" onclick="viewPhoto('${photoId}')" onmouseover="this.style.transform='scale(1.15)'" onmouseout="this.style.transform='scale(1)'"></td>`;
    }
    return `<td style="color:var(--gray-light);">—</td>`;
}

const ALL_STATUSES_LIST = [
    'Заказ принят в обработку',
    'Заказ ожидает отправки из магазина',
    'Заказ едет на склад США',
    'Заказ начал сортировку на складе США',
    'Заказ отправлен из США на наш склад в Россию',
    'Ожидает выхода в продажу',
    'Заказ проходит таможенное оформление',
    'Заказ прибыл в магазин и готов к выдаче',
    'Выдано'
];

function makeInlineStatusCell(order) {
    const opts = ALL_STATUSES_LIST.map(s =>
        `<option value="${s}" ${order.status === s ? 'selected' : ''}>${s}</option>`
    ).join('');
    return `<td>
        <div class="inline-status-form">
            <select class="inline-status-select" data-order-id="${order.id}" onchange="onInlineStatusChange(this)">
                ${opts}
            </select>
            <button class="inline-save-btn" id="save-btn-${order.id}" onclick="saveInlineStatus(${order.id})">&#10003; Сохранить</button>
        </div>
    </td>`;
}

window.onInlineStatusChange = function(sel) {
    const orderId = sel.getAttribute('data-order-id');
    const btn = document.getElementById(`save-btn-${orderId}`);
    if (btn) btn.classList.add('show');
};

window.saveInlineStatus = async function(orderId) {
    const sel = document.querySelector(`.inline-status-select[data-order-id="${orderId}"]`);
    const btn = document.getElementById(`save-btn-${orderId}`);
    if (!sel) return;
    const newStatus = sel.value;
    const order = allOrders.find(o => o.id === orderId);
    if (!order) return;
    const payload = {
        items: order.items,
        total_price: order.total_price,
        paid_amount: order.paid_amount,
        status: newStatus,
        photo_id: order.photo_id,
        order_date: order.order_date,
        cost_price: order.cost_price,
        delivery_cost: order.delivery_cost
    };
    if (btn) { btn.textContent = '...'; btn.disabled = true; }
    try {
        await fetchAPI(`/orders/${orderId}`, { method: 'PUT', body: JSON.stringify(payload) });
        await loadDashboardData();
    } catch (err) {
        alert('Ошибка: ' + err.message);
        if (btn) { btn.textContent = '\u2713 Сохранить'; btn.disabled = false; }
    }
};

// Sort helper
function sortOrders(orders, sortState) {
    return [...orders].sort((a, b) => {
        let valA, valB;
        const k = sortState.key;
        if (k === 'id') { valA = a.id; valB = b.id; }
        else if (k === 'date') { valA = a.order_date || ''; valB = b.order_date || ''; }
        else if (k === 'client') { valA = a.client_id || 0; valB = b.client_id || 0; }
        else if (k === 'price') { valA = a.total_price; valB = b.total_price; }
        else if (k === 'paid') { valA = a.paid_amount || 0; valB = b.paid_amount || 0; }
        else if (k === 'status') { valA = a.status || ''; valB = b.status || ''; }
        else { valA = a.id; valB = b.id; }
        if (valA < valB) return sortState.desc ? 1 : -1;
        if (valA > valB) return sortState.desc ? -1 : 1;
        return 0;
    });
}

// Render active orders
function renderOrders() {
    ordersTableBody.innerHTML = '';
    const emptyMsg = document.getElementById('no-orders');
    const role = currentRole;

    let orders = [...rawActiveOrders];
    orders = filterByDate(orders, 'orders-year-filter', 'orders-month-filter');

    const selectedStatuses = getSelectedStatuses('orders-status-menu');
    if (selectedStatuses.length > 0) {
        orders = orders.filter(o => selectedStatuses.includes(o.status));
    }

    const clientVal = parseInt(document.getElementById('orders-client-filter')?.value);
    if (!isNaN(clientVal)) orders = orders.filter(o => o.client_id === clientVal);

    const q = document.getElementById('orders-search')?.value.toLowerCase().trim();
    if (q) {
        orders = orders.filter(o =>
            o.id.toString().includes(q) ||
            (o.client_id && o.client_id.toString().includes(q)) ||
            o.items.toLowerCase().includes(q)
        );
    }

    orders = sortOrders(orders, ordersSort);

    if (orders.length === 0) { emptyMsg.classList.remove('hidden'); return; }
    emptyMsg.classList.add('hidden');

    orders.forEach((order, i) => {
        const tr = document.createElement('tr');
        tr.className = 'row-animate';
        tr.style.animationDelay = `${i * 0.04}s`;

        let html = '';
        if (role === 'admin') {
            html += `<td><input type="checkbox" class="order-row-checkbox" value="${order.id}" style="cursor:pointer;" onchange="updateMassEditPanel('orders')"></td>`;
        }
        html += `<td>${order.id}</td>`;
        html += `<td style="white-space:nowrap;font-size:0.85rem;color:var(--gray-light);">${formatDisplayDate(order.order_date)}</td>`;
        if (role === 'admin') html += `<td class="admin-only">${order.client_id}</td>`;
        html += makePhotoCell(order.photo_id);
        html += `<td>${order.items.replace(/\n/g, '<br>')}</td>`;
        html += `<td>${order.total_price.toLocaleString('ru')}</td>`;
        html += `<td>${(order.paid_amount || 0).toLocaleString('ru')}</td>`;

        if (role === 'admin') {
            html += makeInlineStatusCell(order);
            html += `<td class="admin-only actions-cell">
                <button class="edit-btn" onclick="openEditModal(${order.id})">Ред.</button>
                <button class="archive-btn" onclick="archiveOrder(${order.id})">Архив</button>
                <button class="delete-btn" onclick="confirmDelete(${order.id})">Удалить</button>
            </td>`;
        } else {
            html += `<td><span class="status-badge">${order.status}</span></td>`;
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

    orders = filterByDate(orders, 'archived-year-filter', 'archived-month-filter');

    const clientVal = parseInt(document.getElementById('archived-client-filter')?.value);
    if (!isNaN(clientVal)) orders = orders.filter(o => o.client_id === clientVal);

    const q = document.getElementById('archived-search')?.value.toLowerCase().trim();
    if (q) {
        orders = orders.filter(o =>
            o.id.toString().includes(q) ||
            (o.client_id && o.client_id.toString().includes(q)) ||
            o.items.toLowerCase().includes(q)
        );
    }

    orders = sortOrders(orders, archivedSort);

    if (orders.length === 0) { emptyMsg.classList.remove('hidden'); return; }
    emptyMsg.classList.add('hidden');

    orders.forEach((order, i) => {
        const tr = document.createElement('tr');
        tr.className = 'row-animate';
        tr.style.animationDelay = `${i * 0.04}s`;

        let html = '';
        if (role === 'admin') {
            html += `<td><input type="checkbox" class="archived-row-checkbox" value="${order.id}" style="cursor:pointer;" onchange="updateMassEditPanel('archived')"></td>`;
        }
        html += `<td>${order.id}</td>`;
        html += `<td style="white-space:nowrap;font-size:0.85rem;color:var(--gray-light);">${formatDisplayDate(order.order_date)}</td>`;
        if (role === 'admin') html += `<td class="admin-only">${order.client_id}</td>`;
        html += makePhotoCell(order.photo_id);
        html += `<td>${order.items.replace(/\n/g, '<br>')}</td>`;
        html += `<td>${order.total_price.toLocaleString('ru')}</td>`;
        html += `<td>${(order.paid_amount || 0).toLocaleString('ru')}</td>`;
        html += `<td><span class="status-badge">${order.status}</span></td>`;

        if (role === 'admin') {
            html += `<td class="admin-only actions-cell">
                <button class="edit-btn" onclick="unarchiveOrder(${order.id})">Восстановить</button>
                <button class="delete-btn" onclick="confirmDelete(${order.id})">Удалить</button>
            </td>`;
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
        tr.innerHTML = `<td>${client.id}</td><td>${client.password}</td><td>${client.user_tg_id || '—'}</td>`;
        clientsTableBody.appendChild(tr);
    });
}

// Accounting
window.toggleMarginMode = function() {
    window.marginMode = window.marginMode === 'rub' ? 'percent' : 'rub';
    const ind = document.getElementById('margin-mode-indicator');
    if (ind) ind.textContent = window.marginMode === 'rub' ? '\u20BD' : '%';
    renderAccounting();
};

window.toggleTaxes = function(e) {
    if (e) e.stopPropagation();
    window.taxesExpanded = !window.taxesExpanded;
    const icon = document.getElementById('taxes-toggle-icon');
    if (icon) icon.textContent = window.taxesExpanded ? '[-]' : '[+]';
    document.querySelectorAll('.tax-column').forEach(el => {
        window.taxesExpanded ? el.classList.remove('hidden') : el.classList.add('hidden');
    });
};

function renderAccounting() {
    if (!accountingTableBody) return;
    accountingTableBody.innerHTML = '';
    const emptyMsg = document.getElementById('no-accounting');

    let orders = [...allOrders];
    orders = filterByDate(orders, 'accounting-year-filter', 'accounting-month-filter');

    const accountingSearch = document.getElementById('accounting-search');
    if (accountingSearch && accountingSearch.value) {
        const q = accountingSearch.value.toLowerCase();
        orders = orders.filter(o => o.id.toString().includes(q) || o.items.toLowerCase().includes(q));
    }

    if (orders.length === 0) { emptyMsg.classList.remove('hidden'); return; }
    emptyMsg.classList.add('hidden');

    const processed = orders.map(o => {
        const cost = o.cost_price || 0;
        const delivery = o.delivery_cost || 0;
        const price = o.total_price || 0;
        const usn = price * 0.06;
        const checks = price * 0.015;
        const acquiring = price * 0.02;
        const totalTax = usn + checks + acquiring;
        let marginVal = price - cost - delivery - totalTax;
        let marginDisplay = '';
        if (window.marginMode === 'percent') {
            const pct = price > 0 ? (marginVal / price) * 100 : 0;
            marginDisplay = pct.toFixed(1) + '%';
            marginVal = pct;
        } else {
            marginDisplay = marginVal.toLocaleString('ru', {maximumFractionDigits: 0}) + ' \u20BD';
        }
        return { ...o, cost, delivery, usn, checks, acquiring, totalTax, marginVal, marginDisplay, price };
    });

    processed.sort((a, b) => {
        let valA, valB;
        const k = accountingSort.key;
        if (k === 'id') { valA = a.id; valB = b.id; }
        else if (k === 'date') { valA = a.order_date || ''; valB = b.order_date || ''; }
        else if (k === 'price') { valA = a.price; valB = b.price; }
        else if (k === 'cost') { valA = a.cost; valB = b.cost; }
        else if (k === 'delivery') { valA = a.delivery; valB = b.delivery; }
        else if (k === 'paid') { valA = a.paid_amount || 0; valB = b.paid_amount || 0; }
        else if (k === 'margin') { valA = a.marginVal; valB = b.marginVal; }
        else { valA = a.id; valB = b.id; }
        if (valA < valB) return accountingSort.desc ? 1 : -1;
        if (valA > valB) return accountingSort.desc ? -1 : 1;
        return 0;
    });

    processed.forEach((order, i) => {
        const tr = document.createElement('tr');
        tr.className = 'row-animate';
        tr.style.animationDelay = `${i * 0.04}s`;
        const photoHtml = order.photo_id
            ? `<img src="/api/photos/${order.photo_id}" style="width:44px;height:44px;object-fit:cover;border-radius:5px;cursor:pointer;flex-shrink:0;" onclick="viewPhoto('${order.photo_id}')">`
            : `<div style="width:44px;height:44px;border-radius:5px;background:#222;flex-shrink:0;"></div>`;

        tr.innerHTML = `
            <td>${order.id}</td>
            <td style="white-space:nowrap;">${formatDisplayDate(order.order_date)}</td>
            <td>
                <div style="display:flex;gap:8px;align-items:center;min-width:220px;">
                    ${photoHtml}
                    <div style="font-size:0.85rem;">${order.items.replace(/\n/g, '<br>')}</div>
                </div>
            </td>
            <td>${order.price.toLocaleString('ru')}</td>
            <td>${order.cost.toLocaleString('ru')}</td>
            <td>${order.delivery.toLocaleString('ru')}</td>
            <td>${(order.paid_amount || 0).toLocaleString('ru')}</td>
            <td style="color:#ff9999;font-weight:bold;">${order.totalTax.toLocaleString('ru', {maximumFractionDigits:0})}</td>
            <td class="tax-column ${window.taxesExpanded ? '' : 'hidden'}">${order.usn.toLocaleString('ru', {maximumFractionDigits:0})}</td>
            <td class="tax-column ${window.taxesExpanded ? '' : 'hidden'}">${order.checks.toLocaleString('ru', {maximumFractionDigits:0})}</td>
            <td class="tax-column ${window.taxesExpanded ? '' : 'hidden'}">${order.acquiring.toLocaleString('ru', {maximumFractionDigits:0})}</td>
            <td style="color:${order.marginVal >= 0 ? '#00ff88' : '#ff4d4d'};font-weight:bold;">${order.marginDisplay}</td>
        `;
        accountingTableBody.appendChild(tr);
    });
}

// Sort listeners
function bindSortListeners(tableId, sortState, renderFn) {
    document.querySelectorAll(`#${tableId} th[data-sort]`).forEach(th => {
        th.addEventListener('click', () => {
            const key = th.getAttribute('data-sort');
            if (sortState.key === key) sortState.desc = !sortState.desc;
            else { sortState.key = key; sortState.desc = true; }
            renderFn();
        });
    });
}
bindSortListeners('orders-table', ordersSort, renderOrders);
bindSortListeners('archived-table', archivedSort, renderArchivedOrders);
bindSortListeners('accounting-table', accountingSort, renderAccounting);

// Filter listeners
['orders-year-filter', 'orders-month-filter', 'orders-client-filter', 'orders-search'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.addEventListener('input', renderOrders); el.addEventListener('change', renderOrders); }
});
['archived-year-filter', 'archived-month-filter', 'archived-client-filter', 'archived-search'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.addEventListener('input', renderArchivedOrders); el.addEventListener('change', renderArchivedOrders); }
});
['accounting-year-filter', 'accounting-month-filter', 'accounting-search'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.addEventListener('input', renderAccounting); el.addEventListener('change', renderAccounting); }
});

// Multi-select dropdown
document.querySelectorAll('.filter-dropdown').forEach(dropdown => {
    const btn = dropdown.querySelector('.filter-dropdown-btn');
    const menu = dropdown.querySelector('.filter-dropdown-menu');
    if (!btn || !menu) return;

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = menu.classList.contains('open');
        document.querySelectorAll('.filter-dropdown-menu').forEach(m => m.classList.remove('open'));
        document.querySelectorAll('.filter-dropdown-btn').forEach(b => b.classList.remove('open'));
        if (!isOpen) {
            menu.classList.add('open');
            btn.classList.add('open');
        }
    });

    menu.querySelectorAll('input[type=checkbox]').forEach(cb => {
        cb.addEventListener('change', () => {
            const selected = getSelectedStatuses(menu.id);
            updateStatusBtn(btn.id, selected);
            renderOrders();
        });
    });

    const clearBtn = menu.querySelector('.filter-clear-all');
    if (clearBtn) {
        clearBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            menu.querySelectorAll('input[type=checkbox]').forEach(cb => cb.checked = false);
            updateStatusBtn(btn.id, []);
            renderOrders();
        });
    }
});

document.addEventListener('click', (e) => {
    if (!e.target.closest('.filter-dropdown')) {
        document.querySelectorAll('.filter-dropdown-menu').forEach(m => m.classList.remove('open'));
        document.querySelectorAll('.filter-dropdown-btn').forEach(b => b.classList.remove('open'));
    }
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
        dateInput.value = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    }
});
closeBtns.forEach(btn => btn.addEventListener('click', closeModals));

// Photo viewer
window.viewPhoto = async function(photoId) {
    openModal(photoViewerModal);
    const imgEl = document.getElementById('photo-viewer-image');
    const loadingEl = document.getElementById('photo-loading');
    imgEl.classList.add('hidden'); imgEl.src = '';
    loadingEl.classList.remove('hidden'); loadingEl.textContent = 'Загрузка...';
    try {
        const res = await fetch(`${API_BASE}/photos/${photoId}`, { headers: { 'Authorization': `Bearer ${token}` }});
        if (!res.ok) throw new Error('Не удалось загрузить фото');
        const blob = await res.blob();
        imgEl.src = URL.createObjectURL(blob);
        imgEl.classList.remove('hidden'); loadingEl.classList.add('hidden');
    } catch (err) {
        loadingEl.textContent = 'Ошибка загрузки: ' + err.message;
    }
};

// Archive / Unarchive
window.archiveOrder = async function(orderId) {
    try { await fetchAPI(`/orders/${orderId}/archive`, { method: 'POST' }); loadDashboardData(); }
    catch (err) { alert(err.message); }
};
window.unarchiveOrder = async function(orderId) {
    try { await fetchAPI(`/orders/${orderId}/unarchive`, { method: 'POST' }); loadDashboardData(); }
    catch (err) { alert(err.message); }
};

// Delete
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
    } catch (err) { alert(err.message); }
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
        await fetchAPI(`/orders/${orderId}`, { method: 'PUT', body: JSON.stringify(payload) });
        closeModals(); loadDashboardData();
    } catch (err) { alert(err.message); }
});

// Create Client
createClientForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const pwd = document.getElementById('new-client-password').value;
    try {
        await fetchAPI('/clients', { method: 'POST', body: JSON.stringify({ password: pwd }) });
        closeModals(); createClientForm.reset(); loadDashboardData();
    } catch (err) { alert(err.message); }
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
        await fetchAPI('/orders', { method: 'POST', body: JSON.stringify(payload) });
        closeModals(); createOrderForm.reset(); loadDashboardData();
        document.querySelector('[data-tab="orders"]').click();
    } catch (err) { alert(err.message); }
});

// Photo upload
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
            headers: { 'Authorization': `Bearer ${token}` },
            body: formData
        });
        if (!res.ok) { const d = await res.json(); throw new Error(d.detail || 'Ошибка загрузки'); }
        const data = await res.json();
        document.getElementById(targetInputId).value = data.photo_id;
        label.textContent = 'Загружено \u2713';
        setTimeout(() => label.textContent = originalText, 2000);
    } catch (err) {
        alert(err.message);
        label.textContent = 'Ошибка \u2715';
        setTimeout(() => label.textContent = originalText, 2000);
    }
    e.target.value = '';
}

const orderPhotoUpload = document.getElementById('order-photo-upload');
if (orderPhotoUpload) orderPhotoUpload.addEventListener('change', (e) => handlePhotoUpload(e, 'order-photo-id'));
const editOrderPhotoUpload = document.getElementById('edit-order-photo-upload');
if (editOrderPhotoUpload) editOrderPhotoUpload.addEventListener('change', (e) => handlePhotoUpload(e, 'edit-order-photo-id'));

// Mass edit
document.getElementById('orders-select-all')?.addEventListener('change', (e) => {
    document.querySelectorAll('.order-row-checkbox').forEach(cb => cb.checked = e.target.checked);
    updateMassEditPanel('orders');
});
document.getElementById('archived-select-all')?.addEventListener('change', (e) => {
    document.querySelectorAll('.archived-row-checkbox').forEach(cb => cb.checked = e.target.checked);
    updateMassEditPanel('archived');
});

window.updateMassEditPanel = function(tab) {
    const checkboxes = document.querySelectorAll(`.${tab}-row-checkbox:checked`);
    const panel = document.getElementById(`${tab}-mass-edit-panel`);
    const countSpan = document.getElementById(`${tab}-mass-edit-count`);
    if (!panel) return;
    if (checkboxes.length > 0) {
        panel.classList.add('visible');
        if (countSpan) countSpan.textContent = `Выбрано: ${checkboxes.length}`;
    } else {
        panel.classList.remove('visible');
    }
};

document.getElementById('orders-mass-cancel-btn')?.addEventListener('click', () => {
    document.querySelectorAll('.order-row-checkbox').forEach(cb => cb.checked = false);
    const selectAll = document.getElementById('orders-select-all');
    if (selectAll) selectAll.checked = false;
    updateMassEditPanel('orders');
});

document.getElementById('orders-mass-edit-btn')?.addEventListener('click', async () => {
    const checkboxes = document.querySelectorAll('.order-row-checkbox:checked');
    const select = document.getElementById('orders-mass-edit-status');
    const newStatus = select ? select.value : null;
    if (!newStatus) { alert('Выберите статус!'); return; }
    const orderIds = Array.from(checkboxes).map(cb => parseInt(cb.value));
    if (orderIds.length === 0) return;
    const btn = document.getElementById('orders-mass-edit-btn');
    btn.textContent = 'Загрузка...'; btn.disabled = true;
    try {
        await Promise.all(orderIds.map(async id => {
            const order = allOrders.find(o => o.id === id);
            if (!order) return;
            const payload = {
                items: order.items, total_price: order.total_price,
                paid_amount: order.paid_amount, status: newStatus,
                photo_id: order.photo_id, order_date: order.order_date,
                cost_price: order.cost_price, delivery_cost: order.delivery_cost
            };
            await fetchAPI(`/orders/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
        }));
        const selectAll = document.getElementById('orders-select-all');
        if (selectAll) selectAll.checked = false;
        await loadDashboardData();
    } catch (err) {
        alert('Ошибка при массовом редактировании: ' + err.message);
    } finally {
        btn.textContent = 'Применить'; btn.disabled = false;
    }
});

init();
