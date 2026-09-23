-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('HR_USER', 'HR_ADMIN', 'SYSTEM_ADMIN');

-- CreateEnum
CREATE TYPE "ProjectMemberRole" AS ENUM ('OWNER', 'MEMBER');

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ON_HOLD', 'READY_FOR_CV_UPLOAD', 'COMPLETED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "RequirementCategory" AS ENUM ('EDUCATION', 'PROFESSIONAL_EXPERIENCE', 'FUNCTIONAL_EXPERIENCE', 'TECHNICAL_SKILLS', 'INDUSTRY_EXPERIENCE', 'CERTIFICATIONS', 'LANGUAGES', 'BEHAVIORAL_COMPETENCY', 'MANAGEMENT_LEADERSHIP', 'LOCATION_MOBILITY', 'OTHER');

-- CreateEnum
CREATE TYPE "RequirementPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "RequirementStatus" AS ENUM ('DRAFT', 'AI_ANALYZED', 'HR_REVIEW', 'APPROVED', 'CHANGED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "SemanticRelevance" AS ENUM ('DIRECT', 'RELEVANT', 'PARTIALLY_RELEVANT', 'NOT_RELEVANT');

-- CreateEnum
CREATE TYPE "EvidenceStrength" AS ENUM ('STRONG', 'MODERATE', 'PARTIAL', 'WEAK', 'NOT_FOUND', 'CONTRADICTORY');

-- CreateEnum
CREATE TYPE "EvidenceConfidence" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "EvidenceType" AS ENUM ('DIRECT', 'INFERRED', 'MISSING');

-- CreateEnum
CREATE TYPE "AssessmentStatus" AS ENUM ('STRONG_EVIDENCE', 'REVIEW_REQUIRED', 'MANDATORY_GAP', 'INSUFFICIENT_EVIDENCE');

-- CreateEnum
CREATE TYPE "CandidateDocumentStatus" AS ENUM ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED_RETRY', 'FAILED_NEEDS_OCR');

-- CreateEnum
CREATE TYPE "HrDecisionType" AS ENUM ('SHORTLIST', 'HOLD', 'REJECT', 'INTERVIEW');

-- CreateEnum
CREATE TYPE "AiTaskType" AS ENUM ('REQUIREMENT_INTERPRETATION', 'WEIGHTING_RECOMMENDATION', 'RESUME_INTELLIGENCE', 'REQUIREMENT_EVIDENCE_ANALYSIS', 'CAREER_CONSISTENCY_ANALYSIS', 'CANDIDATE_COMPARISON');

