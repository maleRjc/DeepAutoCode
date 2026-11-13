import { installDshKernel } from './kernel/install.js';

// Install the Harness kernel seam before the Workbench server module (and its
// AgentClientBridge) is loaded, so every runtime it creates is DSH-backed.
installDshKernel();

const { createWorkbenchServer } = await import('./workbench-server/server.js');

const port = Number(process.env.PORT ?? 3840);
const server = await createWorkbenchServer({ port });

console.log(`[DeepAutoCode × DeepSeek Harness] Workbench ready at ${server.url}`);
console.log(`[DeepAutoCode × DeepSeek Harness] kernel=dsh home=${process.env.DSH_KERNEL_HOME ?? '(default)'}`);

if (process.env.DAC_PRINT_URL === '1') {
  process.stdout.write(`DSH_WORKBENCH_URL=${server.url}\n`);
}
