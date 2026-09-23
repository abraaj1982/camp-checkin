// Basic UI shell. Recruitment Project + Job Requirements screens are built
// (Phase 2); CV Upload, Blind Assessment, and Candidate Comparison screens
// are not built yet (Phases 3-7 per the approved plan) — this page does not
// pretend they work (master instruction, Section 49).

export default function HomePage() {
  return (
    <main style={{ padding: 32, maxWidth: 640 }}>
      <h1>Recruitment Intelligence Platform</h1>
      <p style={{ color: "#555" }}>AI-Powered Evidence-Based Candidate Assessment</p>
      <p>
        Recruitment Project and Job Requirements management are implemented (Phase 2).
        CV Upload, Blind Assessment, and Candidate Comparison screens are not built yet
        (Phases 3 through 7).
      </p>
      <p>
        <a href="/login">Log in</a> · <a href="/projects">Recruitment Projects</a>
      </p>
    </main>
  );
}
