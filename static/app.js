const API_BASE = '/api';

// DOM Elements
const dashboardView = document.getElementById('dashboard-view');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const logoutBtn = document.getElementById('logout-btn');
const sidebarLoginBtn = document.getElementById('sidebar-login-btn');
const sidebarUserChip = document.getElementById('sidebar-user-chip');
const sidebarUserLabel = document.getElementById('sidebar-user-label');

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
const editClientModal = document.getElementById('edit-client-modal');
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
const editClientForm = document.getElementById('edit-client-form');
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
let selectedBrands = [];
let selectedSeries = [];
let activeFranchiseChip = '';
let catalogSort = { key: 'id', desc: true };
let catalogView = 'grid';
let deleteProductTargetId = null;
let isSidebarCollapsed = localStorage.getItem('funko_sidebar_collapsed') === 'true';

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
    loadCartFromStorage();
    loadCatalogMeta();
    loadCatalog();

    if (token) {
        loadDashboardData().catch(() => {
            handleLogout();
        });
        startHeartbeat();
    } else {
        updateRoleUI('guest');
        window.switchTab('home');
    }
}

function updateRoleUI(role) {
    currentRole = role;
    const landingLoginBtn = document.getElementById('landing-login-btn');
    const landingUserChip = document.getElementById('landing-user-chip');
    const landingUserName = document.getElementById('landing-user-name');
    const hubTrackingTag = document.getElementById('hub-tracking-tag');
    const hubTrackingTitle = document.getElementById('hub-tracking-title');
    const hubTrackingDesc = document.getElementById('hub-tracking-desc');
    const hubTrackingAction = document.getElementById('hub-tracking-action');
    const hubTrackingIcon = document.getElementById('hub-tracking-icon');

    if (role === 'admin') {
        document.querySelectorAll('.admin-only').forEach(el => el.classList.remove('hidden'));
        document.querySelectorAll('.auth-only').forEach(el => el.classList.remove('hidden'));
        if (sidebarUserLabel) sidebarUserLabel.textContent = 'Администратор';
        if (sidebarUserChip) {
            sidebarUserChip.classList.remove('hidden');
            sidebarUserChip.classList.add('admin');
        }
        if (sidebarLoginBtn) sidebarLoginBtn.classList.add('hidden');
        if (logoutBtn) logoutBtn.classList.remove('hidden');

        if (landingLoginBtn) landingLoginBtn.classList.add('hidden');
        if (landingUserChip) {
            landingUserChip.classList.remove('hidden');
            if (landingUserName) landingUserName.textContent = 'Администратор';
        }

        if (hubTrackingTag) hubTrackingTag.textContent = 'Панель управления';
        if (hubTrackingTitle) hubTrackingTitle.textContent = 'Управление заказами';
        if (hubTrackingDesc) hubTrackingDesc.textContent = 'Вы вошли как Администратор. Нажмите для перехода к базе заказов и учету.';
        if (hubTrackingAction) hubTrackingAction.innerHTML = 'Открыть заказы &rarr;';
        if (hubTrackingIcon) hubTrackingIcon.className = 'hub-card-icon red';
    } else if (role === 'client') {
        document.querySelectorAll('.admin-only').forEach(el => el.classList.add('hidden'));
        document.querySelectorAll('.auth-only').forEach(el => el.classList.remove('hidden'));
        const nameLabel = window.currentClientFullName ? `${window.currentClientFullName} (#${currentClientId})` : (currentClientId ? `Клиент #${currentClientId}` : 'Личный кабинет');
        if (sidebarUserLabel) sidebarUserLabel.textContent = nameLabel;
        if (sidebarUserChip) {
            sidebarUserChip.classList.remove('hidden');
            sidebarUserChip.classList.remove('admin');
        }
        if (sidebarLoginBtn) sidebarLoginBtn.classList.add('hidden');
        if (logoutBtn) logoutBtn.classList.remove('hidden');

        if (landingLoginBtn) landingLoginBtn.classList.add('hidden');
        if (landingUserChip) {
            landingUserChip.classList.remove('hidden');
            if (landingUserName) landingUserName.textContent = window.currentClientFullName || (currentClientId ? `ID #${currentClientId}` : 'Клиент');
        }

        if (hubTrackingTag) hubTrackingTag.textContent = 'Личный кабинет активен';
        if (hubTrackingTitle) hubTrackingTitle.textContent = currentClientId ? `Мои заказы (ID: #${currentClientId})` : 'Мои заказы';
        if (hubTrackingDesc) hubTrackingDesc.textContent = 'Вы уже вошли в аккаунт. Нажмите, чтобы открыть статус посылок и историю ваших заказов.';
        if (hubTrackingAction) hubTrackingAction.innerHTML = 'Перейти в мои заказы &rarr;';
        if (hubTrackingIcon) hubTrackingIcon.className = 'hub-card-icon green';
    } else {
        // Guest mode
        currentRole = 'guest';
        document.querySelectorAll('.admin-only').forEach(el => el.classList.add('hidden'));
        document.querySelectorAll('.auth-only').forEach(el => el.classList.add('hidden'));
        if (sidebarUserChip) sidebarUserChip.classList.add('hidden');
        if (sidebarLoginBtn) sidebarLoginBtn.classList.remove('hidden');
        if (logoutBtn) logoutBtn.classList.add('hidden');

        if (landingLoginBtn) landingLoginBtn.classList.remove('hidden');
        if (landingUserChip) landingUserChip.classList.add('hidden');

        if (hubTrackingTag) hubTrackingTag.textContent = 'Отслеживание заказов';
        if (hubTrackingTitle) hubTrackingTitle.textContent = 'funkostop.org';
        if (hubTrackingDesc) hubTrackingDesc.textContent = 'Личный кабинет покупателя: путь со склада США до Москвы и статус готовности к выдаче.';
        if (hubTrackingAction) hubTrackingAction.innerHTML = 'Войти в кабинет &rarr;';
        if (hubTrackingIcon) hubTrackingIcon.className = 'hub-card-icon amber';
    }
    window.updateCatalogDevMode();
}

window.updateCatalogDevMode = function() {
    const devBanner = document.getElementById('catalog-guest-under-dev');
    const catalogHeader = document.getElementById('catalog-header-bar');
    const catalogBody = document.getElementById('catalog-body-layout');
    const adminNotice = document.getElementById('catalog-admin-dev-notice');
    const catalogCartBtn = document.querySelector('.catalog-btn-cart');
    const viewToggle = document.getElementById('catalog-view-toggle');

    if (currentRole === 'admin') {
        if (devBanner) devBanner.classList.add('hidden');
        if (catalogHeader) catalogHeader.style.display = 'flex';
        if (catalogBody) catalogBody.style.display = 'grid';
        if (adminNotice) adminNotice.classList.remove('hidden');
        if (catalogCartBtn) catalogCartBtn.style.display = 'inline-flex';
        if (viewToggle) viewToggle.style.display = 'flex';
    } else {
        if (devBanner) devBanner.classList.remove('hidden');
        if (catalogHeader) catalogHeader.style.display = 'none';
        if (catalogBody) catalogBody.style.display = 'none';
        if (adminNotice) adminNotice.classList.add('hidden');
        if (catalogCartBtn) catalogCartBtn.style.display = 'none';
        if (viewToggle) viewToggle.style.display = 'none';
    }
};

