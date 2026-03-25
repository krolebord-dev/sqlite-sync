import { generateId, type SQLiteDbWrapper, type SQLiteTransactionWrapper } from "@sqlite-sync/core";
import type { Selectable } from "kysely";
import type { UserDb } from "@/user-db/migrations";

export const TRANSACTION_TYPES = ["expense", "income", "transfer", "adjustment"] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export type TransactionRow = Selectable<UserDb["transaction_entry"]>;
export type AccountRow = Selectable<UserDb["account"]>;
type TransactionDatabase = Pick<SQLiteDbWrapper<UserDb>, "executeTransaction">;

type TransactionBaseInput = {
  accountId: string;
  category?: string;
  effectiveAt: number;
  notes?: string;
  title?: string;
};

export type ExpenseTransactionInput = TransactionBaseInput & {
  amount: number;
  type: "expense";
};

export type IncomeTransactionInput = TransactionBaseInput & {
  amount: number;
  type: "income";
};

export type AdjustmentTransactionInput = TransactionBaseInput & {
  amount: number;
  type: "adjustment";
};

export type TransferTransactionInput = Omit<TransactionBaseInput, "category"> & {
  amount: number;
  counterpartyAccountId: string;
  counterpartyAmount: number;
  type: "transfer";
};

export type TransactionInput =
  | AdjustmentTransactionInput
  | ExpenseTransactionInput
  | IncomeTransactionInput
  | TransferTransactionInput;

type MaterializedTransaction = Omit<TransactionRow, "id" | "createdAt" | "updatedAt" | "tombstone">;

function requireFiniteAmount(amount: number, fieldName: string) {
  if (!Number.isFinite(amount)) {
    throw new Error(`${fieldName} must be a valid number.`);
  }
}

function requirePositiveAmount(amount: number, fieldName: string) {
  requireFiniteAmount(amount, fieldName);
  if (amount <= 0) {
    throw new Error(`${fieldName} must be greater than 0.`);
  }
}

function trimText(value: string | undefined) {
  return value?.trim() ?? "";
}

function getAccountById(trx: SQLiteTransactionWrapper<UserDb>, accountId: string) {
  const [account] = trx.executeKysely((q) => q.selectFrom("account").selectAll().where("id", "=", accountId)).rows;

  if (!account) {
    throw new Error("Account not found.");
  }

  return account;
}

function updateAccountBalance(trx: SQLiteTransactionWrapper<UserDb>, accountId: string, nextBalance: number) {
  trx.executeKysely((q) => q.updateTable("account").set({ balance: nextBalance }).where("id", "=", accountId));
}

function applyAccountDelta(trx: SQLiteTransactionWrapper<UserDb>, accountId: string, delta: number) {
  if (delta === 0) {
    return;
  }

  const account = getAccountById(trx, accountId);
  updateAccountBalance(trx, accountId, Number(account.balance) + delta);
}

function materializeTransaction(
  trx: SQLiteTransactionWrapper<UserDb>,
  input: TransactionInput,
): MaterializedTransaction {
  const account = getAccountById(trx, input.accountId);
  const title = trimText(input.title);
  const notes = trimText(input.notes);
  const effectiveAt = input.effectiveAt;

  if (!Number.isFinite(effectiveAt)) {
    throw new Error("Transaction time is required.");
  }

  switch (input.type) {
    case "expense":
      requirePositiveAmount(input.amount, "Amount");
      return {
        type: input.type,
        accountId: account.id,
        accountCurrency: account.currency,
        amount: -Math.abs(input.amount),
        counterpartyAccountId: "",
        counterpartyCurrency: "",
        counterpartyAmount: null,
        title,
        category: trimText(input.category),
        notes,
        effectiveAt,
      };
    case "income":
      requirePositiveAmount(input.amount, "Amount");
      return {
        type: input.type,
        accountId: account.id,
        accountCurrency: account.currency,
        amount: Math.abs(input.amount),
        counterpartyAccountId: "",
        counterpartyCurrency: "",
        counterpartyAmount: null,
        title,
        category: trimText(input.category),
        notes,
        effectiveAt,
      };
    case "adjustment":
      requireFiniteAmount(input.amount, "Amount");
      if (input.amount === 0) {
        throw new Error("Adjustment amount cannot be 0.");
      }
      return {
        type: input.type,
        accountId: account.id,
        accountCurrency: account.currency,
        amount: input.amount,
        counterpartyAccountId: "",
        counterpartyCurrency: "",
        counterpartyAmount: null,
        title: title || "Balance adjustment",
        category: trimText(input.category),
        notes,
        effectiveAt,
      };
    case "transfer": {
      requirePositiveAmount(input.amount, "Source amount");
      requirePositiveAmount(input.counterpartyAmount, "Destination amount");
      if (input.accountId === input.counterpartyAccountId) {
        throw new Error("Transfer accounts must be different.");
      }
      const counterpartyAccount = getAccountById(trx, input.counterpartyAccountId);
      return {
        type: input.type,
        accountId: account.id,
        accountCurrency: account.currency,
        amount: -Math.abs(input.amount),
        counterpartyAccountId: counterpartyAccount.id,
        counterpartyCurrency: counterpartyAccount.currency,
        counterpartyAmount: Math.abs(input.counterpartyAmount),
        title: title || "Transfer",
        category: "",
        notes,
        effectiveAt,
      };
    }
  }
}

