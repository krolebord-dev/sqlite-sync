import { useMatch } from "@tanstack/react-router";
import { FlameIcon, SkullIcon, ThumbsUpIcon } from "lucide-react";

export const priorityColors = {
  high: {
    bg: "bg-orange-500",
    border: "border-orange-500",
    text: "text-orange-500",
    icon: <FlameIcon />,
  },
  normal: {
    bg: "bg-blue-500",
    border: "border-blue-500",
    text: "text-blue-500",
    icon: <ThumbsUpIcon />,
  },
  low: {
    bg: "bg-gray-500",
    border: "border-gray-500",
    text: "text-gray-500",
    icon: <SkullIcon />,
  },
};

export function useListId() {
  return useMatch({ from: "/_app/list/$id", shouldThrow: false, select: (m) => m.loaderData?.list.id });
}
