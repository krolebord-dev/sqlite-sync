import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  ArrowDownLeftIcon,
  ArrowLeftRightIcon,
  ArrowUpRightIcon,
  Landmark,
  PlusIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import { z } from "zod";
import { formatBalance } from "@/components/account-card";
import {
  useCreateExpense,
  useCreateIncome,
  useCreateTransfer,
  useTransactionDialogStore,
} from "@/components/transaction-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatDateTimeDisplay } from "@/lib/date-time";
import { getDisplayAmountForAccount, TRANSACTION_TYPES, type TransactionType } from "@/lib/transactions";
import { cn } from "@/lib/utils";
import { useDbQuery } from "@/user-db/user-db";

const transactionsSearchSchema = z.object({
  accountId: z.string().optional(),
  category: z.string().optional(),
  q: z.string().optional(),
  type: z.enum(TRANSACTION_TYPES).optional(),
});

export const Route = createFileRoute("/_app/transactions")({
  component: TransactionsPage,
  validateSearch: transactionsSearchSchema,
});

const TYPE_STYLE = {
  expense: {
    icon: ArrowDownLeftIcon,
    dot: "bg-red-500",
    badge: "bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-400",
    accent: "text-red-600 dark:text-red-400",
  },
  income: {
    icon: ArrowUpRightIcon,
    dot: "bg-emerald-500",
    badge: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400",
    accent: "text-emerald-600 dark:text-emerald-400",
  },
  transfer: {
    icon: ArrowLeftRightIcon,
    dot: "bg-blue-500",
    badge: "bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-400",
    accent: "text-blue-600 dark:text-blue-400",
  },
  adjustment: {
    icon: SlidersHorizontalIcon,
    dot: "bg-amber-500",
    badge: "bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400",
    accent: "text-amber-600 dark:text-amber-400",
  },
} satisfies Record<TransactionType, { icon: unknown; dot: string; badge: string; accent: string }>;

function summaryAmountClass(amount: number) {
  if (amount > 0) {
    return "text-emerald-600 dark:text-emerald-400";
  }

  if (amount < 0) {
    return "text-rose-600 dark:text-rose-400";
  }

  return "text-foreground";
}

function renderCurrencyBreakdown(summaryByCurrency: Map<string, number>) {
  if (summaryByCurrency.size === 0) {
    return <span className="font-mono font-semibold text-lg tabular-nums">0</span>;
  }

  return (
    <div className="space-y-1">
      {Array.from(summaryByCurrency.entries()).map(([currency, amount]) => (
        <p key={currency} className={cn("font-mono font-semibold text-lg tabular-nums", summaryAmountClass(amount))}>
          {formatBalance(amount, currency)}
        </p>
      ))}
    </div>
  );
}

function TransactionsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const openEdit = useTransactionDialogStore((state) => state.openEdit);
  const createExpense = useCreateExpense(search.accountId ? { accountId: search.accountId } : undefined);
  const createIncome = useCreateIncome(search.accountId ? { accountId: search.accountId } : undefined);
  const createTransfer = useCreateTransfer(search.accountId ? { accountId: search.accountId } : undefined);
  const filteredAccountId = search.accountId;

  const { data: accounts } = useDbQuery((db) => db.selectFrom("account").selectAll().orderBy("order", "asc"));
  const { data: transactions } = useDbQuery((db) => {
    let query = db.selectFrom("transaction_entry").selectAll();

    if (filteredAccountId) {
      query = query.where((eb) =>
        eb.or([eb("accountId", "=", filteredAccountId), eb("counterpartyAccountId", "=", filteredAccountId)]),
      );
    }

    if (search.type) {
      query = query.where("type", "=", search.type);
    }

    if (search.category) {
      query = query.where("category", "like", `%${search.category}%`);
    }

    if (search.q) {
      query = query.where((eb) =>
        eb.or([
          eb("title", "like", `%${search.q}%`),
          eb("notes", "like", `%${search.q}%`),
          eb("category", "like", `%${search.q}%`),
        ]),
      );
    }

    return query.orderBy("effectiveAt", "desc").orderBy("createdAt", "desc");
  });

  const accountMap = new Map(accounts.map((account) => [account.id, account]));
  const selectedAccount = search.accountId ? accountMap.get(search.accountId) : undefined;

  const summary = {
    expenseByCurrency: new Map<string, number>(),
    incomeByCurrency: new Map<string, number>(),
    netByCurrency: new Map<string, number>(),
  };

  for (const transaction of transactions) {
    const display = getDisplayAmountForAccount(transaction, search.accountId);
    if (!display.currency) {
      continue;
    }

    if (transaction.type === "income") {
      summary.incomeByCurrency.set(
        display.currency,
        (summary.incomeByCurrency.get(display.currency) ?? 0) + Math.abs(display.amount),
      );
      summary.netByCurrency.set(display.currency, (summary.netByCurrency.get(display.currency) ?? 0) + display.amount);
    } else if (transaction.type === "expense") {
      summary.expenseByCurrency.set(
        display.currency,
        (summary.expenseByCurrency.get(display.currency) ?? 0) + Math.abs(display.amount),
      );
      summary.netByCurrency.set(display.currency, (summary.netByCurrency.get(display.currency) ?? 0) + display.amount);
    } else if (transaction.type === "adjustment") {
      summary.netByCurrency.set(display.currency, (summary.netByCurrency.get(display.currency) ?? 0) + display.amount);
    }
  }

  function patchSearch(next: Partial<typeof search>) {
    navigate({
      to: "/transactions",
      search: (prev) => {
        const merged = { ...prev, ...next };
        return {
          accountId: merged.accountId || undefined,
          category: merged.category || undefined,
          q: merged.q || undefined,
          type: merged.type || undefined,
        };
      },
    });
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="font-semibold text-xl">Transactions</h1>
          <p className="text-muted-foreground text-sm">
            {selectedAccount
              ? `Showing ledger activity for ${selectedAccount.labelText || "Untitled account"}.`
              : "Track expenses, income, transfers, and balance adjustments."}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button onClick={createExpense} size="sm">
            <ArrowDownLeftIcon className="size-4" />
            Expense
          </Button>
          <Button onClick={createIncome} size="sm" variant="outline">
            <ArrowUpRightIcon className="size-4" />
            Income
          </Button>
          <Button onClick={createTransfer} size="sm" variant="outline">
            <ArrowLeftRightIcon className="size-4" />
            Transfer
          </Button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-lg border bg-card p-4 shadow-xs">
          <div className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-emerald-500" />
            <p className="text-muted-foreground text-xs uppercase tracking-wide">Income</p>
          </div>
          <div className="mt-2">{renderCurrencyBreakdown(summary.incomeByCurrency)}</div>
        </div>
        <div className="rounded-lg border bg-card p-4 shadow-xs">
          <div className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-red-500" />
            <p className="text-muted-foreground text-xs uppercase tracking-wide">Expenses</p>
          </div>
          <div className="mt-2">{renderCurrencyBreakdown(summary.expenseByCurrency)}</div>
        </div>
        <div className="rounded-lg border bg-card p-4 shadow-xs">
          <div className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-blue-500" />
            <p className="text-muted-foreground text-xs uppercase tracking-wide">Net change</p>
          </div>
          <div className="mt-2">{renderCurrencyBreakdown(summary.netByCurrency)}</div>
        </div>
        <div className="rounded-lg border bg-card p-4 shadow-xs">
          <div className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-primary" />
            <p className="text-muted-foreground text-xs uppercase tracking-wide">Entries</p>
          </div>
          <p className="mt-2 font-mono font-semibold text-lg tabular-nums">{transactions.length}</p>
          <p className="mt-1 text-muted-foreground text-xs">Transfers are excluded from the summary totals above.</p>
        </div>
      </div>

      <div className="grid gap-3 rounded-lg border bg-card p-4 shadow-xs md:grid-cols-2 xl:grid-cols-4">
        <div className="space-y-1">
          <label htmlFor="transactions-account" className="text-muted-foreground text-xs uppercase tracking-wide">
            Account
          </label>
          <Select
            value={search.accountId ?? "__all__"}
            onValueChange={(value) => patchSearch({ accountId: value === "__all__" ? undefined : value })}
          >
            <SelectTrigger id="transactions-account" className="w-full">
              <SelectValue placeholder="All accounts" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All accounts</SelectItem>
              {accounts.map((account) => (
                <SelectItem key={account.id} value={account.id}>
                  {account.labelText || "Untitled"} ({account.currency})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <label htmlFor="transactions-type" className="text-muted-foreground text-xs uppercase tracking-wide">
            Type
          </label>
          <Select
            value={search.type ?? "__all__"}
            onValueChange={(value) =>
              patchSearch({ type: value === "__all__" ? undefined : (value as TransactionType) })
            }
          >
            <SelectTrigger id="transactions-type" className="w-full">
              <SelectValue placeholder="All types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All types</SelectItem>
              {TRANSACTION_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {type[0].toUpperCase() + type.slice(1)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <label htmlFor="transactions-category" className="text-muted-foreground text-xs uppercase tracking-wide">
            Category
          </label>
          <Input
            id="transactions-category"
            value={search.category ?? ""}
            onChange={(event) => patchSearch({ category: event.currentTarget.value })}
            placeholder="Filter category"
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="transactions-search" className="text-muted-foreground text-xs uppercase tracking-wide">
            Search
          </label>
          <Input
            id="transactions-search"
            value={search.q ?? ""}
            onChange={(event) => patchSearch({ q: event.currentTarget.value })}
            placeholder="Title, notes, category"
          />
        </div>
      </div>

      {transactions.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed bg-card px-6 py-14 text-center">
          <Landmark className="size-8 text-muted-foreground" />
          <div>
            <p className="font-medium">No transactions match this view.</p>
            <p className="text-muted-foreground text-sm">Create an entry or relax the current filters.</p>
          </div>
          <Button onClick={createExpense} variant="outline">
            <PlusIcon className="size-4" />
            New expense
          </Button>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card shadow-xs">
          <div className="divide-y">
            {transactions.map((transaction) => {
              const primaryAccount = accountMap.get(transaction.accountId);
              const secondaryAccount = transaction.counterpartyAccountId
                ? accountMap.get(transaction.counterpartyAccountId)
                : undefined;
              const display = getDisplayAmountForAccount(transaction, search.accountId);
              const isTransfer = transaction.type === "transfer";
              const typeStyle = TYPE_STYLE[transaction.type as TransactionType] ?? TYPE_STYLE.expense;
              const title =
                transaction.title ||
                (transaction.type === "expense"
                  ? "Expense"
                  : transaction.type === "income"
                    ? "Income"
                    : transaction.type === "adjustment"
                      ? "Adjustment"
                      : "Transfer");

              return (
                <button
                  key={transaction.id}
                  type="button"
                  onClick={() => openEdit(transaction.id)}
                  className="flex w-full flex-col gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40 sm:flex-row sm:items-center"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-medium">{title}</span>
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide",
                          typeStyle.badge,
                        )}
                      >
                        <span className={cn("size-1.5 rounded-full", typeStyle.dot)} />
                        {transaction.type}
                      </span>
                      {transaction.category ? (
                        <span className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">
                          {transaction.category}
                        </span>
                      ) : null}
                    </div>

                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-sm">
                      <span>{formatDateTimeDisplay(transaction.effectiveAt)}</span>
                      <span>
                        {primaryAccount?.labelText || "Untitled"}
                        {isTransfer && secondaryAccount ? ` \u2192 ${secondaryAccount.labelText || "Untitled"}` : null}
                      </span>
                    </div>

                    {transaction.notes ? (
                      <p className="mt-1 line-clamp-2 text-muted-foreground text-sm">{transaction.notes}</p>
                    ) : null}
                  </div>

                  <div className="shrink-0 text-right">
                    {isTransfer && !search.accountId ? (
                      <div className="space-y-1">
                        <p className="font-mono font-medium tabular-nums">
                          {formatBalance(transaction.amount, transaction.accountCurrency)}
                        </p>
                        {transaction.counterpartyAmount !== null ? (
                          <p className="font-mono text-muted-foreground text-sm tabular-nums">
                            {formatBalance(transaction.counterpartyAmount, transaction.counterpartyCurrency)}
                          </p>
                        ) : null}
                      </div>
                    ) : (
                      <p className={cn("font-mono font-medium tabular-nums", summaryAmountClass(display.amount))}>
                        {formatBalance(display.amount, display.currency)}
                      </p>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
