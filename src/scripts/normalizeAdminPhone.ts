/**
 * Script to normalize existing admin phone numbers in the database
 * This ensures all admin phones are stored in normalized format (916260440241)
 */

import prisma from "../database/prismaclient";
import { normalizePhoneNumber } from "../utils/phoneNormalizer";

async function normalizeAdminPhones() {
  // console.log("🔄 Normalizing admin phone numbers...\n");
try {
    // Get all admins
    const admins = await prisma.admin.findMany({
      select: { id: true, name: true, phone: true },
    });

    // console.log(`Found ${admins.length} admin(s)
    // in database\n`);

    for (const admin of admins) {
      // console.log(`Processing admin: ${admin.name}`);
// console.log(`  Current phone: ${admin.phone}`);
if (!admin.phone) {
        // console.log(`  ⚠️ Skipping admin with null phone number\n`);
continue;
      }

      try {
        // Normalize the phone number
        const normalizedPhone = normalizePhoneNumber(admin.phone);
        // console.log(`  Normalized phone: ${normalizedPhone}`);
// Only update if phone needs normalization
        if (admin.phone !== normalizedPhone) {
          const updated = await prisma.admin.update({
            where: { id: admin.id },
            data: { phone: normalizedPhone },
          });

          // console.log(`  ✅ Updated phone to: ${updated.phone}\n`);
} else {
          // console.log(`  ✓ Phone already normalized\n`);
}
      } catch (error: any) {
        console.error(`  ❌ Error normalizing phone: ${error.message}\n`);
      }
    }

    // console.log("✅ Phone normalization completed!");
} catch (error: any) {
    console.error("❌ Error normalizing admin phones:", error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Run the script
normalizeAdminPhones()
  .then(() => {
    // console.log("\n🎉 Script completed successfully!");
process.exit(0);
  })
  .catch((error) => {
    console.error("\n❌ Script failed:", error);
    process.exit(1);
  });
