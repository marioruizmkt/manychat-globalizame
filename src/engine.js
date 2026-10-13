// Motor de automatización: contactos, disparadores, flujos, tareas programadas.
import { db, parseRow, now, markProcessed } from './db.js';
import { sendMessage, replyToComment, fetchProfile } from './meta.js';

const HOUR = 3600 * 1000;
export const WINDOW_MS = 24 * HOUR; // ventana de mensajería estándar de Meta
const MAX_GOTO_DEPTH = 10;

// ---------- Contactos ----------

export function getContact(id) {
  return parseRow(db.prepare('SELECT * FROM contacts WHERE id = ?').get(id));
}

async function upsertContact(ev) {
  let contact = parseRow(
    db.prepare('SELECT * FROM contacts WHERE channel = ? AND external_id = ?').get(ev.channel, ev.senderId),
  );
  if (contact) {
    if ((ev.name && !contact.name) || (ev.username && !contact.username)) {
      db.prepare('UPDATE contacts SET name = COALESCE(name, ?), username = COALESCE(username, ?) WHERE id = ?')
        .run(ev.name || null, ev.username || null, contact.id);
      contact = getContact(contact.id);
    }
    return { contact, isNew: false };
  }
  const profile = ev.name || ev.username ? {} : await fetchProfile(ev.channel, ev.senderId);
  const res = db.prepare(
    `INSERT OR IGNORE INTO contacts (channel, external_id, name, username, created_at, last_activity_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(ev.channel, ev.senderId, ev.name || profile.name || null, ev.username || profile.username || null, now(), now());
  contact = parseRow(
    db.prepare('SELECT * FROM contacts WHERE channel = ? AND external_id = ?').get(ev.channel, ev.senderId),
  );
  return { contact, isNew: res.changes > 0 };
}

export function updateContact(id, patch) {
  const allowed = ['tags', 'fields', 'state', 'paused', 'name', 'last_inbound_at', 'last_activity_at'];
  const keys = Object.keys(patch).filter((k) => allowed.includes(k));
  if (!keys.length) return getContact(id);
  const values = keys.map((k) => (typeof patch[k] === 'object' && patch[k] !== null ? JSON.stringify(patch[k]) : patch[k]));
  db.prepare(`UPDATE contacts SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...values, id);
  return getContact(id);
}

function logMessage(contactId, direction, kind, text, meta) {
  db.prepare('INSERT INTO messages (contact_id, direction, kind, text, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(contactId, direction, kind, text ?? null, meta ? JSON.stringify(meta) : null, now());
  db.prepare('UPDATE contacts SET last_activity_at = ? WHERE id = ?').run(now(), contactId);
}

export function canMessage(contact) {
  return Boolean(contact.last_inbound_at && now() - contact.last_inbound_at < WINDOW_MS);
}

// ---------- Texto ----------

export function normalizeText(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function matchKeywords(text, keywords, matchType) {
  if (!keywords?.length) return true;
  const t = normalizeText(text);
  return keywords.some((k) => {
    const kw = normalizeText(k);
    if (!kw) return false;
    if (matchType === 'exact') return t === kw;
    if (matchType === 'starts') return t.startsWith(kw);
    // contains: palabra o frase completa
    return ` ${t} `.includes(` ${kw} `) || (kw.includes(' ') && t.includes(kw));
  });
}

export function render(template, contact) {
  const first = (contact.name || '').split(' ')[0];
  const vars = {
    first_name: first || contact.username || '',
    name: contact.name || contact.username || '',
    username: contact.username || '',
    ...contact.fields,
  };
  return (template || '').replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key) => String(vars[key] ?? ''));
}

// ---------- Flujos ----------

export function getFlow(id) {
  return parseRow(db.prepare('SELECT * FROM flows WHERE id = ?').get(id));
}

async function deliver(contact, msg, opts) {
  const to = opts.commentId ? { commentId: opts.commentId } : { id: contact.external_id };
  try {
    await sendMessage(contact.channel, to, msg, { messagingType: opts.messagingType });
    logMessage(contact.id, 'out', msg.imageUrl ? 'image' : 'text', msg.imageUrl || msg.text, {
      buttons: msg.buttons?.map((b) => b.title),
      privateReply: Boolean(opts.commentId),
    });
    return true;
  } catch (err) {
    console.error(`[envío] contacto ${contact.id}:`, err.message);
    logMessage(contact.id, 'out', 'error', err.message);
    return false;
  }
}

