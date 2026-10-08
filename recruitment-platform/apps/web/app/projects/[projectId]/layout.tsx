"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { apiFetch } from "../../../lib/api";
import { StatusBadge } from "../../components/StatusBadge";
import { Tabs, type TabItem } from "../../components/Tabs";
import { RequirementGateBanner } from "../../components/RequirementGateBanner";
import { colors, spacing, typeScale } from "../../design-tokens";

interface ProjectHeader {
  title: string;
  status: string;
}

/**
 * UI Batch 2a — the shared Project Workspace shell: breadcrumb, project
 * title/status, and the persistent tab strip, wrapping every nested route
 * under /projects/[projectId]. Each child page keeps its own <main> (one
 * per page, for a single landmark) but drops its own copy of the
 * breadcrumb/title/back-link that this layout now renders once.
 *
 * Fetches the project a second time (title/status only) independently of
 * the Overview page's own full fetch — a deliberate, low-risk trade-off for
 * a frontend-only batch rather than threading data across the server/client
 * boundary; both calls are idempotent GETs.
 */
export default function ProjectWorkspaceLayout({ children }: { children: ReactNode }) {
  const { projectId } = useParams<{ projectId: string }>();
  const pathname = usePathname();
  const [project, setProject] = useState<ProjectHeader | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<ProjectHeader>(`/projects/${projectId}`)
      .then((data) => {
        if (!cancelled) setProject(data);
      })
      .catch(() => {
        /* the page below renders its own error state from its own fetch */
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const isCompare = pathname.includes("/candidates/compare");
  const isCandidates = pathname.includes("/candidates") && !isCompare;
  const isRequirements = pathname.includes("/requirements");
  const isOverview = !isCandidates && !isCompare && !isRequirements;

  const tabs: TabItem[] = [
    { href: `/projects/${projectId}`, label: "Overview", active: isOverview },
    { href: `/projects/${projectId}/requirements`, label: "Requirements", active: isRequirements },
    { href: `/projects/${projectId}/candidates`, label: "Candidates", active: isCandidates },
    { href: `/projects/${projectId}/candidates/compare`, label: "Comparison", active: isCompare },
  ];

  return (
    <div style={{ padding: spacing.xxl, fontFamily: "system-ui, sans-serif" }}>
      <p><Link href="/projects" style={{ color: colors.brand700 }}>← All projects</Link></p>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: spacing.sm }}>
        <h1 style={typeScale.pageTitle}>{project?.title ?? "…"}</h1>
        {project && <StatusBadge status={project.status} />}
      </div>
      <Tabs items={tabs} />
      <RequirementGateBanner projectId={String(projectId)} />
      <div style={{ marginTop: spacing.lg }}>{children}</div>
    </div>
  );
}
