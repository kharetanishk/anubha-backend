/**
 * Seed script to create admin and generate slots for November and December 2025
 * Run with: npm run seed:slots
 */

import dotenv from "dotenv";
import { generateSlotsForRange } from "../modules/slots/slots.services";
import { APPOINTMENT_MODES } from "../modules/slots/slots.constants";
import prisma from "../database/prismaclient";

// Load environment variables
dotenv.config();

async function createAdminIfNotExists() {
  try {
    // Check if admin already exists
    const existingAdmin = await prisma.admin.findFirst();

    if (existingAdmin) {
      // console.log(" Admin already exists:", existingAdmin.name);
return existingAdmin.id;
    }

    // Create default admin
    // console.log("👤 Creating admin...");
const bcrypt = require("bcryptjs");
    const hashedPassword = await bcrypt.hash("admin@123", 10);
    const admin = await prisma.admin.create({
      data: {
        name: "Dr. Anubha",
        email: "admin@nutriwell.com",
        phone: "9999999999",
        password: hashedPassword,
      },
    });

    // console.log(` Admin created successfully: ${admin.name} (${admin.email})
    // `);
    return admin.id;
  } catch (error: any) {
    console.error(" Error creating admin:", error.message);
    throw error;
  }
}

async function seedSlots() {
  try {
    // console.log("🌱 Starting seed process for November and December 2025...\n");
// Step 1: Create admin if not exists
    await createAdminIfNotExists();
    // console.log("");
// Step 2: Generate slots for November 2025
    // console.log("📅 Generating slots for November 2025...");
const novemberResult = await generateSlotsForRange({
      startDate: "2025-11-01",
      endDate: "2025-11-30",
      modes: [APPOINTMENT_MODES.IN_PERSON, APPOINTMENT_MODES.ONLINE],
    });
    // console.log(` November: Created ${novemberResult.createdCount} slots\n`);
// Step 3: Generate slots for December 2025
    // console.log("📅 Generating slots for December 2025...");
const decemberResult = await generateSlotsForRange({
      startDate: "2025-12-01",
      endDate: "2025-12-31",
      modes: [APPOINTMENT_MODES.IN_PERSON, APPOINTMENT_MODES.ONLINE],
    });
    // console.log(` December: Created ${decemberResult.createdCount} slots\n`);
const totalSlots =
      novemberResult.createdCount + decemberResult.createdCount;

    // console.log("🎉 Seed process completed!");
// console.log(`📊 Total slots created: ${totalSlots}`);
// console.log(`   - November: ${novemberResult.createdCount} slots`);
// console.log(`   - December: ${decemberResult.createdCount} slots`);
// console.log("\n✨ Note: Sundays and day-offs are automatically skipped.");
} catch (error: any) {
    console.error(" Error in seed process:", error.message);
    throw error;
  }
}

// Run the seed function
seedSlots()
  .then(async () => {
    // console.log("\n Seed script completed successfully!");
await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error("\n Seed script failed:", error);
    await prisma.$disconnect();
    process.exit(1);
  });
