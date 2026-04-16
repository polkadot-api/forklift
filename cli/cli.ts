import { program } from "commander";
import { createWsServer } from "../server/node";
import { forklift, logger, wsSource } from "../src";
import { loadConfig } from "./config.ts";
import { log } from "./log.ts";
import { runFromConfig } from "./runFromConfig.ts";

program
  .name("forklift")
  .argument("[url]", "WebSocket URL of the node to fork")
  .option("-c --config <file>", "use YAML config file")
  .option("-b, --block <block>", "block number or hash to fork from")
  .option("-p, --port <port>", "port to listen on", "3000")
  .option(
    "-l, --log-level <level>",
    "log level (trace|debug|info|warn|error|fatal)",
    "info"
  )
  .action(
    async (
      url: string | undefined,
      opts: { block?: string; config?: string; port: string; logLevel: string }
    ) => {
      logger.level = opts.logLevel;

      const config = opts.config ? await loadConfig(opts.config) : null;
      if (config) {
        return runFromConfig(config);
      }

      if (!url) {
        program.error("error: either <url> or --config <file> is required");
      }

      const atBlock = opts.block
        ? /^\d+$/.test(opts.block)
          ? parseInt(opts.block, 10)
          : opts.block
        : undefined;

      const port = parseInt(opts.port, 10);

      const f = forklift(wsSource(url, { atBlock }));
      const server = await createWsServer(f, { port });

      log.info(
        `Forking ${url}${atBlock !== undefined ? ` at block ${atBlock}` : ""}`
      );
      log.info(`Listening on ws://localhost:${server.port}`);
    }
  );

program.parse();