function handleLogout() {
    token = null;
    currentRole = 'guest';
    currentClientId = null;
    window.currentClientFullName = null;
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
    window.switchTab('home');
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

window.goToOrdersOrLogin = function() {
    if (token) {
        window.switchTab('orders');
    } else {
        window.openLoginModal();
    }
};

if (sidebarLoginBtn) sidebarLoginBtn.addEventListener('click', window.openLoginModal);
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

// Navigation between tabs with smooth page transition animations
window.switchTab = function(tabName) {
    const dashboard = document.getElementById('dashboard-view');
    if (dashboard) {
        if (tabName === 'home') {
            dashboard.classList.add('home-mode');
        } else {
            dashboard.classList.remove('home-mode');
        }
    }

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
        window.updateCatalogDevMode();
        if (currentRole === 'admin') {
            loadCatalog();
            loadCatalogMeta();
        }
    }
    window.scrollTo({ top: 0, behavior: 'auto' });
};

navItems.forEach(item => {
    item.addEventListener('click', (e) => {
        e.preventDefault();
        const tabName = item.getAttribute('data-tab');
        if (tabName) window.switchTab(tabName);
    });
});

// FAQ Accordion click handler
document.addEventListener('click', (e) => {
    const questionBtn = e.target.closest('.faq-question-btn');
    if (questionBtn) {
        const item = questionBtn.closest('.faq-accordion-item');
        if (item) {
            item.classList.toggle('open');
        }
    }
});

