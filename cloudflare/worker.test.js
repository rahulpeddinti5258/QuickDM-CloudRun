import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker, { receive, processEvent, recover, parseEvents } from './worker.js';

class TestDB {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
  }
  prepare(sql) {
    const db = this.db;
    return { bind(...args) { return {
      async first() { return db.prepare(sql).get(...args) || null; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async run() { return { meta: { changes: db.prepare(sql).run(...args).changes } }; },
    }; } };
  }
  async batch(statements) {
    this.db.exec('BEGIN');
    try { const results = []; for (const stmt of statements) results.push(await stmt.run()); this.db.exec('COMMIT'); return results; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
const NOW = Math.floor(Date.now() / 1000);
function setup(t) {
  const env = { DB: new TestDB(), EVENT_QUEUE: { async sendBatch() {} }, VERIFY_TOKEN: 'verify',
    META_APP_SECRET: 'test-secret', IG_USER_ID: 'business', API_VERSION: 'v26.0',
    PROFILE_USERNAME: 'uglyphase_', RESOURCE_URL: 'https://linktr.ee/uglyphase',
    DRY_RUN: 'false', INSTAGRAM_ACCESS_TOKEN: 'test-placeholder',
    FOLLOW_CHECK_VERIFIED: 'true', INITIAL_BUTTON_VERIFIED: 'true' };
  const sends = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (options.method === 'GET') return Response.json({ is_user_follow_business: true });
    sends.push({ url, payload: JSON.parse(options.body) });
    return Response.json({ message_id: `message-${sends.length}`, recipient_id: 'person' });
  });
  t.after(() => env.DB.db.close());
  return { env, sends };
}
function comment(cid = 'c1', media = 'reel1') {
  return { object: 'instagram', entry: [{ id: 'business', changes: [{ field: 'comments',
    value: { id: cid, from: { id: 'person' }, media: { id: media } } }] }] };
}
function message(mid = 'm1', cid = 'c1', at = NOW) {
  return { object: 'instagram', entry: [{ id: 'business', messaging: [{
    sender: { id: 'person' }, recipient: { id: 'business' }, timestamp: at * 1000,
    postback: { mid, payload: `CHECK:${cid}` },
  }] }] };
}
async function request(event, signed = true) {
  const body = JSON.stringify(event);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('test-secret'),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const hex = Buffer.from(digest).toString('hex');
  return new Request('https://quickdm.test/webhook', { method: 'POST', body,
    headers: signed ? { 'X-Hub-Signature-256': `sha256=${hex}` } : {} });
}
async function deliver(event, env) { return receive(await request(event), env); }
async function start(env) { await deliver(comment(), env); await processEvent('comment:c1', env, NOW + 1); }

test('challenge and unsigned rejection', async t => {
  const { env, sends } = setup(t);
  const reply = await receive(new Request('https://q.test/?hub.mode=subscribe&hub.verify_token=verify&hub.challenge=123'), env);
  assert.equal(await reply.text(), '123');
  assert.equal((await receive(await request(comment(), false), env)).status, 403);
  assert.equal(sends.length, 0);
});
test('durable acceptance precedes sends and survives queue failure', async t => {
  const { env, sends } = setup(t);
  env.EVENT_QUEUE.sendBatch = async () => { throw new Error('unavailable'); };
  assert.equal((await deliver(comment(), env)).status, 200);
  assert.equal(sends.length, 0);
  assert.equal(env.DB.db.prepare('SELECT count(*) AS n FROM events').get().n, 1);
  let queued;
  env.EVENT_QUEUE.sendBatch = async batch => { queued = batch; };
  await recover(env, NOW + 1);
  assert.equal(queued[0].body.id, 'comment:c1');
});
test('duplicate comments send one opening and one public reply', async t => {
  const { env, sends } = setup(t);
  await start(env);
  await deliver(comment(), env);
  await processEvent('comment:c1', env, NOW + 2);
  assert.equal(sends.length, 2);
  assert.equal(sends[0].payload.recipient.comment_id, 'c1');
  assert.equal(sends[0].payload.message.attachment.payload.buttons[0].payload, 'GET:c1');
  assert.equal(sends[1].payload.message, 'Check your DMs! 📩❤️');
  assert.ok(!JSON.stringify(sends[0]).includes('linktr.ee'));
});
test('simultaneous worker attempts claim once', async t => {
  const { env, sends } = setup(t);
  await deliver(comment(), env);
  await Promise.all([processEvent('comment:c1', env, NOW + 1), processEvent('comment:c1', env, NOW + 1)]);
  assert.equal(sends.length, 2);
});
test('confirmed follower receives resource once across repeated button clicks', async t => {
  const { env, sends } = setup(t);
  await start(env);
  for (const mid of ['m1', 'm1', 'm2']) {
    await deliver(message(mid), env);
    await processEvent(`message:${mid}`, env, NOW + 2);
  }
  assert.equal(sends.length, 3);
  assert.equal(sends[2].payload.recipient.id, 'person');
  assert.equal(sends[2].payload.message.attachment.payload.buttons[0].url, env.RESOURCE_URL);
});
test('nonfollower receives profile and check buttons, then can qualify', async t => {
  const { env, sends } = setup(t);
  await start(env);
  const original = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, options) => options.method === 'GET'
    ? Response.json({ is_user_follow_business: false }) : original(url, options));
  await deliver(message(), env);
  await processEvent('message:m1', env, NOW + 2);
  assert.equal(sends[2].payload.message.attachment.payload.buttons.length, 2);
  assert.equal(env.DB.db.prepare('SELECT status FROM workflows').get().status, 'awaiting');
  t.mock.method(globalThis, 'fetch', original);
  await deliver(message('m2'), env);
  await processEvent('message:m2', env, NOW + 3);
  assert.equal(env.DB.db.prepare('SELECT status FROM workflows').get().status, 'delivered');
});
test('unknown follow status stays pending and never claims nonfollowing', async t => {
  const { env, sends } = setup(t);
  await start(env);
  const original = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, options) => options.method === 'GET'
    ? Response.json({ error: {} }, { status: 403 }) : original(url, options));
  await deliver(message(), env);
  await processEvent('message:m1', env, NOW + 2);
  assert.equal(sends.length, 3);
  assert.match(sends[2].payload.message.text, /couldn’t check/);
  const event = env.DB.db.prepare("SELECT * FROM events WHERE id='message:m1'").get();
  assert.equal(event.status, 'pending');
  assert.equal(event.error, 'follow_status_unknown');
});
test('ambiguous opening timeout stops replay and public reply', async t => {
  const { env } = setup(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('timeout'); });
  await start(env);
  await processEvent('comment:c1', env, NOW + 300);
  assert.equal(calls, 1);
  assert.equal(env.DB.db.prepare('SELECT status FROM actions').get().status, 'unknown');
  assert.equal(env.DB.db.prepare('SELECT status FROM events').get().status, 'review');
});
test('public rate limit retries public without repeating initial DM', async t => {
  const { env, sends } = setup(t);
  const original = globalThis.fetch;
  let first = true;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/replies') && first) { first = false; return Response.json({}, { status: 429 }); }
    return original(url, options);
  });
  await start(env);
  await processEvent('comment:c1', env, NOW + 400);
  assert.equal(sends.length, 2);
  assert.equal(sends.filter(call => call.payload.recipient?.comment_id).length, 1);
});
test('expired message receives no resource', async t => {
  const { env, sends } = setup(t);
  await start(env);
  await deliver(message('old', 'c1', NOW - 86401), env);
  await processEvent('message:old', env, NOW + 2);
  assert.equal(sends.length, 2);
});
test('another sender cannot unlock someone else’s workflow', async t => {
  const { env, sends } = setup(t);
  await start(env);
  const event = message(); event.entry[0].messaging[0].sender.id = 'stranger';
  await deliver(event, env); await processEvent('message:m1', env, NOW + 2);
  assert.equal(sends.length, 2);
});
test('new reel allows new resource delivery', async t => {
  const { env, sends } = setup(t);
  for (const [cid, media, mid] of [['c1', 'reel1', 'm1'], ['c2', 'reel2', 'm2']]) {
    await deliver(comment(cid, media), env); await processEvent(`comment:${cid}`, env, NOW + 1);
    await deliver(message(mid, cid), env); await processEvent(`message:${mid}`, env, NOW + 2);
  }
  assert.equal(sends.length, 6);
});
test('legacy processed comments are never resent', async t => {
  const { env, sends } = setup(t);
  env.DB.db.exec("INSERT INTO imported_comments VALUES ('c1', 1, 1)");
  await start(env); assert.equal(sends.length, 0);
});
test('malformed signed payload rejected and storage failure returns retry status', async t => {
  const { env } = setup(t);
  assert.equal((await deliver([], env)).status, 400);
  env.DB.batch = async () => { throw new Error('db down'); };
  assert.equal((await worker.fetch(await request(comment()), env)).status, 503);
});
test('DONE text maps to single pending workflow', async t => {
  const { env, sends } = setup(t); await start(env);
  const event = message(); const item = event.entry[0].messaging[0];
  delete item.postback; item.message = { mid: 'done1', text: ' done ' };
  await deliver(event, env); await processEvent('message:done1', env, NOW + 1);
  assert.equal(sends.length, 3);
});
test('echoes and wrong account ignored', () => {
  const event = message(); event.entry[0].messaging[0].message = { is_echo: true };
  assert.deepEqual(parseEvents(event, 'business'), []);
  assert.deepEqual(parseEvents(comment(), 'different'), []);
});

