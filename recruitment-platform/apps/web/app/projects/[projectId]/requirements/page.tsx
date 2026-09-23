"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { apiFetch, ApiError } from "../../../../lib/api";

interface SemanticConcept {
  concept: string;
  relevance: "DIRECT" | "RELEVANT" | "PARTIALLY_RELEVANT" | "NOT_RELEVANT";
  rationale: string;
}
interface Criterion {
  description: string;
}
interface Requirement {
  id: string;
  category: string;
  customCategoryLabel: string | null;
  description: string;
  mandatory: boolean;
  priority: string;
  evidenceCriteria: string | null;
  hrNotes: string | null;
  aiInterpretationSummary: string | null;
  aiSuggestedWeight: string | null;
  hrApprovedWeight: string | null;
  status: string;
  semanticConcepts: SemanticConcept[];
  criteria: Criterion[];
}

const CATEGORIES = [
  "EDUCATION",
  "PROFESSIONAL_EXPERIENCE",
  "FUNCTIONAL_EXPERIENCE",
  "TECHNICAL_SKILLS",
  "INDUSTRY_EXPERIENCE",
  "CERTIFICATIONS",
  "LANGUAGES",
  "BEHAVIORAL_COMPETENCY",
  "MANAGEMENT_LEADERSHIP",
  "LOCATION_MOBILITY",
  "OTHER",
];

