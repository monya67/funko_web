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
let deleteProductTargetId = null;
let isSidebarCollapsed = localStorage.getItem('funko_sidebar_collapsed') === 'true';

// Global toggles
window.marginMode = 'rub';
window.taxesExpanded = false;

// New orders tracking
function getSeenOrderIds() {
    try { return new Set(JSON.parse(localStorage.getItem('funko_seen_order_ids') || '[]')); } catch { return new Set(); }
}
function markOrdersSeen(orderIds) {
    const seen = getSeenOrderIds();
    orderIds.forEach(id => seen.add(id));
    try { localStorage.setItem('funko_seen_order_ids', JSON.stringify([...seen])); } catch {}
}
function updateOrdersBadge() {
    if (currentRole !== 'admin') return;
    const seen = getSeenOrderIds();
    const newCount = rawActiveOrders.filter(o => !seen.has(o.id)).length;
    const badge = document.getElementById('orders-new-badge');
    if (!badge) return;
    if (newCount > 0) {
        badge.textContent = newCount;
        badge.classList.remove('hidden');
    } else {
        badge.classList.add('hidden');
    }    const profileBtn = document.getElementById('profile-menu-btn');
    profileBtn?.classList.toggle('has-new', newCount > 0);
    const bar = document.getElementById('orders-new-badge-bar');
    if (bar) { bar.textContent = newCount; bar.classList.toggle('hidden', newCount === 0); }
    profileBtn?.setAttribute('aria-label', newCount > 0 ? `Профиль, новых заказов: ${newCount}` : 'Профиль');
}

// Global Mass Edit Functions (defined early so they are available immediately)
window.updateMassEditPanel = function(tab) {
    const checkboxes = document.querySelectorAll(`.${tab}-row-checkbox:checked`);
    const countSpan = document.getElementById(`${tab}-mass-edit-count`);
    const btn = document.getElementById(`${tab}-mass-edit-btn`);
    const count = checkboxes.length;
    
    if (countSpan) {
        countSpan.textContent = `Выбрано заказов: ${count} шт.`;
        countSpan.style.color = count > 0 ? 'var(--ok)' : 'var(--ink)';
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
    window.initCookieConsent();
    loadCartFromStorage();
    loadCatalogMeta();
    loadCatalog();

    const initialTab = getTabFromURL();

    if (token) {
        loadDashboardData().then(() => {
            window.switchTab(initialTab, false);
        }).catch(() => {
            handleLogout();
        });
        startHeartbeat();
    } else {
        updateRoleUI('guest');
        const guestAllowed = ['home', 'catalog'];
        window.switchTab(guestAllowed.includes(initialTab) ? initialTab : 'home', false);
    }

    history.replaceState({ tab: initialTab }, '', window.location.pathname + window.location.search + window.location.hash);
    const anchor = window.location.hash && document.getElementById(window.location.hash.slice(1));
    if (anchor && document.getElementById('home-tab').contains(anchor)) {
        setTimeout(() => anchor.scrollIntoView({ behavior: 'instant' }), 0);
    }
}

function updateRoleUI(role) {
    currentRole = role;
    if (typeof renderHomeNew === 'function') renderHomeNew();
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

// Clients who get the catalog before it opens for everyone (client ids)
const CATALOG_PREVIEW_CLIENT_IDS = [184];
function catalogOpenForMe() {
    return currentRole === 'admin' || (currentRole === 'client' && CATALOG_PREVIEW_CLIENT_IDS.includes(Number(currentClientId)));
}

window.updateCatalogDevMode = function() {
    const devBanner = document.getElementById('catalog-guest-under-dev');
    const catalogHeader = document.getElementById('catalog-header-bar');
    const catalogBody = document.getElementById('catalog-body-layout');
    const adminNotice = document.getElementById('catalog-admin-dev-notice');
    const catalogCartBtn = document.querySelector('.catalog-btn-cart');
    const viewToggle = document.getElementById('catalog-view-toggle');

    if (catalogOpenForMe()) {
        if (devBanner) devBanner.classList.add('hidden');
        if (catalogHeader) catalogHeader.style.display = 'flex';
        if (catalogBody) catalogBody.style.display = 'grid';
        if (adminNotice) adminNotice.classList.toggle('hidden', currentRole !== 'admin');
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
    window.currentClientPhone = window.currentClientTg = window.currentClientEmail = null;
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

// 'paid_amount' is the sum the client has to pay; until the bank confirms it, show it as awaited, not as paid
function paidCell(order) {
    const sum = `${(order.paid_amount || 0).toLocaleString('ru')} &#8381;`;
    if (order.status === 'Ожидает оплаты') return `<td style="white-space:nowrap; color:var(--muted);" title="Ждём оплату">ждём ${sum}</td>`;
    return `<td style="white-space:nowrap;">${sum}</td>`;
}

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
            const errData = await res.json().catch(() => ({}));
            if (res.status >= 500 || res.status === 429 || !errData.detail && res.status !== 401) throw new Error('Сервер временно недоступен, попробуйте через минуту');
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

// URL routing
const TAB_ROUTES = {
    home: '/',
    catalog: '/catalog',
    orders: '/orders',
    archived: '/archive',
    accounting: '/accounting',
    clients: '/clients',
    products: '/products',
    purchases: '/purchases',
    promocodes: '/promocodes'
};
const ROUTE_TO_TAB = {};
Object.entries(TAB_ROUTES).forEach(([tab, path]) => { ROUTE_TO_TAB[path] = tab; });

function getTabFromURL() {
    const path = window.location.pathname;
    return ROUTE_TO_TAB[path] || 'home';
}

// Navigation between tabs with smooth page transition animations
window.switchTab = function(tabName, pushState = true) {
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
        if (catalogOpenForMe() && rawCatalogProducts.length === 0) {
            loadCatalog();
            loadCatalogMeta();
        }
    }
    if (tabName === 'product') {
        // highlight catalog nav item as active for product page
        navItems.forEach(nav => {
            if (nav.getAttribute('data-tab') === 'catalog') nav.classList.add('active');
        });
    }
    if (tabName === 'orders' && currentRole === 'admin') {
        markOrdersSeen(rawActiveOrders.map(o => o.id));
        updateOrdersBadge();
        renderOrders();
    }
    if (tabName === 'products' && currentRole === 'admin') {
        loadCatalog();
        renderProductsAdmin();
    }
    if ((tabName === 'purchases' || tabName === 'promocodes') && currentRole === 'admin') {
        loadRegister(tabName);
    }
    if (tabName === 'accounting' && currentRole === 'admin') {
        loadFinance();
        loadLedger();
    }

    if (pushState) {
        const url = TAB_ROUTES[tabName] || '/';
        if (window.location.pathname + window.location.search !== url) {
            history.pushState({ tab: tabName }, '', url);
        }
    }

    window.scrollTo({ top: 0, behavior: 'auto' });
};

window.addEventListener('popstate', (e) => {
    const tab = (e.state && e.state.tab) ? e.state.tab : getTabFromURL();
    if (tab === 'product' && e.state && e.state.product) {
        window.openProductDetail(e.state.product);
        return;
    }
    window.switchTab(tab, false);
});

navItems.forEach(item => {
    item.addEventListener('click', (e) => {
        e.preventDefault();
        const tabName = item.getAttribute('data-tab');
        if (tabName) window.switchTab(tabName);
    });
});

// --- Top bar: profile dropdown, burger menu, home anchors, header search ---
const profileBtn = document.getElementById('profile-menu-btn');
const profileMenu = document.getElementById('profile-menu');
const siteMenuToggle = document.getElementById('site-menu-toggle');
const siteNav = document.getElementById('site-nav');

function setProfileMenu(open) {
    profileMenu.classList.toggle('hidden', !open);
    profileBtn.setAttribute('aria-expanded', String(open));
}
function setSiteNav(open) {
    siteNav.classList.toggle('open', open);
    siteMenuToggle.setAttribute('aria-expanded', String(open));
}
profileBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setProfileMenu(profileMenu.classList.contains('hidden'));
});
siteMenuToggle.addEventListener('click', () => setSiteNav(!siteNav.classList.contains('open')));
document.addEventListener('click', (e) => {
    if (!profileMenu.contains(e.target)) setProfileMenu(false);
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { setProfileMenu(false); setSiteNav(false); }
});
profileMenu.querySelectorAll('a, button').forEach(el => el.addEventListener('click', () => setProfileMenu(false)));
siteNav.querySelectorAll('a').forEach(el => el.addEventListener('click', () => setSiteNav(false)));
document.querySelectorAll('[data-home-anchor]').forEach(a => a.addEventListener('click', (e) => {
    e.preventDefault();
    window.switchTab('home');
    document.getElementById(a.dataset.homeAnchor)?.scrollIntoView({ behavior: 'smooth' });
}));
document.getElementById('header-search')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    window.switchTab('catalog');
    const target = document.getElementById('catalog-search');
    target.value = e.target.value;
    target.dispatchEvent(new Event('input', { bubbles: true }));
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
            window.currentClientPhone = data.phone || '';
            window.currentClientTg = data.tg_username || '';
            window.currentClientEmail = data.email || '';
        }
        updateRoleUI(data.role);
        if (data.online_count) updateOnlineBadge(data.online_count);
        rawActiveOrders = data.orders || [];
        rawArchivedOrders = data.archived || [];
        allOrders = [...rawActiveOrders, ...rawArchivedOrders];
        populateYearFilters(rawActiveOrders, rawArchivedOrders);
        updateOrdersBadge();
        renderOrders();
        renderArchivedOrders();
        if (data.role === 'admin') {
            renderClients(data.clients);
            renderAccounting();
            loadLedger();
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
    'Ожидает оплаты',
    'Заказ принят в обработку',
    'Заказ ожидает отправки из магазина',
    'Заказ едет на склад США',
    'Заказ начал сортировку на складе США',
    'Ожидает рассылки из США',
    'Заказ отправлен из США на наш склад в Россию',
    'Ожидает выхода в продажу',
    'Заказ проходит таможенное оформление',
    'Заказ прибыл в магазин и готов к выдаче',
    'Выдано'
];