test('early button waits for its pending comment and later delivers', async t => {
  const { env, sends } = setup(t);
  await deliver(comment(), env);
  await deliver(message(), env);
  await processEvent('message:m1', env, NOW + 1);
  assert.equal(sends.length, 0);
  assert.equal(env.DB.db.prepare("SELECT status FROM events WHERE id='message:m1'").get().status, 'pending');
  await processEvent('comment:c1', env, NOW + 2);
  await processEvent('message:m1', env, NOW + 400);
  assert.equal(sends.length, 3);
});
test('staging database refuses live mode without sending', async t => {
  const { env, sends } = setup(t);
  env.DRY_RUN = 'true';
  await start(env);
  env.DRY_RUN = 'false';
  await assert.rejects(processEvent('comment:c1', env, NOW + 400), /separate_staging/);
  assert.equal(sends.length, 0);
});
test('interrupted send is quarantined on expired lease recovery', async t => {
  const { env, sends } = setup(t);
  await deliver(comment(), env);
  env.DB.db.prepare("UPDATE events SET status='processing', lease_until=?").run(NOW - 1);
  env.DB.db.prepare("INSERT INTO actions(id, status, updated_at) VALUES ('live:opening:c1', 'sending', ?)").run(NOW - 300);
  await processEvent('comment:c1', env, NOW + 1);
  assert.equal(sends.length, 0);
  assert.equal(env.DB.db.prepare('SELECT status FROM actions').get().status, 'unknown');
  assert.equal(env.DB.db.prepare('SELECT status FROM events').get().status, 'review');
});
test('multiple pending DONE does not choose a resource arbitrarily', async t => {
  const { env, sends } = setup(t);
  await start(env);
  await deliver(comment('c2', 'reel2'), env);
  await processEvent('comment:c2', env, NOW + 1);
  const event = message(); const item = event.entry[0].messaging[0];
  delete item.postback; item.message = { mid: 'done-many', text: 'DONE' };
  await deliver(event, env);
  await processEvent('message:done-many', env, NOW + 2);
  assert.match(sends[4].payload.message.text, /original resource message/);
  assert.equal(env.DB.db.prepare("SELECT count(*) AS n FROM workflows WHERE status='delivered'").get().n, 0);
});
test('different comments on the same reel deliver resource once', async t => {
  const { env, sends } = setup(t);
  for (const cid of ['c1', 'c2']) {
    await deliver(comment(cid), env); await processEvent(`comment:${cid}`, env, NOW + 1);
    await deliver(message(cid, cid), env); await processEvent(`message:${cid}`, env, NOW + 2);
  }
  assert.equal(sends.filter(call => call.payload.message?.attachment?.payload?.buttons?.[0]?.url === env.RESOURCE_URL).length, 1);
});