// Ensure initial home-mode on page load
document.addEventListener('DOMContentLoaded', () => {
    const activeTab = document.querySelector('.tab-content.active');
    const dashboard = document.getElementById('dashboard-view');
    if (dashboard && activeTab && activeTab.id === 'home-tab') {
        dashboard.classList.add('home-mode');
    }
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
            window.currentClientFullName = data.full_name || '';
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

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Render clients
function renderClients(clients) {
    window.allClients = clients || [];
    clientsTableBody.innerHTML = '';
    (clients || []).forEach((client, i) => {
        const tr = document.createElement('tr');
        tr.className = 'row-animate';
        tr.style.animationDelay = `${i * 0.04}s`;
        
        let firstName = (client.first_name || '').trim();
        let lastName = (client.last_name || '').trim();
        if (!firstName && !lastName && client.full_name) {
            const parts = client.full_name.trim().split(/\s+/);
            firstName = parts[0] || '';
            lastName = parts.slice(1).join(' ') || '';
        }

        const fnDisplay = firstName ? escapeHtml(firstName) : '<span style="color:var(--gray-light); font-style:italic;">Не указано</span>';
        const lnDisplay = lastName ? escapeHtml(lastName) : '<span style="color:var(--gray-light); font-style:italic;">Не указано</span>';
        const phoneDisplay = client.phone ? escapeHtml(client.phone) : '—';
        const tgDisplay = (client.tg_username || client.user_tg_id) 
            ? (client.tg_username ? (client.tg_username.startsWith('@') ? client.tg_username : `@${client.tg_username}`) : `ID: ${client.user_tg_id}`)
            : '—';

        tr.innerHTML = `
            <td style="text-align:center;color:var(--gray-light);font-size:0.85rem;font-weight:600;">${i + 1}</td>
            <td style="font-weight:700; color:#fff;">${client.id}</td>
            <td style="font-weight:600; color:#fff;">${fnDisplay}</td>
            <td style="font-weight:600; color:#fff;">${lnDisplay}</td>
            <td style="color:#eee; font-size:0.88rem;">${phoneDisplay}</td>
            <td style="color:${tgDisplay !== '—' ? '#60a5fa' : 'var(--gray-light)'};">${tgDisplay}</td>
            <td style="font-family:monospace; color:#ddd;">${escapeHtml(client.password)}</td>
            <td style="text-align:center; white-space:nowrap;">
                <button type="button" class="edit-btn" onclick="window.openEditClientModal(${client.id})" title="Редактировать клиента">Ред.</button>
                <button type="button" class="delete-btn" onclick="window.confirmDeleteClient(${client.id})" title="Удалить клиента" style="margin-left:4px;">✕</button>
            </td>
        `;
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
    if (!modal) return;
    const overlay = document.getElementById('modal-overlay');
    if (overlay) overlay.classList.remove('hidden');
    modal.classList.remove('hidden');
}
function closeModals() {
    const overlay = document.getElementById('modal-overlay');
    if (overlay) overlay.classList.add('hidden');
    document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
}
window.openModal = openModal;
window.closeModals = closeModals;
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
    if (!photoId) return;
    openModal(photoViewerModal);
    const imgEl = document.getElementById('photo-viewer-image');
    const loadingEl = document.getElementById('photo-loading');
    imgEl.classList.add('hidden'); imgEl.src = '';
    loadingEl.classList.remove('hidden'); loadingEl.textContent = 'Загрузка...';
    try {
        if (photoId.startsWith('http') || photoId.startsWith('/static/')) {
            imgEl.src = photoId;
            imgEl.onload = () => { imgEl.classList.remove('hidden'); loadingEl.classList.add('hidden'); };
            imgEl.onerror = () => { loadingEl.textContent = 'Ошибка загрузки изображения'; };
            return;
        }
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
        const res = await fetch(`${API_BASE}/photos/${photoId}`, { headers });
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
    const pwd = document.getElementById('new-client-password').value.trim();
    const firstName = document.getElementById('new-client-first-name')?.value.trim() || '';
    const lastName = document.getElementById('new-client-last-name')?.value.trim() || '';
    const phone = document.getElementById('new-client-phone')?.value.trim() || '';
    const tg = document.getElementById('new-client-tg')?.value.trim() || '';

    if (!pwd) {
        alert('Укажите пароль!');
        return;
    }
    try {
        await fetchAPI('/clients', {
            method: 'POST',
            body: JSON.stringify({
                password: pwd,
                first_name: firstName,
                last_name: lastName,
                full_name: `${firstName} ${lastName}`.trim(),
                phone: phone,
                tg_username: tg
            })
        });
        closeModals();
        createClientForm.reset();
        await loadDashboardData();
    } catch (err) { alert(err.message); }
});

// Edit Client Modal & Handlers
window.openEditClientModal = function(clientId) {
    const client = (window.allClients || []).find(c => c.id === clientId);
    if (!client) return;
    document.getElementById('edit-client-id').value = client.id;
    document.getElementById('edit-client-id-display').textContent = client.id;

    let firstName = (client.first_name || '').trim();
    let lastName = (client.last_name || '').trim();
    if (!firstName && !lastName && client.full_name) {
        const parts = client.full_name.trim().split(/\s+/);
        firstName = parts[0] || '';
        lastName = parts.slice(1).join(' ') || '';
    }

    const fnInput = document.getElementById('edit-client-first-name');
    const lnInput = document.getElementById('edit-client-last-name');
    const phoneInput = document.getElementById('edit-client-phone');
    const tgInput = document.getElementById('edit-client-tg');

    if (fnInput) fnInput.value = firstName;
    if (lnInput) lnInput.value = lastName;
    if (phoneInput) phoneInput.value = client.phone || '';
    if (tgInput) tgInput.value = client.tg_username || (client.user_tg_id ? String(client.user_tg_id) : '');
    document.getElementById('edit-client-password').value = '';
    openModal(editClientModal);
};

editClientForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const clientId = document.getElementById('edit-client-id').value;
    const firstName = document.getElementById('edit-client-first-name')?.value.trim() || '';
    const lastName = document.getElementById('edit-client-last-name')?.value.trim() || '';
    const phone = document.getElementById('edit-client-phone')?.value.trim() || '';
    const tg = document.getElementById('edit-client-tg')?.value.trim() || '';
    const pwd = document.getElementById('edit-client-password').value.trim();

    try {
        await fetchAPI(`/clients/${clientId}`, {
            method: 'PUT',
            body: JSON.stringify({
                first_name: firstName,
                last_name: lastName,
                full_name: `${firstName} ${lastName}`.trim(),
                phone: phone,
                tg_username: tg,
                password: pwd
            })
        });
        closeModals();
        editClientForm.reset();
        await loadDashboardData();
    } catch (err) {
        alert('Ошибка обновления клиента: ' + err.message);
    }
});

window.confirmDeleteClient = async function(clientId) {
    if (!confirm(`Вы действительно хотите удалить клиента #${clientId}?`)) return;
    try {
        await fetchAPI(`/clients/${clientId}`, { method: 'DELETE' });
        await loadDashboardData();
    } catch (err) {
        alert('Ошибка при удалении клиента: ' + err.message);
    }
};

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
const manageCatalogMetaBtn = document.getElementById('manage-catalog-meta-btn');
const catalogMetaModal = document.getElementById('catalog-meta-modal');
const addCategoryForm = document.getElementById('add-category-form');
const addSeriesForm = document.getElementById('add-series-form');
const sidebarToggleBtn = document.getElementById('sidebar-toggle-btn');
const sidebarOpenBtn = document.getElementById('sidebar-open-btn');
const catalogFilterSidebar = document.getElementById('catalog-filter-sidebar');
const catalogSearchInput = document.getElementById('catalog-search');
const catalogSearchClear = document.getElementById('catalog-search-clear');
const catalogSortSelect = document.getElementById('catalog-sort-select');
const catalogResetFiltersBtn = document.getElementById('catalog-reset-filters-btn');

// --- Sidebar Collapse / Expand ---
function initSidebar() {
    if (isSidebarCollapsed) {
        catalogFilterSidebar?.classList.add('collapsed');
        sidebarOpenBtn?.classList.remove('hidden');
    } else {
        catalogFilterSidebar?.classList.remove('collapsed');
        sidebarOpenBtn?.classList.add('hidden');
    }
}

sidebarToggleBtn?.addEventListener('click', () => {
    catalogFilterSidebar?.classList.add('collapsed');
    sidebarOpenBtn?.classList.remove('hidden');
    isSidebarCollapsed = true;
    localStorage.setItem('funko_sidebar_collapsed', 'true');
});

sidebarOpenBtn?.addEventListener('click', () => {
    catalogFilterSidebar?.classList.remove('collapsed');
    sidebarOpenBtn?.classList.add('hidden');
    isSidebarCollapsed = false;
    localStorage.setItem('funko_sidebar_collapsed', 'false');
});

// --- View Switcher (Grid / Table) ---
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

// --- Brand Cards Slider (Hidden as requested: no brand logos yet) ---
function renderBrandCards() {
    const wrap = document.querySelector('.brand-cards-slider-wrap');
    if (wrap) wrap.style.display = 'none';
    const container = document.getElementById('catalog-brand-cards');
    if (container) container.innerHTML = '';
}

window.selectBrandCard = function(brandName) {
    if (selectedCatalogCategory.toLowerCase() === brandName.toLowerCase()) {
        selectedCatalogCategory = '';
        selectedBrands = [];
    } else {
        selectedCatalogCategory = brandName;
        selectedBrands = [brandName];
    }
    if (window.paginationState.catalog) window.paginationState.catalog.page = 1;
    renderBrandCards();
    renderSidebarFilters();
    renderCatalog();
};

// --- Sidebar Checkbox Filters (Dynamic from DB only) ---
function renderSidebarFilters() {
    // Brands list
    const brandListEl = document.getElementById('sidebar-brand-list');
    if (brandListEl) {
        const allCats = catalogMeta.categories || [];
        if (allCats.length === 0) {
            brandListEl.innerHTML = '<div style="color:var(--gray); font-size:0.83rem; padding:4px 0;">Бренды не добавлены</div>';
        } else {
            brandListEl.innerHTML = allCats.map(cat => {
                const count = rawCatalogProducts.filter(p => (p.category || '').toLowerCase() === cat.toLowerCase()).length;
                const isChecked = selectedBrands.some(b => b.toLowerCase() === cat.toLowerCase()) || 
                                  (selectedCatalogCategory.toLowerCase() === cat.toLowerCase());
                return `
                    <label class="filter-checkbox-item">
                        <input type="checkbox" value="${cat}" ${isChecked ? 'checked' : ''} onchange="window.toggleSidebarBrand('${cat.replace(/'/g, "\\'")}', this.checked)">
                        <span class="filter-item-name">${cat}</span>
                        <span class="filter-item-count">${count}</span>
                    </label>
                `;
            }).join('');
        }
    }

    // Series list
    const seriesListEl = document.getElementById('sidebar-series-list');
    if (seriesListEl) {
        const allSeries = catalogMeta.series || [];
        if (allSeries.length === 0) {
            seriesListEl.innerHTML = '<div style="color:var(--gray); font-size:0.83rem; padding:4px 0;">Тематики не добавлены</div>';
        } else {
            seriesListEl.innerHTML = allSeries.map(ser => {
                const count = rawCatalogProducts.filter(p => (p.series || '').toLowerCase() === ser.toLowerCase()).length;
                const isChecked = selectedSeries.some(s => s.toLowerCase() === ser.toLowerCase());
                return `
                    <label class="filter-checkbox-item">
                        <input type="checkbox" value="${ser}" ${isChecked ? 'checked' : ''} onchange="window.toggleSidebarSeries('${ser.replace(/'/g, "\\'")}', this.checked)">
                        <span class="filter-item-name">${ser}</span>
                        <span class="filter-item-count">${count}</span>
                    </label>
                `;
            }).join('');
        }
    }
}

window.toggleSidebarBrand = function(cat, isChecked) {
    if (isChecked) {
        if (!selectedBrands.some(b => b.toLowerCase() === cat.toLowerCase())) {
            selectedBrands.push(cat);
        }
        selectedCatalogCategory = cat;
    } else {
        selectedBrands = selectedBrands.filter(b => b.toLowerCase() !== cat.toLowerCase());
        if (selectedCatalogCategory.toLowerCase() === cat.toLowerCase()) {
            selectedCatalogCategory = selectedBrands.length > 0 ? selectedBrands[0] : '';
        }
    }
    if (window.paginationState.catalog) window.paginationState.catalog.page = 1;
    renderBrandCards();
    renderCatalog();
};

window.toggleSidebarSeries = function(ser, isChecked) {
    if (isChecked) {
        if (!selectedSeries.some(s => s.toLowerCase() === ser.toLowerCase())) {
            selectedSeries.push(ser);
        }
    } else {
        selectedSeries = selectedSeries.filter(s => s.toLowerCase() !== ser.toLowerCase());
    }
    activeFranchiseChip = selectedSeries.length === 1 ? selectedSeries[0] : '';
    if (window.paginationState.catalog) window.paginationState.catalog.page = 1;
    renderFranchiseChips();
    renderCatalog();
};

// --- Franchise Quick Chips (Dynamic from DB only) ---
function renderFranchiseChips() {
    const chipsBar = document.getElementById('franchise-chips-bar');
    const wrap = document.querySelector('.franchise-chips-wrap');
    if (!chipsBar) return;

    const allSeries = catalogMeta.series || [];
    if (allSeries.length === 0) {
        if (wrap) wrap.style.display = 'none';
        chipsBar.innerHTML = '';
        return;
    }
    if (wrap) wrap.style.display = 'block';

    const list = ['Все', ...allSeries];

    chipsBar.innerHTML = list.map(f => {
        let isActive = false;
        if (f === 'Все') {
            isActive = (selectedSeries.length === 0 && !activeFranchiseChip);
        } else {
            isActive = (activeFranchiseChip.toLowerCase() === f.toLowerCase()) ||
                       (selectedSeries.length === 1 && selectedSeries[0].toLowerCase() === f.toLowerCase());
        }
        return `
            <button type="button" class="franchise-chip ${isActive ? 'active' : ''}" onclick="window.selectFranchiseChip('${f.replace(/'/g, "\\'")}')">
                ${f}
            </button>
        `;
    }).join('');
}

window.selectFranchiseChip = function(franchise) {
    if (franchise === 'Все') {
        selectedSeries = [];
        activeFranchiseChip = '';
    } else {
        if (activeFranchiseChip.toLowerCase() === franchise.toLowerCase()) {
            activeFranchiseChip = '';
            selectedSeries = [];
        } else {
            activeFranchiseChip = franchise;
            selectedSeries = [franchise];
        }
    }
    if (window.paginationState.catalog) window.paginationState.catalog.page = 1;
    renderFranchiseChips();
    renderSidebarFilters();
    renderCatalog();
};

// --- Reset All Filters ---
catalogResetFiltersBtn?.addEventListener('click', () => {
    if (catalogSearchInput) catalogSearchInput.value = '';
    if (catalogSearchClear) catalogSearchClear.classList.add('hidden');
    const priceMin = document.getElementById('catalog-price-min');
    const priceMax = document.getElementById('catalog-price-max');
    if (priceMin) priceMin.value = '';
    if (priceMax) priceMax.value = '';
    const stockIn = document.getElementById('stock-filter-in');
    const stockPre = document.getElementById('stock-filter-preorder');
    if (stockIn) stockIn.checked = true;
    if (stockPre) stockPre.checked = true;
    if (catalogSortSelect) catalogSortSelect.value = 'id_desc';

    selectedCatalogCategory = '';
    selectedBrands = [];
    selectedSeries = [];
    activeFranchiseChip = '';

    if (window.paginationState.catalog) window.paginationState.catalog.page = 1;
    renderBrandCards();
    renderSidebarFilters();
    renderFranchiseChips();
    renderCatalog();
});

// --- Search Input Listener & Clear Button ---
if (catalogSearchInput) {
    catalogSearchInput.addEventListener('input', () => {
        const val = catalogSearchInput.value.trim();
        if (val) {
            catalogSearchClear?.classList.remove('hidden');
        } else {
            catalogSearchClear?.classList.add('hidden');
        }
        if (window.paginationState.catalog) window.paginationState.catalog.page = 1;
        renderCatalog();
    });
}
catalogSearchClear?.addEventListener('click', () => {
    if (catalogSearchInput) catalogSearchInput.value = '';
    catalogSearchClear.classList.add('hidden');
    if (window.paginationState.catalog) window.paginationState.catalog.page = 1;
    renderCatalog();
});

// --- Availability Checkbox Listeners ---
['stock-filter-in', 'stock-filter-preorder'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', () => {
        if (window.paginationState.catalog) window.paginationState.catalog.page = 1;
        renderCatalog();
    });
});