function makeInlineStatusCell(order) {
    // a status the list does not know (older or custom) must still show up as the selected one, not as the first option
    const known = ALL_STATUSES_LIST.includes(order.status) ? ALL_STATUSES_LIST : [order.status, ...ALL_STATUSES_LIST];
    const opts = known.map(s =>
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
        const presetSizes = Array.from(sizeBtns).map(b => parseInt(b.getAttribute('data-size')));
        if (!presetSizes.includes(state.pageSize)) {
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

    const seenIds = getSeenOrderIds();
    pageOrders.forEach((order, i) => {
        const tr = document.createElement('tr');
        const isNew = role === 'admin' && !seenIds.has(order.id);
        tr.className = 'row-animate' + (isNew ? ' new-order-row' : '');
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
        html += paidCell(order);

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
        html += paidCell(order);
        html += `<td><span class="status-badge" style="background:rgba(0,200,80,0.15);color:var(--ok);">${order.status}</span></td>`;

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
        const emailDisplay = client.email ? escapeHtml(client.email) : '—';
        const tgDisplay = (client.tg_username || client.user_tg_id) 
            ? (client.tg_username ? (client.tg_username.startsWith('@') ? client.tg_username : `@${client.tg_username}`) : `ID: ${client.user_tg_id}`)
            : '—';

        tr.innerHTML = `
            <td style="text-align:center;color:var(--gray-light);font-size:0.85rem;font-weight:600;">${i + 1}</td>
            <td style="font-weight:700; color:var(--ink);">${client.id}</td>
            <td style="font-weight:600; color:var(--ink);">${fnDisplay}</td>
            <td style="font-weight:600; color:var(--ink);">${lnDisplay}</td>
            <td style="color:var(--ink); font-size:0.88rem;">${phoneDisplay}</td>
            <td style="color:${tgDisplay !== '—' ? '#1C6EA4' : 'var(--gray-light)'};">${tgDisplay}</td>
            <td style="color:var(--ink); font-size:0.88rem;">${emailDisplay}</td>
            <td style="font-family:monospace; color:var(--muted);">${escapeHtml(client.password)}</td>
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

// Money of one order: taxes and margin in rubles. Margin is negative when costs exceed the price.
function orderFinance(o) {
    const cost = o.cost_price || 0;
    const delivery = o.delivery_cost || 0;
    const price = o.total_price || 0;
    const usn = price * 0.06;
    const checks = price * 0.015;
    const acquiring = price * 0.02;
    const totalTax = usn + checks + acquiring;
    const margin = price - cost - delivery - totalTax;
    return { cost, delivery, price, usn, checks, acquiring, totalTax, margin };
}

// An order's margin counts in the accounting totals once both its cost and its delivery are filled in
function orderMarginCounts(o) {
    return (o.cost_price || 0) > 0 && (o.delivery_cost || 0) > 0;
}

function accountingPeriodOrders() {
    return filterByDate([...allOrders], 'accounting-year-filter', 'accounting-month-filter');
}

function renderAccounting() {
    if (!accountingTableBody) return;
    accountingTableBody.innerHTML = '';
    const emptyMsg = document.getElementById('no-accounting');

    let orders = accountingPeriodOrders();
    renderLedger();

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
        const f = orderFinance(o);
        const rub = f.margin.toLocaleString('ru', {maximumFractionDigits: 0}) + ' ₽';
        let marginVal = f.margin;
        let marginDisplay = rub;
        if (window.marginMode === 'percent') {
            if (f.price > 0) {
                marginVal = (f.margin / f.price) * 100;
                marginDisplay = marginVal.toFixed(1) + '%';
            }
            // no price: a percentage means nothing, the loss is shown in rubles
            else marginVal = f.margin < 0 ? -Infinity : 0;
        }
        return { ...o, ...f, marginVal, marginDisplay, marginSign: Math.sign(Math.round(f.margin)) };
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
            : `<div style="width:44px;height:44px;border-radius:5px;background:var(--card);flex-shrink:0;"></div>`;

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
            <td class="inline-edit-cell" style="white-space:nowrap;" title="Нажмите для редактирования" onclick="window.startInlineEdit(${order.id}, 'cost_price', ${order.cost}, this)">${order.cost.toLocaleString('ru')} &#8381;</td>
            <td class="inline-edit-cell" style="white-space:nowrap;" title="Нажмите для редактирования" onclick="window.startInlineEdit(${order.id}, 'delivery_cost', ${order.delivery}, this)">${order.delivery.toLocaleString('ru')} &#8381;</td>
            ${paidCell(order)}
            <td style="color:var(--pre);font-weight:bold;white-space:nowrap;">${order.totalTax.toLocaleString('ru', {maximumFractionDigits:0})} &#8381;</td>
            <td class="tax-column ${window.taxesExpanded ? '' : 'hidden'}" style="white-space:nowrap;">${order.usn.toLocaleString('ru', {maximumFractionDigits:0})} &#8381;</td>
            <td class="tax-column ${window.taxesExpanded ? '' : 'hidden'}" style="white-space:nowrap;">${order.checks.toLocaleString('ru', {maximumFractionDigits:0})} &#8381;</td>
            <td class="tax-column ${window.taxesExpanded ? '' : 'hidden'}" style="white-space:nowrap;">${order.acquiring.toLocaleString('ru', {maximumFractionDigits:0})} &#8381;</td>
            <td style="color:${order.marginSign < 0 ? 'var(--pre)' : order.marginSign > 0 ? 'var(--ok)' : 'var(--muted)'};font-weight:bold;white-space:nowrap;">${order.marginDisplay}</td>
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
    // Clear ?product= from URL if product detail was open
    const url = new URL(window.location.href);
    if (url.searchParams.has('product')) {
        url.searchParams.delete('product');
        history.pushState({ tab: 'catalog' }, '', url.toString());
    }
}
window.openModal = openModal;
window.closeModals = closeModals;

if (modalOverlay) {
    modalOverlay.addEventListener('click', (e) => {
        if (e.target === modalOverlay) closeModals();
    });
}
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModals();
});
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
    const email = document.getElementById('new-client-email')?.value.trim() || '';

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
                tg_username: tg,
                email: email
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
    const emailEdit = document.getElementById('edit-client-email');
    if (emailEdit) emailEdit.value = client.email || '';
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
    const email = document.getElementById('edit-client-email')?.value.trim() || '';
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
                email: email,
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
        // the server may answer with an HTML page (restart, proxy error): never let JSON parsing hide that
        const raw = await res.text();
        let data = {};
        try { data = JSON.parse(raw); } catch (_) {}
        if (!res.ok || !data.photo_id) throw new Error(data.detail || `Фото не загрузилось (ответ сервера ${res.status}). Попробуйте ещё раз через минуту.`);
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
const catalogBodyLayout = document.getElementById('catalog-body-layout');

function updateLayoutClass() {
    if (isSidebarCollapsed) {
        catalogBodyLayout?.classList.add('sidebar-hidden');
    } else {
        catalogBodyLayout?.classList.remove('sidebar-hidden');
    }
}

function initSidebar() {
    if (isSidebarCollapsed) {
        catalogFilterSidebar?.classList.add('collapsed');
        sidebarOpenBtn?.classList.remove('hidden');
    } else {
        catalogFilterSidebar?.classList.remove('collapsed');
        sidebarOpenBtn?.classList.add('hidden');
    }
    updateLayoutClass();
}

sidebarToggleBtn?.addEventListener('click', () => {
    catalogFilterSidebar?.classList.add('collapsed');
    sidebarOpenBtn?.classList.remove('hidden');
    isSidebarCollapsed = true;
    localStorage.setItem('funko_sidebar_collapsed', 'true');
    updateLayoutClass();
});

sidebarOpenBtn?.addEventListener('click', () => {
    catalogFilterSidebar?.classList.remove('collapsed');
    sidebarOpenBtn?.classList.add('hidden');
    isSidebarCollapsed = false;
    localStorage.setItem('funko_sidebar_collapsed', 'false');
    updateLayoutClass();
});


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
        renderHomeNew();
    } catch (err) {
        console.error('Error loading catalog meta:', err);
    }
}

// --- Catalog Loading ---
async function loadCatalog() {
    try {
        const data = await fetchAPI('/catalog');
        rawCatalogProducts = data.products || [];
        syncCartWithCatalog();
        renderProductsAdmin();
        renderBrandCards();
        renderSidebarFilters();
        renderFranchiseChips();
        renderCatalog();
        renderHomeNew();
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
const ICON_CART = '<svg aria-hidden="true" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"></circle><circle cx="20" cy="21" r="1"></circle><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"></path></svg>';
const ICON_IMAGE = '<svg aria-hidden="true" width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3" y="3" width="18" height="18" rx="1"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>';

// Products opened by a private link are kept apart so they never show up in the catalog grid.
const linkedProducts = [];
function findProduct(id) {
    return rawCatalogProducts.find(p => p.id === id) || linkedProducts.find(p => p.id === id);
}

function stockInfo(p) {
    const tracked = p.stock_qty !== null && p.stock_qty !== undefined;
    return { tracked, qty: tracked ? p.stock_qty : null, sold: tracked && p.stock_qty <= 0, few: tracked && p.stock_qty > 0 && p.stock_qty <= 5 };
}

function photoIds(value) { return (value || '').split(',').map(s => s.trim()).filter(Boolean); }
function photoUrl(id) { return id.startsWith('http') || id.startsWith('/static/') ? id : `/api/photos/${id}`; }

function productCard(p) {
    const card = document.createElement('article');
    card.className = 'product-card';
    card.addEventListener('click', () => window.openProductDetail(p.id));

    const ids = photoIds(p.photo_id);
    const photoSrc = ids[0] ? photoUrl(ids[0]) : '';
    const imgHtml = photoSrc
        ? `<img src="${photoSrc}" alt="${p.name}" loading="lazy">` + (ids[1] ? `<img class="alt" src="${photoUrl(ids[1])}" alt="" loading="lazy" aria-hidden="true">` : '')
        : `<div class="product-image-placeholder">${ICON_IMAGE}<span>Фото скоро</span></div>`;
    const st = stockInfo(p);
    const stockTag = st.sold ? ''
        : p.in_stock ? '<span class="card-tag-stock">В наличии</span>'
        : '<span class="card-tag-pre">Предзаказ</span>';
    const discountTag = p.discount_percent > 0 ? `<span class="card-tag-discount">−${p.discount_percent}%</span>` : '';
    const badgeTag = p.badge ? `<span class="card-tag-badge">${p.badge}</span>` : '';
    const hiddenTag = p.hidden ? '<span class="card-tag-hidden">Скрыт</span>' : '';
    const finalPrice = (p.final_price || p.price).toLocaleString('ru');
    const oldPrice = p.discount_percent > 0 ? `<span class="price-original">${p.price.toLocaleString('ru')} ₽</span>` : '';
    const adminButtons = currentRole === 'admin' ? `
        <div class="card-image-overlay">
            <button type="button" class="card-overlay-btn icon" aria-label="Редактировать" onclick="event.stopPropagation(); window.openEditProductModal(${p.id})">✎</button>
            <button type="button" class="card-overlay-btn icon danger" aria-label="Удалить" onclick="event.stopPropagation(); window.confirmDeleteProduct(${p.id})">✕</button>
        </div>` : '';

    card.innerHTML = `
        <div class="card-tags">${stockTag}${discountTag}${badgeTag}${hiddenTag}</div>
        <div class="product-image-box">${imgHtml}${adminButtons}</div>
        <div class="product-card-body">
            <div class="product-card-brand">${p.category || ''}</div>
            <div class="product-card-title" title="${p.name}">${p.figure_number ? `<span class="card-number">#${p.figure_number}</span> ` : ''}${p.name}</div>
            ${st.sold ? '' : '<div class="card-prepay">Предоплата 50%</div>'}
            ${st.few ? `<div class="card-left">Осталось ${st.qty} шт.</div>` : ''}
            <div class="product-card-price-row">
                <div class="price-group">${st.sold ? '<span class="price-sold">Распродан</span>' : `<span class="price-final">${finalPrice} ₽</span>${oldPrice}`}</div>
                <button type="button" class="card-cart-btn" aria-label="${st.sold ? 'Распродан' : 'В корзину'}" ${st.sold ? 'disabled' : ''} onclick="event.stopPropagation(); window.addToCart(${p.id}, 1)">${ICON_CART}</button>
            </div>
        </div>`;
    return card;
}


let homeNewCategory = '';

function renderHomeNew() {
    const grid = document.getElementById('home-new-grid');
    const tabs = document.getElementById('home-new-tabs');
    if (!grid || !tabs) return;
    const categories = ['', ...(catalogMeta.categories || [])];
    tabs.replaceChildren(...categories.map(c => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'franchise-chip' + (c === homeNewCategory ? ' active' : '');
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-selected', String(c === homeNewCategory));
        b.textContent = c || 'Все';
        b.addEventListener('click', () => { homeNewCategory = c; renderHomeNew(); });
        return b;
    }));
    const open = catalogOpenForMe();
    document.getElementById('home-new-stub')?.classList.toggle('hidden', open);
    tabs.classList.toggle('hidden', !open);
    grid.classList.toggle('hidden', !open);
    const items = open ? rawCatalogProducts
        .filter(p => !homeNewCategory || (p.category || '').toLowerCase() === homeNewCategory.toLowerCase())
        .slice(0, 5) : [];
    grid.replaceChildren(...items.map(productCard));
}

function renderCatalog() {
    if (!catalogGrid) return;
    catalogGrid.innerHTML = '';
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

    if (products.length === 0) {
        if (emptyMsg) {
            emptyMsg.innerHTML = `
                <div style="padding: 48px 20px; text-align: center;">
                    <div style="font-size: 1.15rem; font-weight: 600; color: var(--ink); margin-bottom: 8px;">В каталоге пока нет товаров</div>
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

    pageProducts.forEach((p, i) => {
        const card = productCard(p);
        card.style.animationDelay = `${i * 0.06}s`;
        catalogGrid.appendChild(card);
    });


    updatePaginationUI('catalog', products.length);

    openProductFromUrl();
}

// --- Product Page ---
window._ppCurrentId = null;

window.openProductDetail = function(productId) {
    const p = findProduct(productId);
    if (!p) return;
    window._ppCurrentId = productId;

    const ids = photoIds(p.photo_id);
    const photoSrc = ids[0] ? photoUrl(ids[0]) : '';

    const img = document.getElementById('pp-img');
    const placeholder = document.getElementById('pp-img-placeholder');
    if (photoSrc) {
        img.src = photoSrc;
        img.alt = p.name;
        img.style.display = 'block';
        if (placeholder) placeholder.style.display = 'none';
    } else {
        img.style.display = 'none';
        if (placeholder) placeholder.style.display = 'flex';
    }

    const descEl = document.getElementById('pp-description');
    descEl.textContent = (p.description || '').trim();
    descEl.classList.toggle('hidden', !descEl.textContent);
    setupProductGallery(ids, p.name);
    document.getElementById('pp-breadcrumb-name').textContent = p.name;
    document.getElementById('pp-tags').innerHTML =
        (p.category ? `<span class="card-tag">${p.category}</span>` : '') +
        (p.series   ? `<span class="card-tag series">${p.series}</span>` : '');
    document.getElementById('pp-number').textContent = p.figure_number ? `#${p.figure_number}` : '';
    document.getElementById('pp-title').textContent = p.name;

    const finalPrice = (p.final_price || p.price).toLocaleString('ru');
    const origPrice = p.price.toLocaleString('ru');
    const priceRow = document.getElementById('pp-price-row');
    const soldOut = stockInfo(p).sold;
    if (soldOut) {
        priceRow.innerHTML = '<span class="price-sold">Распродан</span>';
    } else if (p.discount_percent > 0) {
        priceRow.innerHTML = `<span>${finalPrice} ₽</span> <span style="font-size:1.1rem;font-weight:400;text-decoration:line-through;color:var(--gray);margin-left:10px;">${origPrice} ₽</span> <span style="font-size:0.9rem;color:var(--accent);margin-left:8px;font-weight:600;">-${p.discount_percent}%</span>`;
    } else {
        priceRow.innerHTML = `<span>${finalPrice} ₽</span>`;
    }

    const half = Math.round((p.final_price || p.price) * 0.5).toLocaleString('ru');
    document.getElementById('pp-prepay').innerHTML = `<strong>Предоплата 50%</strong><span>Внесите ${half} ₽ сейчас, остальное при получении. Цена фиксируется после предоплаты.</span>`;
    document.getElementById('pp-stock').innerHTML = p.in_stock
        ? `<span style="color:var(--ok);">● В наличии</span>`
        : `<span style="color:var(--warn);">● Под заказ</span>`;

    const actions = document.getElementById('pp-actions');
    const role = currentRole;
    const st = stockInfo(p);
    if (st.sold) document.getElementById('pp-stock').innerHTML = '<span style="color:var(--pre);">● Распродан</span>';
    else if (st.few) document.getElementById('pp-stock').innerHTML = `<span style="color:var(--warn);">● Осталось ${st.qty} шт.</span>`;
    const addBtn = `<button type="button" class="btn primary pp-btn" ${st.sold ? 'disabled' : ''} onclick="window.addToCart(${p.id},1)">${st.sold ? 'Распродан' : 'В корзину'}</button>`;
    if (role === 'admin') {
        actions.innerHTML = `
            ${addBtn}
            <button type="button" class="btn secondary outline pp-btn" onclick="window.openEditProductModal(${p.id})">Редактировать</button>
            <button type="button" class="btn danger outline pp-btn" onclick="window.confirmDeleteProduct(${p.id})">Удалить</button>`;
    } else {
        actions.innerHTML = `
            ${addBtn}
            <button type="button" class="btn secondary outline pp-btn" ${st.sold ? 'disabled' : ''} onclick="window.quickBuy(${p.id})">Купить сразу</button>`;
    }

    // Update URL and switch to product page tab
    const urlKey = new URLSearchParams(window.location.search).get('k') || (p.hidden && p.link_key ? p.link_key : '');
    history.pushState({ tab: 'product', product: productId }, '', `/catalog?product=${productId}${urlKey ? `&k=${encodeURIComponent(urlKey)}` : ''}`);
    window.switchTab('product', false);
};

function setupProductGallery(ids, name) {
    const img = document.getElementById('pp-img');
    const thumbs = document.getElementById('pp-thumbs');
    const prev = document.getElementById('pp-prev');
    const next = document.getElementById('pp-next');
    const multi = ids.length > 1;
    thumbs.classList.toggle('hidden', !multi);
    prev.classList.toggle('hidden', !multi);
    next.classList.toggle('hidden', !multi);
    thumbs.replaceChildren();
    if (!multi) return;
    let cur = 0;
    const show = (i) => {
        cur = (i + ids.length) % ids.length;
        img.src = photoUrl(ids[cur]);
        img.alt = name;
        [...thumbs.children].forEach((b, k) => { b.classList.toggle('active', k === cur); b.setAttribute('aria-current', String(k === cur)); });
    };
    ids.forEach((id, k) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('aria-label', `Фото ${k + 1}`);
        const t = document.createElement('img');
        t.src = photoUrl(id); t.alt = ''; t.loading = 'lazy';
        b.appendChild(t);
        b.addEventListener('click', () => show(k));
        thumbs.appendChild(b);
    });
    prev.onclick = () => show(cur - 1);
    next.onclick = () => show(cur + 1);
    show(0);
}

window.closeProductPage = function() {
    window.switchTab('catalog', true);
};

// --- Copy Product Link ---
window.copyProductLink = function(productId) {
    const p = findProduct(productId);
    const key = p && p.hidden && p.link_key ? `&k=${encodeURIComponent(p.link_key)}` : '';
    const url = `${window.location.origin}/catalog?product=${productId}${key}`;
    navigator.clipboard.writeText(url).then(() => {
        window.showToast('Ссылка скопирована');
    }).catch(() => {
        prompt('Скопируй ссылку:', url);
    });
};

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
        if (photoIds(p.photo_id)[0]) {
            img.src = photoUrl(photoIds(p.photo_id)[0]);
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
    document.getElementById('product-availability').value = 'preorder';
    document.getElementById('product-packs').value = '0';
    document.getElementById('product-stock-qty').value = '';
    document.getElementById('product-hidden').checked = false;
    document.getElementById('product-discount').value = '0';
    document.getElementById('product-badge').value = '';
    document.getElementById('product-photo-id').value = '';
    document.getElementById('product-description').value = '';
    fillProductFinance({});
    renderProductPhotoThumbs();
    openModal(productModal);
};

// Description written by the AI from the product's name, number, brand and series; the admin edits it before saving
async function generateProductDescription({ silent = false } = {}) {
    const btn = document.getElementById('product-desc-ai');
    const area = document.getElementById('product-description');
    const name = document.getElementById('product-name').value.trim();
    if (!name) { if (!silent) alert('Сначала укажите название товара'); return; }
    if (btn.disabled) return;
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Пишу…';
    area.classList.add('ai-busy');
    try {
        const data = await fetchAPI('/ai/describe', { method: 'POST', body: JSON.stringify({
            name,
            figure_number: document.getElementById('product-figure-number').value.trim(),
            category: document.getElementById('product-category').value.trim(),
            series: document.getElementById('product-series').value.trim(),
            badge: (document.getElementById('product-badge')?.value || '').trim()
        }) });
        // never overwrite what the admin typed while the request was running
        if (!silent || !area.value.trim()) area.value = data.description;
    } catch (err) {
        if (!silent) alert(err.message);
    } finally {
        btn.disabled = false; btn.textContent = label;
        area.classList.remove('ai-busy');
    }
}
document.getElementById('product-desc-ai')?.addEventListener('click', () => generateProductDescription());
// a new product gets a draft description by itself once its name is filled in and the description is still empty
document.getElementById('product-name')?.addEventListener('change', () => {
    const isNew = !document.getElementById('product-id').value;
    if (isNew && !document.getElementById('product-description').value.trim()) generateProductDescription({ silent: true });
});

// Private purchase data of a product (admins only receive these fields from the server)
function fillProductFinance(p) {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = (v === null || v === undefined) ? '' : v; };
    set('product-purchase-usd', p.purchase_usd);
    set('product-shipping-rub', p.planned_shipping_rub);
    set('product-source', p.purchase_source);
    set('product-kind', p.product_kind);
}

function readProductFinance() {
    const val = id => (document.getElementById(id)?.value ?? '').trim();
    const usd = parseFloat(val('product-purchase-usd').replace(',', '.'));
    const ship = parseInt(val('product-shipping-rub'), 10);
    return {
        purchase_usd: usd > 0 ? usd : null,
        planned_shipping_rub: ship > 0 ? ship : null,
        purchase_source: val('product-source'),
        product_kind: val('product-kind')
    };
}

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
    document.getElementById('product-stock-qty').value = (p.stock_qty === null || p.stock_qty === undefined) ? '' : p.stock_qty;
    document.getElementById('product-hidden').checked = !!p.hidden;
    document.getElementById('product-availability').value = p.in_stock ? 'instock' : 'preorder';
    document.getElementById('product-photo-id').value = p.photo_id || '';
    document.getElementById('product-badge').value = p.badge || '';
    
    document.getElementById('product-description').value = p.description || '';
    fillProductFinance(p);
    renderProductPhotoThumbs();
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
const MAX_PRODUCT_PHOTOS = 6;
function renderProductPhotoThumbs() {
    const input = document.getElementById('product-photo-id');
    const box = document.getElementById('product-photo-thumbs');
    const ids = photoIds(input.value);
    box.replaceChildren(...ids.map((id, i) => {
        const wrap = document.createElement('div');
        wrap.className = 'photo-thumb';
        const im = document.createElement('img');
        im.src = photoUrl(id); im.alt = `Фото ${i + 1}`;
        const rm = document.createElement('button');
        rm.type = 'button'; rm.className = 'photo-thumb-remove'; rm.setAttribute('aria-label', `Убрать фото ${i + 1}`); rm.textContent = '×';
        rm.addEventListener('click', () => { input.value = ids.filter((_, k) => k !== i).join(','); renderProductPhotoThumbs(); });
        wrap.append(im, rm);
        if (i > 0) {
            const first = document.createElement('button');
            first.type = 'button'; first.className = 'photo-thumb-first'; first.title = 'Сделать главным'; first.textContent = '★';
            first.addEventListener('click', () => { input.value = [id, ...ids.filter((_, k) => k !== i)].join(','); renderProductPhotoThumbs(); });
            wrap.appendChild(first);
        } else {
            const tag = document.createElement('span');
            tag.className = 'photo-thumb-main'; tag.textContent = 'главное';
            wrap.appendChild(tag);
        }
        return wrap;
    }));
    document.querySelector('label[for="product-photo-upload"]')?.classList.toggle('disabled', ids.length >= MAX_PRODUCT_PHOTOS);
}
document.getElementById('product-photo-id')?.addEventListener('input', renderProductPhotoThumbs);

const productPhotoUpload = document.getElementById('product-photo-upload');
if (productPhotoUpload) {
    productPhotoUpload.addEventListener('change', async (e) => {
        const input = document.getElementById('product-photo-id');
        const before = photoIds(input.value);
        if (before.length >= MAX_PRODUCT_PHOTOS) { alert(`Не больше ${MAX_PRODUCT_PHOTOS} фото`); e.target.value = ''; return; }
        await handlePhotoUpload(e, 'product-photo-id');
        const uploaded = input.value.trim();
        input.value = uploaded && !before.includes(uploaded) ? [...before, uploaded].join(',') : before.join(',');
        renderProductPhotoThumbs();
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
        in_stock: document.getElementById('product-availability').value === 'instock',
        badge: (document.getElementById('product-badge')?.value || '').trim(),
        description: (document.getElementById('product-description')?.value || '').trim(),
        hidden: !!document.getElementById('product-hidden')?.checked,
        stock_qty: (document.getElementById('product-stock-qty')?.value ?? '') === '' ? null : Math.max(0, parseInt(document.getElementById('product-stock-qty').value, 10) || 0),
        ...readProductFinance()
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
    if (photoIds(p.photo_id)[0]) {
        imgEl.src = photoUrl(photoIds(p.photo_id)[0]);
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

// --- Add Product Button (Admin Only) ---
newProductBtn?.addEventListener('click', () => {
    window.openAddProductModal();
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
                <div style="display:flex; align-items:center; justify-content:space-between; padding:6px 10px; background:rgba(var(--ink-rgb), 0.04); border-radius:6px; font-size:0.85rem;">
                    <span style="color:var(--ink); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${c}</span>
                    <button type="button" onclick="window.deleteMetaItem('category', '${c.replace(/'/g, "\\'")}')" style="background:none; border:none; color:var(--pre); cursor:pointer; font-size:1rem; padding:0 4px; line-height:1;" title="Удалить бренд">✕</button>
                </div>
            `).join('');
        }
    }

    if (serListEl) {
        if (series.length === 0) {
            serListEl.innerHTML = '<div style="color:var(--gray); font-size:0.82rem; padding:8px 0;">Нет добавленных тематик</div>';
        } else {
            serListEl.innerHTML = series.map(s => `
                <div style="display:flex; align-items:center; justify-content:space-between; padding:6px 10px; background:rgba(var(--ink-rgb), 0.04); border-radius:6px; font-size:0.85rem;">
                    <span style="color:var(--ink); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${s}</span>
                    <button type="button" onclick="window.deleteMetaItem('series', '${s.replace(/'/g, "\\'")}')" style="background:none; border:none; color:var(--pre); cursor:pointer; font-size:1rem; padding:0 4px; line-height:1;" title="Удалить серию">✕</button>
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

// A cart lives in the browser and can outlive the product data it was built from (e.g. a photo added later).
function refreshCartItem(item, product) {
    item.name = product.name;
    item.figure_number = product.figure_number || '';
    item.price = product.price;
    item.final_price = product.final_price || product.price;
    item.photo_id = photoIds(product.photo_id)[0] || '';
}

function syncCartWithCatalog() {
    let changed = false;
    funkoCart.forEach(item => {
        const product = rawCatalogProducts.find(p => p.id === item.id);
        if (!product) return;
        const before = JSON.stringify(item);
        refreshCartItem(item, product);
        if (JSON.stringify(item) !== before) changed = true;
    });
    if (changed) {
        saveCartToStorage();
        if (typeof renderCartModal === 'function') renderCartModal();
    }
}

window.addToCart = function(productId, qty = 1) {
    const product = findProduct(productId);
    if (!product) {
        window.showToast('Товар не найден');
        return;
    }
    const st = stockInfo(product);
    if (st.sold) {
        window.showToast('Товар распродан');
        return;
    }
    const existing = funkoCart.find(item => item.id === productId);
    if (st.tracked) {
        const inCart = existing ? existing.qty : 0;
        if (inCart + qty > st.qty) {
            window.showToast(`Доступно только ${st.qty} шт.`);
            if (inCart >= st.qty) return;
            qty = st.qty - inCart;
        }
    }
    if (existing) {
        existing.qty += qty;
        refreshCartItem(existing, product);
    } else {
        funkoCart.push({
            id: product.id,
            name: product.name,
            figure_number: product.figure_number || '',
            price: product.price,
            final_price: product.final_price || product.price,
            photo_id: photoIds(product.photo_id)[0] || '',
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
// a game promo code applied in the checkout: { code, amount } (the server checks it again when the order is placed)
window.checkoutPromo = null;

function checkoutTotal() {
    const total = funkoCart.reduce((sum, i) => sum + (i.final_price || i.price) * i.qty, 0);
    return Math.max(0, total - (window.checkoutPromo?.amount || 0));
}

function renderCheckoutAmounts() {
    const total = checkoutTotal();
    const a50 = document.getElementById('checkout-amount-50');
    const a100 = document.getElementById('checkout-amount-100');
    if (a50) a50.textContent = `${Math.round(total * 0.5).toLocaleString('ru')} ₽`;
    if (a100) a100.textContent = `${total.toLocaleString('ru')} ₽`;
    updateCheckoutPayButton();
}

function showPromoStatus(text, ok) {
    const el = document.getElementById('checkout-promo-status');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('hidden', !text);
    el.classList.toggle('ok', !!ok);
}

async function applyCheckoutPromo() {
    const input = document.getElementById('checkout-promo');
    const btn = document.getElementById('checkout-promo-apply');
    if (window.checkoutPromo) {  // the button reads "Убрать" while a code is applied
        window.checkoutPromo = null;
        input.value = ''; input.disabled = false; btn.textContent = 'Применить';
        showPromoStatus('', false);
        renderCheckoutAmounts();
        return;
    }
    const code = input.value.trim();
    if (!code) { input.focus(); return; }
    btn.disabled = true;
    try {
        const res = await fetch(`${API_BASE}/promo/check`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || 'Промокод не подошёл');
        const goods = funkoCart.reduce((sum, i) => sum + (i.final_price || i.price) * i.qty, 0);
        if (data.amount >= goods) throw new Error(`Промокод на ${data.amount} ₽ действует для заказа дороже ${data.amount} ₽`);
        window.checkoutPromo = { code: data.code, amount: data.amount };
        input.value = data.code; input.disabled = true; btn.textContent = 'Убрать';
        showPromoStatus(`Скидка ${data.amount.toLocaleString('ru')} ₽ применена`, true);
        renderCheckoutAmounts();
    } catch (err) {
        showPromoStatus(err.message, false);
    } finally {
        btn.disabled = false;
    }
}
document.getElementById('checkout-promo-apply')?.addEventListener('click', applyCheckoutPromo);
document.getElementById('checkout-promo')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyCheckoutPromo(); } });

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
    const total = checkoutTotal();
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
            <div style="display:flex; justify-content:space-between; margin-bottom:6px; font-weight:700; color:var(--ink);">
                <span>В заказе: ${totalItems} шт.</span>
                <span>${totalPrice.toLocaleString('ru')} ₽</span>
            </div>
            <div style="display:flex; flex-direction:column; gap:4px; font-size:0.82rem; color:var(--muted);">
                ${funkoCart.map(i => `<div>• ${i.name} × ${i.qty} шт. (${((i.final_price || i.price) * i.qty).toLocaleString('ru')} ₽)</div>`).join('')}
            </div>
        `;
    }

    // a code applied earlier stays only while it still fits the cart
    const goods = funkoCart.reduce((sum, i) => sum + (i.final_price || i.price) * i.qty, 0);
    if (window.checkoutPromo && window.checkoutPromo.amount >= goods) {
        window.checkoutPromo = null;
        const pi = document.getElementById('checkout-promo');
        if (pi) { pi.value = ''; pi.disabled = false; }
        const pb = document.getElementById('checkout-promo-apply');
        if (pb) pb.textContent = 'Применить';
        showPromoStatus('', false);
    }
    renderCheckoutAmounts();

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

    const emailPre = document.getElementById('checkout-email');
    if (window.currentClientEmail && emailPre && !emailPre.value) emailPre.value = window.currentClientEmail;

    openModal(document.getElementById('checkout-modal'));
};

// --- Cookie Consent (152-FZ Compliance) ---
window.initCookieConsent = function() {
    try {
        const consent = localStorage.getItem('funko_cookie_consent');
        const banner = document.getElementById('cookie-consent-banner');
        if (!banner) return;
        if (!consent) {
            setTimeout(() => {
                banner.classList.remove('hidden');
            }, 600);
        }
    } catch (e) {
        console.warn('Cookie consent init error:', e);
    }
};

window.acceptCookies = function(type) {
    try {
        localStorage.setItem('funko_cookie_consent', type || 'all');
        localStorage.setItem('funko_cookie_consent_date', new Date().toISOString());
    } catch (e) {}
    const banner = document.getElementById('cookie-consent-banner');
    if (banner) {
        banner.classList.add('closing');
        setTimeout(() => {
            banner.classList.add('hidden');
            banner.classList.remove('closing');
        }, 320);
    }
};

window.showCookieBanner = function() {
    const banner = document.getElementById('cookie-consent-banner');
    if (banner) {
        banner.classList.remove('closing');
        banner.classList.remove('hidden');
    }
};

window.proceedToPayment = function(event) {
    if (event) event.preventDefault();

    const fnInput = document.getElementById('checkout-first-name');
    const lnInput = document.getElementById('checkout-last-name');
    const phoneInput = document.getElementById('checkout-phone');
    const tgInput = document.getElementById('checkout-tg');
    const emailInput = document.getElementById('checkout-email');
    const marketingInput = document.getElementById('checkout-marketing');
    const deliveryInput = document.getElementById('checkout-delivery');
    const commentInput = document.getElementById('checkout-comment');
    const consentInput = document.getElementById('checkout-pd-consent');
    const consentContainer = document.getElementById('checkout-consent-container');
    const errBanner = document.getElementById('checkout-error-banner');

    const firstName = (fnInput?.value || '').trim();
    const lastName = (lnInput?.value || '').trim();
    const phone = (phoneInput?.value || '').trim();
    const tg = (tgInput?.value || '').trim();
    const email = (emailInput?.value || '').trim();

    // Reset previous error classes
    [fnInput, lnInput, phoneInput, tgInput, emailInput].forEach(inp => inp?.classList.remove('field-error'));
    if (consentContainer) consentContainer.classList.remove('field-error');
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
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) {
        emailInput?.classList.add('field-error');
        hasError = true;
        if (!firstInvalid) firstInvalid = emailInput;
    }

    // 152-FZ Mandatory Consent Check
    if (consentInput && !consentInput.checked) {
        if (consentContainer) consentContainer.classList.add('field-error');
        hasError = true;
        if (!firstInvalid) firstInvalid = consentInput;
    }

    if (hasError) {
        if (errBanner) {
            if (consentInput && !consentInput.checked) {
                errBanner.textContent = 'Для продолжения необходимо подтвердить согласие на обработку персональных данных (152-ФЗ)!';
            } else {
                errBanner.textContent = 'Обязательно укажите Имя, Фамилию, Телефон, Telegram и почту для связи перед оплатой!';
            }
            errBanner.classList.remove('hidden');
            errBanner.classList.add('shake-it');
            setTimeout(() => errBanner.classList.remove('shake-it'), 500);
        }
        if (firstInvalid) firstInvalid.focus();
        return false;
    }

    const total = checkoutTotal();
    const dueAmount = window.currentPaymentOption === '50%' ? Math.round(total * 0.5) : total;

    window.pendingCheckoutData = {
        promo_code: window.checkoutPromo?.code || '',
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
        email: email,
        marketing_consent: !!marketingInput?.checked,
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
        payBtn.textContent = 'Создание платежа...';
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
            throw new Error(data.detail || 'Ошибка создания заказа');
        }

        // Save order info for return from payment
        localStorage.setItem('funko_pending_order', JSON.stringify({
            order_id: data.order_id,
            client_id: data.client_id,
            password: data.password,
            token: data.token,
            is_new_client: data.is_new_client
        }));

        funkoCart = [];
        saveCartToStorage();

        if (data.payment_url) {
            window.location.href = data.payment_url;
        } else {
            closeModals();
            showOrderSuccess(data);
        }
    } catch (err) {
        alert('Ошибка при оформлении заказа: ' + err.message);
        if (payBtn) {
            payBtn.disabled = false;
            payBtn.textContent = 'Перейти к оплате →';
        }
    }
};

function showOrderSuccess(data) {
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
        window.lastCreatedClientToken = data.token || null;
    }

    if (botLink) {
        botLink.href = `https://t.me/funkostop_bot?start=order_${data.order_id}`;
    }

    openModal(document.getElementById('order-success-modal'));
}

// Check if returning from T-Bank payment — poll real status before showing success
(async function checkPaymentReturn() {
    const pending = localStorage.getItem('funko_pending_order');
    if (!pending) return;
    let orderData;
    try {
        orderData = JSON.parse(pending);
    } catch(e) {
        localStorage.removeItem('funko_pending_order');
        return;
    }

    // Poll /api/payment-status up to ~30s waiting for T-Bank webhook
    const maxAttempts = 10;
    const delayMs = 3000;
    for (let i = 0; i < maxAttempts; i++) {
        try {
            const res = await fetch(`/api/payment-status/${orderData.order_id}`);
            if (res.ok) {
                const { status } = await res.json();
                if (status === 'paid') {
                    localStorage.removeItem('funko_pending_order');
                    showOrderSuccess(orderData);
                    return;
                }
                if (status === 'failed') {
                    localStorage.removeItem('funko_pending_order');
                    alert('Оплата не прошла или была отменена. Попробуйте снова.');
                    return;
                }
                // status === 'pending' — wait and retry
            }
        } catch(_) {}
        if (i < maxAttempts - 1) await new Promise(r => setTimeout(r, delayMs));
    }

    // After timeout — payment still pending (user may have closed T-Bank without paying)
    localStorage.removeItem('funko_pending_order');
    // Don't show success — order exists but not paid yet
})();

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

// Ledger (manual income/expense entries)
let rawLedgerEntries = [];

async function loadLedger() {
    // Set default date to today if empty
    const dateEl = document.getElementById('ledger-date');
    if (dateEl && !dateEl.value) {
        const now = new Date();
        dateEl.value = now.toISOString().split('T')[0];
    }
    try {
        const data = await fetchAPI('/ledger');
        rawLedgerEntries = data.entries || [];
        renderLedger();
    } catch (e) {
        console.error('Ошибка загрузки леджера:', e);
    }
}

function ledgerDateParts(d) {
    // entries are stored as dd.mm.yyyy
    const p = String(d || '').split('.');
    return p.length === 3 ? { day: p[0], month: p[1], year: p[2] } : null;
}

function ledgerInPeriod(e) {
    const month = window.finMonth;
    if (!month) return true;
    const p = ledgerDateParts(e.entry_date);
    return !!p && `${p.year}-${p.month}` === month;
}

function ledgerPeriodLabel() {
    return window.finMonth ? '· ' + finMonthTitle(window.finMonth) : '· за всё время';
}

function renderLedger() {
    const tbody = document.getElementById('ledger-table-body');
    const noMsg = document.getElementById('no-ledger');
    if (!tbody) return;
    tbody.innerHTML = '';
    const period = document.getElementById('ledger-period');
    if (period) period.textContent = ledgerPeriodLabel();

    const entries = rawLedgerEntries.filter(ledgerInPeriod);
    let totalIncome = 0, totalExpense = 0;
    entries.forEach(e => {
        if (e.entry_type === 'income') totalIncome += e.amount;
        else totalExpense += e.amount;
    });
    updateLedgerSummary(totalIncome, totalExpense);

    if (noMsg) noMsg.classList.toggle('hidden', entries.length > 0);
    entries.forEach(e => {
        const tr = document.createElement('tr');
        const isIncome = e.entry_type === 'income';
        tr.className = 'ledger-row';
        tr.title = 'Двойной клик — изменить';
        tr.innerHTML = `
            <td style="white-space:nowrap;">${escapeHtml(e.entry_date)}</td>
            <td>${e.description ? escapeHtml(e.description) : '—'}</td>
            <td style="white-space:nowrap;color:${isIncome ? 'var(--ok)' : 'var(--pre)'};font-weight:600;">
                ${isIncome ? '+' : '−'}${e.amount.toLocaleString('ru')} ₽
            </td>
            <td>${isIncome ? 'Доход' : 'Расход'}</td>
            <td><button class="delete-btn" onclick="window.deleteLedgerEntry(${e.id}, this)" title="Нажми ещё раз для подтверждения">✕</button></td>
        `;
        tr.addEventListener('dblclick', (ev) => {
            if (ev.target.closest('button')) return;
            startLedgerEdit(tr, e);
        });
        tbody.appendChild(tr);
    });
}

function startLedgerEdit(tr, e) {
    if (tr.classList.contains('editing')) return;
    tr.classList.add('editing');
    const p = ledgerDateParts(e.entry_date);
    const iso = p ? `${p.year}-${p.month}-${p.day}` : '';
    tr.innerHTML = `
        <td><input type="date" class="inline-edit-input" data-f="date" value="${iso}"></td>
        <td><input type="text" class="inline-edit-input" data-f="desc" value="${escapeHtml(e.description || '')}" placeholder="Описание"></td>
        <td><input type="number" class="inline-edit-input" data-f="amount" min="1" value="${e.amount}"></td>
        <td><select class="inline-edit-input" data-f="type"><option value="income"${e.entry_type === 'income' ? ' selected' : ''}>Доход</option><option value="expense"${e.entry_type !== 'income' ? ' selected' : ''}>Расход</option></select></td>
        <td style="white-space:nowrap;"><button type="button" class="btn primary ledger-save" title="Сохранить (Enter)">✓</button></td>
    `;
    const field = f => tr.querySelector(`[data-f="${f}"]`);
    let done = false;
    const save = async () => {
        if (done) return;
        const isoVal = field('date').value;
        const amount = parseInt(field('amount').value);
        if (!isoVal || !amount || amount <= 0) { field(!isoVal ? 'date' : 'amount').focus(); return; }
        done = true;
        const [y, mo, d] = isoVal.split('-');
        try {
            await fetchAPI(`/ledger/${e.id}`, {
                method: 'PUT',
                body: JSON.stringify({ entry_date: `${d}.${mo}.${y}`, description: field('desc').value.trim(), amount, entry_type: field('type').value })
            });
            await loadLedger();
        } catch (err) {
            done = false;
            alert('Ошибка: ' + err.message);
        }
    };
    tr.querySelector('.ledger-save').addEventListener('click', save);
    tr.querySelectorAll('.inline-edit-input').forEach(inp => inp.addEventListener('keydown', ev => {
        if (ev.key === 'Enter') { ev.preventDefault(); save(); }
        if (ev.key === 'Escape') { done = true; renderLedger(); }
    }));
    // leaving the row saves it, the same way the cost and delivery cells do
    tr.addEventListener('focusout', () => setTimeout(() => { if (!tr.contains(document.activeElement)) save(); }, 0));
    field('desc').focus();
}

function updateLedgerSummary(income, expense, margin = 0, marginCount = 0) {
    const net = income - expense + margin;
    const incEl = document.getElementById('ledger-income-total');
    const expEl = document.getElementById('ledger-expense-total');
    const marEl = document.getElementById('ledger-margin-total');
    const marCnt = document.getElementById('ledger-margin-count');
    const netEl = document.getElementById('ledger-net-total');
    if (incEl) incEl.textContent = income.toLocaleString('ru') + ' ₽';
    if (expEl) expEl.textContent = expense.toLocaleString('ru') + ' ₽';
    if (marEl) {
        marEl.textContent = (margin > 0 ? '+' : '') + margin.toLocaleString('ru') + ' ₽';
        marEl.style.color = margin < 0 ? 'var(--pre)' : 'var(--ok)';
    }
    if (marCnt) marCnt.textContent = marginCount ? `заказов: ${marginCount}` : 'нет заказов с себест. и доставкой';
    if (netEl) {
        netEl.textContent = (net >= 0 ? '+' : '') + net.toLocaleString('ru') + ' ₽';
        netEl.style.color = net >= 0 ? 'var(--ok)' : 'var(--pre)';
    }
}

window.addLedgerEntry = async function() {
    const dateEl = document.getElementById('ledger-date');
    const descEl = document.getElementById('ledger-desc');
    const amountEl = document.getElementById('ledger-amount');
    const typeEl = document.getElementById('ledger-type');
    const addBtn = document.querySelector('.ledger-add-form .btn.primary');

    const dateVal = (dateEl?.value || '').trim();
    const desc = (descEl?.value || '').trim();
    const amount = parseInt(amountEl?.value);
    const entry_type = typeEl?.value || 'expense';

    if (!dateVal) {
        if (dateEl) dateEl.style.border = '1.5px solid #e03131';
        return;
    } else if (dateEl) dateEl.style.border = '';

    if (!amount || amount <= 0) {
        if (amountEl) { amountEl.style.border = '1.5px solid #e03131'; amountEl.focus(); }
        return;
    } else if (amountEl) amountEl.style.border = '';

    // Convert date from yyyy-mm-dd to dd.mm.yyyy
    let displayDate = dateVal;
    if (dateVal.includes('-')) {
        const [y, m, d] = dateVal.split('-');
        displayDate = `${d}.${m}.${y}`;
    }

    if (addBtn) { addBtn.disabled = true; addBtn.textContent = '...'; }
    try {
        await fetchAPI('/ledger', {
            method: 'POST',
            body: JSON.stringify({ entry_date: displayDate, description: desc, amount, entry_type })
        });
        if (descEl) descEl.value = '';
        if (amountEl) amountEl.value = '';
        await loadLedger();
    } catch (err) {
        alert('Ошибка при добавлении: ' + err.message);
    } finally {
        if (addBtn) { addBtn.disabled = false; addBtn.textContent = '+ Добавить'; }
    }
};

window.deleteLedgerEntry = async function(id, btn) {
    if (btn) {
        if (btn.dataset.confirming) {
            btn.dataset.confirming = '';
            btn.textContent = '✕';
            btn.style.background = '';
        } else {
            btn.dataset.confirming = '1';
            btn.textContent = '✓?';
            btn.style.background = 'rgba(224,49,49,0.5)';
            setTimeout(() => {
                if (btn.dataset.confirming) {
                    btn.dataset.confirming = '';
                    btn.textContent = '✕';
                    btn.style.background = '';
                }
            }, 2000);
            return;
        }
    }
    try {
        await fetchAPI(`/ledger/${id}`, { method: 'DELETE' });
        await loadLedger();
    } catch (err) {
        alert('Ошибка: ' + err.message);
    }
};

// --- Admin registers: purchases (выкупы) and promo codes. One small engine, two configurations. ---
function isoToRu(iso) {
    const p = String(iso || '').split('-');
    return p.length === 3 ? `${p[2]}.${p[1]}.${p[0]}` : '';
}

const REGISTERS = {
    purchases: {
        api: '/purchases',
        modal: 'purchase-modal',
        newTitle: 'Новый выкуп',
        editTitle: it => `Выкуп: ${it.title}`,
        empty: { title: '', description: '', amount: '', purchase_date: '', track: '', kind: 'stock', expected_date: '', shop: '', delivered: false },
        view: 'active',
        visible(it, view) { return view === 'archive' ? it.delivered : !it.delivered; },
        haystack: it => [it.title, it.shop, it.track, it.description].join(' '),
        row(it) {
            const kind = it.kind === 'preorder'
                ? `<span class="reg-pill pre">Предзаказ</span>${it.expected_date ? `<div class="reg-sub">рассылка ${isoToRu(it.expected_date)}</div>` : ''}`
                : '<span class="reg-pill">Обычный</span>';
            const action = it.delivered
                ? `<button type="button" class="btn secondary outline reg-act" data-act="undeliver">Вернуть в работу</button>`
                : `<button type="button" class="btn secondary outline reg-act" data-act="deliver">Доставлен</button>`;
            return `
                <td style="white-space:nowrap;">${isoToRu(it.purchase_date) || '—'}</td>
                <td><b>${escapeHtml(it.title)}</b></td>
                <td>${escapeHtml(it.shop) || '—'}</td>
                <td style="white-space:nowrap;">${(it.amount || 0).toLocaleString('ru')} ₽</td>
                <td class="reg-mono">${escapeHtml(it.track) || '—'}</td>
                <td>${kind}</td>
                <td style="text-align:right;">${action}</td>`;
        },
        count(list, all) {
            const sum = list.reduce((s, it) => s + (it.amount || 0), 0);
            return `${list.length} из ${all.length} · на сумму ${sum.toLocaleString('ru')} ₽`;
        },
        async act(it, act) {
            await fetchAPI(`/purchases/${it.id}`, { method: 'PUT', body: JSON.stringify({ ...it, delivered: act === 'deliver' }) });
        }
    },
    promocodes: {
        api: '/promocodes',
        modal: 'promocode-modal',
        newTitle: 'Новый промокод',
        editTitle: it => `Промокод ${it.code}`,
        empty: { code: '', value: '', value_kind: 'percent', site: '', conditions: '' },
        visible: () => true,
        haystack: it => [it.code, it.site, it.conditions].join(' '),
        row(it) {
            const value = it.value_kind === 'rub' ? `${(it.value || 0).toLocaleString('ru')} ₽` : `${it.value || 0}%`;
            return `
                <td><span class="reg-code">${escapeHtml(it.code)}</span></td>
                <td style="white-space:nowrap;"><b>−${value}</b></td>
                <td>${escapeHtml(it.site) || '—'}</td>
                <td style="text-align:right;"><button type="button" class="btn secondary outline reg-act" data-act="copy">Копировать</button></td>`;
        },
        count: (list, all) => `${list.length} из ${all.length}`,
        async act(it, act) {
            if (act === 'copy') {
                try { await navigator.clipboard.writeText(it.code); } catch (e) {}
                return 'copied';
            }
        }
    }
};
const registerData = { purchases: [], promocodes: [] };
let registerEditing = { name: null, item: null };

async function loadRegister(name) {
    try {
        const data = await fetchAPI(REGISTERS[name].api);
        registerData[name] = data.items || [];
    } catch (e) {
        console.error('register load failed', name, e);
    }
    renderRegister(name);
}

function renderRegister(name) {
    const cfg = REGISTERS[name];
    const tbody = document.querySelector(`[data-reg-table="${name}"] tbody`);
    if (!tbody) return;
    const q = (document.querySelector(`[data-reg-search="${name}"]`)?.value || '').toLowerCase().trim();
    const all = registerData[name].filter(it => cfg.visible(it, cfg.view));
    const list = q ? all.filter(it => cfg.haystack(it).toLowerCase().includes(q)) : all;
    tbody.replaceChildren(...list.map(it => {
        const tr = document.createElement('tr');
        tr.className = 'reg-row';
        tr.title = 'Двойной клик — открыть целиком';
        tr.innerHTML = cfg.row(it);
        tr.addEventListener('dblclick', (e) => { if (!e.target.closest('button')) openRegisterModal(name, it); });
        // phones have no double click: a tap opens the record
        if (window.matchMedia('(hover: none)').matches) tr.addEventListener('click', (e) => { if (!e.target.closest('button')) openRegisterModal(name, it); });
        tr.querySelectorAll('.reg-act').forEach(btn => btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
                const res = await cfg.act(it, btn.dataset.act);
                if (res === 'copied') { btn.textContent = 'Скопирован ✓'; setTimeout(() => { btn.textContent = 'Копировать'; btn.disabled = false; }, 1400); return; }
                await loadRegister(name);
            } catch (err) { alert('Ошибка: ' + err.message); btn.disabled = false; }
        }));
        return tr;
    }));
    document.querySelector(`[data-reg-empty="${name}"]`)?.classList.toggle('hidden', list.length > 0);
    const cnt = document.querySelector(`[data-reg-count="${name}"]`);
    if (cnt) cnt.textContent = cfg.count(list, all);
}

function registerForm(name) { return document.querySelector(`[data-reg-form="${name}"]`); }

function syncRegisterConditional(form) {
    const kind = form.elements.kind?.value;
    form.querySelectorAll('[data-show-if]').forEach(el => el.classList.toggle('hidden', el.dataset.showIf !== kind));
}

function openRegisterModal(name, item) {
    const cfg = REGISTERS[name];
    const form = registerForm(name);
    registerEditing = { name, item: item || null };
    const values = item || cfg.empty;
    Object.entries(cfg.empty).forEach(([k]) => {
        const el = form.elements[k];
        if (!el) return;
        if (el.type === 'checkbox') el.checked = !!values[k];
        else el.value = values[k] ?? '';
    });
    if (!item && form.elements.purchase_date) form.elements.purchase_date.value = new Date().toISOString().slice(0, 10);
    document.querySelector(`[data-reg-title="${name}"]`).textContent = item ? cfg.editTitle(item) : cfg.newTitle;
    form.querySelector('.reg-delete').classList.toggle('hidden', !item);
    form.querySelector('.reg-error').classList.add('hidden');
    syncRegisterConditional(form);
    openModal(document.getElementById(cfg.modal));
    setTimeout(() => form.querySelector('input:not([type=hidden])')?.focus(), 30);
}

function readRegisterForm(name) {
    const form = registerForm(name);
    const out = {};
    Object.keys(REGISTERS[name].empty).forEach(k => {
        const el = form.elements[k];
        if (!el) return;
        if (el.type === 'checkbox') out[k] = el.checked;
        else if (el.type === 'number') out[k] = parseInt(el.value, 10) || 0;
        else out[k] = el.value.trim();
    });
    return out;
}

Object.keys(REGISTERS).forEach(name => {
    const form = registerForm(name);
    if (!form) return;
    document.querySelector(`[data-reg-add="${name}"]`)?.addEventListener('click', () => openRegisterModal(name, null));
    document.querySelector(`[data-reg-search="${name}"]`)?.addEventListener('input', () => renderRegister(name));
    document.querySelectorAll(`[data-reg-view="${name}"]`).forEach(btn => btn.addEventListener('click', () => {
        REGISTERS[name].view = btn.dataset.view;
        document.querySelectorAll(`[data-reg-view="${name}"]`).forEach(b => b.classList.toggle('active', b === btn));
        renderRegister(name);
    }));
    form.elements.kind?.addEventListener('change', () => syncRegisterConditional(form));
    form.querySelector('.reg-cancel').addEventListener('click', closeModals);
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const err = form.querySelector('.reg-error');
        const body = readRegisterForm(name);
        const required = form.querySelector('[required]');
        if (required && !required.value.trim()) { required.focus(); err.textContent = 'Заполните поле «' + required.labels[0].textContent + '»'; err.classList.remove('hidden'); return; }
        const btn = form.querySelector('button[type=submit]');
        btn.disabled = true;
        try {
            const { item } = registerEditing;
            await fetchAPI(item ? `${REGISTERS[name].api}/${item.id}` : REGISTERS[name].api, { method: item ? 'PUT' : 'POST', body: JSON.stringify(body) });
            closeModals();
            await loadRegister(name);
        } catch (ex) {
            err.textContent = ex.message; err.classList.remove('hidden');
        } finally { btn.disabled = false; }
    });
    const del = form.querySelector('.reg-delete');
    del.addEventListener('click', async () => {
        const { item } = registerEditing;
        if (!item) return;
        if (!del.dataset.confirm) {
            del.dataset.confirm = '1'; del.textContent = 'Точно удалить?';
            setTimeout(() => { delete del.dataset.confirm; del.textContent = 'Удалить'; }, 2500);
            return;
        }
        delete del.dataset.confirm; del.textContent = 'Удалить';
        try {
            await fetchAPI(`${REGISTERS[name].api}/${item.id}`, { method: 'DELETE' });
            closeModals();
            await loadRegister(name);
        } catch (ex) { alert('Ошибка: ' + ex.message); }
    });
});

