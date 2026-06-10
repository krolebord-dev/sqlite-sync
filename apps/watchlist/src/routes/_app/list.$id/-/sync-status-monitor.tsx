import { toast } from "sonner";
import { useDb, useDbEvent } from "@/list-db/list-db";

export function SyncStatusMonitor() {
  const db = useDb();

  useDbEvent("remote-schema-version-mismatch", () => {
    toast.warning("A new version is available", {
      id: "sync-schema-mismatch",
      description: "Reload to update to the latest version.",
      duration: Number.POSITIVE_INFINITY,
      action: {
        label: "Reload",
        onClick: () => db.requestReload({ clean: false }),
      },
    });
  });

  useDbEvent("de-sync-detected", () => {
    toast.error("Your data is out of sync", {
      id: "sync-de-sync",
      description: "Reload to reset your local data and re-sync from the server.",
      duration: Number.POSITIVE_INFINITY,
      action: {
        label: "Reload & reset",
        onClick: () => db.requestReload({ clean: true }),
      },
    });
  });

  return null;
}
