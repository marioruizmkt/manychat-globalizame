// API REST del panel de administración.
import express from 'express';
import { db, parseRow, now } from './db.js';
import { config, channelStatus } from './config.js';
import { getContact, updateContact, sendManual, broadcast, getFlow, WINDOW_MS } from './engine.js';

export const api = express.Router();
api.use(express.json({ limit: '1mb' }));

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => res.status(400).json({ error: err.message }));

const STEP_TYPES = ['message', 'image', 'question', 'delay', 'tag', 'field', 'goto'];
const TRIGGER_TYPES = ['keyword', 'comment', 'welcome', 'default'];

// ---------- Estado ----------

api.get('/status', (req, res) => {
  const count = (sql, ...args) => db.prepare(sql).get(...args).n;
  res.json({
    channels: channelStatus(),
    dryRun: config.dryRun,
    signatureCheck: config.appSecrets.length > 0,
    stats: {
      contacts: count('SELECT COUNT(*) n FROM contacts'),
      active24h: count('SELECT COUNT(*) n FROM contacts WHERE last_inbound_at > ?', now() - WINDOW_MS),
      messagesIn: count("SELECT COUNT(*) n FROM messages WHERE direction = 'in'"),
      messagesOut: count("SELECT COUNT(*) n FROM messages WHERE direction = 'out' AND kind != 'error'"),
      errors: count("SELECT COUNT(*) n FROM messages WHERE kind = 'error'"),
      flows: count('SELECT COUNT(*) n FROM flows'),
      triggers: count('SELECT COUNT(*) n FROM triggers WHERE active = 1'),
    },
  });
});

// ---------- Contactos / bandeja ----------

api.get('/contacts', (req, res) => {
  const q = `%${req.query.q || ''}%`;
  const rows = db.prepare(
    `SELECT c.*, (SELECT text FROM messages m WHERE m.contact_id = c.id ORDER BY id DESC LIMIT 1) AS last_text
     FROM contacts c
     WHERE COALESCE(c.name, '') LIKE ? OR COALESCE(c.username, '') LIKE ? OR c.external_id LIKE ? OR c.tags LIKE ?
     ORDER BY c.last_activity_at DESC LIMIT 500`,
  ).all(q, q, q, q);
  res.json(rows.map(parseRow).map((c) => ({ ...c, can_message: Boolean(c.last_inbound_at && now() - c.last_inbound_at < WINDOW_MS) })));
});

api.get('/contacts/:id', (req, res) => {
  const contact = getContact(req.params.id);
  if (!contact) return res.status(404).json({ error: 'No encontrado' });
  const messages = db.prepare('SELECT * FROM messages WHERE contact_id = ? ORDER BY id DESC LIMIT 200')
    .all(contact.id).map(parseRow).reverse();
  res.json({ ...contact, can_message: Boolean(contact.last_inbound_at && now() - contact.last_inbound_at < WINDOW_MS), messages });
});

api.patch('/contacts/:id', wrap((req, res) => {
  const { tags, fields, paused, name } = req.body;
  const patch = {};
  if (Array.isArray(tags)) patch.tags = tags.map(String).filter(Boolean);
  if (fields && typeof fields === 'object') patch.fields = fields;
  if (paused !== undefined) patch.paused = paused ? 1 : 0;
  if (typeof name === 'string') patch.name = name;
  res.json(updateContact(req.params.id, patch));
}));

api.delete('/contacts/:id', (req, res) => {
  db.prepare('DELETE FROM contacts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

api.post('/contacts/:id/send', wrap(async (req, res) => {
  const text = String(req.body.text || '').trim();
  if (!text) throw new Error('Mensaje vacío');
  await sendManual(Number(req.params.id), text);
  res.json({ ok: true });
}));

// ---------- Flujos ----------

function cleanSteps(steps) {
  if (!Array.isArray(steps)) throw new Error('steps debe ser una lista');
  return steps.map((s) => {
    if (!STEP_TYPES.includes(s?.type)) throw new Error(`Tipo de paso no válido: ${s?.type}`);
    return s;
  });
}

api.get('/flows', (req, res) => {
  res.json(db.prepare('SELECT * FROM flows ORDER BY name').all().map(parseRow));
});

api.post('/flows', wrap((req, res) => {
  const name = String(req.body.name || '').trim() || 'Nuevo flujo';
  const steps = cleanSteps(req.body.steps || []);
  const r = db.prepare('INSERT INTO flows (name, steps, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(name, JSON.stringify(steps), now(), now());
  res.json(getFlow(r.lastInsertRowid));
}));

api.put('/flows/:id', wrap((req, res) => {
  const flow = getFlow(req.params.id);
  if (!flow) return res.status(404).json({ error: 'No encontrado' });
  const name = String(req.body.name ?? flow.name).trim() || flow.name;
  const steps = cleanSteps(req.body.steps ?? flow.steps);
  db.prepare('UPDATE flows SET name = ?, steps = ?, updated_at = ? WHERE id = ?')
    .run(name, JSON.stringify(steps), now(), flow.id);
  res.json(getFlow(flow.id));
}));

api.delete('/flows/:id', (req, res) => {
  db.prepare('DELETE FROM flows WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- Disparadores ----------

function triggerValues(b) {
  if (!TRIGGER_TYPES.includes(b.type)) throw new Error('Tipo de disparador no válido');
  if (!getFlow(b.flow_id)) throw new Error('Elige un flujo');
  const arr = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
  return [
    b.type,
    String(b.name || ''),
    JSON.stringify(arr(b.channels)),
    ['exact', 'contains', 'starts'].includes(b.match_type) ? b.match_type : 'contains',
    JSON.stringify(arr(b.keywords)),
    b.post_id ? String(b.post_id).trim() : null,
    JSON.stringify(arr(b.public_replies)),
    Number(b.cooldown_hours ?? 24),
    Number(b.flow_id),
    b.active === false ? 0 : 1,
  ];
}

api.get('/triggers', (req, res) => {
  res.json(db.prepare('SELECT * FROM triggers ORDER BY type, id').all().map(parseRow));
});

api.post('/triggers', wrap((req, res) => {
  const r = db.prepare(
    `INSERT INTO triggers (type, name, channels, match_type, keywords, post_id, public_replies, cooldown_hours, flow_id, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(...triggerValues(req.body), now());
  res.json(parseRow(db.prepare('SELECT * FROM triggers WHERE id = ?').get(r.lastInsertRowid)));
}));

api.put('/triggers/:id', wrap((req, res) => {
  db.prepare(
    `UPDATE triggers SET type = ?, name = ?, channels = ?, match_type = ?, keywords = ?, post_id = ?,
     public_replies = ?, cooldown_hours = ?, flow_id = ?, active = ? WHERE id = ?`,
  ).run(...triggerValues(req.body), req.params.id);
  res.json(parseRow(db.prepare('SELECT * FROM triggers WHERE id = ?').get(req.params.id)));
}));

api.delete('/triggers/:id', (req, res) => {
  db.prepare('DELETE FROM triggers WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- Difusión ----------

api.post('/broadcast', wrap(async (req, res) => {
  const { flowId, tag, channel } = req.body;
  res.json(await broadcast({ flowId: Number(flowId), tag: tag || null, channel: channel || null }));
}));
