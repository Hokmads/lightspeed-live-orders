"""
Database module for Lightspeed Live Orders.
Uses SQLite with Write-Ahead Logging (WAL) for safe multi-threaded concurrency.
"""

import sqlite3
import json
import os
import datetime
import hashlib
import secrets

DB_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'orders.db')

def get_connection():
    conn = sqlite3.connect(DB_FILE, timeout=20.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("PRAGMA journal_mode=WAL;")
    cursor.execute("PRAGMA synchronous=NORMAL;")
    
    # Orders table
    cursor.execute("""
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
    """)

    # Migration for existing databases
    try:
        cursor.execute("ALTER TABLE orders ADD COLUMN synced_to_lightspeed INTEGER DEFAULT 0;")
    except sqlite3.OperationalError:
        pass

    # Order items table
    cursor.execute("""
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
        synced_to_lightspeed INTEGER DEFAULT 0,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
    );
    """)

    # Migration for order_items table
    try:
        cursor.execute("ALTER TABLE order_items ADD COLUMN quantity_made INTEGER DEFAULT 0;")
    except sqlite3.OperationalError:
        pass
    try:
        cursor.execute("ALTER TABLE order_items ADD COLUMN status TEXT DEFAULT 'pending';")
    except sqlite3.OperationalError:
        pass
    try:
        cursor.execute("ALTER TABLE order_items ADD COLUMN synced_to_lightspeed INTEGER DEFAULT 0;")
    except sqlite3.OperationalError:
        pass

    cursor.execute("UPDATE order_items SET quantity_made = quantity WHERE status = 'made' AND (quantity_made IS NULL OR quantity_made = 0);")
    cursor.execute("UPDATE order_items SET quantity_made = 0 WHERE status = 'pending' AND quantity_made IS NULL;")

    # Settings table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
    );
    """)

    # Insert default settings if not exists
    default_settings = {
        'lightspeed_platform': 'r_series',  # 'r_series', 'x_series', 'restaurant', 'webhook_only'
        'api_token': '',
        'account_id': '',
        'domain_prefix': '',
        'webhook_secret': '',
        'polling_enabled': 'false',
        'polling_interval': '15',
        'sound_enabled': 'true',
        'last_sync_timestamp': ''
    }

    for key, value in default_settings.items():
        cursor.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?);", (key, value))

    # Users table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'staff',
        created_at TEXT
    );
    """)

    # Sessions table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        username TEXT NOT NULL,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    """)

    # Ensure default admin account exists
    cursor.execute("SELECT COUNT(*) as cnt FROM users WHERE role = 'admin';")
    admin_cnt = cursor.fetchone()['cnt']
    if admin_cnt == 0:
        now_iso = datetime.datetime.utcnow().isoformat() + "Z"
        default_hash = hash_password('admin123')
        cursor.execute("""
        INSERT OR IGNORE INTO users (username, display_name, password_hash, role, created_at)
        VALUES (?, ?, ?, 'admin', ?);
        """, ('admin', 'Administrator', default_hash, now_iso))

    conn.commit()
    conn.close()

def get_settings():
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT key, value FROM settings;")
    rows = cursor.fetchall()
    conn.close()
    return {row['key']: row['value'] for row in rows}

def update_settings(settings_dict):
    conn = get_connection()
    cursor = conn.cursor()
    for key, value in settings_dict.items():
        cursor.execute("""
        INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value;
        """, (key, str(value)))
    conn.commit()
    conn.close()

