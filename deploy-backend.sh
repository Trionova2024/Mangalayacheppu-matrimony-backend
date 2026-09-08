#!/bin/bash
# ═══════════════════════════════════════════════════════════
# Deploy Backend
# ═══════════════════════════════════════════════════════════
set -e
echo "📦 Deploying backend..."

cd /var/www/matrimony-backend-v2

# Install dependencies
npm install

# Copy production env (EDIT THIS FILE FIRST with your Razorpay keys + EC2 IP)
cp .env.production .env

# Push DB schema
npx prisma generate
npx prisma db push

# Seed admin + sample data
node src/lib/seed.js

# Start with PM2
pm2 delete matrimony-api 2>/dev/null || true
pm2 start src/index.js --name "matrimony-api"
pm2 save
pm2 startup

echo "✅ Backend deployed!"
echo "   API running at: http://localhost:4000"
echo "   Health check:   http://localhost:4000/health"
echo ""
echo "Next: Run deploy-admin.sh"
