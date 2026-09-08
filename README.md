# Matrimony Backend v2 — Fully Synced API

Node.js + Express + PostgreSQL + Prisma  
**Flutter App ↔ Admin Panel — Fully Integrated**

---

## 📁 Project Structure

```
matrimony-backend-v2/
├── prisma/
│   └── schema.prisma              # All 18 DB models
├── src/
│   ├── index.js                   # Express entry point
│   ├── lib/
│   │   ├── prisma.js              # Prisma singleton
│   │   ├── firebase.js            # Firebase Admin (FCM)
│   │   └── seed.js                # DB seed script
│   ├── middleware/
│   │   ├── adminAuth.js           # JWT for Admin panel
│   │   └── userAuth.js            # JWT for Flutter app (+ block check)
│   └── routes/
│       ├── auth.js                # Flutter + Admin auth
│       ├── profile.js             # Flutter profile + unlock contact
│       ├── home.js                # Flutter home screen
│       ├── gallery.js             # Flutter photo upload
│       ├── packages.js            # Flutter buy + Admin manage
│       ├── privacy.js             # Flutter privacy settings
│       ├── dropdowns.js           # Flutter form dropdowns
│       ├── notifications.js       # Flutter receive + Admin send
│       ├── users.js               # Admin users + Flutter report
│       ├── dashboard.js           # Admin dashboard
│       ├── transactions.js        # Admin transactions
│       ├── callLogs.js            # Admin call logs
│       ├── support.js             # Flutter submit + Admin reply
│       └── reports.js             # Admin reports
├── uploads/                       # Gallery photos (auto-created)
├── .env.example
└── package.json
```

---

## 🔄 Sync Flow — How Flutter ↔ Admin Connects

```
Flutter Action                  → Backend Action               → Admin Sees
─────────────────────────────────────────────────────────────────────────────
User signs up                   → Creates User + ProfileApproval → Approval queue
User completes profile          → Fills personal/family/etc.    → Full profile in Users
Admin approves profile          → isVerified=true, status=ACTIVE → User can browse
Admin rejects profile           → FCM push to user              → Notified on phone
Admin blocks user               → status=BLOCKED                → Next API call = 403
User buys package (Razorpay)    → Creates Transaction + credits  → Transactions page
User unlocks contact            → Creates CallLog + deducts credit → Call Logs page
User reports another user       → Creates UserReport            → Reports to review
Admin warns/suspends/bans       → Updates status / deletes user  → Reflected in app
Admin sends notification        → FCM push to all users         → Seen in app
User submits support ticket     → Creates SupportTicket         → Support inbox
Admin replies to ticket         → FCM push to user              → User gets notified
```

---

## 🚀 Local Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
nano .env   # fill in your values

# 3. Push schema to database
npm run db:push

# 4. Generate Prisma client
npm run db:generate

# 5. Seed sample data + admin account
npm run db:seed

# 6. Start server
npm run dev
```

---

## 🖥️ EC2 Deployment (Ubuntu 22.04)

### Step 1 — Install on EC2
```bash
sudo apt update && sudo apt upgrade -y

# Node.js 18
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# PostgreSQL
sudo apt install -y postgresql postgresql-contrib

# Nginx + PM2
sudo apt install -y nginx
sudo npm install -g pm2
```

### Step 2 — Create Database
```bash
sudo -u postgres psql
```
```sql
CREATE DATABASE matrimony_db;
CREATE USER matrimony_user WITH PASSWORD 'YourStrongPassword123';
GRANT ALL PRIVILEGES ON DATABASE matrimony_db TO matrimony_user;
\q
```

### Step 3 — Deploy Backend
```bash
cd /var/www
git clone <your-backend-repo> backend
cd backend
npm install
cp .env.example .env
nano .env    # fill in all values
npm run db:push
npm run db:seed
```

### Step 4 — Start with PM2
```bash
pm2 start src/index.js --name "matrimony-api"
pm2 save
pm2 startup
```

### Step 5 — Deploy Admin Panel
```bash
cd /var/www
git clone <your-admin-repo> admin
cd admin
npm install
echo "VITE_API_URL=http://YOUR_EC2_IP/api" > .env
npm run build
```

### Step 6 — Configure Nginx
```bash
sudo nano /etc/nginx/sites-available/default
```
```nginx
server {
    listen 80;
    server_name YOUR_EC2_IP_OR_DOMAIN;

    # Increase upload limit for gallery photos
    client_max_body_size 10M;

    # Admin Panel
    location / {
        root /var/www/admin/dist;
        try_files $uri /index.html;
    }

    # Backend API
    location /api/ {
        proxy_pass         http://localhost:4000/api/;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host $host;
        proxy_cache_bypass $http_upgrade;
    }

    # Uploaded photos (gallery)
    location /uploads/ {
        proxy_pass http://localhost:4000/uploads/;
    }
}
```
```bash
sudo nginx -t && sudo systemctl restart nginx
```

### Step 7 — Flutter App Update
In `lib/data/constant/api.dart`:
```dart
static const String _domain = 'http://YOUR_EC2_IP';
```

---

## ⚙️ Environment Variables

```env
DATABASE_URL="postgresql://matrimony_user:PASSWORD@localhost:5432/matrimony_db"
JWT_SECRET="your_long_random_secret_min_32_chars"
JWT_EXPIRES_IN="7d"
PORT=4000
NODE_ENV=production

