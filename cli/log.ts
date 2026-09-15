import { createLogger } from "../src/logger";

export const logger = createLogger();
export const log = logger.child({ module: "cli" });