def save_order(order_data):
    """
    Saves or updates an order and its line items.
    Returns (order_dict, is_new: bool).
    """
    conn = get_connection()
    cursor = conn.cursor()

    order_id = str(order_data.get('id') or order_data.get('lightspeed_id'))
    now_iso = datetime.datetime.utcnow().isoformat() + "Z"
    created_at = order_data.get('created_at') or now_iso
    updated_at = now_iso

    # Check if order already exists
    cursor.execute("SELECT id, status FROM orders WHERE id = ? OR lightspeed_id = ?", 
                   (order_id, str(order_data.get('lightspeed_id', ''))))
    existing = cursor.fetchone()
    is_new = existing is None

    status = order_data.get('status')
    if not status:
        status = existing['status'] if existing else 'new'

    raw_payload_str = json.dumps(order_data.get('raw_payload', {})) if isinstance(order_data.get('raw_payload'), dict) else str(order_data.get('raw_payload') or '')

    if is_new:
        cursor.execute("""
        INSERT INTO orders (
            id, lightspeed_id, order_number, source, status,
            customer_name, customer_email, customer_phone,
            order_type, subtotal, tax, total, currency,
            payment_status, payment_method, notes, created_at, updated_at, raw_payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
        """, (
            order_id,
            str(order_data.get('lightspeed_id') or order_id),
            str(order_data.get('order_number') or order_id),
            order_data.get('source', 'lightspeed'),
            status,
            order_data.get('customer_name', 'Walk-in Customer'),
            order_data.get('customer_email', ''),
            order_data.get('customer_phone', ''),
            order_data.get('order_type', 'In-Store'),
            float(order_data.get('subtotal', 0.0)),
            float(order_data.get('tax', 0.0)),
            float(order_data.get('total', 0.0)),
            order_data.get('currency', 'USD'),
            order_data.get('payment_status', 'Paid'),
            order_data.get('payment_method', 'Credit Card'),
            order_data.get('notes', ''),
            created_at,
            updated_at,
            raw_payload_str
        ))
    else:
        # Preserve custom status if updated manually unless specified
        cursor.execute("""
        UPDATE orders SET
            order_number = COALESCE(?, order_number),
            subtotal = ?,
            tax = ?,
            total = ?,
            payment_status = ?,
            payment_method = ?,
            updated_at = ?,
            raw_payload = ?
        WHERE id = ?;
        """, (
            order_data.get('order_number'),
            float(order_data.get('subtotal', 0.0)),
            float(order_data.get('tax', 0.0)),
            float(order_data.get('total', 0.0)),
            order_data.get('payment_status', 'Paid'),
            order_data.get('payment_method', 'Credit Card'),
            updated_at,
            raw_payload_str,
            order_id
        ))

    # Save items
    items = order_data.get('items', [])
    if items:
        cursor.execute("SELECT name, status, synced_to_lightspeed, quantity_made FROM order_items WHERE order_id = ?", (order_id,))
        existing_item_map = {r['name']: (r['status'], r['synced_to_lightspeed'], r['quantity_made']) for r in cursor.fetchall()}

        cursor.execute("DELETE FROM order_items WHERE order_id = ?", (order_id,))
        for item in items:
            name = item.get('name', 'Item')
            prev_status, prev_synced, prev_made = existing_item_map.get(name, ('pending', 0, 0))
            item_status = item.get('status') or prev_status or 'pending'
            synced = item.get('synced_to_lightspeed', prev_synced) or 0
            qty_made = item.get('quantity_made', prev_made) or 0
            cursor.execute("""
            INSERT INTO order_items (
                order_id, name, sku, quantity, quantity_made, unit_price, total_price, modifiers, status, synced_to_lightspeed
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
            """, (
                order_id,
                name,
                item.get('sku', ''),
                int(item.get('quantity', 1)),
                int(qty_made),
                float(item.get('unit_price', 0.0)),
                float(item.get('total_price', 0.0)),
                item.get('modifiers', ''),
                item_status,
                synced
            ))

    conn.commit()
    conn.close()

    full_order = get_order_by_id(order_id)
    return full_order, is_new

def update_order_status(order_id, new_status, synced_to_lightspeed=None):
    now_iso = datetime.datetime.utcnow().isoformat() + "Z"
    conn = get_connection()
    cursor = conn.cursor()
    if synced_to_lightspeed is not None:
        cursor.execute("UPDATE orders SET status = ?, synced_to_lightspeed = ?, updated_at = ? WHERE id = ?;", 
                       (new_status, 1 if synced_to_lightspeed else 0, now_iso, order_id))
    else:
        cursor.execute("UPDATE orders SET status = ?, updated_at = ? WHERE id = ?;", (new_status, now_iso, order_id))

    if new_status in ('ready', 'completed'):
        if synced_to_lightspeed is not None:
            cursor.execute("UPDATE order_items SET status = 'made', quantity_made = quantity, synced_to_lightspeed = ? WHERE order_id = ? AND status != 'made';", 
                           (1 if synced_to_lightspeed else 0, order_id))
        else:
            cursor.execute("UPDATE order_items SET status = 'made', quantity_made = quantity WHERE order_id = ? AND status != 'made';", 
                           (order_id,))
    elif new_status == 'new':
        cursor.execute("UPDATE order_items SET status = 'pending', quantity_made = 0 WHERE order_id = ?;", (order_id,))

    conn.commit()
    conn.close()
    return get_order_by_id(order_id)

