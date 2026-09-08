#!/bin/bash
# ═══════════════════════════════════════════════════════════
# Deploy Admin Panel
# ═══════════════════════════════════════════════════════════
set -e

# ⚠️  CHANGE THIS to your EC2 public IP before running
EC2_IP="13.53.205.192"

echo "🖥️  Deploying admin panel..."
cd /var/www/admin-matrimony

# Set API URL to EC2
echo "VITE_API_URL=http://${EC2_IP}/api" > .env

npm install
npm run build

echo "✅ Admin panel built!"
echo "   Output: /var/www/admin-matrimony/dist"
echo ""
echo "Next: Run setup-nginx.sh"
