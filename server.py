"""
Multi-threaded HTTP & Real-time Server-Sent Events (SSE) server for Lightspeed Live Orders.
Zero external dependencies - runs on macOS / Linux standard Python 3.
"""

import http.server
import socketserver
import json
import urllib.parse
import os
import sys
import threading
import time
import queue

from db import (
    init_db, get_settings, update_settings, save_order,
    update_order_status, update_order_notes, get_order_by_id, list_orders,
    get_stats, clear_all_orders, get_active_queue_summary,
    get_detailed_queue_items, update_item_status, update_items_by_name
)
from lightspeed import (
    normalize_webhook_payload, test_api_connection,
    poll_lightspeed_sales, generate_mock_order, update_lightspeed_sale_status
)

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'static')
PORT = int(os.environ.get('PORT', 8080))

class SSEManager:
    """Manages connected SSE client queues and handles broadcasting."""
    def __init__(self):
        self.clients = set()
        self.lock = threading.Lock()

    def add_client(self, client_queue):
        with self.lock:
            self.clients.add(client_queue)

    def remove_client(self, client_queue):
        with self.lock:
            self.clients.discard(client_queue)

    def broadcast(self, event_type, data):
        message = json.dumps({"type": event_type, "data": data, "timestamp": time.time()})
        with self.lock:
            dead_clients = set()
            for q in self.clients:
                try:
                    q.put_nowait(message)
                except queue.Full:
                    dead_clients.add(q)
            for q in dead_clients:
                self.clients.discard(q)

sse_manager = SSEManager()

class BackgroundPoller(threading.Thread):
    """
    Periodically polls the Lightspeed API for new sales when polling is enabled.
    """
    def __init__(self):
        super().__init__(daemon=True)
        self.running = True
        self.wake_event = threading.Event()

    def run(self):
        while self.running:
            try:
                settings = get_settings()
                polling_enabled = settings.get('polling_enabled', 'false').lower() == 'true'
                interval = int(settings.get('polling_interval', '15') or 15)
                
                if polling_enabled and settings.get('api_token'):
                    last_sync = settings.get('last_sync_timestamp') or None
                    sales = poll_lightspeed_sales(settings, since_timestamp=last_sync)
                    
                    if sales:
                        for sale in sales:
                            saved_order, is_new = save_order(sale)
                            if is_new:
                                sse_manager.broadcast("new_order", saved_order)
                            else:
                                sse_manager.broadcast("order_updated", saved_order)

                        # Update last sync timestamp
                        now_str = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
                        update_settings({'last_sync_timestamp': now_str})
                        sse_manager.broadcast("stats_updated", get_stats())

            except Exception as e:
                print(f"[BackgroundPoller] Error during sync: {e}", file=sys.stderr)

            # Wait for interval or wake signal
            self.wake_event.wait(timeout=max(5, interval if 'interval' in locals() else 15))
            self.wake_event.clear()

    def trigger_now(self):
        self.wake_event.set()

poller_thread = BackgroundPoller()

class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

