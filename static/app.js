const API_BASE = '/api';

// DOM Elements
const dashboardView = document.getElementById('dashboard-view');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const logoutBtn = document.getElementById('logout-btn');
const sidebarLoginBtn = document.getElementById('sidebar-login-btn');
const headerLoginBtn = document.getElementById('header-login-btn');
const headerLogoutBtn = document.getElementById('header-logout-btn');
const guestHeaderWidget = document.getElementById('guest-header-widget');
const userHeaderWidget = document.getElementById('user-header-widget');
const headerUserIcon = document.getElementById('header-user-icon');
const headerUserLabel = document.getElementById('header-user-label');

// Tabs
const navItems = document.querySelectorAll('.nav-item');
const tabContents = document.querySelectorAll('.tab-content');

// Modals
const modalOverlay = document.getElementById('modal-overlay');
const loginModal = document.getElementById('login-modal');
const orderInquiryModal = document.getElementById('order-inquiry-modal');
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
let currentRole = 'guest';
let currentClientId = null;
let allOrders = [];
let rawActiveOrders = [];
let rawArchivedOrders = [];
let ordersSort = { key: 'id', desc: true };
let archivedSort = { key: 'id', desc: true };
let accountingSort = { key: 'id', desc: true };
let deleteTargetId = null;

// Catalog State
let rawCatalogProducts = [];
let catalogMeta = { categories: [], series: [] };
let selectedCatalogCategory = '';
let catalogSort = { key: 'id', desc: true };
let catalogView = 'grid';
let deleteProductTargetId = null;

// Global toggles
window.marginMode = 'rub';
window.taxesExpanded = false;

// Global Mass Edit Functions (defined early so they are available immediately)
window.updateMassEditPanel = function(tab) {
    const checkboxes = document.querySelectorAll(`.${tab}-row-checkbox:checked`);
    const countSpan = document.getElementById(`${tab}-mass-edit-count`);
    const btn = document.getElementById(`${tab}-mass-edit-btn`);
    const count = checkboxes.length;
    
    if (countSpan) {
        countSpan.textContent = `Выбрано заказов: ${count} шт.`;
        countSpan.style.color = count > 0 ? '#00ff88' : '#fff';
    }
    if (btn) {
        if (count > 0) {
            btn.textContent = `Применить статус ко всем (${count})`;
            btn.style.opacity = '1';
        } else {
            btn.textContent = 'Применить статус';
            btn.style.opacity = '0.7';
        }
    }
};

window.clearMassSelection = function(tab) {
    document.querySelectorAll(`.${tab}-row-checkbox`).forEach(cb => cb.checked = false);
    const selectAll = document.getElementById(`${tab}-select-all`);
    if (selectAll) selectAll.checked = false;
    window.updateMassEditPanel(tab);
};

// 1-Click Fast Inline Status Save
window.saveInlineStatus = async function(orderId, newStatus) {
    const order = allOrders.find(o => o.id === orderId);
    if (!order) return;
    if (order.status === newStatus) return;

    const sel = document.querySelector(`.inline-status-select[data-order-id="${orderId}"]`);
    if (sel) {
        sel.classList.add('saving');
    }
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
    try {
        await fetchAPI(`/orders/${orderId}`, { method: 'PUT', body: JSON.stringify(payload) });
        if (sel) {
            sel.classList.remove('saving');
            sel.classList.add('saved');
            setTimeout(() => sel.classList.remove('saved'), 1500);
        }
        await loadDashboardData();
    } catch (err) {
        alert('Ошибка при смене статуса: ' + err.message);
        if (sel) {
            sel.classList.remove('saving');
            sel.value = order.status;
        }
    }
};

// Init
function init() {
    loadCatalogMeta();
    loadCatalog();

    if (token) {
        loadDashboardData().catch(() => {
            handleLogout();
        });
        startHeartbeat();
    } else {
        updateRoleUI('guest');
    }
}

function updateRoleUI(role) {
    currentRole = role;
    if (role === 'admin') {
        document.querySelectorAll('.admin-only').forEach(el => el.classList.remove('hidden'));
        document.querySelectorAll('.auth-only').forEach(el => el.classList.remove('hidden'));
        if (guestHeaderWidget) guestHeaderWidget.classList.add('hidden');
        if (userHeaderWidget) userHeaderWidget.classList.remove('hidden');
        if (headerUserIcon) headerUserIcon.textContent = '';
        if (headerUserLabel) headerUserLabel.textContent = 'Администратор';
        if (sidebarLoginBtn) sidebarLoginBtn.classList.add('hidden');
        if (logoutBtn) logoutBtn.classList.remove('hidden');
    } else if (role === 'client') {
        document.querySelectorAll('.admin-only').forEach(el => el.classList.add('hidden'));
        document.querySelectorAll('.auth-only').forEach(el => el.classList.remove('hidden'));
        if (guestHeaderWidget) guestHeaderWidget.classList.add('hidden');
        if (userHeaderWidget) userHeaderWidget.classList.remove('hidden');
        if (headerUserIcon) headerUserIcon.textContent = '';
        if (headerUserLabel) headerUserLabel.textContent = currentClientId ? `Клиент #${currentClientId}` : 'Личный кабинет';
        if (sidebarLoginBtn) sidebarLoginBtn.classList.add('hidden');
        if (logoutBtn) logoutBtn.classList.remove('hidden');
    } else {
        // Guest mode
        currentRole = 'guest';
        document.querySelectorAll('.admin-only').forEach(el => el.classList.add('hidden'));
        document.querySelectorAll('.auth-only').forEach(el => el.classList.add('hidden'));
        if (guestHeaderWidget) guestHeaderWidget.classList.remove('hidden');
        if (userHeaderWidget) userHeaderWidget.classList.add('hidden');
        if (sidebarLoginBtn) sidebarLoginBtn.classList.remove('hidden');
        if (logoutBtn) logoutBtn.classList.add('hidden');
    }
}

function handleLogout() {
    token = null;
    currentRole = 'guest';
    currentClientId = null;
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    localStorage.removeItem('funko_token');
    ordersTableBody.innerHTML = '';
    archivedTableBody.innerHTML = '';
    clientsTableBody.innerHTML = '';
    if (accountingTableBody) accountingTableBody.innerHTML = '';
    allOrders = [];
    rawActiveOrders = [];
    rawArchivedOrders = [];
    updateRoleUI('guest');
    window.switchTab('catalog');
    renderCatalog();
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

// Auth Modals & Listeners
window.openLoginModal = function() {
    if (loginError) loginError.textContent = '';
    if (loginForm) loginForm.reset();
    openModal(document.getElementById('login-modal'));
};

if (sidebarLoginBtn) sidebarLoginBtn.addEventListener('click', window.openLoginModal);
if (headerLoginBtn) headerLoginBtn.addEventListener('click', window.openLoginModal);
if (headerLogoutBtn) headerLogoutBtn.addEventListener('click', handleLogout);
if (logoutBtn) logoutBtn.addEventListener('click', handleLogout);

loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    loginError.textContent = '';
    const btn = loginForm.querySelector('button[type="submit"]');
    if (btn) btn.textContent = 'Вход...';
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
        closeModals();
        await loadDashboardData();
        startHeartbeat();
    } catch (err) {
        loginError.textContent = err.message;
    } finally {
        if (btn) btn.textContent = 'Войти';
    }
});

