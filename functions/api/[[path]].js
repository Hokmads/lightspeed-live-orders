/**
 * Cloudflare Pages Function — Full Backend for Lightspeed Live Orders
 * Routes all /api/* requests on Cloudflare Pages.
 *
 * Supports:
 * 1. Cloudflare D1 Serverless SQLite Database (bound as `DB`) with automatic table creation.
 * 2. Automatic in-memory fallback store if D1 is not bound yet (zero-config instant deploy).
 * 3. All Orders, Items Queue (partial & batch), Stats, Settings, Webhooks, and Lightspeed API sync endpoints.
 */

// In-memory fallback store (used if D1 binding `env.DB` is not yet configured)
const memoryStore = {
  orders: [],
  order_items: [],
  nextItemId: 1,
  users: [],
  nextUserId: 1,
  sessions: [],
  settings: {
    lightspeed_platform: 'r_series',
    api_token: '',
    account_id: '',
    domain_prefix: '',
    webhook_secret: '',
    polling_enabled: 'false',
    polling_interval: '15',
    sound_enabled: 'true',
    auto_print: 'false',
    last_sync_timestamp: ''
  }
};

function randomHex(byteCount = 16) {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(str) {
  const buf = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hashPassword(password, salt = null) {
  const s = salt || randomHex(16);
  const digest = await sha256Hex(`${s}:${password}`);
  return `${s}$${digest}`;
}

async function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes('$')) return false;
  const [salt, expected] = storedHash.split('$');
  const actual = await sha256Hex(`${salt}:${password}`);
  return actual === expected;
}

let d1Initialized = false;

async function ensureD1Schema(db) {
  if (!db || d1Initialized) return;
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        lightspeed_id TEXT,
        order_number TEXT,
        source TEXT DEFAULT 'lightspeed',
        status TEXT DEFAULT 'new',
        customer_name TEXT,
        customer_email TEXT,
        customer_phone TEXT,
        order_type TEXT DEFAULT 'In-Store',
        subtotal REAL DEFAULT 0.0,
        tax REAL DEFAULT 0.0,
        total REAL DEFAULT 0.0,
        currency TEXT DEFAULT 'USD',
        payment_status TEXT DEFAULT 'Paid',
        payment_method TEXT DEFAULT 'Credit Card',
        notes TEXT,
        synced_to_lightspeed INTEGER DEFAULT 0,
        created_at TEXT,
        updated_at TEXT,
        raw_payload TEXT
      );
    `).run();

    await db.prepare(`
      CREATE TABLE IF NOT EXISTS order_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id TEXT NOT NULL,
        name TEXT NOT NULL,
        sku TEXT,
        quantity INTEGER DEFAULT 1,
        quantity_made INTEGER DEFAULT 0,
        unit_price REAL DEFAULT 0.0,
        total_price REAL DEFAULT 0.0,
        modifiers TEXT,
        status TEXT DEFAULT 'pending',
        synced_to_lightspeed INTEGER DEFAULT 0
      );
    `).run();

    await db.prepare(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `).run();

    const defaults = {
      lightspeed_platform: 'r_series',
      api_token: '',
      account_id: '',
      domain_prefix: '',
      webhook_secret: '',
      polling_enabled: 'false',
      polling_interval: '15',
      sound_enabled: 'true',
      auto_print: 'false',
      last_sync_timestamp: ''
    };

    for (const [k, v] of Object.entries(defaults)) {
      await db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?);`).bind(k, v).run();
    }

    await db.prepare(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'staff',
        created_at TEXT
      );
    `).run();

    await db.prepare(`
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        username TEXT NOT NULL,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at TEXT
      );
    `).run();

    const adminRow = await db.prepare(`SELECT COUNT(*) as cnt FROM users WHERE role = 'admin';`).first();
    if (!adminRow || !adminRow.cnt) {
      const defaultHash = await hashPassword('admin123');
      const nowIso = new Date().toISOString();
      await db.prepare(`
        INSERT OR IGNORE INTO users (username, display_name, password_hash, role, created_at)
        VALUES ('admin', 'Administrator', ?, 'admin', ?);
      `).bind(defaultHash, nowIso).run();
    }

    d1Initialized = true;
  } catch (err) {
    console.error('D1 schema init error:', err);
  }
}

// ============================================================================
// Database Helper Functions (Supports D1 and Memory Fallback)
// ============================================================================

async function getSettings(db) {
  if (!db) {
    return { ...memoryStore.settings };
  }
  await ensureD1Schema(db);
  const { results } = await db.prepare(`SELECT key, value FROM settings;`).all();
  const out = {};
  for (const r of results || []) {
    out[r.key] = r.value;
  }
  return out;
}