class LightspeedRequestHandler(http.server.BaseHTTPRequestHandler):

    def log_message(self, format, *args):
        # Concise logging for SSE and static requests
        if "/api/stream" in args[0]:
            return
        super().log_message(format, *args)

    def send_json_response(self, status_code, data):
        payload = json.dumps(data).encode('utf-8')
        self.send_response(status_code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PATCH')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Lightspeed-Signature, Authorization')
        self.end_headers()
        self.wfile.write(payload)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PATCH')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Lightspeed-Signature, Authorization')
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        # 1. Real-time SSE Stream Endpoint
        if path == '/api/stream':
            self.handle_sse_stream()
            return

        # 1b. Live Sync Snapshot (used by serverless / fallback clients)
        if path == '/api/live-sync':
            self.send_json_response(200, {
                'orders': list_orders(limit=100),
                'stats': get_stats(),
                'queue_summary': get_active_queue_summary(),
                'detailed_queue': get_detailed_queue_items()
            })
            return

        # 2. REST API: List Orders
        if path == '/api/orders':
            status = query.get('status', [None])[0]
            search = query.get('search', [None])[0]
            limit = int(query.get('limit', ['100'])[0])
            orders = list_orders(status=status, search=search, limit=limit)
            self.send_json_response(200, {'orders': orders, 'count': len(orders)})
            return

        # 3. REST API: Single Order Details
        if path.startswith('/api/orders/'):
            order_id = path[len('/api/orders/'):].strip('/')
            order = get_order_by_id(order_id)
            if order:
                self.send_json_response(200, {'order': order})
            else:
                self.send_json_response(404, {'error': 'Order not found'})
            return

        # 4. REST API: Stats
        if path == '/api/stats':
            self.send_json_response(200, get_stats())
            return

        # 4b. REST API: Active Items Queue Summary
        if path == '/api/queue-summary':
            self.send_json_response(200, {'items': get_active_queue_summary()})
            return

        # 4c. REST API: Detailed Queue Items (Items Station Tab)
        if path == '/api/detailed-queue-items':
            self.send_json_response(200, {'items': get_detailed_queue_items()})
            return

        # 5. REST API: Settings
        if path == '/api/settings':
            settings = get_settings()
            # Mask API token for security in UI
            masked_token = settings.get('api_token', '')
            if masked_token and len(masked_token) > 8:
                masked_token = masked_token[:4] + '••••••••' + masked_token[-4:]
            safe_settings = dict(settings)
            safe_settings['api_token_preview'] = masked_token
            safe_settings['has_api_token'] = bool(settings.get('api_token'))
            self.send_json_response(200, safe_settings)
            return

        # 6. Static files (Frontend)
        self.serve_static(path)

    def handle_sse_stream(self):
        """Streams real-time events to connected browser clients."""
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Connection', 'keep-alive')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()

        client_q = queue.Queue(maxsize=50)
        sse_manager.add_client(client_q)

        # Initial handshake message
        try:
            init_msg = json.dumps({
                "type": "connected",
                "message": "Connected to Lightspeed Live Stream",
                "stats": get_stats(),
                "queue_summary": get_active_queue_summary(),
                "detailed_queue": get_detailed_queue_items()
            })
            self.wfile.write(f"data: {init_msg}\n\n".encode('utf-8'))
            self.wfile.flush()

            while True:
                try:
                    # Wait for message with 15s timeout for heartbeat
                    message = client_q.get(timeout=15.0)
                    self.wfile.write(f"data: {message}\n\n".encode('utf-8'))
                    self.wfile.flush()
                except queue.Empty:
                    # Heartbeat comment to keep connection alive
                    self.wfile.write(b": heartbeat\n\n")
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            sse_manager.remove_client(client_q)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        content_len = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_len) if content_len > 0 else b'{}'
        try:
            data = json.loads(body.decode('utf-8')) if body else {}
        except Exception:
            data = {}

        # 1. Lightspeed Webhook Ingestion Endpoint
        if path == '/api/webhooks/lightspeed':
            normalized = normalize_webhook_payload(data)
            saved_order, is_new = save_order(normalized)
            
            # Broadcast live to connected clients!
            if is_new:
                sse_manager.broadcast("new_order", saved_order)
            else:
                sse_manager.broadcast("order_updated", saved_order)
            sse_manager.broadcast("stats_updated", get_stats())
            sse_manager.broadcast("queue_updated", get_active_queue_summary())

            self.send_json_response(200, {
                'status': 'success',
                'order_id': saved_order['id'],
                'is_new': is_new
            })
            return

        # 2. Update Order Status (supports sync_lightspeed flag)
        if path.startswith('/api/orders/') and path.endswith('/status'):
            parts = path.split('/')
            order_id = parts[3]
            new_status = data.get('status', 'new')
            sync_lightspeed = bool(data.get('sync_lightspeed', False))

            api_result = None
            if sync_lightspeed:
                order = get_order_by_id(order_id)
                if order:
                    settings = get_settings()
                    success, msg, is_sim = update_lightspeed_sale_status(settings, order.get('lightspeed_id') or order_id, new_status)
                    api_result = {'success': success, 'message': msg, 'simulated': is_sim}

            updated = update_order_status(order_id, new_status, synced_to_lightspeed=sync_lightspeed)
            if updated:
                sse_manager.broadcast("order_updated", updated)
                sse_manager.broadcast("stats_updated", get_stats())
                sse_manager.broadcast("queue_updated", get_active_queue_summary())
                sse_manager.broadcast("detailed_queue_updated", get_detailed_queue_items())
                self.send_json_response(200, {'order': updated, 'api_result': api_result})
            else:
                self.send_json_response(404, {'error': 'Order not found'})
            return

        # 2b. Update Order Local Notes
        if path.startswith('/api/orders/') and path.endswith('/notes'):
            parts = path.split('/')
            order_id = parts[3]
            notes = data.get('notes', '')
            updated = update_order_notes(order_id, notes)
            if updated:
                sse_manager.broadcast("order_updated", updated)
                self.send_json_response(200, {'order': updated})
            else:
                self.send_json_response(404, {'error': 'Order not found'})
            return

        # 2c. Update Individual Order Item Status (Local or API)
        if path.startswith('/api/items/') and path.endswith('/status'):
            parts = path.split('/')
            item_id = int(parts[3])
            new_status = data.get('status', 'made')
            sync_lightspeed = bool(data.get('sync_lightspeed', False))
            quantity_delta = data.get('quantity_delta')
            count = data.get('count')

            api_result = None
            if sync_lightspeed:
                settings = get_settings()
                desc = f"item-{item_id}"
                if count:
                    desc += f" (count: {count})"
                elif quantity_delta:
                    desc += f" (delta: {quantity_delta})"
                success, msg, is_sim = update_lightspeed_sale_status(settings, desc, new_status)
                api_result = {'success': success, 'message': msg, 'simulated': is_sim}

            updated_order = update_item_status(item_id, new_status, synced_to_lightspeed=sync_lightspeed, quantity_delta=quantity_delta, count=count)
            sse_manager.broadcast("queue_updated", get_active_queue_summary())
            sse_manager.broadcast("detailed_queue_updated", get_detailed_queue_items())
            if updated_order:
                sse_manager.broadcast("order_updated", updated_order)
                sse_manager.broadcast("stats_updated", get_stats())

            self.send_json_response(200, {
                'status': 'success',
                'order': updated_order,
                'api_result': api_result,
                'detailed_items': get_detailed_queue_items()
            })
            return

        # 2d. Batch Update Items by Name (supports custom count or all)
        if path == '/api/items/batch-status':
            item_name = data.get('name')
            new_status = data.get('status', 'made')
            count = data.get('count')
            if count is not None:
                try:
                    count = int(count)
                except (ValueError, TypeError):
                    count = None
            sync_lightspeed = bool(data.get('sync_lightspeed', False))

            api_result = None
            if sync_lightspeed:
                settings = get_settings()
                target_desc = f"{count}x {item_name}" if count else item_name
                success, msg, is_sim = update_lightspeed_sale_status(settings, target_desc, new_status)
                api_result = {'success': success, 'message': msg, 'simulated': is_sim}

            update_items_by_name(item_name, count_to_mark=count, new_status=new_status, synced_to_lightspeed=sync_lightspeed)
            sse_manager.broadcast("queue_updated", get_active_queue_summary())
            sse_manager.broadcast("detailed_queue_updated", get_detailed_queue_items())
            sse_manager.broadcast("stats_updated", get_stats())

            self.send_json_response(200, {
                'status': 'success',
                'api_result': api_result,
                'detailed_items': get_detailed_queue_items()
            })
            return

        # 3. Simulate Incoming Order (One-click demo/test)
        if path == '/api/simulate-order':
            mock = generate_mock_order()
            saved_order, is_new = save_order(mock)
            sse_manager.broadcast("new_order", saved_order)
            sse_manager.broadcast("stats_updated", get_stats())
            sse_manager.broadcast("queue_updated", get_active_queue_summary())
            sse_manager.broadcast("detailed_queue_updated", get_detailed_queue_items())
            self.send_json_response(201, {'order': saved_order})
            return

        # 4. Save Settings
        if path == '/api/settings':
            # Preserve existing token if user left it blank
            current = get_settings()
            if not data.get('api_token'):
                data['api_token'] = current.get('api_token', '')
            update_settings(data)
            poller_thread.trigger_now()
            self.send_json_response(200, {'status': 'saved'})
            return

        # 5. Test API Connection
        if path == '/api/lightspeed/test-connection':
            current_settings = get_settings()
            # Merge with incoming payload in case testing unsaved inputs
            merged = dict(current_settings)
            merged.update(data)
            success, msg = test_api_connection(merged)
            self.send_json_response(200 if success else 400, {
                'success': success,
                'message': msg
            })
            return

        # 6. Force Sync Now
        if path == '/api/lightspeed/sync-now':
            settings = get_settings()
            sales = poll_lightspeed_sales(settings)
            count = 0
            for sale in sales:
                saved, is_new = save_order(sale)
                if is_new:
                    count += 1
                    sse_manager.broadcast("new_order", saved)
                else:
                    sse_manager.broadcast("order_updated", saved)
            if count > 0:
                sse_manager.broadcast("stats_updated", get_stats())
                sse_manager.broadcast("queue_updated", get_active_queue_summary())
                sse_manager.broadcast("detailed_queue_updated", get_detailed_queue_items())
            self.send_json_response(200, {'synced_count': len(sales), 'new_count': count})
            return

        # 7. Clear Demo Orders
        if path == '/api/orders/clear':
            clear_all_orders()
            sse_manager.broadcast("orders_cleared", {})
            sse_manager.broadcast("stats_updated", get_stats())
            sse_manager.broadcast("queue_updated", [])
            sse_manager.broadcast("detailed_queue_updated", [])
            self.send_json_response(200, {'status': 'cleared'})
            return

        self.send_json_response(404, {'error': 'Endpoint not found'})

    def serve_static(self, path):
        if path in ('/', ''):
            filepath = os.path.join(STATIC_DIR, 'index.html')
            content_type = 'text/html; charset=utf-8'
        else:
            filename = os.path.basename(path)
            filepath = os.path.join(STATIC_DIR, filename)
            if filename.endswith('.css'):
                content_type = 'text/css; charset=utf-8'
            elif filename.endswith('.js'):
                content_type = 'application/javascript; charset=utf-8'
            elif filename.endswith('.html'):
                content_type = 'text/html; charset=utf-8'
            elif filename.endswith('.svg'):
                content_type = 'image/svg+xml'
            elif filename.endswith('.json'):
                content_type = 'application/json'
            else:
                content_type = 'application/octet-stream'

        if os.path.exists(filepath) and os.path.isfile(filepath):
            with open(filepath, 'rb') as f:
                content = f.read()
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(content)))
            self.end_headers()
            self.wfile.write(content)
        else:
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"404 Not Found")

def run_server(port=PORT):
    init_db()
    poller_thread.start()
    server_address = ('0.0.0.0', port)
    httpd = ThreadingHTTPServer(server_address, LightspeedRequestHandler)
    print(f"=======================================================")
    print(f" Lightspeed Live Orders Dashboard running at:")
    print(f" http://localhost:{port}")
    print(f" http://127.0.0.1:{port}")
    print(f" Webhook URL: http://<your-host>:{port}/api/webhooks/lightspeed")
    print(f"=======================================================")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server...")
        httpd.shutdown()

if __name__ == '__main__':
    run_server()
