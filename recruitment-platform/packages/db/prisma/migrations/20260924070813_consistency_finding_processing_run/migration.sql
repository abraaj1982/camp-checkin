-- AlterTable
ALTER TABLE "CandidateConsistencyFinding" ADD COLUMN     "processingRunId" TEXT NOT NULL;

-- AddForeignKey
ALTER TABLE "CandidateConsistencyFinding" ADD CONSTRAINT "CandidateConsistencyFinding_processingRunId_fkey" FOREIGN KEY ("processingRunId") REFERENCES "ProcessingRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