async function updateSettings(db, newSettings) {
  if (!db) {
    for (const [k, v] of Object.entries(newSettings)) {
      memoryStore.settings[k] = String(v);
    }
    return;
  }
  await ensureD1Schema(db);
  for (const [k, v] of Object.entries(newSettings)) {
    await db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    `).bind(k, String(v)).run();
  }
}

async function getOrderById(db, orderId) {
  if (!db) {
    const o = memoryStore.orders.find(x => x.id === orderId);
    if (!o) return null;
    const items = memoryStore.order_items.filter(i => i.order_id === orderId);
    return { ...o, items: items.map(i => ({ ...i })) };
  }
  await ensureD1Schema(db);
  const order = await db.prepare(`SELECT * FROM orders WHERE id = ?;`).bind(orderId).first();
  if (!order) return null;
  const { results: items } = await db.prepare(`SELECT * FROM order_items WHERE order_id = ?;`).bind(orderId).all();
  return { ...order, items: items || [] };
}

async function listOrders(db, { status = null, search = null, limit = 100 } = {}) {
  if (!db) {
    let list = [...memoryStore.orders];
    if (status && status.toLowerCase() !== 'all') {
      list = list.filter(o => (o.status || '').toLowerCase() === status.toLowerCase());
    }
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(o =>
        (o.id || '').toLowerCase().includes(q) ||
        (o.order_number || '').toLowerCase().includes(q) ||
        (o.customer_name || '').toLowerCase().includes(q) ||
        (o.customer_email || '').toLowerCase().includes(q)
      );
    }
    list.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    list = list.slice(0, limit);
    return list.map(o => ({
      ...o,
      items: memoryStore.order_items.filter(i => i.order_id === o.id).map(i => ({ ...i }))
    }));
  }

  await ensureD1Schema(db);
  let query = `SELECT * FROM orders WHERE 1=1`;
  const params = [];

  if (status && status.toLowerCase() !== 'all') {
    query += ` AND status = ?`;
    params.push(status.toLowerCase());
  }
  if (search) {
    query += ` AND (id LIKE ? OR order_number LIKE ? OR customer_name LIKE ? OR customer_email LIKE ?)`;
    const term = `%${search}%`;
    params.push(term, term, term, term);
  }
  query += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);

  const { results: orderRows } = await db.prepare(query).bind(...params).all();
  const orders = [];
  for (const row of orderRows || []) {
    const { results: items } = await db.prepare(`SELECT * FROM order_items WHERE order_id = ?;`).bind(row.id).all();
    orders.push({ ...row, items: items || [] });
  }
  return orders;
}

async function saveOrder(db, orderData) {
  const nowIso = new Date().toISOString();
  const orderId = String(orderData.id || '');
  const createdAt = orderData.created_at || nowIso;
  const rawPayloadStr = JSON.stringify(orderData.raw_payload || {});

  if (!db) {
    const existingIdx = memoryStore.orders.findIndex(o => o.id === orderId);
    const isNew = existingIdx === -1;
    const prevOrder = isNew ? null : memoryStore.orders[existingIdx];

    const record = {
      id: orderId,
      lightspeed_id: orderData.lightspeed_id || '',
      order_number: orderData.order_number || orderId,
      source: orderData.source || 'lightspeed',
      status: isNew ? (orderData.status || 'new') : prevOrder.status,
      customer_name: orderData.customer_name || 'Walk-in Customer',
      customer_email: orderData.customer_email || '',
      customer_phone: orderData.customer_phone || '',
      order_type: orderData.order_type || 'In-Store',
      subtotal: Number(orderData.subtotal || 0),
      tax: Number(orderData.tax || 0),
      total: Number(orderData.total || 0),
      currency: orderData.currency || 'USD',
      payment_status: orderData.payment_status || 'Paid',
      payment_method: orderData.payment_method || 'Credit Card',
      notes: isNew ? (orderData.notes || '') : prevOrder.notes,
      synced_to_lightspeed: isNew ? 0 : (prevOrder.synced_to_lightspeed || 0),
      created_at: isNew ? createdAt : prevOrder.created_at,
      updated_at: nowIso,
      raw_payload: rawPayloadStr
    };

    if (isNew) {
      memoryStore.orders.unshift(record);
    } else {
      memoryStore.orders[existingIdx] = record;
    }

    const items = orderData.items || [];
    if (items.length > 0) {
      const prevItems = memoryStore.order_items.filter(i => i.order_id === orderId);
      const prevMap = {};
      for (const pi of prevItems) {
        prevMap[pi.name] = pi;
      }
      memoryStore.order_items = memoryStore.order_items.filter(i => i.order_id !== orderId);

      for (const item of items) {
        const name = item.name || 'Item';
        const prev = prevMap[name];
        memoryStore.order_items.push({
          id: memoryStore.nextItemId++,
          order_id: orderId,
          name,
          sku: item.sku || '',
          quantity: Number(item.quantity || 1),
          quantity_made: Number(item.quantity_made ?? (prev ? prev.quantity_made : 0)),
          unit_price: Number(item.unit_price || 0),
          total_price: Number(item.total_price || 0),
          modifiers: item.modifiers || '',
          status: item.status || (prev ? prev.status : 'pending'),
          synced_to_lightspeed: Number(item.synced_to_lightspeed ?? (prev ? prev.synced_to_lightspeed : 0))
        });
      }
    }

    const saved = await getOrderById(db, orderId);
    return { savedOrder: saved, isNew };
  }

  await ensureD1Schema(db);
  const existing = await db.prepare(`SELECT id, status FROM orders WHERE id = ?;`).bind(orderId).first();
  const isNew = !existing;

  if (isNew) {
    await db.prepare(`
      INSERT INTO orders (
        id, lightspeed_id, order_number, source, status,
        customer_name, customer_email, customer_phone, order_type,
        subtotal, tax, total, currency, payment_status, payment_method,
        notes, created_at, updated_at, raw_payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `).bind(
      orderId,
      orderData.lightspeed_id || '',
      orderData.order_number || orderId,
      orderData.source || 'lightspeed',
      orderData.status || 'new',
      orderData.customer_name || 'Walk-in Customer',
      orderData.customer_email || '',
      orderData.customer_phone || '',
      orderData.order_type || 'In-Store',
      Number(orderData.subtotal || 0),
      Number(orderData.tax || 0),
      Number(orderData.total || 0),
      orderData.currency || 'USD',
      orderData.payment_status || 'Paid',
      orderData.payment_method || 'Credit Card',
      orderData.notes || '',
      createdAt,
      nowIso,
      rawPayloadStr
    ).run();
  } else {
    await db.prepare(`
      UPDATE orders SET
        customer_name = ?,
        customer_email = ?,
        customer_phone = ?,
        subtotal = ?,
        tax = ?,
        total = ?,
        payment_status = ?,
        payment_method = ?,
        updated_at = ?,
        raw_payload = ?
      WHERE id = ?;
    `).bind(
      orderData.customer_name || 'Walk-in Customer',
      orderData.customer_email || '',
      orderData.customer_phone || '',
      Number(orderData.subtotal || 0),
      Number(orderData.tax || 0),
      Number(orderData.total || 0),
      orderData.payment_status || 'Paid',
      orderData.payment_method || 'Credit Card',
      nowIso,
      rawPayloadStr,
      orderId
    ).run();
  }

  const items = orderData.items || [];
  if (items.length > 0) {
    const { results: existingItems } = await db.prepare(
      `SELECT name, status, synced_to_lightspeed, quantity_made FROM order_items WHERE order_id = ?;`
    ).bind(orderId).all();

    const prevMap = {};
    for (const r of existingItems || []) {
      prevMap[r.name] = r;
    }

    await db.prepare(`DELETE FROM order_items WHERE order_id = ?;`).bind(orderId).run();

    for (const item of items) {
      const name = item.name || 'Item';
      const prev = prevMap[name];
      const itemStatus = item.status || (prev ? prev.status : 'pending');
      const synced = Number(item.synced_to_lightspeed ?? (prev ? prev.synced_to_lightspeed : 0));
      const qtyMade = Number(item.quantity_made ?? (prev ? prev.quantity_made : 0));

      await db.prepare(`
        INSERT INTO order_items (
          order_id, name, sku, quantity, quantity_made, unit_price, total_price, modifiers, status, synced_to_lightspeed
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `).bind(
        orderId,
        name,
        item.sku || '',
        Number(item.quantity || 1),
        qtyMade,
        Number(item.unit_price || 0),
        Number(item.total_price || 0),
        item.modifiers || '',
        itemStatus,
        synced
      ).run();
    }
  }

  const savedOrder = await getOrderById(db, orderId);
  return { savedOrder, isNew };
}

async function updateOrderStatus(db, orderId, newStatus, syncedToLightspeed = null) {
  const nowIso = new Date().toISOString();
  if (!db) {
    const order = memoryStore.orders.find(o => o.id === orderId);
    if (!order) return null;
    order.status = newStatus;
    order.updated_at = nowIso;
    if (syncedToLightspeed !== null) {
      order.synced_to_lightspeed = syncedToLightspeed ? 1 : 0;
    }
    for (const item of memoryStore.order_items.filter(i => i.order_id === orderId)) {
      if (newStatus === 'ready' || newStatus === 'completed') {
        if (item.status !== 'made') {
          item.status = 'made';
          item.quantity_made = item.quantity;
          if (syncedToLightspeed !== null) item.synced_to_lightspeed = syncedToLightspeed ? 1 : 0;
        }
      } else if (newStatus === 'new') {
        item.status = 'pending';
        item.quantity_made = 0;
      }
    }
    return getOrderById(db, orderId);
  }

  await ensureD1Schema(db);
  if (syncedToLightspeed !== null) {
    await db.prepare(`UPDATE orders SET status = ?, synced_to_lightspeed = ?, updated_at = ? WHERE id = ?;`)
      .bind(newStatus, syncedToLightspeed ? 1 : 0, nowIso, orderId).run();
  } else {
    await db.prepare(`UPDATE orders SET status = ?, updated_at = ? WHERE id = ?;`)
      .bind(newStatus, nowIso, orderId).run();
  }

  if (newStatus === 'ready' || newStatus === 'completed') {
    if (syncedToLightspeed !== null) {
      await db.prepare(`UPDATE order_items SET status = 'made', quantity_made = quantity, synced_to_lightspeed = ? WHERE order_id = ? AND status != 'made';`)
        .bind(syncedToLightspeed ? 1 : 0, orderId).run();
    } else {
      await db.prepare(`UPDATE order_items SET status = 'made', quantity_made = quantity WHERE order_id = ? AND status != 'made';`)
        .bind(orderId).run();
    }
  } else if (newStatus === 'new') {
    await db.prepare(`UPDATE order_items SET status = 'pending', quantity_made = 0 WHERE order_id = ?;`)
      .bind(orderId).run();
  }

  return getOrderById(db, orderId);
}

async function updateOrderNotes(db, orderId, notes) {
  const nowIso = new Date().toISOString();
  if (!db) {
    const order = memoryStore.orders.find(o => o.id === orderId);
    if (!order) return null;
    order.notes = notes;
    order.updated_at = nowIso;
    return getOrderById(db, orderId);
  }
  await ensureD1Schema(db);
  await db.prepare(`UPDATE orders SET notes = ?, updated_at = ? WHERE id = ?;`).bind(notes, nowIso, orderId).run();
  return getOrderById(db, orderId);
}

async function updateItemStatus(db, itemId, newStatus = null, syncedToLightspeed = null, quantityDelta = null, count = null) {
  const nowIso = new Date().toISOString();

  if (!db) {
    const item = memoryStore.order_items.find(i => i.id === Number(itemId));
    if (!item) return null;
    const qty = Number(item.quantity || 1);
    const currentMade = Number(item.quantity_made || 0);
    let newMade = currentMade;

    if (count !== null && count !== undefined) {
      newMade = Math.max(0, Math.min(qty, Number(count)));
    } else if (quantityDelta !== null && quantityDelta !== undefined) {
      newMade = Math.max(0, Math.min(qty, currentMade + Number(quantityDelta)));
    } else if (newStatus === 'made') {
      newMade = qty;
    } else if (newStatus === 'pending') {
      newMade = 0;
    }

    const computedStatus = newMade >= qty ? 'made' : (newMade > 0 ? 'partially_made' : 'pending');
    item.status = (newStatus && count === null && quantityDelta === null && (newStatus === 'made' || newStatus === 'pending')) ? newStatus : computedStatus;
    item.quantity_made = newMade;
    if (syncedToLightspeed !== null) {
      item.synced_to_lightspeed = syncedToLightspeed ? 1 : 0;
    }

    const orderItems = memoryStore.order_items.filter(i => i.order_id === item.order_id);
    const pendingCount = orderItems.filter(i => i.status !== 'made').length;
    const order = memoryStore.orders.find(o => o.id === item.order_id);
    if (order) {
      if (pendingCount === 0 && (order.status === 'new' || order.status === 'in_progress')) {
        order.status = 'ready';
        order.updated_at = nowIso;
      } else if (pendingCount > 0 && order.status === 'ready') {
        order.status = 'in_progress';
        order.updated_at = nowIso;
      }
    }
    return getOrderById(db, item.order_id);
  }

  await ensureD1Schema(db);
  const row = await db.prepare(
    `SELECT id, order_id, quantity, COALESCE(quantity_made, 0) as quantity_made, status FROM order_items WHERE id = ?;`
  ).bind(Number(itemId)).first();

  if (!row) return null;
  const orderId = row.order_id;
  const qty = Number(row.quantity || 1);
  const currentMade = Number(row.quantity_made || 0);
  let newMade = currentMade;

  if (count !== null && count !== undefined) {
    newMade = Math.max(0, Math.min(qty, Number(count)));
  } else if (quantityDelta !== null && quantityDelta !== undefined) {
    newMade = Math.max(0, Math.min(qty, currentMade + Number(quantityDelta)));
  } else if (newStatus === 'made') {
    newMade = qty;
  } else if (newStatus === 'pending') {
    newMade = 0;
  }

  const computedStatus = newMade >= qty ? 'made' : (newMade > 0 ? 'partially_made' : 'pending');
  const finalStatus = (newStatus && count === null && quantityDelta === null && (newStatus === 'made' || newStatus === 'pending')) ? newStatus : computedStatus;

  if (syncedToLightspeed !== null) {
    await db.prepare(`UPDATE order_items SET status = ?, quantity_made = ?, synced_to_lightspeed = ? WHERE id = ?;`)
      .bind(finalStatus, newMade, syncedToLightspeed ? 1 : 0, Number(itemId)).run();
  } else {
    await db.prepare(`UPDATE order_items SET status = ?, quantity_made = ? WHERE id = ?;`)
      .bind(finalStatus, newMade, Number(itemId)).run();
  }

  if (orderId) {
    const pendingRow = await db.prepare(
      `SELECT COUNT(*) as pending_count FROM order_items WHERE order_id = ? AND status != 'made';`
    ).bind(orderId).first();
    const pendingCount = Number(pendingRow?.pending_count || 0);
    if (pendingCount === 0) {
      await db.prepare(`UPDATE orders SET status = 'ready', updated_at = ? WHERE id = ? AND status IN ('new', 'in_progress');`)
        .bind(nowIso, orderId).run();
    } else {
      await db.prepare(`UPDATE orders SET status = 'in_progress', updated_at = ? WHERE id = ? AND status = 'ready';`)
        .bind(nowIso, orderId).run();
    }
  }

  return getOrderById(db, orderId);
}

async function updateItemsByName(db, itemName, countToMark = null, newStatus = 'made', syncedToLightspeed = null) {
  const nowIso = new Date().toISOString();
  const affectedOrderIds = new Set();

  if (!db) {
    const activeOrderMap = new Map(memoryStore.orders.map(o => [o.id, o]));
    let remaining = countToMark !== null && countToMark !== undefined ? Number(countToMark) : 999999;

    if (newStatus === 'pending') {
      const candidates = memoryStore.order_items
        .filter(i => {
          const o = activeOrderMap.get(i.order_id);
          return i.name === itemName && o && ['new', 'in_progress', 'ready'].includes(o.status) && (i.quantity_made || 0) > 0;
        })
        .reverse();

      for (const r of candidates) {
        if (remaining <= 0) break;
        const reduceBy = Math.min(r.quantity_made || 0, remaining);
        r.quantity_made = (r.quantity_made || 0) - reduceBy;
        r.status = r.quantity_made === 0 ? 'pending' : 'partially_made';
        if (syncedToLightspeed !== null) r.synced_to_lightspeed = syncedToLightspeed ? 1 : 0;
        affectedOrderIds.add(r.order_id);
        remaining -= reduceBy;
      }
    } else {
      const candidates = memoryStore.order_items.filter(i => {
        const o = activeOrderMap.get(i.order_id);
        return i.name === itemName && o && ['new', 'in_progress'].includes(o.status) && (i.quantity - (i.quantity_made || 0)) > 0;
      });

      for (const r of candidates) {
        if (remaining <= 0) break;
        const needed = r.quantity - (r.quantity_made || 0);
        const addBy = Math.min(needed, remaining);
        r.quantity_made = (r.quantity_made || 0) + addBy;
        r.status = r.quantity_made >= r.quantity ? 'made' : 'partially_made';
        if (syncedToLightspeed !== null) r.synced_to_lightspeed = syncedToLightspeed ? 1 : 0;
        affectedOrderIds.add(r.order_id);
        remaining -= addBy;
      }
    }

    for (const oId of affectedOrderIds) {
      const orderItems = memoryStore.order_items.filter(i => i.order_id === oId);
      const pendingCount = orderItems.filter(i => i.status !== 'made').length;
      const o = activeOrderMap.get(oId);
      if (o) {
        if (pendingCount === 0 && ['new', 'in_progress'].includes(o.status)) {
          o.status = 'ready';
          o.updated_at = nowIso;
        } else if (pendingCount > 0 && o.status === 'ready') {
          o.status = 'in_progress';
          o.updated_at = nowIso;
        }
      }
    }
    return;
  }

  await ensureD1Schema(db);
  let remaining = countToMark !== null && countToMark !== undefined ? Number(countToMark) : 999999;

  if (newStatus === 'pending') {
    const { results: rows } = await db.prepare(`
      SELECT oi.id, oi.order_id, oi.quantity, COALESCE(oi.quantity_made, 0) as quantity_made
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      WHERE oi.name = ? AND o.status IN ('new', 'in_progress', 'ready') AND COALESCE(oi.quantity_made, 0) > 0
      ORDER BY o.created_at DESC, oi.id DESC;
    `).bind(itemName).all();

    for (const r of rows || []) {
      if (remaining <= 0) break;
      const qMade = Number(r.quantity_made || 0);
      const reduceBy = Math.min(qMade, remaining);
      const newMade = qMade - reduceBy;
      const st = newMade === 0 ? 'pending' : 'partially_made';
      if (syncedToLightspeed !== null) {
        await db.prepare(`UPDATE order_items SET status = ?, quantity_made = ?, synced_to_lightspeed = ? WHERE id = ?;`)
          .bind(st, newMade, syncedToLightspeed ? 1 : 0, r.id).run();
      } else {
        await db.prepare(`UPDATE order_items SET status = ?, quantity_made = ? WHERE id = ?;`)
          .bind(st, newMade, r.id).run();
      }
      affectedOrderIds.add(r.order_id);
      remaining -= reduceBy;
    }
  } else {
    const { results: rows } = await db.prepare(`
      SELECT oi.id, oi.order_id, oi.quantity, COALESCE(oi.quantity_made, 0) as quantity_made
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      WHERE oi.name = ? AND o.status IN ('new', 'in_progress') AND (oi.quantity - COALESCE(oi.quantity_made, 0)) > 0
      ORDER BY o.created_at ASC, oi.id ASC;
    `).bind(itemName).all();

    for (const r of rows || []) {
      if (remaining <= 0) break;
      const needed = Number(r.quantity) - Number(r.quantity_made || 0);
      const addBy = Math.min(needed, remaining);
      const newMade = Number(r.quantity_made || 0) + addBy;
      const st = newMade >= Number(r.quantity) ? 'made' : 'partially_made';
      if (syncedToLightspeed !== null) {
        await db.prepare(`UPDATE order_items SET status = ?, quantity_made = ?, synced_to_lightspeed = ? WHERE id = ?;`)
          .bind(st, newMade, syncedToLightspeed ? 1 : 0, r.id).run();
      } else {
        await db.prepare(`UPDATE order_items SET status = ?, quantity_made = ? WHERE id = ?;`)
          .bind(st, newMade, r.id).run();
      }
      affectedOrderIds.add(r.order_id);
      remaining -= addBy;
    }
  }

  for (const oId of affectedOrderIds) {
    const pendingRow = await db.prepare(
      `SELECT COUNT(*) as pending_count FROM order_items WHERE order_id = ? AND status != 'made';`
    ).bind(oId).first();
    if (Number(pendingRow?.pending_count || 0) === 0) {
      await db.prepare(`UPDATE orders SET status = 'ready', updated_at = ? WHERE id = ? AND status IN ('new', 'in_progress');`)
        .bind(nowIso, oId).run();
    } else {
      await db.prepare(`UPDATE orders SET status = 'in_progress', updated_at = ? WHERE id = ? AND status = 'ready';`)
        .bind(nowIso, oId).run();
    }
  }
}

async function getDetailedQueueItems(db) {
  let rows = [];
  if (!db) {
    const activeOrderMap = new Map(
      memoryStore.orders.filter(o => ['new', 'in_progress'].includes(o.status)).map(o => [o.id, o])
    );
    for (const oi of memoryStore.order_items) {
      const o = activeOrderMap.get(oi.order_id);
      if (o) {
        rows.push({
          item_id: oi.id,
          order_id: oi.order_id,
          name: oi.name,
          sku: oi.sku || '',
          quantity: oi.quantity,
          quantity_made: oi.quantity_made || 0,
          modifiers: oi.modifiers || '',
          item_status: oi.status,
          item_synced: oi.synced_to_lightspeed || 0,
          order_number: o.order_number,
          customer_name: o.customer_name,
          order_status: o.status,
          order_created_at: o.created_at
        });
      }
    }
    rows.sort((a, b) => a.name.localeCompare(b.name) || String(a.order_created_at).localeCompare(String(b.order_created_at)));
  } else {
    await ensureD1Schema(db);
    const res = await db.prepare(`
      SELECT 
        oi.id as item_id,
        oi.order_id,
        oi.name,
        oi.sku,
        oi.quantity,
        COALESCE(oi.quantity_made, 0) as quantity_made,
        oi.modifiers,
        oi.status as item_status,
        oi.synced_to_lightspeed as item_synced,
        o.order_number,
        o.customer_name,
        o.status as order_status,
        o.created_at as order_created_at
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      WHERE o.status IN ('new', 'in_progress')
      ORDER BY oi.name ASC, o.created_at ASC;
    `).all();
    rows = res.results || [];
  }

  const grouped = {};
  for (const r of rows) {
    const name = r.name;
    if (!grouped[name]) {
      grouped[name] = {
        name,
        sku: r.sku || '',
        total_quantity: 0,
        pending_quantity: 0,
        made_quantity: 0,
        order_lines: []
      };
    }
    const qty = Number(r.quantity || 1);
    const qtyMade = Math.min(qty, Number(r.quantity_made || 0));
    const qtyPending = Math.max(0, qty - qtyMade);

    grouped[name].total_quantity += qty;
    grouped[name].made_quantity += qtyMade;
    grouped[name].pending_quantity += qtyPending;

    grouped[name].order_lines.push({
      ...r,
      line_made_quantity: qtyMade,
      line_pending_quantity: qtyPending
    });
  }

  return Object.values(grouped).sort((a, b) => {
    if ((a.pending_quantity === 0) !== (b.pending_quantity === 0)) {
      return a.pending_quantity === 0 ? 1 : -1;
    }
    if (b.pending_quantity !== a.pending_quantity) {
      return b.pending_quantity - a.pending_quantity;
    }
    return a.name.localeCompare(b.name);
  });
}

async function getActiveQueueSummary(db) {
  const detailed = await getDetailedQueueItems(db);
  return detailed
    .filter(d => d.pending_quantity > 0)
    .map(d => ({
      name: d.name,
      sku: d.sku,
      total_quantity: d.pending_quantity,
      order_count: new Set(d.order_lines.filter(l => l.line_pending_quantity > 0).map(l => l.order_id)).size
    }))
    .sort((a, b) => b.total_quantity - a.total_quantity || a.name.localeCompare(b.name));
}

async function getStats(db) {
  const todayStart = new Date().toISOString().slice(0, 10) + 'T00:00:00';
  if (!db) {
    const totalOrders = memoryStore.orders.length;
    const totalRevenue = memoryStore.orders.reduce((s, o) => s + Number(o.total || 0), 0);
    const todayList = memoryStore.orders.filter(o => String(o.created_at) >= todayStart);
    const todayRevenue = todayList.reduce((s, o) => s + Number(o.total || 0), 0);
    const pendingOrders = memoryStore.orders.filter(o => o.status === 'new').length;
    const inProgressOrders = memoryStore.orders.filter(o => o.status === 'in_progress').length;
    return {
      total_orders: totalOrders,
      total_revenue: Math.round(totalRevenue * 100) / 100,
      today_orders: todayList.length,
      today_revenue: Math.round(todayRevenue * 100) / 100,
      pending_orders: pendingOrders,
      in_progress_orders: inProgressOrders
    };
  }

  await ensureD1Schema(db);
  const overall = await db.prepare(`SELECT COUNT(*) as total_count, COALESCE(SUM(total), 0) as total_revenue FROM orders;`).first();
  const today = await db.prepare(`SELECT COUNT(*) as count, COALESCE(SUM(total), 0) as revenue FROM orders WHERE created_at >= ?;`).bind(todayStart).first();
  const pending = await db.prepare(`SELECT COUNT(*) as count FROM orders WHERE status = 'new';`).first();
  const inProgress = await db.prepare(`SELECT COUNT(*) as count FROM orders WHERE status = 'in_progress';`).first();

  return {
    total_orders: Number(overall?.total_count || 0),
    total_revenue: Math.round(Number(overall?.total_revenue || 0) * 100) / 100,
    today_orders: Number(today?.count || 0),
    today_revenue: Math.round(Number(today?.revenue || 0) * 100) / 100,
    pending_orders: Number(pending?.count || 0),
    in_progress_orders: Number(inProgress?.count || 0)
  };
}

async function clearAllOrders(db) {
  if (!db) {
    memoryStore.order_items = [];
    memoryStore.orders = [];
    return;
  }
  await ensureD1Schema(db);
  await db.prepare(`DELETE FROM order_items;`).run();
  await db.prepare(`DELETE FROM orders;`).run();
}

// ============================================================================
// Lightspeed Normalization, Simulation & API Helpers
// ============================================================================

function generateMockOrder() {
  const menuItems = [
    { name: "Flat White (Oat Milk)", sku: "BEV-001", price: 4.75, mod: "Extra hot, 1 pump vanilla" },
    { name: "Cold Brew Reserve", sku: "BEV-002", price: 5.25, mod: "Light ice" },
    { name: "Avocado Sourdough Toast", sku: "FD-101", price: 12.50, mod: "Poached egg, chili flakes" },
    { name: "Almond Butter Croissant", sku: "BAK-201", price: 4.50, mod: "Warmed" },
    { name: "Acai Energy Bowl", sku: "FD-102", price: 11.00, mod: "Extra chia seeds" },
    { name: "Smoked Salmon Bagel", sku: "FD-103", price: 13.50, mod: "Capers on the side" },
    { name: "Iced Ceremonial Matcha", sku: "BEV-003", price: 6.00, mod: "Sweetened with honey" },
    { name: "Artisan Ceramic Tumbler", sku: "RET-301", price: 24.00, mod: "Gift wrapped" },
    { name: "Truffle Mushroom Panini", sku: "FD-104", price: 14.00, mod: "Gluten-free bread" }
  ];

  const customers = [
    { name: "Sophia Reynolds", email: "sophia.r@example.com", phone: "(555) 234-5678" },
    { name: "Marcus Vance", email: "m.vance@example.com", phone: "(555) 876-5432" },
    { name: "Elena Rostova", email: "elena.rostova@example.com", phone: "(555) 345-9876" },
    { name: "David Chen", email: "dchen@example.com", phone: "(555) 654-3210" },
    { name: "Chloe Dupont", email: "chloe.d@example.com", phone: "(555) 987-1234" },
    { name: "Liam Gallagher", email: "liam.g@example.com", phone: "(555) 432-8765" }
  ];

  const orderTypes = ["In-Store", "Takeaway", "Dine-In", "Delivery", "Online"];
  const paymentMethods = ["Apple Pay", "Visa Contactless", "Mastercard", "Cash", "Gift Card"];

  const orderNum = `LS-${Math.floor(10000 + Math.random() * 90000)}`;
  const cust = customers[Math.floor(Math.random() * customers.length)];

  const shuffled = [...menuItems].sort(() => 0.5 - Math.random());
  const count = Math.floor(1 + Math.random() * 3);
  const selected = shuffled.slice(0, count);

  const items = [];
  let subtotal = 0;
  for (const it of selected) {
    const qty = Math.floor(1 + Math.random() * 2);
    const totalPrice = Math.round(qty * it.price * 100) / 100;
    subtotal += totalPrice;
    items.push({
      name: it.name,
      sku: it.sku,
      quantity: qty,
      unit_price: it.price,
      total_price: totalPrice,
      modifiers: Math.random() > 0.3 ? it.mod : ""
    });
  }

  const tax = Math.round(subtotal * 0.08875 * 100) / 100;
  const total = Math.round((subtotal + tax) * 100) / 100;
  const nowIso = new Date().toISOString();

  return {
    id: `SIM-${orderNum}`,
    lightspeed_id: orderNum,
    order_number: orderNum,
    source: "simulator",
    status: "new",
    customer_name: cust.name,
    customer_email: cust.email,
    customer_phone: cust.phone,
    order_type: orderTypes[Math.floor(Math.random() * orderTypes.length)],
    subtotal: Math.round(subtotal * 100) / 100,
    tax,
    total,
    currency: "USD",
    payment_status: "Paid",
    payment_method: paymentMethods[Math.floor(Math.random() * paymentMethods.length)],
    notes: Math.random() > 0.6 ? "Fast pickup requested" : "",
    created_at: nowIso,
    items,
    raw_payload: { simulated: true, generated_at: nowIso }
  };
}

function normalizeWebhookPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return generateMockOrder();
  }
  const inner = payload.payload && typeof payload.payload === 'object' ? payload.payload : (payload.sale || payload.order || payload);
  const saleId = String(inner.saleID || inner.SaleID || inner.id || crypto.randomUUID().slice(0, 8));
  const orderNum = String(inner.calcReceiptNumber || inner.invoice_number || inner.receipt_number || inner.order_number || `LS-${saleId.slice(-6)}`);

  const cust = inner.Customer || inner.customer || {};
  const custName = inner.customer_name || `${cust.firstName || cust.first_name || ''} ${cust.lastName || cust.last_name || ''}`.trim() || 'Walk-in Customer';

  const rawItems = inner.items || inner.line_items || inner.register_sale_products || (inner.SaleLines && inner.SaleLines.SaleLine) || [];
  const itemsList = Array.isArray(rawItems) ? rawItems : [rawItems];

  const items = itemsList.map(it => {
    const qty = Number(it.quantity || it.unitQuantity || 1);
    const price = Number(it.unit_price || it.price || it.unitPrice || 0);
    const total = Number(it.total_price || it.price_total || it.calcTotal || qty * price);
    const itemObj = it.Item || {};
    return {
      name: it.name || it.product_name || itemObj.description || 'Menu Item',
      sku: String(it.sku || itemObj.customSku || ''),
      quantity: qty,
      unit_price: price,
      total_price: total,
      modifiers: String(it.modifiers || it.note || '')
    };
  });

  const total = Number(inner.total || inner.calcTotal || inner.total_price || items.reduce((s, i) => s + i.total_price, 0));
  const tax = Number(inner.tax || inner.taxTotal || inner.total_tax || 0);
  const subtotal = Number(inner.subtotal || inner.calcSubtotal || Math.max(0, total - tax));

  return {
    id: `LS-${saleId}`,
    lightspeed_id: saleId,
    order_number: orderNum,
    source: 'lightspeed_webhook',
    status: 'new',
    customer_name: custName,
    customer_email: cust.email || inner.customer_email || '',
    customer_phone: cust.phone || inner.customer_phone || '',
    order_type: inner.order_type || 'In-Store',
    subtotal,
    tax,
    total,
    currency: inner.currency || 'USD',
    payment_status: inner.payment_status || 'Paid',
    payment_method: inner.payment_method || 'Card',
    notes: inner.notes || inner.note || '',
    created_at: inner.created_at || inner.timeStamp || new Date().toISOString(),
    items: items.length > 0 ? items : [{ name: 'General Item', sku: 'GEN-01', quantity: 1, unit_price: total, total_price: total, modifiers: '' }],
    raw_payload: payload
  };
}

async function updateLightspeedSaleStatus(settings, lightspeedId, newStatus) {
  const platform = settings.lightspeed_platform || 'r_series';
  const apiToken = (settings.api_token || '').trim();
  const accountId = (settings.account_id || '').trim();
  const domainPrefix = (settings.domain_prefix || '').trim();
  const cleanId = String(lightspeedId).replace(/^(R-|X-|SIM-|GEN-)/, '');

  if (!apiToken || String(lightspeedId).includes('SIM')) {
    return {
      success: true,
      message: `Simulated Lightspeed API call: marked #${cleanId} as '${newStatus}'`,
      simulated: true
    };
  }

  const headers = {
    'Authorization': `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': 'LightspeedLiveOrdersDashboard/1.0'
  };

  try {
    if (platform === 'r_series' && accountId) {
      const url = `https://api.lightspeedapp.com/API/Account/${accountId}/Sale/${cleanId}.json`;
      const res = await fetch(url, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          completed: ['ready', 'completed'].includes(newStatus),
          note: `Order status updated to ${newStatus.toUpperCase()}`
        })
      });
      if (res.ok) {
        return { success: true, message: `Synced #${cleanId} as '${newStatus}' via Lightspeed R-Series API`, simulated: false };
      }
      return { success: false, message: `Lightspeed API HTTP ${res.status}`, simulated: false };
    }

    if (platform === 'x_series' && domainPrefix) {
      const url = `https://${domainPrefix}.vendhq.com/api/2.0/sales/${cleanId}`;
      const res = await fetch(url, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          status: newStatus === 'completed' ? 'CLOSED' : 'SAVED',
          note: `Order marked as ${newStatus.toUpperCase()}`
        })
      });
      if (res.ok) {
        return { success: true, message: `Synced #${cleanId} as '${newStatus}' via Lightspeed X-Series API`, simulated: false };
      }
      return { success: false, message: `Lightspeed API HTTP ${res.status}`, simulated: false };
    }

    return { success: true, message: `Marked #${cleanId} as '${newStatus}'`, simulated: true };
  } catch (err) {
    return { success: false, message: `Failed to sync with Lightspeed API: ${err.message}`, simulated: false };
  }
}