// ======================= Accounting screen (numbers come from /api/finance; rules live in finance.py) =======================
const FIN_STAGES = { 0: 'Не учитывать', 1: 'Ожидает выкупа', 2: 'Выкуплен', 3: 'Доставка до РФ оплачена', 4: 'Завершён' };
const MONTHS_RU = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
window.finMonth = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; })();
let finData = null;
let finOrdersShown = 100;

function finMonthTitle(key) {
    const [y, m] = key.split('-').map(Number);
    return `${MONTHS_RU[m - 1]} ${y}`;
}
function rub(n) { return `${Math.round(n || 0).toLocaleString('ru')} ₽`; }
function signedRub(n) { return `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(Math.round(n || 0)).toLocaleString('ru')} ₽`; }
function isoRu(iso) { const d = String(iso || '').slice(0, 10).split('-'); return d.length === 3 ? `${d[2]}.${d[1]}.${d[0]}` : ''; }

async function loadFinance() {
    const all = document.getElementById('fin-ops-all')?.checked ? '&show_all_ops=true' : '';
    try {
        finData = await fetchAPI(`/finance?month=${window.finMonth}${all}`);
        renderFinance();
    } catch (e) {
        console.error('finance load failed', e);
    }
}

function renderFinance() {
    const d = finData;
    if (!d) return;
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    const approx = d.need.approx ? '~ ' : '';
    set('fin-month-label', finMonthTitle(window.finMonth));
    set('fin-need', approx + rub(d.need.total));
    set('fin-need-purchase', approx + rub(d.need.purchase));
    set('fin-need-shipping', approx + rub(d.need.shipping));

    const short = d.available.value < 0;
    set('fin-avail-label', short ? 'Не хватает резерва' : 'Доступно к выводу');
    set('fin-avail', approx + rub(Math.abs(d.available.value)));
    document.querySelector('.fin-card.avail')?.classList.toggle('short', short);
    set('fin-cash', rub(d.available.cash));
    set('fin-withdrawn-total', rub(d.available.withdrawn_total));

    const [y, m] = window.finMonth.split('-').map(Number);
    set('fin-profit-label', `Прибыль за ${MONTHS_RU[m - 1].toLowerCase()}` + (y !== new Date().getFullYear() ? ` ${y}` : ''));
    set('fin-profit', (d.month.approx ? '~ ' : '') + signedRub(d.month.total));
    set('fin-done', String(d.month.done));
    set('fin-month-withdrawn', rub(d.month.withdrawn));

    const note = document.getElementById('fin-start-note');
    const today = new Date().toISOString().slice(0, 10);
    if (note) {
        const future = d.start_date > today;
        note.classList.toggle('hidden', !future);
        note.textContent = future ? `Учёт начнётся ${isoRu(d.start_date)}: в бухгалтерию попадут только заказы, оформленные с этой даты. Старые заказы в ней не учитываются.` : '';
    }

    const att = document.getElementById('fin-attention');
    if (att) {
        att.innerHTML = d.attention.length
            ? '<h3>Требует внимания</h3><ul>' + d.attention.map(a => `<li><b>${a.count}</b> — ${escapeHtml(a.text)}</li>`).join('') + '</ul>'
            : '<h3 class="ok">✓ Всё учтено</h3>';
    }
    renderFinOrders();
    renderFinMonths();
    renderFinChart();
    renderFinWithdrawals();
    renderFinOps();
}

