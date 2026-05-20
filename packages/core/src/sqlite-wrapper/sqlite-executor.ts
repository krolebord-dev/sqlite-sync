export type SqlValue = number | string | boolean | null | undefined;

export type ExecuteQueryParams = SqlValue[];

export type ExecuteParams = {
  sql: string;
  parameters: ExecuteQueryParams;
};

export type ExecuteResult<T> = T[];

export type PreparedStatement<TParams extends ExecuteQueryParams, TResult> = {
  execute: (parameters: TParams) => ExecuteResult<TResult>;
  finalize: () => void;
  isFinalized: boolean;
};

type SQLiteExecutorBase = {
  execute: <TResult>(params: ExecuteParams) => ExecuteResult<TResult>;
  prepare: <TParams extends ExecuteQueryParams, TResult>(sql: string) => PreparedStatement<TParams, TResult>;
};

export type SQLiteExecutor = SQLiteExecutorBase & {
  executeTransaction: <TResult>(callback: (tx: SQLiteExecutorBase) => ExecuteResult<TResult>) => ExecuteResult<TResult>;
};
