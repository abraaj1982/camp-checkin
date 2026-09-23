// Basic UI shell for Phase 1 (Foundation). Real screens — Dashboard,
// Recruitment Projects, Requirements, AI Weighting Review, etc. — are built
// in Phases 2-7 per the approved plan; this placeholder exists so the app
// boots and confirms the API/session wiring end to end without pretending
// any of those screens work yet (master instruction, Section 49).

export default function HomePage() {
  return (
    <main style={{ padding: 32, maxWidth: 640 }}>
      <h1>Recruitment Intelligence Platform</h1>
      <p style={{ color: "#555" }}>AI-Powered Evidence-Based Candidate Assessment</p>
      <p>
        Foundation phase: authentication and the AI Gateway are wired up. Recruitment
        Project, Requirements, CV Upload, and Assessment screens are not built yet
        (Phases 2 through 7).
      </p>
      <a href="/login">Log in</a>
    </main>
  );
}