ADMIN_EMAIL=""
ADMIN_PASSWORD=""
ADMIN_NAME=""

RAZORPAY_KEY_ID="rzp_live_xxxxxxxxxxxx"
RAZORPAY_KEY_SECRET="xxxxxxxxxxxxxxxxxxxxxxxx"

FIREBASE_SERVICE_ACCOUNT_JSON='{"type":"service_account","project_id":"...","private_key":"...","client_email":"..."}'

UPLOAD_DIR="uploads"
MAX_FILE_SIZE_MB=5
```

---

## 📋 Complete API Reference

### 🔐 Auth (Flutter + Admin)

| Method | Route | Who | Description |
|--------|-------|-----|-------------|
| POST | /api/auth/signup | Flutter | Register new user → creates ProfileApproval |
| POST | /api/auth/login | Flutter | Pre-OTP check |
| POST | /api/auth/verify-otp | Flutter | Verify Firebase OTP → get JWT |
| POST | /api/auth/resend-otp | Flutter | Resend OTP |
| POST | /api/auth/save-fcm-token | Flutter | Save device token for push |
| POST | /api/auth/admin/login | Admin | Admin JWT login |
| GET | /api/auth/me | Admin | Get current admin |
| PUT | /api/auth/profile | Admin | Update admin name |
| PUT | /api/auth/password | Admin | Change admin password |

### 👤 Profile (Flutter)

| Method | Route | Description |
|--------|-------|-------------|
| GET | /api/profile/me | My full profile |
| POST | /api/profile/personal | Save personal details |
| POST | /api/profile/family | Save family details |
| POST | /api/profile/professional | Save professional details |
| POST | /api/profile/physical | Save physical details |
| GET | /api/profile/:id | View another user's profile |
| POST | /api/profile/:id/unlock-contact | Spend 1 credit → get contact → writes CallLog |
| POST | /api/profile/:id/bookmark | Bookmark / unbookmark |
| POST | /api/profile/:id/swipe | Swipe left or right |

### 🏠 Home (Flutter)

| Method | Route | Description |
|--------|-------|-------------|
| GET | /api/home/dashboard | Home screen data + featured profiles |
| GET | /api/home/profiles | Browse all profiles (paginated) |

### 🖼️ Gallery (Flutter)

| Method | Route | Description |
|--------|-------|-------------|
| GET | /api/gallery | My uploaded photos |
| POST | /api/gallery/upload | Upload photo (multipart/form-data, field: `photo`) |

### 📦 Packages (Flutter + Admin)

| Method | Route | Who | Description |
|--------|-------|-----|-------------|
| GET | /api/packages | Flutter | List active packages + free user config |
| POST | /api/packages/create-order | Flutter | Create Razorpay order |
| POST | /api/packages/verify-payment | Flutter | Verify payment → add credits → create Transaction |
| GET | /api/packages/stats | Admin | Revenue stats |
| GET | /api/packages/config | Admin | Free credit config |
| PUT | /api/packages/config | Admin | Update free credit config |
| GET | /api/packages/approvals | Admin | Profile approval queue |
| PATCH | /api/packages/approvals/:id/approve | Admin | Approve → isVerified=true + FCM push |
| PATCH | /api/packages/approvals/:id/reject | Admin | Reject → FCM push |
| GET | /api/packages/list | Admin | List all packages |
| POST | /api/packages | Admin | Create package |
| PUT | /api/packages/:id | Admin | Update package |
| DELETE | /api/packages/:id | Admin | Delete package |

### 🔒 Privacy (Flutter)

| Method | Route | Description |
|--------|-------|-------------|
| GET | /api/privacy | Get privacy settings |
| PUT | /api/privacy | Update privacy settings |

### 📋 Dropdowns (Flutter)

| Method | Route | Description |
|--------|-------|-------------|
| GET | /api/dropdowns | All form options (religions, castes, heights etc.) |

### 🔔 Notifications (Flutter + Admin)

| Method | Route | Who | Description |
|--------|-------|-----|-------------|
| GET | /api/notifications/user | Flutter | My notifications |
| GET | /api/notifications | Admin | All notifications |
| POST | /api/notifications | Admin | Create + broadcast via FCM |
| PUT | /api/notifications/:id | Admin | Edit draft |
| DELETE | /api/notifications/:id | Admin | Delete |
| PATCH | /api/notifications/:id/send | Admin | Send draft via FCM |
| GET | /api/notifications/expiring | Admin | Expiring users list |
| POST | /api/notifications/send-expiry/:userId | Admin | Send expiry reminder |

### 👥 Users (Admin + Flutter report)

| Method | Route | Who | Description |
|--------|-------|-----|-------------|
| GET | /api/users | Admin | List all users |
| POST | /api/users | Admin | Create user |
| PUT | /api/users/:id | Admin | Update user |
| DELETE | /api/users/:id | Admin | Delete user |
| PATCH | /api/users/:id/credits | Admin | Add credits |
| PATCH | /api/users/:id/block | Admin | Toggle block → enforced in app via 403 |
| GET | /api/users/reports | Admin | All user reports |
| PATCH | /api/users/reports/:id/action | Admin | Warn / Suspend / Ban |
| POST | /api/users/report | Flutter | Report a user |

### 📊 Dashboard (Admin)

| Method | Route | Description |
|--------|-------|-------------|
| GET | /api/dashboard/stats | KPI cards |
| GET | /api/dashboard/revenue | Monthly revenue chart |
| GET | /api/dashboard/growth | Monthly user growth chart |
| GET | /api/dashboard/broadcasts | Recent notifications |

### 💳 Transactions (Admin)

| Method | Route | Description |
|--------|-------|-------------|
| GET | /api/transactions | List all transactions |
| DELETE | /api/transactions/:id | Delete transaction |
| GET | /api/transactions/stats | Revenue totals |

### 📞 Call Logs (Admin)

| Method | Route | Description |
|--------|-------|-------------|
| GET | /api/call-logs | All contact unlock logs |

### 🎧 Support (Flutter + Admin)

| Method | Route | Who | Description |
|--------|-------|-----|-------------|
| POST | /api/support/create | Flutter | Submit support ticket |
| GET | /api/support | Admin | All tickets |
| GET | /api/support/:id | Admin | Ticket + messages |
| POST | /api/support/:id/messages | Admin | Reply → FCM push to user |
| PATCH | /api/support/:id/status | Admin | Resolve / close |

### 📈 Reports (Admin)

| Method | Route | Description |
|--------|-------|-------------|
| GET | /api/reports | Report definitions |
| POST | /api/reports/generate | Trigger generation |
| GET | /api/reports/data?title=... | Get report data |

---

## 🔑 Default Login

```
Admin Panel URL:  http://YOUR_EC2_IP
Admin Email:      admin@matrimony.com
Admin Password:   Admin@123
```
⚠️ Change the password immediately after first login!

---

## 📱 Flutter API Endpoints Summary

Update `lib/data/constant/api.dart` to match these exact paths:

```dart
class Api {
  static const String baseUrl = 'http://YOUR_EC2_IP';
  static const String _api    = '$baseUrl/api';