function finCostCell(o, kind) {
    const value = kind === 'purchase' ? o.purchase : o.shipping;
    const fact = kind === 'purchase' ? o.purchase_is_fact : o.shipping_is_fact;
    const text = value == null ? '<span class="fin-missing">не указано</span>' : `${fact ? '' : '~'}${rub(value)}${fact ? ' <span class="fin-ok">✓</span>' : ''}`;
    return `<td class="num fin-edit" data-kind="${kind}" title="Нажмите, чтобы указать план или факт">${text}</td>`;
}

function renderFinOrders() {
    const tbody = document.querySelector('#fin-orders-table tbody');
    if (!tbody || !finData) return;
    const q = (document.getElementById('fin-orders-search')?.value || '').toLowerCase().trim();
    const f = document.getElementById('fin-orders-filter')?.value || 'all';
    let rows = finData.orders.filter(o => {
        if (f === 'missing') { if (!(o.missing_purchase || o.missing_shipping)) return false; }
        else if (f !== 'all' && String(o.stage) !== f) return false;
        return !q || String(o.id).includes(q) || (o.items || '').toLowerCase().includes(q);
    });
    const total = rows.length;
    rows = rows.slice(0, finOrdersShown);
    tbody.replaceChildren(...rows.map(o => {
        const tr = document.createElement('tr');
        const profitApprox = (o.exact ? '' : '~');
        const profit = (o.missing_purchase || o.missing_shipping) ? '<span class="fin-missing">?</span>' : `${profitApprox}${signedRub(o.profit)}`;
        tr.innerHTML = `
            <td>#${o.id}</td>
            <td class="fin-item">${escapeHtml(o.items || '')}</td>
            <td><span class="fin-stage s${o.stage}" title="${escapeHtml(o.status)}">${FIN_STAGES[o.stage]}</span></td>
            <td class="num">${rub(o.received)} / ${rub(o.price)}</td>
            ${finCostCell(o, 'purchase')}
            ${finCostCell(o, 'shipping')}
            <td class="num">~${rub(o.tax)}</td>
            <td class="num"><b>${o.need ? rub(o.need) : '0 ₽'}</b></td>
            <td class="num ${o.profit < 0 ? 'neg' : 'pos'}">${profit}</td>`;
        tr.querySelectorAll('.fin-edit').forEach(td => td.addEventListener('click', () => openFinCostEditor(td, o)));
        return tr;
    }));
    document.getElementById('fin-orders-empty')?.classList.toggle('hidden', total > 0);
    const more = document.getElementById('fin-orders-more');
    if (more) { more.classList.toggle('hidden', total <= finOrdersShown); more.textContent = `Показать ещё (${total - finOrdersShown})`; }
}

