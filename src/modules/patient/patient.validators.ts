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

export const FoodPreference = z.enum(["VEG", "NON_VEG", "EGG_VEG"]);

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

  // Optional basic measurements
  neck: z
    .union([z.string(), z.number(), z.null(), z.undefined()])
    .transform((val) => {
      if (val === null || val === undefined || val === "") return undefined;
      const num = Number(val);
      return isNaN(num) ? undefined : num;
    })
    .optional()
    .refine((n) => n === undefined || n > 0, "Neck must be positive"),

  waist: z
    .union([z.string(), z.number(), z.null(), z.undefined()])
    .transform((val) => {
      if (val === null || val === undefined || val === "") return undefined;
      const num = Number(val);
      return isNaN(num) ? undefined : num;
    })
    .optional()
    .refine((n) => n === undefined || n > 0, "Waist must be positive"),

  hip: z
    .union([z.string(), z.number(), z.null(), z.undefined()])
    .transform((val) => {
      if (val === null || val === undefined || val === "") return undefined;
      const num = Number(val);
      return isNaN(num) ? undefined : num;
    })
    .optional()
    .refine((n) => n === undefined || n > 0, "Hip must be positive"),

  // Optional detailed measurements (for weight loss plan)
  chest: z
    .union([z.string(), z.number(), z.null(), z.undefined()])
    .transform((val) => {
      if (val === null || val === undefined || val === "") return undefined;
      const num = Number(val);
      return isNaN(num) ? undefined : num;
    })
    .optional()
    .refine((n) => n === undefined || n > 0, "Chest must be positive"),

  chestFemale: z
    .union([z.string(), z.number(), z.null(), z.undefined()])
    .transform((val) => {
      if (val === null || val === undefined || val === "") return undefined;
      const num = Number(val);
      return isNaN(num) ? undefined : num;
    })
    .optional()
    .refine((n) => n === undefined || n > 0, "Chest female must be positive"),

  normalChestLung: z
    .union([z.string(), z.number(), z.null(), z.undefined()])
    .transform((val) => {
      if (val === null || val === undefined || val === "") return undefined;
      const num = Number(val);
      return isNaN(num) ? undefined : num;
    })
    .optional()
    .refine(
      (n) => n === undefined || n > 0,
      "Normal chest lung must be positive"
    ),

  expandedChestLungs: z
    .union([z.string(), z.number(), z.null(), z.undefined()])
    .transform((val) => {
      if (val === null || val === undefined || val === "") return undefined;
      const num = Number(val);
      return isNaN(num) ? undefined : num;
    })
    .optional()
    .refine(
      (n) => n === undefined || n > 0,
      "Expanded chest lungs must be positive"
    ),

  arms: z
    .union([z.string(), z.number(), z.null(), z.undefined()])
    .transform((val) => {
      if (val === null || val === undefined || val === "") return undefined;
      const num = Number(val);
      return isNaN(num) ? undefined : num;
    })
    .optional()
    .refine((n) => n === undefined || n > 0, "Arms must be positive"),

  forearms: z
    .union([z.string(), z.number(), z.null(), z.undefined()])
    .transform((val) => {
      if (val === null || val === undefined || val === "") return undefined;
      const num = Number(val);
      return isNaN(num) ? undefined : num;
    })
    .optional()
    .refine((n) => n === undefined || n > 0, "Forearms must be positive"),

  wrist: z
    .union([z.string(), z.number(), z.null(), z.undefined()])
    .transform((val) => {
      if (val === null || val === undefined || val === "") return undefined;
      const num = Number(val);
      return isNaN(num) ? undefined : num;
    })
    .optional()
    .refine((n) => n === undefined || n > 0, "Wrist must be positive"),

  abdomenUpper: z
    .union([z.string(), z.number(), z.null(), z.undefined()])
    .transform((val) => {
      if (val === null || val === undefined || val === "") return undefined;
      const num = Number(val);
      return isNaN(num) ? undefined : num;
    })
    .optional()
    .refine((n) => n === undefined || n > 0, "Abdomen upper must be positive"),

  abdomenLower: z
    .union([z.string(), z.number(), z.null(), z.undefined()])
    .transform((val) => {
      if (val === null || val === undefined || val === "") return undefined;
      const num = Number(val);
      return isNaN(num) ? undefined : num;
    })
    .optional()
    .refine((n) => n === undefined || n > 0, "Abdomen lower must be positive"),

  thighUpper: z
    .union([z.string(), z.number(), z.null(), z.undefined()])
    .transform((val) => {
      if (val === null || val === undefined || val === "") return undefined;
      const num = Number(val);
      return isNaN(num) ? undefined : num;
    })
    .optional()
    .refine((n) => n === undefined || n > 0, "Thigh upper must be positive"),

  thighLower: z
    .union([z.string(), z.number(), z.null(), z.undefined()])
    .transform((val) => {
      if (val === null || val === undefined || val === "") return undefined;
      const num = Number(val);
      return isNaN(num) ? undefined : num;
    })
    .optional()
    .refine((n) => n === undefined || n > 0, "Thigh lower must be positive"),

  calf: z
    .union([z.string(), z.number(), z.null(), z.undefined()])
    .transform((val) => {
      if (val === null || val === undefined || val === "") return undefined;
      const num = Number(val);
      return isNaN(num) ? undefined : num;
    })
    .optional()
    .refine((n) => n === undefined || n > 0, "Calf must be positive"),

  ankle: z
    .union([z.string(), z.number(), z.null(), z.undefined()])
    .transform((val) => {
      if (val === null || val === undefined || val === "") return undefined;
      const num = Number(val);
      return isNaN(num) ? undefined : num;
    })
    .optional()
    .refine((n) => n === undefined || n > 0, "Ankle must be positive"),

  medicalHistory: z.string().optional(),
  fileIds: z.array(z.string().uuid()).optional(),
  appointmentConcerns: z.string().optional(),

  bowelMovement: BowelMovementEnum,
  foodPreference: FoodPreference,

  allergic: z.string().optional(),

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