def update_item_status(item_id, new_status=None, synced_to_lightspeed=None, quantity_delta=None, count=None):
    """
    Updates the status or made count of an individual line item.
    - If count is passed: sets quantity_made = count
    - If quantity_delta is passed (e.g. +1 or -1): adjusts quantity_made by that delta
    - If new_status == 'made': marks fully made (quantity_made = quantity)
    - If new_status == 'pending': marks pending (quantity_made = 0)
    If all items in the order become made, automatically marks the parent order as 'ready'!
    """
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT id, order_id, quantity, COALESCE(quantity_made, 0) as quantity_made, status, synced_to_lightspeed FROM order_items WHERE id = ?;", (item_id,))
    row = cursor.fetchone()
    if not row:
        conn.close()
        return None

    order_id = row['order_id']
    qty = row['quantity']
    current_made = row['quantity_made']

    if count is not None:
        new_made = max(0, min(qty, int(count)))
    elif quantity_delta is not None:
        new_made = max(0, min(qty, current_made + int(quantity_delta)))
    elif new_status == 'made':
        new_made = qty
    elif new_status == 'pending':
        new_made = 0
    else:
        new_made = current_made

    if new_made >= qty:
        computed_status = 'made'
    elif new_made > 0:
        computed_status = 'partially_made'
    else:
        computed_status = 'pending'

    final_status = new_status if (new_status in ('made', 'pending') and count is None and quantity_delta is None) else computed_status

    if synced_to_lightspeed is not None:
        cursor.execute("UPDATE order_items SET status = ?, quantity_made = ?, synced_to_lightspeed = ? WHERE id = ?;", 
                       (final_status, new_made, 1 if synced_to_lightspeed else 0, item_id))
    else:
        cursor.execute("UPDATE order_items SET status = ?, quantity_made = ? WHERE id = ?;", 
                       (final_status, new_made, item_id))

    # Check order auto-transitions
    now_iso = datetime.datetime.utcnow().isoformat() + "Z"
    if order_id:
        cursor.execute("SELECT COUNT(*) as pending_count FROM order_items WHERE order_id = ? AND status != 'made';", (order_id,))
        pending = cursor.fetchone()['pending_count']
        if pending == 0:
            cursor.execute("UPDATE orders SET status = 'ready', updated_at = ? WHERE id = ? AND status IN ('new', 'in_progress');", (now_iso, order_id))
        else:
            cursor.execute("UPDATE orders SET status = 'in_progress', updated_at = ? WHERE id = ? AND status = 'ready';", (now_iso, order_id))

    conn.commit()
    conn.close()
    return get_order_by_id(order_id) if order_id else None

