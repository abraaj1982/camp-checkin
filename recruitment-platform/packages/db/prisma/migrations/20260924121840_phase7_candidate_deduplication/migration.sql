-- CreateEnum
CREATE TYPE "StagedUploadStatus" AS ENUM ('PENDING_IDENTITY_RESOLUTION', 'RESOLVING', 'PENDING_REVIEW', 'PROMOTED', 'FAILED');

-- CreateEnum
CREATE TYPE "CandidateMatchReviewStatus" AS ENUM ('PENDING', 'LINK_EXISTING', 'CREATE_NEW');

-- CreateEnum
CREATE TYPE "CandidateMatchSignal" AS ENUM ('EMAIL', 'PHONE', 'BOTH', 'CONFLICT');

-- AlterTable
ALTER TABLE "Candidate" ADD COLUMN     "normalizedEmail" TEXT,
ADD COLUMN     "normalizedPhone" TEXT;

-- AlterTable
ALTER TABLE "CandidateDocument" ADD COLUMN     "stagedUploadId" TEXT;

-- CreateTable
CREATE TABLE "StagedUpload" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "batchId" TEXT,
    "storageKey" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "fileSizeBytes" INTEGER,
    "uploadedBy" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "StagedUploadStatus" NOT NULL DEFAULT 'PENDING_IDENTITY_RESOLUTION',
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StagedUpload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateMatchReview" (
    "id" TEXT NOT NULL,
    "stagedUploadId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "matchSignal" "CandidateMatchSignal" NOT NULL,
    "emailMatchedCandidateId" TEXT,
    "phoneMatchedCandidateId" TEXT,
    "status" "CandidateMatchReviewStatus" NOT NULL DEFAULT 'PENDING',
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CandidateMatchReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StagedUpload_projectId_status_idx" ON "StagedUpload"("projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateMatchReview_stagedUploadId_key" ON "CandidateMatchReview"("stagedUploadId");

-- CreateIndex
CREATE INDEX "CandidateMatchReview_projectId_status_idx" ON "CandidateMatchReview"("projectId", "status");

-- CreateIndex
CREATE INDEX "Candidate_normalizedEmail_idx" ON "Candidate"("normalizedEmail");

-- CreateIndex
CREATE INDEX "Candidate_normalizedPhone_idx" ON "Candidate"("normalizedPhone");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateDocument_stagedUploadId_key" ON "CandidateDocument"("stagedUploadId");

-- AddForeignKey
ALTER TABLE "CandidateDocument" ADD CONSTRAINT "CandidateDocument_stagedUploadId_fkey" FOREIGN KEY ("stagedUploadId") REFERENCES "StagedUpload"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StagedUpload" ADD CONSTRAINT "StagedUpload_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "RecruitmentProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StagedUpload" ADD CONSTRAINT "StagedUpload_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "CandidateUploadBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateMatchReview" ADD CONSTRAINT "CandidateMatchReview_stagedUploadId_fkey" FOREIGN KEY ("stagedUploadId") REFERENCES "StagedUpload"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateMatchReview" ADD CONSTRAINT "CandidateMatchReview_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "RecruitmentProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateMatchReview" ADD CONSTRAINT "CandidateMatchReview_emailMatchedCandidateId_fkey" FOREIGN KEY ("emailMatchedCandidateId") REFERENCES "Candidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateMatchReview" ADD CONSTRAINT "CandidateMatchReview_phoneMatchedCandidateId_fkey" FOREIGN KEY ("phoneMatchedCandidateId") REFERENCES "Candidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateMatchReview" ADD CONSTRAINT "CandidateMatchReview_resolvedBy_fkey" FOREIGN KEY ("resolvedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

