/**
 * Lightspeed Live Orders - Real-Time Dashboard Client
 * Handles Server-Sent Events (SSE), Web Audio alerts, dynamic DOM updates,
 * status transitions, filtering, and settings management.
 */

// Global State
let orders = [];
let currentFilter = 'all';
let searchQuery = '';
let currentView = 'cards';
let currentMainView = 'orders'; // 'orders' or 'items'
let isSoundEnabled = localStorage.getItem('ls_sound_enabled') !== 'false';
let eventSource = null;
let currentModalOrderId = null;
let selectedQueueItem = null;
let activeQueueItems = [];
let detailedQueueItems = [];

// Initialize Web Audio Context
let audioCtx = null;
function getAudioContext() {
  if (!audioCtx) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (AudioContext) {
      audioCtx = new AudioContext();
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  return audioCtx;
}

// Unlock Web Audio on iOS Safari / iPadOS
function unlockAudioForMobile() {
  const ctx = getAudioContext();
  if (!ctx) return;

  if (ctx.state === 'suspended') {
    ctx.resume().then(() => {
      hideAudioBanner();
      showToast('Sound alerts enabled for this device', 'success');
    }).catch(e => console.warn("Could not resume audio:", e));
  } else {
    hideAudioBanner();
  }

  // Play a silent 0.01s buffer to unlock iOS hardware mute
  try {
    const buffer = ctx.createBuffer(1, 1, 22050);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(0);
  } catch (err) {}
}

function hideAudioBanner() {
  const banner = document.getElementById('mobile-audio-banner');
  if (banner) banner.style.display = 'none';
}

function checkMobileAudio() {
  // Show prompt if on touch device / iOS and audio is suspended
  const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  if (isTouchDevice && isSoundEnabled) {
    const banner = document.getElementById('mobile-audio-banner');
    if (banner) {
      const ctx = getAudioContext();
      if (ctx && ctx.state === 'suspended') {
        banner.style.display = 'flex';
      }
    }
  }
}

// Play a pleasant two-tone order notification bell
function playOrderChime() {
  if (!isSoundEnabled) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    
    // Tone 1: E5 (659.25 Hz)
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(659.25, now);
    gain1.gain.setValueAtTime(0, now);
    gain1.gain.linearRampToValueAtTime(0.25, now + 0.04);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.5);

    // Tone 2: B5 (987.77 Hz)
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(987.77, now + 0.12);
    gain2.gain.setValueAtTime(0, now + 0.12);
    gain2.gain.linearRampToValueAtTime(0.35, now + 0.16);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.85);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.12);
    osc2.stop(now + 0.9);
  } catch (e) {
    console.warn("Audio chime could not play:", e);
  }
}

// Format relative time: e.g. "Just now", "2m ago", "1h ago"
function formatTimeAgo(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  const now = new Date();
  const diffInSeconds = Math.floor((now - date) / 1000);

  if (diffInSeconds < 30) return 'Just now';
  if (diffInSeconds < 60) return `${diffInSeconds}s ago`;
  const minutes = Math.floor(diffInSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return date.toLocaleDateString();
}

// Format currency
function formatCurrency(amount, currency = 'USD') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency || 'USD'
  }).format(amount || 0);
}

// Toast Notifications
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'toast';
  
  let icon = '🔔';
  if (type === 'success') icon = '✅';
  if (type === 'warning') icon = '⚠️';
  if (type === 'error') icon = '❌';

  toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// Setup Real-time SSE Stream
function initSSE() {
  const statusBadge = document.getElementById('live-status-badge');
  const statusText = document.getElementById('live-status-text');

  if (eventSource) {
    eventSource.close();
  }

  statusBadge.className = 'live-badge connecting';
  statusText.textContent = 'CONNECTING...';

  eventSource = new EventSource('/api/stream');

  eventSource.onopen = () => {
    statusBadge.className = 'live-badge';
    statusText.textContent = 'LIVE STREAMING';
  };

  eventSource.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      handleServerEvent(payload);
    } catch (err) {
      console.error("Error parsing SSE data:", err);
    }
  };

  eventSource.onerror = () => {
    statusBadge.className = 'live-badge connecting';
    statusText.textContent = 'RECONNECTING...';
  };
}