async function testApiConnection(settings) {
  const platform = settings.lightspeed_platform || 'r_series';
  const apiToken = (settings.api_token || '').trim();
  const accountId = (settings.account_id || '').trim();
  const domainPrefix = (settings.domain_prefix || '').trim();

  if (platform === 'webhook_only') {
    return { success: true, message: 'Webhook mode: Ready to accept incoming Webhook events.' };
  }
  if (!apiToken) {
    return { success: false, message: 'API Token is required.' };
  }

  const headers = {
    'Authorization': `Bearer ${apiToken}`,
    'Accept': 'application/json',
    'User-Agent': 'LightspeedLiveOrdersDashboard/1.0'
  };

  try {
    let url = '';
    if (platform === 'r_series') {
      if (!accountId) return { success: false, message: 'Account ID is required for Lightspeed R-Series.' };
      url = `https://api.lightspeedapp.com/API/Account/${accountId}/Sale.json?limit=1`;
    } else if (platform === 'x_series') {
      if (!domainPrefix) return { success: false, message: 'Domain Prefix is required for Lightspeed X-Series.' };
      url = `https://${domainPrefix}.vendhq.com/api/2.0/sales?page_size=1`;
    } else {
      return { success: true, message: 'Webhook mode ready.' };
    }

    const res = await fetch(url, { headers });
    if (res.ok) {
      return { success: true, message: `Successfully connected to Lightspeed (${platform.toUpperCase()})!` };
    }
    const txt = await res.text();
    return { success: false, message: `Lightspeed API Error (${res.status}): ${txt.slice(0, 120)}` };
  } catch (err) {
    return { success: false, message: `Connection error: ${err.message}` };
  }
}

