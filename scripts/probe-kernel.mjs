import { HarnessClient } from '@deepseek-ai/dsh-sdk-client'

const dshHome = 'E:\\AutoCode\\DeepAutoCode-New\\.dsh-home'
const client = new HarnessClient({ dshHome, profile: 'sdk', initializeTimeoutMs: 120000 })
try {
  client.start()
  const init = await client.initialize({
    cwd: 'E:\\AutoCode\\DeepAutoCode-New',
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
  })
  console.log('INIT_OK', JSON.stringify(init))
} catch (err) {
  console.error('INIT_FAIL', err?.constructor?.name, err?.message)
  process.exitCode = 1
} finally {
  await client.close().catch(() => {})
}