// The Weighting Review screen (Phase 2, Section 7). Evidence-first, never a
// bare "Candidate = 87%" layout (Section 8): every row shows the reasoning
// behind its number, and the whole screen is about requirement coverage,
// not a single score.
export default function RequirementsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [whyOpenId, setWhyOpenId] = useState<string | null>(null);

  async function load() {
    try {
      const data = await apiFetch<Requirement[]>(`/projects/${projectId}/requirements`);
      setRequirements(data);
      setError(null);
    } catch {
      setError("Could not load requirements.");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const total = requirements.reduce(
    (sum, r) => sum + Number(r.hrApprovedWeight ?? r.aiSuggestedWeight ?? 0),
    0,
  );

  async function runInterpretation() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/projects/${projectId}/requirements/interpret`, { method: "POST" });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? `AI interpretation failed (${e.status}).` : "AI interpretation failed.");
    } finally {
      setBusy(false);
    }
  }

  async function runWeighting() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/projects/${projectId}/requirements/weighting-recommendation`, { method: "POST" });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? `AI weighting failed (${e.status}).` : "AI weighting failed.");
    } finally {
      setBusy(false);
    }
  }

  async function setWeight(requirementId: string, weight: number, hrNote?: string) {
    try {
      await apiFetch(`/projects/${projectId}/requirements/${requirementId}/weight`, {
        method: "PATCH",
        body: JSON.stringify({ weight, hrNote }),
      });
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.body && (e.body as { error?: string }).error === "hr_note_required") {
        const note = window.prompt("This changes the AI-suggested weight — add a note explaining why:");
        if (note) await setWeight(requirementId, weight, note);
      } else {
        setError("Could not update weight.");
      }
    }
  }

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/projects/${projectId}/requirements/approve`, { method: "POST" });
      await load();
    } catch (e) {
      if (e instanceof ApiError && (e.body as { error?: string })?.error === "weights_must_total_100") {
        setError(`Total approved weight is ${(e.body as { total?: number }).total}% — it must equal 100%.`);
      } else {
        setError("Could not approve requirements.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ padding: 32, maxWidth: 1000 }}>
      <p><Link href={`/projects/${projectId}`}>← Project overview</Link></p>
      <h1>Job Requirements &amp; Weighting Review</h1>
      <p style={{ color: "#555" }}>
        What evidence exists, how strong it is, and what HR approved — not a single score.
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button onClick={runInterpretation} disabled={busy || requirements.length === 0}>
          Ask AI to interpret requirements
        </button>
        <button onClick={runWeighting} disabled={busy || requirements.length === 0}>
          Get AI weighting recommendation
        </button>
        <NewRequirementForm projectId={projectId} onCreated={load} />
      </div>

      {error && <p style={{ color: "crimson" }}>{error}</p>}

      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "2px solid #ddd" }}>
            <th style={{ padding: 8 }}>Requirement</th>
            <th style={{ padding: 8 }}>Category</th>
            <th style={{ padding: 8 }}>M/P</th>
            <th style={{ padding: 8 }}>AI Weight</th>
            <th style={{ padding: 8 }}>HR Weight</th>
            <th style={{ padding: 8 }}>Diff</th>
            <th style={{ padding: 8 }}>Status</th>
            <th style={{ padding: 8 }}></th>
          </tr>
        </thead>
        <tbody>
          {requirements.map((r) => {
            const ai = r.aiSuggestedWeight ? Number(r.aiSuggestedWeight) : null;
            const hr = r.hrApprovedWeight ? Number(r.hrApprovedWeight) : null;
            const diff = ai !== null && hr !== null ? (hr - ai).toFixed(1) : "—";
            return (
              <>
                <tr key={r.id} style={{ borderBottom: "1px solid #eee", verticalAlign: "top" }}>
                  <td style={{ padding: 8, maxWidth: 320 }}>{r.description}</td>
                  <td style={{ padding: 8 }}>{r.customCategoryLabel ?? r.category.replaceAll("_", " ")}</td>
                  <td style={{ padding: 8 }}>{r.mandatory ? "Mandatory" : "Preferred"}</td>
                  <td style={{ padding: 8 }}>{ai ?? "—"}</td>
                  <td style={{ padding: 8 }}>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      defaultValue={hr ?? ai ?? 0}
                      style={{ width: 64 }}
                      onBlur={(e) => {
                        const value = Number(e.target.value);
                        if (value !== hr) setWeight(r.id, value);
                      }}
                    />
                  </td>
                  <td style={{ padding: 8 }}>{diff}</td>
                  <td style={{ padding: 8 }}>{r.status.replaceAll("_", " ")}</td>
                  <td style={{ padding: 8 }}>
                    {r.aiInterpretationSummary && (
                      <button onClick={() => setWhyOpenId(whyOpenId === r.id ? null : r.id)}>
                        Why this weight?
                      </button>
                    )}
                  </td>
                </tr>
                {whyOpenId === r.id && (
                  <tr key={`${r.id}-why`}>
                    <td colSpan={8} style={{ padding: 12, background: "#fafafa" }}>
                      <p><strong>AI interpretation:</strong> {r.aiInterpretationSummary}</p>
                      {r.hrNotes && <p><strong>Weighting rationale:</strong> {r.hrNotes}</p>}
                      {r.criteria.length > 0 && (
                        <>
                          <p><strong>Evidence criteria</strong> — what convincing evidence would look like in a CV:</p>
                          <ul>
                            {r.criteria.map((c, i) => (
                              <li key={i}>{c.description}</li>
                            ))}
                          </ul>
                        </>
                      )}
                      {r.semanticConcepts.length > 0 && (
                        <>
                          <p><strong>Related concepts</strong>:</p>
                          <ul>
                            {r.semanticConcepts.map((c, i) => (
                              <li key={i}>
                                <strong>{c.concept}</strong> — {c.relevance.replaceAll("_", " ")}: {c.rationale}
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                    </td>
                  </tr>
                )}
              </>
            );
          })}
        </tbody>
      </table>

      <p style={{ marginTop: 16 }}>
        <strong>Total: {total.toFixed(1)}%</strong>{" "}
        {Math.abs(total - 100) > 0.01 && requirements.length > 0 && (
          <span style={{ color: "crimson" }}>— must equal 100% to approve</span>
        )}
      </p>

      <button onClick={approve} disabled={busy || requirements.length === 0}>
        Approve requirement set
      </button>
    </main>
  );
}

function NewRequirementForm({ projectId, onCreated }: { projectId: string; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("FUNCTIONAL_EXPERIENCE");
  const [customCategoryLabel, setCustomCategoryLabel] = useState("");
  const [mandatory, setMandatory] = useState(true);

  if (!open) return <button onClick={() => setOpen(true)}>+ Add requirement</button>;

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        await apiFetch(`/projects/${projectId}/requirements`, {
          method: "POST",
          body: JSON.stringify({
            description,
            category,
            customCategoryLabel: category === "OTHER" ? customCategoryLabel : undefined,
            mandatory,
          }),
        });
        setDescription("");
        setOpen(false);
        onCreated();
      }}
      style={{ display: "flex", gap: 8, alignItems: "center" }}
    >
      <input
        required
        placeholder="Requirement text"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        style={{ width: 280 }}
      />
      <select value={category} onChange={(e) => setCategory(e.target.value)}>
        {CATEGORIES.map((c) => (
          <option key={c} value={c}>
            {c.replaceAll("_", " ")}
          </option>
        ))}
      </select>
      {category === "OTHER" && (
        <input
          required
          placeholder="Custom category"
          value={customCategoryLabel}
          onChange={(e) => setCustomCategoryLabel(e.target.value)}
        />
      )}
      <label>
        <input type="checkbox" checked={mandatory} onChange={(e) => setMandatory(e.target.checked)} /> Mandatory
      </label>
      <button type="submit">Add</button>
    </form>
  );
}
