/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import CandidateDetailPage from "./page";

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj-1", candidateId: "cand-1" }),
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

const CANDIDATE = { id: "cand-1", anonymizedLabel: "Candidate #001" };

function mockResponses({
  assessments = [],
  findings = [],
  documents = [],
}: {
  assessments?: unknown[];
  findings?: unknown[];
  documents?: { status: string; hasCurrentRun?: boolean }[];
} = {}) {
  apiFetchMock.mockImplementation((path: string) => {
    if (path.endsWith("/assessments")) {
      return Promise.resolve({ candidate: CANDIDATE, assessments });
    }
    if (path.endsWith("/consistency-findings")) {
      return Promise.resolve({ candidate: CANDIDATE, findings });
    }
    if (path.endsWith("/candidates")) {
      // Matches the Phase 5C-hardened /projects/:id/candidates DTO: flat
      // (no nested `candidate` wrapper), hasCurrentRun instead of the raw
      // currentProcessingRunId.
      return Promise.resolve([
        {
          candidateId: "cand-1",
          anonymizedLabel: "Candidate #001",
          documents: documents.map((d) => ({ hasCurrentRun: false, ...d })),
        },
      ]);
    }
    throw new Error(`Unexpected path in test: ${path}`);
  });
}

const baseAssessment = (overrides: Partial<Record<string, unknown>> = {}) => ({
  status: "STRONG_EVIDENCE",
  requirement: {
    id: "req-1",
    description: "5 years Employee Relations",
    mandatory: true,
    category: "FUNCTIONAL_EXPERIENCE",
    hrApprovedWeight: "100",
  },
  requirementVersion: { id: "v1", versionNumber: 1, evidenceCriteriaSnapshot: ["Grievance handling"] },
  evidence: [
    {
      role: "SUPPORTING",
      rationale: "Directly on-point.",
      evidenceStrength: "STRONG",
      confidence: "HIGH",
      evidenceType: "DIRECT",
      sourcePage: 2,
      evidenceText: "Led grievance handling for 200+ staff.",
      source: "Source Document",
    },
  ],
  ...overrides,
});

