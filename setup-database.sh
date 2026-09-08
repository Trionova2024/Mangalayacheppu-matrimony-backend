#!/bin/bash
# ═══════════════════════════════════════════════════════════
# PostgreSQL Database Setup
# ═══════════════════════════════════════════════════════════
set -e

if [ -z "$DB_PASSWORD" ]; then
  echo "❌ Error: DB_PASSWORD environment variable is required."
  echo "Usage: DB_PASSWORD='YourSecurePassword' bash setup-database.sh"
  exit 1
fi

echo "🗄️  Setting up PostgreSQL database..."

sudo -u postgres psql << SQL
CREATE DATABASE matrimony_db;
CREATE USER matrimony_user WITH PASSWORD '$DB_PASSWORD';
GRANT ALL PRIVILEGES ON DATABASE matrimony_db TO matrimony_user;
ALTER DATABASE matrimony_db OWNER TO matrimony_user;
\q
SQL

echo "✅ Database created successfully!"
echo "   DB Name: matrimony_db"
echo "   DB User: matrimony_user"
echo ""
echo "Next: Run deploy-backend.sh"
