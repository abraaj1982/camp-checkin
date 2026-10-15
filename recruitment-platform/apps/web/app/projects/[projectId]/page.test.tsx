/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import ProjectOverviewPage from "./page";

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj-1" }),
}));

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

const PROJECT = {
  id: "proj-1",
  title: "UAT-TEST Project",
  department: null,
  businessUnit: null,
  location: null,
  hiringManager: null,
  vacancies: 1,
  employmentType: null,
  description: null,
  status: "ON_HOLD",
  createdBy: "user-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  members: [],
};

function mockLoad(project = PROJECT) {
  apiFetchMock.mockImplementation((path: string) => {
    if (path === "/projects/proj-1") return Promise.resolve(project);
    if (path === "/projects/proj-1/requirements") return Promise.resolve([]);
    if (path === "/projects/proj-1/candidates") return Promise.resolve([]);
    if (path === "/projects/proj-1/staged-uploads") return Promise.resolve([]);
    throw new Error(`Unexpected path in test: ${path}`);
  });
}

describe("ProjectOverviewPage — ON_HOLD resume UI", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it("shows a resume button for an ON_HOLD project, including READY_FOR_CV_UPLOAD", async () => {
    mockLoad();
    render(<ProjectOverviewPage />);
    await waitFor(() => expect(screen.getByText("Project Details")).toBeInTheDocument());

    expect(screen.getByRole("button", { name: "Move to READY FOR CV UPLOAD" })).toBeInTheDocument();
  });

  it("shows a specific inline error for requirements_not_approved WITHOUT replacing the whole Overview page", async () => {
    mockLoad();
    render(<ProjectOverviewPage />);
    await waitFor(() => expect(screen.getByText("Project Details")).toBeInTheDocument());

    const { ApiError } = await import("../../../lib/api");
    apiFetchMock.mockImplementationOnce(() =>
      Promise.reject(new ApiError(400, { error: "requirements_not_approved" })),
    );

    fireEvent.click(screen.getByRole("button", { name: "Move to READY FOR CV UPLOAD" }));

    await waitFor(() =>
      expect(
        screen.getByText(
          "Cannot resume to Ready for CV Upload — one or more requirements are no longer approved (edited since the project was put on hold, or weights no longer total 100%).",
        ),
      ).toBeInTheDocument(),
    );

    // The regression this fix addresses: the page must still show the
    // project's own content, not just a bare error screen.
    expect(screen.getByText("Project Details")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Move to READY FOR CV UPLOAD" })).toBeInTheDocument();
  });

  it("re-fetches and reflects the new status after a successful resume", async () => {
    mockLoad();
    render(<ProjectOverviewPage />);
    await waitFor(() => expect(screen.getByText("Project Details")).toBeInTheDocument());

    apiFetchMock.mockImplementationOnce(() => Promise.resolve({})); // the POST /status call itself
    mockLoad({ ...PROJECT, status: "READY_FOR_CV_UPLOAD" }); // subsequent load() calls see the new status

    fireEvent.click(screen.getByRole("button", { name: "Move to READY FOR CV UPLOAD" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Move to ON HOLD" })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Move to READY FOR CV UPLOAD" })).not.toBeInTheDocument();
  });

  it("clears the previous status error once a retry succeeds, and reflects the updated status/buttons", async () => {
    mockLoad();
    render(<ProjectOverviewPage />);
    await waitFor(() => expect(screen.getByText("Project Details")).toBeInTheDocument());

    const { ApiError } = await import("../../../lib/api");
    const errorText =
      "Cannot resume to Ready for CV Upload — one or more requirements are no longer approved (edited since the project was put on hold, or weights no longer total 100%).";

    // First attempt fails.
    apiFetchMock.mockImplementationOnce(() =>
      Promise.reject(new ApiError(400, { error: "requirements_not_approved" })),
    );
    fireEvent.click(screen.getByRole("button", { name: "Move to READY FOR CV UPLOAD" }));
    await waitFor(() => expect(screen.getByText(errorText)).toBeInTheDocument());
    expect(screen.getByText("Project Details")).toBeInTheDocument();

    // Retry succeeds — the error must disappear, and the page must reflect
    // the new status (updated transition buttons).
    apiFetchMock.mockImplementationOnce(() => Promise.resolve({})); // the POST /status call itself
    mockLoad({ ...PROJECT, status: "READY_FOR_CV_UPLOAD" }); // subsequent load() calls see the new status
    fireEvent.click(screen.getByRole("button", { name: "Move to READY FOR CV UPLOAD" }));

    await waitFor(() => expect(screen.queryByText(errorText)).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Move to ON HOLD" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move to READY FOR CV UPLOAD" })).not.toBeInTheDocument();
  });
});
