type RetryOptions = {
  maxAttempts: number;
  backoffBaseMs: number;
  backoffExponent: number;
  backoffJitterMs: number;
  timeoutMs: number;
};

export const REMOTE_RETRY_OPTIONS: RetryOptions = {
  maxAttempts: 3,
  backoffBaseMs: 100,
  backoffExponent: 1.5,
  backoffJitterMs: 150,
  timeoutMs: 10000,
};

class RetryTimeoutError extends Error {
  constructor(
    message: string,
    public previous?: unknown,
  ) {
    super(message);
    this.name = "TimeoutError";
  }
}

const applyJitter = (delayMs: number, maxJitterMs: number): number => {
  const jitter = Math.random() * maxJitterMs * (Math.random() > 0.5 ? 1 : -1);
  return Math.max(0, delayMs + jitter);
};

const delay = (delayMs: number) => new Promise((resolve) => setTimeout(resolve, delayMs));

const withTimeout = async <T>(operation: () => Promise<T>, timeoutMs: number, previousError?: unknown): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new RetryTimeoutError("Remote operation timed out", previousError)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
};

export const retryRemoteOperation = async <T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> => {
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      return await withTimeout(operation, options.timeoutMs, lastError);
    } catch (error) {
      lastError = error;

      if (attempt >= options.maxAttempts) {
        throw error;
      }

      const backoffDelay = applyJitter(
        options.backoffBaseMs * options.backoffExponent ** (attempt - 1),
        options.backoffJitterMs,
      );
      if (backoffDelay > 0) {
        await delay(backoffDelay);
      }
    }
  }

  throw lastError;
};
