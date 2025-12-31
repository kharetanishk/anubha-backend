import prisma from "../../../database/prismaclient";
import { CreateRecallInput } from "./recall.validation";

export async function createRecall(data: CreateRecallInput, userId: string) {
  // console.log(" [RECALL SERVICE] Starting recall creation");
const { patientId, notes, entries, appointmentId } = data;

  // console.log(" [RECALL SERVICE] Verifying patient ownership...");
const patient = await prisma.patientDetials.findFirst({
    where: { id: patientId, userId },
  });
  if (!patient) {
    console.error(" [RECALL SERVICE] Patient not found or unauthorized");
    throw new Error("Invalid patient or unauthorized");
  }
  // console.log(" [RECALL SERVICE] Patient verified:", {
  // id: patient.id,
  // name: patient.name,
  // });
// If appointmentId is provided, verify it belongs to the same patient
  if (appointmentId) {
    // console.log(" [RECALL SERVICE] Verifying appointment ownership...");
const appointment = await prisma.appointment.findFirst({
      where: { id: appointmentId, patientId, userId },
    });
    if (!appointment) {
      console.error(" [RECALL SERVICE] Appointment not found or unauthorized");
      throw new Error("Invalid appointment or unauthorized");
    }
    // console.log(" [RECALL SERVICE] Appointment verified:", {
    // id: appointment.id,
    // status: appointment.status,
    // });
    // }

  // console.log(" [RECALL SERVICE] Creating recall with entries...");
const recall = await prisma.recall.create({
    data: {
      patientId,
      notes: notes ?? null,
      appointmentId: appointmentId ?? null,
      entries: {
        create: entries.map((e) => ({
          mealType: e.mealType as any,
          time: e.time,
          foodItem: e.foodItem,
          quantity: e.quantity,
          notes: e.notes ?? null,
        })),
      },
    },
    include: { entries: true },
  });

  // console.log(" [RECALL SERVICE] Recall created successfully:", {
  // id: recall.id,
  // entriesCount: recall.entries.length,
  // });
  // return recall;
  // }

export async function deleteRecallEntry(
  recallId: string,
  entryId: string,
  userId: string
) {
  // Verify recall belongs to user
  const recall = await prisma.recall.findFirst({
    where: {
      id: recallId,
      patient: { userId },
    },
    include: { entries: true },
  });

  if (!recall) {
    throw new Error("Recall not found or unauthorized");
  }

  // Verify entry belongs to this recall
  const entry = recall.entries.find((e) => e.id === entryId);
  if (!entry) {
    throw new Error("Entry not found in this recall");
  }

  await prisma.recallEntry.delete({
    where: { id: entryId },
  });

  return prisma.recall.findUnique({
    where: { id: recallId },
    include: { entries: true },
  });
}
