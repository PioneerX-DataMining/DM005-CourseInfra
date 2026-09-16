const DISPATCH_URL = 'https://api.github.com/repos/PioneerX-DataMining/DM005-CourseInfra/dispatches';
const COURSE_ORG = 'PioneerX-DataMining';
const INFRA_REPO = 'PioneerX-DataMining/DM005-CourseInfra';
const PRODUCTION_REF = 'refs/heads/main';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifyGithubSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const digest = await crypto.subtle.sign('HMAC', key, rawBody);
  return constantTimeEqual(`sha256=${toHex(digest)}`, signatureHeader);
}

export async function onRequestPost(context) {
  const webhookSecret = context.env.GITHUB_WEBHOOK_SECRET;
  const dispatchToken = context.env.GITHUB_DISPATCH_TOKEN;
  if (!webhookSecret || !dispatchToken) {
    return json({ ok: false, error: 'Webhook receiver is not configured' }, 503);
  }

  const request = context.request;
  const rawBody = await request.arrayBuffer();
  const signature = request.headers.get('x-hub-signature-256');
  const verified = await verifyGithubSignature(rawBody, signature, webhookSecret);
  if (!verified) return json({ ok: false, error: 'Invalid signature' }, 401);

  const event = request.headers.get('x-github-event') || '';
  const delivery = request.headers.get('x-github-delivery') || '';
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return json({ ok: false, error: 'Invalid JSON' }, 400);
  }

  if (event === 'ping') return json({ ok: true, pong: true });
  if (event !== 'push') return json({ ok: true, ignored: `event:${event}` });

  const repository = payload.repository?.full_name || '';
  const owner = payload.repository?.owner?.login || payload.organization?.login || '';
  if (owner !== COURSE_ORG || !repository.startsWith(`${COURSE_ORG}/`)) {
    return json({ ok: true, ignored: 'outside-course-organization' });
  }
  if (repository === INFRA_REPO) return json({ ok: true, ignored: 'courseinfra-self-push' });
  if (payload.ref !== PRODUCTION_REF) return json({ ok: true, ignored: `ref:${payload.ref || 'unknown'}` });
  if (!payload.after || /^0+$/.test(payload.after)) return json({ ok: true, ignored: 'deleted-ref' });

  const dispatch = await fetch(DISPATCH_URL, {
    method: 'POST',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${dispatchToken}`,
      'content-type': 'application/json',
      'user-agent': 'DM005-CourseInfra-Webhook',
      'x-github-api-version': '2022-11-28'
    },
    body: JSON.stringify({
      event_type: 'course-source-push',
      client_payload: {
        repository,
        ref: payload.ref,
        after: payload.after,
        delivery
      }
    })
  });

  if (!dispatch.ok) {
    return json({ ok: false, error: 'GitHub dispatch failed', status: dispatch.status }, 502);
  }

  return json({ ok: true, dispatched: true, repository, revision: payload.after.slice(0, 12) }, 202);
}

export function onRequestGet() {
  return json({ ok: true, service: 'DM005 course webhook receiver' });
}
