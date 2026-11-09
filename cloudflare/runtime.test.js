import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test('Cloudflare runtime receives signed webhook and consumes durable event', async t => {
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'quickdm-test',
    modules: true, scriptPath: new URL('./worker.js', import.meta.url).pathname,
    compatibilityDate: '2026-11-08',
    d1Databases: { DB: 'quickdm-test' },
    queueProducers: { EVENT_QUEUE: 'quickdm-test-events' },
    queueConsumers: { 'quickdm-test-events': { maxBatchSize: 1, maxBatchTimeout: 1 } },
    bindings: { DRY_RUN: 'true', VERIFY_TOKEN: 'test-verify', META_APP_SECRET: 'test-secret',
      IG_USER_ID: 'business', API_VERSION: 'v26.0', PROFILE_USERNAME: 'uglyphase_',
      RESOURCE_URL: 'https://linktr.ee/uglyphase', TEST_FOLLOW_STATUS: 'true' },
  }] }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  const migration = readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8');
  await db.batch(migration.split(';').map(sql => sql.trim()).filter(Boolean).map(sql => db.prepare(sql)));
  const challenge = await mf.dispatchFetch('https://quickdm.test/webhook?hub.mode=subscribe&hub.verify_token=test-verify&hub.challenge=123');
  assert.equal(await challenge.text(), '123');
  const body = JSON.stringify({ object: 'instagram', entry: [{ id: 'business', changes: [{ field: 'comments',
    value: { id: 'runtime-c1', from: { id: 'test-person' }, media: { id: 'reel1' } } }] }] });
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('test-secret'),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))).toString('hex');
  for (let i = 0; i < 2; i++) {
    const response = await mf.dispatchFetch('https://quickdm.test/webhook', {
      method: 'POST', body, headers: { 'X-Hub-Signature-256': `sha256=${signature}` },
    });
    assert.equal(response.status, 200);
  }
  const deadline = Date.now() + 10000;
  let event;
  do {
    event = await db.prepare("SELECT status FROM events WHERE id='comment:runtime-c1'").first();
    if (event?.status === 'done') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.equal(event.status, 'done');
  const count = await db.prepare("SELECT count(*) AS n FROM actions WHERE status='sent'").first();
  assert.equal(count.n, 2);
});
