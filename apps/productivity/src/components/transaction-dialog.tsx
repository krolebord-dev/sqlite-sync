import { useStore } from "@tanstack/react-form";
import {
  ArrowDownLeftIcon,
  ArrowLeftRightIcon,
  ArrowUpRightIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback } from "react";
import { toast } from "sonner";
import { create } from "zustand";
import { combine } from "zustand/middleware";
import { formatDateTimeLocal, parseDateTimeLocal } from "@/lib/date-time";
import {
  createTransaction,
  deleteTransaction,
  TRANSACTION_TYPES,
  type TransactionType,
  updateTransaction,
} from "@/lib/transactions";
import { cn } from "@/lib/utils";
import { useDb, useDbQuery } from "@/user-db/user-db";
import { useCreateAccount } from "./account-dialog";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";
import { useAppForm } from "./ui/form";
import { SelectItem } from "./ui/select";

type TransactionDialogDraft = {
  accountId?: string;
  counterpartyAccountId?: string;
  type?: TransactionType;
};

type TransactionDialogState = {
  draft: TransactionDialogDraft | null;
  isOpen: boolean;
  mode: "create" | "edit" | null;
  openRevision: number;
  transactionId: string | null;
};

const defaultDraft: TransactionDialogDraft = {
  type: "expense",
};

export const useTransactionDialogStore = create(
  combine(
    {
      isOpen: false,
      mode: null,
      transactionId: null,
      draft: null,
      openRevision: 0,
    } as TransactionDialogState,
    (set, get) => ({
      close: () => set({ isOpen: false, mode: null, transactionId: null, draft: null }),
      openCreate: (draft?: TransactionDialogDraft) =>
        set({
          isOpen: true,
          mode: "create",
          transactionId: null,
          draft: { ...defaultDraft, ...draft },
          openRevision: get().openRevision + 1,
        }),
      openEdit: (transactionId: string) =>
        set({
          isOpen: true,
          mode: "edit",
          transactionId,
          draft: null,
          openRevision: get().openRevision + 1,
        }),
    }),
  ),
);

function useOpenTransaction(defaults?: TransactionDialogDraft) {
  const openCreate = useTransactionDialogStore((state) => state.openCreate);
  return useCallback(() => openCreate(defaults), [defaults, openCreate]);
}

export function useCreateExpense(defaults?: Omit<TransactionDialogDraft, "type">) {
  return useOpenTransaction({ ...defaults, type: "expense" });
}

export function useCreateIncome(defaults?: Omit<TransactionDialogDraft, "type">) {
  return useOpenTransaction({ ...defaults, type: "income" });
}

export function useCreateTransfer(defaults?: Omit<TransactionDialogDraft, "type">) {
  return useOpenTransaction({ ...defaults, type: "transfer" });
}

const TYPE_CONFIG = {
  expense: {
    icon: ArrowDownLeftIcon,
    label: "Expense",
    activeClass: "bg-background text-red-600 shadow-sm dark:bg-input/50 dark:text-red-400",
    dotColor: "bg-red-500",
  },
  income: {
    icon: ArrowUpRightIcon,
    label: "Income",
    activeClass: "bg-background text-emerald-600 shadow-sm dark:bg-input/50 dark:text-emerald-400",
    dotColor: "bg-emerald-500",
  },
  transfer: {
    icon: ArrowLeftRightIcon,
    label: "Transfer",
    activeClass: "bg-background text-blue-600 shadow-sm dark:bg-input/50 dark:text-blue-400",
    dotColor: "bg-blue-500",
  },
  adjustment: {
    icon: SlidersHorizontalIcon,
    label: "Adjust",
    activeClass: "bg-background text-amber-600 shadow-sm dark:bg-input/50 dark:text-amber-400",
    dotColor: "bg-amber-500",
  },
};

function getDialogTitle(mode: "create" | "edit" | null, type: TransactionType | undefined) {
  if (mode === "edit") {
    return type === "adjustment" ? "Edit adjustment" : "Edit transaction";
  }

  switch (type) {
    case "income":
      return "New income";
    case "transfer":
      return "New transfer";
    case "adjustment":
      return "New adjustment";
    default:
      return "New expense";
  }
}