  // Auth
  static const String signup        = '$_api/auth/signup';
  static const String login         = '$_api/auth/login';
  static const String verifyOtp     = '$_api/auth/verify-otp';
  static const String resendOtp     = '$_api/auth/resend-otp';
  static const String saveFcmToken  = '$_api/auth/save-fcm-token';

  // Profile
  static const String getMyProfile   = '$_api/profile/me';
  static const String updatePersonal = '$_api/profile/personal';
  static const String updateFamily   = '$_api/profile/family';
  static const String updateProfessional = '$_api/profile/professional';
  static const String updatePhysical = '$_api/profile/physical';

  // Home
  static const String homeDashboard  = '$_api/home/dashboard';
  static const String homeProfiles   = '$_api/home/profiles';

  // Gallery
  static const String gallery        = '$_api/gallery';
  static const String uploadGallery  = '$_api/gallery/upload';

  // Packages
  static const String packages       = '$_api/packages';
  static const String createOrder    = '$_api/packages/create-order';
  static const String verifyPayment  = '$_api/packages/verify-payment';

  // Privacy
  static const String privacy        = '$_api/privacy';

  // Dropdowns
  static const String dropdowns      = '$_api/dropdowns';

  // Notifications
  static const String notifications  = '$_api/notifications/user';

  // Support
  static const String createTicket   = '$_api/support/create';

  // Reports
  static const String reportUser     = '$_api/users/report';
}
```
