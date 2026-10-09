import { readEnv } from './env.js';
import { runLane } from './lane-runner.js';

const laneId = process.argv[2];
if (!laneId) {
  console.error('usage: arena-runner <core|alts|flow>');
  process.exit(2);
}

const env = readEnv();
const runtime = await runLane({ env, lane: laneId });

const shutdown = (signal: string) => {
  console.log(`[${new Date().toISOString()}] ${laneId}: ${signal}, stopping`);
  runtime
    .stop()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
};
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

await runtime.done;
process.exit(1);
