#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# MATRIMONY — MASTER DEPLOY SCRIPT
# EC2: 13.53.205.192  |  Ubuntu 22.04
# Run: bash DEPLOY_ALL.sh
# ═══════════════════════════════════════════════════════════════
set -e

EC2_IP="13.53.205.192"

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║   MATRIMONY FULL DEPLOYMENT STARTING...      ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ── STEP 1: System Update ──────────────────────────────────────
echo "📦 STEP 1: Installing system dependencies..."
sudo apt update -y && sudo apt upgrade -y

# Node.js 18
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# PostgreSQL
sudo apt install -y postgresql postgresql-contrib

# Nginx
sudo apt install -y nginx

# PM2
sudo npm install -g pm2

echo "✅ System dependencies installed"
echo ""

# ── STEP 2: PostgreSQL Setup ───────────────────────────────────
echo "🗄️  STEP 2: Setting up PostgreSQL database..."

if [ -z "$DB_PASSWORD" ]; then
  echo "⚠️  DB_PASSWORD not set. Using secure random password or prompt."
  DB_PASSWORD=$(openssl rand -base64 16)
fi

sudo -u postgres psql << SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'matrimony_user') THEN
    CREATE USER matrimony_user WITH PASSWORD '$DB_PASSWORD';
  END IF;
END
\$\$;
SELECT 'CREATE DATABASE matrimony_db' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'matrimony_db')\\gexec
GRANT ALL PRIVILEGES ON DATABASE matrimony_db TO matrimony_user;
ALTER DATABASE matrimony_db OWNER TO matrimony_user;
SQL

echo "✅ Database ready"
echo ""

# ── STEP 3: Backend Setup ──────────────────────────────────────
echo "🚀 STEP 3: Deploying backend API..."

cd /var/www/matrimony-backend-v2

# Create uploads folder
mkdir -p uploads

# Install dependencies
npm install

# Copy production env
cp .env.production .env

# Generate Prisma client + push schema
npx prisma generate
npx prisma db push --accept-data-loss

# Seed admin account + sample data
node src/lib/seed.js

# Start with PM2
pm2 delete matrimony-api 2>/dev/null || true
pm2 start src/index.js --name "matrimony-api"
pm2 save
pm2 startup systemd -u ubuntu --hp /home/ubuntu | tail -1 | sudo bash || true

echo "✅ Backend API running on port 4000"
echo ""

# ── STEP 4: Admin Panel Build ──────────────────────────────────
echo "🖥️  STEP 4: Building admin panel..."

cd /var/www/admin-matrimony

# Set API URL
echo "VITE_API_URL=http://${EC2_IP}/api" > .env

npm install
npm run build

echo "✅ Admin panel built → /var/www/admin-matrimony/dist"
echo ""

# ── STEP 5: Nginx Configuration ───────────────────────────────
echo "🌐 STEP 5: Configuring Nginx..."

sudo tee /etc/nginx/sites-available/default > /dev/null << NGINX
server {
    listen 80;
    server_name ${EC2_IP};

    client_max_body_size 10M;

    # Admin Panel (React)
    location / {
        root /var/www/admin-matrimony/dist;
        try_files \$uri /index.html;
    }

    # Backend API
    location /api/ {
        proxy_pass         http://localhost:4000/api/;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade \$http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_cache_bypass \$http_upgrade;
    }

    # Gallery uploads
    location /uploads/ {
        proxy_pass http://localhost:4000/uploads/;
    }
}
NGINX

sudo nginx -t && sudo systemctl restart nginx
sudo systemctl enable nginx

echo "✅ Nginx configured"
echo ""

# ── FINAL: Health Check ────────────────────────────────────────
echo "🔍 Running health check..."
sleep 3

HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:4000/health)
if [ "$HTTP_STATUS" = "200" ]; then
  echo "✅ Backend API is healthy"
else
  echo "⚠️  Backend returned status: $HTTP_STATUS"
  echo "Check logs: pm2 logs matrimony-api"
fi

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║            DEPLOYMENT COMPLETE! 🎉                       ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║                                                          ║"
echo "║  Admin Panel : http://13.53.205.192                     ║"
echo "║  API         : http://13.53.205.192/api                 ║"
echo "║  Health      : http://13.53.205.192/health              ║"
echo "║                                                          ║"
echo "║  Admin Login                                             ║"
echo "║  Email    : ${ADMIN_EMAIL:-admin@matrimony.com}                   ║"
echo "║  Password : (Set via ADMIN_PASSWORD environment variable) ║"
echo "║                                                          ║"
echo "║  Flutter api.dart → update _domain to:                  ║"
echo "║  http://13.53.205.192                                    ║"
echo "║                                                          ║"
echo "╚══════════════════════════════════════════════════════════╝"
