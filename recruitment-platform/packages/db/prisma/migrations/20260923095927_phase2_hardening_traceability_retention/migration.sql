-- CreateEnum
CREATE TYPE "AssessmentEvidenceRole" AS ENUM ('SUPPORTING', 'CONSIDERED_REJECTED');

-- DropForeignKey
ALTER TABLE "Assessment" DROP CONSTRAINT "Assessment_candidateId_fkey";

-- DropForeignKey
ALTER TABLE "Evidence" DROP CONSTRAINT "Evidence_candidateId_fkey";

-- AlterTable
ALTER TABLE "Candidate" ADD COLUMN     "piiPurgedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AssessmentEvidence" (
    "id" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "evidenceId" TEXT NOT NULL,
    "role" "AssessmentEvidenceRole" NOT NULL,
    "rationale" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssessmentEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AssessmentEvidence_assessmentId_evidenceId_key" ON "AssessmentEvidence"("assessmentId", "evidenceId");

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assessment" ADD CONSTRAINT "Assessment_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssessmentEvidence" ADD CONSTRAINT "AssessmentEvidence_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "Assessment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssessmentEvidence" ADD CONSTRAINT "AssessmentEvidence_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "Evidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrDecision" ADD CONSTRAINT "HrDecision_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
