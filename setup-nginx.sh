#!/bin/bash
# ═══════════════════════════════════════════════════════════
# Nginx Configuration
# ═══════════════════════════════════════════════════════════

# ⚠️  CHANGE THIS to your EC2 public IP before running
EC2_IP="13.53.205.192"

echo "🌐 Configuring Nginx..."

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

    # Gallery photo uploads
    location /uploads/ {
        proxy_pass http://localhost:4000/uploads/;
    }
}
NGINX

sudo nginx -t && sudo systemctl restart nginx

echo "✅ Nginx configured!"
echo "   Admin Panel: http://${EC2_IP}"
echo "   API:         http://${EC2_IP}/api"
