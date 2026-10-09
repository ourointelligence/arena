#!/usr/bin/env node
import { configFromEnv, startServer } from './server.js';

const cfg = configFromEnv();
const server = startServer(cfg);
const shutdown = () => {
  server.close().finally(() => process.exit(0));
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
