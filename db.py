"""
Database module for Lightspeed Live Orders.
Uses SQLite with Write-Ahead Logging (WAL) for safe multi-threaded concurrency.
"""

import sqlite3
import json
import os
import datetime

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
        created_at TEXT,
        updated_at TEXT,
        raw_payload TEXT
    );
    """)

    # Order items table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS order_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id TEXT NOT NULL,
        name TEXT NOT NULL,
        sku TEXT,
        quantity INTEGER DEFAULT 1,
        unit_price REAL DEFAULT 0.0,
        total_price REAL DEFAULT 0.0,
        modifiers TEXT,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
    );
    """)

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
        cursor.execute("DELETE FROM order_items WHERE order_id = ?", (order_id,))
        for item in items:
            cursor.execute("""
            INSERT INTO order_items (
                order_id, name, sku, quantity, unit_price, total_price, modifiers
            ) VALUES (?, ?, ?, ?, ?, ?, ?);
            """, (
                order_id,
                item.get('name', 'Item'),
                item.get('sku', ''),
                int(item.get('quantity', 1)),
                float(item.get('unit_price', 0.0)),
                float(item.get('total_price', 0.0)),
                item.get('modifiers', '')
            ))

    conn.commit()
    conn.close()

    full_order = get_order_by_id(order_id)
    return full_order, is_new

def update_order_status(order_id, new_status):
    now_iso = datetime.datetime.utcnow().isoformat() + "Z"
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("UPDATE orders SET status = ?, updated_at = ? WHERE id = ?;", (new_status, now_iso, order_id))
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
