/**
 * Deterministic Experience Intelligence (architecture doc, Section:
 * Candidate Experience Intelligence). Takes the structured experience
 * entries Resume Intelligence already extracted (employer, dates,
 * functional-area tags) and computes Total / Functional / Relevant /
 * Directly-Relevant experience by date math and tag filtering — no AI call
 * per requirement, no calculation from job title or total role duration
 * alone (Section 13/14 of the master instruction).
 */

export interface ExperienceEntry {
  startDate: string | null; // ISO date
  endDate: string | null; // null + isCurrent = present role
  isCurrent: boolean;
  functionalAreaTags: string[];
  // From Requirement Evidence Analysis, when scoring against one specific
  // requirement; omitted when just computing Total/Functional experience.
  evidenceStrength?: "STRONG" | "MODERATE" | "PARTIAL" | "WEAK" | "NOT_FOUND" | "CONTRADICTORY";
}

export interface ExperienceBreakdown {
  totalMonths: number;
  functionalMonths: Record<string, number>;
  relevantMonths: number;
  directlyRelevantMonths: number;
  confidence: "HIGH" | "MEDIUM" | "LOW";
}

function monthsBetween(start: Date, end: Date): number {
  const months =
    (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
  return Math.max(0, months);
}

function entryDuration(entry: ExperienceEntry, now: Date): number {
  if (!entry.startDate) return 0;
  const start = new Date(entry.startDate);
  const end = entry.isCurrent || !entry.endDate ? now : new Date(entry.endDate);
  return monthsBetween(start, end);
}

/**
 * @param entries All of a candidate's experience entries.
 * @param requirementFunctionalAreas Functional-area tags the requirement
 *   cares about (e.g. ["Employee Relations"]) — determines Relevant vs.
 *   merely Functional experience. Pass [] to get only Total/Functional.
 */
export function computeExperienceBreakdown(
  entries: ExperienceEntry[],
  requirementFunctionalAreas: string[] = [],
  now: Date = new Date(),
): ExperienceBreakdown {
  const functionalMonths: Record<string, number> = {};
  let totalMonths = 0;
  let relevantMonths = 0;
  let directlyRelevantMonths = 0;
  let hasMissingDates = false;
  let hasStrongEvidence = false;

  for (const entry of entries) {
    if (!entry.startDate) {
      hasMissingDates = true;
      continue;
    }
    const duration = entryDuration(entry, now);
    totalMonths += duration;

    for (const tag of entry.functionalAreaTags) {
      functionalMonths[tag] = (functionalMonths[tag] ?? 0) + duration;
    }

    const isRelevant = entry.functionalAreaTags.some((tag) =>
      requirementFunctionalAreas.includes(tag),
    );
    if (isRelevant) {
      relevantMonths += duration;
      const strong = entry.evidenceStrength === "STRONG" || entry.evidenceStrength === "MODERATE";
      if (strong) {
        directlyRelevantMonths += duration;
        hasStrongEvidence = true;
      }
    }
  }

  // Confidence reflects date completeness and evidence strength, never
  // presented as an exact figure (architecture doc: "labeled estimates").
  const confidence: ExperienceBreakdown["confidence"] = hasMissingDates
    ? "LOW"
    : hasStrongEvidence
      ? "HIGH"
      : "MEDIUM";

  return { totalMonths, functionalMonths, relevantMonths, directlyRelevantMonths, confidence };
}

export function monthsToYearsLabel(months: number): string {
  const years = months / 12;
  return `approximately ${years.toFixed(1)} years`;
}
