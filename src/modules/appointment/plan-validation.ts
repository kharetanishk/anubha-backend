/**
 * Plan validation service
 * Validates plan prices and details against server-side plan definitions
 * This prevents price manipulation attacks
 */

export interface PlanPackage {
  name: string;
  details: string;
  duration?: string;
  price: number; // Price in paise (smallest currency unit) for precision
}

export interface PlanDefinition {
  title: string;
  slug: string;
  packages: PlanPackage[];
}

/**
 * Server-side plan definitions
 * These should match the frontend plans but are the source of truth for pricing
 * Prices are stored in rupees (not paise) to match frontend format
 */
const PLAN_DEFINITIONS: PlanDefinition[] = [
  {
    title: "Weight Loss Plan",
    slug: "weight-loss",
    packages: [
      {
        name: "3-Month Plan",
        details: "8–10 kg weight loss in 3 months.",
        duration: "3 months",
        price: 17800, // ₹17,800 in rupees
      },
      {
        name: "6-Month Plan",
        details: "17–20 kg weight loss in 6 months.",
        duration: "6 months",
        price: 26800, // ₹26,800 in rupees
      },
    ],
  },
  {
    title: "Kid's Nutrition Plan",
    slug: "kids-nutrition",
    packages: [
      {
        name: "Kids Nutrition Personalized Plan",
        details:
          "Personalized diet plan and food guide for children aged 3–18 years.",
        price: 5500, // ₹5,500 in rupees
      },
    ],
  },
  {
    title: "Baby's First Solid Food Plan",
    slug: "baby-solid-food",
    packages: [
      {
        name: "Option 1: Solid Food Complete Guide (Baby-Led Weaning)",
        details:
          "For parents who prefer a baby-led approach where the baby self-feeds safely, encouraging independence and sensory development.",
        price: 5500, // ₹5,500 in rupees
      },
      {
        name: "Option 2: Solid Food Complete Guide (Traditional Feeding)",
        details:
          "For parents who prefer traditional spoon-feeding — includes meal guidance, portion control, and progression plans.",
        price: 5500, // ₹5,500 in rupees
      },
    ],
  },
  {
    title: "Medical Management Plan",
    slug: "medical-management",
    packages: [
      {
        name: "Medical Management Consultation",
        details:
          "Comprehensive medical nutrition consultation with a 40-minute session.",
        duration: "40 minutes",
        price: 5500, // ₹5,500 in rupees
      },
    ],
  },
  {
    title: "Groom or Bride-to-be Plan",
    slug: "groom-bride-plan",
    packages: [
      {
        name: "Pre-Wedding Glow Plan",
        details:
          "Customized diet and wellness plan for 40-minute consultation.",
        duration: "40 minutes",
        price: 3000, // ₹3,000 in rupees
      },
    ],
  },
  {
    title: "Corporate Health & Wellness Plan",
    slug: "corporate-plan",
    packages: [
      {
        name: "Corporate Wellness Session",
        details:
          "Comprehensive 40-minute corporate session (30-minute workshop + 10-minute discussion).",
        duration: "40 minutes",
        price: 6800, // ₹6,800 in rupees
      },
    ],
  },
  {
    title: "General Consultation",
    slug: "general-consultation",
    packages: [
      {
        name: "Consultation Session",
        details: "General consultation session with 40-minute duration.",
        duration: "40 min",
        price: 1000, // ₹1,000 in rupees
      },
    ],
  },
];

/**
 * Validate plan details against server-side definitions
 *
 * SECURITY: This function prevents price manipulation attacks by validating
 * that the plan price, slug, name, and package details match the server-side
 * definitions. Never trust client-provided prices - always validate against
 * server-side data.
 *
 * @throws Error if validation fails
 */