// --- Price Filters & Sort Selector ---
['catalog-price-min', 'catalog-price-max', 'catalog-sort-select'].forEach(id => {
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

// --- Metadata Loading ---
async function loadCatalogMeta() {
    try {
        const meta = await fetchAPI('/catalog/meta');
        catalogMeta = meta || { categories: [], series: [] };

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

        renderBrandCards();
        renderSidebarFilters();
        renderFranchiseChips();
    } catch (err) {
        console.error('Error loading catalog meta:', err);
    }
}

// --- Catalog Loading ---
async function loadCatalog() {
    try {
        const data = await fetchAPI('/catalog');
        rawCatalogProducts = data.products || [];
        renderBrandCards();
        renderSidebarFilters();
        renderFranchiseChips();
        renderCatalog();
    } catch (err) {
        console.error('Error loading catalog:', err);
    }
}

// Helper to determine badge CSS class
function getBadgeClass(badge) {
    const b = (badge || '').toUpperCase();
    if (b === 'NEW') return 'card-badge card-badge-new';
    if (b === 'GITD' || b.includes('GLOW')) return 'card-badge card-badge-gitd';
    if (b === 'CHASE') return 'card-badge card-badge-chase';
    if (b === 'EXCLUSIVE') return 'card-badge card-badge-exclusive';
    if (b === 'LIGHT & SOUND' || b.includes('LIGHT')) return 'card-badge card-badge-special';
    return 'card-badge card-badge-custom';
}

// --- Catalog Rendering ---
function renderCatalog() {
    if (!catalogGrid || !catalogTableBody) return;
    catalogGrid.innerHTML = '';
    catalogTableBody.innerHTML = '';
    const emptyMsg = document.getElementById('no-catalog');
    const role = currentRole;
    let products = [...rawCatalogProducts];

    // Filter by Stock (В наличии / Под заказ)
    const stockIn = document.getElementById('stock-filter-in')?.checked ?? true;
    const stockPre = document.getElementById('stock-filter-preorder')?.checked ?? true;
    if (stockIn && !stockPre) {
        products = products.filter(p => p.in_stock);
    } else if (!stockIn && stockPre) {
        products = products.filter(p => !p.in_stock);
    } else if (!stockIn && !stockPre) {
        products = [];
    }

    // Filter by Brand / Category
    if (selectedBrands.length > 0) {
        products = products.filter(p => selectedBrands.some(b => b.toLowerCase() === (p.category || '').toLowerCase()));
    } else if (selectedCatalogCategory) {
        products = products.filter(p => (p.category || '').toLowerCase() === selectedCatalogCategory.toLowerCase());
    }

    // Filter by Series / Thematics
    if (selectedSeries.length > 0) {
        products = products.filter(p => selectedSeries.some(s => s.toLowerCase() === (p.series || '').toLowerCase()));
    }

    // Filter by Price min/max
    const priceMin = parseFloat(document.getElementById('catalog-price-min')?.value);
    if (!isNaN(priceMin)) products = products.filter(p => (p.final_price || p.price || 0) >= priceMin);
    const priceMax = parseFloat(document.getElementById('catalog-price-max')?.value);
    if (!isNaN(priceMax)) products = products.filter(p => (p.final_price || p.price || 0) <= priceMax);

    // Filter by Search query
    const q = document.getElementById('catalog-search')?.value.toLowerCase().trim();
    if (q) {
        products = products.filter(p => 
            (p.name && p.name.toLowerCase().includes(q)) ||
            (p.figure_number && p.figure_number.toLowerCase().includes(q)) ||
            (p.category && p.category.toLowerCase().includes(q)) ||
            (p.series && p.series.toLowerCase().includes(q)) ||
            (p.badge && p.badge.toLowerCase().includes(q))
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
        if (emptyMsg) {
            emptyMsg.innerHTML = `
                <div style="padding: 48px 20px; text-align: center;">
                    <div style="font-size: 1.15rem; font-weight: 600; color: #fff; margin-bottom: 8px;">В каталоге пока нет товаров</div>
                    <p style="color: var(--gray); font-size: 0.88rem;">
                        ${role === 'admin' 
                            ? 'Нажмите кнопку <b>«+ Добавить товар»</b> в правом верхнем углу, чтобы добавить первую позицию.' 
                            : 'Товары скоро появятся в продаже.'}
                    </p>
                </div>
            `;
            emptyMsg.classList.remove('hidden');
        }
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

            const photoSrc = p.photo_id 
                ? (p.photo_id.startsWith('http') || p.photo_id.startsWith('/static/') ? p.photo_id : `/api/photos/${p.photo_id}`)
                : '';

            const imgHtml = photoSrc
                ? `<img src="${photoSrc}" alt="${p.name}" loading="lazy">`
                : `<div class="product-image-placeholder"><span style="font-size:0.75rem;color:var(--gray);">Нет фото</span></div>`;

            // Badges
            const customBadgeHtml = p.badge 
                ? `<span class="${getBadgeClass(p.badge)}">${p.badge}</span>` 
                : '';
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
                ? `<span class="card-badge card-badge-stock in-stock">● В наличии</span>`
                : `<span class="card-badge card-badge-stock out-stock">○ Под заказ</span>`;

            const priceDisplay = p.discount_percent > 0
                ? `<span class="price-final discounted">${(p.final_price || p.price).toLocaleString('ru')} &#8381;</span>
                   <span class="price-original">${p.price.toLocaleString('ru')} &#8381;</span>`
                : `<span class="price-final">${p.price.toLocaleString('ru')} &#8381;</span>`;

            let actionsHtml = '';
            if (role === 'admin') {
                actionsHtml = `
                    <div class="product-card-actions">
                        <button type="button" class="btn-quick-order" onclick="window.addToCart(${p.id}, 1)" title="Добавить в корзину">+ В корзину</button>
                        <button type="button" class="btn-card-icon" onclick="window.openEditProductModal(${p.id})" title="Редактировать">✎</button>
                        <button type="button" class="btn-card-icon delete" onclick="window.confirmDeleteProduct(${p.id})" title="Удалить">&#10005;</button>
                    </div>
                `;
            } else {
                actionsHtml = `
                    <div class="product-card-actions" style="display:flex; gap:6px; width:100%;">
                        <button type="button" class="btn primary" onclick="window.addToCart(${p.id}, 1)" style="flex:1; padding:8px 12px; font-size:0.85rem; font-weight:700; border-radius:8px; display:inline-flex; align-items:center; justify-content:center; gap:6px;">
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="9" cy="21" r="1"></circle><circle cx="20" cy="21" r="1"></circle><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"></path></svg>
                            <span>В корзину</span>
                        </button>
                        <button type="button" class="btn secondary outline" onclick="window.quickBuy(${p.id})" style="padding:8px 12px; font-size:0.82rem; font-weight:600; border-radius:8px; width:auto;" title="Купить сразу">Купить</button>
                    </div>
                `;
            }

            card.innerHTML = `
                <div class="product-image-box" onclick="${photoSrc ? `window.viewPhoto('${p.photo_id}')` : ''}">
                    ${imgHtml}
                    ${customBadgeHtml}
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
                    <div class="product-card-title" title="${p.name}">
                        ${p.figure_number ? `<span style="color:var(--primary);margin-right:4px;">#${p.figure_number}</span>` : ''}${p.name}
                    </div>
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
                        <button class="edit-btn" onclick="window.addToCart(${p.id}, 1)" title="Добавить в корзину">+ В корзину</button>
                        <button class="edit-btn" onclick="window.openEditProductModal(${p.id})" title="Редактировать">Ред.</button>
                        <button class="delete-btn" onclick="window.confirmDeleteProduct(${p.id})" title="Удалить">&#10005;</button>
                    </td>
                `;
            } else {
                actionsHtml = `
                    <td class="actions-cell" style="white-space:nowrap; text-align:center;">
                        <button type="button" class="btn primary" onclick="window.addToCart(${p.id}, 1)" style="padding:6px 14px; font-size:0.82rem; font-weight:700; width:auto; display:inline-flex; align-items:center; gap:6px;">
                            <span>В корзину</span>
                        </button>
                    </td>
                `;
            }

            tr.innerHTML = `
                <td style="text-align:center;color:var(--gray-light);font-size:0.85rem;font-weight:600;">${startIdx + i + 1}</td>
                ${photoCell}
                <td style="font-family:monospace;font-weight:600;">${p.figure_number || '—'}</td>
                <td style="font-weight:600;">
                    ${p.badge ? `<span class="${getBadgeClass(p.badge)}" style="position:static;display:inline-block;margin-right:6px;font-size:0.68rem;padding:2px 6px;">${p.badge}</span>` : ''}
                    ${p.name}
                </td>
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

// --- Order Inquiry Modal for Clients & Guests ---
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
            img.src = p.photo_id.startsWith('http') || p.photo_id.startsWith('/static/') ? p.photo_id : `/api/photos/${p.photo_id}`;
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
        const msgText = `Здравствуйте! Хочу уточнить по фигурке: ${p.name}${p.figure_number ? ` (#${p.figure_number})` : ''}, цена: ${finalPrice} ₽${clientInfo}`;
        tgBtn.href = `https://t.me/Funko_Stop?text=${encodeURIComponent(msgText)}`;
    }

    openModal(modal);
};

// --- Add Product Modal ---
window.openAddProductModal = function() {
    if (!productModal) return;
    productForm.reset();
    document.getElementById('product-id').value = '';
    document.getElementById('product-modal-title').textContent = 'Добавить товар в каталог';
    document.getElementById('product-in-stock').checked = true;
    document.getElementById('product-packs').value = '0';
    document.getElementById('product-discount').value = '0';
    document.getElementById('product-badge').value = '';
    document.getElementById('product-photo-preview-wrap').style.display = 'none';
    document.getElementById('product-photo-preview').src = '';
    openModal(productModal);
};

// --- Edit Product Modal ---
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
    document.getElementById('product-badge').value = p.badge || '';
    
    const previewWrap = document.getElementById('product-photo-preview-wrap');
    const previewImg = document.getElementById('product-photo-preview');
    if (p.photo_id) {
        previewImg.src = p.photo_id.startsWith('http') || p.photo_id.startsWith('/static/') ? p.photo_id : `/api/photos/${p.photo_id}`;
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
            previewImg.src = photoId.startsWith('http') || photoId.startsWith('/static/') ? photoId : `/api/photos/${photoId}`;
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
        in_stock: document.getElementById('product-in-stock').checked,
        badge: (document.getElementById('product-badge')?.value || '').trim()
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
        imgEl.src = p.photo_id.startsWith('http') || p.photo_id.startsWith('/static/') ? p.photo_id : `/api/photos/${p.photo_id}`;
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

// --- Category & Series Meta Manager (Admin Only) ---
manageCatalogMetaBtn?.addEventListener('click', () => {
    window.openCatalogMetaModal();
});

window.openCatalogMetaModal = function() {
    if (!catalogMetaModal) return;
    renderMetaModalLists();
    openModal(catalogMetaModal);
};

function renderMetaModalLists() {
    const catListEl = document.getElementById('meta-categories-list');
    const serListEl = document.getElementById('meta-series-list');
    const catCountEl = document.getElementById('meta-cat-count');
    const serCountEl = document.getElementById('meta-ser-count');

    const cats = catalogMeta.categories || [];
    const series = catalogMeta.series || [];

    if (catCountEl) catCountEl.textContent = `${cats.length} шт.`;
    if (serCountEl) serCountEl.textContent = `${series.length} шт.`;

    if (catListEl) {
        if (cats.length === 0) {
            catListEl.innerHTML = '<div style="color:var(--gray); font-size:0.82rem; padding:8px 0;">Нет добавленных категорий</div>';
        } else {
            catListEl.innerHTML = cats.map(c => `
                <div style="display:flex; align-items:center; justify-content:space-between; padding:6px 10px; background:rgba(255,255,255,0.04); border-radius:6px; font-size:0.85rem;">
                    <span style="color:#eee; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${c}</span>
                    <button type="button" onclick="window.deleteMetaItem('category', '${c.replace(/'/g, "\\'")}')" style="background:none; border:none; color:#ff4d4d; cursor:pointer; font-size:1rem; padding:0 4px; line-height:1;" title="Удалить бренд">✕</button>
                </div>
            `).join('');
        }
    }

    if (serListEl) {
        if (series.length === 0) {
            serListEl.innerHTML = '<div style="color:var(--gray); font-size:0.82rem; padding:8px 0;">Нет добавленных тематик</div>';
        } else {
            serListEl.innerHTML = series.map(s => `
                <div style="display:flex; align-items:center; justify-content:space-between; padding:6px 10px; background:rgba(255,255,255,0.04); border-radius:6px; font-size:0.85rem;">
                    <span style="color:#eee; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${s}</span>
                    <button type="button" onclick="window.deleteMetaItem('series', '${s.replace(/'/g, "\\'")}')" style="background:none; border:none; color:#ff4d4d; cursor:pointer; font-size:1rem; padding:0 4px; line-height:1;" title="Удалить серию">✕</button>
                </div>
            `).join('');
        }
    }
}

addCategoryForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('new-category-name');
    const name = input?.value.trim();
    if (!name) return;
    try {
        await fetchAPI('/catalog/categories', { method: 'POST', body: JSON.stringify({ name }) });
        input.value = '';
        await loadCatalogMeta();
        renderMetaModalLists();
    } catch (err) {
        alert('Ошибка добавления категории: ' + err.message);
    }
});

addSeriesForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('new-series-name');
    const name = input?.value.trim();
    if (!name) return;
    try {
        await fetchAPI('/catalog/series', { method: 'POST', body: JSON.stringify({ name }) });
        input.value = '';
        await loadCatalogMeta();
        renderMetaModalLists();
    } catch (err) {
        alert('Ошибка добавления серии: ' + err.message);
    }
});

window.deleteMetaItem = async function(type, name) {
    const cleanName = (name || '').trim();
    if (!cleanName) return;

    // Optimistically remove from state immediately for instant UI feedback
    if (type === 'category') {
        catalogMeta.categories = (catalogMeta.categories || []).filter(c => c.toLowerCase() !== cleanName.toLowerCase());
    } else {
        catalogMeta.series = (catalogMeta.series || []).filter(s => s.toLowerCase() !== cleanName.toLowerCase());
    }
    renderMetaModalLists();
    renderSidebarFilters();
    renderFranchiseChips();

    try {
        const endpoint = type === 'category' 
            ? `/catalog/categories/${encodeURIComponent(cleanName)}` 
            : `/catalog/series/${encodeURIComponent(cleanName)}`;
        await fetchAPI(endpoint, { method: 'DELETE' });
        await loadCatalogMeta();
        renderMetaModalLists();
        renderSidebarFilters();
        renderFranchiseChips();
        window.showToast(type === 'category' ? `Бренд «${cleanName}» удалён` : `Тематика «${cleanName}» удалена`);
    } catch (err) {
        // Rollback on failure
        await loadCatalogMeta();
        renderMetaModalLists();
        alert('Ошибка при удалении: ' + err.message);
    }
};

function populateClientsDatalist(clients) {
    const dl = document.getElementById('clients-datalist');
    if (!dl) return;
    dl.innerHTML = (clients || []).map(c => {
        const label = c.full_name ? `${c.full_name} (#${c.id})` : `Клиент #${c.id}`;
        return `<option value="${c.id}">${label}</option>`;
    }).join('');
}

// --- Toast Notification ---
window.showToast = function(msg) {
    let toast = document.getElementById('funko-global-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'funko-global-toast';
        toast.className = 'funko-toast';
        document.body.appendChild(toast);
    }
    toast.innerHTML = `<span class="funko-toast-icon">✓</span><span>${msg}</span>`;
    toast.classList.add('show');
    clearTimeout(window._toastTimeout);
    window._toastTimeout = setTimeout(() => {
        toast.classList.remove('show');
    }, 2400);
};

// --- Shopping Cart Engine ---
let funkoCart = [];

function loadCartFromStorage() {
    try {
        funkoCart = JSON.parse(localStorage.getItem('funko_cart') || '[]');
        if (!Array.isArray(funkoCart)) funkoCart = [];
    } catch (e) {
        funkoCart = [];
    }
    updateCartBadges();
}

function saveCartToStorage() {
    localStorage.setItem('funko_cart', JSON.stringify(funkoCart));
    updateCartBadges();
}

window.addToCart = function(productId, qty = 1) {
    const product = rawCatalogProducts.find(p => p.id === productId);
    if (!product) {
        window.showToast('Товар не найден');
        return;
    }
    const existing = funkoCart.find(item => item.id === productId);
    if (existing) {
        existing.qty += qty;
    } else {
        funkoCart.push({
            id: product.id,
            name: product.name,
            figure_number: product.figure_number || '',
            price: product.price,
            final_price: product.final_price || product.price,
            photo_id: product.photo_id || '',
            qty: qty
        });
    }
    saveCartToStorage();
    window.showToast(`«${product.name}» добавлен в корзину!`);

    // Bump badges
    document.querySelectorAll('.cart-badge-count').forEach(b => {
        b.classList.add('badge-bump');
        setTimeout(() => b.classList.remove('badge-bump'), 250);
    });
};

window.quickBuy = function(productId) {
    window.addToCart(productId, 1);
    window.openCheckoutModal();
};

window.updateCartItemQty = function(productId, delta) {
    const item = funkoCart.find(i => i.id === productId);
    if (!item) return;
    item.qty += delta;
    if (item.qty <= 0) {
        funkoCart = funkoCart.filter(i => i.id !== productId);
    }
    saveCartToStorage();
    renderCartModal();
};

window.removeFromCart = function(productId) {
    funkoCart = funkoCart.filter(i => i.id !== productId);
    saveCartToStorage();
    renderCartModal();
    window.showToast('Товар удален из корзины');
};

window.clearCart = function() {
    funkoCart = [];
    saveCartToStorage();
    renderCartModal();
    window.showToast('Корзина очищена');
};

function updateCartBadges() {
    const totalItems = funkoCart.reduce((sum, item) => sum + item.qty, 0);
    ['landing-cart-badge', 'catalog-cart-badge', 'floating-cart-badge', 'cart-modal-count-pill'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.textContent = `${totalItems}${id.includes('pill') ? ' шт.' : ''}`;
        }
    });

    const floatingBtn = document.getElementById('floating-cart-btn');
    if (floatingBtn) {
        if (totalItems > 0) {
            floatingBtn.classList.remove('hidden');
        } else {
            floatingBtn.classList.add('hidden');
        }
    }
}

