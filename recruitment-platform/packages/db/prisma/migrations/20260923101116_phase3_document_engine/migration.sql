-- AlterTable
ALTER TABLE "CandidateDocument" ADD COLUMN     "extractedPageTexts" JSONB,
ADD COLUMN     "extractedText" TEXT,
ADD COLUMN     "fileSizeBytes" INTEGER,
ADD COLUMN     "parsedAt" TIMESTAMP(3);