async function pollLightspeedSales(settings) {
  const platform = settings.lightspeed_platform || 'r_series';
  const apiToken = (settings.api_token || '').trim();
  const accountId = (settings.account_id || '').trim();
  const domainPrefix = (settings.domain_prefix || '').trim();

  if (!apiToken) return [];
  const headers = {
    'Authorization': `Bearer ${apiToken}`,
    'Accept': 'application/json',
    'User-Agent': 'LightspeedLiveOrdersDashboard/1.0'
  };

  try {
    if (platform === 'r_series' && accountId) {
      const url = `https://api.lightspeedapp.com/API/Account/${accountId}/Sale.json?limit=25&sort=-timeStamp&load_relations=%5B%22Customer%22%2C%22SaleLines%22%2C%22SaleLines.Item%22%2C%22SalePayments%22%5D`;
      const res = await fetch(url, { headers });
      if (!res.ok) return [];
      const data = await res.json();
      let sales = data.Sale || [];
      if (!Array.isArray(sales)) sales = [sales];
      return sales.map(s => normalizeWebhookPayload(s));
    }
    if (platform === 'x_series' && domainPrefix) {
      const url = `https://${domainPrefix}.vendhq.com/api/2.0/sales?page_size=25&order_by=created_at&order_direction=desc`;
      const res = await fetch(url, { headers });
      if (!res.ok) return [];
      const data = await res.json();
      return (data.data || []).map(s => normalizeWebhookPayload(s));
    }
  } catch (err) {
    console.error('Lightspeed poll error:', err);
  }
  return [];
}

