import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport: process.env.LOG_JSON
    ? undefined
    : {
        target: "pino-pretty",
      },
});
