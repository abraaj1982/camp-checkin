/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import CandidateComparisonPage from "./page";

let currentSearch = "candidateIds=cand-1,cand-2";
vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj-1" }),
  useSearchParams: () => new URLSearchParams(currentSearch),
}));

const apiFetchMock = vi.fn();
vi.mock("../../../../../lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  ApiError: class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(status: number, body: unknown) {
      super(`API error ${status}`);
      this.status = status;
      this.body = body;
    }
  },
}));

const NOT_COMPUTABLE_SCORE = { computable: false as const, reason: "PII_PURGED" as const };

const CANDIDATES = [
  {
    candidateId: "cand-1",
    anonymizedLabel: "Candidate #001",
    hasCurrentRun: true,
    isProcessing: false,
    isFailed: false,
    score: { computable: true, score: 100, numerator: 100, denominator: 100 },
  },
  {
    candidateId: "cand-2",
    anonymizedLabel: "Candidate #002",
    hasCurrentRun: true,
    isProcessing: false,
    isFailed: false,
    score: { computable: true, score: 0, numerator: 0, denominator: 100 },
  },
];

const REQUIREMENT_ROW = {
  requirementId: "req-1",
  requirementVersionId: "v1",
  versionNumber: 1,
  description: "5 years Employee Relations",
  mandatory: true,
  category: "FUNCTIONAL_EXPERIENCE",
  hrApprovedWeight: "100",
  resultsByCandidate: {
    "cand-1": [
      {
        status: "STRONG_EVIDENCE",
        isAuthoritative: true,
        evidence: [
          {
            role: "SUPPORTING",
            rationale: "On-point.",
            evidenceStrength: "STRONG",
            confidence: "HIGH",
            evidenceType: "DIRECT",
            sourcePage: 2,
            evidenceText: "Led grievance handling.",
            source: "Source Document",
          },
        ],
      },
    ],
    "cand-2": [
      {
        status: "MANDATORY_GAP",
        isAuthoritative: true,
        evidence: [
          {
            role: "CONSIDERED_REJECTED",
            rationale: null,
            evidenceStrength: "NOT_FOUND",
            confidence: "HIGH",
            evidenceType: "MISSING",
            sourcePage: null,
            evidenceText: null,
            source: null,
          },
        ],
      },
    ],
  },
};

function mockCompareResponse(overrides: Partial<{ candidates: unknown[]; requirementRows: unknown[]; consistencyFindingsByCandidate: Record<string, unknown[]> }> = {}) {
  apiFetchMock.mockResolvedValue({
    candidates: CANDIDATES,
    requirementRows: [REQUIREMENT_ROW],
    consistencyFindingsByCandidate: { "cand-1": [], "cand-2": [] },
    ...overrides,
  });
}

