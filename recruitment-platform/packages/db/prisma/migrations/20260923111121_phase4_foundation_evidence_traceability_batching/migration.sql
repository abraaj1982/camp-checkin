-- CreateEnum
CREATE TYPE "ConsistencyFindingType" AS ENUM ('EMPLOYMENT_GAP', 'OVERLAPPING_DATES', 'UNCLEAR_CHRONOLOGY', 'RESPONSIBILITY_SENIORITY_MISMATCH', 'POTENTIAL_INCONSISTENCY', 'OTHER');

-- CreateEnum
CREATE TYPE "ConsistencyFindingSeverity" AS ENUM ('INFORMATION_UNCLEAR', 'VERIFICATION_REQUIRED', 'POTENTIAL_INCONSISTENCY');

-- DropForeignKey
ALTER TABLE "Assessment" DROP CONSTRAINT "Assessment_requirementId_fkey";

-- DropForeignKey
ALTER TABLE "Evidence" DROP CONSTRAINT "Evidence_requirementId_fkey";

-- AlterTable
ALTER TABLE "CandidateDocument" ADD COLUMN     "batchId" TEXT;

-- CreateTable
CREATE TABLE "CandidateUploadBatch" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CandidateUploadBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateBatchRequirementVersion" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "requirementVersionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CandidateBatchRequirementVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateConsistencyFinding" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "findingType" "ConsistencyFindingType" NOT NULL,
    "severity" "ConsistencyFindingSeverity" NOT NULL,
    "description" TEXT NOT NULL,
    "sourceDocumentId" TEXT,
    "sourcePage" INTEGER,
    "evidenceText" TEXT,
    "confidence" "EvidenceConfidence" NOT NULL,
    "aiInteractionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CandidateConsistencyFinding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CandidateBatchRequirementVersion_batchId_requirementId_key" ON "CandidateBatchRequirementVersion"("batchId", "requirementId");

-- CreateIndex
CREATE INDEX "CandidateConsistencyFinding_candidateId_projectId_idx" ON "CandidateConsistencyFinding"("candidateId", "projectId");

-- AddForeignKey
ALTER TABLE "CandidateUploadBatch" ADD CONSTRAINT "CandidateUploadBatch_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "RecruitmentProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateBatchRequirementVersion" ADD CONSTRAINT "CandidateBatchRequirementVersion_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "CandidateUploadBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateBatchRequirementVersion" ADD CONSTRAINT "CandidateBatchRequirementVersion_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "JobRequirement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateBatchRequirementVersion" ADD CONSTRAINT "CandidateBatchRequirementVersion_requirementVersionId_fkey" FOREIGN KEY ("requirementVersionId") REFERENCES "JobRequirementVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateDocument" ADD CONSTRAINT "CandidateDocument_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "CandidateUploadBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "JobRequirement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assessment" ADD CONSTRAINT "Assessment_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "JobRequirement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateConsistencyFinding" ADD CONSTRAINT "CandidateConsistencyFinding_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateConsistencyFinding" ADD CONSTRAINT "CandidateConsistencyFinding_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "CandidateDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;