def update_items_by_name(item_name, count_to_mark=None, new_status='made', synced_to_lightspeed=None):
    """
    Batch updates units of an item across active orders.
    - If count_to_mark is None: marks ALL pending units of item_name as made (or pending if new_status=='pending')
    - If count_to_mark is an integer (e.g. 1, 2, 3...): marks that exact number of units as made (FIFO across active orders),
      or unmarks that many units if new_status=='pending' (LIFO).
    """
    conn = get_connection()
    cursor = conn.cursor()
    affected_order_ids = set()

    if new_status == 'pending':
        # Reopen / undo (LIFO: newest made first)
        cursor.execute("""
            SELECT oi.id, oi.order_id, oi.quantity, COALESCE(oi.quantity_made, 0) as quantity_made
            FROM order_items oi
            JOIN orders o ON oi.order_id = o.id
            WHERE oi.name = ? AND o.status IN ('new', 'in_progress', 'ready') AND COALESCE(oi.quantity_made, 0) > 0
            ORDER BY o.created_at DESC, oi.id DESC;
        """, (item_name,))
        rows = cursor.fetchall()
        remaining = int(count_to_mark) if count_to_mark is not None else 999999

        for r in rows:
            if remaining <= 0:
                break
            q_made = r['quantity_made']
            reduce_by = min(q_made, remaining)
            new_made = q_made - reduce_by
            st = 'pending' if new_made == 0 else 'partially_made'
            if synced_to_lightspeed is not None:
                cursor.execute("UPDATE order_items SET status = ?, quantity_made = ?, synced_to_lightspeed = ? WHERE id = ?;", 
                               (st, new_made, 1 if synced_to_lightspeed else 0, r['id']))
            else:
                cursor.execute("UPDATE order_items SET status = ?, quantity_made = ? WHERE id = ?;", 
                               (st, new_made, r['id']))
            affected_order_ids.add(r['order_id'])
            remaining -= reduce_by

    else:
        # Mark made (FIFO: oldest orders first)
        cursor.execute("""
            SELECT oi.id, oi.order_id, oi.quantity, COALESCE(oi.quantity_made, 0) as quantity_made
            FROM order_items oi
            JOIN orders o ON oi.order_id = o.id
            WHERE oi.name = ? AND o.status IN ('new', 'in_progress') AND (oi.quantity - COALESCE(oi.quantity_made, 0)) > 0
            ORDER BY o.created_at ASC, oi.id ASC;
        """, (item_name,))
        rows = cursor.fetchall()
        remaining = int(count_to_mark) if count_to_mark is not None else 999999

        for r in rows:
            if remaining <= 0:
                break
            needed = r['quantity'] - r['quantity_made']
            add_by = min(needed, remaining)
            new_made = r['quantity_made'] + add_by
            st = 'made' if new_made >= r['quantity'] else 'partially_made'
            if synced_to_lightspeed is not None:
                cursor.execute("UPDATE order_items SET status = ?, quantity_made = ?, synced_to_lightspeed = ? WHERE id = ?;", 
                               (st, new_made, 1 if synced_to_lightspeed else 0, r['id']))
            else:
                cursor.execute("UPDATE order_items SET status = ?, quantity_made = ? WHERE id = ?;", 
                               (st, new_made, r['id']))
            affected_order_ids.add(r['order_id'])
            remaining -= add_by

    # Check auto-ready / in_progress transitions for affected orders
    now_iso = datetime.datetime.utcnow().isoformat() + "Z"
    for o_id in affected_order_ids:
        cursor.execute("SELECT COUNT(*) as pending_count FROM order_items WHERE order_id = ? AND status != 'made';", (o_id,))
        if cursor.fetchone()['pending_count'] == 0:
            cursor.execute("UPDATE orders SET status = 'ready', updated_at = ? WHERE id = ? AND status IN ('new', 'in_progress');", (now_iso, o_id))
        else:
            cursor.execute("UPDATE orders SET status = 'in_progress', updated_at = ? WHERE id = ? AND status = 'ready';", (now_iso, o_id))

    conn.commit()
    conn.close()

def get_detailed_queue_items():
    """
    Returns detailed grouped pending items for the Kitchen Items Queue Station Tab.
    """
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
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
    """)
    rows = cursor.fetchall()
    conn.close()

    grouped = {}
    for r in rows:
        row_dict = dict(r)
        name = row_dict['name']
        if name not in grouped:
            grouped[name] = {
                'name': name,
                'sku': row_dict['sku'] or '',
                'total_quantity': 0,
                'pending_quantity': 0,
                'made_quantity': 0,
                'order_lines': []
            }
        qty = int(row_dict['quantity'])
        qty_made = min(qty, int(row_dict['quantity_made']))
        qty_pending = max(0, qty - qty_made)

        grouped[name]['total_quantity'] += qty
        grouped[name]['made_quantity'] += qty_made
        grouped[name]['pending_quantity'] += qty_pending

        row_dict['line_made_quantity'] = qty_made
        row_dict['line_pending_quantity'] = qty_pending
        grouped[name]['order_lines'].append(row_dict)

    # Sort so items with remaining pending quantity come first
    sorted_items = sorted(
        grouped.values(), 
        key=lambda x: (x['pending_quantity'] == 0, -x['pending_quantity'], x['name'])
    )
    return sorted_items

def get_active_queue_summary():
    """
    Returns aggregated items across all active orders ('new' and 'in_progress').
    Example: [{'name': 'Flat White', 'total_quantity': 4, 'order_count': 3}, ...]
    """
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT oi.name, oi.sku, SUM(oi.quantity - COALESCE(oi.quantity_made, 0)) as total_quantity, COUNT(DISTINCT o.id) as order_count
        FROM order_items oi
        JOIN orders o ON oi.order_id = o.id
        WHERE o.status IN ('new', 'in_progress') AND (oi.quantity - COALESCE(oi.quantity_made, 0)) > 0
        GROUP BY oi.name
        ORDER BY total_quantity DESC, oi.name ASC;
    """)
    rows = cursor.fetchall()
    conn.close()
    return [dict(r) for r in rows]

