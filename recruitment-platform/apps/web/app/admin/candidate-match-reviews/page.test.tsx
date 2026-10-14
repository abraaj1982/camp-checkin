/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import CandidateMatchReviewsPage from "./page";

const apiFetchMock = vi.fn();
vi.mock("../../../lib/api", () => ({
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

const REVIEW = {
  reviewId: "review-1",
  projectId: "proj-1",
  projectTitle: "HR Manager",
  stagedUploadFilename: "jane-doe-resume.pdf",
  matchSignal: "EMAIL" as const,
  status: "PENDING",
  createdAt: "2026-01-01T00:00:00.000Z",
  emailMatch: { candidateId: "cand-1", candidateName: "Jane Doe" },
  phoneMatch: null,
};

describe("CandidateMatchReviewsPage", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it("shows loading then empty state when there are no pending reviews", async () => {
    apiFetchMock.mockResolvedValueOnce([]);
    render(<CandidateMatchReviewsPage />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("No pending candidate match reviews.")).toBeInTheDocument());
  });

  it("renders a pending review with its match signal and candidate name, never a raw email/phone", async () => {
    apiFetchMock.mockResolvedValueOnce([REVIEW]);
    render(<CandidateMatchReviewsPage />);
    await waitFor(() => expect(screen.getByText("jane-doe-resume.pdf")).toBeInTheDocument());
    expect(screen.getAllByText("EMAIL").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Jane Doe").length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/@/);
  });

  it("shows a 403 message instead of the list when forbidden", async () => {
    const { ApiError } = await import("../../../lib/api");
    apiFetchMock.mockRejectedValueOnce(new ApiError(403, { error: "forbidden" }));
    render(<CandidateMatchReviewsPage />);
    await waitFor(() =>
      expect(screen.getByText("You don't have permission to view candidate match reviews.")).toBeInTheDocument(),
    );
  });

  it("requires confirmation before resolving, then calls resolve with LINK_EXISTING and the matched candidateId", async () => {
    apiFetchMock.mockResolvedValueOnce([REVIEW]);
    render(<CandidateMatchReviewsPage />);
    await waitFor(() => expect(screen.getByText("jane-doe-resume.pdf")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /Link to Jane Doe/ }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(apiFetchMock).toHaveBeenCalledTimes(1); // only the initial list load so far — no resolve call yet

    apiFetchMock.mockResolvedValueOnce({ candidateId: "cand-1", documentId: "doc-1" });
    apiFetchMock.mockResolvedValueOnce([]); // reload after resolve
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/admin/candidate-match-reviews/review-1/resolve",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ outcome: "LINK_EXISTING", candidateId: "cand-1" }),
        }),
      ),
    );
  });

  it("cancelling the confirmation makes no resolve call", async () => {
    apiFetchMock.mockResolvedValueOnce([REVIEW]);
    render(<CandidateMatchReviewsPage />);
    await waitFor(() => expect(screen.getByText("jane-doe-resume.pdf")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Create new candidate" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(apiFetchMock).toHaveBeenCalledTimes(1); // only the initial list load
  });

  it("shows an already_resolved (409) message and refreshes instead of leaving a stale confirm dialog", async () => {
    apiFetchMock.mockResolvedValueOnce([REVIEW]);
    render(<CandidateMatchReviewsPage />);
    await waitFor(() => expect(screen.getByText("jane-doe-resume.pdf")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /Link to Jane Doe/ }));

    const { ApiError } = await import("../../../lib/api");
    apiFetchMock.mockRejectedValueOnce(new ApiError(409, { error: "already_resolved" }));
    apiFetchMock.mockResolvedValueOnce([]); // reload after the 409
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() =>
      expect(screen.getByText(/already resolved/)).toBeInTheDocument(),
    );
  });
});
