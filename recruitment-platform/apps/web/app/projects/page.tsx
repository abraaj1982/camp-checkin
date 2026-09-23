"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "../../lib/api";
import { StatusBadge } from "./status-badge";

interface Project {
  id: string;
  title: string;
  department: string | null;
  status: string;
  createdAt: string;
}

// Evidence-first, status-driven list (architecture doc Section 31/Phase 2
// Section 12): clarity and actionability, no decorative dashboard widgets.
export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const data = await apiFetch<Project[]>("/projects");
      setProjects(data);
      setError(null);
    } catch {
      setError("Could not load projects. Are you logged in?");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <main style={{ padding: 32, maxWidth: 960 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>Recruitment Projects</h1>
        <button onClick={() => setShowCreate((v) => !v)}>
          {showCreate ? "Cancel" : "+ New Project"}
        </button>
      </div>

      {showCreate && (
        <CreateProjectForm
          onCreated={() => {
            setShowCreate(false);
            load();
          }}
        />
      )}

      {error && <p style={{ color: "crimson" }}>{error}</p>}
      {loading ? (
        <p>Loading…</p>
      ) : projects.length === 0 ? (
        <p style={{ color: "#666" }}>No projects yet.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 16 }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "2px solid #ddd" }}>
              <th style={{ padding: 8 }}>Position</th>
              <th style={{ padding: 8 }}>Department</th>
              <th style={{ padding: 8 }}>Status</th>
              <th style={{ padding: 8 }}>Created</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => (
              <tr key={p.id} style={{ borderBottom: "1px solid #eee" }}>
                <td style={{ padding: 8 }}>
                  <Link href={`/projects/${p.id}`}>{p.title}</Link>
                </td>
                <td style={{ padding: 8 }}>{p.department ?? "—"}</td>
                <td style={{ padding: 8 }}>
                  <StatusBadge status={p.status} />
                </td>
                <td style={{ padding: 8 }}>{new Date(p.createdAt).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

function CreateProjectForm({ onCreated }: { onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [department, setDepartment] = useState("");
  const [businessUnit, setBusinessUnit] = useState("");
  const [location, setLocation] = useState("");
  const [hiringManager, setHiringManager] = useState("");
  const [vacancies, setVacancies] = useState(1);
  const [employmentType, setEmploymentType] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch("/projects", {
        method: "POST",
        body: JSON.stringify({
          title,
          department: department || undefined,
          businessUnit: businessUnit || undefined,
          location: location || undefined,
          hiringManager: hiringManager || undefined,
          vacancies,
          employmentType: employmentType || undefined,
          description: description || undefined,
        }),
      });
      onCreated();
    } catch {
      setError("Could not create project.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      style={{
        border: "1px solid #ddd",
        borderRadius: 6,
        padding: 16,
        marginTop: 16,
        display: "grid",
        gap: 10,
        maxWidth: 480,
      }}
    >
      <label>
        Position title *
        <input required value={title} onChange={(e) => setTitle(e.target.value)} style={{ display: "block", width: "100%" }} />
      </label>
      <label>
        Department
        <input value={department} onChange={(e) => setDepartment(e.target.value)} style={{ display: "block", width: "100%" }} />
      </label>
      <label>
        Business unit
        <input value={businessUnit} onChange={(e) => setBusinessUnit(e.target.value)} style={{ display: "block", width: "100%" }} />
      </label>
      <label>
        Location
        <input value={location} onChange={(e) => setLocation(e.target.value)} style={{ display: "block", width: "100%" }} />
      </label>
      <label>
        Hiring manager
        <input value={hiringManager} onChange={(e) => setHiringManager(e.target.value)} style={{ display: "block", width: "100%" }} />
      </label>
      <label>
        Vacancies
        <input
          type="number"
          min={1}
          value={vacancies}
          onChange={(e) => setVacancies(Number(e.target.value))}
          style={{ display: "block", width: "100%" }}
        />
      </label>
      <label>
        Employment type
        <input value={employmentType} onChange={(e) => setEmploymentType(e.target.value)} style={{ display: "block", width: "100%" }} />
      </label>
      <label>
        Description
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} style={{ display: "block", width: "100%" }} />
      </label>
      {error && <p style={{ color: "crimson" }}>{error}</p>}
      <button type="submit" disabled={submitting}>
        {submitting ? "Creating…" : "Create project"}
      </button>
    </form>
  );
}
