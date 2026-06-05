import { QueryShell } from "./QueryShell";

export function ShellApp() {
  return (
    <div className="main">
      <p style={{ color: "var(--muted)", marginBottom: 16 }}>Database initialized and seeded.</p>
      <QueryShell />
    </div>
  );
}
