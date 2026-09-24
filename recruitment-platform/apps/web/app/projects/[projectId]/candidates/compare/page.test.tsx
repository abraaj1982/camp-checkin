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

const CANDIDATES = [
  { candidateId: "cand-1", anonymizedLabel: "Candidate #001", hasCurrentRun: true, isProcessing: false, isFailed: false },
  { candidateId: "cand-2", anonymizedLabel: "Candidate #002", hasCurrentRun: true, isProcessing: false, isFailed: false },
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
    "cand-1": {
      status: "STRONG_EVIDENCE",
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
    "cand-2": {
      status: "MANDATORY_GAP",
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
          resultsByCandidate: { "cand-1": null, "cand-2": REQUIREMENT_ROW.resultsByCandidate["cand-2"] },
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
            "cand-1": {
              status: "STRONG_EVIDENCE",
              evidence: [{ ...REQUIREMENT_ROW.resultsByCandidate["cand-1"].evidence[0], evidenceText: "Worked at Company A." }],
            },
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
        { candidateId: "cand-1", anonymizedLabel: "Candidate #001", hasCurrentRun: false, isProcessing: true, isFailed: false },
        { candidateId: "cand-2", anonymizedLabel: "Candidate #002", hasCurrentRun: true, isProcessing: false, isFailed: false },
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
        { candidateId: "cand-1", anonymizedLabel: "Candidate #001", hasCurrentRun: false, isProcessing: false, isFailed: true },
        { candidateId: "cand-2", anonymizedLabel: "Candidate #002", hasCurrentRun: true, isProcessing: false, isFailed: false },
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

  it("never renders a score, ranking, or recommendation anywhere", async () => {
    mockCompareResponse();
    render(<CandidateComparisonPage />);
    await waitFor(() => expect(screen.getByText("5 years Employee Relations")).toBeInTheDocument());

    const bodyText = (document.body.textContent ?? "").toLowerCase();
    for (const forbidden of ["score", "rank", "recommend", "suitab", "hire", "winner", "best candidate", "overall match"]) {
      expect(bodyText).not.toContain(forbidden);
    }
  });

  it("never renders an aggregate count of requirements met (no score-like summary)", async () => {
    mockCompareResponse();
    render(<CandidateComparisonPage />);
    await waitFor(() => expect(screen.getByText("5 years Employee Relations")).toBeInTheDocument());
    expect(screen.queryByText(/\d+\s*(of|\/)\s*\d+/)).toBeNull();
  });
});