describe("CandidateDetailPage", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it("shows a loading state before data arrives", () => {
    apiFetchMock.mockReturnValue(new Promise(() => {})); // never resolves
    render(<CandidateDetailPage />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("renders a successful assessment with requirement, status, and evidence", async () => {
    mockResponses({ assessments: [baseAssessment()] });
    render(<CandidateDetailPage />);

    await waitFor(() => expect(screen.getByText("5 years Employee Relations")).toBeInTheDocument());
    expect(screen.getByText("Candidate #001")).toBeInTheDocument();
    expect(screen.getByText(/strong evidence/i)).toBeInTheDocument();
    expect(screen.getByText(/Led grievance handling for 200\+ staff\./)).toBeInTheDocument();
    expect(screen.getByText(/Source Document, page 2/)).toBeInTheDocument();
  });

  it.each(["STRONG_EVIDENCE", "REVIEW_REQUIRED", "MANDATORY_GAP", "INSUFFICIENT_EVIDENCE"])(
    "renders the %s status badge",
    async (status) => {
      mockResponses({ assessments: [baseAssessment({ status })] });
      render(<CandidateDetailPage />);
      await waitFor(() =>
        expect(screen.getByText(new RegExp(status.replaceAll("_", " "), "i"))).toBeInTheDocument(),
      );
    },
  );

  it("distinguishes mandatory vs optional requirements", async () => {
    mockResponses({
      assessments: [
        baseAssessment({ requirement: { ...baseAssessment().requirement, mandatory: true, description: "Req A" } }),
        baseAssessment({ requirement: { ...baseAssessment().requirement, mandatory: false, description: "Req B" } }),
      ],
    });
    render(<CandidateDetailPage />);
    await waitFor(() => expect(screen.getByText("Req A")).toBeInTheDocument());
    expect(screen.getByText(/Mandatory ·/)).toBeInTheDocument();
    expect(screen.getByText(/Optional ·/)).toBeInTheDocument();
  });

  it("renders multiple evidence candidates for one requirement", async () => {
    mockResponses({
      assessments: [
        baseAssessment({
          evidence: [
            { ...baseAssessment().evidence[0], evidenceText: "First quote." },
            { ...baseAssessment().evidence[0], evidenceText: "Second quote." },
          ],
        }),
      ],
    });
    render(<CandidateDetailPage />);
    await waitFor(() => expect(screen.getByText(/First quote\./)).toBeInTheDocument());
    expect(screen.getByText(/Second quote\./)).toBeInTheDocument();
  });

  it("separates SUPPORTING from CONSIDERED_REJECTED evidence into distinct sections", async () => {
    mockResponses({
      assessments: [
        baseAssessment({
          evidence: [
            { ...baseAssessment().evidence[0], role: "SUPPORTING", evidenceText: "Supporting quote." },
            { ...baseAssessment().evidence[0], role: "CONSIDERED_REJECTED", evidenceText: "Rejected quote." },
          ],
        }),
      ],
    });
    render(<CandidateDetailPage />);
    await waitFor(() => expect(screen.getByText("Supporting Evidence")).toBeInTheDocument());
    const supportingHeading = screen.getByText("Supporting Evidence");
    const rejectedHeading = screen.getByText("Considered Rejected Evidence");
    expect(within(supportingHeading.closest("section")!).getByText(/Supporting quote\./)).toBeInTheDocument();
    expect(within(rejectedHeading.parentElement!).queryByText(/Supporting quote\./)).toBeNull();
    expect(screen.getByText(/Rejected quote\./)).toBeInTheDocument();
  });

  it("renders Evidence Criteria as a collapsible section, toggled by the user", async () => {
    mockResponses({ assessments: [baseAssessment()] });
    render(<CandidateDetailPage />);
    await waitFor(() => expect(screen.getByText(/show evidence criteria/i)).toBeInTheDocument());
    expect(screen.queryByText("Grievance handling")).toBeNull(); // collapsed by default
    screen.getByText(/show evidence criteria/i).click();
    expect(await screen.findByText("Grievance handling")).toBeInTheDocument();
  });

  it("renders source and page, including a null sourcePage", async () => {
    mockResponses({
      assessments: [
        baseAssessment({
          evidence: [{ ...baseAssessment().evidence[0], sourcePage: null, source: "Source Document" }],
        }),
      ],
    });
    render(<CandidateDetailPage />);
    await waitFor(() => expect(screen.getByText("Source Document")).toBeInTheDocument());
    expect(screen.queryByText(/page null/i)).toBeNull();
  });

  it("renders Career Consistency findings with type, severity, description, evidence, confidence, source", async () => {
    mockResponses({
      findings: [
        {
          findingType: "EMPLOYMENT_GAP",
          severity: "INFORMATION_UNCLEAR",
          description: "Approximately 7-month gap noted.",
          sourcePage: null,
          evidenceText: null,
          confidence: "MEDIUM",
          source: null,
        },
      ],
    });
    render(<CandidateDetailPage />);
    await waitFor(() => expect(screen.getByText(/EMPLOYMENT GAP/)).toBeInTheDocument());
    expect(screen.getByText(/INFORMATION UNCLEAR/)).toBeInTheDocument();
    expect(screen.getByText("Approximately 7-month gap noted.")).toBeInTheDocument();
    expect(screen.getByText(/Confidence: MEDIUM/)).toBeInTheDocument();
    expect(screen.getByText(/No source/)).toBeInTheDocument();
  });

  it("shows an empty-assessments message without erroring", async () => {
    mockResponses({ findings: [{ findingType: "OTHER", severity: "POTENTIAL_INCONSISTENCY", description: "x", sourcePage: null, evidenceText: null, confidence: "LOW", source: null }] });
    render(<CandidateDetailPage />);
    await waitFor(() => expect(screen.getByText("No requirement assessments yet.")).toBeInTheDocument());
  });

  it("shows an empty-findings message without erroring", async () => {
    mockResponses({ assessments: [baseAssessment()] });
    render(<CandidateDetailPage />);
    await waitFor(() => expect(screen.getByText("No consistency findings.")).toBeInTheDocument());
  });

  it("shows a processing state when a document is QUEUED or PROCESSING", async () => {
    mockResponses({ documents: [{ status: "PROCESSING" }] });
    render(<CandidateDetailPage />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/processing/i));
  });

  it("shows a failed/retry state when there is no current run and the document is FAILED_RETRY", async () => {
    mockResponses({ documents: [{ status: "FAILED_RETRY" }] });
    render(<CandidateDetailPage />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/failed/i));
  });

  it("shows 'No results available yet.' when there is no run and no actionable status", async () => {
    mockResponses({ documents: [{ status: "COMPLETED" }] });
    render(<CandidateDetailPage />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/no results available yet/i));
  });

  it("[precedence 1] keeps current results visible and does NOT show failed/retry when another document for the same candidate is FAILED_RETRY", async () => {
    mockResponses({
      assessments: [baseAssessment()],
      documents: [{ status: "COMPLETED", hasCurrentRun: true }, { status: "FAILED_RETRY" }],
    });
    render(<CandidateDetailPage />);
    await waitFor(() => expect(screen.getByText("5 years Employee Relations")).toBeInTheDocument());
    expect(screen.queryByRole("status")).toBeNull(); // no processing/failed/no-results banner — results are current and shown
  });

  it("[precedence 2] does not show failed/retry when a current run exists but legitimately produced zero results, even if another document is FAILED_RETRY", async () => {
    mockResponses({
      assessments: [],
      findings: [],
      documents: [{ status: "COMPLETED", hasCurrentRun: true }, { status: "FAILED_RETRY" }],
    });
    render(<CandidateDetailPage />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/no results available yet/i));
    expect(screen.queryByText(/failed/i)).toBeNull();
  });

  it("[precedence 3] shows the failed/retry state when there is no current run and a document is FAILED_RETRY", async () => {
    mockResponses({
      documents: [{ status: "FAILED_RETRY", hasCurrentRun: false }],
    });
    render(<CandidateDetailPage />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/failed/i));
  });

  it("[precedence 4] shows the processing state for QUEUED/PROCESSING regardless of any other document's status", async () => {
    mockResponses({
      documents: [{ status: "PROCESSING", hasCurrentRun: false }, { status: "FAILED_RETRY", hasCurrentRun: false }],
    });
    render(<CandidateDetailPage />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/processing/i));
  });

  it("shows a not-found message on a 404 from the API", async () => {
    const { ApiError } = await import("../../../../../lib/api");
    apiFetchMock.mockImplementation(() => Promise.reject(new ApiError(404, { error: "candidate_not_found" })));
    render(<CandidateDetailPage />);
    await waitFor(() => expect(screen.getByText(/candidate not found/i)).toBeInTheDocument());
  });

  it("never renders identifying or sensitive fields, even if present in the raw API payload", async () => {
    // Simulates a hypothetical/defensive scenario: even if the underlying
    // /candidates response happens to carry more than this page declares
    // (it does, on the real API — fullName/email/phone/originalFilename),
    // the narrow type this page reads means those values are never touched
    // by the render, so they must never appear in the DOM.
    apiFetchMock.mockImplementation((path: string) => {
      if (path.endsWith("/assessments")) return Promise.resolve({ candidate: CANDIDATE, assessments: [baseAssessment()] });
      if (path.endsWith("/consistency-findings")) return Promise.resolve({ candidate: CANDIDATE, findings: [] });
      if (path.endsWith("/candidates")) {
        return Promise.resolve([
          {
            candidateId: "cand-1",
            anonymizedLabel: "Candidate #001",
            candidate: {
              fullName: "Jordan Doe",
              email: "jordan.doe@example.com",
              phone: "+1 (555) 123-4567",
              documents: [{ status: "COMPLETED", originalFilename: "jordan-doe-resume.pdf", id: "doc-1" }],
            },
          },
        ]);
      }
      throw new Error("unexpected path");
    });
    render(<CandidateDetailPage />);
    await waitFor(() => expect(screen.getByText("5 years Employee Relations")).toBeInTheDocument());

    const bodyText = document.body.textContent ?? "";
    expect(bodyText).not.toContain("Jordan Doe");
    expect(bodyText).not.toContain("jordan.doe@example.com");
    expect(bodyText).not.toContain("555");
    expect(bodyText).not.toContain("jordan-doe-resume.pdf");
    expect(bodyText).not.toContain("processingRunId");
    expect(bodyText).not.toContain("aiInteractionId");
  });

  it("never renders a score, ranking, or recommendation anywhere", async () => {
    mockResponses({ assessments: [baseAssessment()], findings: [] });
    render(<CandidateDetailPage />);
    await waitFor(() => expect(screen.getByText("5 years Employee Relations")).toBeInTheDocument());

    const bodyText = (document.body.textContent ?? "").toLowerCase();
    for (const forbidden of ["score", "rank", "recommend", "suitab", "hire", "reject candidate", "overall match"]) {
      expect(bodyText).not.toContain(forbidden);
    }
  });
});
