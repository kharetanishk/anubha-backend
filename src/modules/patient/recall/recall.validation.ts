import { z } from "zod";

export const recallEntrySchema = z.object({
  mealType: z.enum([
    "PRE_WAKEUP",
    "BREAKFAST",
    "MID_MEAL",
    "LUNCH",
    "MID_EVENING",
    "DINNER",
    "OTHER",
  ]),
  time: z.string().min(1),
  foodItem: z.string().min(1),
  quantity: z.string().min(1),
  notes: z.string().optional(),
});

export const createRecallSchema = z.object({
  patientId: z.string().uuid(),
  notes: z.string().optional(),
  entries: z.array(recallEntrySchema).min(1),
  appointmentId: z.string().uuid(), // ✅ Required - removed .optional()
});

export type CreateRecallInput = z.infer<typeof createRecallSchema>;
