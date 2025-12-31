/**
 * Script to list all admins in the database
 * Run with: ts-node src/scripts/listAdmins.ts
 */

import dotenv from "dotenv";
import prisma from "../database/prismaclient";

dotenv.config();

async function listAdmins() {
  try {
    // console.log("🔍 Fetching all admins from database...\n");
const admins = await prisma.admin.findMany({
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        createdAt: true,
        isArchived: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    if (admins.length === 0) {
      // console.log("❌ No admins found in database.");
// console.log("   Run: npm run seed");
} else {
      // console.log(`✅ Found ${admins.length} admin(s)
      // :\n`);
      admins.forEach((admin, index) => {
        // console.log(`${index + 1}. Admin:`);
// console.log(`   ID: ${admin.id}`);
// console.log(`   Name: ${admin.name}`);
// console.log(
// `   Phone: ${admin.phone || "N/A"} (length: ${
// admin.phone?.length || 0
// })
// `
// );
        // console.log(`   Email: ${admin.email}`);
// console.log(`   Created: ${admin.createdAt}`);
// console.log(`   Archived: ${admin.isArchived}`);
// console.log("");
});
    }
  } catch (error: any) {
    console.error("❌ Error listing admins:", error.message);
  } finally {
    await prisma.$disconnect();
  }
}

listAdmins();
