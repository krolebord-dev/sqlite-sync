import type { Logger } from "@sqlite-sync/core";

export const logger: Logger = (type, message, level = "info") => {
  const logMessage = `[${type}] ${message}`;

  switch (level) {
    case "info":
      console.log(logMessage);
      break;
    case "warning":
      console.warn(logMessage);
      break;
    case "error":
      console.error(logMessage);
      break;
    case "trace":
      console.trace(logMessage);
      break;
  }
};
