const encoder = new TextEncoder();
const DAY = 86400;
const nowSeconds = () => Math.floor(Date.now() / 1000);
const statement = (db, sql, ...args) => db.prepare(sql).bind(...args);
const one = (db, sql, ...args) => statement(db, sql, ...args).first();
const run = (db, sql, ...args) => statement(db, sql, ...args).run();
const rows = async (db, sql, ...args) => (await statement(db, sql, ...args).all()).results;

class RetryLater extends Error {}
class NeedsReview extends Error {}

export async function verifySignature(body, signature, secret) {
  if (!secret || !/^sha256=[a-f0-9]{64}$/.test(signature || '')) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const bytes = Uint8Array.from(signature.slice(7).match(/../g), hex => parseInt(hex, 16));
  return crypto.subtle.verify('HMAC', key, bytes, body);
}

function array(value) {
  if (!Array.isArray(value)) throw new Error('invalid_event');
  return value;
}
function id(value) {
  if (typeof value !== 'string' || !value || value.length > 512) throw new Error('invalid_id');
  return value;
}

export function parseEvents(body, accountId, now = nowSeconds()) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid_event');
  if (body.object !== 'instagram') return [];
  const events = [];
  for (const entry of array(body.entry)) {
    if (!entry || typeof entry !== 'object') throw new Error('invalid_entry');
    if (entry.id !== accountId) continue;
    for (const change of array(entry.changes || [])) {
      if (change?.field !== 'comments') continue;
      const value = change.value;
      const commentId = id(value?.id);
      if (value.from?.id === accountId) continue;
      events.push({ id: `comment:${commentId}`, kind: 'comment', commentId,
        senderId: value.from?.id || null, mediaId: value.media?.id || commentId,
        at: now });
    }
    for (const message of array(entry.messaging || [])) {
      if (message?.message?.is_echo || message?.sender?.id === accountId) continue;
      if (message?.recipient?.id !== accountId) continue;
      const text = message.message?.text;
      const payload = message.postback?.payload || message.message?.quick_reply?.payload;
      const done = typeof text === 'string' && text.trim().toUpperCase() === 'DONE';
      if (!done && !(typeof payload === 'string' && /^(GET|CHECK):/.test(payload))) continue;
      const messageId = id(message.message?.mid || message.postback?.mid);
      const senderId = id(message.sender?.id);
      const at = Math.floor(Number(message.timestamp) / 1000);
      if (!Number.isFinite(at) || at > now + 300) throw new Error('invalid_timestamp');
      events.push({ id: `message:${messageId}`, kind: 'message', senderId,
        commentId: payload ? id(payload.slice(payload.indexOf(':') + 1)) : null, at });
    }
  }
  if (events.length > 100) throw new Error('batch_too_large');
  return events;
}

export function buttonMessage(text, buttons) {
  return { attachment: { type: 'template', payload: {
    template_type: 'button', text, buttons,
  } } };
}
const postback = (title, payload) => ({ type: 'postback', title, payload });
const link = (title, url) => ({ type: 'web_url', title, url });

export function openingMessage(commentId) {
  return buttonMessage('Hey! 👋 Thanks for commenting. Tap below to get your resources ❤️',
    [postback('Send me the link 🔗', `GET:${commentId}`)]);
}
export function followMessage(commentId, username) {
  return buttonMessage(`Follow @${username} to get the resources ❤️ Then tap “I’m following” or reply DONE.`, [
    link('Visit profile', `https://www.instagram.com/${encodeURIComponent(username)}/`),
    postback('I’m following ✅', `CHECK:${commentId}`),
  ]);
}
export function resourceMessage(url) {
  return buttonMessage('Thanks for following! ❤️ Here are your resources.', [link('Get resources 🔗', url)]);
}