// ============================================================================
// User & Session Auth Helpers (D1 + Memory Fallback)
// ============================================================================

async function ensureMemoryAdmin() {
  if (memoryStore.users.length === 0) {
    const defaultHash = await hashPassword('admin123');
    memoryStore.users.push({
      id: memoryStore.nextUserId++,
      username: 'admin',
      display_name: 'Administrator',
      password_hash: defaultHash,
      role: 'admin',
      created_at: new Date().toISOString()
    });
  }
}

async function authenticateUser(db, username, password) {
  const cleanUser = String(username || '').trim().toLowerCase();
  if (!cleanUser || !password) return null;

  if (!db) {
    await ensureMemoryAdmin();
    const row = memoryStore.users.find(u => u.username.toLowerCase() === cleanUser);
    if (!row || !(await verifyPassword(password, row.password_hash))) return null;
    const token = randomHex(32);
    const session = {
      token,
      user_id: row.id,
      username: row.username,
      display_name: row.display_name,
      role: row.role,
      created_at: new Date().toISOString()
    };
    memoryStore.sessions.push(session);
    return {
      token,
      user: { id: row.id, username: row.username, display_name: row.display_name, role: row.role }
    };
  }

  await ensureD1Schema(db);
  const row = await db.prepare(`SELECT * FROM users WHERE LOWER(username) = ?;`).bind(cleanUser).first();
  if (!row || !(await verifyPassword(password, row.password_hash))) return null;

  const token = randomHex(32);
  const nowIso = new Date().toISOString();
  await db.prepare(`
    INSERT INTO sessions (token, user_id, username, display_name, role, created_at)
    VALUES (?, ?, ?, ?, ?, ?);
  `).bind(token, row.id, row.username, row.display_name, row.role, nowIso).run();

  return {
    token,
    user: { id: row.id, username: row.username, display_name: row.display_name, role: row.role }
  };
}