describe("CandidateComparisonPage", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    currentSearch = "candidateIds=cand-1,cand-2";
  });

  it("shows a loading state before data arrives", () => {
    apiFetchMock.mockReturnValue(new Promise(() => {}));
    render(<CandidateComparisonPage />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("renders one column per candidate with anonymized labels, in the API's returned order", async () => {
    mockCompareResponse();
    render(<CandidateComparisonPage />);
    await waitFor(() => expect(screen.getByText("Candidate #001")).toBeInTheDocument());
    expect(screen.getByText("Candidate #002")).toBeInTheDocument();

    const labels = screen.getAllByText(/Candidate #00[12]/);
    expect(labels[0].textContent).toBe("Candidate #001");
    expect(labels[1].textContent).toBe("Candidate #002");
  });

  it("aligns candidates under the same requirement row, showing each candidate's own status", async () => {
    mockCompareResponse();
    render(<CandidateComparisonPage />);
    await waitFor(() => expect(screen.getByText("5 years Employee Relations")).toBeInTheDocument());
    expect(screen.getByText("STRONG EVIDENCE")).toBeInTheDocument();
    expect(screen.getByText("MANDATORY GAP")).toBeInTheDocument();
  });

  it("displays different RequirementVersions as separate rows with visible version labels", async () => {
    mockCompareResponse({
      requirementRows: [
        REQUIREMENT_ROW,
        {
          ...REQUIREMENT_ROW,
          requirementVersionId: "v2",
          versionNumber: 2,
          resultsByCandidate: { "cand-1": [], "cand-2": REQUIREMENT_ROW.resultsByCandidate["cand-2"] },
        },
      ],
    });
    render(<CandidateComparisonPage />);
    await waitFor(() => expect(screen.getByText(/version 1/)).toBeInTheDocument());
    expect(screen.getByText(/version 2/)).toBeInTheDocument();
  });

  it("renders evidence text, rationale, and source/page", async () => {
    mockCompareResponse();
    render(<CandidateComparisonPage />);
    await waitFor(() => expect(screen.getByText(/Led grievance handling\./)).toBeInTheDocument());
    expect(screen.getByText("On-point.")).toBeInTheDocument();
    expect(screen.getByText(/Source Document, page 2/)).toBeInTheDocument();
  });

  it("shows redacted text as-is (no client-side redaction — trusts the API payload verbatim)", async () => {
    mockCompareResponse({
      requirementRows: [
        {
          ...REQUIREMENT_ROW,
          resultsByCandidate: {
            ...REQUIREMENT_ROW.resultsByCandidate,
            "cand-1": [
              {
                status: "STRONG_EVIDENCE",
                isAuthoritative: true,
                evidence: [{ ...REQUIREMENT_ROW.resultsByCandidate["cand-1"][0].evidence[0], evidenceText: "Worked at Company A." }],
              },
            ],
          },
        },
      ],
    });
    render(<CandidateComparisonPage />);
    await waitFor(() => expect(screen.getByText(/Worked at Company A\./)).toBeInTheDocument());
  });

  it("renders the Career Consistency section per candidate", async () => {
    mockCompareResponse({
      consistencyFindingsByCandidate: {
        "cand-1": [
          {
            findingType: "EMPLOYMENT_GAP",
            severity: "INFORMATION_UNCLEAR",
            description: "Gap noted.",
            sourcePage: null,
            evidenceText: null,
            confidence: "MEDIUM",
            source: null,
            isAuthoritative: true,
          },
        ],
        "cand-2": [],
      },
    });
    render(<CandidateComparisonPage />);
    await waitFor(() => expect(screen.getByText(/EMPLOYMENT GAP/)).toBeInTheDocument());
    expect(screen.getByText("Gap noted.")).toBeInTheDocument();
    expect(screen.getByText("No findings.")).toBeInTheDocument();
  });

  it("shows independent processing states per candidate — one candidate processing does not affect another's results", async () => {
    mockCompareResponse({
      candidates: [
        { candidateId: "cand-1", anonymizedLabel: "Candidate #001", hasCurrentRun: false, isProcessing: true, isFailed: false, score: NOT_COMPUTABLE_SCORE },
        { candidateId: "cand-2", anonymizedLabel: "Candidate #002", hasCurrentRun: true, isProcessing: false, isFailed: false, score: NOT_COMPUTABLE_SCORE },
      ],
    });
    render(<CandidateComparisonPage />);
    await waitFor(() => expect(screen.getAllByRole("status").length).toBeGreaterThan(0));
    const statuses = screen.getAllByRole("status").map((el) => el.textContent);
    expect(statuses.some((t) => /processing/i.test(t ?? ""))).toBe(true);
    // Candidate 2's requirement result still renders despite candidate 1 processing.
    expect(screen.getByText("MANDATORY GAP")).toBeInTheDocument();
  });

  it("shows a failed state for one candidate without affecting another", async () => {
    mockCompareResponse({
      candidates: [
        { candidateId: "cand-1", anonymizedLabel: "Candidate #001", hasCurrentRun: false, isProcessing: false, isFailed: true, score: NOT_COMPUTABLE_SCORE },
        { candidateId: "cand-2", anonymizedLabel: "Candidate #002", hasCurrentRun: true, isProcessing: false, isFailed: false, score: NOT_COMPUTABLE_SCORE },
      ],
    });
    render(<CandidateComparisonPage />);
    await waitFor(() => expect(screen.getByText(/processing failed/i)).toBeInTheDocument());
  });

  it("shows an empty state when there are no requirement rows", async () => {
    mockCompareResponse({ requirementRows: [] });
    render(<CandidateComparisonPage />);
    await waitFor(() => expect(screen.getByText("No requirement assessments to compare yet.")).toBeInTheDocument());
  });

  it("shows an error message when fewer than 2 candidates are provided", async () => {
    currentSearch = "candidateIds=cand-1";
    render(<CandidateComparisonPage />);
    await waitFor(() => expect(screen.getByText(/select at least 2 candidates/i)).toBeInTheDocument());
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("shows an error message on a 400 from the API", async () => {
    const { ApiError } = await import("../../../../../lib/api");
    apiFetchMock.mockRejectedValue(new ApiError(400, { error: "invalid_candidates" }));
    render(<CandidateComparisonPage />);
    await waitFor(() => expect(screen.getByText(/could not be completed/i)).toBeInTheDocument());
  });

  it("never renders a ranking or recommendation anywhere (V1 Score is display-only and is covered separately below)", async () => {
    mockCompareResponse();
    render(<CandidateComparisonPage />);
    await waitFor(() => expect(screen.getByText("5 years Employee Relations")).toBeInTheDocument());

    const bodyText = (document.body.textContent ?? "").toLowerCase();
    // "recommendation"/"suitability" legitimately appear inside both
    // disclaimers' standard "not a suitability, ... or hiring
    // recommendation" framing (approved V1 Score integration) — checked
    // for precisely elsewhere (the dedicated disclaimer tests), not as a
    // bare substring ban here.
    for (const forbidden of ["rank", "hire", "winner", "best candidate", "overall match"]) {
      expect(bodyText).not.toContain(forbidden);
    }
    expect(bodyText).not.toMatch(/\brecommend(ed|s)?\b/); // no affirmative recommendation verb/label
    expect(bodyText).not.toMatch(/\bsuitable\b/); // no affirmative suitability verdict
  });

  it("never renders an aggregate count of requirements met (no score-like summary)", async () => {
    mockCompareResponse();
    render(<CandidateComparisonPage />);
    await waitFor(() => expect(screen.getByText("5 years Employee Relations")).toBeInTheDocument());
    expect(screen.queryByText(/\d+\s*(of|\/)\s*\d+/)).toBeNull();
  });

  describe("Phase 9 — Evidence Coverage", () => {
    const COVERAGE_CANDIDATES = [
      {
        candidateId: "cand-1",
        anonymizedLabel: "Candidate #001",
        hasCurrentRun: true,
        isProcessing: false,
        isFailed: false,
        evidenceCoverage: {
          coveragePercentage: 100,
          status: "COMPLETE",
          scoredWeight: 100,
          totalWeight: 100,
          mandatoryGapCount: 0,
          lowConfidenceCoveredCount: 0,
          perRequirement: [{ requirementId: "req-1", covered: true, contested: false, mandatoryGap: false, lowConfidenceAssessment: false }],
        },
        score: { computable: true, score: 100, numerator: 100, denominator: 100 },
      },
      {
        candidateId: "cand-2",
        anonymizedLabel: "Candidate #002",
        hasCurrentRun: true,
        isProcessing: false,
        isFailed: false,
        evidenceCoverage: {
          coveragePercentage: 0,
          status: "COMPLETE",
          scoredWeight: 100,
          totalWeight: 100,
          mandatoryGapCount: 1,
          lowConfidenceCoveredCount: 0,
          perRequirement: [{ requirementId: "req-1", covered: false, contested: false, mandatoryGap: true, lowConfidenceAssessment: false }],
        },
        score: { computable: true, score: 0, numerator: 0, denominator: 100 },
      },
    ];

    it("renders 'Evidence Coverage: X%', never relabeled as a bare 'Score:' or 'X/100' (V1 Score, where present, is always its own separate 'V1 Score:' line)", async () => {
      mockCompareResponse({ candidates: COVERAGE_CANDIDATES });
      render(<CandidateComparisonPage />);
      await waitFor(() => expect(screen.getByText(/Evidence Coverage: 100%/)).toBeInTheDocument());
      expect(screen.getByText(/Evidence Coverage: 0%/)).toBeInTheDocument();
      const bodyText = document.body.textContent ?? "";
      // Coverage itself is never rendered under a bare "Score:" label — only
      // the distinct, separately-disclaimed "V1 Score:" line uses that word.
      expect(bodyText).not.toMatch(/(?<!V1 )score\s*:/i);
      expect(bodyText).not.toMatch(/\b100\/100\b/);
    });

    it("shows the fixed non-suitability disclaimer whenever coverage is present", async () => {
      mockCompareResponse({ candidates: COVERAGE_CANDIDATES });
      render(<CandidateComparisonPage />);
      await waitFor(() =>
        expect(
          screen.getByText(/Evidence Coverage reflects weighted evidence against approved requirements/),
        ).toBeInTheDocument(),
      );
      // Both the Coverage and V1 Score disclaimers share this trailing
      // clause (approved framing for both) — getAllByText, not getByText.
      expect(screen.getAllByText(/not a suitability, quality, or hiring recommendation/).length).toBe(2);
    });

    it("shows Mandatory Gap count and per-requirement flag, without hiding or zeroing anything", async () => {
      mockCompareResponse({ candidates: COVERAGE_CANDIDATES });
      render(<CandidateComparisonPage />);
      await waitFor(() => expect(screen.getByText(/Mandatory Gaps: 1/)).toBeInTheDocument());
      expect(screen.getByText(/^· Mandatory Gap$/)).toBeInTheDocument(); // per-requirement badge under candidate 2, distinct from the "Mandatory Gaps: 1" count
    });

    it("never renders a rank, 'best match', or 'recommended candidate' label, even with coverage present", async () => {
      mockCompareResponse({ candidates: COVERAGE_CANDIDATES });
      render(<CandidateComparisonPage />);
      await waitFor(() => expect(screen.getByText(/Evidence Coverage: 100%/)).toBeInTheDocument());
      const bodyText = (document.body.textContent ?? "").toLowerCase();
      for (const forbidden of ["rank", "best match", "recommended candidate", "top candidate", "winner"]) {
        expect(bodyText).not.toContain(forbidden);
      }
    });

    it("shows no coverage line for a candidate with no current run (never displays 0% for an unprocessed candidate)", async () => {
      mockCompareResponse({
        candidates: [
          { ...COVERAGE_CANDIDATES[0] },
          { candidateId: "cand-2", anonymizedLabel: "Candidate #002", hasCurrentRun: false, isProcessing: false, isFailed: false, evidenceCoverage: null, score: NOT_COMPUTABLE_SCORE },
        ],
      });
      render(<CandidateComparisonPage />);
      await waitFor(() => expect(screen.getByText(/Evidence Coverage: 100%/)).toBeInTheDocument());
      expect(screen.queryByText(/Evidence Coverage: 0%/)).toBeNull();
    });

    it("shows a Low Confidence review flag without changing the coverage percentage shown", async () => {
      mockCompareResponse({
        candidates: [
          {
            ...COVERAGE_CANDIDATES[0],
            evidenceCoverage: { ...COVERAGE_CANDIDATES[0].evidenceCoverage, lowConfidenceCoveredCount: 1 },
          },
          COVERAGE_CANDIDATES[1],
        ],
      });
      render(<CandidateComparisonPage />);
      await waitFor(() => expect(screen.getByText(/Evidence Coverage: 100%/)).toBeInTheDocument());
      expect(screen.getByText(/Low Confidence: 1/)).toBeInTheDocument();
    });
  });

  describe("V1 Candidate Scoring (display-only, approved integration)", () => {
    it("renders a computable score as 'V1 Score: X%', separate from Evidence Coverage", async () => {
      mockCompareResponse();
      render(<CandidateComparisonPage />);
      await waitFor(() => expect(screen.getByText("V1 Score: 100%")).toBeInTheDocument());
      expect(screen.getByText("V1 Score: 0%")).toBeInTheDocument();
    });

    it("renders a LIVE_REQUIREMENT_NOT_YET_APPROVED block as its own named state, not 0% or blank", async () => {
      mockCompareResponse({
        candidates: [
          {
            ...CANDIDATES[0],
            score: { computable: false, reason: "LIVE_REQUIREMENT_NOT_YET_APPROVED", requirementIds: ["req-x", "req-y"] },
          },
          CANDIDATES[1],
        ],
      });
      render(<CandidateComparisonPage />);
      await waitFor(() =>
        expect(screen.getByText(/V1 Score: Not computable — 2 live requirement\(s\) not yet approved/)).toBeInTheDocument(),
      );
      expect(screen.queryByText("V1 Score: 0%")).not.toBeNull(); // candidate 2's unrelated computable 0% is unaffected
    });

    it("renders a PII_PURGED block as its own named state, never 0% or blank", async () => {
      mockCompareResponse({
        candidates: [{ ...CANDIDATES[0], score: NOT_COMPUTABLE_SCORE }, CANDIDATES[1]],
      });
      render(<CandidateComparisonPage />);
      await waitFor(() =>
        expect(screen.getByText("V1 Score: Not available (candidate data purged)")).toBeInTheDocument(),
      );
    });

    it("shows the fixed non-suitability disclaimer whenever the comparison renders", async () => {
      mockCompareResponse();
      render(<CandidateComparisonPage />);
      await waitFor(() => expect(screen.getByText(/V1 Score reflects weighted evaluation state/)).toBeInTheDocument());
      expect(screen.getByText(/not a suitability, quality, or hiring recommendation/)).toBeInTheDocument();
    });

    it("never reorders candidates by score: requested order [cand-1, cand-2, cand-3] with scores (0, 100, 50) stays in that order", async () => {
      mockCompareResponse({
        candidates: [
          { candidateId: "cand-1", anonymizedLabel: "Candidate #001", hasCurrentRun: true, isProcessing: false, isFailed: false, score: { computable: true, score: 0, numerator: 0, denominator: 100 } },
          { candidateId: "cand-2", anonymizedLabel: "Candidate #002", hasCurrentRun: true, isProcessing: false, isFailed: false, score: { computable: true, score: 100, numerator: 100, denominator: 100 } },
          { candidateId: "cand-3", anonymizedLabel: "Candidate #003", hasCurrentRun: true, isProcessing: false, isFailed: false, score: { computable: true, score: 50, numerator: 50, denominator: 100 } },
        ],
        requirementRows: [],
      });
      render(<CandidateComparisonPage />);
      await waitFor(() => expect(screen.getByText("Candidate #001")).toBeInTheDocument());
      const labels = screen.getAllByText(/Candidate #00[123]/);
      expect(labels.map((el) => el.textContent)).toEqual(["Candidate #001", "Candidate #002", "Candidate #003"]);
    });
  });
});