-- CreateEnum
CREATE TYPE "AiValidationStatus" AS ENUM ('VALID', 'RETRIED_VALID', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'HR_USER',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecruitmentProject" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "department" TEXT,
    "businessUnit" TEXT,
    "location" TEXT,
    "hiringManager" TEXT,
    "vacancies" INTEGER NOT NULL DEFAULT 1,
    "employmentType" TEXT,
    "description" TEXT,
    "status" "ProjectStatus" NOT NULL DEFAULT 'DRAFT',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecruitmentProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectMember" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "ProjectMemberRole" NOT NULL DEFAULT 'MEMBER',
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobRequirement" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "category" "RequirementCategory" NOT NULL,
    "customCategoryLabel" TEXT,
    "description" TEXT NOT NULL,
    "mandatory" BOOLEAN NOT NULL DEFAULT false,
    "priority" "RequirementPriority" NOT NULL DEFAULT 'MEDIUM',
    "evidenceCriteria" TEXT,
    "hrNotes" TEXT,
    "aiInterpretationSummary" TEXT,
    "aiInteractionId" TEXT,
    "aiSuggestedWeight" DECIMAL(5,2),
    "hrApprovedWeight" DECIMAL(5,2),
    "status" "RequirementStatus" NOT NULL DEFAULT 'DRAFT',
    "currentVersionNumber" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobRequirement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RequirementSemanticConcept" (
    "id" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "concept" TEXT NOT NULL,
    "relevance" "SemanticRelevance" NOT NULL,
    "rationale" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RequirementSemanticConcept_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RequirementEvidenceCriterion" (
    "id" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RequirementEvidenceCriterion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobRequirementVersion" (
    "id" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "category" "RequirementCategory" NOT NULL,
    "customCategoryLabel" TEXT,
    "description" TEXT NOT NULL,
    "mandatory" BOOLEAN NOT NULL,
    "priority" "RequirementPriority" NOT NULL,
    "evidenceCriteriaSnapshot" JSONB NOT NULL,
    "aiInterpretationSummary" TEXT,
    "aiSuggestedWeight" DECIMAL(5,2),
    "hrApprovedWeight" DECIMAL(5,2) NOT NULL,
    "approvedBy" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobRequirementVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RequirementWeightApproval" (
    "id" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "approvedBy" TEXT NOT NULL,
    "previousWeight" DECIMAL(5,2),
    "newWeight" DECIMAL(5,2) NOT NULL,
    "hrNote" TEXT,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RequirementWeightApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Candidate" (
    "id" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Candidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateProjectLink" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "anonymizedLabel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CandidateProjectLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateDocument" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "projectId" TEXT,
    "fileType" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "status" "CandidateDocumentStatus" NOT NULL DEFAULT 'QUEUED',
    "failureReason" TEXT,
    "uploadedBy" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purgedAt" TIMESTAMP(3),

    CONSTRAINT "CandidateDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateExperience" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "documentId" TEXT,
    "employer" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "responsibilities" TEXT[],
    "functionalAreaTags" TEXT[],
    "extractedConfidence" "EvidenceConfidence",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CandidateExperience_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateEducation" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "institution" TEXT NOT NULL,
    "degree" TEXT,
    "field" TEXT,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),

    CONSTRAINT "CandidateEducation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateSkill" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "skillName" TEXT NOT NULL,
    "category" TEXT,

    CONSTRAINT "CandidateSkill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateCertification" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "issuer" TEXT,
    "dateObtained" TIMESTAMP(3),

    CONSTRAINT "CandidateCertification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateLanguage" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "proficiency" TEXT,

    CONSTRAINT "CandidateLanguage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Evidence" (
    "id" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sourceDocumentId" TEXT,
    "sourcePage" INTEGER,
    "evidenceText" TEXT,
    "evidenceType" "EvidenceType" NOT NULL,
    "evidenceStrength" "EvidenceStrength" NOT NULL,
    "confidence" "EvidenceConfidence" NOT NULL,
    "aiModel" TEXT,
    "aiPromptVersion" TEXT,
    "aiInteractionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Assessment" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "requirementVersionId" TEXT,
    "aiAssessmentSummary" TEXT NOT NULL,
    "status" "AssessmentStatus" NOT NULL,
    "computedScoreContribution" DECIMAL(6,4),
    "aiInteractionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Assessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateComparison" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "candidateIds" TEXT[],
    "createdBy" TEXT NOT NULL,
    "summaryJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CandidateComparison_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrDecision" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "decision" "HrDecisionType" NOT NULL,
    "decidedBy" TEXT NOT NULL,
    "notes" TEXT,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HrDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrOverride" (
    "id" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "overridden" BOOLEAN NOT NULL,
    "hrNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HrOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiInteraction" (
    "id" TEXT NOT NULL,
    "taskType" "AiTaskType" NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "inputRef" TEXT,
    "outputJson" JSONB,
    "validationStatus" "AiValidationStatus" NOT NULL,
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiInteraction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiModelConfiguration" (
    "id" TEXT NOT NULL,
    "taskType" "AiTaskType" NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "temperature" DECIMAL(3,2),
    "maxTokens" INTEGER,
    "timeoutMs" INTEGER,
    "retryPolicy" JSONB,
    "promptVersion" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiModelConfiguration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "beforeJson" JSONB,
    "afterJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectMember_projectId_userId_key" ON "ProjectMember"("projectId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "JobRequirementVersion_requirementId_versionNumber_key" ON "JobRequirementVersion"("requirementId", "versionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateProjectLink_candidateId_projectId_key" ON "CandidateProjectLink"("candidateId", "projectId");

-- CreateIndex
CREATE INDEX "Assessment_candidateId_projectId_idx" ON "Assessment"("candidateId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "HrOverride_decisionId_key" ON "HrOverride"("decisionId");

-- CreateIndex
CREATE UNIQUE INDEX "AiModelConfiguration_taskType_key" ON "AiModelConfiguration"("taskType");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- AddForeignKey
ALTER TABLE "RecruitmentProject" ADD CONSTRAINT "RecruitmentProject_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "RecruitmentProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRequirement" ADD CONSTRAINT "JobRequirement_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "RecruitmentProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequirementSemanticConcept" ADD CONSTRAINT "RequirementSemanticConcept_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "JobRequirement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequirementEvidenceCriterion" ADD CONSTRAINT "RequirementEvidenceCriterion_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "JobRequirement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRequirementVersion" ADD CONSTRAINT "JobRequirementVersion_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "JobRequirement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRequirementVersion" ADD CONSTRAINT "JobRequirementVersion_approvedBy_fkey" FOREIGN KEY ("approvedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequirementWeightApproval" ADD CONSTRAINT "RequirementWeightApproval_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "JobRequirement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequirementWeightApproval" ADD CONSTRAINT "RequirementWeightApproval_approvedBy_fkey" FOREIGN KEY ("approvedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateProjectLink" ADD CONSTRAINT "CandidateProjectLink_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateProjectLink" ADD CONSTRAINT "CandidateProjectLink_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "RecruitmentProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateDocument" ADD CONSTRAINT "CandidateDocument_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateExperience" ADD CONSTRAINT "CandidateExperience_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateEducation" ADD CONSTRAINT "CandidateEducation_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateSkill" ADD CONSTRAINT "CandidateSkill_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateCertification" ADD CONSTRAINT "CandidateCertification_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateLanguage" ADD CONSTRAINT "CandidateLanguage_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "JobRequirement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "CandidateDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assessment" ADD CONSTRAINT "Assessment_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assessment" ADD CONSTRAINT "Assessment_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "JobRequirement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assessment" ADD CONSTRAINT "Assessment_requirementVersionId_fkey" FOREIGN KEY ("requirementVersionId") REFERENCES "JobRequirementVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateComparison" ADD CONSTRAINT "CandidateComparison_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "RecruitmentProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrDecision" ADD CONSTRAINT "HrDecision_decidedBy_fkey" FOREIGN KEY ("decidedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrOverride" ADD CONSTRAINT "HrOverride_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "HrDecision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrOverride" ADD CONSTRAINT "HrOverride_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "Assessment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
