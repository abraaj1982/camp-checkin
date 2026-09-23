export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      style={{
        padding: "2px 8px",
        borderRadius: 4,
        fontSize: 12,
        background: "#eee",
        color: "#333",
      }}
    >
      {status.replaceAll("_", " ")}
    </span>
  );
}
