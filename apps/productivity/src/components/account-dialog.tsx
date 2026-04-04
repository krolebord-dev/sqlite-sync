import { generateId } from "@sqlite-sync/core";
import { useStore } from "@tanstack/react-form";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { create } from "zustand";
import { combine } from "zustand/middleware";
import { APP_CURRENCIES } from "@/lib/currency/currencies";
import { createTransactionInTransaction } from "@/lib/transactions";
import { useDb, useDbQuery } from "@/user-db/user-db";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";
import { useAppForm } from "./ui/form";
import { SelectItem } from "./ui/select";

const LABEL_COLORS = [
  "#8b5cf6", // violet
  "#3b82f6", // blue
  "#06b6d4", // cyan
  "#10b981", // emerald
  "#f59e0b", // amber
  "#f97316", // orange
  "#ef4444", // red
  "#ec4899", // pink
  "#09090b", // black
];

export const useAccountDialogStore = create(
  combine(
    {
      isOpen: false as boolean,
      mode: null as "create" | "edit" | null,
      accountId: null as string | null,
      openRevision: 0,
    },
    (set, get) => ({
      openCreate: () => set({ isOpen: true, mode: "create", accountId: null, openRevision: get().openRevision + 1 }),
      openEdit: (id: string) =>
        set({ isOpen: true, mode: "edit", accountId: id, openRevision: get().openRevision + 1 }),
      close: () => set({ isOpen: false, mode: null, accountId: null }),
    }),
  ),
);

export function useCreateAccount() {
  const openCreate = useAccountDialogStore((s) => s.openCreate);
  return useCallback(() => openCreate(), [openCreate]);
}

