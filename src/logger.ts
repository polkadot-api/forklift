import pino from "pino";

export const createLogger = () =>
  pino({
    level: globalThis.process?.env?.LOG_LEVEL ?? "info",
    transport: globalThis.process?.env?.LOG_JSON
      ? undefined
      : {
          target: "pino-pretty",
        },
  });