// Dispatch incoming SSE events
function handleServerEvent(payload) {
  const { type, data } = payload;

  if (type === 'connected') {
    fetchStats();
    if (payload.queue_summary) {
      renderQueueSummaryUI(payload.queue_summary);
    } else {
      computeQueueSummary();
    }
    if (payload.detailed_queue) {
      detailedQueueItems = payload.detailed_queue;
      updateStationBadge();
      if (currentMainView === 'items') renderItemsStation();
    }
    return;
  }

  if (type === 'new_order') {
    const exists = orders.some(o => o.id === data.id);
    if (!exists) {
      orders.unshift(data);
      playOrderChime();
      showToast(`New Order ${data.order_number} received! (${formatCurrency(data.total)})`, 'success');
      renderOrders(data.id);
      fetchStats();
      computeQueueSummary();
      fetchDetailedQueueItems();
    }
    return;
  }

  if (type === 'order_updated') {
    const idx = orders.findIndex(o => o.id === data.id);
    if (idx !== -1) {
      orders[idx] = data;
    } else {
      orders.unshift(data);
    }
    renderOrders();
    fetchStats();
    computeQueueSummary();
    fetchDetailedQueueItems();
    if (currentModalOrderId === data.id) {
      renderOrderModal(data);
    }
    return;
  }

  if (type === 'orders_cleared') {
    orders = [];
    detailedQueueItems = [];
    renderOrders();
    fetchStats();
    renderQueueSummaryUI([]);
    updateStationBadge();
    if (currentMainView === 'items') renderItemsStation();
    showToast('All orders cleared.', 'info');
    return;
  }

  if (type === 'queue_updated') {
    renderQueueSummaryUI(data);
    return;
  }

  if (type === 'detailed_queue_updated') {
    detailedQueueItems = data || [];
    updateStationBadge();
    if (currentMainView === 'items') renderItemsStation();
    return;
  }

  if (type === 'stats_updated') {
    updateStatsUI(data);
  }
}

// Fetch all orders from backend REST API
async function fetchOrders() {
  try {
    const res = await fetch('/api/orders?limit=100');
    const data = await res.json();
    orders = data.orders || [];
    renderOrders();
    computeQueueSummary();
    fetchDetailedQueueItems();
  } catch (err) {
    console.error("Failed to fetch orders:", err);
  }
}

// Fetch stats summary
async function fetchStats() {
  try {
    const res = await fetch('/api/stats');
    const stats = await res.json();
    updateStatsUI(stats);
  } catch (err) {
    console.error("Failed to fetch stats:", err);
  }
}

function updateStatsUI(stats) {
  if (!stats) return;
  document.getElementById('stat-today-orders').textContent = stats.today_orders ?? 0;
  document.getElementById('stat-today-revenue').textContent = formatCurrency(stats.today_revenue ?? 0);
  document.getElementById('stat-pending-orders').textContent = stats.pending_orders ?? 0;
  document.getElementById('stat-in-progress-orders').textContent = stats.in_progress_orders ?? 0;

  // Update tab counts
  const newCount = orders.filter(o => o.status === 'new').length;
  const inProgCount = orders.filter(o => o.status === 'in_progress').length;
  const readyCount = orders.filter(o => o.status === 'ready').length;
  const completedCount = orders.filter(o => o.status === 'completed').length;

  document.getElementById('tab-count-all').textContent = orders.length;
  document.getElementById('tab-count-new').textContent = newCount;
  document.getElementById('tab-count-in_progress').textContent = inProgCount;
  document.getElementById('tab-count-ready').textContent = readyCount;
  document.getElementById('tab-count-completed').textContent = completedCount;
}

// Compute Kitchen Item Queue Summary from active orders ('new' and 'in_progress')
function computeQueueSummary() {
  const itemMap = {};
  const activeOrders = orders.filter(o => o.status === 'new' || o.status === 'in_progress');
  
  for (const order of activeOrders) {
    for (const item of (order.items || [])) {
      const name = item.name || 'Item';
      if (!itemMap[name]) {
        itemMap[name] = { name: name, total_quantity: 0, order_ids: new Set() };
      }
      itemMap[name].total_quantity += parseInt(item.quantity || 1, 10);
      itemMap[name].order_ids.add(order.id);
    }
  }

  activeQueueItems = Object.values(itemMap).map(it => ({
    name: it.name,
    total_quantity: it.total_quantity,
    order_count: it.order_ids.size
  })).sort((a, b) => b.total_quantity - a.total_quantity);

  renderQueueSummaryUI(activeQueueItems);
}

// Render the Kitchen Items Queue (All-Day bar)
function renderQueueSummaryUI(items) {
  const container = document.getElementById('queue-items-container');
  const totalBadge = document.getElementById('queue-total-items-badge');
  const clearBtn = document.getElementById('clear-item-filter-btn');
  if (!container) return;

  activeQueueItems = items || [];
  const totalItemsCount = activeQueueItems.reduce((sum, it) => sum + (it.total_quantity || 0), 0);
  if (totalBadge) {
    totalBadge.textContent = `${totalItemsCount} to make`;
  }

  if (clearBtn) {
    clearBtn.style.display = selectedQueueItem ? 'inline-block' : 'none';
  }

  if (!items || items.length === 0) {
    container.innerHTML = `<span class="queue-empty-msg">No items in prep queue. All active orders completed!</span>`;
    return;
  }

  container.innerHTML = items.map(it => {
    const isSelected = selectedQueueItem === it.name ? 'active' : '';
    const orderPlural = it.order_count === 1 ? 'order' : 'orders';
    return `
      <div class="queue-item-pill ${isSelected}" onclick="toggleQueueItemFilter('${escapeHtml(it.name)}')">
        <span class="queue-item-qty">${it.total_quantity}×</span>
        <span class="queue-item-name">${escapeHtml(it.name)}</span>
        <span class="queue-item-orders">(${it.order_count} ${orderPlural})</span>
      </div>
    `;
  }).join('');
}

function toggleQueueItemFilter(itemName) {
  if (selectedQueueItem === itemName) {
    selectedQueueItem = null;
  } else {
    selectedQueueItem = itemName;
  }
  renderQueueSummaryUI(activeQueueItems);
  renderOrders();
}

