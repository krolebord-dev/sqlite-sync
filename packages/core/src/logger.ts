export type LogLevel = "info" | "warning" | "error" | "trace" | "system";

export type Logger = (type: string, message: string, level?: LogLevel) => void;

export const startPerformanceLogger = (logger: Logger) => {
  let startTime = performance.now();

  return {
    restart: () => {
      startTime = performance.now();
    },
    logEnd: (type: string, message: string, level: LogLevel = "info") => {
      const elapsed = performance.now() - startTime;

      logger(type, `${elapsed.toFixed(2)}ms - ${message}`, level);
    },
  };
};
