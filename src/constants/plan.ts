export const PLANS = {
  "weightloss-3m": {
    name: "3-Month Weight Loss Plan",
    price: 17800,
    duration: "3 months",
    packageName: "8–10 kg weight loss",
  },

  "weightloss-6m": {
    name: "6-Month Weight Loss Plan",
    price: 26800,
    duration: "6 months",
    packageName: "17–20 kg weight loss",
  },

  "kids-nutrition": {
    name: "Kid’s Nutrition Plan",
    price: 5500,
    duration: "N/A",
    packageName: "Kids Nutrition Personalized Plan",
  },

  "baby-solid-food-blw": {
    name: "Baby Solid Food Plan (Baby-Led Weaning)",
    price: 5500,
    duration: "N/A",
    packageName: "BLW Method",
  },

  "baby-solid-food-traditional": {
    name: "Baby Solid Food Plan (Traditional Feeding)",
    price: 5500,
    duration: "N/A",
    packageName: "Traditional Feeding Method",
  },

  "medical-management": {
    name: "Medical Management Consultation",
    price: 5500,
    duration: "40 min",
    packageName: "Medical Consultation",
  },

  "prewedding-glow": {
    name: "Pre-Wedding Glow Plan",
    price: 3000,
    duration: "40 min",
    packageName: "Pre-Wedding Consultation",
  },

  "corporate-plan": {
    name: "Corporate Wellness Session",
    price: 6800,
    duration: "40 min",
    packageName: "Corporate Workshop",
  },

  "general-consultation": {
    name: "General Consultation (40 min)",
    price: 1, // Changed to ₹1 for testing
    duration: "40 min",
    packageName: "Consultation Session",
  },
} as const;

export type PlanSlug = keyof typeof PLANS;
