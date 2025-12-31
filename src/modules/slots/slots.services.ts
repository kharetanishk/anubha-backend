import prisma from "../../database/prismaclient";
import { AppointmentStatus } from "@prisma/client";
import { APPOINTMENT_MODES, AppointmentModeType } from "./slots.constants";
import {
  generateSlotsForDate,
  toDateString,
  isPastDate,
  formatSlotLabel,
} from "./slots.utils";

/**
 * Since there is only one doctor/admin in Nutriwell,
 * this helper fetches that single Admin.
 */
export async function getSingleAdminId() {
  const admin = await prisma.admin.findFirst();
  if (!admin) {
    throw new Error("No admin found in database. Seed the Admin first.");
  }
  return admin.id;
}

/**
 * Get the single admin with all details (including phone)
 */
export async function getSingleAdmin() {
  const admin = await prisma.admin.findFirst();
  if (!admin) {
    throw new Error("No admin found in database. Seed the Admin first.");
  }
  return admin;
}

/**
 * Check if a date (YYYY-MM-DD) is a Sunday.
 */
export function isSunday(dateStr: string) {
  const d = new Date(dateStr + "T00:00:00Z");
  return d.getDay() === 0;
}

/**
 * Generate slots for a range of dates (admin-driven).
 */
export async function generateSlotsForRange(opts: {
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  modes: AppointmentModeType[]; // e.g. ['IN_PERSON', 'ONLINE']
}) {
  const adminId = await getSingleAdminId();
  const { startDate, endDate, modes } = opts;

  // Create dates in IST timezone for consistent comparison
  // startDate and endDate are in YYYY-MM-DD format
  const start = new Date(startDate + "T00:00:00+05:30"); // IST start of day
  const end = new Date(endDate + "T23:59:59+05:30"); // IST end of day

  if (end < start) {
    throw new Error("endDate cannot be before startDate");
  }

  // console.log(" [SLOT GENERATION] Date range (IST)
  // :", {
  // startDate,
  // endDate,
  // startIST: start.toISOString(),
  // endIST: end.toISOString(),
  // });

  // Fetch all doctor day offs in range once for efficiency
  const dayOffs = await prisma.doctorDayOff.findMany({
    where: {
      adminId,
      date: {
        gte: start,
        lte: end,
      },
    },
  });

  const dayOffSet = new Set(dayOffs.map((d) => toDateString(d.date)));

  const data: {
    adminId: string;
    startAt: Date;
    endAt: Date;
    mode: AppointmentModeType;
  }[] = [];

  // Get current time in IST for comparison
  const now = new Date();

  // Get today's date string in IST
  // Convert current time to IST timezone string, then parse it
  const nowISTString = now.toLocaleString("en-US", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // Format: "MM/DD/YYYY" -> convert to "YYYY-MM-DD"
  const [month, day, year] = nowISTString.split("/");
  const todayStr = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;

  // console.log(" [SLOT GENERATION] Starting slot generation:", {
  // startDate,
  // endDate,
  // modes,
  // currentTimeUTC: now.toISOString()
  // ,
  // todayInIST: todayStr,
  // nowISTString,
  // });

  // Start cursor from start date, iterate day by day
  const cursor = new Date(start);

  while (cursor <= end) {
    // Get date string in IST - convert cursor to IST timezone
    const cursorISTString = cursor.toLocaleString("en-US", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const [cMonth, cDay, cYear] = cursorISTString.split("/");
    const dateStr = `${cYear}-${cMonth.padStart(2, "0")}-${cDay.padStart(
      2,
      "0"
    )}`;

    const isToday = dateStr === todayStr;
    // Also check if this date matches the requested startDate (user's intent)
    const isRequestedStartDate = dateStr === startDate;

    // console.log(" [SLOT GENERATION] Processing date:", {
    // date: dateStr,
    // isToday,
    // isRequestedStartDate,
    // today: todayStr,
    // startDate,
    // dateMatch: dateStr === todayStr,
    // cursorUTC: cursor.toISOString()
    // ,
    // cursorIST: cursorISTString,
    // });

    // Skip Sundays
    if (!isSunday(dateStr) && !dayOffSet.has(dateStr)) {
      // console.log(
      // " [SLOT GENERATION] Date is valid (not Sunday, not day off)
      // , generating slots"
      // );

      for (const mode of modes) {
        // console.log(" [SLOT GENERATION] Generating slots for mode:", mode);
const slots = generateSlotsForDate(dateStr, mode);
        // console.log(
        // "📋 [SLOT GENERATION] Generated",
        // slots.length,
        // "slots for",
        // dateStr,
        // mode
        // );
let slotsAdded = 0;
        let slotsSkipped = 0;

        for (const { startAt, endAt } of slots) {
          // For today or requested start date: only skip slots that are already in the past
          // For future dates: create all slots
          let shouldSkip = false;

          // Check if this is today OR if it's the requested start date (user's intent)
          const isTodayOrRequested = isToday || isRequestedStartDate;

          if (isTodayOrRequested) {
            // Compare timestamps - both are in UTC internally
            // startAt is in IST but stored as UTC milliseconds
            // now is current time in UTC milliseconds
            const slotTime = startAt.getTime();
            const currentTime = now.getTime();
            const timeDiff = slotTime - currentTime; // positive if slot is in future
            const minutesDiff = Math.round(timeDiff / 1000 / 60);

            // console.log(
            // " [SLOT GENERATION] Checking slot (today or requested date)
            // :",
            // {
            // slotTime: startAt.toISOString(),
            // currentTime: now.toISOString(),
            // timeDiffMinutes: minutesDiff,
            // isPast: timeDiff <= 0,
            // isToday,
            // isRequestedStartDate,
            // }
            // );

            if (slotTime <= currentTime) {
              // console.log(" [SLOT GENERATION] Skipping past slot:", {
              // startAt: startAt.toISOString()
              // ,
              // now: now.toISOString(),
              // minutesAgo: Math.abs(minutesDiff),
              // });
              // shouldSkip = true;
              // slotsSkipped++;
              // } else {
              // console.log(
              // " [SLOT GENERATION] Slot is in future, will create:",
              // {
              // startAt: startAt.toISOString()
              // ,
              // minutesFromNow: minutesDiff,
              // }
              // );
            }
          } else {
            // console.log(" [SLOT GENERATION] Future date, creating all slots:", {
            // date: dateStr,
            // startAt: startAt.toISOString()
            // ,
            // });
            // }

          // For future dates, create all slots regardless of time
          if (!shouldSkip) {
            data.push({
              adminId,
              startAt,
              endAt,
              mode,
            });
            slotsAdded++;
          }
        }

        // console.log(" [SLOT GENERATION] Slots for", dateStr, mode + ":", {
        // total: slots.length,
        // added: slotsAdded,
        // skipped: slotsSkipped,
        // });
        // }
        // } else {
        // const reason = isSunday(dateStr) ? "Sunday" : "day off";
      // console.log(
      // " [SLOT GENERATION] Skipping date (" + reason + ")
      // :",
      // dateStr
      // );
    }

    // Move to next day - increment the date string and create new Date in IST
    const [year, month, day] = dateStr.split("-").map(Number);
    const nextDate = new Date(year, month - 1, day + 1); // JavaScript months are 0-indexed
    const nextDateStr = toDateString(nextDate);
    cursor.setTime(new Date(nextDateStr + "T00:00:00+05:30").getTime());
  }

  if (!data.length) {
    return { createdCount: 0 };
  }

  const result = await prisma.slot.createMany({
    data,
    skipDuplicates: true, // respects @@unique([adminId, startAt])
  });

  return { createdCount: result.count };
}

/**
 * Mark a doctor day off.
 */
export async function addDoctorDayOff(opts: {
  date: string; // YYYY-MM-DD
  reason?: string;
}) {
  const adminId = await getSingleAdminId();
  const date = new Date(opts.date + "T00:00:00Z");
  const dayEnd = new Date(date.getTime() + 24 * 60 * 60 * 1000);

  // Block day-off if the doctor already has a confirmed appointment that day
  const confirmedAppointment = await prisma.appointment.findFirst({
    where: {
      doctorId: adminId,
      status: {
        in: [AppointmentStatus.CONFIRMED, AppointmentStatus.PENDING],
      },
      isArchived: false,
      startAt: {
        gte: date,
        lt: dayEnd,
      },
    },
    select: { id: true, startAt: true },
  });

  if (confirmedAppointment) {
    throw new Error(
      "Cannot mark this day off because you have a confirmed or pending appointment on this date"
    );
  }

  const dayOff = await prisma.doctorDayOff.upsert({
    where: {
      adminId_date: {
        adminId,
        date,
      },
    },
    update: {
      reason: opts.reason,
    },
    create: {
      adminId,
      date,
      reason: opts.reason,
    },
  });

  // Optionally: delete any existing slots on that day (cleaner)
  await prisma.slot.deleteMany({
    where: {
      adminId,
      startAt: {
        gte: date,
        lt: dayEnd,
      },
    },
  });

  return dayOff;
}

export async function removeDoctorDayOff(id: string) {
  await prisma.doctorDayOff.delete({
    where: { id },
  });
}

/**
 * Get available slots for a given date + mode for the public booking flow.
 * IMPORTANT: Only returns admin-created slots with isBooked: false.
 * No auto-generation - only slots explicitly created by admin are returned.
 */
export async function getAvailableSlotsForDate(opts: {
  date: string; // YYYY-MM-DD
  mode: AppointmentModeType;
}) {
  const adminId = await getSingleAdminId();
  const { date, mode } = opts;

  // console.log(" [SLOTS SERVICE] Fetching available slots:", { date, mode });
// Create date range in IST timezone (slots are stored in IST)
  // date is YYYY-MM-DD, we need to create IST dates
  // Use start of day in IST and end of day in IST
  const dayStart = new Date(date + "T00:00:00+05:30"); // IST start of day
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000); // Next day start (exclusive)

  // console.log(" [SLOTS SERVICE] Date range (IST)
  // :", {
  // dayStart: dayStart.toISOString(),
  // dayEnd: dayEnd.toISOString(),
  // });

  // Check Sunday
  if (isSunday(date)) {
    // console.log(" [SLOTS SERVICE] Date is Sunday, returning empty array");
return [];
  }

  // Check DoctorDayOff
  const dayOff = await prisma.doctorDayOff.findFirst({
    where: {
      adminId,
      date: {
        gte: dayStart,
        lt: dayEnd,
      },
    },
  });

  if (dayOff) {
    // console.log(
    // " [SLOTS SERVICE] Date is marked as day off, returning empty array"
    // );
return [];
  }

  // Fetch only admin-generated slots (no auto-generation)
  // Only return slots that were explicitly created by admin with isBooked: false
  // console.log(" [SLOTS SERVICE] Querying database for admin-created slots...");
const slots = await prisma.slot.findMany({
    where: {
      adminId,
      mode,
      isBooked: false, // CRITICAL: Only return unbooked slots
      startAt: {
        gte: dayStart,
        lt: dayEnd,
      },
    },
    orderBy: {
      startAt: "asc",
    },
  });

  // console.log(" [SLOTS SERVICE] Found slots from database:", {
  // total: slots.length,
  // slotIds: slots.map((s)
  // => s.id),
  // });

  // Filter out slots that are in the past (for today)
  const validSlots = slots.filter((s) => !isPastDate(s.startAt));

  // console.log(" [SLOTS SERVICE] Valid (non-past)
  // slots:", {
  // count: validSlots.length,
  // slots: validSlots.map((s) => ({
  // id: s.id,
  // startAt: s.startAt.toISOString(),
  // mode: s.mode,
  // isBooked: s.isBooked,
  // })),
  // });

  // Map to frontend-friendly format
  const formattedSlots = validSlots.map((slot) => ({
    id: slot.id,
    startAt: slot.startAt.toISOString(),
    endAt: slot.endAt.toISOString(),
    label: formatSlotLabel(slot.startAt, slot.endAt),
    mode: slot.mode,
  }));

  // console.log(
  // " [SLOTS SERVICE] Returning formatted slots:",
  // formattedSlots.length
  // );
return formattedSlots;
}

// ADMIN: get slot date range (earliest and latest slot dates)
export async function getAdminSlotDateRange() {
  try {
    const adminId = await getSingleAdminId();

    // Get the earliest slot date
    const earliestSlot = await prisma.slot.findFirst({
      where: {
        adminId,
        isArchived: false,
      },
      orderBy: {
        startAt: "asc",
      },
      select: {
        startAt: true,
      },
    });

    // Get the latest slot date
    const latestSlot = await prisma.slot.findFirst({
      where: {
        adminId,
        isArchived: false,
      },
      orderBy: {
        startAt: "desc",
      },
      select: {
        startAt: true,
      },
    });

    if (!earliestSlot || !latestSlot) {
      return {
        hasSlots: false,
        earliestDate: null,
        latestDate: null,
      };
    }

    // Format dates to YYYY-MM-DD
    const earliestDate = earliestSlot.startAt.toISOString().split("T")[0];
    const latestDate = latestSlot.startAt.toISOString().split("T")[0];

    return {
      hasSlots: true,
      earliestDate,
      latestDate,
    };
  } catch (error: any) {
    console.error("[SLOTS SERVICE] Error getting slot date range:", error);
    throw error;
  }
}

// ADMIN: fetch all slots (with booking details)
export async function getAdminSlots(opts: {
  date?: string;
  startDate?: string;
  endDate?: string;
}) {
  const adminId = await getSingleAdminId();

  let where: any = { adminId };

  // CASE 1: single date
  if (opts.date) {
    const dayStart = new Date(opts.date + "T00:00:00Z");
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

    where.startAt = { gte: dayStart, lt: dayEnd };
  }

  // CASE 2: range filter
  if (opts.startDate && opts.endDate) {
    const start = new Date(opts.startDate + "T00:00:00Z");
    const end = new Date(opts.endDate + "T23:59:59Z");

    where.startAt = { gte: start, lte: end };
  }

  const slots = await prisma.slot.findMany({
    where,
    orderBy: { startAt: "asc" },
    include: {
      appointments: {
        where: {
          status: "CONFIRMED",
          isArchived: false,
        },
        include: {
          patient: true,
        },
        take: 1, // Get only the first confirmed appointment
      },
    },
  });

  return slots.map((s) => ({
    id: s.id,
    startAt: s.startAt,
    endAt: s.endAt,
    mode: s.mode,
    isBooked: s.isBooked,
    appointment: s.appointments[0]
      ? {
          id: s.appointments[0].id,
          patientName: s.appointments[0].patient.name,
          patientId: s.appointments[0].patientId,
        }
      : null,
  }));
}

export async function getAdminDayOffList() {
  const adminId = await getSingleAdminId();

  const offs = await prisma.doctorDayOff.findMany({
    where: { adminId },
    orderBy: { date: "asc" },
  });

  return offs.map((d) => ({
    id: d.id,
    date: d.date,
    reason: d.reason,
  }));
}

/**
 * Preview slot creation - calculates how many slots can be created
 * and identifies issues (existing slots, past times, etc.)
 */
export async function previewSlotsForRange(opts: {
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  modes: AppointmentModeType[]; // e.g. ['IN_PERSON', 'ONLINE']
}) {
  const adminId = await getSingleAdminId();
  const { startDate, endDate, modes } = opts;

  const start = new Date(startDate + "T00:00:00Z");
  const end = new Date(endDate + "T00:00:00Z");

  if (end < start) {
    throw new Error("endDate cannot be before startDate");
  }

  // Fetch all doctor day offs in range
  const dayOffs = await prisma.doctorDayOff.findMany({
    where: {
      adminId,
      date: {
        gte: start,
        lte: end,
      },
    },
  });

  const dayOffSet = new Set(dayOffs.map((d) => toDateString(d.date)));

  // Fetch existing slots in range
  const existingSlots = await prisma.slot.findMany({
    where: {
      adminId,
      startAt: {
        gte: start,
        lte: new Date(end.getTime() + 24 * 60 * 60 * 1000 - 1), // End of end date
      },
    },
    select: {
      startAt: true,
      mode: true,
    },
  });

  // Group existing slots by date and mode
  const existingSlotsByDate = new Map<string, Set<AppointmentModeType>>();
  existingSlots.forEach((slot) => {
    const dateStr = toDateString(slot.startAt);
    if (!existingSlotsByDate.has(dateStr)) {
      existingSlotsByDate.set(dateStr, new Set());
    }
    existingSlotsByDate.get(dateStr)?.add(slot.mode);
  });

  const now = new Date();
  const todayStr = toDateString(now);

  let totalSlots = 0;
  let inPersonSlots = 0;
  let onlineSlots = 0;
  const inPersonErrors: string[] = [];
  const onlineErrors: string[] = [];
  const existingSlotWarnings: string[] = [];
  const dateDetails: Array<{
    date: string;
    isSunday: boolean;
    isDayOff: boolean;
    hasExistingSlots: string[];
    inPersonCount: number;
    onlineCount: number;
    inPersonReasons: string[];
    onlineReasons: string[];
  }> = [];

  const cursor = new Date(start);
  while (cursor <= end) {
    const dateStr = toDateString(cursor);
    const isSun = isSunday(dateStr);
    const isDayOff = dayOffSet.has(dateStr);
    const isToday = dateStr === todayStr;
    const hasExistingSlots = existingSlotsByDate.get(dateStr);

    const dateDetail: {
      date: string;
      isSunday: boolean;
      isDayOff: boolean;
      hasExistingSlots: string[];
      inPersonCount: number;
      onlineCount: number;
      inPersonReasons: string[];
      onlineReasons: string[];
    } = {
      date: dateStr,
      isSunday: isSun,
      isDayOff,
      hasExistingSlots: hasExistingSlots ? Array.from(hasExistingSlots) : [],
      inPersonCount: 0,
      onlineCount: 0,
      inPersonReasons: [],
      onlineReasons: [],
    };

    if (!isSun && !isDayOff) {
      // Check IN_PERSON slots
      if (modes.includes(APPOINTMENT_MODES.IN_PERSON)) {
        const hasExistingInPerson = hasExistingSlots?.has(
          APPOINTMENT_MODES.IN_PERSON
        );
        if (hasExistingInPerson) {
          existingSlotWarnings.push(
            `${dateStr}: IN_PERSON slots already exist for this date`
          );
          dateDetail.inPersonReasons.push("Slots already exist");
        } else {
          const slots = generateSlotsForDate(
            dateStr,
            APPOINTMENT_MODES.IN_PERSON
          );
          let dayInPersonCount = 0;
          for (const { startAt } of slots) {
            if (startAt > now) {
              dayInPersonCount++;
            } else if (isToday) {
              dateDetail.inPersonReasons.push(
                `Slot at ${startAt.toLocaleTimeString("en-IN", {
                  hour: "2-digit",
                  minute: "2-digit",
                })} is in the past`
              );
            }
          }
          if (isToday && dayInPersonCount === 0) {
            inPersonErrors.push(
              `Today: All IN_PERSON slots (10:00-12:40) are in the past. Cannot create IN_PERSON slots for today.`
            );
            dateDetail.inPersonReasons.push("All slots are in the past");
          } else if (isToday && dayInPersonCount < slots.length) {
            inPersonErrors.push(
              `Today: Only ${dayInPersonCount} of ${slots.length} IN_PERSON slots can be created (some are in the past)`
            );
          }
          dateDetail.inPersonCount = dayInPersonCount;
          inPersonSlots += dayInPersonCount;
        }
      }

      // Check ONLINE slots
      if (modes.includes(APPOINTMENT_MODES.ONLINE)) {
        const hasExistingOnline = hasExistingSlots?.has(
          APPOINTMENT_MODES.ONLINE
        );
        if (hasExistingOnline) {
          existingSlotWarnings.push(
            `${dateStr}: ONLINE slots already exist for this date`
          );
          dateDetail.onlineReasons.push("Slots already exist");
        } else {
          const slots = generateSlotsForDate(dateStr, APPOINTMENT_MODES.ONLINE);
          let dayOnlineCount = 0;
          for (const { startAt } of slots) {
            if (startAt > now) {
              dayOnlineCount++;
            } else if (isToday) {
              dateDetail.onlineReasons.push(
                `Slot at ${startAt.toLocaleTimeString("en-IN", {
                  hour: "2-digit",
                  minute: "2-digit",
                })} is in the past`
              );
            }
          }
          if (isToday && dayOnlineCount === 0) {
            onlineErrors.push(
              `Today: All ONLINE slots (14:00-19:40) are in the past. Cannot create ONLINE slots for today.`
            );
            dateDetail.onlineReasons.push("All slots are in the past");
          } else if (isToday && dayOnlineCount < slots.length) {
            onlineErrors.push(
              `Today: Only ${dayOnlineCount} of ${slots.length} ONLINE slots can be created (some are in the past)`
            );
          }
          dateDetail.onlineCount = dayOnlineCount;
          onlineSlots += dayOnlineCount;
        }
      }
    } else {
      if (isSun) {
        dateDetail.inPersonReasons.push(
          "Sunday (slots not created on Sundays)"
        );
        dateDetail.onlineReasons.push("Sunday (slots not created on Sundays)");
      }
      if (isDayOff) {
        dateDetail.inPersonReasons.push("Day off");
        dateDetail.onlineReasons.push("Day off");
      }
    }

    dateDetails.push(dateDetail);
    cursor.setDate(cursor.getDate() + 1);
  }

  totalSlots = inPersonSlots + onlineSlots;

  return {
    totalSlots,
    inPersonSlots,
    onlineSlots,
    inPersonErrors,
    onlineErrors,
    existingSlotWarnings,
    dateDetails,
  };
}
