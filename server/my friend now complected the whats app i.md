my friend now complected the whats app intergation , now we have to updated this file by 
"https://github.com/dhanujakse/alagiri-whatsapp" this repo and i will send you the convation by her , you go thjrough it and makeit i think we have to
updated it in aws , and get the env2 and updated our env . :hi , the think is my friend compled the whatapp interagition , she said now we need to upload in aws , i will send the chat and env "env2" gothrough it and fix it 






.Round 2 is deploy and connect, and your friend can do the server part while round 1 runs. Here's a handoff he can follow. EC2 is the safest AWS choice because SQLite needs a disk that persists and the 9:00 AM job needs a server that stays on.

**What your friend needs from you**
1. The code in a private Git repo, with `server/.env` confirmed as not committed.
2. The variable names from `server/.env.example`.
3. The secret values, but not over WhatsApp or chat. Type them into the server's `.env` yourself during a call, or use a password manager.

**Server steps (your friend)**

1. **Create the server.** An EC2 instance with Ubuntu 22.04 or 24.04 (t3.small is fine) and an Elastic IP attached. Allow ports 22 (his IP only), 80 and 443 in the security group.

2. **Install the tools.** Node 22.13 or newer, because the backend uses `node:sqlite` (as far as I know, older versions need an experimental flag), plus git, nginx and pm2:
```
sudo apt update && sudo apt install -y git nginx
npm install -g pm2
```
Check with `node -v`.

3. **Get the code:**
```
git clone <repo-url> millmate && cd millmate
npm ci && npm ci --prefix server
```

4. **Create `server/.env`** with `nano server/.env`:
```
NODE_ENV=production
PORT=4000
WHATSAPP_DRY_RUN=1
```
plus all the other values from the local `.env`. Use a **new** strong `JWT_SECRET` for production, and set `CORS_ORIGIN` to the real app URL(s). Put `DB_PATH` on a normal disk folder that survives restarts, not temporary storage.

5. **Run it as exactly one instance:**
```
pm2 start server/index.js --name millmate
pm2 save && pm2 startup
```
Don't use cluster mode or two copies, or the 9:00 AM job would send everything twice.

6. **Get an https address.** Meta rejects plain http and bare IPs.
   - At GoDaddy DNS, add an **A record** `api` pointing to the Elastic IP, giving `api.alagiriduplex.com`. Don't touch the existing `@`, `www`, MX or TXT records.
   - Create `/etc/nginx/sites-available/millmate`:
```
server {
  server_name api.alagiriduplex.com;
  location / {
    proxy_pass http://127.0.0.1:4000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 25m;
  }
}
```
   - Enable it and get the certificate:
```
sudo ln -s /etc/nginx/sites-available/millmate /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d api.alagiriduplex.com
```
   If your AWS setup already has an https address (a load balancer, say), use that and skip this step.

7. **Confirm it's live:** `https://api.alagiriduplex.com/api/health` should respond, and the verification test should print the challenge:
```
https://api.alagiriduplex.com/api/whatsapp/inbound?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=12345
```
   The page should show `12345`.

8. **PO PDF link:** check that the link the app builds for a PO opens in a private window with no login, and that it uses the public backend address, not localhost. Ask Antigravity which env variable controls that base URL.

9. **Backups:** add a nightly copy of the SQLite file, because it's the only copy of your orders. For example a cron job copying it to S3. Also take an EC2 snapshot.

10. **Updating later:** `git pull && npm ci --prefix server && pm2 restart millmate`.

**What you do (needs your Meta access)**
1. Mill Mate → WhatsApp → Configuration → Webhook → Edit: set the callback URL to `https://api.alagiriduplex.com/api/whatsapp/inbound` and the same verify token, click Verify and save, and subscribe to **messages**. If your friend should do this, add him under App settings → App roles → Roles.
2. **Stop the old `whatsapp-webhook` server and the Cloudflare tunnel.** If it keeps running, it auto-replies Yes/No buttons to anyone who messages the number.

**Round 2 checks**
1. The Meta webhook shows a green tick, and **messages** is subscribed.
2. A message from your phone to the business number shows up in the server logs (`pm2 logs millmate`) and creates an admin notification.
3. A real PO PDF link opens without a login.

Keep `WHATSAPP_DRY_RUN=1` on the server until the payment is added. Is your backend already running on an EC2 instance, or something else on AWS?