function clearItemFilter() {
  selectedQueueItem = null;
  renderQueueSummaryUI(activeQueueItems);
  renderOrders();
}

// Filter and search orders
function getFilteredOrders() {
  return orders.filter(order => {
    // Queue item filter (when clicked from Kitchen Queue bar)
    if (selectedQueueItem) {
      const hasItem = (order.items || []).some(it => it.name === selectedQueueItem);
      if (!hasItem) return false;
    }
    // Status filter
    if (currentFilter !== 'all' && order.status !== currentFilter) {
      return false;
    }
    // Search query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchNum = (order.order_number || '').toLowerCase().includes(q);
      const matchCust = (order.customer_name || '').toLowerCase().includes(q);
      const matchEmail = (order.customer_email || '').toLowerCase().includes(q);
      const matchItem = (order.items || []).some(it => (it.name || '').toLowerCase().includes(q));
      return matchNum || matchCust || matchEmail || matchItem;
    }
    return true;
  });
}

// Render Orders list / cards
function renderOrders(highlightId = null) {
  const container = document.getElementById('orders-container');
  const filtered = getFilteredOrders();

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / -1;">
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
        </svg>
        <h3>No orders found</h3>
        <p>${searchQuery ? 'Try clearing your search query.' : 'Waiting for incoming orders from Lightspeed...'}</p>
        <button class="btn btn-secondary" onclick="simulateOrder()" style="margin-top: 16px;">
          ⚡ Send Simulated Order
        </button>
      </div>
    `;
    return;
  }

  container.innerHTML = filtered.map(order => {
    const isHighlighted = order.id === highlightId ? 'highlight-new' : '';
    const statusLabel = (order.status || 'new').replace('_', ' ');
    const itemsPreview = (order.items || []).slice(0, 4);
    const extraCount = (order.items || []).length - itemsPreview.length;

    // Quick action buttons based on status
    let actionButtons = '';
    if (order.status === 'new') {
      actionButtons = `
        <button class="action-btn-mini btn-secondary" onclick="event.stopPropagation(); updateOrderStatus('${order.id}', 'in_progress', false)">
          ⏳ Prep
        </button>
        <button class="action-btn-mini btn-local-ready" onclick="event.stopPropagation(); updateOrderStatus('${order.id}', 'ready', false)" title="Mark Ready on dashboard only (Safe from POS)">
          🛡️ Ready (Local)
        </button>
        <button class="action-btn-mini btn-api-ready" onclick="event.stopPropagation(); updateOrderStatus('${order.id}', 'ready', true)" title="Mark Ready & Sync to Lightspeed POS API">
          ☁️ Ready (API)
        </button>
      `;
    } else if (order.status === 'in_progress') {
      actionButtons = `
        <button class="action-btn-mini btn-local-ready" onclick="event.stopPropagation(); updateOrderStatus('${order.id}', 'ready', false)" title="Mark Ready on dashboard only (Safe from POS)">
          🛡️ Ready (Local)
        </button>
        <button class="action-btn-mini btn-api-ready" onclick="event.stopPropagation(); updateOrderStatus('${order.id}', 'ready', true)" title="Mark Ready & Sync to Lightspeed POS API">
          ☁️ Ready (API)
        </button>
      `;
    } else if (order.status === 'ready') {
      actionButtons = `
        <button class="action-btn-mini btn-local-complete" onclick="event.stopPropagation(); updateOrderStatus('${order.id}', 'completed', false)" title="Complete on dashboard only (Safe from POS)">
          🛡️ Complete (Local)
        </button>
        <button class="action-btn-mini btn-api-complete" onclick="event.stopPropagation(); updateOrderStatus('${order.id}', 'completed', true)" title="Complete & Sync to Lightspeed POS API">
          ☁️ Complete (API)
        </button>
      `;
    } else {
      actionButtons = `
        <button class="action-btn-mini btn-secondary" onclick="event.stopPropagation(); updateOrderStatus('${order.id}', 'new', false)">
          ↩ Reopen
        </button>
      `;
    }

    const syncBadge = order.synced_to_lightspeed
      ? '<span class="sync-status-pill synced" title="Synced with Lightspeed API">☁️ Synced</span>'
      : '<span class="sync-status-pill local" title="Local display only">🛡️ Local</span>';

    return `
      <div class="order-card ${isHighlighted}" onclick="openOrderModal('${order.id}')">
        <div class="order-card-header">
          <div class="order-num-time">
            <span class="order-number">${escapeHtml(order.order_number || order.id)}</span>
            <span class="order-time" data-timestamp="${order.created_at}">${formatTimeAgo(order.created_at)}</span>
          </div>
          <div style="display: flex; align-items: center; gap: 6px;">
            ${syncBadge}
            <span class="status-badge ${order.status}">${statusLabel}</span>
          </div>
        </div>

        <div class="order-card-body">
          <div class="customer-row">
            <span class="cust-name">${escapeHtml(order.customer_name || 'Walk-in Customer')}</span>
            <span class="order-type-tag">${escapeHtml(order.order_type || 'In-Store')}</span>
          </div>

          <ul class="order-items-list">
            ${itemsPreview.map(item => `
              <li class="item-row">
                <div class="item-left">
                  <span class="item-qty">${item.quantity}×</span>
                  <div>
                    <div class="item-name">${escapeHtml(item.name)}</div>
                    ${item.modifiers ? `<div class="item-modifiers">${escapeHtml(item.modifiers)}</div>` : ''}
                  </div>
                </div>
                <span class="item-price">${formatCurrency(item.total_price || (item.quantity * item.unit_price))}</span>
              </li>
            `).join('')}
            ${extraCount > 0 ? `<li style="font-size: 11px; color: var(--text-muted); text-align: center;">+ ${extraCount} more item${extraCount > 1 ? 's' : ''}</li>` : ''}
          </ul>
        </div>

        <div class="order-card-footer">
          <div class="order-footer-price-row">
            <span class="total-label">Total</span>
            <span class="total-amount">${formatCurrency(order.total, order.currency)}</span>
          </div>
          <div class="quick-action-btns">
            ${actionButtons}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// Update order status via REST API (supports syncToLightspeed: boolean)
async function updateOrderStatus(orderId, newStatus, syncToLightspeed = false) {
  try {
    const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus, sync_lightspeed: syncToLightspeed })
    });
    if (res.ok) {
      const data = await res.json();
      const idx = orders.findIndex(o => o.id === orderId);
      if (idx !== -1) {
        orders[idx] = data.order;
        renderOrders();
        fetchStats();
        computeQueueSummary();
      }
      if (syncToLightspeed) {
        const msg = data.api_result?.message || 'Updated & synced with Lightspeed API';
        showToast(`☁️ ${msg}`, 'success');
      } else {
        showToast(`🛡️ Marked as ${newStatus.replace('_', ' ')} (Local only)`, 'info');
      }
    }
  } catch (err) {
    console.error("Failed to update status:", err);
    showToast("Failed to update order status", "error");
  }
}

