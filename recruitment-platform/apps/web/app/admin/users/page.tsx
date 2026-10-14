"use client";

import { useState } from "react";
import Link from "next/link";
import { apiFetch, ApiError } from "../../../lib/api";
import { Card } from "../../components/Card";
import { colors, spacing, typeScale } from "../../design-tokens";

/**
 * Admin-only HR account creation — the only way to add an HR user before
 * this was the seed script or a direct DB write. The backend's own
 * requireRole("HR_ADMIN", "SYSTEM_ADMIN") gate is the real authorization
 * boundary; a non-admin hitting this page simply gets a 403 from the API.
 */
export default function CreateUserPage() {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"HR_USER" | "HR_ADMIN" | "SYSTEM_ADMIN">("HR_USER");
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ email: string; name: string; role: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCreated(null);
    setSubmitting(true);
    try {
      const user = await apiFetch<{ email: string; name: string; role: string }>("/users", {
        method: "POST",
        body: JSON.stringify({ email, name, password, role }),
      });
      setCreated(user);
      setEmail("");
      setName("");
      setPassword("");
      setRole("HR_USER");
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setError("A user with that email already exists.");
      } else if (e instanceof ApiError && e.status === 403) {
        setError("You don't have permission to assign that role.");
      } else if (e instanceof ApiError && e.status === 400) {
        setError("Check the fields — a valid email, a name, and a password of at least 8 characters are required.");
      } else {
        setError("Could not create user.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main style={{ padding: spacing.xxl, maxWidth: 480, fontFamily: "system-ui, sans-serif" }}>
      <p><Link href="/projects" style={{ color: colors.brand700 }}>← Recruitment Projects</Link></p>
      <h1 style={typeScale.pageTitle}>Add HR User</h1>
      <p style={typeScale.meta}>Creates a new HR account. Requires HR_ADMIN or SYSTEM_ADMIN.</p>

      <Card style={{ marginTop: spacing.lg }}>
        <form onSubmit={handleSubmit} style={{ display: "grid", gap: 10 }}>
          <label>
            Email *
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={{ display: "block", width: "100%" }}
            />
          </label>
          <label>
            Name *
            <input required value={name} onChange={(e) => setName(e.target.value)} style={{ display: "block", width: "100%" }} />
          </label>
          <label>
            Password * (min 8 characters)
            <input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={{ display: "block", width: "100%" }}
            />
          </label>
          <label>
            Role
            <select value={role} onChange={(e) => setRole(e.target.value as typeof role)} style={{ display: "block", width: "100%" }}>
              <option value="HR_USER">HR_USER</option>
              <option value="HR_ADMIN">HR_ADMIN</option>
              <option value="SYSTEM_ADMIN">SYSTEM_ADMIN</option>
            </select>
          </label>
          {error && <p style={{ color: colors.danger700 }}>{error}</p>}
          {created && (
            <p style={{ color: colors.success700 }}>
              Created {created.name} ({created.email}) as {created.role}.
            </p>
          )}
          <button type="submit" disabled={submitting}>
            {submitting ? "Creating…" : "Create user"}
          </button>
        </form>
      </Card>
    </main>
  );
}
