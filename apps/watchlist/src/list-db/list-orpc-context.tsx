import { createContext, type ReactNode, useContext, useMemo } from "react";
import { getListDbOrpc, type ListDbORPCUtils } from "./list-orpc-client";

const ListDbOrpcContext = createContext<ListDbORPCUtils | null>(null);

export function ListDbOrpcProvider({ listId, children }: { listId: string; children: ReactNode }) {
  const orpc = useMemo(() => getListDbOrpc(listId), [listId]);

  return <ListDbOrpcContext.Provider value={orpc}>{children}</ListDbOrpcContext.Provider>;
}

export function useListOrpc(): ListDbORPCUtils {
  const context = useContext(ListDbOrpcContext);
  if (!context) {
    throw new Error("useListDbOrpc must be used within ListDbOrpcProvider");
  }
  return context;
}