// Open Order Details Modal
function openOrderModal(orderId) {
  const order = orders.find(o => o.id === orderId);
  if (!order) return;
  currentModalOrderId = orderId;
  renderOrderModal(order);
  document.getElementById('order-modal').classList.add('active');
}

function closeOrderModal() {
  currentModalOrderId = null;
  document.getElementById('order-modal').classList.remove('active');
}

function renderOrderModal(order) {
  document.getElementById('modal-order-number').textContent = `Order ${order.order_number || order.id}`;
  
  const body = document.getElementById('modal-order-body');
  body.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-color); padding-bottom: 12px;">
      <div>
        <div style="font-size: 18px; font-weight: 700;">${escapeHtml(order.customer_name || 'Walk-in Customer')}</div>
        <div style="font-size: 12px; color: var(--text-secondary); margin-top: 2px;">
          ${order.customer_email ? `✉️ ${escapeHtml(order.customer_email)} ` : ''}
          ${order.customer_phone ? `📞 ${escapeHtml(order.customer_phone)}` : ''}
        </div>
      </div>
      <div style="text-align: right;">
        <span class="status-badge ${order.status}">${(order.status || 'new').replace('_', ' ')}</span>
        <div style="font-size: 11px; color: var(--text-secondary); margin-top: 4px;">
          ${order.created_at ? new Date(order.created_at).toLocaleString() : ''}
        </div>
      </div>
    </div>

    <div>
      <h4 style="font-size: 13px; text-transform: uppercase; color: var(--text-secondary); margin-bottom: 10px;">Order Details</h4>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; font-size: 13px; background: var(--bg-primary); padding: 12px; border-radius: var(--radius-md);">
        <div><span style="color: var(--text-muted);">Source:</span> <strong>${escapeHtml(order.source || 'Lightspeed')}</strong></div>
        <div><span style="color: var(--text-muted);">Fulfillment:</span> <strong>${escapeHtml(order.order_type || 'In-Store')}</strong></div>
        <div><span style="color: var(--text-muted);">Payment Status:</span> <strong>${escapeHtml(order.payment_status || 'Paid')}</strong></div>
        <div><span style="color: var(--text-muted);">Payment Method:</span> <strong>${escapeHtml(order.payment_method || 'Credit Card')}</strong></div>
        ${order.lightspeed_id ? `<div><span style="color: var(--text-muted);">Lightspeed ID:</span> <code>${escapeHtml(order.lightspeed_id)}</code></div>` : ''}
      </div>
    </div>

    <div>
      <h4 style="font-size: 13px; text-transform: uppercase; color: var(--text-secondary); margin-bottom: 10px;">Items Ordered</h4>
      <div style="background: var(--bg-primary); border-radius: var(--radius-md); padding: 12px;">
        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
          <thead>
            <tr style="text-align: left; color: var(--text-muted); border-bottom: 1px solid var(--border-color);">
              <th style="padding-bottom: 8px;">Item</th>
              <th style="padding-bottom: 8px; text-align: center;">Qty</th>
              <th style="padding-bottom: 8px; text-align: right;">Price</th>
              <th style="padding-bottom: 8px; text-align: right;">Total</th>
            </tr>
          </thead>
          <tbody>
            ${(order.items || []).map(it => `
              <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
                <td style="padding: 10px 0;">
                  <div style="font-weight: 600;">${escapeHtml(it.name)}</div>
                  ${it.sku ? `<div style="font-size: 11px; color: var(--text-muted);">SKU: ${escapeHtml(it.sku)}</div>` : ''}
                  ${it.modifiers ? `<div style="font-size: 11px; color: var(--accent-amber);">${escapeHtml(it.modifiers)}</div>` : ''}
                </td>
                <td style="padding: 10px 0; text-align: center; font-weight: 700;">${it.quantity}</td>
                <td style="padding: 10px 0; text-align: right; color: var(--text-secondary);">${formatCurrency(it.unit_price)}</td>
                <td style="padding: 10px 0; text-align: right; font-weight: 600;">${formatCurrency(it.total_price || (it.quantity * it.unit_price))}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>

        <div style="margin-top: 14px; border-top: 1px solid var(--border-color); padding-top: 10px; display: flex; flex-direction: column; gap: 4px; font-size: 13px;">
          <div style="display: flex; justify-content: space-between; color: var(--text-secondary);">
            <span>Subtotal</span>
            <span>${formatCurrency(order.subtotal)}</span>
          </div>
          <div style="display: flex; justify-content: space-between; color: var(--text-secondary);">
            <span>Tax</span>
            <span>${formatCurrency(order.tax)}</span>
          </div>
          <div style="display: flex; justify-content: space-between; font-size: 16px; font-weight: 700; color: var(--text-primary); margin-top: 4px; padding-top: 6px; border-top: 1px dashed var(--border-color);">
            <span>Total</span>
            <span>${formatCurrency(order.total, order.currency)}</span>
          </div>
        </div>
      </div>
    </div>

    <div style="background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.3); color: #93c5fd; padding: 10px 14px; border-radius: var(--radius-md); font-size: 12px; display: flex; flex-direction: column; gap: 4px;">
      <div style="display: flex; align-items: center; justify-content: space-between;">
        <strong>Sync Status: ${order.synced_to_lightspeed ? '☁️ Synced with Lightspeed API' : '🛡️ Local Display Only'}</strong>
        <span class="sync-status-pill ${order.synced_to_lightspeed ? 'synced' : 'local'}">${order.synced_to_lightspeed ? 'API Synced' : 'Local Only'}</span>
      </div>
      <div style="color: var(--text-secondary); font-size: 11px;">
        Use <strong>🛡️ (Local)</strong> buttons to mark order without affecting your Lightspeed POS records. Use <strong>☁️ (API)</strong> buttons to update status in Lightspeed.
      </div>
    </div>

    <div>
      <h4 style="font-size: 13px; text-transform: uppercase; color: var(--text-secondary); margin-bottom: 8px;">Internal Staff / Kitchen Notes (Local)</h4>
      <div style="display: flex; gap: 8px; align-items: center;">
        <input type="text" id="modal-internal-notes" value="${escapeHtml(order.notes || '')}" placeholder="Add local notes (e.g. Table 4, boxed to-go, extra napkins)..." style="flex: 1; background: var(--bg-primary); border: 1px solid var(--border-color); color: var(--text-primary); padding: 8px 12px; border-radius: var(--radius-md); font-size: 13px; outline: none;">
        <button class="btn btn-secondary" onclick="saveOrderNotes('${order.id}')" style="white-space: nowrap;">💾 Save Note</button>
      </div>
    </div>
  `;

  // Modal Footer Actions
  const footer = document.getElementById('modal-order-footer');
  footer.innerHTML = `
    <button class="btn btn-secondary" onclick="window.print()">🖨️ Print Ticket</button>
    <button class="btn btn-secondary" onclick="updateOrderStatus('${order.id}', 'in_progress', false); closeOrderModal();">⏳ Prep</button>
    <button class="btn btn-local-ready" onclick="updateOrderStatus('${order.id}', 'ready', false); closeOrderModal();" title="Mark ready locally without touching Lightspeed">🛡️ Ready (Local)</button>
    <button class="btn btn-api-ready" onclick="updateOrderStatus('${order.id}', 'ready', true); closeOrderModal();" title="Mark ready & sync to Lightspeed API">☁️ Ready (API)</button>
    <button class="btn btn-local-complete" onclick="updateOrderStatus('${order.id}', 'completed', false); closeOrderModal();" title="Complete locally without touching Lightspeed">🛡️ Complete (Local)</button>
    <button class="btn btn-api-complete" onclick="updateOrderStatus('${order.id}', 'completed', true); closeOrderModal();" title="Complete & sync to Lightspeed API">☁️ Complete (API)</button>
  `;
}

// Save Internal Staff Notes locally
async function saveOrderNotes(orderId) {
  const notesInput = document.getElementById('modal-internal-notes');
  if (!notesInput) return;
  const notes = notesInput.value.trim();
  try {
    const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes })
    });
    if (res.ok) {
      showToast('Internal note saved locally', 'success');
      const data = await res.json();
      const idx = orders.findIndex(o => o.id === orderId);
      if (idx !== -1) {
        orders[idx] = data.order;
        renderOrders();
      }
    }
  } catch (err) {
    showToast('Failed to save note', 'error');
  }
}

