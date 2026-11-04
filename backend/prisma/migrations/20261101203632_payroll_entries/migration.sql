/*
  Warnings:

  - A unique constraint covering the columns `[companyId,number]` on the table `employee_ledger_entries` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `number` to the `employee_ledger_entries` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "employee_ledger_entries" ADD COLUMN     "number" TEXT NOT NULL,
ADD COLUMN     "status" "DocStatus" NOT NULL DEFAULT 'POSTED',
ADD COLUMN     "voidReason" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "employee_ledger_entries_companyId_number_key" ON "employee_ledger_entries"("companyId", "number");
