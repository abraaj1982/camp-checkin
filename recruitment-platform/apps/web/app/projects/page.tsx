"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "../../lib/api";
import { StatusBadge } from "../components/StatusBadge";
import { Card } from "../components/Card";
import { Table, TableHeadRow, HeaderCell, Row, Cell } from "../components/DataTable";
import { EmptyState } from "../components/EmptyState";
import { colors, radii, spacing, typeScale } from "../design-tokens";

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
    <main style={{ padding: spacing.xxl, maxWidth: 960, fontFamily: "system-ui, sans-serif" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1 style={typeScale.pageTitle}>Recruitment Projects</h1>
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

      {error && <p style={{ color: colors.danger700 }}>{error}</p>}
      {loading ? (
        <p>Loading…</p>
      ) : projects.length === 0 ? (
        <EmptyState>No projects yet.</EmptyState>
      ) : (
        <div style={{ marginTop: spacing.lg }}>
          <Table>
            <thead>
              <TableHeadRow>
                <HeaderCell>Position</HeaderCell>
                <HeaderCell>Department</HeaderCell>
                <HeaderCell>Status</HeaderCell>
                <HeaderCell>Created</HeaderCell>
              </TableHeadRow>
            </thead>
            <tbody>
              {projects.map((p) => (
                <Row key={p.id}>
                  <Cell>
                    <Link href={`/projects/${p.id}`} style={{ color: colors.brand700 }}>
                      {p.title}
                    </Link>
                  </Cell>
                  <Cell>{p.department ?? "—"}</Cell>
                  <Cell>
                    <StatusBadge status={p.status} />
                  </Cell>
                  <Cell>{new Date(p.createdAt).toLocaleDateString()}</Cell>
                </Row>
              ))}
            </tbody>
          </Table>
        </div>
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
    <Card style={{ marginTop: spacing.lg, maxWidth: 480 }}>
      <form onSubmit={handleSubmit} style={{ display: "grid", gap: 10 }}>
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
      {error && <p style={{ color: colors.danger700 }}>{error}</p>}
      <button type="submit" disabled={submitting}>
        {submitting ? "Creating…" : "Create project"}
      </button>
      </form>
    </Card>
  );
}