// Simulate Order
async function simulateOrder() {
  getAudioContext(); // Ensure user gesture activates audio context
  try {
    const res = await fetch('/api/simulate-order', { method: 'POST' });
    if (res.ok) {
      showToast('Simulated Lightspeed order triggered!', 'info');
    }
  } catch (err) {
    console.error("Simulation failed:", err);
  }
}

// Clear Orders (Local only - never calls or modifies Lightspeed POS)
async function clearAllOrders() {
  if (!confirm("Are you sure you want to clear all orders from this screen?\n\n🛡️ LOCAL ONLY: This only clears the local dashboard/demo orders. It will NEVER delete, cancel, or alter sales in Lightspeed POS.")) return;
  try {
    await fetch('/api/orders/clear', { method: 'POST' });
  } catch (err) {
    console.error("Failed to clear orders:", err);
  }
}

// Toggle Sound
function toggleSound() {
  isSoundEnabled = !isSoundEnabled;
  localStorage.setItem('ls_sound_enabled', isSoundEnabled ? 'true' : 'false');
  updateSoundButtonUI();
  if (isSoundEnabled) {
    playOrderChime();
    showToast("Sound notifications enabled", "info");
  } else {
    showToast("Sound notifications muted", "info");
  }
}

function updateSoundButtonUI() {
  const btn = document.getElementById('sound-toggle-btn');
  if (btn) {
    btn.innerHTML = isSoundEnabled ? '🔊 Sound On' : '🔇 Muted';
    btn.style.color = isSoundEnabled ? 'var(--text-primary)' : 'var(--text-muted)';
  }
}

