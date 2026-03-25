import { useNavigate } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useCreateExpense } from "@/components/transaction-dialog";
import type { AccountItem } from "@/user-db/migrations";
import { useDb } from "@/user-db/user-db";
import { useAccountDialogStore } from "./account-dialog";
import { Button } from "./ui/button";

function formatBalance(balance: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(balance);
  } catch {
    return `${currency} ${balance.toFixed(2)}`;
  }
}

type AccountCardProps = {
  account: AccountItem;
};

export function AccountCard({ account }: AccountCardProps) {
  const db = useDb();
  const navigate = useNavigate();
  const openAccountDialog = useAccountDialogStore((s) => s.openEdit);
  const createExpense = useCreateExpense({ accountId: account.id });

  return (
    <div className="group">
      <div className="relative rounded-lg border bg-card text-card-foreground shadow-xs">
        {/* Hover actions */}
        <div className="absolute top-1.5 right-1.5 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            className="rounded-md p-1.5 text-muted-foreground/60 transition-colors hover:bg-destructive/10 hover:text-destructive"
            aria-label="Delete account"
            onClick={(e) => {
              e.stopPropagation();
              const linkedTransactions = db.db.executeKysely((q) =>
                q
                  .selectFrom("transaction_entry")
                  .select(["id"])
                  .where((eb) =>
                    eb.or([eb("accountId", "=", account.id), eb("counterpartyAccountId", "=", account.id)]),
                  )
                  .limit(1),
              ).rows;

              if (linkedTransactions.length > 0) {
                toast.error("Delete or move related transactions before removing this account.");
                return;
              }

              db.db.executeKysely((q) => q.deleteFrom("account").where("id", "=", account.id));
            }}
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>

        <div className="cursor-pointer select-none px-4 py-3" onClick={() => openAccountDialog(account.id)}>
          <div className="mb-2 flex items-center gap-2">
            <span
              className="inline-block size-3 shrink-0 rounded-full"
              style={{ backgroundColor: account.labelColor }}
            />
            {account.labelText ? (
              <span className="truncate font-medium text-sm">{account.labelText}</span>
            ) : (
              <span className="text-muted-foreground/50 text-sm italic">Untitled</span>
            )}
          </div>

          <p className="font-semibold text-lg tabular-nums">{formatBalance(account.balance, account.currency)}</p>

          {account.description && (
            <p className="mt-1 line-clamp-2 text-muted-foreground text-sm">{account.description}</p>
          )}
        </div>

        <div className="flex items-center justify-between border-t px-4 py-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={(event) => {
              event.stopPropagation();
              navigate({ to: "/transactions", search: { accountId: account.id } });
            }}
          >
            Activity
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={(event) => {
              event.stopPropagation();
              createExpense();
            }}
          >
            New entry
          </Button>
        </div>
      </div>
    </div>
  );
}

export { formatBalance };
