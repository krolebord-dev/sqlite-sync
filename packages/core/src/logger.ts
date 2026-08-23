export type LogLevel = "info" | "warning" | "error" | "trace" | "system";

export type Logger = (type: string, message: string, level?: LogLevel) => void;

export type PerformanceLogger = {
  restart: () => void;
  logEnd: (type: string, message: string, level?: LogLevel) => void;
};

const noopPerformanceLogger: PerformanceLogger = {
  restart() {},
  logEnd() {},
};

export const startPerformanceLogger = (logger: Logger | undefined, level: LogLevel = "info"): PerformanceLogger => {
  if (!logger || level === "system") {
    return noopPerformanceLogger;
  }

  let startTime = performance.now();

  return {
    restart: () => {
      startTime = performance.now();
    },
    logEnd: (type: string, message: string, logLevel: LogLevel = level) => {
      const elapsed = performance.now() - startTime;

      logger(type, `${elapsed.toFixed(2)}ms - ${message}`, logLevel);
    },
  };
};
