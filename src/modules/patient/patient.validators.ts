import { z } from "zod";

export const GenderEnum = z.enum(["MALE", "FEMALE", "OTHER"]);
export const SleepQualityEnum = z.enum([
  "NORMAL",
  "IRREGULAR",
  "DISTURBED",
  "INSOMNIA",
]);
export const BowelMovementEnum = z.enum([
  "NORMAL",
  "CONSTIPATION",
  "DIARRHEA",
  "IRREGULAR",
]);

export const createPatientSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(100),

  phone: z
    .string()
    .min(10, "Mobile number must be at least 10 digits")
    .max(15, "Mobile number seems too long"),

  gender: GenderEnum,

  email: z.string().email("Enter a valid email address"),

  dateOfBirth: z
    .string()
    .refine((val) => !Number.isNaN(Date.parse(val)), "Invalid date format"),

  age: z
    .union([z.string(), z.number()])
    .transform((val) => Number(val))
    .refine((num) => !isNaN(num), { message: "Age must be a number" })
    .refine((num) => num >= 0 && num <= 120, {
      message: "Age must be between 0 and 120",
    }),

  address: z.string().min(5, "Address is too short"),

  weight: z
    .union([z.string(), z.number()])
    .transform(Number)
    .refine((n) => !isNaN(n) && n > 0, "Weight must be positive"),

  height: z
    .union([z.string(), z.number()])
    .transform(Number)
    .refine((n) => !isNaN(n) && n > 0, "Height must be positive"),

  neck: z
    .union([z.string(), z.number()])
    .transform(Number)
    .refine((n) => !isNaN(n) && n > 0, "Neck must be positive"),

  waist: z
    .union([z.string(), z.number()])
    .transform(Number)
    .refine((n) => !isNaN(n) && n > 0, "Waist must be positive"),

  hip: z
    .union([z.string(), z.number()])
    .transform(Number)
    .refine((n) => !isNaN(n) && n > 0, "Hip must be positive"),

  medicalHistory: z.string().optional(),
  fileIds: z.array(z.string().uuid()).optional(),
  appointmentConcerns: z.string().optional(),

  bowelMovement: BowelMovementEnum,

  dailyFoodIntake: z.string().optional(),

  dailyWaterIntake: z
    .union([z.string(), z.number()])
    .transform(Number)
    .refine((n) => !isNaN(n) && n >= 0, "Water intake must be a number"),

  wakeUpTime: z.string().min(2, "Invalid wakeup time"),
  sleepTime: z.string().min(2, "Invalid sleep time"),

  sleepQuality: SleepQualityEnum,
});

export type CreatePatientInput = z.infer<typeof createPatientSchema>;