function applyTransactionBalanceEffect(trx: SQLiteTransactionWrapper<UserDb>, transaction: MaterializedTransaction | TransactionRow) {
  applyAccountDelta(trx, transaction.accountId, Number(transaction.amount));

  if (transaction.counterpartyAccountId && transaction.counterpartyAmount !== null) {
    applyAccountDelta(trx, transaction.counterpartyAccountId, Number(transaction.counterpartyAmount));
  }
}

function reverseTransactionBalanceEffect(trx: SQLiteTransactionWrapper<UserDb>, transaction: TransactionRow) {
  applyAccountDelta(trx, transaction.accountId, -Number(transaction.amount));

  if (transaction.counterpartyAccountId && transaction.counterpartyAmount !== null) {
    applyAccountDelta(trx, transaction.counterpartyAccountId, -Number(transaction.counterpartyAmount));
  }
}

export function createTransactionInTransaction(trx: SQLiteTransactionWrapper<UserDb>, input: TransactionInput) {
  const createdAt = Date.now();
  const transaction = materializeTransaction(trx, input);
  const id = generateId();

  trx.executeKysely((q) =>
    q.insertInto("transaction_entry").values({
      id,
      ...transaction,
      createdAt,
      updatedAt: createdAt,
      tombstone: false,
    }),
  );

  applyTransactionBalanceEffect(trx, transaction);
  return id;
}

export function createTransaction(db: TransactionDatabase, input: TransactionInput) {
  return db.executeTransaction((trx) => createTransactionInTransaction(trx, input));
}

export function updateTransaction(db: TransactionDatabase, transactionId: string, input: TransactionInput) {
  db.executeTransaction((trx) => {
    const [existing] = trx.executeKysely((q) =>
      q.selectFrom("transaction_entry").selectAll().where("id", "=", transactionId),
    ).rows;

    if (!existing) {
      throw new Error("Transaction not found.");
    }

    reverseTransactionBalanceEffect(trx, existing);
    const nextTransaction = materializeTransaction(trx, input);

    trx.executeKysely((q) =>
      q
        .updateTable("transaction_entry")
        .set({
          ...nextTransaction,
          updatedAt: Date.now(),
        })
        .where("id", "=", transactionId),
    );

    applyTransactionBalanceEffect(trx, nextTransaction);
  });
}

export function deleteTransaction(db: TransactionDatabase, transactionId: string) {
  db.executeTransaction((trx) => {
    const [existing] = trx.executeKysely((q) =>
      q.selectFrom("transaction_entry").selectAll().where("id", "=", transactionId),
    ).rows;

    if (!existing) {
      return;
    }

    reverseTransactionBalanceEffect(trx, existing);
    trx.executeKysely((q) => q.deleteFrom("transaction_entry").where("id", "=", transactionId));
  });
}

export function createBalanceAdjustment(db: TransactionDatabase, opts: { accountId: string; amount: number; title?: string }) {
  return createTransaction(db, {
    type: "adjustment",
    accountId: opts.accountId,
    amount: opts.amount,
    effectiveAt: Date.now(),
    title: opts.title,
  });
}

export function transactionTouchesAccount(transaction: TransactionRow, accountId: string) {
  return transaction.accountId === accountId || transaction.counterpartyAccountId === accountId;
}

export function getDisplayAmountForAccount(transaction: TransactionRow, accountId?: string | null) {
  if (accountId && transaction.counterpartyAccountId === accountId) {
    return {
      amount: Number(transaction.counterpartyAmount ?? 0),
      currency: transaction.counterpartyCurrency,
      counterpartyRole: "destination" as const,
    };
  }

  return {
    amount: Number(transaction.amount),
    currency: transaction.accountCurrency,
    counterpartyRole: "source" as const,
  };
}
