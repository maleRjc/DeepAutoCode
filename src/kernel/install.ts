import { AgentClientBridge, RuntimeFactory } from '@deepautocode/agent';
import { DshRuntime, type DshRuntimeOptions } from './dsh-runtime.js';

interface RuntimeFactoryLike {
  create(params: {
    storageDir: string;
    preferredMode?: string;
    [key: string]: unknown;
  }): Promise<unknown>;
}

interface BridgeFactoryLike {
  create(params: unknown): Promise<unknown>;
}

/**
 * Swap the DeepAutoCode "Cline kernel" for the DeepSeek Harness kernel.
 *
 * The Workbench server only creates its runtime through `RuntimeFactory.create`,
 * so replacing that one seam keeps every DAC feature (sessions, approvals, diffs,
 * REST endpoints, React UI) intact while turns and tools run on `dsh`.
 *
 * `AgentClientBridge.create` is wrapped so the kernel can reach the live
 * ApprovalBridge for human-in-the-loop confirmations.
 */
export function installDshKernel(): void {
  const factory = RuntimeFactory as unknown as RuntimeFactoryLike;
  factory.create = async (params) =>
    new DshRuntime({
      storageDir: params.storageDir,
      // The kernel needs the endpoint/model of a non-DeepSeek provider to
      // declare a pi-ai gateway route for it.
      providerManager: params.providerManager as DshRuntimeOptions['providerManager'],
    });

  const bridge = AgentClientBridge as unknown as BridgeFactoryLike;
  const originalCreate = bridge.create;
  bridge.create = async (params: unknown) => {
    const instance = await originalCreate.call(AgentClientBridge, params);
    (globalThis as { __dacAgentBridge?: unknown }).__dacAgentBridge = instance;
    return instance;
  };
}