function renderCartModal() {
    const listEl = document.getElementById('cart-items-list');
    const emptyEl = document.getElementById('cart-empty-view');
    const footerEl = document.getElementById('cart-summary-footer');
    const totalEl = document.getElementById('cart-total-display');
    const prepayEl = document.getElementById('cart-prepay-display');

    if (!listEl) return;

    if (funkoCart.length === 0) {
        listEl.innerHTML = '';
        if (emptyEl) emptyEl.classList.remove('hidden');
        if (footerEl) footerEl.classList.add('hidden');
        return;
    }

    if (emptyEl) emptyEl.classList.add('hidden');
    if (footerEl) footerEl.classList.remove('hidden');

    let totalPrice = 0;

    listEl.innerHTML = funkoCart.map(item => {
        const itemPrice = item.final_price || item.price;
        const lineTotal = itemPrice * item.qty;
        totalPrice += lineTotal;

        const photoSrc = item.photo_id 
            ? (item.photo_id.startsWith('http') || item.photo_id.startsWith('/static/') ? item.photo_id : `/api/photos/${item.photo_id}`)
            : '';
        const imgHtml = photoSrc 
            ? `<img class="cart-item-img" src="${photoSrc}" alt="${item.name}">` 
            : `<div class="cart-item-placeholder">📦</div>`;

        return `
            <div class="cart-item-row">
                ${imgHtml}
                <div class="cart-item-info">
                    <div class="cart-item-title">${item.figure_number ? `#${item.figure_number} ` : ''}${item.name}</div>
                    <div class="cart-item-sub">${itemPrice.toLocaleString('ru')} ₽ / шт.</div>
                </div>
                <div class="cart-qty-stepper">
                    <button type="button" class="cart-qty-btn" onclick="window.updateCartItemQty(${item.id}, -1)">−</button>
                    <span class="cart-qty-val">${item.qty}</span>
                    <button type="button" class="cart-qty-btn" onclick="window.updateCartItemQty(${item.id}, 1)">+</button>
                </div>
                <div class="cart-item-price">${lineTotal.toLocaleString('ru')} ₽</div>
                <button type="button" class="cart-remove-btn" onclick="window.removeFromCart(${item.id})" title="Удалить">✕</button>
            </div>
        `;
    }).join('');

    const prepay50 = Math.round(totalPrice * 0.5);
    if (totalEl) totalEl.textContent = `${totalPrice.toLocaleString('ru')} ₽`;
    if (prepayEl) prepayEl.textContent = `${prepay50.toLocaleString('ru')} ₽`;
}

window.openCartModal = function() {
    renderCartModal();
    openModal(document.getElementById('cart-modal'));
};

// --- Checkout & Strict Validation Engine ---
window.currentPaymentOption = '50%';
window.pendingCheckoutData = null;

window.selectPaymentOption = function(type) {
    window.currentPaymentOption = type;
    const card50 = document.getElementById('option-prepay-50');
    const card100 = document.getElementById('option-prepay-100');
    if (type === '50%') {
        if (card50) card50.classList.add('active');
        if (card100) card100.classList.remove('active');
    } else {
        if (card50) card50.classList.remove('active');
        if (card100) card100.classList.add('active');
    }
    updateCheckoutPayButton();
};

function updateCheckoutPayButton() {
    const total = funkoCart.reduce((sum, i) => sum + (i.final_price || i.price) * i.qty, 0);
    const dueAmount = window.currentPaymentOption === '50%' ? Math.round(total * 0.5) : total;
    const payBtnAmount = document.getElementById('checkout-pay-btn-amount');
    if (payBtnAmount) {
        payBtnAmount.textContent = `${dueAmount.toLocaleString('ru')} ₽`;
    }
}

window.openCheckoutModal = function() {
    if (funkoCart.length === 0) {
        window.openCartModal();
        return;
    }
    closeModals();

    const previewEl = document.getElementById('checkout-items-preview');
    if (previewEl) {
        const totalItems = funkoCart.reduce((s, i) => s + i.qty, 0);
        const totalPrice = funkoCart.reduce((s, i) => s + (i.final_price || i.price) * i.qty, 0);
        previewEl.innerHTML = `
            <div style="display:flex; justify-content:space-between; margin-bottom:6px; font-weight:700; color:#fff;">
                <span>В заказе: ${totalItems} шт.</span>
                <span>${totalPrice.toLocaleString('ru')} ₽</span>
            </div>
            <div style="display:flex; flex-direction:column; gap:4px; font-size:0.82rem; color:#aaa;">
                ${funkoCart.map(i => `<div>• ${i.name} × ${i.qty} шт. (${((i.final_price || i.price) * i.qty).toLocaleString('ru')} ₽)</div>`).join('')}
            </div>
        `;
    }

    const total = funkoCart.reduce((sum, i) => sum + (i.final_price || i.price) * i.qty, 0);
    const amount50El = document.getElementById('checkout-amount-50');
    const amount100El = document.getElementById('checkout-amount-100');
    if (amount50El) amount50El.textContent = `${Math.round(total * 0.5).toLocaleString('ru')} ₽`;
    if (amount100El) amount100El.textContent = `${total.toLocaleString('ru')} ₽`;

    window.selectPaymentOption('50%');

    // Prefill if customer is already logged in
    const fnInput = document.getElementById('checkout-first-name');
    const lnInput = document.getElementById('checkout-last-name');
    const phoneInput = document.getElementById('checkout-phone');
    const tgInput = document.getElementById('checkout-tg');
    const errBanner = document.getElementById('checkout-error-banner');
    if (errBanner) errBanner.classList.add('hidden');

    if (window.currentClientFullName) {
        const parts = window.currentClientFullName.trim().split(/\s+/);
        if (fnInput && !fnInput.value) fnInput.value = parts[0] || '';
        if (lnInput && !lnInput.value) lnInput.value = parts.slice(1).join(' ') || '';
    }
    if (window.currentClientPhone && phoneInput && !phoneInput.value) {
        phoneInput.value = window.currentClientPhone;
    }
    if (window.currentClientTg && tgInput && !tgInput.value) {
        tgInput.value = window.currentClientTg;
    }

    openModal(document.getElementById('checkout-modal'));
};

window.proceedToPayment = function(event) {
    if (event) event.preventDefault();

    const fnInput = document.getElementById('checkout-first-name');
    const lnInput = document.getElementById('checkout-last-name');
    const phoneInput = document.getElementById('checkout-phone');
    const tgInput = document.getElementById('checkout-tg');
    const deliveryInput = document.getElementById('checkout-delivery');
    const commentInput = document.getElementById('checkout-comment');
    const errBanner = document.getElementById('checkout-error-banner');

    const firstName = (fnInput?.value || '').trim();
    const lastName = (lnInput?.value || '').trim();
    const phone = (phoneInput?.value || '').trim();
    const tg = (tgInput?.value || '').trim();

    // Reset previous error classes
    [fnInput, lnInput, phoneInput, tgInput].forEach(inp => inp?.classList.remove('field-error'));
    if (errBanner) errBanner.classList.add('hidden');

    // STRICT VALIDATION: First Name, Last Name, Phone, and Telegram are MANDATORY
    let hasError = false;
    let firstInvalid = null;

    if (!firstName) {
        fnInput?.classList.add('field-error');
        hasError = true;
        if (!firstInvalid) firstInvalid = fnInput;
    }
    if (!lastName) {
        lnInput?.classList.add('field-error');
        hasError = true;
        if (!firstInvalid) firstInvalid = lnInput;
    }
    if (!phone || phone.length < 6) {
        phoneInput?.classList.add('field-error');
        hasError = true;
        if (!firstInvalid) firstInvalid = phoneInput;
    }
    if (!tg) {
        tgInput?.classList.add('field-error');
        hasError = true;
        if (!firstInvalid) firstInvalid = tgInput;
    }

    if (hasError) {
        if (errBanner) {
            errBanner.textContent = 'Обязательно укажите Имя, Фамилию, Телефон и Telegram для связи перед оплатой!';
            errBanner.classList.remove('hidden');
            errBanner.classList.add('shake-it');
            setTimeout(() => errBanner.classList.remove('shake-it'), 500);
        }
        if (firstInvalid) firstInvalid.focus();
        return false;
    }

    const total = funkoCart.reduce((sum, i) => sum + (i.final_price || i.price) * i.qty, 0);
    const dueAmount = window.currentPaymentOption === '50%' ? Math.round(total * 0.5) : total;

    window.pendingCheckoutData = {
        items: funkoCart.map(i => ({
            id: i.id,
            name: i.name,
            figure_number: i.figure_number || '',
            price: i.price,
            final_price: i.final_price || i.price,
            photo_id: i.photo_id || '',
            qty: i.qty
        })),
        first_name: firstName,
        last_name: lastName,
        customer_name: `${firstName} ${lastName}`.trim(),
        phone: phone,
        telegram: tg,
        payment_type: window.currentPaymentOption,
        delivery_method: deliveryInput?.value || 'СДЭК',
        comment: commentInput?.value || '',
        due_amount: dueAmount,
        total_price: total
    };

    // Populate payment modal
    const payDisplay = document.getElementById('payment-amount-display');
    if (payDisplay) {
        payDisplay.textContent = `${dueAmount.toLocaleString('ru')} ₽`;
    }

    closeModals();
    openModal(document.getElementById('payment-modal'));
    return false;
};

window.confirmOrderPayment = async function() {
    if (!window.pendingCheckoutData) {
        alert('Данные заказа не найдены. Пожалуйста, начните оформление заново.');
        return;
    }

    const payBtn = document.getElementById('confirm-pay-btn');
    if (payBtn) {
        payBtn.disabled = true;
        payBtn.textContent = 'Обработка платежа в Т-Банке...';
    }

    try {
        const headers = { 'Content-Type': 'application/json', 'X-Device-ID': getDeviceId() };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const res = await fetch(`${API_BASE}/checkout`, {
            method: 'POST',
            headers,
            body: JSON.stringify(window.pendingCheckoutData)
        });

        const data = await res.json();
        if (!res.ok) {
            throw new Error(data.detail || 'Ошибка проведения платежа');
        }

        // Success! Clear cart
        funkoCart = [];
        saveCartToStorage();

        closeModals();

        // Populate Success Modal
        const orderIdDisplay = document.getElementById('success-order-id');
        const credBox = document.getElementById('success-credentials-box');
        const clientIdDisplay = document.getElementById('success-client-id');
        const passwordDisplay = document.getElementById('success-password');
        const botLink = document.getElementById('success-tg-bot-link');

        if (orderIdDisplay) orderIdDisplay.textContent = `#${data.order_id}`;

        if (data.is_new_client) {
            if (credBox) credBox.classList.remove('hidden');
            if (clientIdDisplay) clientIdDisplay.textContent = data.client_id;
            if (passwordDisplay) passwordDisplay.textContent = data.password;
            window.lastCreatedClientToken = data.token;
        } else {
            if (credBox) credBox.classList.add('hidden');
            window.lastCreatedClientToken = null;
        }

        if (botLink) {
            botLink.href = `https://t.me/funkostop_bot?start=order_${data.order_id}`;
        }

        openModal(document.getElementById('order-success-modal'));
    } catch (err) {
        alert('Ошибка при оформлении заказа: ' + err.message);
    } finally {
        if (payBtn) {
            payBtn.disabled = false;
            payBtn.textContent = 'Подтвердить и оплатить заказ ✓';
        }
    }
};

window.autoLoginFromSuccess = async function() {
    if (window.lastCreatedClientToken) {
        token = window.lastCreatedClientToken;
        localStorage.setItem('funko_token', token);
        closeModals();
        await loadDashboardData();
        window.switchTab('orders');
    } else {
        closeModals();
        window.switchTab('orders');
    }
};

// Initialize application
initSidebar();
init();

