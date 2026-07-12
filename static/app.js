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
    localStorage.removeItem('funko_token');
    // Clear all rendered data so nothing flashes on next login
    ordersTableBody.innerHTML = '';
    archivedTableBody.innerHTML = '';
    clientsTableBody.innerHTML = '';
    if (accountingTableBody) accountingTableBody.innerHTML = '';
    allOrders = [];
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

// API
async function fetchAPI(endpoint, options = {}) {
    if (!token) return logoutBtn.click();
    
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
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
        allOrders = [...data.orders, ...(data.archived || [])];
        renderOrders(data.orders, data.role);
        renderArchivedOrders(data.archived || [], data.role);
        
        if (data.role === 'admin') {
            renderClients(data.clients);
            renderAccounting();
        }
    } catch (err) {
        console.error(err);
    }
}

// Render active orders
function renderOrders(orders, role) {
    ordersTableBody.innerHTML = '';
    const emptyMsg = document.getElementById('no-orders');
    
    if (orders.length === 0) {
        emptyMsg.classList.remove('hidden');
        return;
    }
    emptyMsg.classList.add('hidden');
    
    orders.forEach((order, i) => {
        const tr = document.createElement('tr');
        tr.className = 'row-animate';
        tr.style.animationDelay = `${i * 0.04}s`;
        
        let html = `<td>${order.id}</td>`;
        if (role === 'admin') {
            html += `<td class="admin-only">${order.client_id}</td>`;
        }
        
        html += order.photo_id
            ? `<td><button class="photo-btn" onclick="viewPhoto('${order.photo_id}')">Смотреть</button></td>`
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
function renderArchivedOrders(orders, role) {
    archivedTableBody.innerHTML = '';
    const emptyMsg = document.getElementById('no-archived');
    
    if (orders.length === 0) {
        emptyMsg.classList.remove('hidden');
        return;
    }
    emptyMsg.classList.add('hidden');
    
    orders.forEach((order, i) => {
        const tr = document.createElement('tr');
        tr.className = 'row-animate';
        tr.style.animationDelay = `${i * 0.04}s`;
        
        let html = `<td>${order.id}</td>`;
        if (role === 'admin') {
            html += `<td class="admin-only">${order.client_id}</td>`;
        }
        
        html += order.photo_id
            ? `<td><button class="photo-btn" onclick="viewPhoto('${order.photo_id}')">Смотреть</button></td>`
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

// Render Accounting
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
    
    // Sort
    filteredOrders.sort((a, b) => {
        let valA, valB;
        if (accountingSort.key === 'id') { valA = a.id; valB = b.id; }
        else if (accountingSort.key === 'date') { valA = a.order_date || ''; valB = b.order_date || ''; }
        else if (accountingSort.key === 'price') { valA = a.total_price; valB = b.total_price; }
        else if (accountingSort.key === 'cost') { valA = a.cost_price; valB = b.cost_price; }
        else if (accountingSort.key === 'delivery') { valA = a.delivery_cost; valB = b.delivery_cost; }
        else if (accountingSort.key === 'margin') { 
            valA = a.total_price - (a.cost_price || 0) - (a.delivery_cost || 0); 
            valB = b.total_price - (b.cost_price || 0) - (b.delivery_cost || 0); 
        }
        
        if (valA < valB) return accountingSort.desc ? 1 : -1;
        if (valA > valB) return accountingSort.desc ? -1 : 1;
        return 0;
    });

    filteredOrders.forEach((order, i) => {
        const tr = document.createElement('tr');
        tr.className = 'row-animate';
        tr.style.animationDelay = `${i * 0.04}s`;
        
        const cost = order.cost_price || 0;
        const delivery = order.delivery_cost || 0;
        const margin = order.total_price - cost - delivery;
        
        tr.innerHTML = `
            <td>${order.id}</td>
            <td>${order.order_date || '—'}</td>
            <td>${order.items.replace(/\n/g, '<br>')}</td>
            <td>${order.total_price.toLocaleString('ru')}</td>
            <td>${cost.toLocaleString('ru')}</td>
            <td>${delivery.toLocaleString('ru')}</td>
            <td style="color: ${margin >= 0 ? '#00ff88' : '#ff4d4d'}; font-weight: bold;">
                ${margin.toLocaleString('ru')}
            </td>
        `;
        accountingTableBody.appendChild(tr);
    });
}

if (accountingSearch) {
    accountingSearch.addEventListener('input', renderAccounting);
}

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
createOrderBtn.addEventListener('click', () => openModal(createOrderModal));
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

init();
