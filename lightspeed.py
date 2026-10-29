"""
Lightspeed API integration and webhook normalization module.
Supports:
1. Lightspeed Retail (R-Series / MerchantOS API)
2. Lightspeed Retail (X-Series / Vend API)
3. Lightspeed Restaurant (K-Series)
4. Webhook payload ingestion and normalization
5. Realistic order simulation for live testing
"""

import json
import urllib.request
import urllib.error
import ssl
import datetime
import random
import uuid

# Helper to normalize timestamps to ISO format
def parse_date(date_str):
    if not date_str:
        return datetime.datetime.utcnow().isoformat() + "Z"
    try:
        # Check standard formats
        for fmt in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%d %H:%M:%S"):
            try:
                dt = datetime.datetime.strptime(date_str.replace("+00:00", "Z"), fmt)
                return dt.isoformat() + "Z"
            except ValueError:
                continue
    except Exception:
        pass
    return str(date_str)

def normalize_r_series_sale(sale):
    """
    Normalizes a Lightspeed Retail (R-Series) Sale object into standard order dict.
    """
    sale_id = str(sale.get('saleID') or sale.get('SaleID') or sale.get('id', ''))
    order_num = str(sale.get('calcReceiptNumber') or sale.get('ticketNumber') or f"LS-{sale_id}")
    
    # Customer
    cust = sale.get('Customer') or {}
    first_name = cust.get('firstName', '')
    last_name = cust.get('lastName', '')
    cust_name = f"{first_name} {last_name}".strip() or "Walk-in Customer"
    cust_email = ""
    contact = cust.get('Contact') or {}
    emails = contact.get('Emails', {}).get('ContactEmail', [])
    if isinstance(emails, list) and emails:
        cust_email = emails[0].get('address', '')
    elif isinstance(emails, dict):
        cust_email = emails.get('address', '')
    phone = ""
    phones = contact.get('Phones', {}).get('ContactPhone', [])
    if isinstance(phones, list) and phones:
        phone = phones[0].get('number', '')
    elif isinstance(phones, dict):
        phone = phones.get('number', '')

    # Amounts
    total = float(sale.get('total') or sale.get('calcTotal') or 0.0)
    subtotal = float(sale.get('calcSubtotal') or 0.0)
    tax = float(sale.get('taxTotal') or sale.get('calcTax1', 0.0) or 0.0)
    if subtotal == 0.0 and total > 0.0:
        subtotal = round(total - tax, 2)

    # Line items
    items = []
    lines = sale.get('SaleLines', {}).get('SaleLine', [])
    if isinstance(lines, dict):
        lines = [lines]
    for line in lines:
        item_obj = line.get('Item') or {}
        name = item_obj.get('description') or line.get('description') or 'Item'
        sku = item_obj.get('customSku') or item_obj.get('systemSku') or ''
        qty = int(float(line.get('unitQuantity') or 1))
        unit_price = float(line.get('unitPrice') or 0.0)
        tot_price = float(line.get('calcTotal') or (qty * unit_price))
        note = line.get('note') or ''
        items.append({
            'name': name,
            'sku': sku,
            'quantity': qty,
            'unit_price': unit_price,
            'total_price': tot_price,
            'modifiers': note
        })

    # Payment
    payments = sale.get('SalePayments', {}).get('SalePayment', [])
    if isinstance(payments, dict):
        payments = [payments]
    payment_method = 'Credit Card'
    if payments:
        p_type = payments[0].get('PaymentType') or {}
        payment_method = p_type.get('name') or 'Credit Card'

    # Order type
    order_type = 'In-Store'
    if sale.get('shipTo'):
        order_type = 'Delivery'
    elif 'pickup' in (sale.get('displayStatus') or '').lower():
        order_type = 'Takeaway'

    return {
        'id': f"R-{sale_id}",
        'lightspeed_id': sale_id,
        'order_number': order_num,
        'source': 'lightspeed_r_series',
        'status': 'new',
        'customer_name': cust_name,
        'customer_email': cust_email,
        'customer_phone': phone,
        'order_type': order_type,
        'subtotal': subtotal,
        'tax': tax,
        'total': total,
        'currency': 'USD',
        'payment_status': 'Paid' if float(sale.get('calcBalance', 0.0)) <= 0 else 'Pending',
        'payment_method': payment_method,
        'notes': sale.get('note') or '',
        'created_at': parse_date(sale.get('timeStamp') or sale.get('createTime')),
        'items': items,
        'raw_payload': sale
    }

