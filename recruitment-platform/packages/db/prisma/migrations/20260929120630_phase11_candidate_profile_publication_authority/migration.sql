-- AlterTable
ALTER TABLE "Candidate" ADD COLUMN     "currentProfileAttemptNumber" INTEGER,
ADD COLUMN     "currentProfileDocumentId" TEXT,
ADD COLUMN     "currentProfileProcessingRunId" TEXT,
ADD COLUMN     "currentProfileUploadedAt" TIMESTAMP(3);

-- AddForeignKey
ALTER TABLE "Candidate" ADD CONSTRAINT "Candidate_currentProfileDocumentId_fkey" FOREIGN KEY ("currentProfileDocumentId") REFERENCES "CandidateDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Candidate" ADD CONSTRAINT "Candidate_currentProfileProcessingRunId_fkey" FOREIGN KEY ("currentProfileProcessingRunId") REFERENCES "ProcessingRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