function openFinCostEditor(td, o) {
    if (td.querySelector('form')) return;
    const kind = td.dataset.kind;
    const order = (allOrders || []).find(x => x.id === o.id) || {};
    const planKey = kind === 'purchase' ? 'planned_purchase_cost' : 'planned_shipping';
    const factKey = kind === 'purchase' ? 'cost_price' : 'delivery_cost';
    const planNow = kind === 'purchase' ? (o.purchase_is_fact ? '' : (o.purchase ?? '')) : (o.shipping_is_fact ? '' : (o.shipping ?? ''));
    const factNow = (kind === 'purchase' ? (o.purchase_is_fact ? o.purchase : '') : (o.shipping_is_fact ? o.shipping : '')) || order[factKey] || '';
    td.innerHTML = `<form class="fin-cost-form">
        <label>План <input type="number" min="0" step="1" name="plan" value="${planNow}"></label>
        <label>Факт <input type="number" min="0" step="1" name="fact" value="${factNow || ''}"></label>
        <button type="submit" class="btn primary">✓</button></form>`;
    const form = td.querySelector('form');
    form.addEventListener('click', e => e.stopPropagation());
    form.elements.fact.focus();
    form.addEventListener('keydown', e => { if (e.key === 'Escape') renderFinOrders(); });
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const plan = form.elements.plan.value.trim();
        const fact = form.elements.fact.value.trim();
        const body = { [planKey]: plan === '' ? null : parseInt(plan, 10), [factKey]: fact === '' ? 0 : parseInt(fact, 10) };
        try {
            await fetchAPI(`/orders/${o.id}/costs`, { method: 'PATCH', body: JSON.stringify(body) });
            await loadFinance();
        } catch (err) { alert('Ошибка: ' + err.message); }
    });
}

