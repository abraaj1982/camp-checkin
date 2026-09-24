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
    if (path.endsWith("/decisions")) {
      return Promise.resolve({ decisions: [] });
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
  id: "assessment-1",
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
    // Scoped to the assessment card: Phase 6's Decisions panel legitimately
    // repeats the status text in its "override this assessment" picker.
    const card = screen.getByText("5 years Employee Relations").closest("section")!;
    expect(within(card).getByText(/strong evidence/i)).toBeInTheDocument();
    expect(screen.getByText(/Led grievance handling for 200\+ staff\./)).toBeInTheDocument();
    expect(screen.getByText(/Source Document, page 2/)).toBeInTheDocument();
  });

  it.each(["STRONG_EVIDENCE", "REVIEW_REQUIRED", "MANDATORY_GAP", "INSUFFICIENT_EVIDENCE"])(
    "renders the %s status badge",
    async (status) => {
      mockResponses({ assessments: [baseAssessment({ status })] });
      render(<CandidateDetailPage />);
      await waitFor(() => expect(screen.getByText("5 years Employee Relations")).toBeInTheDocument());
      // Scoped to the assessment card's own status badge — Phase 6 added a
      // second, legitimate occurrence of this same status text in the
      // Decisions panel's "override this assessment" picker.
      const card = screen.getByText("5 years Employee Relations").closest("section")!;
      expect(within(card).getByText(new RegExp(status.replaceAll("_", " "), "i"))).toBeInTheDocument();
    },
  );

  it("distinguishes mandatory vs optional requirements", async () => {
    mockResponses({
      assessments: [
        baseAssessment({ id: "a1", requirement: { ...baseAssessment().requirement, mandatory: true, description: "Req A" } }),
        baseAssessment({ id: "a2", requirement: { ...baseAssessment().requirement, mandatory: false, description: "Req B" } }),
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
      if (path.endsWith("/decisions")) return Promise.resolve({ decisions: [] });
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

  describe("Decisions panel (Phase 6)", () => {
    it("loads and renders existing decision history, newest first", async () => {
      apiFetchMock.mockImplementation((path: string) => {
        if (path.endsWith("/assessments")) return Promise.resolve({ candidate: CANDIDATE, assessments: [] });
        if (path.endsWith("/consistency-findings")) return Promise.resolve({ candidate: CANDIDATE, findings: [] });
        if (path.endsWith("/decisions")) {
          return Promise.resolve({
            decisions: [
              {
                id: "d2",
                decision: "SHORTLIST",
                notes: "Second look confirms fit.",
                decidedAt: "2026-01-02T00:00:00.000Z",
                decidedByName: "Alex HR",
                override: null,
              },
              {
                id: "d1",
                decision: "HOLD",
                notes: null,
                decidedAt: "2026-01-01T00:00:00.000Z",
                decidedByName: "Alex HR",
                override: { assessmentId: "a1", overridden: true, hrNote: null },
              },
            ],
          });
        }
        if (path.endsWith("/candidates")) return Promise.resolve([{ candidateId: "cand-1", anonymizedLabel: "Candidate #001", documents: [] }]);
        throw new Error(`Unexpected path: ${path}`);
      });
      render(<CandidateDetailPage />);
      await waitFor(() => expect(screen.getByText("Second look confirms fit.")).toBeInTheDocument());
      const items = screen.getAllByText(/^(SHORTLIST|HOLD)$/);
      expect(items[0]).toHaveTextContent("SHORTLIST"); // newest first
      expect(items[1]).toHaveTextContent("HOLD");
      expect(screen.getByText("Overrides an AI assessment gap.")).toBeInTheDocument();
      expect(screen.getAllByText((_, el) => el?.textContent === "by Alex HR").length).toBe(2);
    });

    it("shows a no-decisions message when history is empty", async () => {
      mockResponses({ assessments: [baseAssessment()] });
      render(<CandidateDetailPage />);
      await waitFor(() => expect(screen.getByText("No decisions recorded yet.")).toBeInTheDocument());
    });

    it("only offers the candidate's current-run assessments in the override picker", async () => {
      mockResponses({
        assessments: [baseAssessment({ id: "a1", requirement: { ...baseAssessment().requirement, description: "Req A" } })],
      });
      render(<CandidateDetailPage />);
      await waitFor(() => expect(screen.getByText("Override assessment (optional)")).toBeInTheDocument());
      const select = screen.getByLabelText(/override assessment/i) as HTMLSelectElement;
      const options = Array.from(select.options).map((o) => o.textContent);
      expect(options).toEqual(["None", "Req A — STRONG EVIDENCE"]);
    });

    it("hides the override picker entirely when there are no current-run assessments", async () => {
      mockResponses({ assessments: [] });
      render(<CandidateDetailPage />);
      await waitFor(() => expect(screen.getByText("No decisions recorded yet.")).toBeInTheDocument());
      expect(screen.queryByText("Override assessment (optional)")).toBeNull();
    });

    it("submits a decision and refreshes the history", async () => {
      let decisions: unknown[] = [];
      apiFetchMock.mockImplementation((path: string, options?: { method?: string; body?: string }) => {
        if (path.endsWith("/assessments")) return Promise.resolve({ candidate: CANDIDATE, assessments: [] });
        if (path.endsWith("/consistency-findings")) return Promise.resolve({ candidate: CANDIDATE, findings: [] });
        if (path.endsWith("/candidates")) return Promise.resolve([{ candidateId: "cand-1", anonymizedLabel: "Candidate #001", documents: [] }]);
        if (path.endsWith("/decisions") && options?.method === "POST") {
          const body = JSON.parse(options.body ?? "{}");
          decisions = [
            { id: "new-1", decision: body.decision, notes: body.notes ?? null, decidedAt: "2026-01-03T00:00:00.000Z", decidedByName: "Alex HR", override: null },
          ];
          return Promise.resolve({ id: "new-1", decision: body.decision, notes: body.notes ?? null, decidedAt: "2026-01-03T00:00:00.000Z", override: null });
        }
        if (path.endsWith("/decisions")) return Promise.resolve({ decisions });
        throw new Error(`Unexpected path: ${path}`);
      });
      render(<CandidateDetailPage />);
      await waitFor(() => expect(screen.getByText("No decisions recorded yet.")).toBeInTheDocument());

      screen.getByRole("button", { name: /record decision/i }).click();
      await waitFor(() => expect(screen.getByText("SHORTLIST")).toBeInTheDocument());
      const postCall = apiFetchMock.mock.calls.find((call) => {
        const [path, options] = call as [string, { method?: string } | undefined];
        return path.endsWith("/decisions") && options?.method === "POST";
      });
      expect(postCall).toBeDefined();
    });

    it("shows an error message when submitting a decision fails", async () => {
      const { ApiError } = await import("../../../../../lib/api");
      apiFetchMock.mockImplementation((path: string, options?: { method?: string }) => {
        if (path.endsWith("/assessments")) return Promise.resolve({ candidate: CANDIDATE, assessments: [] });
        if (path.endsWith("/consistency-findings")) return Promise.resolve({ candidate: CANDIDATE, findings: [] });
        if (path.endsWith("/candidates")) return Promise.resolve([{ candidateId: "cand-1", anonymizedLabel: "Candidate #001", documents: [] }]);
        if (path.endsWith("/decisions") && options?.method === "POST") {
          return Promise.reject(new ApiError(404, { error: "candidate_not_found" }));
        }
        if (path.endsWith("/decisions")) return Promise.resolve({ decisions: [] });
        throw new Error(`Unexpected path: ${path}`);
      });
      render(<CandidateDetailPage />);
      await waitFor(() => expect(screen.getByText("No decisions recorded yet.")).toBeInTheDocument());

      screen.getByRole("button", { name: /record decision/i }).click();
      await waitFor(() => expect(screen.getByText("Could not record decision.")).toBeInTheDocument());
    });

    it("never renders a decision-history aggregate count or dashboard-like summary", async () => {
      apiFetchMock.mockImplementation((path: string) => {
        if (path.endsWith("/assessments")) return Promise.resolve({ candidate: CANDIDATE, assessments: [] });
        if (path.endsWith("/consistency-findings")) return Promise.resolve({ candidate: CANDIDATE, findings: [] });
        if (path.endsWith("/candidates")) return Promise.resolve([{ candidateId: "cand-1", anonymizedLabel: "Candidate #001", documents: [] }]);
        if (path.endsWith("/decisions")) {
          return Promise.resolve({
            decisions: [
              { id: "d1", decision: "SHORTLIST", notes: null, decidedAt: "2026-01-01T00:00:00.000Z", decidedByName: "Alex HR", override: null },
              { id: "d2", decision: "REJECT", notes: null, decidedAt: "2026-01-02T00:00:00.000Z", decidedByName: "Alex HR", override: null },
            ],
          });
        }
        throw new Error(`Unexpected path: ${path}`);
      });
      render(<CandidateDetailPage />);
      await waitFor(() => expect(screen.getAllByText(/^(SHORTLIST|REJECT)$/).length).toBe(2));
      expect(screen.queryByText(/\d+\s+of\s+\d+/)).toBeNull();
    });
  });
});
