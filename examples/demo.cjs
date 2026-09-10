'use strict';
const { WorkerRouter } = require('../index.cjs');

async function main() {
  const router = new WorkerRouter({
    providers: [{ name: 'offline-demo', accountId: 'demo', invoke: async request => ({ ok: true, text: `Handled offline: ${request.prompt}` }) }],
    maxAttempts: 1, maxConcurrency: 1, dailyCap: 2,
  });
  console.log(JSON.stringify(await router.run({ prompt: 'summarize the bounded workflow' }), null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