def normalize_x_series_sale(sale):
    """
    Normalizes a Lightspeed Retail (X-Series / Vend) Sale object into standard order dict.
    """
    sale_id = str(sale.get('id', ''))
    order_num = str(sale.get('invoice_number') or sale.get('sequence_number') or f"VD-{sale_id[:8]}")

    cust = sale.get('customer') or {}
    cust_name = cust.get('name') or f"{cust.get('first_name', '')} {cust.get('last_name', '')}".strip() or "Customer"
    cust_email = cust.get('email', '')
    cust_phone = cust.get('phone', '')

    total = float(sale.get('total_price') or sale.get('total') or 0.0)
    tax = float(sale.get('total_tax') or 0.0)
    subtotal = round(total - tax, 2)

    items = []
    line_items = sale.get('line_items') or sale.get('register_sale_products') or []
    for line in line_items:
        items.append({
            'name': line.get('name') or line.get('product_name') or 'Item',
            'sku': line.get('sku') or '',
            'quantity': int(float(line.get('quantity') or 1)),
            'unit_price': float(line.get('price') or line.get('unit_price') or 0.0),
            'total_price': float(line.get('total_price') or 0.0),
            'modifiers': line.get('notes') or ''
        })

    payments = sale.get('payments') or []
    payment_method = 'Credit Card'
    if payments:
        payment_method = payments[0].get('name') or payments[0].get('payment_type_name') or 'Credit Card'

    return {
        'id': f"X-{sale_id}",
        'lightspeed_id': sale_id,
        'order_number': order_num,
        'source': 'lightspeed_x_series',
        'status': 'new',
        'customer_name': cust_name,
        'customer_email': cust_email,
        'customer_phone': cust_phone,
        'order_type': 'In-Store',
        'subtotal': subtotal,
        'tax': tax,
        'total': total,
        'currency': sale.get('currency', 'USD'),
        'payment_status': 'Paid' if sale.get('status') in ('SAVED', 'CLOSED') else 'Pending',
        'payment_method': payment_method,
        'notes': sale.get('note') or '',
        'created_at': parse_date(sale.get('created_at') or sale.get('sale_date')),
        'items': items,
        'raw_payload': sale
    }

