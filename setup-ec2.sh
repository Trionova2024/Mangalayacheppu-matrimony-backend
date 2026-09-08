#!/bin/bash
# ═══════════════════════════════════════════════════════════
# Matrimony EC2 Setup Script — Run once on fresh Ubuntu 22.04
# ═══════════════════════════════════════════════════════════
set -e
echo "🚀 Starting Matrimony EC2 Setup..."

# ── System update ──────────────────────────────────────────
sudo apt update && sudo apt upgrade -y

# ── Node.js 18 ────────────────────────────────────────────
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# ── PostgreSQL ────────────────────────────────────────────
sudo apt install -y postgresql postgresql-contrib

# ── Nginx ─────────────────────────────────────────────────
sudo apt install -y nginx

# ── PM2 ───────────────────────────────────────────────────
sudo npm install -g pm2

# ── Create uploads folder ─────────────────────────────────
mkdir -p /var/www/matrimony-backend-v2/uploads

echo "✅ System setup complete!"
echo ""
echo "Next: Run setup-database.sh"
