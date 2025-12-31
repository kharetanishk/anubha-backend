import prisma from "../../database/prismaclient";

export async function getSingleDoctorId() {
  // console.log(" [APPOINTMENT SERVICE] Fetching doctor/admin ID...");
  const doctor = await prisma.admin.findFirst();

  if (!doctor) {
    console.error(
      "❌ [APPOINTMENT SERVICE] Admin/Doctor not found in database"
    );
    throw new Error(
      "Admin/Doctor not found. Please ensure an admin account exists."
    );
  }

  // console.log(" [APPOINTMENT SERVICE] Doctor found:", {
  //   id: doctor.id,
  //   name: doctor.name,
  // });

  return doctor.id;
}
