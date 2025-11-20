-- CreateEnum
CREATE TYPE "MealType" AS ENUM ('PRE_WAKEUP', 'BREAKFAST', 'MID_MEAL', 'LUNCH', 'MID_EVENING', 'DINNER', 'OTHER');

-- CreateTable
CREATE TABLE "Recall" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "appointmentId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Recall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecallEntry" (
    "id" TEXT NOT NULL,
    "recallId" TEXT NOT NULL,
    "mealType" "MealType" NOT NULL,
    "time" TEXT NOT NULL,
    "foodItem" TEXT NOT NULL,
    "quantity" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecallEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Recall_appointmentId_key" ON "Recall"("appointmentId");

-- AddForeignKey
ALTER TABLE "Recall" ADD CONSTRAINT "Recall_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "PatientDetials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recall" ADD CONSTRAINT "Recall_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecallEntry" ADD CONSTRAINT "RecallEntry_recallId_fkey" FOREIGN KEY ("recallId") REFERENCES "Recall"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
