/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import CandidatesPage from "./page";

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj-1" }),
}));

const apiFetchMock = vi.fn();
vi.mock("../../../../lib/api", () => ({
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

function mockLoad({ status = "READY_FOR_CV_UPLOAD", links = [] as unknown[], staged = [] as unknown[] } = {}) {
  apiFetchMock.mockImplementation((path: string) => {
    if (path === "/projects/proj-1/candidates") return Promise.resolve(links);
    if (path === "/projects/proj-1/staged-uploads") return Promise.resolve(staged);
    if (path === "/projects/proj-1") return Promise.resolve({ status });
    throw new Error(`Unexpected path in test: ${path}`);
  });
}

describe("CandidatesPage — CV upload readiness gate UI", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it("disables the upload control and shows the explanatory note when the project is not READY_FOR_CV_UPLOAD", async () => {
    mockLoad({ status: "ON_HOLD" });
    render(<CandidatesPage />);

    await waitFor(() => expect(screen.getByText("No candidates have been added yet. Upload CVs above to get started.")).toBeInTheDocument());

    expect(screen.getByText(/CV upload isn.t available yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Upload CVs/ })).toBeDisabled();
  });

  it("enables the upload control with no note when the project is READY_FOR_CV_UPLOAD", async () => {
    mockLoad({ status: "READY_FOR_CV_UPLOAD" });
    render(<CandidatesPage />);

    await waitFor(() => expect(screen.getByRole("button", { name: /Upload CVs/ })).not.toBeDisabled());
    expect(screen.queryByText(/CV upload isn.t available yet/)).not.toBeInTheDocument();
  });

  it("shows a specific inline error for project_not_ready_for_upload WITHOUT hiding the candidate list or upload form", async () => {
    mockLoad({
      status: "READY_FOR_CV_UPLOAD",
      links: [{ candidateId: "cand-1", anonymizedLabel: "Candidate #001", documents: [] }],
    });
    render(<CandidatesPage />);
    await waitFor(() => expect(screen.getByText("Candidate #001")).toBeInTheDocument());

    const { ApiError } = await import("../../../../lib/api");
    apiFetchMock.mockImplementationOnce(() =>
      Promise.reject(new ApiError(400, { error: "project_not_ready_for_upload" })),
    );

    const file = new File(["dummy"], "resume.pdf", { type: "application/pdf" });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    fireEvent.change(input);
    fireEvent.submit(input.closest("form")!);

    await waitFor(() =>
      expect(
        screen.getByText("This project is not ready for CV uploads. Requirements must be approved first (project status: Ready for CV Upload)."),
      ).toBeInTheDocument(),
    );

    // The rest of the page must still be visible — this is the specific
    // regression the fix addresses (an upload rejection must not replace
    // the whole page with a bare error view).
    expect(screen.getByText("Candidate #001")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Upload CVs/ })).toBeInTheDocument();
  });

  it("shows a generic error for any other upload failure, still without hiding the page", async () => {
    mockLoad({ status: "READY_FOR_CV_UPLOAD", links: [{ candidateId: "cand-1", anonymizedLabel: "Candidate #001", documents: [] }] });
    render(<CandidatesPage />);
    await waitFor(() => expect(screen.getByText("Candidate #001")).toBeInTheDocument());

    const { ApiError } = await import("../../../../lib/api");
    apiFetchMock.mockImplementationOnce(() => Promise.reject(new ApiError(500, {})));

    const file = new File(["dummy"], "resume.pdf", { type: "application/pdf" });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    fireEvent.change(input);
    fireEvent.submit(input.closest("form")!);

    await waitFor(() => expect(screen.getByText("Upload failed (500).")).toBeInTheDocument());
    expect(screen.getByText("Candidate #001")).toBeInTheDocument();
  });

  it("clears the previous upload error once a retry succeeds, and the page stays functional throughout", async () => {
    mockLoad({
      status: "READY_FOR_CV_UPLOAD",
      links: [{ candidateId: "cand-1", anonymizedLabel: "Candidate #001", documents: [] }],
    });
    render(<CandidatesPage />);
    await waitFor(() => expect(screen.getByText("Candidate #001")).toBeInTheDocument());

    const { ApiError } = await import("../../../../lib/api");
    const file = new File(["dummy"], "resume.pdf", { type: "application/pdf" });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;

    // First attempt fails.
    apiFetchMock.mockImplementationOnce(() =>
      Promise.reject(new ApiError(400, { error: "project_not_ready_for_upload" })),
    );
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    fireEvent.change(input);
    fireEvent.submit(input.closest("form")!);

    const errorText = "This project is not ready for CV uploads. Requirements must be approved first (project status: Ready for CV Upload).";
    await waitFor(() => expect(screen.getByText(errorText)).toBeInTheDocument());
    expect(screen.getByText("Candidate #001")).toBeInTheDocument();

    // Retry succeeds — the error must disappear, and the page (candidate
    // list, upload form) must remain intact and usable.
    apiFetchMock.mockImplementationOnce(() => Promise.resolve({ staged: [{ stagedUploadId: "su-1", filename: "resume.pdf" }], rejected: [] }));
    mockLoad({
      status: "READY_FOR_CV_UPLOAD",
      links: [{ candidateId: "cand-1", anonymizedLabel: "Candidate #001", documents: [] }],
    }); // subsequent load() calls after the successful upload
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    fireEvent.change(input);
    fireEvent.submit(input.closest("form")!);

    await waitFor(() => expect(screen.queryByText(errorText)).not.toBeInTheDocument());
    expect(screen.getByText("Candidate #001")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Upload CVs/ })).not.toBeDisabled();
  });
});