async function getUserByToken(db, token) {
  if (!token) return null;
  if (!db) {
    await ensureMemoryAdmin();
    const s = memoryStore.sessions.find(x => x.token === token);
    if (!s) return null;
    const u = memoryStore.users.find(x => x.id === s.user_id);
    if (!u) return null;
    return { id: u.id, username: u.username, display_name: u.display_name, role: u.role };
  }
  await ensureD1Schema(db);
  const row = await db.prepare(`
    SELECT u.id, u.username, u.display_name, u.role
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.token = ?;
  `).bind(token).first();
  return row || null;
}

async function revokeSession(db, token) {
  if (!token) return;
  if (!db) {
    memoryStore.sessions = memoryStore.sessions.filter(s => s.token !== token);
    return;
  }
  await ensureD1Schema(db);
  await db.prepare(`DELETE FROM sessions WHERE token = ?;`).bind(token).run();
}

async function listUsers(db) {
  if (!db) {
    await ensureMemoryAdmin();
    return memoryStore.users.map(u => ({
      id: u.id,
      username: u.username,
      display_name: u.display_name,
      role: u.role,
      created_at: u.created_at
    }));
  }
  await ensureD1Schema(db);
  const { results } = await db.prepare(`SELECT id, username, display_name, role, created_at FROM users ORDER BY id ASC;`).all();
  return results || [];
}