// Navigation between tabs
window.switchTab = function(tabName) {
    navItems.forEach(nav => {
        if (nav.getAttribute('data-tab') === tabName) nav.classList.add('active');
        else nav.classList.remove('active');
    });
    tabContents.forEach(tab => {
        if (tab.id === `${tabName}-tab`) {
            tab.classList.add('active');
        } else {
            tab.classList.remove('active');
        }
    });
    if (tabName === 'catalog') {
        loadCatalog();
        loadCatalogMeta();
    }
};

navItems.forEach(item => {
    item.addEventListener('click', (e) => {
        e.preventDefault();
        const tabName = item.getAttribute('data-tab');
        if (tabName) window.switchTab(tabName);
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
    const isPublicEndpoint = endpoint.startsWith('/catalog') || endpoint.startsWith('/photos');
    if (!token && !isPublicEndpoint) {
        handleLogout();
        throw new Error('Требуется авторизация');
    }
    const headers = {
        'Content-Type': 'application/json',
        'X-Device-ID': getDeviceId(),
        ...options.headers
    };
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    const res = await fetch(`${API_BASE}${endpoint}`, { ...options, headers });
    if ((res.status === 401 || res.status === 403) && !isPublicEndpoint) {
        handleLogout();
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
        if (data.role === 'client' && data.client_id) {
            currentClientId = data.client_id;
        }
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
            populateClientsDatalist(data.clients || []);
        }
        loadCatalog();
        loadCatalogMeta();
    } catch (err) {
        console.error('Ошибка загрузки данных личного кабинета:', err);
        handleLogout();
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
        btn.innerHTML = 'Все статусы <span class="arrow">&#9660;</span>';
    } else if (selectedStatuses.length === 1) {
        const short = selectedStatuses[0].length > 18 ? selectedStatuses[0].substring(0, 18) + '…' : selectedStatuses[0];
        btn.innerHTML = `${short} <span class="arrow">&#9660;</span>`;
    } else {
        btn.innerHTML = `Выбрано: ${selectedStatuses.length} <span class="arrow">&#9660;</span>`;
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
        `<option value="${s}" ${order.status === s ? 'selected' : ''}>${s}${s === 'Выдано' ? ' (→ в архив)' : ''}</option>`
    ).join('');
    return `<td>
        <select class="inline-status-select" data-order-id="${order.id}" onchange="window.saveInlineStatus(${order.id}, this.value)" title="Нажмите, чтобы мгновенно сменить статус">
            ${opts}
        </select>
    </td>`;
}

// Sort helper
function sortOrders(orders, sortState) {
    return [...orders].sort((a, b) => {
        let valA, valB;
        const k = sortState.key;
        if (k === 'id') { valA = a.id; valB = b.id; }
        else if (k === 'date') { valA = a.order_date || ''; valB = b.order_date || ''; }
        else if (k === 'client') { valA = a.client_id || 0; valB = b.client_id || 0; }
        else if (k === 'price') { 
            valA = a.total_price || 0; 
            valB = b.total_price || 0; 
            // When sorting by price ascending, put 0 at the end (Zeros Last)
            if (!sortState.desc) {
                if (valA === 0 && valB > 0) return 1;
                if (valB === 0 && valA > 0) return -1;
            }
        }
        else if (k === 'paid') { 
            valA = a.paid_amount || 0; 
            valB = b.paid_amount || 0; 
            if (!sortState.desc) {
                if (valA === 0 && valB > 0) return 1;
                if (valB === 0 && valA > 0) return -1;
            }
        }
        else if (k === 'status') { valA = a.status || ''; valB = b.status || ''; }
        else { valA = a.id; valB = b.id; }
        if (valA < valB) return sortState.desc ? 1 : -1;
        if (valA > valB) return sortState.desc ? -1 : 1;
        return 0;
    });
}

// Pagination State & Logic
const savedPageSize = parseInt(localStorage.getItem('funko_pageSize')) || 20;
window.paginationState = {
    orders: { page: 1, pageSize: savedPageSize },
    archived: { page: 1, pageSize: savedPageSize },
    accounting: { page: 1, pageSize: savedPageSize },
    catalog: { page: 1, pageSize: 24 }
};

window.setPageSize = function(tab, size) {
    const s = parseInt(size) || 20;
    if (window.paginationState[tab]) {
        window.paginationState[tab].pageSize = s;
        window.paginationState[tab].page = 1;
    }
    if (tab !== 'catalog') {
        localStorage.setItem('funko_pageSize', s);
        // Sync order tabs
        ['orders', 'archived', 'accounting'].forEach(t => {
            window.paginationState[t].pageSize = s;
        });
    }
    
    if (tab === 'orders') renderOrders();
    else if (tab === 'archived') renderArchivedOrders();
    else if (tab === 'accounting') renderAccounting();
    else if (tab === 'catalog') renderCatalog();
};

window.setCustomPageSize = function(tab, val) {
    const s = parseInt(val);
    if (!s || s < 1) return;
    window.setPageSize(tab, s);
};

window.changePage = function(tab, delta) {
    if (window.paginationState[tab]) {
        window.paginationState[tab].page += delta;
    }
    if (tab === 'orders') renderOrders();
    else if (tab === 'archived') renderArchivedOrders();
    else if (tab === 'accounting') renderAccounting();
    else if (tab === 'catalog') renderCatalog();
};

function updatePaginationUI(tab, totalCount) {
    const state = window.paginationState[tab];
    const totalPages = Math.max(1, Math.ceil(totalCount / state.pageSize));
    if (state.page > totalPages) state.page = totalPages;
    if (state.page < 1) state.page = 1;

    const bar = document.getElementById(`${tab}-pagination`);
    if (!bar) return;
    
    if (totalCount === 0) {
        bar.style.display = 'none';
        return;
    }
    bar.style.display = 'flex';

    const startIdx = (state.page - 1) * state.pageSize;
    const endIdx = Math.min(startIdx + state.pageSize, totalCount);

    const rangeEl = document.getElementById(`${tab}-page-range`);
    const totalEl = document.getElementById(`${tab}-total-count`);
    const indicatorEl = document.getElementById(`${tab}-page-indicator`);
    const prevBtn = document.getElementById(`${tab}-prev-btn`);
    const nextBtn = document.getElementById(`${tab}-next-btn`);

    if (rangeEl) rangeEl.textContent = `${startIdx + 1}–${endIdx}`;
    if (totalEl) totalEl.textContent = totalCount;
    if (indicatorEl) indicatorEl.textContent = `Стр. ${state.page} из ${totalPages}`;

    if (prevBtn) prevBtn.disabled = (state.page <= 1);
    if (nextBtn) nextBtn.disabled = (state.page >= totalPages);

    const sizeBtns = document.querySelectorAll(`#${tab}-page-sizes .btn-size`);
    sizeBtns.forEach(btn => {
        const sz = parseInt(btn.getAttribute('data-size'));
        if (sz === state.pageSize) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });

    const customInput = document.getElementById(`${tab}-custom-size`);
    if (customInput) {
        if (![10, 20, 50, 100].includes(state.pageSize)) {
            customInput.value = state.pageSize;
        } else {
            customInput.value = '';
        }
    }
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

    const priceMin = parseFloat(document.getElementById('orders-price-min')?.value);
    if (!isNaN(priceMin)) orders = orders.filter(o => (o.total_price || 0) >= priceMin);
    const priceMax = parseFloat(document.getElementById('orders-price-max')?.value);
    if (!isNaN(priceMax)) orders = orders.filter(o => (o.total_price || 0) <= priceMax);
    const paidMin = parseFloat(document.getElementById('orders-paid-min')?.value);
    if (!isNaN(paidMin)) orders = orders.filter(o => (o.paid_amount || 0) >= paidMin);
    const paidMax = parseFloat(document.getElementById('orders-paid-max')?.value);
    if (!isNaN(paidMax)) orders = orders.filter(o => (o.paid_amount || 0) <= paidMax);

    const q = document.getElementById('orders-search')?.value.toLowerCase().trim();
    if (q) {
        orders = orders.filter(o =>
            o.id.toString().includes(q) ||
            (o.client_id && o.client_id.toString().includes(q)) ||
            (o.items && o.items.toLowerCase().includes(q))
        );
    }

    orders = sortOrders(orders, ordersSort);

    if (orders.length === 0) { 
        emptyMsg.classList.remove('hidden'); 
        updatePaginationUI('orders', 0);
        return; 
    }
    emptyMsg.classList.add('hidden');

    const state = window.paginationState.orders;
    const totalPages = Math.max(1, Math.ceil(orders.length / state.pageSize));
    if (state.page > totalPages) state.page = totalPages;
    if (state.page < 1) state.page = 1;

    const startIdx = (state.page - 1) * state.pageSize;
    const pageOrders = orders.slice(startIdx, startIdx + state.pageSize);

    pageOrders.forEach((order, i) => {
        const tr = document.createElement('tr');
        tr.className = 'row-animate';
        tr.style.animationDelay = `${i * 0.02}s`;

        let html = '';
        if (role === 'admin') {
            html += `<td style="text-align:center;"><input type="checkbox" class="orders-row-checkbox" value="${order.id}" onchange="window.updateMassEditPanel('orders')"></td>`;
        }
        html += `<td style="text-align:center;color:var(--gray-light);font-size:0.85rem;font-weight:600;">${startIdx + i + 1}</td>`;
        html += `<td>${order.id}</td>`;
        html += `<td style="white-space:nowrap;font-size:0.85rem;color:var(--gray-light);">${formatDisplayDate(order.order_date)}</td>`;
        if (role === 'admin') html += `<td class="admin-only">${order.client_id}</td>`;
        html += makePhotoCell(order.photo_id);
        html += `<td>${order.items.replace(/\n/g, '<br>')}</td>`;
        html += `<td style="white-space:nowrap;font-weight:500;">${(order.total_price || 0).toLocaleString('ru')} &#8381;</td>`;
        html += `<td style="white-space:nowrap;">${(order.paid_amount || 0).toLocaleString('ru')} &#8381;</td>`;

        if (role === 'admin') {
            html += makeInlineStatusCell(order);
            html += `<td class="admin-only actions-cell">
                <button class="edit-btn" onclick="openEditModal(${order.id})" title="Полное редактирование">Ред.</button>
                <button class="archive-btn" onclick="archiveOrder(${order.id})" title="Перенести в архив">Архив</button>
                <button class="delete-btn" onclick="confirmDelete(${order.id})" title="Удалить заказ">&#10005;</button>
            </td>`;
        } else {
            html += `<td><span class="status-badge">${order.status}</span></td>`;
        }

        tr.innerHTML = html;
        ordersTableBody.appendChild(tr);
    });

    updatePaginationUI('orders', orders.length);
    window.updateMassEditPanel('orders');
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

    const priceMin = parseFloat(document.getElementById('archived-price-min')?.value);
    if (!isNaN(priceMin)) orders = orders.filter(o => (o.total_price || 0) >= priceMin);
    const priceMax = parseFloat(document.getElementById('archived-price-max')?.value);
    if (!isNaN(priceMax)) orders = orders.filter(o => (o.total_price || 0) <= priceMax);
    const paidMin = parseFloat(document.getElementById('archived-paid-min')?.value);
    if (!isNaN(paidMin)) orders = orders.filter(o => (o.paid_amount || 0) >= paidMin);
    const paidMax = parseFloat(document.getElementById('archived-paid-max')?.value);
    if (!isNaN(paidMax)) orders = orders.filter(o => (o.paid_amount || 0) <= paidMax);

    const q = document.getElementById('archived-search')?.value.toLowerCase().trim();
    if (q) {
        orders = orders.filter(o =>
            o.id.toString().includes(q) ||
            (o.client_id && o.client_id.toString().includes(q)) ||
            (o.items && o.items.toLowerCase().includes(q))
        );
    }

    orders = sortOrders(orders, archivedSort);

    if (orders.length === 0) { 
        emptyMsg.classList.remove('hidden'); 
        updatePaginationUI('archived', 0);
        return; 
    }
    emptyMsg.classList.add('hidden');

    const state = window.paginationState.archived;
    const totalPages = Math.max(1, Math.ceil(orders.length / state.pageSize));
    if (state.page > totalPages) state.page = totalPages;
    if (state.page < 1) state.page = 1;

    const startIdx = (state.page - 1) * state.pageSize;
    const pageOrders = orders.slice(startIdx, startIdx + state.pageSize);

    pageOrders.forEach((order, i) => {
        const tr = document.createElement('tr');
        tr.className = 'row-animate';
        tr.style.animationDelay = `${i * 0.02}s`;

        let html = '';
        if (role === 'admin') {
            html += `<td style="text-align:center;"><input type="checkbox" class="archived-row-checkbox" value="${order.id}" onchange="window.updateMassEditPanel('archived')"></td>`;
        }
        html += `<td style="text-align:center;color:var(--gray-light);font-size:0.85rem;font-weight:600;">${startIdx + i + 1}</td>`;
        html += `<td>${order.id}</td>`;
        html += `<td style="white-space:nowrap;font-size:0.85rem;color:var(--gray-light);">${formatDisplayDate(order.order_date)}</td>`;
        if (role === 'admin') html += `<td class="admin-only">${order.client_id}</td>`;
        html += makePhotoCell(order.photo_id);
        html += `<td>${order.items.replace(/\n/g, '<br>')}</td>`;
        html += `<td style="white-space:nowrap;font-weight:500;">${(order.total_price || 0).toLocaleString('ru')} &#8381;</td>`;
        html += `<td style="white-space:nowrap;">${(order.paid_amount || 0).toLocaleString('ru')} &#8381;</td>`;
        html += `<td><span class="status-badge" style="background:rgba(0,200,80,0.15);color:#40e07a;">${order.status}</span></td>`;

        if (role === 'admin') {
            html += `<td class="admin-only actions-cell">
                <button class="edit-btn" onclick="unarchiveOrder(${order.id})" title="Восстановить в активные">В работу</button>
                <button class="delete-btn" onclick="confirmDelete(${order.id})" title="Удалить навсегда">&#10005;</button>
            </td>`;
        }

        tr.innerHTML = html;
        archivedTableBody.appendChild(tr);
    });

    updatePaginationUI('archived', orders.length);
    window.updateMassEditPanel('archived');
}

// Render clients
function renderClients(clients) {
    clientsTableBody.innerHTML = '';
    clients.forEach((client, i) => {
        const tr = document.createElement('tr');
        tr.className = 'row-animate';
        tr.style.animationDelay = `${i * 0.04}s`;
        tr.innerHTML = `<td style="text-align:center;color:var(--gray-light);font-size:0.85rem;font-weight:600;">${i + 1}</td><td>${client.id}</td><td>${client.password}</td><td>${client.user_tg_id || '—'}</td>`;
        clientsTableBody.appendChild(tr);
    });
}

// Accounting
window.toggleMarginMode = function() {
    window.marginMode = window.marginMode === 'rub' ? 'percent' : 'rub';
    const ind = document.getElementById('margin-mode-indicator');
    if (ind) ind.textContent = window.marginMode === 'rub' ? '₽' : '%';
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
        const q = accountingSearch.value.toLowerCase().trim();
        orders = orders.filter(o => o.id.toString().includes(q) || (o.items && o.items.toLowerCase().includes(q)));
    }

    if (orders.length === 0) { 
        emptyMsg.classList.remove('hidden'); 
        updatePaginationUI('accounting', 0);
        return; 
    }
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
            marginDisplay = marginVal.toLocaleString('ru', {maximumFractionDigits: 0}) + ' ₽';
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

    const state = window.paginationState.accounting;
    const totalPages = Math.max(1, Math.ceil(processed.length / state.pageSize));
    if (state.page > totalPages) state.page = totalPages;
    if (state.page < 1) state.page = 1;

    const startIdx = (state.page - 1) * state.pageSize;
    const pageProcessed = processed.slice(startIdx, startIdx + state.pageSize);

    pageProcessed.forEach((order, i) => {
        const tr = document.createElement('tr');
        tr.className = 'row-animate';
        tr.style.animationDelay = `${i * 0.02}s`;
        const photoHtml = order.photo_id
            ? `<img src="/api/photos/${order.photo_id}" style="width:44px;height:44px;object-fit:cover;border-radius:5px;cursor:pointer;flex-shrink:0;" onclick="viewPhoto('${order.photo_id}')">`
            : `<div style="width:44px;height:44px;border-radius:5px;background:#222;flex-shrink:0;"></div>`;

        tr.innerHTML = `
            <td style="text-align:center;color:var(--gray-light);font-size:0.85rem;font-weight:600;">${startIdx + i + 1}</td>
            <td>${order.id}</td>
            <td style="white-space:nowrap;">${formatDisplayDate(order.order_date)}</td>
            <td>
                <div style="display:flex;gap:8px;align-items:center;min-width:220px;">
                    ${photoHtml}
                    <div style="font-size:0.85rem;">${order.items.replace(/\n/g, '<br>')}</div>
                </div>
            </td>
            <td style="white-space:nowrap;">${order.price.toLocaleString('ru')} &#8381;</td>
            <td style="white-space:nowrap;">${order.cost.toLocaleString('ru')} &#8381;</td>
            <td style="white-space:nowrap;">${order.delivery.toLocaleString('ru')} &#8381;</td>
            <td style="white-space:nowrap;">${(order.paid_amount || 0).toLocaleString('ru')} &#8381;</td>
            <td style="color:#ff9999;font-weight:bold;white-space:nowrap;">${order.totalTax.toLocaleString('ru', {maximumFractionDigits:0})} &#8381;</td>
            <td class="tax-column ${window.taxesExpanded ? '' : 'hidden'}" style="white-space:nowrap;">${order.usn.toLocaleString('ru', {maximumFractionDigits:0})} &#8381;</td>
            <td class="tax-column ${window.taxesExpanded ? '' : 'hidden'}" style="white-space:nowrap;">${order.checks.toLocaleString('ru', {maximumFractionDigits:0})} &#8381;</td>
            <td class="tax-column ${window.taxesExpanded ? '' : 'hidden'}" style="white-space:nowrap;">${order.acquiring.toLocaleString('ru', {maximumFractionDigits:0})} &#8381;</td>
            <td style="color:${order.marginVal >= 0 ? '#00ff88' : '#ff4d4d'};font-weight:bold;white-space:nowrap;">${order.marginDisplay}</td>
        `;
        accountingTableBody.appendChild(tr);
    });

    updatePaginationUI('accounting', processed.length);
}

// Sort listeners with 3-state cycle (desc -> asc -> default) and header arrows
function bindSortListeners(tableId, sortState, renderFn, defaultKey = 'id') {
    const table = document.getElementById(tableId);
    if (!table) return;

    function updateHeaderArrows() {
        table.querySelectorAll('th[data-sort]').forEach(th => {
            const key = th.getAttribute('data-sort');
            let baseLabel = th.getAttribute('data-base-label');
            if (!baseLabel) {
                baseLabel = th.textContent.replace(/[↕▲▼↑↓]/g, '').trim();
                th.setAttribute('data-base-label', baseLabel);
            }
            if (sortState.key === key) {
                th.innerHTML = `${baseLabel} <span class="sort-icon active">${sortState.desc ? '▼' : '▲'}</span>`;
                th.classList.add('sorted-col');
            } else {
                th.innerHTML = `${baseLabel} <span class="sort-icon">↕</span>`;
                th.classList.remove('sorted-col');
            }
        });
    }

    table.querySelectorAll('th[data-sort]').forEach(th => {
        th.addEventListener('click', () => {
            const key = th.getAttribute('data-sort');
            if (sortState.key === key) {
                if (sortState.desc) {
                    sortState.desc = false; // 2nd click: asc
                } else {
                    sortState.key = defaultKey; // 3rd click: reset to default
                    sortState.desc = true;
                }
            } else {
                sortState.key = key; // 1st click: desc
                sortState.desc = true;
            }

            const tabName = tableId.replace('-table', '');
            if (window.paginationState && window.paginationState[tabName]) {
                window.paginationState[tabName].page = 1;
            }
            updateHeaderArrows();
            renderFn();
        });
    });

    updateHeaderArrows();
}
bindSortListeners('orders-table', ordersSort, renderOrders, 'id');
bindSortListeners('archived-table', archivedSort, renderArchivedOrders, 'id');
bindSortListeners('accounting-table', accountingSort, renderAccounting, 'id');
bindSortListeners('catalog-table', catalogSort, renderCatalog, 'id');

// Filter listeners with ALL filters included
['orders-year-filter', 'orders-month-filter', 'orders-client-filter', 'orders-price-min', 'orders-price-max', 'orders-paid-min', 'orders-paid-max', 'orders-search'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { 
        const handler = () => {
            window.paginationState.orders.page = 1;
            renderOrders();
        };
        el.addEventListener('input', handler); 
        el.addEventListener('change', handler); 
    }
});
['archived-year-filter', 'archived-month-filter', 'archived-client-filter', 'archived-price-min', 'archived-price-max', 'archived-paid-min', 'archived-paid-max', 'archived-search'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { 
        const handler = () => {
            window.paginationState.archived.page = 1;
            renderArchivedOrders();
        };
        el.addEventListener('input', handler); 
        el.addEventListener('change', handler); 
    }
});
['accounting-year-filter', 'accounting-month-filter', 'accounting-search'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { 
        const handler = () => {
            window.paginationState.accounting.page = 1;
            renderAccounting();
        };
        el.addEventListener('input', handler); 
        el.addEventListener('change', handler); 
    }
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
            window.paginationState.orders.page = 1;
            renderOrders();
        });
    });

    const clearBtn = menu.querySelector('.filter-clear-all');
    if (clearBtn) {
        clearBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            menu.querySelectorAll('input[type=checkbox]').forEach(cb => cb.checked = false);
            updateStatusBtn(btn.id, []);
            window.paginationState.orders.page = 1;
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

// Global Event Delegation for Row Checkboxes (handles Click, Change, Input immediately)
document.addEventListener('change', (e) => {
    if (e.target.classList.contains('orders-row-checkbox')) {
        window.updateMassEditPanel('orders');
    }
    if (e.target.classList.contains('archived-row-checkbox')) {
        window.updateMassEditPanel('archived');
    }
});

document.addEventListener('click', (e) => {
    if (e.target.classList.contains('orders-row-checkbox')) {
        window.updateMassEditPanel('orders');
    }
    if (e.target.classList.contains('archived-row-checkbox')) {
        window.updateMassEditPanel('archived');
    }
});

// Select All Checkboxes
document.getElementById('orders-select-all')?.addEventListener('change', (e) => {
    document.querySelectorAll('.orders-row-checkbox').forEach(cb => cb.checked = e.target.checked);
    window.updateMassEditPanel('orders');
});
document.getElementById('archived-select-all')?.addEventListener('change', (e) => {
    document.querySelectorAll('.archived-row-checkbox').forEach(cb => cb.checked = e.target.checked);
    window.updateMassEditPanel('archived');
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

// Mass status change apply
['orders', 'archived'].forEach(tab => {
    document.getElementById(`${tab}-mass-edit-btn`)?.addEventListener('click', async () => {
        const checkboxes = document.querySelectorAll(`.${tab}-row-checkbox:checked`);
        const select = document.getElementById(`${tab}-mass-edit-status`);
        const newStatus = select ? select.value : null;
        if (!newStatus) { 
            alert('Пожалуйста, выберите новый статус из выпадающего списка!'); 
            if (select) select.focus();
            return; 
        }
        const orderIds = Array.from(checkboxes).map(cb => parseInt(cb.value));
        if (orderIds.length === 0) {
            alert('Сначала отметьте галочками нужные заказы в таблице!');
            return;
        }
        const btn = document.getElementById(`${tab}-mass-edit-btn`);
        const originalText = btn.textContent;
        btn.textContent = 'Применение...';
        btn.disabled = true;
        try {
            await Promise.all(orderIds.map(async id => {
                const order = allOrders.find(o => o.id === id);
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
                await fetchAPI(`/orders/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
            }));
            window.clearMassSelection(tab);
            await loadDashboardData();
        } catch (err) {
            alert('Ошибка при массовом изменении: ' + err.message);
        } finally {
            btn.textContent = originalText;
            btn.disabled = false;
        }
    });
});

// ===== CATALOG MODULE =====
const catalogGrid = document.getElementById('catalog-grid');
const catalogTableBody = document.querySelector('#catalog-table tbody');
const catalogTableWrapper = document.getElementById('catalog-table-wrapper');
const productModal = document.getElementById('product-modal');
const productForm = document.getElementById('product-form');
const quickOrderModal = document.getElementById('quick-order-modal');
const quickOrderForm = document.getElementById('quick-order-form');
const confirmDeleteProductModal = document.getElementById('confirm-delete-product-modal');
const newProductBtn = document.getElementById('new-product-btn');

window.switchCatalogView = function(view) {
    catalogView = view;
    document.getElementById('view-grid-btn')?.classList.toggle('active', view === 'grid');
    document.getElementById('view-table-btn')?.classList.toggle('active', view === 'table');
    if (view === 'grid') {
        catalogGrid?.classList.remove('hidden');
        catalogTableWrapper?.classList.add('hidden');
    } else {
        catalogGrid?.classList.add('hidden');
        catalogTableWrapper?.classList.remove('hidden');
    }
    renderCatalog();
};

window.selectCatalogCategory = function(cat) {
    selectedCatalogCategory = cat;
    document.querySelectorAll('#catalog-category-pills .category-pill').forEach(pill => {
        pill.classList.toggle('active', pill.getAttribute('data-category') === cat);
    });
    if (window.paginationState.catalog) window.paginationState.catalog.page = 1;
    renderCatalog();
};

async function loadCatalogMeta() {
    try {
        const meta = await fetchAPI('/catalog/meta');
        catalogMeta = meta;

        // Categories datalist
        const catDatalist = document.getElementById('categories-datalist');
        if (catDatalist) {
            catDatalist.innerHTML = '';
            (meta.categories || []).forEach(c => {
                const opt = document.createElement('option');
                opt.value = c;
                catDatalist.appendChild(opt);
            });
        }

        // Series datalist
        const serDatalist = document.getElementById('series-datalist');
        if (serDatalist) {
            serDatalist.innerHTML = '';
            (meta.series || []).forEach(s => {
                const opt = document.createElement('option');
                opt.value = s;
                serDatalist.appendChild(opt);
            });
        }

        // Series filter dropdown
        const serSelect = document.getElementById('catalog-series-filter');
        if (serSelect) {
            const currentVal = serSelect.value;
            serSelect.innerHTML = '<option value="">Все серии</option>';
            (meta.series || []).forEach(s => {
                const opt = document.createElement('option');
                opt.value = s;
                opt.textContent = s;
                serSelect.appendChild(opt);
            });
            if (currentVal) serSelect.value = currentVal;
        }

        // Category pills bar
        const pillsContainer = document.getElementById('catalog-category-pills');
        if (pillsContainer) {
            pillsContainer.innerHTML = '';
            const allBtn = document.createElement('button');
            allBtn.type = 'button';
            allBtn.className = `category-pill ${!selectedCatalogCategory ? 'active' : ''}`;
            allBtn.setAttribute('data-category', '');
            allBtn.textContent = 'Все товары';
            allBtn.onclick = () => selectCatalogCategory('');
            pillsContainer.appendChild(allBtn);

            (meta.categories || []).forEach(cat => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = `category-pill ${selectedCatalogCategory === cat ? 'active' : ''}`;
                btn.setAttribute('data-category', cat);
                btn.textContent = cat;
                btn.onclick = () => selectCatalogCategory(cat);
                pillsContainer.appendChild(btn);
            });
        }
    } catch (err) {
        console.error('Error loading catalog meta:', err);
    }
}

async function loadCatalog() {
    try {
        const data = await fetchAPI('/catalog');
        rawCatalogProducts = data.products || [];
        renderCatalog();
    } catch (err) {
        console.error('Error loading catalog:', err);
    }
}

function renderCatalog() {
    if (!catalogGrid || !catalogTableBody) return;
    catalogGrid.innerHTML = '';
    catalogTableBody.innerHTML = '';
    const emptyMsg = document.getElementById('no-catalog');
    const role = currentRole;
    let products = [...rawCatalogProducts];

    // Filter by Category
    if (selectedCatalogCategory) {
        products = products.filter(p => p.category === selectedCatalogCategory);
    }

    // Filter by Series
    const seriesVal = document.getElementById('catalog-series-filter')?.value;
    if (seriesVal) {
        products = products.filter(p => p.series === seriesVal);
    }

    // Filter by Price min/max
    const priceMin = parseFloat(document.getElementById('catalog-price-min')?.value);
    if (!isNaN(priceMin)) products = products.filter(p => (p.final_price || p.price || 0) >= priceMin);
    const priceMax = parseFloat(document.getElementById('catalog-price-max')?.value);
    if (!isNaN(priceMax)) products = products.filter(p => (p.final_price || p.price || 0) <= priceMax);

    // Filter by Stock
    const stockVal = document.getElementById('catalog-stock-filter')?.value;
    if (stockVal === 'in_stock') products = products.filter(p => p.in_stock);
    else if (stockVal === 'out_of_stock') products = products.filter(p => !p.in_stock);

    // Search query
    const q = document.getElementById('catalog-search')?.value.toLowerCase().trim();
    if (q) {
        products = products.filter(p => 
            p.name.toLowerCase().includes(q) ||
            (p.figure_number && p.figure_number.toLowerCase().includes(q)) ||
            (p.category && p.category.toLowerCase().includes(q)) ||
            (p.series && p.series.toLowerCase().includes(q))
        );
    }

    // Sort products
    if (catalogView === 'table' && catalogSort.key && catalogSort.key !== 'id') {
        products.sort((a, b) => {
            let valA, valB;
            const k = catalogSort.key;
            if (k === 'number') { valA = a.figure_number || ''; valB = b.figure_number || ''; }
            else if (k === 'name') { valA = a.name || ''; valB = b.name || ''; }
            else if (k === 'category') { valA = a.category || ''; valB = b.category || ''; }
            else if (k === 'series') { valA = a.series || ''; valB = b.series || ''; }
            else if (k === 'price') { valA = a.price || 0; valB = b.price || 0; }
            else if (k === 'discount') { valA = a.discount_percent || 0; valB = b.discount_percent || 0; }
            else if (k === 'final_price') { valA = a.final_price || a.price || 0; valB = b.final_price || b.price || 0; }
            else if (k === 'packs') { valA = a.packs_count || 0; valB = b.packs_count || 0; }
            else { valA = a.id; valB = b.id; }
            if (valA < valB) return catalogSort.desc ? 1 : -1;
            if (valA > valB) return catalogSort.desc ? -1 : 1;
            return 0;
        });
    } else {
        const sortSelect = document.getElementById('catalog-sort-select')?.value || 'id_desc';
        products.sort((a, b) => {
            if (sortSelect === 'price_asc') {
                const pa = a.final_price || a.price || 0;
                const pb = b.final_price || b.price || 0;
                return pa - pb;
            } else if (sortSelect === 'price_desc') {
                const pa = a.final_price || a.price || 0;
                const pb = b.final_price || b.price || 0;
                return pb - pa;
            } else if (sortSelect === 'discount_desc') {
                return (b.discount_percent || 0) - (a.discount_percent || 0);
            } else if (sortSelect === 'name_asc') {
                return a.name.localeCompare(b.name, 'ru');
            } else {
                return b.id - a.id;
            }
        });
    }

    if (products.length === 0) {
        if (emptyMsg) emptyMsg.classList.remove('hidden');
        updatePaginationUI('catalog', 0);
        return;
    }
    if (emptyMsg) emptyMsg.classList.add('hidden');

    const state = window.paginationState.catalog;
    const totalPages = Math.max(1, Math.ceil(products.length / state.pageSize));
    if (state.page > totalPages) state.page = totalPages;
    if (state.page < 1) state.page = 1;

    const startIdx = (state.page - 1) * state.pageSize;
    const pageProducts = products.slice(startIdx, startIdx + state.pageSize);

    if (catalogView === 'grid') {
        pageProducts.forEach((p, i) => {
            const card = document.createElement('div');
            card.className = 'product-card row-animate';
            card.style.animationDelay = `${i * 0.02}s`;

            const imgHtml = p.photo_id
                ? `<img src="/api/photos/${p.photo_id}" alt="${p.name}" loading="lazy">`
                : `<div class="product-image-placeholder"><span style="font-size:0.75rem;color:var(--gray);">Нет фото</span></div>`;

            const discountBadge = p.discount_percent > 0
                ? `<span class="card-badge card-badge-discount">-${p.discount_percent}%</span>`
                : '';
            const packsBadge = p.packs_count > 0
                ? `<span class="card-badge card-badge-packs">+${p.packs_count} ${p.packs_count === 1 ? 'пак' : (p.packs_count < 5 ? 'пака' : 'паков')}</span>`
                : '';
            const numberBadge = p.figure_number
                ? `<span class="card-badge card-badge-number">#${p.figure_number}</span>`
                : '';
            const stockBadge = p.in_stock
                ? `<span class="card-badge card-badge-stock in-stock">В наличии</span>`
                : `<span class="card-badge card-badge-stock out-stock">Под заказ</span>`;

            const priceDisplay = p.discount_percent > 0
                ? `<span class="price-final discounted">${(p.final_price || p.price).toLocaleString('ru')} &#8381;</span>
                   <span class="price-original">${p.price.toLocaleString('ru')} &#8381;</span>`
                : `<span class="price-final">${p.price.toLocaleString('ru')} &#8381;</span>`;

            let actionsHtml = '';
            if (role === 'admin') {
                actionsHtml = `
                    <div class="product-card-actions">
                        <button type="button" class="btn-quick-order" onclick="openQuickOrderModal(${p.id})">В заказ</button>
                        <button type="button" class="btn-card-icon" onclick="openEditProductModal(${p.id})" title="Редактировать">✎</button>
                        <button type="button" class="btn-card-icon delete" onclick="confirmDeleteProduct(${p.id})" title="Удалить">&#10005;</button>
                    </div>
                `;
            } else {
                actionsHtml = `
                    <div class="product-card-actions">
                        <button type="button" class="btn-client-order" onclick="openOrderInquiryModal(${p.id})">Заказать</button>
                    </div>
                `;
            }

            card.innerHTML = `
                <div class="product-image-box" onclick="${p.photo_id ? `viewPhoto('${p.photo_id}')` : ''}">
                    ${imgHtml}
                    ${discountBadge}
                    ${packsBadge}
                    ${numberBadge}
                    ${stockBadge}
                </div>
                <div class="product-card-body">
                    <div class="product-card-meta">
                        ${p.category ? `<span class="meta-chip meta-chip-category">${p.category}</span>` : ''}
                        ${p.series ? `<span class="meta-chip meta-chip-series">${p.series}</span>` : ''}
                    </div>
                    <div class="product-card-title" title="${p.name}">${p.name}</div>
                    <div class="product-price-box">
                        ${priceDisplay}
                    </div>
                    ${actionsHtml}
                </div>
            `;
            catalogGrid.appendChild(card);
        });
    } else {
        // Table view
        pageProducts.forEach((p, i) => {
            const tr = document.createElement('tr');
            tr.className = 'row-animate';
            tr.style.animationDelay = `${i * 0.02}s`;

            const photoCell = makePhotoCell(p.photo_id);
            const discountText = p.discount_percent > 0 ? `<span style="color:#ff4d4d;font-weight:600;">-${p.discount_percent}%</span>` : '—';
            const finalPriceVal = (p.final_price || p.price || 0).toLocaleString('ru');
            const packsText = p.packs_count > 0 ? `<span style="color:#ffb400;font-weight:600;">+${p.packs_count}</span>` : '0';
            const stockHtml = p.in_stock 
                ? `<span style="color:#00ff88;font-size:0.85rem;">● В наличии</span>`
                : `<span style="color:#888;font-size:0.85rem;">○ Под заказ</span>`;

            let actionsHtml = '';
            if (role === 'admin') {
                actionsHtml = `
                    <td class="admin-only actions-cell" style="white-space:nowrap;">
                        <button class="edit-btn" onclick="openQuickOrderModal(${p.id})" title="Оформить заказ">В заказ</button>
                        <button class="edit-btn" onclick="openEditProductModal(${p.id})" title="Редактировать">Ред.</button>
                        <button class="delete-btn" onclick="confirmDeleteProduct(${p.id})" title="Удалить">&#10005;</button>
                    </td>
                `;
            } else {
                actionsHtml = `
                    <td class="actions-cell" style="white-space:nowrap; text-align:center;">
                        <button type="button" class="btn-client-order" onclick="openOrderInquiryModal(${p.id})" style="padding:4px 12px;font-size:0.8rem;">Заказать</button>
                    </td>
                `;
            }

            tr.innerHTML = `
                <td style="text-align:center;color:var(--gray-light);font-size:0.85rem;font-weight:600;">${startIdx + i + 1}</td>
                ${photoCell}
                <td style="font-family:monospace;font-weight:600;">${p.figure_number || '—'}</td>
                <td style="font-weight:600;">${p.name}</td>
                <td><span class="meta-chip meta-chip-category">${p.category || '—'}</span></td>
                <td><span class="meta-chip meta-chip-series">${p.series || '—'}</span></td>
                <td style="white-space:nowrap;">${(p.price || 0).toLocaleString('ru')} &#8381;</td>
                <td>${discountText}</td>
                <td style="white-space:nowrap;font-weight:700;color:var(--primary);">${finalPriceVal} &#8381;</td>
                <td>${packsText}</td>
                <td>${stockHtml}</td>
                ${actionsHtml}
            `;
            catalogTableBody.appendChild(tr);
        });
    }

    updatePaginationUI('catalog', products.length);
}

// Open Order Inquiry Modal for Clients & Guests
window.openOrderInquiryModal = function(id) {
    const p = rawCatalogProducts.find(x => x.id === id);
    if (!p) return;
    const modal = document.getElementById('order-inquiry-modal');
    if (!modal) return;

    const img = document.getElementById('inquiry-img');
    const num = document.getElementById('inquiry-number');
    const title = document.getElementById('inquiry-title');
    const price = document.getElementById('inquiry-price');
    const packs = document.getElementById('inquiry-packs');
    const tgBtn = document.getElementById('inquiry-tg-btn');

    if (img) {
        if (p.photo_id) {
            img.src = `/api/photos/${p.photo_id}`;
            img.style.display = 'block';
        } else {
            img.style.display = 'none';
        }
    }
    if (num) num.textContent = p.figure_number ? `#${p.figure_number}` : '';
    if (title) title.textContent = p.name;
    const finalPrice = (p.final_price || p.price || 0).toLocaleString('ru');
    if (price) price.textContent = `${finalPrice} ₽`;
    if (packs) packs.textContent = p.packs_count > 0 ? `+${p.packs_count} пак.` : '';

    if (tgBtn) {
        const clientInfo = currentClientId ? ` (Клиент #${currentClientId})` : '';
        const msgText = `Здравствуйте! Хочу заказать фигурку: ${p.name}${p.figure_number ? ` (#${p.figure_number})` : ''}, цена: ${finalPrice} ₽${clientInfo}`;
        tgBtn.href = `https://t.me/funkostop_bot?text=${encodeURIComponent(msgText)}`;
    }

    openModal(modal);
};

// Open Add Product Modal
window.openAddProductModal = function() {
    if (!productModal) return;
    productForm.reset();
    document.getElementById('product-id').value = '';
    document.getElementById('product-modal-title').textContent = 'Добавить товар в каталог';
    document.getElementById('product-in-stock').checked = true;
    document.getElementById('product-packs').value = '0';
    document.getElementById('product-discount').value = '0';
    document.getElementById('product-photo-preview-wrap').style.display = 'none';
    document.getElementById('product-photo-preview').src = '';
    openModal(productModal);
};

// Open Edit Product Modal
window.openEditProductModal = function(id) {
    const p = rawCatalogProducts.find(x => x.id === id);
    if (!p || !productModal) return;
    document.getElementById('product-id').value = p.id;
    document.getElementById('product-modal-title').textContent = `Редактировать товар #${p.id}`;
    document.getElementById('product-name').value = p.name;
    document.getElementById('product-figure-number').value = p.figure_number || '';
    document.getElementById('product-category').value = p.category || '';
    document.getElementById('product-series').value = p.series || '';
    document.getElementById('product-price').value = p.price;
    document.getElementById('product-discount').value = p.discount_percent || 0;
    document.getElementById('product-final-price').value = p.final_price || p.price;
    document.getElementById('product-packs').value = p.packs_count || 0;
    document.getElementById('product-in-stock').checked = !!p.in_stock;
    document.getElementById('product-photo-id').value = p.photo_id || '';
    
    const previewWrap = document.getElementById('product-photo-preview-wrap');
    const previewImg = document.getElementById('product-photo-preview');
    if (p.photo_id) {
        previewImg.src = `/api/photos/${p.photo_id}`;
        previewWrap.style.display = 'block';
    } else {
        previewWrap.style.display = 'none';
    }
    openModal(productModal);
};

// Auto-calculation of price and discount
const priceInput = document.getElementById('product-price');
const discountInput = document.getElementById('product-discount');
const finalPriceInput = document.getElementById('product-final-price');

function calcFinalPrice() {
    const price = parseFloat(priceInput?.value) || 0;
    const discount = parseFloat(discountInput?.value) || 0;
    if (price >= 0 && discountInput && finalPriceInput) {
        const finalP = Math.max(0, Math.round(price * (100 - discount) / 100));
        finalPriceInput.value = finalP;
    }
}
function calcDiscountFromFinal() {
    const price = parseFloat(priceInput?.value) || 0;
    const finalP = parseFloat(finalPriceInput?.value) || 0;
    if (price > 0 && discountInput) {
        const disc = Math.max(0, Math.min(99, Math.round((price - finalP) * 100 / price)));
        discountInput.value = disc;
    }
}
priceInput?.addEventListener('input', calcFinalPrice);
discountInput?.addEventListener('input', calcFinalPrice);
finalPriceInput?.addEventListener('input', calcDiscountFromFinal);

// Product Photo Upload Listener
const productPhotoUpload = document.getElementById('product-photo-upload');
if (productPhotoUpload) {
    productPhotoUpload.addEventListener('change', async (e) => {
        await handlePhotoUpload(e, 'product-photo-id');
        const photoId = document.getElementById('product-photo-id').value;
        if (photoId) {
            const previewWrap = document.getElementById('product-photo-preview-wrap');
            const previewImg = document.getElementById('product-photo-preview');
            previewImg.src = `/api/photos/${photoId}`;
            previewWrap.style.display = 'block';
        }
    });
}

// Product Form Submit
productForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('product-id').value;
    const price = parseInt(document.getElementById('product-price').value) || 0;
    const discount = parseInt(document.getElementById('product-discount').value) || 0;
    let finalPrice = parseInt(document.getElementById('product-final-price').value);
    if (isNaN(finalPrice) || finalPrice <= 0) {
        finalPrice = Math.max(0, Math.round(price * (100 - discount) / 100));
    }
    const payload = {
        name: document.getElementById('product-name').value.trim(),
        figure_number: document.getElementById('product-figure-number').value.trim(),
        price: price,
        discount_percent: discount,
        final_price: finalPrice,
        category: document.getElementById('product-category').value.trim(),
        series: document.getElementById('product-series').value.trim(),
        packs_count: parseInt(document.getElementById('product-packs').value) || 0,
        photo_id: document.getElementById('product-photo-id').value.trim(),
        in_stock: document.getElementById('product-in-stock').checked
    };

    try {
        if (id) {
            await fetchAPI(`/catalog/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
        } else {
            await fetchAPI('/catalog', { method: 'POST', body: JSON.stringify(payload) });
        }
        closeModals();
        await loadCatalogMeta();
        await loadCatalog();
    } catch (err) {
        alert('Ошибка сохранения товара: ' + err.message);
    }
});

// Delete Product
window.confirmDeleteProduct = function(id) {
    const p = rawCatalogProducts.find(x => x.id === id);
    if (!p) return;
    deleteProductTargetId = id;
    document.getElementById('delete-product-name-display').textContent = p.name;
    openModal(confirmDeleteProductModal);
};
document.getElementById('confirm-delete-product-btn')?.addEventListener('click', async () => {
    if (!deleteProductTargetId) return;
    try {
        await fetchAPI(`/catalog/${deleteProductTargetId}`, { method: 'DELETE' });
        closeModals();
        deleteProductTargetId = null;
        await loadCatalogMeta();
        await loadCatalog();
    } catch (err) {
        alert('Ошибка при удалении: ' + err.message);
    }
});

// Quick Order Modal
window.openQuickOrderModal = function(id) {
    const p = rawCatalogProducts.find(x => x.id === id);
    if (!p) return;
    document.getElementById('quick-order-product-id').value = p.id;
    const title = p.figure_number ? `${p.figure_number} - ${p.name}` : p.name;
    document.getElementById('quick-order-title').textContent = title;
    
    const priceVal = p.final_price > 0 ? p.final_price : p.price;
    document.getElementById('quick-order-price').textContent = `${priceVal.toLocaleString('ru')} ₽`;
    document.getElementById('quick-order-packs').textContent = p.packs_count > 0 ? `+${p.packs_count} пак.` : '';
    
    const imgEl = document.getElementById('quick-order-img');
    if (p.photo_id) {
        imgEl.src = `/api/photos/${p.photo_id}`;
        imgEl.style.display = 'block';
    } else {
        imgEl.style.display = 'none';
    }
    document.getElementById('quick-order-client-id').value = '';
    document.getElementById('quick-order-paid').value = priceVal;
    openModal(quickOrderModal);
};

quickOrderForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const productId = document.getElementById('quick-order-product-id').value;
    const clientId = parseInt(document.getElementById('quick-order-client-id').value);
    const paidAmount = parseInt(document.getElementById('quick-order-paid').value) || 0;

    if (!clientId) {
        alert('Укажите корректный ID клиента!');
        return;
    }

    try {
        const res = await fetchAPI(`/catalog/${productId}/create_order`, {
            method: 'POST',
            body: JSON.stringify({ client_id: clientId, paid_amount: paidAmount })
        });
        closeModals();
        await loadDashboardData();
        document.querySelector('[data-tab="orders"]').click();
        alert(`Заказ #${res.id} успешно создан!`);
    } catch (err) {
        alert('Ошибка оформления заказа: ' + err.message);
    }
});

function populateClientsDatalist(clients) {
    const dl = document.getElementById('clients-datalist');
    if (!dl) return;
    dl.innerHTML = clients.map(c => `<option value="${c.id}">Клиент #${c.id}</option>`).join('');
}

// Catalog filter listeners
['catalog-search', 'catalog-price-min', 'catalog-price-max', 'catalog-series-filter', 'catalog-stock-filter', 'catalog-sort-select'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
        const handler = () => {
            if (window.paginationState.catalog) window.paginationState.catalog.page = 1;
            renderCatalog();
        };
        el.addEventListener('input', handler);
        el.addEventListener('change', handler);
    }
});

newProductBtn?.addEventListener('click', openAddProductModal);

init();