function configured(env) {
  return env.DB && env.EVENT_QUEUE && env.VERIFY_TOKEN && env.META_APP_SECRET && env.IG_USER_ID
    && (env.DRY_RUN === 'true' || (env.INSTAGRAM_ACCESS_TOKEN
      && env.FOLLOW_CHECK_VERIFIED === 'true' && env.INITIAL_BUTTON_VERIFIED === 'true'));
}

async function verifyDatabaseMode(env) {
  const mode = env.DRY_RUN === 'true' ? 'dry' : 'live';
  await run(env.DB, "INSERT OR IGNORE INTO settings(key, value) VALUES ('mode', ?)", mode);
  const stored = await one(env.DB, "SELECT value FROM settings WHERE key='mode'");
  if (stored.value !== mode) throw new Error('use_separate_staging_and_live_databases');
}

export async function receive(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/healthz') return new Response('QuickDM');
  if (!['/', '/webhook'].includes(url.pathname)) return new Response('Not found', { status: 404 });
  if (request.method === 'GET') {
    const valid = env.VERIFY_TOKEN && url.searchParams.get('hub.mode') === 'subscribe'
      && url.searchParams.get('hub.verify_token') === env.VERIFY_TOKEN;
    const challenge = url.searchParams.get('hub.challenge');
    return valid && challenge ? new Response(challenge) : new Response('Forbidden', { status: 403 });
  }
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!configured(env)) return new Response('Setup incomplete', { status: 503 });
  // Bound the actual streamed body, not just the caller-supplied Content-Length.
  const reader = request.body?.getReader();
  if (!reader) return new Response('Empty request', { status: 400 });
  const chunks = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 128 * 1024) {
      await reader.cancel();
      return new Response('Too large', { status: 413 });
    }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  if (!await verifySignature(body, request.headers.get('X-Hub-Signature-256'), env.META_APP_SECRET)) {
    return new Response('Forbidden', { status: 403 });
  }
  let events;
  try { events = parseEvents(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)), env.IG_USER_ID); }
  catch { return new Response('Invalid event', { status: 400 }); }
  const now = nowSeconds();
  if (events.length) {
    await verifyDatabaseMode(env);
    await env.DB.batch(events.map(event => statement(env.DB,
      'INSERT OR IGNORE INTO events(id, payload, available_at, created_at) VALUES (?, ?, ?, ?)',
      event.id, JSON.stringify(event), now, now)));
    // The durable inbox remains pending if queue delivery fails. Scheduled recovery retries it.
    try { await env.EVENT_QUEUE.sendBatch(events.map(event => ({ body: { id: event.id } }))); }
    catch { console.warn('queue_dispatch_pending'); }
  }
  return new Response('EVENT_RECEIVED');
}

