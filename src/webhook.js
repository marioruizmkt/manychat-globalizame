// Recepción y normalización de webhooks de Meta.
import crypto from 'node:crypto';
import { config } from './config.js';

export function verifySignature(rawBody, header) {
  if (!config.appSecrets.length) return true; // sin APP_SECRET no se valida (solo para pruebas)
  if (!header?.startsWith('sha256=')) return false;
  const received = Buffer.from(header.slice(7), 'hex');
  return config.appSecrets.some((secret) => {
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
    return expected.length === received.length && crypto.timingSafeEqual(expected, received);
  });
}

/**
 * Convierte el cuerpo de un webhook en eventos normalizados:
 * { channel, type: 'message'|'postback'|'comment', senderId, text, payload,
 *   commentId, postId, name, username, eventId }
 */
export function normalize(body) {
  const events = [];
  const object = body?.object;

  for (const entry of body?.entry || []) {
    if (object === 'page' || object === 'instagram') {
      const channel = object === 'page' ? 'messenger' : 'instagram';
      const ownIds = new Set([entry.id, config.messenger.pageId, config.instagram.userId].filter(Boolean));

      for (const m of entry.messaging || []) {
        if (m.message?.is_echo) continue; // mensajes enviados por nosotros
        const senderId = m.sender?.id;
        if (!senderId || ownIds.has(senderId)) continue;
        if (m.message) {
          const payload = m.message.quick_reply?.payload;
          events.push({
            channel,
            type: payload ? 'postback' : 'message',
            senderId,
            text: m.message.text || '',
            payload,
            attachments: m.message.attachments?.map((a) => a.type) || [],
            eventId: m.message.mid,
          });
        } else if (m.postback) {
          events.push({
            channel,
            type: 'postback',
            senderId,
            text: m.postback.title || '',
            payload: m.postback.payload,
            eventId: m.postback.mid || `${senderId}:${m.timestamp}:${m.postback.payload}`,
          });
        }
      }

      for (const change of entry.changes || []) {
        const v = change.value || {};
        // Instagram: field "comments"
        if (object === 'instagram' && change.field === 'comments' && v.from?.id) {
          if (ownIds.has(v.from.id)) continue;
          events.push({
            channel,
            type: 'comment',
            senderId: v.from.id,
            username: v.from.username,
            text: v.text || '',
            commentId: v.id,
            postId: v.media?.id,
            eventId: `comment:${v.id}`,
          });
        }
        // Facebook: field "feed", item "comment", verb "add"
        if (object === 'page' && change.field === 'feed' && v.item === 'comment' && v.verb === 'add') {
          if (!v.from?.id || ownIds.has(v.from.id)) continue;
          events.push({
            channel,
            type: 'comment',
            senderId: v.from.id,
            name: v.from.name,
            text: v.message || '',
            commentId: v.comment_id,
            postId: v.post_id,
            eventId: `comment:${v.comment_id}`,
          });
        }
      }
    }

    if (object === 'whatsapp_business_account') {
      for (const change of entry.changes || []) {
        const v = change.value || {};
        if (change.field !== 'messages') continue;
        const names = Object.fromEntries((v.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
        for (const msg of v.messages || []) {
          const reply = msg.interactive?.button_reply || msg.interactive?.list_reply;
          const payload = reply?.id || msg.button?.payload;
          events.push({
            channel: 'whatsapp',
            type: payload ? 'postback' : 'message',
            senderId: msg.from,
            name: names[msg.from],
            text: msg.text?.body || reply?.title || msg.button?.text || '',
            payload,
            attachments: msg.type !== 'text' && !payload ? [msg.type] : [],
            eventId: msg.id,
          });
        }
      }
    }
  }
  return events;
}
