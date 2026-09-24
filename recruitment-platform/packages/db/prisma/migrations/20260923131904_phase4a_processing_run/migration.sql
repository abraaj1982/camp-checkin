-- CreateEnum
CREATE TYPE "ProcessingRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

-- AlterTable
ALTER TABLE "Assessment" ADD COLUMN     "processingRunId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "CandidateDocument" ADD COLUMN     "currentProcessingRunId" TEXT,
ADD COLUMN     "processingAttemptCounter" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ProcessingRun" (
    "id" TEXT NOT NULL,
    "candidateDocumentId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "status" "ProcessingRunStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessingRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProcessingRun_candidateDocumentId_attemptNumber_key" ON "ProcessingRun"("candidateDocumentId", "attemptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Assessment_processingRunId_requirementId_key" ON "Assessment"("processingRunId", "requirementId");

-- AddForeignKey
ALTER TABLE "CandidateDocument" ADD CONSTRAINT "CandidateDocument_currentProcessingRunId_fkey" FOREIGN KEY ("currentProcessingRunId") REFERENCES "ProcessingRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessingRun" ADD CONSTRAINT "ProcessingRun_candidateDocumentId_fkey" FOREIGN KEY ("candidateDocumentId") REFERENCES "CandidateDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assessment" ADD CONSTRAINT "Assessment_processingRunId_fkey" FOREIGN KEY ("processingRunId") REFERENCES "ProcessingRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