async function graph(env, path, payload) {
  const method = payload ? 'POST' : 'GET';
  const response = await fetch(`https://graph.instagram.com/${env.API_VERSION}/${path}`, {
    method, headers: { Authorization: `Bearer ${env.INSTAGRAM_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(15000), redirect: 'error',
  });
  let data;
  try { data = await response.json(); } catch { data = {}; }
  return { status: response.status, data };
}

async function sendOnce(env, key, path, payload, now) {
  const actionId = `${env.DRY_RUN === 'true' ? 'dry' : 'live'}:${key}`;
  await run(env.DB, 'INSERT OR IGNORE INTO actions(id, updated_at) VALUES (?, ?)', actionId, now);
  const prior = await one(env.DB, 'SELECT * FROM actions WHERE id = ?', actionId);
  if (prior.status === 'sent') return JSON.parse(prior.response);
  if (['unknown', 'failed'].includes(prior.status)) throw new NeedsReview('outbound_needs_review');
  if (prior.status === 'sending') {
    if (prior.updated_at < now - 120) {
      await run(env.DB, "UPDATE actions SET status='unknown', error='interrupted_send' WHERE id=? AND status='sending'", actionId);
      throw new NeedsReview('interrupted_send');
    }
    throw new RetryLater('send_in_progress');
  }
  const claim = await run(env.DB, "UPDATE actions SET status='sending', updated_at=? WHERE id=? AND status='pending'", now, actionId);
  if (claim.meta.changes !== 1) throw new RetryLater('claim_busy');
  let result;
  try {
    result = env.DRY_RUN === 'true'
      ? { status: 200, data: { message_id: `dry-${key}`, recipient_id: 'dry-test-user' } }
      : await graph(env, path, payload);
  } catch {
    await run(env.DB, "UPDATE actions SET status='unknown', error='network_outcome_unknown' WHERE id=?", actionId);
    throw new NeedsReview('network_outcome_unknown');
  }
  if (result.status === 429) {
    await run(env.DB, "UPDATE actions SET status='pending', error='rate_limited' WHERE id=?", actionId);
    throw new RetryLater('rate_limited');
  }
  const success = result.status >= 200 && result.status < 300 && !result.data.error
    && (result.data.message_id || result.data.id);
  if (!success) {
    const state = result.status >= 500 || result.status < 400 ? 'unknown' : 'failed';
    await run(env.DB, 'UPDATE actions SET status=?, error=? WHERE id=?', state, `http_${result.status}`, actionId);
    throw new NeedsReview(`send_${state}`);
  }
  // Store only the identifiers needed for mapping/recovery, never the entire API response.
  const saved = { message_id: result.data.message_id || result.data.id,
    recipient_id: result.data.recipient_id || null };
  await run(env.DB, "UPDATE actions SET status='sent', response=?, updated_at=? WHERE id=?",
    JSON.stringify(saved), now, actionId);
  return saved;
}

async function processComment(event, env, now) {
  if (now - event.at > 7 * DAY) return;
  const imported = await one(env.DB, 'SELECT * FROM imported_comments WHERE comment_id=?', event.commentId);
  if (imported) return; // Legacy incomplete states require review, never automatic replay.
  await run(env.DB, `INSERT OR IGNORE INTO workflows(comment_id, sender_id, media_id, resource_url, created_at)
    VALUES (?, ?, ?, ?, ?)`, event.commentId, event.senderId, event.mediaId, env.RESOURCE_URL, event.at);
  const result = await sendOnce(env, `opening:${event.commentId}`, `${env.IG_USER_ID}/messages`, {
    recipient: { comment_id: event.commentId }, message: openingMessage(event.commentId),
  }, now);
  if (result.recipient_id && env.DRY_RUN !== 'true') {
    await run(env.DB, 'UPDATE workflows SET sender_id=? WHERE comment_id=?', result.recipient_id, event.commentId);
  }
  await sendOnce(env, `public:${event.commentId}`, `${event.commentId}/replies`,
    { message: 'Check your DMs! 📩❤️' }, now);
}

async function follows(env, senderId) {
  if (env.DRY_RUN === 'true') return env.TEST_FOLLOW_STATUS === 'true' ? true
    : env.TEST_FOLLOW_STATUS === 'false' ? false : null;
  try {
    const result = await graph(env, `${encodeURIComponent(senderId)}?fields=is_user_follow_business`);
    if (result.status === 200 && typeof result.data.is_user_follow_business === 'boolean') {
      return result.data.is_user_follow_business;
    }
    return null;
  } catch { return null; }
}

async function processMessage(event, env, now) {
  if (now - event.at >= DAY) return;
  let workflow;
  if (event.commentId) {
    workflow = await one(env.DB, 'SELECT * FROM workflows WHERE comment_id=?', event.commentId);
    if (!workflow || workflow.sender_id !== event.senderId) {
      const opening = await one(env.DB, 'SELECT status FROM events WHERE id=?', `comment:${event.commentId}`);
      if (opening && ['pending', 'processing'].includes(opening.status)) {
        throw new RetryLater('opening_still_processing');
      }
      return;
    }
  } else {
    const pending = await rows(env.DB, "SELECT * FROM workflows WHERE sender_id=? AND status='awaiting' ORDER BY created_at DESC LIMIT 2", event.senderId);
    if (pending.length === 1) workflow = pending[0];
    else if (pending.length > 1) {
      await sendOnce(env, `choose:${event.id}`, `${env.IG_USER_ID}/messages`, {
        recipient: { id: event.senderId }, message: { text: 'Please tap the button in the original resource message so I can send you the right link.' },
      }, now);
      return;
    }
  }
  if (!workflow || workflow.status === 'delivered') return;
  const status = await follows(env, event.senderId);
  if (status === null) {
    await sendOnce(env, `follow-unavailable:${event.senderId}:${workflow.media_id}:${Math.floor(now / 3600)}`,
      `${env.IG_USER_ID}/messages`, { recipient: { id: event.senderId }, message: {
        text: 'I couldn’t check your follow status just now. Please try the “I’m following” button again in a few minutes.',
      } }, now);
    throw new RetryLater('follow_status_unknown');
  }
  if (!status) {
    // One reminder per sender/campaign per five minutes, even with repeated taps.
    await sendOnce(env, `reminder:${event.senderId}:${workflow.media_id}:${Math.floor(now / 300)}`,
      `${env.IG_USER_ID}/messages`, { recipient: { id: event.senderId },
        message: followMessage(workflow.comment_id, env.PROFILE_USERNAME) }, now);
    return;
  }
  const resourceKey = `${event.senderId}:${workflow.media_id}:${workflow.resource_url}`;
  await sendOnce(env, `resource:${resourceKey}`, `${env.IG_USER_ID}/messages`, {
    recipient: { id: event.senderId }, message: resourceMessage(workflow.resource_url),
  }, now);
  await run(env.DB, "UPDATE workflows SET status='delivered' WHERE sender_id=? AND media_id=? AND resource_url=?",
    event.senderId, workflow.media_id, workflow.resource_url);
}

export async function processEvent(eventId, env, now = nowSeconds()) {
  if (!configured(env)) throw new Error('setup_incomplete');
  await verifyDatabaseMode(env);
  const claim = await run(env.DB, `UPDATE events SET status='processing', lease_until=?, attempts=attempts+1
    WHERE id=? AND available_at<=? AND (status='pending' OR (status='processing' AND lease_until<?))`,
    now + 120, eventId, now, now);
  if (claim.meta.changes !== 1) return;
  const record = await one(env.DB, 'SELECT * FROM events WHERE id=?', eventId);
  try {
    const event = JSON.parse(record.payload);
    if (event.kind === 'comment') await processComment(event, env, now);
    else await processMessage(event, env, now);
    await run(env.DB, "UPDATE events SET status='done', error=NULL WHERE id=?", eventId);
  } catch (error) {
    const review = error instanceof NeedsReview || record.attempts >= 8;
    const delay = Math.min(3600, 60 * 2 ** Math.min(record.attempts, 6));
    await run(env.DB, 'UPDATE events SET status=?, available_at=?, error=? WHERE id=?',
      review ? 'review' : 'pending', now + delay,
      error instanceof RetryLater || error instanceof NeedsReview ? error.message : 'processing_failure', eventId);
  }
}

export async function recover(env, now = nowSeconds()) {
  if (!configured(env)) return;
  const pending = await rows(env.DB, `SELECT id FROM events WHERE
    (status='pending' AND available_at<=?) OR (status='processing' AND lease_until<?)
    ORDER BY available_at LIMIT 10`, now, now);
  if (pending.length) await env.EVENT_QUEUE.sendBatch(pending.map(row => ({ body: { id: row.id } })));
}

export default {
  async fetch(request, env) {
    try { return await receive(request, env); }
    catch { console.error('webhook_storage_failure'); return new Response('Retry later', { status: 503 }); }
  },
  async queue(batch, env) {
    for (const message of batch.messages) {
      try { await processEvent(message.body.id, env); message.ack(); }
      catch { message.retry({ delaySeconds: 60 }); }
    }
  },
  async scheduled(controller, env, ctx) { ctx.waitUntil(recover(env)); },
};