def normalize_webhook_payload(payload):
    """
    Intelligently parses incoming webhooks from Lightspeed Retail or Restaurant.
    """
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except Exception:
            payload = {}

    # Check for wrapped events e.g. {"event": "sale.create", "data": {...}}
    inner = payload.get('payload') or payload.get('data') or payload.get('Sale') or payload

    # If it has saleID or SaleLines -> R-Series
    if 'saleID' in inner or 'SaleLines' in inner or 'calcTotal' in inner:
        return normalize_r_series_sale(inner)

    # If it has invoice_number or line_items or register_id -> X-Series
    if 'invoice_number' in inner or 'line_items' in inner or 'register_sale_products' in inner:
        return normalize_x_series_sale(inner)

    # Generic fallback normalization
    order_id = str(inner.get('id') or inner.get('order_id') or inner.get('sale_id') or f"WH-{uuid.uuid4().hex[:8]}")
    order_number = str(inner.get('order_number') or inner.get('number') or f"#{order_id[-6:]}")
    
    total = float(inner.get('total') or inner.get('total_price') or inner.get('amount') or 0.0)
    tax = float(inner.get('tax') or inner.get('total_tax') or 0.0)
    subtotal = float(inner.get('subtotal') or (total - tax))

    items = []
    raw_items = inner.get('items') or inner.get('line_items') or inner.get('products') or []
    for item in raw_items:
        items.append({
            'name': item.get('name') or item.get('title') or 'Item',
            'sku': item.get('sku') or '',
            'quantity': int(item.get('quantity') or 1),
            'unit_price': float(item.get('unit_price') or item.get('price') or 0.0),
            'total_price': float(item.get('total_price') or 0.0),
            'modifiers': str(item.get('modifiers') or '')
        })

    if not items:
        items.append({
            'name': 'Lightspeed Order Item',
            'sku': 'LS-GEN-01',
            'quantity': 1,
            'unit_price': total,
            'total_price': total,
            'modifiers': ''
        })

    return {
        'id': f"GEN-{order_id}",
        'lightspeed_id': order_id,
        'order_number': order_number,
        'source': 'lightspeed_webhook',
        'status': 'new',
        'customer_name': inner.get('customer_name') or inner.get('customer', {}).get('name') or "Customer",
        'customer_email': inner.get('customer_email') or inner.get('customer', {}).get('email') or "",
        'customer_phone': inner.get('customer_phone') or inner.get('customer', {}).get('phone') or "",
        'order_type': inner.get('order_type') or 'In-Store',
        'subtotal': subtotal,
        'tax': tax,
        'total': total,
        'currency': inner.get('currency', 'USD'),
        'payment_status': inner.get('payment_status', 'Paid'),
        'payment_method': inner.get('payment_method', 'Credit Card'),
        'notes': inner.get('notes', ''),
        'created_at': parse_date(inner.get('created_at')),
        'items': items,
        'raw_payload': payload
    }

def test_api_connection(settings):
    """
    Tests live API connectivity to Lightspeed using provided credentials.
    Returns (success: bool, message: str).
    """
    platform = settings.get('lightspeed_platform', 'r_series')
    api_token = settings.get('api_token', '').strip()
    account_id = settings.get('account_id', '').strip()
    domain_prefix = settings.get('domain_prefix', '').strip()

    if not api_token:
        return False, "API Token is required."

    headers = {
        'Authorization': f"Bearer {api_token}",
        'Accept': 'application/json',
        'User-Agent': 'LightspeedLiveOrdersDashboard/1.0'
    }

    ctx = ssl.create_default_context()

    try:
        if platform == 'r_series':
            if not account_id:
                return False, "Account ID is required for Lightspeed R-Series."
            url = f"https://api.lightspeedapp.com/API/Account/{account_id}/Sale.json?limit=1"
        elif platform == 'x_series':
            if not domain_prefix:
                return False, "Domain Prefix (Store Name) is required for Lightspeed X-Series."
            url = f"https://{domain_prefix}.vendhq.com/api/2.0/sales?page_size=1"
        else:
            return True, "Webhook mode: Ready to accept incoming Webhook events."

        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=10, context=ctx) as response:
            if response.status in (200, 201):
                return True, f"Successfully connected to Lightspeed ({platform.upper()})!"
            else:
                return False, f"HTTP {response.status}: {response.read().decode('utf-8')[:100]}"
    except urllib.error.HTTPError as e:
        error_msg = e.read().decode('utf-8', errors='ignore')[:150]
        return False, f"Lightspeed API Error ({e.code}): {error_msg or e.reason}"
    except urllib.error.URLError as e:
        return False, f"Network/Connection error: {str(e.reason)}"
    except Exception as e:
        return False, f"Unexpected error: {str(e)}"