/**
 * Ejecuta un flujo desde startIndex.
 * opts.commentId: el primer mensaje se envía como respuesta privada al comentario.
 *   Meta solo permite UN mensaje así; el resto del flujo queda pendiente hasta
 *   que el usuario responda (como hace ManyChat).
 */
export async function runFlow(contactId, flowId, startIndex = 0, opts = {}, depth = 0) {
  const flow = getFlow(flowId);
  if (!flow || depth > MAX_GOTO_DEPTH) return;
  let contact = getContact(contactId);
  const steps = flow.steps || [];

  for (let i = startIndex; i < steps.length; i++) {
    const step = steps[i];
    contact = getContact(contactId);

    switch (step.type) {
      case 'message':
      case 'image': {
        const msg = step.type === 'image'
          ? { imageUrl: step.url }
          : {
              text: render(step.text, contact),
              buttons: (step.buttons || []).filter((b) => b.title && b.flowId)
                .map((b) => ({ title: render(b.title, contact), payload: `FLOW:${b.flowId}` })),
            };
        const ok = await deliver(contact, msg, opts);
        if (!ok) return;
        if (opts.commentId) {
          const rest = i + 1 < steps.length ? { resume: { flowId, index: i + 1 } } : {};
          updateContact(contactId, { state: rest });
          return;
        }
        break;
      }
      case 'question': {
        const ok = await deliver(contact, { text: render(step.text, contact) }, opts);
        if (!ok) return;
        updateContact(contactId, { state: { await: { flowId, index: i + 1, field: step.field || 'respuesta' } } });
        return;
      }
      case 'delay': {
        const seconds = Math.max(1, Number(step.seconds) || 1);
        db.prepare('INSERT INTO jobs (contact_id, flow_id, step_index, run_at) VALUES (?, ?, ?, ?)')
          .run(contactId, flowId, i + 1, now() + seconds * 1000);
        return;
      }
      case 'tag': {
        const tags = new Set(contact.tags);
        if (step.action === 'remove') tags.delete(step.tag);
        else if (step.tag) tags.add(step.tag);
        updateContact(contactId, { tags: [...tags] });
        break;
      }
      case 'field': {
        if (step.field) updateContact(contactId, { fields: { ...contact.fields, [step.field]: render(step.value, contact) } });
        break;
      }
      case 'goto': {
        if (step.flowId) return runFlow(contactId, Number(step.flowId), 0, opts, depth + 1);
        break;
      }
      default:
        console.warn(`[flujo ${flowId}] paso desconocido: ${step.type}`);
    }
  }
}

// ---------- Disparadores ----------

function activeTriggers(type, channel) {
  return db.prepare('SELECT * FROM triggers WHERE type = ? AND active = 1 ORDER BY id').all(type)
    .map(parseRow)
    .filter((t) => !t.channels?.length || t.channels.includes(channel))
    .filter((t) => t.flow_id);
}

// Serializa el procesamiento por contacto para evitar condiciones de carrera.
const queues = new Map();
function enqueue(key, fn) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(fn, fn).finally(() => {
    if (queues.get(key) === next) queues.delete(key);
  });
  queues.set(key, next);
  return next;
}

export async function handleEvent(ev) {
  if (!markProcessed(ev.eventId)) return; // duplicado
  return enqueue(`${ev.channel}:${ev.senderId}`, () => processEvent(ev));
}

