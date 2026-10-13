import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.DB_PATH = ':memory:';
process.env.DRY_RUN = 'true';
process.env.APP_SECRET = 'secreto-test';
process.env.VERIFY_TOKEN = 'verify-test';
process.env.IG_USER_ID = '999';
process.env.ADMIN_PASSWORD = 'admin';

let app, sentLog, db, runDueJobs;
let base;

before(async () => {
  ({ app } = await import('../src/server.js'));
  ({ sentLog } = await import('../src/meta.js'));
  ({ db } = await import('../src/db.js'));
  ({ runDueJobs } = await import('../src/engine.js'));
  const server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  server.unref();
});

const auth = { Authorization: `Basic ${Buffer.from('x:admin').toString('base64')}` };
async function apiCall(path, method = 'GET', body) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { ...auth, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function webhook(payload, secret = 'secreto-test') {
  const raw = JSON.stringify(payload);
  const sig = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
  const res = await fetch(`${base}/webhook`, { method: 'POST', body: raw, headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig } });
  await new Promise((r) => setTimeout(r, 60)); // procesamiento asíncrono
  return res.status;
}

const igDM = (sender, text, extra = {}) => ({
  object: 'instagram',
  entry: [{ id: '999', time: Date.now(), messaging: [{ sender: { id: sender }, recipient: { id: '999' }, timestamp: Date.now(), message: { mid: crypto.randomUUID(), text, ...extra } }] }],
});

test('verificación del webhook', async () => {
  const ok = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=verify-test&hub.challenge=42`);
  assert.equal(await ok.text(), '42');
  const bad = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=mal&hub.challenge=42`);
  assert.equal(bad.status, 403);
});

test('rechaza firmas inválidas', async () => {
  assert.equal(await webhook(igDM('1', 'hola'), 'otro'), 401);
});

test('panel exige contraseña', async () => {
  const res = await fetch(`${base}/api/status`);
  assert.equal(res.status, 401);
});

test('palabra clave → flujo con botón, pregunta y etiqueta', async () => {
  const info = await apiCall('/flows', 'POST', { name: 'Info', steps: [
    { type: 'question', text: '¿Cuál es tu email?', field: 'email' },
    { type: 'tag', action: 'add', tag: 'lead' },
    { type: 'message', text: 'Gracias, te escribo a {{email}}' },
  ] });
  const main = await apiCall('/flows', 'POST', { name: 'Precio', steps: [
    { type: 'message', text: 'Hola {{first_name}}', buttons: [{ title: 'Quiero info', flowId: info.id }] },
  ] });
  await apiCall('/triggers', 'POST', { type: 'keyword', keywords: ['precio'], match_type: 'contains', flow_id: main.id });

  sentLog.length = 0;
  assert.equal(await webhook(igDM('111', '¿Cuál es el PRECIO?')), 200);
  assert.equal(sentLog.length, 1);
  assert.equal(sentLog[0].path, 'me/messages');
  assert.deepEqual(sentLog[0].body.recipient, { id: '111' });
  assert.equal(sentLog[0].body.message.quick_replies[0].payload, `FLOW:${info.id}`);

  await webhook(igDM('111', 'Quiero info', { quick_reply: { payload: `FLOW:${info.id}` } }));
  assert.equal(sentLog.at(-1).body.message.text, '¿Cuál es tu email?');

  await webhook(igDM('111', 'yo@ejemplo.com'));
  assert.equal(sentLog.at(-1).body.message.text, 'Gracias, te escribo a yo@ejemplo.com');

  const [contact] = (await apiCall('/contacts?q=111'));
  assert.deepEqual(contact.tags, ['lead']);
  assert.equal(contact.fields.email, 'yo@ejemplo.com');
});

