#!/usr/bin/env bun
import { program } from "commander";
import { logger } from "./src/logger";
import { forklift } from "./src/forklift";
import { createWsServer } from "./src/serve";

program
  .name("forklift")
  .argument("<url>", "WebSocket URL of the node to fork")
  .option("-b, --block <block>", "block number or hash to fork from")
  .option("-p, --port <port>", "port to listen on", "3000")
  .option("-l, --log-level <level>", "log level (trace|debug|info|warn|error|fatal)", "info")
  .action((url: string, opts: { block?: string; port: string; logLevel: string }) => {
    logger.level = opts.logLevel;
    const atBlock = opts.block
      ? /^\d+$/.test(opts.block)
        ? parseInt(opts.block, 10)
        : opts.block
      : undefined;

    const port = parseInt(opts.port, 10);

    const f = forklift({ type: "remote", value: { url, atBlock } });
    const server = createWsServer(f, { port });

    console.log(
      `Forking ${url}${atBlock !== undefined ? ` at block ${atBlock}` : ""}`
    );
    console.log(`Listening on ws://localhost:${server.port}`);
  });

program.parse();