def poll_lightspeed_sales(settings, since_timestamp=None):
    """
    Queries Lightspeed for sales created/updated since timestamp.
    Returns list of normalized order dicts.
    """
    platform = settings.get('lightspeed_platform', 'r_series')
    api_token = settings.get('api_token', '').strip()
    account_id = settings.get('account_id', '').strip()
    domain_prefix = settings.get('domain_prefix', '').strip()

    if not api_token:
        return []

    headers = {
        'Authorization': f"Bearer {api_token}",
        'Accept': 'application/json',
        'User-Agent': 'LightspeedLiveOrdersDashboard/1.0'
    }

    ctx = ssl.create_default_context()
    normalized_orders = []

    try:
        if platform == 'r_series' and account_id:
            # Query Lightspeed Retail (R-Series)
            url = f"https://api.lightspeedapp.com/API/Account/{account_id}/Sale.json?limit=50&load_relations=%5B%22Customer%22%2C%22SaleLines%22%2C%22SaleLines.Item%22%2C%22SalePayments%22%5D"
            if since_timestamp:
                url += f"&timeStamp=%3E,{since_timestamp}"
            else:
                # Default to orders from the last hour or recent 20
                url += "&sort=-timeStamp"

            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=15, context=ctx) as response:
                data = json.loads(response.read().decode('utf-8'))
                sales = data.get('Sale', [])
                if isinstance(sales, dict):
                    sales = [sales]
                for sale in sales:
                    normalized_orders.append(normalize_r_series_sale(sale))

        elif platform == 'x_series' and domain_prefix:
            # Query Lightspeed Retail (X-Series / Vend)
            url = f"https://{domain_prefix}.vendhq.com/api/2.0/sales?page_size=50&order_by=created_at&order_direction=desc"
            if since_timestamp:
                url += f"&since={since_timestamp}"

            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=15, context=ctx) as response:
                data = json.loads(response.read().decode('utf-8'))
                sales = data.get('data', [])
                for sale in sales:
                    normalized_orders.append(normalize_x_series_sale(sale))

    except Exception as e:
        print(f"[Lightspeed Poller] Error fetching sales: {e}")

    return normalized_orders

def generate_mock_order():
    """
    Generates a realistic Lightspeed POS order for live testing, demonstration,
    and UI verification.
    """
    menu_items = [
        {"name": "Flat White (Oat Milk)", "sku": "BEV-001", "price": 4.75, "mod": "Extra hot, 1 pump vanilla"},
        {"name": "Cold Brew Reserve", "sku": "BEV-002", "price": 5.25, "mod": "Light ice"},
        {"name": "Avocado Sourdough Toast", "sku": "FD-101", "price": 12.50, "mod": "Poached egg, chili flakes"},
        {"name": "Almond Butter Croissant", "sku": "BAK-201", "price": 4.50, "mod": "Warmed"},
        {"name": "Acai Energy Bowl", "sku": "FD-102", "price": 11.00, "mod": "Extra chia seeds"},
        {"name": "Smoked Salmon Bagel", "sku": "FD-103", "price": 13.50, "mod": "Capers on the side"},
        {"name": "Iced Ceremonial Matcha", "sku": "BEV-003", "price": 6.00, "mod": "Sweetened with honey"},
        {"name": "Artisan Ceramic Tumbler", "sku": "RET-301", "price": 24.00, "mod": "Gift wrapped"},
        {"name": "Truffle Mushroom Panini", "sku": "FD-104", "price": 14.00, "mod": "Gluten-free bread"}
    ]

    customers = [
        {"name": "Sophia Reynolds", "email": "sophia.r@example.com", "phone": "(555) 234-5678"},
        {"name": "Marcus Vance", "email": "m.vance@example.com", "phone": "(555) 876-5432"},
        {"name": "Elena Rostova", "email": "elena.rostova@example.com", "phone": "(555) 345-9876"},
        {"name": "David Chen", "email": "dchen@example.com", "phone": "(555) 654-3210"},
        {"name": "Chloe Dupont", "email": "chloe.d@example.com", "phone": "(555) 987-1234"},
        {"name": "Liam Gallagher", "email": "liam.g@example.com", "phone": "(555) 432-8765"}
    ]

    order_types = ["In-Store", "Takeaway", "Dine-In", "Delivery", "Online"]
    payment_methods = ["Apple Pay", "Visa Contactless", "Mastercard", "Cash", "Gift Card"]

    order_num = f"LS-{random.randint(10000, 99999)}"
    cust = random.choice(customers)
    selected_items_pool = random.sample(menu_items, k=random.randint(1, 3))
    
    order_items = []
    subtotal = 0.0
    for it in selected_items_pool:
        qty = random.randint(1, 2)
        total_price = round(qty * it["price"], 2)
        subtotal += total_price
        order_items.append({
            "name": it["name"],
            "sku": it["sku"],
            "quantity": qty,
            "unit_price": it["price"],
            "total_price": total_price,
            "modifiers": it["mod"] if random.random() > 0.3 else ""
        })

    tax_rate = 0.08875  # ~8.875% tax
    tax = round(subtotal * tax_rate, 2)
    total = round(subtotal + tax, 2)
    now_iso = datetime.datetime.utcnow().isoformat() + "Z"

    return {
        "id": f"SIM-{order_num}",
        "lightspeed_id": order_num,
        "order_number": order_num,
        "source": "simulator",
        "status": "new",
        "customer_name": cust["name"],
        "customer_email": cust["email"],
        "customer_phone": cust["phone"],
        "order_type": random.choice(order_types),
        "subtotal": round(subtotal, 2),
        "tax": tax,
        "total": total,
        "currency": "USD",
        "payment_status": "Paid",
        "payment_method": random.choice(payment_methods),
        "notes": "Fast pickup requested" if random.random() > 0.6 else "",
        "created_at": now_iso,
        "items": order_items,
        "raw_payload": {"simulated": True, "generated_at": now_iso}
    }

