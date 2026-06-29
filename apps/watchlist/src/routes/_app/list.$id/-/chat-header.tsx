import { Sparkles, X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { SheetClose, SheetHeader, SheetTitle } from "@/components/ui/sheet";

export function ChatSheetHeader({ actions }: { actions?: ReactNode }) {
  return (
    <SheetHeader className="flex-row items-center space-y-0 border-b">
      <SheetTitle className="flex min-w-0 flex-1 items-center gap-2">
        <Sparkles className="size-4 shrink-0" /> List assistant
      </SheetTitle>
      <div className="flex shrink-0 items-center gap-0.5">
        {actions}
        <SheetClose asChild>
          <Button variant="ghost" size="icon" className="size-8" aria-label="Close">
            <X className="size-4" />
          </Button>
        </SheetClose>
      </div>
    </SheetHeader>
  );
}