// Settings Modal Management
function openSettingsModal() {
  loadSettings();
  document.getElementById('settings-modal').classList.add('active');
}

function closeSettingsModal() {
  document.getElementById('settings-modal').classList.remove('active');
}

async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    const settings = await res.json();
    
    document.getElementById('setting-platform').value = settings.lightspeed_platform || 'r_series';
    document.getElementById('setting-account-id').value = settings.account_id || '';
    document.getElementById('setting-domain-prefix').value = settings.domain_prefix || '';
    document.getElementById('setting-api-token').value = settings.api_token || '';
    document.getElementById('setting-polling').checked = settings.polling_enabled === 'true';
    document.getElementById('setting-interval').value = settings.polling_interval || '15';

    // Set Webhook URL based on window.location
    const webhookUrl = `${window.location.origin}/api/webhooks/lightspeed`;
    document.getElementById('webhook-display-url').textContent = webhookUrl;

    updatePlatformFields();
  } catch (err) {
    console.error("Failed to load settings:", err);
  }
}

function updatePlatformFields() {
  const platform = document.getElementById('setting-platform').value;
  const accGroup = document.getElementById('group-account-id');
  const domGroup = document.getElementById('group-domain-prefix');

  if (platform === 'r_series') {
    accGroup.style.display = 'flex';
    domGroup.style.display = 'none';
  } else if (platform === 'x_series') {
    accGroup.style.display = 'none';
    domGroup.style.display = 'flex';
  } else {
    accGroup.style.display = 'none';
    domGroup.style.display = 'none';
  }
}

async function saveSettings(e) {
  if (e) e.preventDefault();
  const saveBtn = document.getElementById('save-settings-btn');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving...';

  const settingsData = {
    lightspeed_platform: document.getElementById('setting-platform').value,
    account_id: document.getElementById('setting-account-id').value.trim(),
    domain_prefix: document.getElementById('setting-domain-prefix').value.trim(),
    api_token: document.getElementById('setting-api-token').value.trim(),
    polling_enabled: document.getElementById('setting-polling').checked ? 'true' : 'false',
    polling_interval: document.getElementById('setting-interval').value
  };

  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settingsData)
    });
    if (res.ok) {
      showToast('Settings saved successfully!', 'success');
      closeSettingsModal();
    }
  } catch (err) {
    showToast('Failed to save settings', 'error');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Configuration';
  }
}

async function testApiConnection() {
  const testBtn = document.getElementById('test-conn-btn');
  const resultBox = document.getElementById('test-result-box');
  
  testBtn.disabled = true;
  testBtn.textContent = 'Testing...';
  resultBox.style.display = 'none';

  const testData = {
    lightspeed_platform: document.getElementById('setting-platform').value,
    account_id: document.getElementById('setting-account-id').value.trim(),
    domain_prefix: document.getElementById('setting-domain-prefix').value.trim(),
    api_token: document.getElementById('setting-api-token').value.trim()
  };

  try {
    const res = await fetch('/api/lightspeed/test-connection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testData)
    });
    const data = await res.json();
    resultBox.style.display = 'block';
    if (data.success) {
      resultBox.style.color = '#10b981';
      resultBox.textContent = `✅ ${data.message}`;
    } else {
      resultBox.style.color = '#ef4444';
      resultBox.textContent = `❌ ${data.message}`;
    }
  } catch (err) {
    resultBox.style.display = 'block';
    resultBox.style.color = '#ef4444';
    resultBox.textContent = `❌ Connection test failed: ${err.message}`;
  } finally {
    testBtn.disabled = false;
    testBtn.textContent = 'Test Connection';
  }
}

