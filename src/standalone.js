// Run the hub without Electron (handy for testing or a headless PC):  npm run hub
'use strict';
const { Hub } = require('./hub');

(async () => {
  const hub = new Hub({ port: process.env.PORT ? Number(process.env.PORT) : undefined });
  await hub.load();
  await hub.start();
  console.log(`Driftshare hub running on port ${hub.port}`);
  console.log(`Pairing code: ${hub.pairCode}`);
  for (const u of hub.pairUrls()) console.log(`  Phone link (${u.ifname}): ${u.url}`);
  console.log(`  This PC: ${hub.localUrl()}`);
  process.on('SIGINT', async () => {
    await hub.stop();
    process.exit(0);
  });
})();