// Grouped bars: profit (can go below zero) and owner withdrawals per month, last 12 months up to the chosen one
function renderFinChart() {
    const box = document.querySelector('#fin-chart .fin-chart-body');
    const tip = document.querySelector('#fin-chart .fin-tip');
    if (!box || !finData) return;
    const byMonth = Object.fromEntries(finData.months.map(mm => [mm.month, mm]));
    const [y0, m0] = window.finMonth.split('-').map(Number);
    const months = [];
    for (let i = 11; i >= 0; i--) {
        const d = new Date(y0, m0 - 1 - i, 1);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        const mm = byMonth[key] || { total: 0, withdrawn: 0, done: 0, approx: false };
        months.push({ key, profit: mm.total, withdrawn: mm.withdrawn, done: mm.done, approx: mm.approx });
    }
    const W = 760, H = 240, padL = 56, padR = 8, padT = 12, padB = 26;
    const hi = Math.max(0, ...months.map(x => Math.max(x.profit, x.withdrawn)));
    const lo = Math.min(0, ...months.map(x => x.profit));
    if (hi === 0 && lo === 0) {
        box.innerHTML = '<p class="fin-chart-empty">Данные появятся, когда с начала учёта будут завершены заказы или сделаны выводы.</p>';
        return;
    }
    const step = (() => { const raw = (hi - lo) / 4; const p = 10 ** Math.floor(Math.log10(raw || 1)); return [1, 2, 2.5, 5, 10].map(k => k * p).find(k => k >= raw); })();
    const top = Math.ceil(hi / step) * step, bottom = Math.floor(lo / step) * step;
    const yOf = v => padT + (top - v) / (top - bottom || 1) * (H - padT - padB);
    const slot = (W - padL - padR) / months.length;
    const bw = Math.min(18, (slot - 10) / 2);
    const fmt = v => Math.abs(v) >= 1000 ? `${Math.round(v / 1000)}k` : String(Math.round(v));
    let svg = '';
    for (let v = bottom; v <= top + 1e-9; v += step) {
        const yy = yOf(v).toFixed(1);
        svg += `<line class="${v === 0 ? 'base' : 'grid'}" x1="${padL}" x2="${W - padR}" y1="${yy}" y2="${yy}"/><text class="ax" x="${padL - 8}" y="${yy}" dy="0.32em" text-anchor="end">${fmt(v)}</text>`;
    }
    const bar = (x, v, cls) => {
        if (!v) return '';
        const y1 = yOf(Math.max(v, 0)), y2 = yOf(Math.min(v, 0));
        const hgt = Math.max(1, y2 - y1), r = Math.min(4, hgt / 2, bw / 2);
        // rounded data end, square at the baseline
        const d = v > 0
            ? `M${x},${y2}V${y1 + r}Q${x},${y1} ${x + r},${y1}H${x + bw - r}Q${x + bw},${y1} ${x + bw},${y1 + r}V${y2}Z`
            : `M${x},${y1}V${y2 - r}Q${x},${y2} ${x + r},${y2}H${x + bw - r}Q${x + bw},${y2} ${x + bw},${y2 - r}V${y1}Z`;
        return `<path class="${cls}" d="${d}"/>`;
    };
    months.forEach((mm, i) => {
        const cx = padL + slot * i + slot / 2;
        // the hover band sits under the bars so it never tints them
        svg += `<rect class="hit" x="${padL + slot * i}" y="${padT}" width="${slot}" height="${H - padT - padB}" data-i="${i}"/>`;
        svg += bar(cx - bw - 1, mm.profit, 'b profit') + bar(cx + 1, mm.withdrawn, 'b wd');
        const [yy, mo] = mm.key.split('-').map(Number);
        svg += `<text class="ax" x="${cx}" y="${H - 8}" text-anchor="middle">${MONTHS_RU[mo - 1].slice(0, 3).toLowerCase()}${mo === 1 ? ` ${String(yy).slice(2)}` : ''}</text>`;
    });
    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Прибыль и выводы по месяцам; точные цифры — в таблице ниже">${svg}</svg>`;
    const svgEl = box.querySelector('svg');
    svgEl.querySelectorAll('.hit').forEach(r => {
        r.addEventListener('pointerenter', () => {
            const mm = months[+r.dataset.i];
            svgEl.querySelectorAll('.hit').forEach(o => o.classList.toggle('on', o === r));
            tip.innerHTML = `<b>${finMonthTitle(mm.key)}</b><span><i class="sw profit"></i>Прибыль ${mm.approx ? '~' : ''}${signedRub(mm.profit)}</span><span><i class="sw wd"></i>Выведено ${rub(mm.withdrawn)}</span><span class="muted">Завершено заказов: ${mm.done}</span>`;
            tip.classList.remove('hidden');
            const fig = box.closest('.fin-chart').getBoundingClientRect();
            const rr = r.getBoundingClientRect();
            const left = Math.min(fig.width - tip.offsetWidth - 8, Math.max(8, rr.left - fig.left + rr.width / 2 - tip.offsetWidth / 2));
            tip.style.left = `${left}px`;
        });
    });
    svgEl.addEventListener('pointerleave', () => { tip.classList.add('hidden'); svgEl.querySelectorAll('.hit').forEach(o => o.classList.remove('on')); });
}

