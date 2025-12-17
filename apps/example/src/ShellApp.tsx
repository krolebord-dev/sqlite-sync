import { QueryShell } from "./QueryShell";

export function ShellApp() {
  return (
    <div className="p-8">
      <p className="text-gray-600">Database initialized and seeded!</p>

      <QueryShell />
    </div>
  );
}