async function createUser(db, { username, password, display_name, role = 'staff' }) {
  const cleanUsername = String(username || '').trim().toLowerCase();
  if (!cleanUsername || !password) {
    return { user: null, error: 'Username and password are required.' };
  }
  if (String(password).length < 4) {
    return { user: null, error: 'Password must be at least 4 characters.' };
  }
  const cleanRole = role === 'admin' ? 'admin' : 'staff';
  const cleanDisplay = String(display_name || cleanUsername).trim();
  const nowIso = new Date().toISOString();
  const pwHash = await hashPassword(password);

  if (!db) {
    await ensureMemoryAdmin();
    if (memoryStore.users.some(u => u.username.toLowerCase() === cleanUsername)) {
      return { user: null, error: `Username '${cleanUsername}' already exists.` };
    }
    const u = {
      id: memoryStore.nextUserId++,
      username: cleanUsername,
      display_name: cleanDisplay,
      password_hash: pwHash,
      role: cleanRole,
      created_at: nowIso
    };
    memoryStore.users.push(u);
    return {
      user: { id: u.id, username: u.username, display_name: u.display_name, role: u.role, created_at: u.created_at },
      error: null
    };
  }

  await ensureD1Schema(db);
  const existing = await db.prepare(`SELECT id FROM users WHERE LOWER(username) = ?;`).bind(cleanUsername).first();
  if (existing) {
    return { user: null, error: `Username '${cleanUsername}' already exists.` };
  }
  const res = await db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role, created_at)
    VALUES (?, ?, ?, ?, ?);
  `).bind(cleanUsername, cleanDisplay, pwHash, cleanRole, nowIso).run();

  return {
    user: {
      id: res.meta?.last_row_id,
      username: cleanUsername,
      display_name: cleanDisplay,
      role: cleanRole,
      created_at: nowIso
    },
    error: null
  };
}

async function updateUserPassword(db, userId, newPassword) {
  if (!newPassword || String(newPassword).length < 4) {
    return { ok: false, error: 'Password must be at least 4 characters.' };
  }
  const pwHash = await hashPassword(newPassword);
  const targetId = parseInt(userId, 10);
  if (!db) {
    await ensureMemoryAdmin();
    const u = memoryStore.users.find(x => x.id === targetId);
    if (!u) return { ok: false, error: 'User not found.' };
    u.password_hash = pwHash;
    return { ok: true, error: null };
  }
  await ensureD1Schema(db);
  await db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?;`).bind(pwHash, targetId).run();
  return { ok: true, error: null };
}

async function deleteUser(db, userId, requestingUserId) {
  const targetId = parseInt(userId, 10);
  if (requestingUserId !== undefined && parseInt(requestingUserId, 10) === targetId) {
    return { ok: false, error: 'You cannot delete your own active account.' };
  }
  if (!db) {
    await ensureMemoryAdmin();
    const target = memoryStore.users.find(x => x.id === targetId);
    if (!target) return { ok: false, error: 'User not found.' };
    if (target.role === 'admin') {
      const admins = memoryStore.users.filter(x => x.role === 'admin');
      if (admins.length <= 1) return { ok: false, error: 'Cannot delete the last admin account.' };
    }
    memoryStore.sessions = memoryStore.sessions.filter(s => s.user_id !== targetId);
    memoryStore.users = memoryStore.users.filter(u => u.id !== targetId);
    return { ok: true, error: null };
  }
  await ensureD1Schema(db);
  const target = await db.prepare(`SELECT id, username, role FROM users WHERE id = ?;`).bind(targetId).first();
  if (!target) return { ok: false, error: 'User not found.' };
  if (target.role === 'admin') {
    const adminCnt = await db.prepare(`SELECT COUNT(*) as cnt FROM users WHERE role = 'admin';`).first();
    if ((adminCnt?.cnt || 0) <= 1) {
      return { ok: false, error: 'Cannot delete the last admin account.' };
    }
  }
  await db.prepare(`DELETE FROM sessions WHERE user_id = ?;`).bind(targetId).run();
  await db.prepare(`DELETE FROM users WHERE id = ?;`).bind(targetId).run();
  return { ok: true, error: null };
}

function getAuthTokenFromRequest(request, url) {
  const authHeader = request.headers.get('Authorization') || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  return url.searchParams.get('token') || null;
}

// ============================================================================
// Main Cloudflare Pages Function Request Handler
// ============================================================================

function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PATCH',
      'Access-Control-Allow-Headers': 'Content-Type, X-Lightspeed-Signature, Authorization'
    }
  });
}