function TransactionDialogContent() {
  const db = useDb();
  const createAccount = useCreateAccount();
  const { draft, isOpen, mode, transactionId } = useTransactionDialogStore();
  const closeDialog = useTransactionDialogStore((state) => state.close);

  const { data: accounts } = useDbQuery((query) => query.selectFrom("account").selectAll().orderBy("order", "asc"));
  const { data: existingTransactions } = useDbQuery((query) =>
    query
      .selectFrom("transaction_entry")
      .selectAll()
      .where("id", "=", transactionId ?? ""),
  );
  const { data: categoryRows } = useDbQuery((query) =>
    query
      .selectFrom("transaction_entry")
      .select("category")
      .distinct()
      .where("category", "!=", "")
      .orderBy("category", "asc"),
  );
  const categories = categoryRows.map((row) => row.category);

  const existing = mode === "edit" ? existingTransactions[0] : undefined;
  const selectedType = (existing?.type ?? draft?.type ?? "expense") as TransactionType;
  const fallbackAccountId = accounts[0]?.id ?? "";
  const fallbackTransferAccountId =
    accounts.find((account) => account.id !== (draft?.accountId ?? fallbackAccountId))?.id ?? "";

  const form = useAppForm({
    defaultValues: {
      accountId: existing?.accountId ?? draft?.accountId ?? fallbackAccountId,
      amount:
        existing?.type === "adjustment" ? String(existing.amount) : String(Math.abs(Number(existing?.amount ?? 0))),
      category: existing?.category ?? "",
      counterpartyAccountId:
        existing?.counterpartyAccountId ?? draft?.counterpartyAccountId ?? fallbackTransferAccountId,
      counterpartyAmount: String(Math.abs(Number(existing?.counterpartyAmount ?? 0))),
      effectiveAt: formatDateTimeLocal(existing?.effectiveAt ?? Date.now()),
      notes: existing?.notes ?? "",
      title: existing?.title ?? "",
      type: selectedType,
    },
    onSubmit: ({ value }) => {
      if (accounts.length === 0) {
        toast.error("Create an account before adding transactions.");
        return;
      }

      try {
        const effectiveAt = parseDateTimeLocal(value.effectiveAt);
        const baseInput = {
          accountId: value.accountId,
          effectiveAt,
          notes: value.notes,
          title: value.title,
        };

        switch (value.type as TransactionType) {
          case "expense":
            createOrUpdate({
              ...baseInput,
              amount: Number.parseFloat(value.amount),
              category: value.category,
              type: "expense",
            });
            break;
          case "income":
            createOrUpdate({
              ...baseInput,
              amount: Number.parseFloat(value.amount),
              category: value.category,
              type: "income",
            });
            break;
          case "transfer":
            if (accounts.length < 2) {
              throw new Error("Create at least two accounts before recording a transfer.");
            }
            createOrUpdate({
              ...baseInput,
              amount: Number.parseFloat(value.amount),
              counterpartyAccountId: value.counterpartyAccountId,
              counterpartyAmount: Number.parseFloat(value.counterpartyAmount),
              type: "transfer",
            });
            break;
          case "adjustment":
            createOrUpdate({
              ...baseInput,
              amount: Number.parseFloat(value.amount),
              category: value.category,
              type: "adjustment",
            });
            break;
        }

        closeDialog();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Unable to save transaction.");
      }
    },
  });

  function createOrUpdate(input: Parameters<typeof createTransaction>[1] | Parameters<typeof updateTransaction>[2]) {
    if (mode === "edit" && transactionId) {
      updateTransaction(db.db, transactionId, input);
      return;
    }

    createTransaction(db.db, input);
  }

  const currentType = useStore(form.store, (state) => state.values.type as TransactionType);
  const currentAccountId = useStore(form.store, (state) => state.values.accountId);
  const currentCounterpartyId = useStore(form.store, (state) => state.values.counterpartyAccountId);
  const sourceAccount = accounts.find((account) => account.id === currentAccountId);
  const destinationAccount = accounts.find((account) => account.id === currentCounterpartyId);
  const canRenderTransfer = currentType === "transfer" && accounts.length >= 2;

  function openAccountCreator() {
    closeDialog();
    createAccount();
  }

  const typeConfig = TYPE_CONFIG[currentType];

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && closeDialog()}>
      <DialogContent className="sm:max-w-xl">
        <div className="flex items-center gap-2">
          <span className={cn("size-2 shrink-0 rounded-full transition-colors", typeConfig.dotColor)} />
          <DialogTitle>{getDialogTitle(mode, currentType)}</DialogTitle>
        </div>
        <DialogDescription className="sr-only">Create or edit a balance-affecting transaction.</DialogDescription>

        {accounts.length === 0 ? (
          <div className="flex flex-col items-center gap-4 py-4 text-center">
            <p className="text-muted-foreground text-sm">
              Create an account before adding income, expenses, or transfers.
            </p>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={closeDialog}>
                Cancel
              </Button>
              <Button type="button" onClick={openAccountCreator}>
                New account
              </Button>
            </div>
          </div>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              form.handleSubmit();
            }}
          >
            <form.AppField name="type">
              {(field) => (
                <div className="grid grid-cols-4 gap-1 rounded-lg bg-muted/50 p-1">
                  {TRANSACTION_TYPES.map((type) => {
                    const config = TYPE_CONFIG[type];
                    const Icon = config.icon;
                    const isActive = field.state.value === type;
                    return (
                      <button
                        key={type}
                        type="button"
                        onClick={() => field.handleChange(type)}
                        className={cn(
                          "flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 font-medium text-sm transition-all",
                          isActive
                            ? config.activeClass
                            : "text-muted-foreground hover:bg-background/50 hover:text-foreground",
                        )}
                      >
                        <Icon className="size-3.5 shrink-0" />
                        <span className="hidden sm:inline">{config.label}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </form.AppField>

            <div className={canRenderTransfer ? "grid gap-3 sm:grid-cols-2" : "grid gap-3"}>
              <form.AppField name="accountId">
                {(field) => (
                  <field.FieldContainer labelText={currentType === "transfer" ? "Source account" : "Account"}>
                    <field.FormSelect placeholder="Select account">
                      {accounts.map((account) => (
                        <SelectItem key={account.id} value={account.id}>
                          {account.labelText || "Untitled"} ({account.currency})
                        </SelectItem>
                      ))}
                    </field.FormSelect>
                  </field.FieldContainer>
                )}
              </form.AppField>

              {canRenderTransfer && (
                <form.AppField name="counterpartyAccountId">
                  {(field) => (
                    <field.FieldContainer labelText="Destination account">
                      <field.FormSelect placeholder="Select destination">
                        {accounts.map((account) => (
                          <SelectItem key={account.id} value={account.id}>
                            {account.labelText || "Untitled"} ({account.currency})
                          </SelectItem>
                        ))}
                      </field.FormSelect>
                    </field.FieldContainer>
                  )}
                </form.AppField>
              )}
            </div>

            <div className={canRenderTransfer ? "grid gap-3 sm:grid-cols-2" : "grid gap-3 sm:grid-cols-2"}>
              <form.AppField name="amount">
                {(field) => (
                  <field.FieldContainer
                    labelText={
                      currentType === "adjustment"
                        ? `Balance delta${sourceAccount ? ` (${sourceAccount.currency})` : ""}`
                        : `Amount${sourceAccount ? ` (${sourceAccount.currency})` : ""}`
                    }
                  >
                    <field.FormInput
                      type="number"
                      step="0.01"
                      placeholder={currentType === "adjustment" ? "-12.50 or 12.50" : "0.00"}
                      className="font-mono tabular-nums [-moz-appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    />
                  </field.FieldContainer>
                )}
              </form.AppField>

              {canRenderTransfer ? (
                <form.AppField name="counterpartyAmount">
                  {(field) => (
                    <field.FieldContainer
                      labelText={`Received amount${destinationAccount ? ` (${destinationAccount.currency})` : ""}`}
                    >
                      <field.FormInput
                        type="number"
                        step="0.01"
                        placeholder="0.00"
                        className="font-mono tabular-nums [-moz-appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                      />
                    </field.FieldContainer>
                  )}
                </form.AppField>
              ) : (
                <form.AppField name="effectiveAt">
                  {(field) => (
                    <field.FieldContainer labelText="Date and time">
                      <field.FormDateTimeInput />
                    </field.FieldContainer>
                  )}
                </form.AppField>
              )}
            </div>

            {canRenderTransfer && (
              <form.AppField name="effectiveAt">
                {(field) => (
                  <field.FieldContainer labelText="Date and time">
                    <field.FormDateTimeInput />
                  </field.FieldContainer>
                )}
              </form.AppField>
            )}

            {currentType === "transfer" && accounts.length < 2 && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800 text-sm dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
                Transfers require at least two accounts.
              </p>
            )}

            <form.AppField name="title">
              {(field) => (
                <field.FieldContainer labelText="Title">
                  <field.FormInput
                    placeholder={
                      currentType === "expense"
                        ? "Coffee"
                        : currentType === "income"
                          ? "Salary"
                          : currentType === "transfer"
                            ? "Between accounts"
                            : "Manual correction"
                    }
                  />
                </field.FieldContainer>
              )}
            </form.AppField>

            {currentType !== "transfer" && (
              <form.AppField name="category">
                {(field) => (
                  <field.FieldContainer labelText="Category">
                    <field.FormComboboxInput options={categories} placeholder="Optional category" />
                  </field.FieldContainer>
                )}
              </form.AppField>
            )}

            <form.AppField name="notes">
              {(field) => (
                <field.FieldContainer labelText="Notes">
                  <field.FormTextarea placeholder="Optional notes..." className="min-h-20 resize-none" />
                </field.FieldContainer>
              )}
            </form.AppField>

            {currentType === "transfer" &&
              sourceAccount &&
              destinationAccount &&
              sourceAccount.currency !== destinationAccount.currency && (
                <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800 text-sm dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
                  This transfer stores both entered amounts exactly. No exchange-rate conversion is applied.
                </p>
              )}

            <DialogFooter className="justify-between">
              <div>
                {mode === "edit" && transactionId ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => {
                      deleteTransaction(db.db, transactionId);
                      closeDialog();
                    }}
                  >
                    <Trash2Icon />
                    Delete
                  </Button>
                ) : null}
              </div>

              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={closeDialog}>
                  Cancel
                </Button>
                <Button type="submit">{mode === "edit" ? "Save" : "Create"}</Button>
              </div>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function TransactionDialog() {
  const openRevision = useTransactionDialogStore((state) => state.openRevision);
  return <TransactionDialogContent key={openRevision} />;
}
