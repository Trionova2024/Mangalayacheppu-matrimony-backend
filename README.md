💍 Mangalayacheppu Matrimony — Backend

A production-oriented REST API backend for the Mangalayacheppu Matrimony Platform, supporting authentication, profile discovery, interests/swipes, contact access, notifications, packages, payments, admin operations, reports, call logs, and profile management.

Built with Node.js, Express.js, PostgreSQL, and Prisma ORM, with security controls and database-level safeguards for critical business operations.

✨ Core Features

🔐 Authentication & Security

JWT-based authentication and authorization

Admin and user authentication middleware

JWT expiration and malformed Bearer-token validation

Production environment validation

Auth-specific and general API rate limiting

Strict production CORS configuration

Production-safe error sanitization

👤 User & Profile Management

User registration/login

Profile creation and updates

DOB and age handling

Profile verification and status management

Gallery/image support

Admin user management

Profile activation/deactivation

Gender, religion, caste, location, education, and occupation data

🔎 Profile Discovery

Supports filtering by:

Minimum/maximum age

Gender

Religion

Caste

Native/location

Education

Occupation

Profile visibility rules account for:

Current user

Inactive profiles

Blocked profiles

Unverified profiles

Previously swiped profiles where applicable

❤️ Interests & Swipes

Interest/like handling

Swipe tracking

Interest retrieval

Duplicate interaction protection

Relationship-aware profile queries

💰 Credits & Contact Unlock

Credit-based contact access

Free contact allowance

Atomic credit operations

Credit audit logging

Negative-balance database protection

Transaction-safe unlock operations

💳 Packages & Payments

Package creation and management

Credit and amount validation

Payment transaction tracking

Success/failure/cancellation handling

Payment status management

Monthly revenue aggregation

Transaction reporting

🎁 Free Offer Protection

The free-offer flow is protected against duplicate and concurrent claims through:

Database transactions

Partial unique database index

Credit balance constraints

This prevents the same user from receiving the free offer multiple times for the same package.

🔔 Notifications

User notifications

Notification recipients

Read/unread state

Read timestamps

Notification management

Expiry-related notification support

📞 Call Logs

Call history

User/locker relationships

Pagination

Date-based filtering:

Today

This Week

This Month

This Year

📊 Dashboard & Reports

Dashboard statistics

Monthly revenue

Transaction summaries

User reports

Transaction reports

Date-based filtering

Pagination

Success-rate calculations

Revenue aggregation

🛡️ Privacy & Support

Privacy-related APIs

Support APIs

User-specific access controls

🏗️ Technology Stack

Layer

Technology

Runtime

Node.js

Framework

Express.js

Language

JavaScript

Database

PostgreSQL

ORM

Prisma

Authentication

JWT

Authentication Support

Firebase Admin

API Testing

Postman

Security

CORS, Rate Limiting, Validation

Package Manager

npm

Version Control

Git / GitHub

📁 Project Structure

matrimony-backend-v2/
├── src/
│   ├── index.js
│   ├── lib/
│   │   ├── firebase.js
│   │   ├── prisma.js
│   │   └── seed.js
│   ├── middleware/
│   │   ├── adminAuth.js
│   │   ├── rateLimiter.js
│   │   └── userAuth.js
│   ├── routes/
│   │   ├── auth.js
│   │   ├── callLogs.js
│   │   ├── dashboard.js
│   │   ├── dropdowns.js
│   │   ├── gallery.js
│   │   ├── home.js
│   │   ├── notifications.js
│   │   ├── packages.js
│   │   ├── privacy.js
│   │   ├── profile.js
│   │   ├── reports.js
│   │   ├── support.js
│   │   ├── transactions.js
│   │   └── users.js
│   └── utils/
│       ├── age.js
│       └── swipe.js
├── prisma/
│   ├── schema.prisma
│   └── migrations/
├── postman/
├── .env.example
├── .gitignore
├── package.json
├── package-lock.json
└── README.md

🗄️ Database & Prisma

The backend uses PostgreSQL with Prisma ORM.

