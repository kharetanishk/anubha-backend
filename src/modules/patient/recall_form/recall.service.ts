import prisma from "../../../database/prismaclient";
import { CreateRecallInput } from "./recall.validation";

export async function createRecall(data: CreateRecallInput, userId: string) {
  const { patientId, notes, entries } = data;

  const patient = await prisma.patientDetials.findFirst({
    where: { id: patientId, userId },
  });
  if (!patient) throw new Error("Invalid patient or unauthorized");

  const recall = await prisma.recall.create({
    data: {
      patientId,
      notes: notes ?? null,
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

  return recall;
}

export async function deleteRecallEntry(recallId: string, entryId: string) {
  await prisma.recallEntry.delete({
    where: { id: entryId },
  });

  return prisma.recall.findUnique({
    where: { id: recallId },
    include: { entries: true },
  });
}