function AccountDialogContent() {
  const { isOpen, mode, accountId } = useAccountDialogStore();
  const closeDialog = useAccountDialogStore((x) => x.close);
  const db = useDb();
  const [pendingBalanceChoice, setPendingBalanceChoice] = useState<null | {
    balance: number;
    description: string;
    labelColor: string;
    labelText: string;
    currency: string;
  }>(null);

  const { data: existingAccounts } = useDbQuery((q) =>
    q
      .selectFrom("account")
      .selectAll()
      .where("id", "=", accountId ?? ""),
  );
  const { data: relatedTransactions } = useDbQuery((q) =>
    q
      .selectFrom("transaction_entry")
      .select(["id"])
      .where((eb) => eb.or([eb("accountId", "=", accountId ?? ""), eb("counterpartyAccountId", "=", accountId ?? "")]))
      .limit(1),
  );
  const existing = mode === "edit" ? existingAccounts[0] : undefined;
  const hasTransactionHistory = relatedTransactions.length > 0;

  function persistAccount(
    value: {
      balance: number;
      currency: string;
      description: string;
      labelColor: string;
      labelText: string;
    },
    balanceChangeMode: "adjustment" | "overwrite" = "overwrite",
  ) {
    if (mode === "create") {
      const id = generateId();
      const createdAt = Date.now();

      db.db.executeTransaction((trx) => {
        const [maxOrderRow] = trx.executeKysely((q) =>
          q.selectFrom("account").select((eb) => eb.fn.max("order").as("maxOrder")),
        ).rows;

        const maxOrder = Number(maxOrderRow?.maxOrder ?? 0);

        trx.executeKysely((q) =>
          q.insertInto("account").values({
            id,
            currency: value.currency,
            initialBalance: value.balance,
            balance: value.balance,
            description: value.description,
            labelColor: value.labelColor,
            labelText: value.labelText,
            order: maxOrder + 1,
            createdAt,
            tombstone: false,
          }),
        );
      });

      closeDialog();
      return;
    }

    if (mode !== "edit" || !accountId || !existing) {
      return;
    }

    db.db.executeTransaction((trx) => {
      if (balanceChangeMode === "adjustment") {
        trx.executeKysely((q) =>
          q
            .updateTable("account")
            .set({
              labelText: value.labelText,
              labelColor: value.labelColor,
              currency: value.currency,
              description: value.description,
            })
            .where("id", "=", accountId),
        );

        const delta = value.balance - Number(existing.balance);
        if (delta !== 0) {
          createTransactionInTransaction(trx, {
            type: "adjustment",
            accountId,
            amount: delta,
            effectiveAt: Date.now(),
            title: "Balance adjustment",
          });
        }
      } else {
        trx.executeKysely((q) =>
          q
            .updateTable("account")
            .set({
              labelText: value.labelText,
              labelColor: value.labelColor,
              currency: value.currency,
              balance: value.balance,
              description: value.description,
            })
            .where("id", "=", accountId),
        );
      }
    });

    closeDialog();
  }

  const form = useAppForm({
    defaultValues: {
      labelText: existing?.labelText ?? "",
      labelColor: existing?.labelColor ?? "#8b5cf6",
      currency: existing?.currency ?? "USD",
      // Stored as string so FormInput handles free-form typing (negatives, decimals)
      balance: String(mode === "edit" ? (existing?.balance ?? 0) : 0),
      description: existing?.description ?? "",
    },
    onSubmit: ({ value }) => {
      try {
        const parsedBalance = Number.parseFloat(value.balance);
        if (!Number.isFinite(parsedBalance)) {
          throw new Error("Balance must be a valid number.");
        }

        const nextValue = {
          balance: parsedBalance,
          currency: value.currency,
          description: value.description,
          labelColor: value.labelColor,
          labelText: value.labelText,
        };

        const balanceChanged = mode === "edit" && existing ? parsedBalance !== Number(existing.balance) : false;

        if (balanceChanged && hasTransactionHistory) {
          setPendingBalanceChoice(nextValue);
          return;
        }

        persistAccount(nextValue);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Unable to save account.");
      }
    },
  });
  const selectedCurrency = useStore(form.store, (state) => state.values.currency);

  return (
    <>
      <Dialog
        open={isOpen}
        onOpenChange={(open) => {
          if (!open) {
            setPendingBalanceChoice(null);
            closeDialog();
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogTitle>{mode === "create" ? "New account" : "Edit account"}</DialogTitle>
          <DialogDescription className="sr-only">Create or edit an account and its current balance.</DialogDescription>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              form.handleSubmit();
            }}
            className="flex flex-col gap-4"
          >
            <form.AppField name="labelText">
              {(field) => (
                <field.FormInput
                  placeholder="Account name"
                  className="rounded-none border-0 border-b bg-transparent! px-0 font-semibold text-base shadow-none focus-visible:border-primary focus-visible:ring-0"
                />
              )}
            </form.AppField>

            <form.AppField name="labelColor">
              {(field) => (
                <div className="flex flex-col gap-1.5">
                  <span className="text-muted-foreground text-xs">Color</span>
                  <div className="flex gap-2">
                    {LABEL_COLORS.map((color) => (
                      <button
                        key={color}
                        type="button"
                        className="size-6 rounded-full transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        style={{
                          backgroundColor: color,
                          boxShadow:
                            field.state.value === color ? `0 0 0 2px var(--background), 0 0 0 4px ${color}` : undefined,
                        }}
                        onClick={() => field.handleChange(color)}
                        aria-label={`Select color ${color}`}
                      />
                    ))}
                  </div>
                </div>
              )}
            </form.AppField>

            <div className="flex gap-3">
              <form.AppField name="currency">
                {(field) => (
                  <field.FieldContainer labelText="Currency" className="flex-1">
                    <field.FormSelect placeholder="Select currency">
                      {APP_CURRENCIES.map((code) => (
                        <SelectItem key={code} value={code}>
                          {code}
                        </SelectItem>
                      ))}
                    </field.FormSelect>
                  </field.FieldContainer>
                )}
              </form.AppField>

              <form.AppField name="balance">
                {(field) => (
                  <field.FieldContainer
                    labelText={mode === "create" ? "Initial balance" : "Balance"}
                    className="flex-1"
                  >
                    <field.FormInput
                      type="number"
                      step="0.01"
                      className="font-mono tabular-nums [-moz-appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    />
                  </field.FieldContainer>
                )}
              </form.AppField>
            </div>

            {mode === "edit" && hasTransactionHistory && existing?.currency !== selectedCurrency && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800 text-sm dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
                Changing the account currency only affects future transactions. Existing transaction amounts keep their
                original currency.
              </p>
            )}

            <form.AppField name="description">
              {(field) => (
                <field.FieldContainer labelText="Description">
                  <field.FormTextarea placeholder="Optional description..." className="min-h-20 resize-none" />
                </field.FieldContainer>
              )}
            </form.AppField>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={closeDialog}>
                Cancel
              </Button>
              <Button type="submit">{mode === "create" ? "Create" : "Save"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={pendingBalanceChoice !== null} onOpenChange={(open) => !open && setPendingBalanceChoice(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle>Balance change detected</DialogTitle>
          <DialogDescription>
            This account already has transaction history. Choose whether to keep an adjustment entry or overwrite the
            current balance directly.
          </DialogDescription>
          <div className="flex flex-col gap-3">
            <Button
              type="button"
              onClick={() => {
                if (!pendingBalanceChoice) return;
                try {
                  persistAccount(pendingBalanceChoice, "adjustment");
                  setPendingBalanceChoice(null);
                } catch (error) {
                  toast.error(error instanceof Error ? error.message : "Unable to save account.");
                }
              }}
            >
              Create adjustment entry
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                if (!pendingBalanceChoice) return;
                try {
                  persistAccount(pendingBalanceChoice, "overwrite");
                  setPendingBalanceChoice(null);
                } catch (error) {
                  toast.error(error instanceof Error ? error.message : "Unable to save account.");
                }
              }}
            >
              Overwrite balance only
            </Button>
            <Button type="button" variant="ghost" onClick={() => setPendingBalanceChoice(null)}>
              Cancel
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function AccountDialog() {
  const openRevision = useAccountDialogStore((x) => x.openRevision);
  return <AccountDialogContent key={openRevision} />;
}