def update_order_notes(order_id, notes):
    now_iso = datetime.datetime.utcnow().isoformat() + "Z"
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("UPDATE orders SET notes = ?, updated_at = ? WHERE id = ?;", (notes, now_iso, order_id))
    conn.commit()
    conn.close()
    return get_order_by_id(order_id)

def get_order_by_id(order_id):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM orders WHERE id = ?;", (order_id,))
    order_row = cursor.fetchone()
    if not order_row:
        conn.close()
        return None

    order_dict = dict(order_row)
    cursor.execute("SELECT * FROM order_items WHERE order_id = ?;", (order_id,))
    items_rows = cursor.fetchall()
    order_dict['items'] = [dict(item) for item in items_rows]
    conn.close()
    return order_dict

def list_orders(status=None, search=None, limit=100):
    conn = get_connection()
    cursor = conn.cursor()
    query = "SELECT * FROM orders WHERE 1=1"
    params = []

    if status and status.lower() != 'all':
        query += " AND status = ?"
        params.append(status.lower())

    if search:
        query += " AND (id LIKE ? OR order_number LIKE ? OR customer_name LIKE ? OR customer_email LIKE ?)"
        term = f"%{search}%"
        params.extend([term, term, term, term])

    query += " ORDER BY created_at DESC LIMIT ?"
    params.append(limit)

    cursor.execute(query, params)
    order_rows = cursor.fetchall()

    orders = []
    for row in order_rows:
        order = dict(row)
        cursor.execute("SELECT * FROM order_items WHERE order_id = ?;", (order['id'],))
        order['items'] = [dict(item) for item in cursor.fetchall()]
        orders.append(order)

    conn.close()
    return orders

def get_stats():
    conn = get_connection()
    cursor = conn.cursor()
    today_start = datetime.datetime.utcnow().strftime('%Y-%m-%d') + "T00:00:00"

    cursor.execute("SELECT COUNT(*) as total_count, COALESCE(SUM(total), 0) as total_revenue FROM orders;")
    overall = cursor.fetchone()

    cursor.execute("SELECT COUNT(*) as count, COALESCE(SUM(total), 0) as revenue FROM orders WHERE created_at >= ?;", (today_start,))
    today = cursor.fetchone()

    cursor.execute("SELECT COUNT(*) as count FROM orders WHERE status = 'new';")
    pending = cursor.fetchone()

    cursor.execute("SELECT COUNT(*) as count FROM orders WHERE status = 'in_progress';")
    in_progress = cursor.fetchone()

    conn.close()
    return {
        'total_orders': overall['total_count'],
        'total_revenue': round(overall['total_revenue'], 2),
        'today_orders': today['count'],
        'today_revenue': round(today['revenue'], 2),
        'pending_orders': pending['count'],
        'in_progress_orders': in_progress['count']
    }

def clear_all_orders():
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM order_items;")
    cursor.execute("DELETE FROM orders;")
    conn.commit()
    conn.close()

# ============================================================================
# User & Session Authentication Functions
# ============================================================================

def hash_password(password, salt=None):
    if not salt:
        salt = secrets.token_hex(16)
    digest = hashlib.sha256(f"{salt}:{password}".encode('utf-8')).hexdigest()
    return f"{salt}${digest}"