async function processEvent(ev) {
  const { contact, isNew } = await upsertContact(ev);

  if (ev.type === 'comment') {
    logMessage(contact.id, 'in', 'comment', ev.text, { postId: ev.postId, commentId: ev.commentId });
  } else {
    // Un mensaje o pulsación de botón abre la ventana de 24 h; un comentario no.
    updateContact(contact.id, { last_inbound_at: now() });
    const kind = ev.type === 'postback' ? 'button' : ev.attachments?.length ? ev.attachments[0] : 'text';
    logMessage(contact.id, 'in', kind, ev.text, ev.payload ? { payload: ev.payload } : null);
  }

  if (contact.paused) return; // chat en vivo: un humano ha tomado el control

  if (ev.type === 'comment') {
    const trigger = activeTriggers('comment', ev.channel).find(
      (t) => (!t.post_id || t.post_id === ev.postId) && matchKeywords(ev.text, t.keywords, t.match_type),
    );
    if (!trigger) return;
    const replies = (trigger.public_replies || []).filter(Boolean);
    if (replies.length) {
      const text = render(replies[Math.floor(Math.random() * replies.length)], contact);
      await replyToComment(ev.channel, ev.commentId, text).catch((e) => console.error('[comentario]', e.message));
    }
    return runFlow(contact.id, trigger.flow_id, 0, { commentId: ev.commentId });
  }

  const state = contact.state || {};

  if (ev.payload?.startsWith('FLOW:')) {
    updateContact(contact.id, { state: {} });
    return runFlow(contact.id, Number(ev.payload.slice(5)));
  }

  if (state.await) {
    const fields = { ...contact.fields, [state.await.field]: ev.text };
    updateContact(contact.id, { fields, state: {} });
    return runFlow(contact.id, state.await.flowId, state.await.index);
  }

  const keyword = activeTriggers('keyword', ev.channel).find((t) => matchKeywords(ev.text, t.keywords, t.match_type));
  if (keyword) {
    updateContact(contact.id, { state: {} });
    return runFlow(contact.id, keyword.flow_id);
  }

  if (state.resume) {
    updateContact(contact.id, { state: {} });
    return runFlow(contact.id, state.resume.flowId, state.resume.index);
  }

  if (isNew) {
    const welcome = activeTriggers('welcome', ev.channel)[0];
    if (welcome) return runFlow(contact.id, welcome.flow_id);
  }

  const fallback = activeTriggers('default', ev.channel)[0];
  if (fallback) {
    const last = contact.fields?._last_default_at || 0;
    if (now() - last >= fallback.cooldown_hours * HOUR) {
      updateContact(contact.id, { fields: { ...getContact(contact.id).fields, _last_default_at: now() } });
      return runFlow(contact.id, fallback.flow_id);
    }
  }
}

// ---------- Tareas programadas (pasos de espera) ----------

export async function runDueJobs() {
  const jobs = db.prepare('SELECT * FROM jobs WHERE run_at <= ? ORDER BY run_at LIMIT 50').all(now());
  for (const job of jobs) {
    db.prepare('DELETE FROM jobs WHERE id = ?').run(job.id);
    const contact = getContact(job.contact_id);
    if (!contact || contact.paused) continue;
    await enqueue(`${contact.channel}:${contact.external_id}`, () =>
      runFlow(job.contact_id, job.flow_id, job.step_index),
    ).catch((e) => console.error('[tarea]', e.message));
  }
}

// ---------- Envíos manuales y difusiones ----------

export async function sendManual(contactId, text) {
  const contact = getContact(contactId);
  if (!contact) throw new Error('Contacto no encontrado');
  if (!canMessage(contact)) throw new Error('Fuera de la ventana de 24 h: Meta no permite escribir a este contacto ahora');
  const ok = await deliver(contact, { text }, { messagingType: 'RESPONSE' });
  if (!ok) throw new Error('Meta rechazó el mensaje (mira la conversación para ver el error)');
}

/** Envía un flujo a los contactos dentro de la ventana de 24 h (política de Meta). */
export async function broadcast({ flowId, tag, channel }) {
  if (!getFlow(flowId)) throw new Error('Flujo no encontrado');
  const contacts = db.prepare('SELECT * FROM contacts WHERE paused = 0 AND last_inbound_at > ?')
    .all(now() - WINDOW_MS)
    .map(parseRow)
    .filter((c) => (!channel || c.channel === channel) && (!tag || c.tags.includes(tag)));
  for (const c of contacts) {
    await enqueue(`${c.channel}:${c.external_id}`, () => runFlow(c.id, flowId, 0, { messagingType: 'UPDATE' }));
  }
  return { sent: contacts.length };
}