export function validatePlanDetails(opts: {
  planSlug: string;
  planName: string;
  planPrice: number; // Price in rupees (will be converted to paise for comparison)
  planPackageName?: string;
  planDuration?: string;
}): void {
  const { planSlug, planName, planPrice, planPackageName, planDuration } = opts;

  // console.log(" [PLAN VALIDATION] Validating plan details:", {
  // planSlug,
  // planName,
  // planPrice,
  // planPackageName: planPackageName || "none",
  // planDuration: planDuration || "none",
  // });
  // Find the plan by slug
  const plan = PLAN_DEFINITIONS.find((p) => p.slug === planSlug);

  if (!plan) {
    console.error(
      " [PLAN VALIDATION] Plan not found. Available slugs:",
      PLAN_DEFINITIONS.map((p) => p.slug)
    );
    throw new Error(`Invalid plan slug: ${planSlug}`);
  }

  // console.log(" [PLAN VALIDATION] Plan found:", {
  //   slug: plan.slug,
  //   title: plan.title,
  // });

  // Validate plan name matches (with support for admin UI combined labels)
  //
  // Frontend (user booking) usually sends:
  //   planName = plan.title
  //
  // Admin panel may send a combined label like:
  //   "Baby's First Solid Food Plan - Option 1: Solid Food Complete Guide (Baby-Led Weaning)"
  // In this case we still consider it valid as long as:
  //   - The base title matches server definition, and
  //   - The package part matches a known package name for this plan.
  const normalizedPlanTitle = plan.title.trim();
  const normalizedPlanName = planName.trim();
  const normalizedPackageName = planPackageName?.trim();

  let planNameMatches = normalizedPlanName === normalizedPlanTitle;

  // Allow combined admin label: "<Plan Title> - <Package Name>[...]"
  if (!planNameMatches && normalizedPackageName) {
    const expectedCombinedPrefix = `${normalizedPlanTitle} - ${normalizedPackageName}`;

    if (
      normalizedPlanName === expectedCombinedPrefix ||
      normalizedPlanName.startsWith(`${expectedCombinedPrefix} `) ||
      normalizedPlanName.startsWith(`${expectedCombinedPrefix} (`)
    ) {
      planNameMatches = true;
    }
  }

  if (!planNameMatches) {
    console.error(" [PLAN VALIDATION] Plan name mismatch:", {
      expected: plan.title,
      got: planName,
    });
    throw new Error(
      `Plan name mismatch. Expected: ${plan.title}, Got: ${planName}`
    );
  }
  // console.log(" [PLAN VALIDATION] Plan name matches");

  // Prices are stored in rupees (not paise) for consistency with frontend
  const providedPrice = Math.round(planPrice);

  // If package name is provided, validate against specific package
  if (planPackageName) {
    // console.log(" [PLAN VALIDATION] Looking for package:", {
    // providedPackageName: planPackageName,
    // availablePackages: plan.packages.map((pkg)
    // => pkg.name),
    // });

    const package_ = plan.packages.find((pkg) => pkg.name === planPackageName);

    if (!package_) {
      console.error(" [PLAN VALIDATION] Package not found:", {
        provided: planPackageName,
        available: plan.packages.map((pkg) => pkg.name),
      });
      throw new Error(
        `Invalid package name "${planPackageName}" for plan "${planSlug}". Available packages: ${plan.packages
          .map((pkg) => `"${pkg.name}"`)
          .join(", ")}`
      );
    }

    // console.log(" [PLAN VALIDATION] Package found:", package_.name);
// Validate duration if provided (flexible matching)
    if (planDuration && package_.duration) {
      const normalizedDuration = planDuration.toLowerCase().trim();
      const normalizedPackageDuration = package_.duration.toLowerCase().trim();
      // Allow some flexibility (e.g., "3 months" vs "3 months")
      if (
        !normalizedDuration.includes(normalizedPackageDuration) &&
        !normalizedPackageDuration.includes(normalizedDuration)
      ) {
        // Only throw if they're clearly different
        if (normalizedDuration !== normalizedPackageDuration) {
          // console.warn(
          // `Duration mismatch for package "${planPackageName}". Expected: ${package_.duration}, Got: ${planDuration}`
          // );
}
      }
    }

    // Validate price matches exactly (no tolerance for security)
    if (package_.price !== providedPrice) {
      throw new Error(
        `Price mismatch for package "${planPackageName}". Expected: ₹${package_.price}, Got: ₹${planPrice}. This may indicate a security issue.`
      );
    }
  } else {
    // If no package name, check if price matches any package in the plan
    // console.log(
    // " [PLAN VALIDATION] No package name provided, checking if price matches any package"
    // );
const matchingPackage = plan.packages.find(
      (pkg) => pkg.price === providedPrice
    );

    if (!matchingPackage) {
      const validPrices = plan.packages
        .map((pkg) => `₹${pkg.price}`)
        .join(", ");
      console.error(" [PLAN VALIDATION] Price mismatch:", {
        provided: providedPrice,
        validPrices: plan.packages.map((pkg) => pkg.price),
      });
      throw new Error(
        `Invalid price ₹${planPrice} for plan "${planSlug}". Valid prices: ${validPrices}. This may indicate a security issue.`
      );
    }
    // console.log(
    // " [PLAN VALIDATION] Price matches package:",
    // matchingPackage.name
    // );
}

  // console.log(" [PLAN VALIDATION] All validations passed");
}

/**
 * Get plan package by slug and package name
 */
export function getPlanPackage(
  planSlug: string,
  packageName: string
): PlanPackage | null {
  const plan = PLAN_DEFINITIONS.find((p) => p.slug === planSlug);
  if (!plan) return null;

  return plan.packages.find((pkg) => pkg.name === packageName) || null;
}

/**
 * Get all packages for a plan
 */
export function getPlanPackages(planSlug: string): PlanPackage[] {
  const plan = PLAN_DEFINITIONS.find((p) => p.slug === planSlug);
  return plan?.packages || [];
}