def verify_password(password, stored_hash):
    if not stored_hash or '$' not in stored_hash:
        return False
    salt, expected_digest = stored_hash.split('$', 1)
    actual_digest = hashlib.sha256(f"{salt}:{password}".encode('utf-8')).hexdigest()
    return secrets.compare_digest(actual_digest, expected_digest)

def authenticate_user(username, password):
    conn = get_connection()
    cursor = conn.cursor()
    clean_user = (username or '').strip().lower()
    cursor.execute("SELECT * FROM users WHERE LOWER(username) = ?;", (clean_user,))
    row = cursor.fetchone()
    if not row or not verify_password(password or '', row['password_hash']):
        conn.close()
        return None

    token = secrets.token_hex(32)
    now_iso = datetime.datetime.utcnow().isoformat() + "Z"
    cursor.execute("""
    INSERT INTO sessions (token, user_id, username, display_name, role, created_at)
    VALUES (?, ?, ?, ?, ?, ?);
    """, (token, row['id'], row['username'], row['display_name'], row['role'], now_iso))
    conn.commit()
    conn.close()

    return {
        'token': token,
        'user': {
            'id': row['id'],
            'username': row['username'],
            'display_name': row['display_name'],
            'role': row['role']
        }
    }

def get_user_by_token(token):
    if not token:
        return None
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
    SELECT u.id, u.username, u.display_name, u.role
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.token = ?;
    """, (token,))
    row = cursor.fetchone()
    conn.close()
    if not row:
        return None
    return dict(row)

def revoke_session(token):
    if not token:
        return
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM sessions WHERE token = ?;", (token,))
    conn.commit()
    conn.close()

def list_users():
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT id, username, display_name, role, created_at FROM users ORDER BY id ASC;")
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()
    return rows

def create_user(username, password, display_name=None, role='staff'):
    clean_username = (username or '').strip().lower()
    if not clean_username or not password:
        return None, "Username and password are required."
    if len(password) < 4:
        return None, "Password must be at least 4 characters."
    clean_role = 'admin' if role == 'admin' else 'staff'
    clean_display = (display_name or clean_username).strip()
    now_iso = datetime.datetime.utcnow().isoformat() + "Z"
    pw_hash = hash_password(password)

    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT id FROM users WHERE LOWER(username) = ?;", (clean_username,))
    if cursor.fetchone():
        conn.close()
        return None, f"Username '{clean_username}' already exists."

    cursor.execute("""
    INSERT INTO users (username, display_name, password_hash, role, created_at)
    VALUES (?, ?, ?, ?, ?);
    """, (clean_username, clean_display, pw_hash, clean_role, now_iso))
    user_id = cursor.lastrowid
    conn.commit()
    conn.close()
    return {
        'id': user_id,
        'username': clean_username,
        'display_name': clean_display,
        'role': clean_role,
        'created_at': now_iso
    }, None

def update_user_password(user_id, new_password):
    if not new_password or len(new_password) < 4:
        return False, "Password must be at least 4 characters."
    pw_hash = hash_password(new_password)
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("UPDATE users SET password_hash = ? WHERE id = ?;", (pw_hash, int(user_id)))
    updated = cursor.rowcount > 0
    conn.commit()
    conn.close()
    if not updated:
        return False, "User not found."
    return True, None

def delete_user(user_id, requesting_user_id=None):
    target_id = int(user_id)
    if requesting_user_id is not None and int(requesting_user_id) == target_id:
        return False, "You cannot delete your own active account."
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT id, username, role FROM users WHERE id = ?;", (target_id,))
    target = cursor.fetchone()
    if not target:
        conn.close()
        return False, "User not found."
    if target['role'] == 'admin':
        cursor.execute("SELECT COUNT(*) as cnt FROM users WHERE role = 'admin';")
        if cursor.fetchone()['cnt'] <= 1:
            conn.close()
            return False, "Cannot delete the last admin account."
    cursor.execute("DELETE FROM sessions WHERE user_id = ?;", (target_id,))
    cursor.execute("DELETE FROM users WHERE id = ?;", (target_id,))
    conn.commit()
    conn.close()
    return True, None