// CSV of the open accounting tab, for Excel (semicolons, BOM, whole numbers)
function exportFinance() {
    if (!finData) return;
    const tab = document.querySelector('.fin-tab.active')?.dataset.finTab || 'orders';
    const v = n => (n === null || n === undefined) ? '' : Math.round(n);
    let head = [], rows = [];
    if (tab === 'orders') {
        head = ['Заказ', 'Товар', 'Статус', 'Этап', 'Цена', 'Оплачено', 'Закупка', 'Закупка факт', 'Доставка РФ', 'Доставка факт', 'Налоги', 'Ещё потребуется', 'Ожид. прибыль'];
        rows = finData.orders.map(o => [o.id, o.items, o.status, FIN_STAGES[o.stage], v(o.price), v(o.received), v(o.purchase), o.purchase_is_fact ? 'да' : 'план',
            v(o.shipping), o.shipping_is_fact ? 'да' : 'план', v(o.tax), v(o.need), (o.missing_purchase || o.missing_shipping) ? '' : v(o.profit)]);
    } else if (tab === 'months') {
        head = ['Месяц', 'Завершено', 'Прибыль заказов', 'Прочие', 'Итого', 'Выведено', 'Приблизительно'];
        rows = finData.months.map(mm => [finMonthTitle(mm.month), mm.done, v(mm.profit), v(mm.other), v(mm.total), v(mm.withdrawn), mm.approx ? 'да' : '']);
    } else if (tab === 'withdrawals') {
        head = ['Дата', 'Сумма', 'Комментарий'];
        rows = finData.withdrawals.map(w => [isoRu(w.wd_date), v(w.amount), w.comment || '']);
    } else {
        const table = document.querySelector(`[data-fin-panel="${tab}"] table`);
        head = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim()).filter(Boolean);
        rows = [...table.querySelectorAll('tbody tr')].map(tr => [...tr.querySelectorAll('td')].slice(0, head.length).map(td => td.textContent.replace(/\s+/g, ' ').trim()));
    }
    const cell = x => { const s = String(x ?? ''); return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = '\ufeff' + [head, ...rows].map(r => r.map(cell).join(';')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `buhgalteriya-${tab}-${window.finMonth}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function renderFinMonths() {
    const tbody = document.querySelector('#fin-months-table tbody');
    if (!tbody || !finData) return;
    tbody.innerHTML = finData.months.map(mm => `
        <tr><td>${finMonthTitle(mm.month)}</td><td class="num">${mm.done}</td>
        <td class="num">${mm.approx ? '~' : ''}${signedRub(mm.profit)}</td><td class="num">${signedRub(mm.other)}</td>
        <td class="num"><b>${mm.approx ? '~' : ''}${signedRub(mm.total)}</b></td><td class="num">${rub(mm.withdrawn)}</td></tr>`).join('');
    document.getElementById('fin-months-empty')?.classList.toggle('hidden', finData.months.length > 0);
}

function renderFinWithdrawals() {
    const tbody = document.querySelector('#fin-wd-table tbody');
    if (!tbody || !finData) return;
    tbody.replaceChildren(...finData.withdrawals.map(w => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${isoRu(w.wd_date)}</td><td class="num"><b>${rub(w.amount)}</b></td><td>${escapeHtml(w.comment || '')}</td>
            <td style="text-align:right;"><button type="button" class="delete-btn" title="Удалить">✕</button></td>`;
        const btn = tr.querySelector('button');
        btn.addEventListener('click', async () => {
            if (!btn.dataset.confirm) { btn.dataset.confirm = '1'; btn.textContent = '✓?'; setTimeout(() => { delete btn.dataset.confirm; btn.textContent = '✕'; }, 2000); return; }
            try { await fetchAPI(`/finance/withdrawals/${w.id}`, { method: 'DELETE' }); await loadFinance(); } catch (e) { alert('Ошибка: ' + e.message); }
        });
        return tr;
    }));
    document.getElementById('fin-wd-empty')?.classList.toggle('hidden', finData.withdrawals.length > 0);
}

const FIN_OP_LABELS = { payment: 'Оплата клиента', tax: 'Налоги и комиссии', purchase: 'Закупка', shipping: 'Доставка до РФ' };

function renderFinOps() {
    const tbody = document.querySelector('#fin-ops-table tbody');
    if (!tbody || !finData) return;
    const showAll = document.getElementById('fin-ops-all')?.checked;
    const start = finData.start_date;
    const rows = finData.operations.map(e => ({
        day: e.created_at.slice(0, 10), amount: e.amount,
        text: `${FIN_OP_LABELS[e.kind] || e.kind}${e.order_id ? ` · заказ #${e.order_id}` : ''}${e.items ? ` — ${e.items}` : ''}`, note: e.note
    }));
    finData.withdrawals.forEach(w => { if (showAll || w.wd_date >= start) rows.push({ day: w.wd_date, amount: -w.amount, text: 'Вывод владельцу' + (w.comment ? ` — ${w.comment}` : ''), note: '' }); });
    (rawLedgerEntries || []).forEach(l => {
        const p = ledgerDateParts(l.entry_date);
        if (!p) return;
        const day = `${p.year}-${p.month}-${p.day}`;
        if (showAll || day >= start) rows.push({ day, amount: l.entry_type === 'income' ? l.amount : -l.amount, text: (l.entry_type === 'income' ? 'Прочий доход' : 'Прочий расход') + (l.description ? ` — ${l.description}` : ''), note: '' });
    });
    rows.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
    tbody.innerHTML = rows.slice(0, 500).map(r => `
        <tr><td style="white-space:nowrap;">${isoRu(r.day)}</td>
        <td>${escapeHtml(r.text)}${r.note ? ` <span class="fin-note-inline">${escapeHtml(r.note)}</span>` : ''}</td>
        <td class="num ${r.amount < 0 ? 'neg' : 'pos'}">${signedRub(r.amount)}</td></tr>`).join('');
    document.getElementById('fin-ops-empty')?.classList.toggle('hidden', rows.length > 0);
}

function shiftFinMonth(delta) {
    const [y, m] = window.finMonth.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    window.finMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    loadFinance();
    renderLedger();
}

function openFinSettings() {
    if (!finData) return;
    const s = finData.settings;
    const form = document.getElementById('fin-settings-form');
    form.querySelector('.reg-error').classList.add('hidden');
    document.getElementById('fin-set-start').value = s.start_date;
    if (finData.baseline_at) document.getElementById('fin-set-start').min = finData.baseline_at;
    document.getElementById('fin-set-balance').value = s.start_balance;
    document.getElementById('fin-set-markup').value = s.fx_markup_pct;
    document.getElementById('fin-set-add-rub').value = s.fx_add_rub ?? 3;
    document.getElementById('fin-set-tax').value = s.tax_pct;
    const fx = finData.fx || {};
    document.getElementById('fin-set-fx').innerHTML = fx.cbr
        ? `Курс ЦБ на ${isoRu(fx.day)}: <b>${Number(fx.cbr).toFixed(2)} ₽</b>, для закупок с наценкой: <b>${Number(fx.rate).toFixed(2)} ₽</b>`
        : 'Курс ЦБ сейчас недоступен — заказы будут без плановой закупки, пока он не загрузится.';
    const statuses = [...new Set([...ALL_STATUSES_LIST, ...Object.keys(s.status_stages)])];
    document.getElementById('fin-set-stages').innerHTML = statuses.map(st => `
        <label class="fin-stage-row"><span>${escapeHtml(st)}</span>
        <select data-status="${escapeHtml(st)}">${Object.entries(FIN_STAGES).map(([v, t]) => `<option value="${v}"${Number(s.status_stages[st] ?? 1) === Number(v) ? ' selected' : ''}>${t}</option>`).join('')}</select></label>`).join('');
    const norms = document.getElementById('fin-set-norms');
    norms.innerHTML = '';
    Object.entries(s.shipping_norms || {}).forEach(([k, v]) => addNormRow(k, v));
    if (!Object.keys(s.shipping_norms || {}).length) ['Standard Pop', 'Deluxe', 'Jumbo'].forEach(k => addNormRow(k, ''));
    openModal(document.getElementById('fin-settings-modal'));
}

function addNormRow(kind = '', value = '') {
    const row = document.createElement('div');
    row.className = 'fin-norm-row';
    row.innerHTML = `<input type="text" list="product-kind-list" placeholder="Тип товара" value="${escapeHtml(kind)}"><input type="number" min="0" step="1" placeholder="₽" value="${value}"><button type="button" class="delete-btn" title="Убрать">✕</button>`;
    row.querySelector('button').addEventListener('click', () => row.remove());
    document.getElementById('fin-set-norms').appendChild(row);
}

(function initFinance() {
    document.getElementById('fin-prev')?.addEventListener('click', () => shiftFinMonth(-1));
    document.getElementById('fin-next')?.addEventListener('click', () => shiftFinMonth(1));
    document.querySelectorAll('.fin-tab').forEach(btn => btn.addEventListener('click', () => {
        document.querySelectorAll('.fin-tab').forEach(b => b.classList.toggle('active', b === btn));
        document.querySelectorAll('.fin-panel').forEach(p => p.classList.toggle('hidden', p.dataset.finPanel !== btn.dataset.finTab));
    }));
    document.getElementById('fin-orders-search')?.addEventListener('input', () => { finOrdersShown = 100; renderFinOrders(); });
    document.getElementById('fin-orders-filter')?.addEventListener('change', () => { finOrdersShown = 100; renderFinOrders(); });
    document.getElementById('fin-orders-more')?.addEventListener('click', () => { finOrdersShown += 100; renderFinOrders(); });
    document.getElementById('fin-ops-all')?.addEventListener('change', loadFinance);
    document.getElementById('fin-export-btn')?.addEventListener('click', exportFinance);

    const wdForm = document.getElementById('fin-withdraw-form');
    document.getElementById('fin-withdraw-btn')?.addEventListener('click', () => {
        wdForm.reset();
        wdForm.querySelector('.reg-error').classList.add('hidden');
        document.getElementById('fin-wd-date').value = new Date().toISOString().slice(0, 10);
        openModal(document.getElementById('fin-withdraw-modal'));
        setTimeout(() => document.getElementById('fin-wd-amount').focus(), 30);
    });
    wdForm?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const err = wdForm.querySelector('.reg-error');
        const amount = parseInt(document.getElementById('fin-wd-amount').value, 10);
        const wd_date = document.getElementById('fin-wd-date').value;
        if (!wd_date || !(amount > 0)) { err.textContent = 'Укажите дату и сумму'; err.classList.remove('hidden'); return; }
        try {
            await fetchAPI('/finance/withdrawals', { method: 'POST', body: JSON.stringify({ wd_date, amount, comment: document.getElementById('fin-wd-comment').value }) });
            closeModals();
            await loadFinance();
        } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
    });

    const setForm = document.getElementById('fin-settings-form');
    document.getElementById('fin-settings-btn')?.addEventListener('click', openFinSettings);
    document.getElementById('fin-set-norm-add')?.addEventListener('click', () => addNormRow());
    setForm?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const err = setForm.querySelector('.reg-error');
        const status_stages = {};
        setForm.querySelectorAll('[data-status]').forEach(sel => { status_stages[sel.dataset.status] = parseInt(sel.value, 10); });
        const shipping_norms = {};
        setForm.querySelectorAll('.fin-norm-row').forEach(r => {
            const [k, v] = r.querySelectorAll('input');
            if (k.value.trim() && parseInt(v.value, 10) > 0) shipping_norms[k.value.trim()] = parseInt(v.value, 10);
        });
        const body = {
            start_date: document.getElementById('fin-set-start').value,
            start_balance: parseInt(document.getElementById('fin-set-balance').value, 10) || 0,
            fx_markup_pct: parseFloat(document.getElementById('fin-set-markup').value) || 0,
            fx_add_rub: parseFloat(document.getElementById('fin-set-add-rub').value) || 0,
            tax_pct: parseFloat(document.getElementById('fin-set-tax').value) || 0,
            status_stages, shipping_norms
        };
        try {
            await fetchAPI('/finance/settings', { method: 'PUT', body: JSON.stringify(body) });
            closeModals();
            await loadFinance();
        } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
    });
})();

