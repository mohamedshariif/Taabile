/*
  Warnings:

  - A unique constraint covering the columns `[seq]` on the table `stock_movements` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "stock_movements" ADD COLUMN     "seq" BIGSERIAL NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "stock_movements_seq_key" ON "stock_movements"("seq");