def update_lightspeed_sale_status(settings, lightspeed_id, new_status):
    """
    Calls the Lightspeed API to update an order/sale status on Lightspeed's side.
    If no API token is configured, or if it is a simulated order, operates in simulation mode.
    Returns (success: bool, message: str, simulated: bool).
    """
    platform = settings.get('lightspeed_platform', 'r_series')
    api_token = settings.get('api_token', '').strip()
    account_id = settings.get('account_id', '').strip()
    domain_prefix = settings.get('domain_prefix', '').strip()

    clean_id = str(lightspeed_id).replace('R-', '').replace('X-', '').replace('SIM-', '').replace('GEN-', '')

    if not api_token or 'SIM' in str(lightspeed_id):
        return True, f"Simulated Lightspeed API call: marked #{clean_id} as '{new_status}'", True

    headers = {
        'Authorization': f"Bearer {api_token}",
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'LightspeedLiveOrdersDashboard/1.0'
    }

    ctx = ssl.create_default_context()

    try:
        if platform == 'r_series' and account_id:
            url = f"https://api.lightspeedapp.com/API/Account/{account_id}/Sale/{clean_id}.json"
            payload = json.dumps({
                "completed": True if new_status in ('ready', 'completed') else False,
                "note": f"Order status updated to {new_status.upper()}"
            }).encode('utf-8')
            req = urllib.request.Request(url, data=payload, headers=headers, method='PUT')
            with urllib.request.urlopen(req, timeout=10, context=ctx) as response:
                return True, f"Successfully marked #{clean_id} as '{new_status}' via Lightspeed R-Series API", False

        elif platform == 'x_series' and domain_prefix:
            url = f"https://{domain_prefix}.vendhq.com/api/2.0/sales/{clean_id}"
            payload = json.dumps({
                "status": "CLOSED" if new_status == 'completed' else "SAVED",
                "note": f"Order marked as {new_status.upper()}"
            }).encode('utf-8')
            req = urllib.request.Request(url, data=payload, headers=headers, method='PUT')
            with urllib.request.urlopen(req, timeout=10, context=ctx) as response:
                return True, f"Successfully marked #{clean_id} as '{new_status}' via Lightspeed X-Series API", False

        return True, f"Marked #{clean_id} as '{new_status}'", True

    except urllib.error.HTTPError as e:
        err_msg = e.read().decode('utf-8', errors='ignore')[:150]
        return False, f"Lightspeed API Error ({e.code}): {err_msg or e.reason}", False
    except Exception as e:
        return False, f"Failed to sync with Lightspeed API: {str(e)}", False