// Inline editing for cost_price and delivery_cost in accounting table
window.startInlineEdit = function(orderId, field, currentVal, cellEl) {
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'inline-edit-input';
    input.value = currentVal;
    input.min = 0;
    cellEl.innerHTML = '';
    cellEl.appendChild(input);
    input.focus();
    input.select();

    async function save() {
        const newVal = parseInt(input.value) || 0;
        const order = allOrders.find(o => o.id === orderId);
        if (!order) return;
        const payload = {
            items: order.items,
            total_price: order.total_price,
            paid_amount: order.paid_amount,
            status: order.status,
            photo_id: order.photo_id,
            order_date: order.order_date,
            cost_price: field === 'cost_price' ? newVal : (order.cost_price || 0),
            delivery_cost: field === 'delivery_cost' ? newVal : (order.delivery_cost || 0)
        };
        try {
            await fetchAPI(`/orders/${orderId}`, { method: 'PUT', body: JSON.stringify(payload) });
            await loadDashboardData();
        } catch (err) {
            alert('Ошибка: ' + err.message);
            renderAccounting();
        }
    }

    input.addEventListener('blur', save);
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { input.blur(); }
        if (e.key === 'Escape') { renderAccounting(); }
    });
};

// Initialize application
initSidebar();
init();

// --- Home motion: pointer tilt on the hero collage, scroll reveal ---
(function homeMotion() {
    const collage = document.querySelector('.hero-collage');
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (collage && !still && window.matchMedia('(hover: hover)').matches) {
        const hero = collage.closest('.hero');
        hero.addEventListener('pointermove', (e) => {
            const r = collage.getBoundingClientRect();
            const x = (e.clientX - (r.left + r.width / 2)) / (window.innerWidth / 2);
            const y = (e.clientY - (r.top + r.height / 2)) / (window.innerHeight / 2);
            collage.style.setProperty('--tilt-y', `${Math.max(-1, Math.min(1, x)) * 12}deg`);
            collage.style.setProperty('--tilt-x', `${Math.max(-1, Math.min(1, y)) * -9}deg`);
        });
        hero.addEventListener('pointerleave', () => {
            collage.style.setProperty('--tilt-x', '0deg');
            collage.style.setProperty('--tilt-y', '0deg');
        });
    }
    const targets = document.querySelectorAll('.benefits, .home-new, .home-hub-grid > *, .landing-section, .landing-footer');
    if (still || !('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver((entries) => entries.forEach(en => {
        if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
    }), { threshold: 0.12 });
    targets.forEach(t => { t.classList.add('reveal'); io.observe(t); });
})();

// --- Lower home sections: cards tilt toward the pointer, the stock banner boxes turn with pointer and scroll ---
(function lowerSectionsMotion() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const hover = window.matchMedia('(hover: hover)').matches;
    if (hover) {
        document.querySelectorAll('.step-card, .info-card, .feature-card, .faq-accordion-item, .faq-manager-callout, .hub-card').forEach(card => {
            card.addEventListener('pointermove', (e) => {
                const r = card.getBoundingClientRect();
                const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
                const k = Math.min(1, 420 / r.width); // wide cards tilt less, so a long FAQ row does not swing
                card.style.setProperty('--ry', `${((x - 0.5) * 12 * k).toFixed(2)}deg`);
                card.style.setProperty('--rx', `${((0.5 - y) * 10 * k).toFixed(2)}deg`);
                card.style.setProperty('--mx', `${(x * 100).toFixed(1)}%`);
                card.style.setProperty('--my', `${(y * 100).toFixed(1)}%`);
            });
            card.addEventListener('pointerleave', () => {
                card.style.setProperty('--rx', '0deg');
                card.style.setProperty('--ry', '0deg');
            });
        });
    }
})();

// --- Footer terminal: a STOP sign drawn in code that glitches now and then, and a typewriter pitch ---
(function footerAscii() {
    const fig = document.querySelector('.ascii-fig');
    const out = document.querySelector('.ascii-type');
    if (!fig || !out) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const GLYPHS = '01#$%&*+=<>/{}[]';
    const draw = (word, lit) => [
        `      .--------.`,
        `     /          \\`,
        `    /            \\`,
        `   |   <b class="${lit ? 'r' : 'r dim'}">${word}</b>    |`,
        `    \\            /`,
        `     \\          /`,
        `      '--------'`,
        `          ||`,
        `          ||`,
        `       ___||___`
    ].map((l, i) => l.replace(/^( *)(.*)$/, `$1<span class="${i < 7 ? 'sign' : 'pole'}">$2</span>`)).join('\n');
    const WORD = 'S T O P';
    fig.innerHTML = draw(WORD, true);
    const lines = ['stop переплачивать', 'stop ждать без трекинга', 'stop искать по всем сайтам', 'echo "funko stop. collect. trade. repeat."'];
    if (still) { out.textContent = lines.map(l => '$ ' + l).join('\n'); return; }
    // every few seconds the sign glitches into code for a moment and flickers back on
    (function glitch() {
        setTimeout(() => {
            let n = 0;
            const t = setInterval(() => {
                const scrambled = WORD.replace(/[A-Z]/g, () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)]);
                fig.innerHTML = draw(n % 2 ? WORD : scrambled, n % 3 !== 1);
                if (++n > 6) { clearInterval(t); fig.innerHTML = draw(WORD, true); glitch(); }
            }, 70);
        }, 2600 + Math.random() * 2600);
    })();
    let li = 0, ci = 0, erasing = false;
    const caret = '<span class="c"></span>';
    const type = () => {
        const text = lines[li];
        out.innerHTML = `<span class="p">$</span> ${text.slice(0, ci).replace(/</g, '&lt;')}${caret}`;
        if (!erasing && ci < text.length) { ci++; return setTimeout(type, 55 + Math.random() * 45); }
        if (!erasing) { erasing = true; return setTimeout(type, 1600); }
        if (ci > 0) { ci = Math.max(0, ci - 2); return setTimeout(type, 22); }
        erasing = false; li = (li + 1) % lines.length; setTimeout(type, 350);
    };
    type();
})();

// Late-loading images shift the page: re-aim deep links once everything is loaded
window.addEventListener('load', () => {
    const a = window.location.hash && document.getElementById(window.location.hash.slice(1));
    if (a && document.getElementById('home-tab')?.contains(a)) a.scrollIntoView({ behavior: 'instant' });
});

// --- Theme toggle (choice remembered; the <head> script applies it before first paint) ---
document.getElementById('theme-toggle')?.addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme !== 'dark';
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    try { localStorage.setItem('funko_theme', dark ? 'dark' : 'light'); } catch {}
    document.getElementById('theme-toggle').setAttribute('aria-pressed', String(dark));
});

// header gets a shadow once the page is scrolled
(function headerScroll() {
    const hdr = document.getElementById('site-header');
    if (!hdr) return;
    const on = () => hdr.classList.toggle('scrolled', window.scrollY > 8);
    window.addEventListener('scroll', on, { passive: true });
    on();
})();

// --- Admin: products list with search, filters and sorting ---
function productStatus(p) {
    const st = stockInfo(p);
    if (st.sold) return { label: 'Распродан', cls: 'card-tag-sold' };
    return p.in_stock ? { label: 'В наличии', cls: 'card-tag-stock' } : { label: 'Предзаказ', cls: 'card-tag-pre' };
}

// the filters are independent facts, so a preorder with 3 pieces left is both "preorder" and "low"
function matchesStockFilter(p, filter) {
    const st = stockInfo(p);
    switch (filter) {
        case 'instock': return !!p.in_stock && !st.sold;
        case 'preorder': return !p.in_stock && !st.sold;
        case 'low': return st.few;
        case 'sold': return st.sold;
        default: return true;
    }
}

function renderProductsAdmin() {
    const body = document.querySelector('#products-table tbody');
    if (!body) return;
    const search = (document.getElementById('products-search')?.value || '').toLowerCase().trim();
    const stockFilter = document.getElementById('products-filter-stock')?.value || 'all';
    const catSelect = document.getElementById('products-filter-category');
    const sort = document.getElementById('products-sort')?.value || 'new';

    const cats = [...new Set(rawCatalogProducts.map(p => p.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
    if (catSelect) {
        const cur = catSelect.value;
        const sig = cats.join('|');
        if (catSelect.dataset.sig !== sig) {
            catSelect.replaceChildren(new Option('Все бренды', ''), ...cats.map(c => new Option(c, c)));
            catSelect.value = cats.includes(cur) ? cur : '';
            catSelect.dataset.sig = sig;
        }
    }
    const cat = catSelect?.value || '';

    let list = rawCatalogProducts.filter(p => {
        const hay = `${p.name} ${p.figure_number || ''} ${p.category || ''} ${p.series || ''} ${p.badge || ''}`.toLowerCase();
        if (search && !hay.includes(search)) return false;
        if (cat && p.category !== cat) return false;
        if (!matchesStockFilter(p, stockFilter)) return false;
        return true;
    });
    const price = (p) => p.final_price || p.price || 0;
    const sorters = {
        new: (a, b) => b.id - a.id,
        name: (a, b) => a.name.localeCompare(b.name, 'ru'),
        price_asc: (a, b) => price(a) - price(b),
        price_desc: (a, b) => price(b) - price(a),
        stock_asc: (a, b) => (stockInfo(a).tracked ? a.stock_qty : 1e9) - (stockInfo(b).tracked ? b.stock_qty : 1e9)
    };
    list.sort(sorters[sort] || sorters.new);

    const count = document.getElementById('products-count');
    if (count) count.textContent = `Показано ${list.length} из ${rawCatalogProducts.length}`;

    if (!list.length) {
        body.innerHTML = '<tr class="empty-row"><td colspan="7" style="text-align:center; padding:28px; color:var(--muted);">Ничего не найдено</td></tr>';
        return;
    }
    body.replaceChildren(...list.map(p => {
        const tr = document.createElement('tr');
        const ids = photoIds(p.photo_id);
        const status = productStatus(p);
        const stock = stockInfo(p);
        const photo = ids[0] ? `<img src="${photoUrl(ids[0])}" alt="" loading="lazy" style="width:44px;height:44px;object-fit:contain;background:var(--img-bg);border-radius:6px;">` : '<span style="color:var(--muted)">—</span>';
        const cell = (html, cls = '') => { const td = document.createElement('td'); if (cls) td.className = cls; td.innerHTML = html; return td; };
        const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        tr.append(
            cell(photo),
            cell(`${p.figure_number ? `<span style="color:var(--muted)">#${esc(p.figure_number)}</span> ` : ''}${esc(p.name)}${p.hidden ? ' <span class="card-tag-hidden">Скрыт</span>' : ''}`, 'product-name-cell'),
            cell(`${esc(p.category || '')}${p.series ? `<div style="color:var(--muted);font-size:0.82rem;">${esc(p.series)}</div>` : ''}`),
            cell(`${price(p).toLocaleString('ru')} ₽${p.discount_percent > 0 ? `<div style="color:var(--muted);font-size:0.8rem;text-decoration:line-through;">${p.price.toLocaleString('ru')} ₽</div>` : ''}`),
            cell(stock.tracked ? `<strong>${stock.qty}</strong> шт.` : '<span style="color:var(--muted)">—</span>'),
            cell(`<span class="${status.cls}">${status.label}</span>`),
            cell(`<button type="button" class="btn secondary outline product-edit-btn" style="padding:6px 12px;font-size:0.8rem;" onclick="window.openEditProductModal(${p.id})">Изменить</button> <button type="button" class="btn danger outline product-delete-btn" style="padding:6px 12px;font-size:0.8rem;" onclick="window.confirmDeleteProduct(${p.id})" aria-label="Удалить">✕</button>`)
        );
        return tr;
    }));
}
window.renderProductsAdmin = renderProductsAdmin;
['products-search', 'products-filter-stock', 'products-filter-category', 'products-sort'].forEach(id => {
    const el = document.getElementById(id);
    el?.addEventListener(id === 'products-search' ? 'input' : 'change', renderProductsAdmin);
});
document.getElementById('products-add-btn')?.addEventListener('click', () => window.openAddProductModal());

let handledUrlProduct = '';
async function openProductFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const id = parseInt(params.get('product') || '', 10);
    if (!id) { handledUrlProduct = ''; return; }
    const signature = `${id}|${params.get('k') || ''}`;
    if (handledUrlProduct === signature) return;
    handledUrlProduct = signature;
    if (findProduct(id)) { window.openProductDetail(id); return; }
    try {
        const res = await fetch(`/api/catalog/${id}?k=${encodeURIComponent(params.get('k') || '')}`, {
            headers: token ? { 'Authorization': `Bearer ${token}` } : {}
        });
        if (!res.ok) return;
        linkedProducts.push(await res.json());
        window.openProductDetail(id);
    } catch (e) { /* offline: stay on the catalog */ }
}
