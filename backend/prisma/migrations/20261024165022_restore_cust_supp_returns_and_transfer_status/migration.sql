/*
  Warnings:

  - The values [CUSTOMER_RETURN,SUPPLIER_RETURN] on the enum `MovementType` will be removed. If these variants are still used in the database, this will fail.
  - The values [DISPATCHED] on the enum `TransferStatus` will be removed. If these variants are still used in the database, this will fail.

*/

-- Drop the constraint before replacing the enum
ALTER TABLE "stock_movements"
DROP CONSTRAINT IF EXISTS "stock_movements_direction";

-- AlterEnum
BEGIN;
CREATE TYPE "MovementType_new" AS ENUM ('OPENING', 'RECEIPT', 'TRANSFER_OUT', 'TRANSFER_IN', 'SALE_RELEASE', 'RETURN_IN', 'RETURN_OUT', 'ADJUSTMENT', 'DAMAGE', 'REVERSAL');
ALTER TABLE "stock_movements" ALTER COLUMN "type" TYPE "MovementType_new" USING ("type"::text::"MovementType_new");
ALTER TYPE "MovementType" RENAME TO "MovementType_old";
ALTER TYPE "MovementType_new" RENAME TO "MovementType";
DROP TYPE "public"."MovementType_old";
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "TransferStatus_new" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'IN_TRANSIT', 'RECEIVED', 'DISCREPANCY', 'CLOSED', 'CANCELLED');
ALTER TABLE "public"."transfers" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "transfers" ALTER COLUMN "status" TYPE "TransferStatus_new" USING ("status"::text::"TransferStatus_new");
ALTER TYPE "TransferStatus" RENAME TO "TransferStatus_old";
ALTER TYPE "TransferStatus_new" RENAME TO "TransferStatus";
DROP TYPE "public"."TransferStatus_old";
ALTER TABLE "transfers" ALTER COLUMN "status" SET DEFAULT 'REQUESTED';
COMMIT;