import { useSuspenseQuery } from "@tanstack/react-query";
import { useMatch } from "@tanstack/react-router";
import { useMemo } from "react";
import { orpc } from "@/orpc/orpc-client";

export function useListId() {
  return useMatch({
    from: "/_app/list/$id/",
    shouldThrow: false,
    select: (m) => m.loaderData?.list.id,
  });
}

export function useActiveList() {
  const lists = useSuspenseQuery(orpc.list.getLists.queryOptions());

  const selectedListId = useMatch({
    from: "/_app/list/$id/",
    shouldThrow: false,
    select: (m) => m.loaderData?.list.id,
  });
  const selectedList = useMemo(() => {
    return lists.data?.find((list) => list.id === selectedListId);
  }, [lists.data, selectedListId]);

  return selectedList;
}