export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB || null;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PATCH',
        'Access-Control-Allow-Headers': 'Content-Type, X-Lightspeed-Signature, Authorization'
      }
    });
  }

  // -------------------- GET ENDPOINTS --------------------
  if (method === 'GET') {
    if (path === '/api/stream') {
      const [stats, queue_summary, detailed_queue] = await Promise.all([
        getStats(db),
        getActiveQueueSummary(db),
        getDetailedQueueItems(db)
      ]);
      const initMsg = JSON.stringify({
        type: 'connected',
        serverless: true,
        message: 'Connected to Lightspeed Live Stream (Cloudflare Edge)',
        stats,
        queue_summary,
        detailed_queue
      });
      return new Response(`data: ${initMsg}\n\n`, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    if (path === '/api/live-sync') {
      const [orders, stats, queue_summary, detailed_queue] = await Promise.all([
        listOrders(db, { limit: 100 }),
        getStats(db),
        getActiveQueueSummary(db),
        getDetailedQueueItems(db)
      ]);
      return jsonResponse(200, { orders, stats, queue_summary, detailed_queue });
    }

    if (path === '/api/orders') {
      const status = url.searchParams.get('status');
      const search = url.searchParams.get('search');
      const limit = parseInt(url.searchParams.get('limit') || '100', 10);
      const orders = await listOrders(db, { status, search, limit });
      return jsonResponse(200, { orders, count: orders.length });
    }

    if (path.startsWith('/api/orders/')) {
      const orderId = decodeURIComponent(path.slice('/api/orders/'.length).replace(/\/$/, ''));
      const order = await getOrderById(db, orderId);
      if (order) return jsonResponse(200, { order });
      return jsonResponse(404, { error: 'Order not found' });
    }

    if (path === '/api/stats') {
      return jsonResponse(200, await getStats(db));
    }

    if (path === '/api/queue-summary') {
      return jsonResponse(200, { items: await getActiveQueueSummary(db) });
    }

    if (path === '/api/detailed-queue-items') {
      return jsonResponse(200, { items: await getDetailedQueueItems(db) });
    }

    if (path === '/api/settings') {
      const token = getAuthTokenFromRequest(request, url);
      const user = await getUserByToken(db, token);
      if (!user) return jsonResponse(401, { error: 'Authentication required. Please sign in.' });
      if (user.role !== 'admin') {
        return jsonResponse(403, { error: 'Admin access required. Only the admin account can change API settings.' });
      }
      const settings = await getSettings(db);
      let masked = settings.api_token || '';
      if (masked && masked.length > 8) {
        masked = masked.slice(0, 4) + '••••••••' + masked.slice(-4);
      }
      return jsonResponse(200, {
        ...settings,
        api_token_preview: masked,
        has_api_token: Boolean(settings.api_token)
      });
    }

    if (path === '/api/auth/me') {
      const token = getAuthTokenFromRequest(request, url);
      const user = await getUserByToken(db, token);
      if (!user) return jsonResponse(401, { authenticated: false });
      return jsonResponse(200, { authenticated: true, user });
    }

    if (path === '/api/users') {
      const token = getAuthTokenFromRequest(request, url);
      const user = await getUserByToken(db, token);
      if (!user) return jsonResponse(401, { error: 'Authentication required.' });
      if (user.role !== 'admin') return jsonResponse(403, { error: 'Admin access required.' });
      return jsonResponse(200, { users: await listUsers(db) });
    }
  }

  // -------------------- POST ENDPOINTS --------------------
  if (method === 'POST') {
    let data = {};
    try {
      const text = await request.text();
      data = text ? JSON.parse(text) : {};
    } catch (_) {
      data = {};
    }

    if (path === '/api/webhooks/lightspeed') {
      const normalized = normalizeWebhookPayload(data);
      const { savedOrder, isNew } = await saveOrder(db, normalized);
      return jsonResponse(200, {
        status: 'success',
        order_id: savedOrder.id,
        is_new: isNew
      });
    }

    if (path.startsWith('/api/orders/') && path.endsWith('/status')) {
      const parts = path.split('/');
      const orderId = decodeURIComponent(parts[3]);
      const newStatus = data.status || 'new';
      const syncLightspeed = Boolean(data.sync_lightspeed);

      let apiResult = null;
      if (syncLightspeed) {
        const order = await getOrderById(db, orderId);
        if (order) {
          const settings = await getSettings(db);
          apiResult = await updateLightspeedSaleStatus(settings, order.lightspeed_id || orderId, newStatus);
        }
      }

      const updated = await updateOrderStatus(db, orderId, newStatus, syncLightspeed);
      if (updated) {
        return jsonResponse(200, { order: updated, api_result: apiResult });
      }
      return jsonResponse(404, { error: 'Order not found' });
    }

    if (path.startsWith('/api/orders/') && path.endsWith('/notes')) {
      const parts = path.split('/');
      const orderId = decodeURIComponent(parts[3]);
      const updated = await updateOrderNotes(db, orderId, data.notes || '');
      if (updated) return jsonResponse(200, { order: updated });
      return jsonResponse(404, { error: 'Order not found' });
    }

    if (path.startsWith('/api/items/') && path.endsWith('/status')) {
      const parts = path.split('/');
      const itemId = parseInt(parts[3], 10);
      const newStatus = data.status || 'made';
      const syncLightspeed = Boolean(data.sync_lightspeed);
      const quantityDelta = data.quantity_delta ?? null;
      const count = data.count ?? null;

      let apiResult = null;
      if (syncLightspeed) {
        const settings = await getSettings(db);
        let desc = `item-${itemId}`;
        if (count !== null) desc += ` (count: ${count})`;
        else if (quantityDelta !== null) desc += ` (delta: ${quantityDelta})`;
        apiResult = await updateLightspeedSaleStatus(settings, desc, newStatus);
      }

      const updatedOrder = await updateItemStatus(db, itemId, newStatus, syncLightspeed, quantityDelta, count);
      const detailedItems = await getDetailedQueueItems(db);
      return jsonResponse(200, {
        status: 'success',
        order: updatedOrder,
        api_result: apiResult,
        detailed_items: detailedItems
      });
    }

    if (path === '/api/items/batch-status') {
      const itemName = data.name;
      const newStatus = data.status || 'made';
      const count = data.count !== null && data.count !== undefined ? parseInt(data.count, 10) : null;
      const syncLightspeed = Boolean(data.sync_lightspeed);

      let apiResult = null;
      if (syncLightspeed) {
        const settings = await getSettings(db);
        const targetDesc = count ? `${count}x ${itemName}` : itemName;
        apiResult = await updateLightspeedSaleStatus(settings, targetDesc, newStatus);
      }

      await updateItemsByName(db, itemName, count, newStatus, syncLightspeed);
      const detailedItems = await getDetailedQueueItems(db);
      return jsonResponse(200, {
        status: 'success',
        api_result: apiResult,
        detailed_items: detailedItems
      });
    }

    if (path === '/api/simulate-order') {
      const mock = generateMockOrder();
      const { savedOrder } = await saveOrder(db, mock);
      return jsonResponse(201, { order: savedOrder });
    }

    if (path === '/api/settings') {
      const token = getAuthTokenFromRequest(request, url);
      const user = await getUserByToken(db, token);
      if (!user) return jsonResponse(401, { error: 'Authentication required.' });
      if (user.role !== 'admin') {
        return jsonResponse(403, { error: 'Admin access required. Only the admin account can change API settings.' });
      }
      const current = await getSettings(db);
      if (!data.api_token) {
        data.api_token = current.api_token || '';
      }
      await updateSettings(db, data);
      return jsonResponse(200, { status: 'saved' });
    }

    if (path === '/api/lightspeed/test-connection') {
      const token = getAuthTokenFromRequest(request, url);
      const user = await getUserByToken(db, token);
      if (!user) return jsonResponse(401, { error: 'Authentication required.' });
      if (user.role !== 'admin') return jsonResponse(403, { error: 'Admin access required.' });
      const current = await getSettings(db);
      const merged = { ...current, ...data };
      const res = await testApiConnection(merged);
      return jsonResponse(res.success ? 200 : 400, res);
    }

    if (path === '/api/lightspeed/sync-now') {
      const token = getAuthTokenFromRequest(request, url);
      const user = await getUserByToken(db, token);
      if (!user) return jsonResponse(401, { error: 'Authentication required.' });
      if (user.role !== 'admin') return jsonResponse(403, { error: 'Admin access required.' });
      const settings = await getSettings(db);
      const sales = await pollLightspeedSales(settings);
      let newCount = 0;
      for (const sale of sales) {
        const { isNew } = await saveOrder(db, sale);
        if (isNew) newCount++;
      }
      return jsonResponse(200, { synced_count: sales.length, new_count: newCount });
    }

    if (path === '/api/orders/clear') {
      await clearAllOrders(db);
      return jsonResponse(200, { status: 'cleared' });
    }

    if (path === '/api/auth/login') {
      const authRes = await authenticateUser(db, data.username, data.password);
      if (!authRes) {
        return jsonResponse(401, { error: 'Invalid username or password.' });
      }
      return jsonResponse(200, authRes);
    }

    if (path === '/api/auth/logout') {
      const token = getAuthTokenFromRequest(request, url);
      await revokeSession(db, token);
      return jsonResponse(200, { status: 'logged_out' });
    }

    if (path === '/api/users') {
      const token = getAuthTokenFromRequest(request, url);
      const user = await getUserByToken(db, token);
      if (!user) return jsonResponse(401, { error: 'Authentication required.' });
      if (user.role !== 'admin') return jsonResponse(403, { error: 'Admin access required.' });
      const { user: created, error } = await createUser(db, data);
      if (error) return jsonResponse(400, { error });
      return jsonResponse(201, { user: created, users: await listUsers(db) });
    }

    if (path.startsWith('/api/users/') && path.endsWith('/delete')) {
      const token = getAuthTokenFromRequest(request, url);
      const user = await getUserByToken(db, token);
      if (!user) return jsonResponse(401, { error: 'Authentication required.' });
      if (user.role !== 'admin') return jsonResponse(403, { error: 'Admin access required.' });
      const parts = path.split('/');
      const targetId = parseInt(parts[3], 10);
      const { ok, error } = await deleteUser(db, targetId, user.id);
      if (!ok) return jsonResponse(400, { error });
      return jsonResponse(200, { status: 'deleted', users: await listUsers(db) });
    }

    if (path.startsWith('/api/users/') && path.endsWith('/password')) {
      const token = getAuthTokenFromRequest(request, url);
      const user = await getUserByToken(db, token);
      if (!user) return jsonResponse(401, { error: 'Authentication required.' });
      if (user.role !== 'admin') return jsonResponse(403, { error: 'Admin access required.' });
      const parts = path.split('/');
      const targetId = parseInt(parts[3], 10);
      const { ok, error } = await updateUserPassword(db, targetId, data.password || '');
      if (!ok) return jsonResponse(400, { error });
      return jsonResponse(200, { status: 'password_updated' });
    }
  }

  return jsonResponse(404, { error: 'Endpoint not found' });
}
