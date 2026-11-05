// Soft-delete helpers. Rows are never hard-deleted; records with isDeleted = true
// are hidden from the mobile app and the admin panel.
//
// Direct User queries are filtered automatically (src/lib/prisma.js). Use these
// filters when users are reached through a relation, or for transactions.

// Relation filter: the related (required) user is not deleted
const LIVE_USER = { isDeleted: false };

// Transactions visible in the admin panel: not deleted and owner not deleted
const VISIBLE_TRANSACTION = { isDeleted: false, user: LIVE_USER };

// Optional relation (SupportTicket.user): keep tickets with no user, hide deleted users' tickets
// (explicit userId: null — a NOT on a nullable FK can drop NULL rows in SQL)
const NOT_OWNED_BY_DELETED_USER = { OR: [{ userId: null }, { user: { isDeleted: false } }] };

// NotificationRecipient rows whose notification is not deleted
const VISIBLE_RECIPIENT = { notification: { isDeleted: false } };

module.exports = { LIVE_USER, VISIBLE_TRANSACTION, NOT_OWNED_BY_DELETED_USER, VISIBLE_RECIPIENT };
