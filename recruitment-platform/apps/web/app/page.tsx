"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "../lib/api";
import { Card } from "./components/Card";
import { colors, spacing, typeScale } from "./design-tokens";

/**
 * Landing page. The product itself (project workspace, requirements,
 * candidates, comparison, decisions) lives under /projects — this page is
 * just the entry point, so it stays thin: identify the product, and hand
 * the visitor straight to /projects (or /login first, if not authenticated).
 */
export default function HomePage() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch("/auth/me")
      .then(() => {
        if (!cancelled) setAuthenticated(true);
      })
      .catch(() => {
        if (!cancelled) setAuthenticated(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main style={{ padding: spacing.xxl, maxWidth: 640, fontFamily: "system-ui, sans-serif" }}>
      <h1 style={typeScale.pageTitle}>Recruitment Intelligence Platform</h1>
      <p style={{ ...typeScale.meta, marginTop: spacing.xs }}>Evidence-based candidate review for HR teams.</p>

      <Card style={{ marginTop: spacing.lg }}>
        <p style={{ margin: 0, ...typeScale.body }}>
          Define job requirements, upload candidate CVs, and review evidence-backed assessments and
          side-by-side comparisons — every HR decision stays with you, never automated.
        </p>
        <p style={{ marginTop: spacing.md, marginBottom: 0 }}>
          {authenticated === null ? (
            <span style={typeScale.meta}>Loading…</span>
          ) : authenticated ? (
            <Link href="/projects" style={{ color: colors.brand700, fontWeight: 600 }}>
              Go to Recruitment Projects →
            </Link>
          ) : (
            <Link href="/login" style={{ color: colors.brand700, fontWeight: 600 }}>
              Log in →
            </Link>
          )}
        </p>
      </Card>
    </main>
  );
}
