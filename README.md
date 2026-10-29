# ⚡ Lightspeed Live Orders Dashboard

A real-time order monitoring dashboard that connects to **Lightspeed's API and Webhooks** to display incoming orders instantly without having to manually refresh the page.

![Dashboard Preview](https://img.shields.io/badge/Lightspeed-Retail%20%7C%20Vend%20%7C%20Restaurant-red)
![Real-time](https://img.shields.io/badge/Stream-SSE%20%28Server--Sent%20Events%29-brightgreen)
![Zero Dependencies](https://img.shields.io/badge/Dependencies-Zero%20%28Standard%20Python%203%29-blue)

---

## 🌟 Key Features

- **No Manual Refreshing**: Uses **Server-Sent Events (SSE)** over persistent HTTP to stream orders the moment they are placed.
- **Audio & Visual Alerts**: Built-in sound bell (via Web Audio API) and card pulse animations notify kitchen/front-of-house staff when an order lands.
- **Dual Connection Modes**:
  1. **Instant Webhooks (Push)**: Receives orders with sub-second latency from Lightspeed's event webhooks.
  2. **Automated Background Poller (Pull)**: Periodically queries the Lightspeed API for newly completed sales (customizable 5s–300s interval).
- **Supports Multiple Lightspeed Products**:
  - **Lightspeed Retail (R-Series / MerchantOS)**
  - **Lightspeed Retail (X-Series / Vend)**
  - **Lightspeed Restaurant (K-Series)**
  - **Direct Webhook Ingestion**
- **Kitchen / Counter Display System**:
  - Order status progression: **New (Pending) ➜ In Prep ➜ Ready for Pickup ➜ Completed**.
  - Elapsed time counter ("Just now", "2m ago") auto-updates in real time.
  - Detailed line items, modifiers, customer info, and ticket printing.
- **Instant Simulator**: Test and demo realistic orders with a single click before plugging in live store credentials.
- **Zero External Dependencies**: Built entirely on standard Python 3 (`http.server`, `urllib`, `sqlite3`). No `npm`, `pip`, or virtual environment required!

---

## 🚀 Quick Start

### 1. Launch the Server

Navigate to the project directory and run:

```bash
cd /Users/tony/.gemini/antigravity/scratch/lightspeed-live-orders
python3 server.py
```

Or make the startup script executable and run:
```bash
chmod +x start.sh
./start.sh
```

### 2. Open the Dashboard

Open your web browser and navigate to:
```
http://localhost:8080
```

---

## 🔌 Connecting to Lightspeed

Click **⚙️ Settings & API** in the top navigation bar to configure your store.

### Mode A: Lightspeed Retail (R-Series / MerchantOS)
1. **Platform**: Select *Lightspeed Retail (R-Series)*.
2. **Account ID**: Enter your Lightspeed Account ID (visible in your store URL, e.g. `cloud.lightspeedapp.com/?accountId=123456`).
3. **API Token**: Enter your OAuth Bearer Token or API Key generated under **Settings > Developer API**.
4. **Enable Automatic API Polling**: Toggle ON to automatically pull sales every 15 seconds.
5. Click **🔌 Test Connection** to verify credentials, then **Save Configuration**.

### Mode B: Lightspeed Retail (X-Series / Vend)
1. **Platform**: Select *Lightspeed Retail (X-Series / Vend)*.
2. **Store Domain Prefix**: Enter your store subdomain (e.g. `mystore` for `mystore.vendhq.com`).
3. **API Token**: Enter your Personal Access Token generated under **Setup > Personal Access Tokens**.
4. Click **🔌 Test Connection**, then **Save Configuration**.

---

## ⚡ Instant Push Webhooks (Zero Delay)

Webhooks push sales directly to your dashboard the exact millisecond they occur.

### Setting up Webhooks in Lightspeed:
1. Your dashboard provides a dedicated webhook receiver endpoint:
   ```
   http://<your-server-domain-or-ip>:8080/api/webhooks/lightspeed
   ```
2. For local testing with Lightspeed, expose your local port 8080 using [ngrok](https://ngrok.com) or [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/):
   ```bash
   ngrok http 8080
   ```
   Your webhook URL will look like:
   `https://xyz.ngrok-free.app/api/webhooks/lightspeed`
3. In your Lightspeed Backoffice:
   - Go to **Settings > Webhooks** (or API Webhook Subscriptions).
   - Subscribe to events such as `sale.create` or `sale.update`.
   - Paste your Webhook URL.
   - Save the webhook.

---

## 🧪 Testing and Simulation

You do not need an active store ringing sales to verify the dashboard:

1. **One-Click Simulator**:
   Click the **⚡ Simulate Order** button in the header. A realistic POS order complete with customer name, items, modifiers, and payment details will immediately appear with an audio chime!
2. **Simulate via cURL (Webhook test)**:
   ```bash
   curl -X POST http://localhost:8080/api/webhooks/lightspeed \
     -H "Content-Type: application/json" \
     -d '{
       "id": "SALE-9912",
       "order_number": "#LS-9912",
       "customer_name": "Sarah Connor",
       "customer_email": "sarah@example.com",
       "order_type": "Takeaway",
       "subtotal": 18.50,
       "tax": 1.64,
       "total": 20.14,
       "items": [
         {"name": "Iced Vanilla Latte", "quantity": 2, "unit_price": 5.50, "modifiers": "Oat milk"},
         {"name": "Avocado Toast", "quantity": 1, "unit_price": 7.50, "modifiers": "Poached egg"}
       ]
     }'
   ```
   Notice that the dashboard updates instantaneously without reloading!

## 🛡️ Independent Local Status Tracking (Safe from Lightspeed POS)

A key design feature of this dashboard is **strict separation between kitchen display status and POS accounting**:
- **Read-Only Integration**: The dashboard only *reads* sales and orders from Lightspeed.
- **Local State Isolation**: When you click **Start Prep**, **Mark Ready**, **Complete**, or add **Internal Staff Notes**, these actions are stored exclusively in your local database (`orders.db`).
- **Never Alters Lightspeed Sales**: Status changes on this board **will never** void, modify, alter, refund, or mark sales completed in Lightspeed's backoffice or register.
- **Sync Protection**: Subsequent background polls or incoming webhooks from Lightspeed will preserve your local progression status and will not reset your orders.

---

## 🌐 How to Host on GitHub & Deploy Live

Because this application uses **real-time Server-Sent Events (SSE)**, an **automated background poller**, and a **webhook receiver**, it requires a lightweight Python backend running.

Here are the step-by-step instructions:

### Step 1: Push your Code to GitHub

1. Go to [GitHub.com](https://github.com) and click **New Repository** (e.g. `lightspeed-live-orders`).
2. Keep it public or private, and do not initialize with a README (we already have one).
3. In your local terminal, run:

```bash
cd /Users/tony/.gemini/antigravity/scratch/lightspeed-live-orders

# Link your local repo to GitHub (replace with your GitHub username)
git remote add origin https://github.com/<your-username>/lightspeed-live-orders.git

# Set main branch and push
git branch -M main
git push -u origin main
```

---

### Step 2: Host Online with Free 24/7 Cloud Deployment (Render / Railway)

By connecting your GitHub repository to a free cloud platform like **Render** or **Railway**, your dashboard will automatically build, deploy, and stay live with a free public HTTPS URL:

#### Option A: Deploy on Render (Recommended & Free)
1. Sign up / log in to [Render.com](https://render.com) using your GitHub account.
2. Click **New +** ➜ **Web Service**.
3. Select your `lightspeed-live-orders` repository.
4. Render will auto-detect the included `render.yaml` and `Procfile`:
   - **Environment**: `Python 3`
   - **Build Command**: *(leave empty)*
   - **Start Command**: `python3 server.py`
5. Click **Create Web Service**.
6. Within 1 minute, you will receive a public HTTPS URL:
   `https://lightspeed-live-orders-xxxx.onrender.com`
7. Now you can:
   - Open this URL on any device, tablet, or phone in your kitchen/store.
   - Use `https://lightspeed-live-orders-xxxx.onrender.com/api/webhooks/lightspeed` directly in Lightspeed's webhook settings without needing ngrok!

#### Option B: Run in GitHub Codespaces (Browser-based)
If you just want to run it from GitHub without any third-party services:
1. On your GitHub repository page, click the green **Code** button.
2. Select the **Codespaces** tab and click **Create codespace on main**.
3. In the built-in terminal, type:
   ```bash
   python3 server.py
   ```
4. A notification popup will say *"Your application running on port 8080 is available"*. Click **Open in Browser**!

---

## 📂 Project Architecture

```
lightspeed-live-orders/
├── server.py        # Multi-threaded HTTP & Server-Sent Events (SSE) server
├── db.py            # SQLite database with Write-Ahead Logging (WAL)
├── lightspeed.py    # Lightspeed R-Series & X-Series API integration & normalizer
├── Procfile         # Cloud deployment specification
├── requirements.txt # Python package specification for cloud platforms
├── render.yaml      # 1-click cloud blueprint for Render
├── start.sh         # Convenience launcher script
├── README.md        # Documentation and setup guide
└── static/
    ├── index.html   # Modern responsive dashboard & modals
    ├── styles.css   # Dark theme, status badges, animations
    └── app.js       # Real-time SSE listener, Web Audio bell, order actions
```
