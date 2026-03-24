import { generateId } from "@sqlite-sync/core";
import { useCallback } from "react";
import { create } from "zustand";
import { combine } from "zustand/middleware";
import { useDb, useDbQuery } from "@/user-db/user-db";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { useAppForm } from "./ui/form";
import { SelectItem } from "./ui/select";

const CURRENCIES = [
  "AUD", "BRL", "CAD", "CHF", "CNY", "CZK", "DKK", "EUR", "GBP", "HKD",
  "HUF", "IDR", "ILS", "INR", "ISK", "JPY", "KRW", "MXN", "MYR", "NOK",
  "NZD", "PHP", "PLN", "RON", "SEK", "SGD", "THB", "TRY", "UAH", "USD", "ZAR",
] as const;

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

  const { data: existingAccounts } = useDbQuery((q) =>
    q.selectFrom("account").selectAll().where("id", "=", accountId ?? ""),
  );
  const existing = mode === "edit" ? existingAccounts[0] : undefined;

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
      const parsedBalance = Number.parseFloat(value.balance) || 0;

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
              initialBalance: parsedBalance,
              balance: parsedBalance,
              description: value.description,
              labelColor: value.labelColor,
              labelText: value.labelText,
              order: maxOrder + 1,
              createdAt,
              tombstone: false,
            }),
          );
        });
      } else if (mode === "edit" && accountId) {
        db.db.executeKysely((q) =>
          q
            .updateTable("account")
            .set({
              labelText: value.labelText,
              labelColor: value.labelColor,
              currency: value.currency,
              balance: parsedBalance,
              description: value.description,
            })
            .where("id", "=", accountId),
        );
      }

      closeDialog();
    },
  });

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && closeDialog()}>
      <DialogContent className="sm:max-w-md">
        <DialogTitle>{mode === "create" ? "New account" : "Edit account"}</DialogTitle>
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
                          field.state.value === color
                            ? `0 0 0 2px var(--background), 0 0 0 4px ${color}`
                            : undefined,
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
                    {CURRENCIES.map((code) => (
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
                    className="[&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none [-moz-appearance:textfield]"
                  />
                </field.FieldContainer>
              )}
            </form.AppField>
          </div>

          <form.AppField name="description">
            {(field) => (
              <field.FieldContainer labelText="Description">
                <field.FormTextarea placeholder="Optional description..." className="min-h-20 resize-none" />
              </field.FieldContainer>
            )}
          </form.AppField>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={closeDialog}>
              Cancel
            </Button>
            <Button type="submit">{mode === "create" ? "Create" : "Save"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function AccountDialog() {
  const openRevision = useAccountDialogStore((x) => x.openRevision);
  return <AccountDialogContent key={openRevision} />;
}
