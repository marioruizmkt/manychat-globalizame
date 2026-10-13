// Cliente mínimo de la Graph API oficial de Meta para Messenger, Instagram y WhatsApp.
import { config } from './config.js';

export const sentLog = []; // en DRY_RUN guarda lo que se habría enviado (útil en tests)

async function graph(host, path, token, body, method = 'POST') {
  const url = new URL(`https://${host}/${config.graphVersion}/${path}`);
  url.searchParams.set('access_token', token);
  if (config.dryRun) {
    const entry = { host, path, method, body };
    sentLog.push(entry);
    console.log('[DRY_RUN]', method, `${host}/${path}`, body ? JSON.stringify(body) : '');
    return { dry_run: true };
  }
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const msg = data.error?.message || `HTTP ${res.status}`;
    const err = new Error(`Meta API (${path}): ${msg}`);
    err.meta = data.error;
    throw err;
  }
  return data;
}

function channelConfig(channel) {
  if (channel === 'messenger') return { host: 'graph.facebook.com', token: config.messenger.token };
  if (channel === 'instagram') return { host: config.instagram.host, token: config.instagram.token };
  if (channel === 'whatsapp') return { host: 'graph.facebook.com', token: config.whatsapp.token };
  throw new Error(`Canal desconocido: ${channel}`);
}

/**
 * Mensaje genérico independiente del canal:
 *   { text, buttons: [{ title, payload }], imageUrl }
 * Destino: { id } (usuario) o { commentId } (respuesta privada a un comentario).
 */
export async function sendMessage(channel, to, msg, { messagingType = 'RESPONSE' } = {}) {
  const { host, token } = channelConfig(channel);

  if (channel === 'whatsapp') {
    return graph(host, `${config.whatsapp.phoneNumberId}/messages`, token, buildWhatsApp(to.id, msg));
  }

  const recipient = to.commentId ? { comment_id: to.commentId } : { id: to.id };
  const body = { recipient, message: buildMessengerLike(msg) };
  // Las respuestas privadas a comentarios no llevan messaging_type.
  if (!to.commentId) body.messaging_type = messagingType;
  return graph(host, 'me/messages', token, body);
}

function buildMessengerLike(msg) {
  if (msg.imageUrl) {
    return { attachment: { type: 'image', payload: { url: msg.imageUrl, is_reusable: true } } };
  }
  const message = { text: msg.text || ' ' };
  if (msg.buttons?.length) {
    message.quick_replies = msg.buttons.slice(0, 13).map((b) => ({
      content_type: 'text',
      title: b.title.slice(0, 20),
      payload: b.payload,
    }));
  }
  return message;
}

function buildWhatsApp(to, msg) {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to };
  if (msg.imageUrl) return { ...base, type: 'image', image: { link: msg.imageUrl } };
  if (msg.buttons?.length) {
    return {
      ...base,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: msg.text || ' ' },
        action: {
          // WhatsApp admite como máximo 3 botones de respuesta de 20 caracteres.
          buttons: msg.buttons.slice(0, 3).map((b) => ({
            type: 'reply',
            reply: { id: b.payload, title: b.title.slice(0, 20) },
          })),
        },
      },
    };
  }
  return { ...base, type: 'text', text: { body: msg.text || ' ', preview_url: true } };
}

/** Respuesta pública a un comentario de Instagram o Facebook. */
export async function replyToComment(channel, commentId, text) {
  const { host, token } = channelConfig(channel);
  if (channel === 'instagram') return graph(host, `${commentId}/replies`, token, { message: text });
  return graph(host, `${commentId}/comments`, token, { message: text });
}

/** Intenta obtener nombre / usuario del contacto. Si falla, devuelve {}. */
export async function fetchProfile(channel, userId) {
  if (config.dryRun || channel === 'whatsapp') return {};
  try {
    const { host, token } = channelConfig(channel);
    const fields = channel === 'instagram' ? 'name,username' : 'first_name,last_name';
    const url = new URL(`https://${host}/${config.graphVersion}/${userId}`);
    url.searchParams.set('fields', fields);
    url.searchParams.set('access_token', token);
    const res = await fetch(url);
    if (!res.ok) return {};
    const data = await res.json();
    if (channel === 'instagram') return { name: data.name, username: data.username };
    return { name: [data.first_name, data.last_name].filter(Boolean).join(' ') };
  } catch {
    return {};
  }
}
