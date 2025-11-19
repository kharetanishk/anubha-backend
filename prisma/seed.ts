import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const ADMIN_EMAIL = "tanu@gmail.com";
  const ADMIN_PHONE = "+916260440241";

  const admin = await prisma.admin.upsert({
    where: { email: ADMIN_EMAIL },
    update: {
      phone: ADMIN_PHONE, // in case you change phone later
      name: "Super Admin",
    },
    create: {
      name: "Super Admin",
      email: ADMIN_EMAIL,
      phone: ADMIN_PHONE,
    },
  });

  console.log("✅ Admin seeded:", admin);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
