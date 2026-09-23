"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { apiFetch } from "../../../lib/api";
import { StatusBadge } from "../status-badge";

interface Member {
  userId: string;
  role: "OWNER" | "MEMBER";
  user: { name: string; email: string };
}

interface ProjectDetail {
  id: string;
  title: string;
  department: string | null;
  businessUnit: string | null;
  location: string | null;
  hiringManager: string | null;
  vacancies: number;
  employmentType: string | null;
  description: string | null;
  status: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  members: Member[];
}

const NEXT_STATUS: Record<string, string[]> = {
  DRAFT: ["ACTIVE", "ARCHIVED"],
  ACTIVE: ["ON_HOLD", "READY_FOR_CV_UPLOAD", "ARCHIVED"],
  ON_HOLD: ["ACTIVE", "ARCHIVED"],
  READY_FOR_CV_UPLOAD: ["ON_HOLD", "COMPLETED", "ARCHIVED"],
  COMPLETED: ["ARCHIVED"],
  ARCHIVED: [],
};

// Workflow: Project Overview -> Job Requirements -> AI Analysis ->
// Weighting Review -> Approve -> Ready for CV Upload (Phase 2, Section 12).
export default function ProjectOverviewPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [assignEmail, setAssignEmail] = useState("");

  async function load() {
    try {
      const data = await apiFetch<ProjectDetail>(`/projects/${projectId}`);
      setProject(data);
      setError(null);
    } catch {
      setError("Project not found, or you don't have access to it.");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function changeStatus(status: string) {
    try {
      await apiFetch(`/projects/${projectId}/status`, {
        method: "POST",
        body: JSON.stringify({ status }),
      });
      load();
    } catch {
      setError("Could not change status.");
    }
  }

  if (error) return <main style={{ padding: 32 }}><p style={{ color: "crimson" }}>{error}</p></main>;
  if (!project) return <main style={{ padding: 32 }}><p>Loading…</p></main>;

  return (
    <main style={{ padding: 32, maxWidth: 800 }}>
      <p><Link href="/projects">← All projects</Link></p>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h1>{project.title}</h1>
        <StatusBadge status={project.status} />
      </div>

      <dl style={{ display: "grid", gridTemplateColumns: "160px 1fr", rowGap: 6 }}>
        <dt style={{ color: "#666" }}>Department</dt>
        <dd>{project.department ?? "—"}</dd>
        <dt style={{ color: "#666" }}>Business unit</dt>
        <dd>{project.businessUnit ?? "—"}</dd>
        <dt style={{ color: "#666" }}>Location</dt>
        <dd>{project.location ?? "—"}</dd>
        <dt style={{ color: "#666" }}>Hiring manager</dt>
        <dd>{project.hiringManager ?? "—"}</dd>
        <dt style={{ color: "#666" }}>Vacancies</dt>
        <dd>{project.vacancies}</dd>
        <dt style={{ color: "#666" }}>Employment type</dt>
        <dd>{project.employmentType ?? "—"}</dd>
        <dt style={{ color: "#666" }}>Created</dt>
        <dd>{new Date(project.createdAt).toLocaleString()}</dd>
        <dt style={{ color: "#666" }}>Last updated</dt>
        <dd>{new Date(project.updatedAt).toLocaleString()}</dd>
      </dl>
      {project.description && <p>{project.description}</p>}

      <h2>Status</h2>
      <div style={{ display: "flex", gap: 8 }}>
        {(NEXT_STATUS[project.status] ?? []).map((s) => (
          <button key={s} onClick={() => changeStatus(s)}>
            Move to {s.replaceAll("_", " ")}
          </button>
        ))}
        {(NEXT_STATUS[project.status] ?? []).length === 0 && <span style={{ color: "#666" }}>No further transitions.</span>}
      </div>

      <h2>Assigned HR users</h2>
      <ul>
        {project.members.map((m) => (
          <li key={m.userId}>
            {m.user.name} ({m.user.email}) — {m.role}
          </li>
        ))}
      </ul>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const users = await apiFetch<{ id: string; email: string }[]>(`/users?search=${encodeURIComponent(assignEmail)}`).catch(() => []);
            const match = users.find((u) => u.email === assignEmail);
            if (!match) {
              setError("No user found with that email. (User lookup endpoint is minimal in Phase 2 — enter the exact email.)");
              return;
            }
            await apiFetch(`/projects/${projectId}/members`, {
              method: "POST",
              body: JSON.stringify({ userId: match.id, role: "MEMBER" }),
            });
            setAssignEmail("");
            load();
          } catch {
            setError("Could not assign user.");
          }
        }}
        style={{ display: "flex", gap: 8 }}
      >
        <input
          placeholder="teammate@example.com"
          value={assignEmail}
          onChange={(e) => setAssignEmail(e.target.value)}
        />
        <button type="submit">Assign</button>
      </form>

      <h2>Job Requirements</h2>
      <p>
        <Link href={`/projects/${projectId}/requirements`}>Open requirements & weighting review →</Link>
      </p>

      <h2>Candidates</h2>
      <p>
        <Link href={`/projects/${projectId}/candidates`}>Upload CVs & view processing status →</Link>
      </p>
    </main>
  );
}