function copyWebhookUrl() {
  const url = document.getElementById('webhook-display-url').textContent;
  navigator.clipboard.writeText(url).then(() => {
    showToast('Webhook URL copied to clipboard!', 'success');
  });
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Switch main view mode ('orders' vs 'items')
function switchMainView(mode) {
  currentMainView = mode;
  const btnOrders = document.getElementById('btn-view-orders');
  const btnItems = document.getElementById('btn-view-items');
  const ordersFilterBar = document.getElementById('orders-status-filters');
  const allDayBar = document.getElementById('all-day-bar-section');
  const ordersContainer = document.getElementById('orders-container');
  const itemsContainer = document.getElementById('items-station-container');

  if (mode === 'items') {
    if (btnOrders) btnOrders.classList.remove('active');
    if (btnItems) btnItems.classList.add('active');
    if (ordersFilterBar) ordersFilterBar.style.display = 'none';
    if (allDayBar) allDayBar.style.display = 'none';
    if (ordersContainer) ordersContainer.style.display = 'none';
    if (itemsContainer) itemsContainer.style.display = 'grid';
    renderItemsStation();
  } else {
    if (btnItems) btnItems.classList.remove('active');
    if (btnOrders) btnOrders.classList.add('active');
    if (ordersFilterBar) ordersFilterBar.style.display = 'flex';
    if (allDayBar) allDayBar.style.display = 'block';
    if (ordersContainer) ordersContainer.style.display = 'grid';
    if (itemsContainer) itemsContainer.style.display = 'none';
    renderOrders();
  }
}

// Fetch detailed grouped queue items for the Items Queue station
async function fetchDetailedQueueItems() {
  try {
    const res = await fetch('/api/detailed-queue-items');
    if (res.ok) {
      const data = await res.json();
      detailedQueueItems = data.items || [];
      updateStationBadge();
      if (currentMainView === 'items') {
        renderItemsStation();
      }
    }
  } catch (err) {
    console.error("Failed to fetch detailed queue items:", err);
  }
}

// Update the station badge counter
function updateStationBadge() {
  const badge = document.getElementById('station-queue-badge');
  if (!badge) return;
  const pendingTotal = (detailedQueueItems || []).reduce((acc, it) => acc + (it.pending_quantity || 0), 0);
  badge.textContent = pendingTotal;
}

// Render dedicated Items Queue Station view
function renderItemsStation() {
  const container = document.getElementById('items-station-container');
  if (!container) return;

  let items = detailedQueueItems || [];
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    items = items.filter(it =>
      (it.name && it.name.toLowerCase().includes(q)) ||
      (it.sku && it.sku.toLowerCase().includes(q)) ||
      (it.order_lines && it.order_lines.some(l =>
        (l.order_number && String(l.order_number).toLowerCase().includes(q)) ||
        (l.customer_name && l.customer_name.toLowerCase().includes(q)) ||
        (l.modifiers && l.modifiers.toLowerCase().includes(q))
      ))
    );
  }

  if (items.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / -1;">
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <h3>No Items In Queue</h3>
        <p>All items in active orders have been made! New items will appear here automatically when orders arrive.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = items.map(item => {
    const pendingCount = item.pending_quantity || 0;
    const madeCount = item.made_quantity || 0;
    const totalCount = item.total_quantity || (pendingCount + madeCount);

    const linesHtml = (item.order_lines || []).map(line => {
      const isMade = line.item_status === 'made';
      const syncBadge = isMade
        ? (line.item_synced
            ? '<span class="sync-status-pill synced" style="font-size: 10px; padding: 1px 6px;">☁️ Synced</span>'
            : '<span class="sync-status-pill local" style="font-size: 10px; padding: 1px 6px;">🛡️ Local</span>')
        : '';

      const actionButtons = isMade ? `
        <button class="action-btn-mini btn-secondary" onclick="updateItemStatus(${line.item_id}, 'pending', false)">
          ↩ Reopen
        </button>
      ` : `
        <button class="action-btn-mini btn-local-ready" onclick="updateItemStatus(${line.item_id}, 'made', false)" title="Mark item made on dashboard only">
          🛡️ Made (Local)
        </button>
        <button class="action-btn-mini btn-api-ready" onclick="updateItemStatus(${line.item_id}, 'made', true)" title="Mark item made & sync to Lightspeed API">
          ☁️ Made (API)
        </button>
      `;

      return `
        <li class="station-line-entry ${isMade ? 'is-made' : ''}">
          <div class="station-line-top">
            <div>
              <span class="station-order-tag">${escapeHtml(line.order_number || ('#' + line.order_id))}</span>
              <span class="station-cust-name">${escapeHtml(line.customer_name || 'Walk-in')}</span>
            </div>
            <div style="display: flex; align-items: center; gap: 6px;">
              ${syncBadge}
              <span class="station-line-qty">×${line.quantity}</span>
            </div>
          </div>
          ${line.modifiers ? `<div class="station-modifiers">📝 ${escapeHtml(line.modifiers)}</div>` : ''}
          <div class="station-line-actions">
            ${actionButtons}
          </div>
        </li>
      `;
    }).join('');

    const batchFooter = pendingCount > 0 ? `
      <div class="station-item-footer">
        <button class="action-btn-mini btn-local-ready" style="flex: 1; justify-content: center;" onclick="updateBatchItemStatus('${escapeHtml(item.name).replace(/'/g, "\\'")}', 'made', false)" title="Mark all ${pendingCount} made locally">
          🛡️ All Made (Local)
        </button>
        <button class="action-btn-mini btn-api-ready" style="flex: 1; justify-content: center;" onclick="updateBatchItemStatus('${escapeHtml(item.name).replace(/'/g, "\\'")}', 'made', true)" title="Mark all ${pendingCount} made and sync API">
          ☁️ All Made (API)
        </button>
      </div>
    ` : `
      <div class="station-item-footer" style="justify-content: center; color: var(--accent-emerald); font-size: 12px; font-weight: 700; padding: 10px;">
        ✅ All ${totalCount} completed
      </div>
    `;

    return `
      <div class="station-item-card">
        <div class="station-item-header">
          <div>
            <div class="station-item-title">${escapeHtml(item.name)}</div>
            ${item.sku ? `<div class="station-item-sku">SKU: ${escapeHtml(item.sku)}</div>` : ''}
          </div>
          <div class="station-item-counts">
            ${pendingCount > 0 ? `<span class="station-pending-badge">${pendingCount} TO MAKE</span>` : ''}
            ${madeCount > 0 ? `<span class="station-made-badge">${madeCount} MADE</span>` : ''}
          </div>
        </div>

        <ul class="station-lines-list">
          ${linesHtml}
        </ul>

        ${batchFooter}
      </div>
    `;
  }).join('');
}

// Update individual item status via API (Local or Lightspeed synced)
async function updateItemStatus(itemId, newStatus, syncToLightspeed = false) {
  try {
    const res = await fetch(`/api/items/${encodeURIComponent(itemId)}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus, sync_lightspeed: syncToLightspeed })
    });
    if (res.ok) {
      const data = await res.json();
      if (data.detailed_items) {
        detailedQueueItems = data.detailed_items;
        updateStationBadge();
        if (currentMainView === 'items') {
          renderItemsStation();
        }
      }
      if (data.order) {
        const idx = orders.findIndex(o => o.id === data.order.id);
        if (idx !== -1) {
          orders[idx] = data.order;
        } else {
          orders.unshift(data.order);
        }
        renderOrders();
        fetchStats();
        computeQueueSummary();
      }
      if (syncToLightspeed) {
        const msg = data.api_result?.message || 'Item updated & synced with Lightspeed API';
        showToast(`☁️ ${msg}`, 'success');
      } else {
        showToast(`🛡️ Item marked as ${newStatus} (Local only)`, 'info');
      }
    }
  } catch (err) {
    console.error("Failed to update item status:", err);
    showToast("Failed to update item status", "error");
  }
}

// Batch update all units of an item by name
async function updateBatchItemStatus(itemName, newStatus, syncToLightspeed = false) {
  try {
    const res = await fetch('/api/items/batch-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: itemName, status: newStatus, sync_lightspeed: syncToLightspeed })
    });
    if (res.ok) {
      const data = await res.json();
      if (data.detailed_items) {
        detailedQueueItems = data.detailed_items;
        updateStationBadge();
        if (currentMainView === 'items') {
          renderItemsStation();
        }
      }
      fetchOrders();
      fetchStats();
      if (syncToLightspeed) {
        showToast(`☁️ All "${itemName}" marked as ${newStatus} & synced with Lightspeed API`, 'success');
      } else {
        showToast(`🛡️ All "${itemName}" marked as ${newStatus} (Local only)`, 'info');
      }
    }
  } catch (err) {
    console.error("Failed to batch update items:", err);
    showToast("Failed to batch update items", "error");
  }
}

// Setup Event Listeners and Timers
document.addEventListener('DOMContentLoaded', () => {
  fetchOrders();
  fetchDetailedQueueItems();
  fetchStats();
  initSSE();
  updateSoundButtonUI();

  // Filter tab buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.status;
      renderOrders();
    });
  });

  // Search input
  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      searchQuery = e.target.value;
      if (currentMainView === 'items') {
        renderItemsStation();
      } else {
        renderOrders();
      }
    });
  }

  // Periodic relative time update (every 25 seconds)
  setInterval(() => {
    document.querySelectorAll('.order-time').forEach(el => {
      const ts = el.dataset.timestamp;
      if (ts) {
        el.textContent = formatTimeAgo(ts);
      }
    });
  }, 25000);

  // Close modals on overlay click or Escape key
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeOrderModal();
      closeSettingsModal();
    }
  });

  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        closeOrderModal();
        closeSettingsModal();
      }
    });
  });

  // Mobile / iPad auto-unlock for Web Audio on first user interaction
  const unlockEvents = ['touchstart', 'touchend', 'click', 'keydown'];
  unlockEvents.forEach(evt => {
    document.addEventListener(evt, () => {
      unlockAudioForMobile();
    }, { once: true, passive: true });
  });

  setTimeout(checkMobileAudio, 800);
});
