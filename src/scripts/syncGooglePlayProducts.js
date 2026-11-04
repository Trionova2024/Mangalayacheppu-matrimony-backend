/**
 * Sync existing packages to Google Play one-time products.
 *
 *   npm run google:sync-products            # create/update products on Google Play
 *   npm run google:sync-products -- --dry-run   # only show what would happen
 *
 * - Paid ACTIVE packages without a googlePlayProductId: a product ID is generated,
 *   the product is created on Google Play, and the ID is saved on the package.
 * - Paid packages that already have a googlePlayProductId: title, description, price
 *   and active/inactive state are pushed to Google Play.
 * - Free packages and INACTIVE packages without a product ID are skipped.
 *
 * Safe to run more than once.
 */

require("dotenv").config();
const prisma = require("../lib/prisma");
const {
  buildGooglePlayProductId,
  syncGooglePlayProduct,
} = require("../services/googlePlayCatalogService");

const dryRun = process.argv.includes("--dry-run");

async function main() {
  if (!process.env.GOOGLE_PLAY_PACKAGE_NAME) {
    throw new Error("GOOGLE_PLAY_PACKAGE_NAME is not set in .env");
  }

  const packages = await prisma.package.findMany({ orderBy: { amount: "asc" } });
  console.log(`${dryRun ? "[DRY RUN] " : ""}Found ${packages.length} package(s)\n`);

  const summary = { created: 0, updated: 0, skipped: 0, failed: 0 };

  for (const pkg of packages) {
    const label = `"${pkg.name}" (₹${pkg.amount}, ${pkg.status})`;

    if (!(pkg.amount > 0)) {
      console.log(`  skip    ${label}: free package`);
      summary.skipped++;
      continue;
    }
    if (!pkg.googlePlayProductId && pkg.status !== "ACTIVE") {
      console.log(`  skip    ${label}: inactive and not on Google Play`);
      summary.skipped++;
      continue;
    }

    const isNew = !pkg.googlePlayProductId;
    const productId = pkg.googlePlayProductId || buildGooglePlayProductId(pkg);
    const action = isNew ? "create" : "update";

    if (dryRun) {
      console.log(`  ${action}  ${label} -> ${productId}`);
      summary[isNew ? "created" : "updated"]++;
      continue;
    }

    try {
      await syncGooglePlayProduct(pkg, productId);
      if (isNew) {
        await prisma.package.update({ where: { id: pkg.id }, data: { googlePlayProductId: productId } });
      }
      console.log(`  ${action}  ${label} -> ${productId} ✓`);
      summary[isNew ? "created" : "updated"]++;
    } catch (err) {
      console.error(`  FAILED  ${label} -> ${productId}: ${err.message}`);
      summary.failed++;
    }
  }

  console.log(
    `\n${dryRun ? "[DRY RUN] " : ""}Created: ${summary.created}, Updated: ${summary.updated}, ` +
    `Skipped: ${summary.skipped}, Failed: ${summary.failed}`
  );
  return summary;
}

main()
  .then((summary) => {
    process.exitCode = summary.failed > 0 ? 1 : 0;
  })
  .catch((err) => {
    console.error("Sync failed:", err.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