convation 2 : Here is the complete guide for setting up payment on Meta and verifying real-time working once deployed.

---

### Part 1: How to Set Up Payment in Meta

Meta WhatsApp Cloud API charges per 24-hour conversation window (utility messages like POs and reminders cost ~₹0.12 to ₹0.40 per conversation in India). To enable live messaging without rate or test-number restrictions:

1. **Open Meta Business Suite / Manager**:
   - Go to [business.facebook.com](https://business.facebook.com).
   - In the left sidebar, click **Settings** (gear icon) &rarr; **Billing & Payments**.
2. **Add a Payment Method**:
   - Click **Add Payment Method** &rarr; select Credit Card / Debit Card (ensure international online transactions are enabled on the card).
3. **Assign Payment Method to WhatsApp Account**:
   - Go to **Settings** &rarr; **WhatsApp Accounts**.
   - Select your WhatsApp Business Account (**Alagiri Duplex**).
   - Click **Settings** tab &rarr; **Payment Settings** (or Payment Method).
   - Select the card you added and set it as the primary payment method for this WABA.

---

### Part 2: Switch From Dry-Run to Real-Time Mode

Once your server is deployed on your production host (e.g., Render, Railway, VPS):

1. **Update `server/.env`**:
   ```env
   # 1. Turn OFF dry run so real WhatsApp messages are dispatched
   WHATSAPP_DRY_RUN=0

   # 2. Set your production HTTPS backend domain
   PUBLIC_BASE_URL=https://api.yourdomain.com

   # 3. Enter your real WhatsApp Business Account ID (from WhatsApp -> API Setup)
   META_WABA_ID=your_real_waba_id
   ```

2. **Configure Meta Webhook**:
   - In [Meta Developer Dashboard](https://developers.facebook.com) &rarr; your App &rarr; **WhatsApp** &rarr; **Configuration**:
     - **Callback URL**: `https://api.yourdomain.com/api/whatsapp/inbound`
     - **Verify Token**: Must match your `META_WEBHOOK_VERIFY_TOKEN` in `server/.env`.
     - Click **Verify and save**.
   - Under **Webhook Fields**, click **Manage** and subscribe to **`messages`**.

---

### Part 3: How to Check and Verify Everything is Working

Follow this 4-step checklist to test the full live workflow:

#### Step 1: Verify Templates with Meta
Run the built-in diagnostic tool on your server:
```bash
npm run check:templates --prefix server
```
- **What to look for**: All 5 templates (`po_dispatch_request_v2`, `dispatchday_booking`, `dispatch_overdue_reschedule`, `dispatchdate_pending`, `daily_summary`) should show **Status: APPROVED**, **Language: en**, and **Vars Match: ✅**.

---

#### Step 2: Send a Real PO on WhatsApp
1. In the Mill Mate web app, open an order and set the supplier phone number to **your own WhatsApp number** (in international format, e.g., `+919876543210`).
2. Go to **PO Preview** and click **"Send PO on WhatsApp"**.
3. **Verify on your phone**:
   - You should receive a WhatsApp message from Alagiri Duplex with:
     - The PO PDF attached (tap to download and verify it opens).
     - The body text showing the PO number.
     - The interactive button: **Select Dispatch Date**.

---

#### Step 3: Test Interactive Flow & LR Document Upload
1. **Tap the Flow Button on WhatsApp**:
   - Pick an expected dispatch date (e.g., a future date) and submit.
   - **Verification**:
     - You should receive an immediate confirmation message: *"Thank you! We have recorded your expected dispatch date..."*
     - In Mill Mate, open the order &rarr; verify the **Dispatch Date** is updated and the status chip shows the date.
2. **Send an LR / Booking Proof Document**:
   - From your phone, reply with any photo or PDF.
   - **Verification**:
     - Bot replies: *"Thank you! We received your booking document... Your order is now marked as Booked."*
     - In Mill Mate, refresh the order &rarr; status updates to **Booked** and the LR document link appears.
     - Click **"View Chat"** in the order to see the full timeline with sent, delivered, and read status ticks.

---

#### Step 4: Test 9:00 AM Daily Summary
Trigger a test run of the morning job manually from the command line:
```bash
npm run job:morning --prefix server
```
- **Verification**: All team members with phone numbers and WhatsApp alerts toggled ON will receive the 6-variable daily summary message detailing live, awaiting-date, booked, overdue, and rejected orders.  