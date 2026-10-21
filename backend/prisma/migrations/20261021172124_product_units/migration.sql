/*
  Warnings:

  - You are about to drop the column `barcode` on the `products` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[companyId,barcode]` on the table `product_units` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "products_companyId_barcode_idx";

-- AlterTable
ALTER TABLE "product_units" ADD COLUMN     "barcode" TEXT,
ADD COLUMN     "isBase" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE "products" DROP COLUMN "barcode",
ADD COLUMN     "allowFractions" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "product_units_companyId_barcode_key" ON "product_units"("companyId", "barcode");