test('comentario en Instagram → respuesta pública + DM privado, resto al responder', async () => {
  const flow = await apiCall('/flows', 'POST', { name: 'Guía', steps: [
    { type: 'message', text: '¡Aquí tienes la guía!' },
    { type: 'message', text: 'Segundo mensaje' },
  ] });
  await apiCall('/triggers', 'POST', { type: 'comment', keywords: ['guia'], flow_id: flow.id, public_replies: ['Revisa tu DM'] });

  sentLog.length = 0;
  const comment = (id, from, text) => ({
    object: 'instagram',
    entry: [{ id: '999', time: Date.now(), changes: [{ field: 'comments', value: { id, text, from: { id: from, username: 'ana' }, media: { id: 'm1' } } }] }],
  });
  await webhook(comment('c1', '222', 'Quiero la GUÍA'));
  assert.equal(sentLog.length, 2);
  assert.equal(sentLog[0].path, 'c1/replies');
  assert.deepEqual(sentLog[1].body.recipient, { comment_id: 'c1' });

  // Duplicado (Meta reintenta) y comentario propio: ignorados
  await webhook(comment('c1', '222', 'Quiero la GUÍA'));
  await webhook(comment('c2', '999', 'guia'));
  assert.equal(sentLog.length, 2);

  await webhook(igDM('222', 'gracias!'));
  assert.equal(sentLog.at(-1).body.message.text, 'Segundo mensaje');
  assert.deepEqual(sentLog.at(-1).body.recipient, { id: '222' });
});

test('WhatsApp: botones interactivos y espera programada', async () => {
  const flow = await apiCall('/flows', 'POST', { name: 'WA', steps: [
    { type: 'message', text: 'Elige', buttons: [{ title: 'A', flowId: 1 }, { title: 'B', flowId: 1 }] },
    { type: 'delay', seconds: 1 },
    { type: 'message', text: 'Después de esperar' },
  ] });
  await apiCall('/triggers', 'POST', { type: 'keyword', keywords: ['menu'], match_type: 'exact', channels: ['whatsapp'], flow_id: flow.id });

  sentLog.length = 0;
  await webhook({
    object: 'whatsapp_business_account',
    entry: [{ id: 'w', changes: [{ field: 'messages', value: {
      contacts: [{ wa_id: '34600000000', profile: { name: 'Luis' } }],
      messages: [{ from: '34600000000', id: 'wamid.1', type: 'text', text: { body: 'Menú' } }],
    } }] }],
  });
  assert.equal(sentLog.length, 1);
  assert.equal(sentLog[0].body.type, 'interactive');
  assert.equal(sentLog[0].body.interactive.action.buttons.length, 2);

  db.prepare('UPDATE jobs SET run_at = 0').run();
  await runDueJobs();
  assert.equal(sentLog.at(-1).body.text.body, 'Después de esperar');
});

test('bienvenida, respuesta por defecto con enfriamiento y pausa humana', async () => {
  const welcome = await apiCall('/flows', 'POST', { name: 'Bienvenida', steps: [{ type: 'message', text: 'Bienvenido' }] });
  const def = await apiCall('/flows', 'POST', { name: 'Defecto', steps: [{ type: 'message', text: 'No te entendí' }] });
  await apiCall('/triggers', 'POST', { type: 'welcome', flow_id: welcome.id });
  await apiCall('/triggers', 'POST', { type: 'default', flow_id: def.id, cooldown_hours: 24 });

  sentLog.length = 0;
  await webhook(igDM('333', 'hola'));
  await webhook(igDM('333', 'algo raro'));
  await webhook(igDM('333', 'otra cosa'));
  assert.deepEqual(sentLog.map((s) => s.body.message.text), ['Bienvenido', 'No te entendí']);

  const [contact] = await apiCall('/contacts?q=333');
  await apiCall(`/contacts/${contact.id}`, 'PATCH', { paused: true });
  await webhook(igDM('333', 'precio'));
  assert.equal(sentLog.length, 2);

  const r = await apiCall(`/contacts/${contact.id}/send`, 'POST', { text: 'Hola, soy humano' });
  assert.equal(r.ok, true);
  assert.equal(sentLog.at(-1).body.message.text, 'Hola, soy humano');
});
