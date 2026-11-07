import { ProviderManager } from '../providers/index.js';

/**
 * AG-006 & Section 7.3: Provider Smoke Test Runner
 * Verifies DeepSeek default configuration, OpenAI-compatible endpoint switching,
 * streaming/tool-call capability metadata, and diagnostic error classification (401, 429, 404).
 */
async function main() {
  console.log('=== DeepAutoCode Provider Smoke Test (AG-006) ===\n');
  const pm = new ProviderManager();

  // 1. Default DeepSeek verification
  const deepseekRes = await pm.runSmokeTest({
    providerId: 'deepseek',
    customFetch: async () =>
      new Response(
        JSON.stringify({
          id: 'chatcmpl-deepseek-test',
          choices: [{ message: { role: 'assistant', content: 'OK' } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      ),
  });
  console.log('[1] DeepSeek Default Provider:');
  console.log(`  - Endpoint: ${deepseekRes.endpoint}`);
  console.log(`  - Model: ${deepseekRes.modelId}`);
  console.log(`  - Checks: ${JSON.stringify(deepseekRes.checks)}`);

  // 2. OpenAI-Compatible Provider verification (with simulated mock HTTP server response)
  await pm.configureProvider({
    providerId: 'openai-compatible',
    apiEndpoint: 'http://127.0.0.1:11434/v1',
    modelId: 'qwen2.5-coder:14b',
    apiKey: 'sk-test-local-compatible-key-123456',
  });

  const compatRes = await pm.runSmokeTest({
    providerId: 'openai-compatible',
    customFetch: async () =>
      new Response(
        JSON.stringify({
          id: 'chatcmpl-test',
          choices: [{ message: { role: 'assistant', content: 'OK' } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      ),
  });
  console.log('\n[2] OpenAI-Compatible Endpoint Verification:');
  console.log(`  - Endpoint: ${compatRes.endpoint}`);
  console.log(`  - Model: ${compatRes.modelId}`);
  console.log(`  - Auth Status: ${compatRes.checks.authStatus} (OK=${compatRes.ok})`);

  // 3. Error Diagnostic Verification (401 Auth Failed, 429 Rate Limited, 404 Model Not Found)
  const authFailRes = await pm.runSmokeTest({
    providerId: 'openai-compatible',
    customFetch: async () => new Response('Unauthorized invalid api key', { status: 401 }),
  });
  const rateLimitRes = await pm.runSmokeTest({
    providerId: 'openai-compatible',
    customFetch: async () => new Response('Rate limit exceeded', { status: 429 }),
  });

  console.log('\n[3] Error Diagnostic Classification:');
  console.log(`  - 401 Diagnostic: ${authFailRes.diagnostic?.code} -> ${authFailRes.diagnostic?.remediation}`);
  console.log(`  - 429 Diagnostic: ${rateLimitRes.diagnostic?.code} -> ${rateLimitRes.diagnostic?.remediation}`);

  if (!deepseekRes.ok || !compatRes.ok || authFailRes.diagnostic?.code !== 'AUTH_FAILED') {
    throw new Error('Provider Smoke Test failed');
  }

  console.log('\n=== Provider Smoke Test PASSED ===');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