Schema

prisma/schema.prisma

Migration history

prisma/migrations/
├── 0_init/
├── 20260904000000_add_indexes_and_credit_audit_log/
└── 20260907000000_add_free_offer_and_credit_checks/

Database hardening

The database includes:

Non-negative credit constraints

Non-negative free-contact constraints

Unique protection for free-offer claims

Query-performance indexes

Referential integrity

Transaction-safe critical mutations

🧪 QA & Bug-Fix Verification

The backend was audited against the project's QA defect list and subsequent retest requirements.

Verification covered:

User validation

User creation/update

Credit validation

Package validation

Dashboard revenue

Transaction calculations

Reports

Profile filtering

Blocked/inactive profile exclusion

Swiped profile exclusion

Notification state

Payment cancellation

Authentication/session handling

Free-offer concurrency

Name synchronization

Database constraints

Security controls

Temporary QA/testing artifacts are intentionally excluded from the Git repository.

Verification note: automated unit/mock tests validate application logic. Full production confidence additionally requires integration testing against the real PostgreSQL database and deployed API.

🚀 Getting Started

1. Clone

git clone https://github.com/Trionova2024/Mangalayacheppu-matrimony-backend.git
cd Mangalayacheppu-matrimony-backend

2. Install dependencies

npm install

3. Configure environment

Create a local .env using .env.example as the template.

Never commit real credentials.

4. Generate Prisma Client

npx prisma generate

5. Apply migrations

npx prisma migrate deploy

6. Start the server

Use the npm scripts defined in package.json, for example:

npm start

🔌 API Modules

The backend provides modules for:

/auth
/users
/profile
/home
/gallery
/notifications
/packages
/transactions
/dashboard
/reports
/call-logs
/dropdowns
/privacy
/support

Authentication and request requirements are defined in src/routes/.

📮 Postman

Postman collections and environments are maintained under:

postman/

They can be used for API verification across authentication, users, profiles, packages, transactions, notifications, reports, and admin functionality.

🌍 Deployment

Deployment and infrastructure scripts include:

DEPLOY_ALL.sh
deploy-admin.sh
deploy-backend.sh
setup-database.sh
setup-ec2.sh
setup-nginx.sh

Review environment-specific configuration before execution.

Production secrets must be supplied through environment variables or a secret-management system.

🔐 Environment & Secrets

Use:

.env.example

as the safe configuration template.

Never commit:

.env
.env.production
.env.local

or files containing real:

Database credentials

JWT secrets

Firebase credentials

Payment gateway secrets

API keys

Private keys

📈 Production-Oriented Improvements

✅ Modular Express backend

✅ PostgreSQL + Prisma

✅ Versioned Prisma migrations

✅ Database constraints

✅ Performance indexes

✅ ACID transactions

✅ JWT authentication

✅ Admin authorization

✅ Rate limiting

✅ Strict CORS

✅ Production error sanitization

✅ Environment validation

✅ Server-side input validation

✅ Credit audit logging

✅ Free-offer concurrency protection

✅ Postman API collection

📌 Development Guidelines

Validate all client-controlled input on the server.

Never rely only on frontend validation.

Use transactions for related critical mutations.

Use database constraints for rules that must never be violated.

Preserve Prisma migration history.

Keep API contracts backward compatible where possible.

Never expose internal errors or secrets.

Test both success and failure scenarios.

Keep production source code separate from temporary QA artifacts.

Review git status before every production push.

🧾 Repository Hygiene

The repository intentionally excludes local/generated artifacts such as:

node_modules/
.env.production
test/
coverage/
temporary QA reports
temporary audit artifacts
logs

Production source code, configuration templates, Prisma schema, and Prisma migrations remain tracked.

📄 License

This project is proprietary software developed for the Mangalayacheppu Matrimony Platform.

Unauthorized copying, redistribution, or commercial use is not permitted without appropriate authorization.

👨‍💻 Maintained By

Trionova Technologies Pvt. Ltd.

Repository: Trionova2024/Mangalayacheppu-matrimony-backend
