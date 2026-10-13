import express from 'express';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config, channelStatus } from './config.js';
import { pruneProcessed } from './db.js';
import { verifySignature, normalize } from './webhook.js';
import { handleEvent, runDueJobs } from './engine.js';
import { api } from './api.js';

export const app = express();
app.set('trust proxy', false);

// ---------- Webhook de Meta (público, a través del túnel) ----------

app.get('/webhook', (req, res) => {
  const ok = req.query['hub.mode'] === 'subscribe' && config.verifyToken && req.query['hub.verify_token'] === config.verifyToken;
  if (ok) return res.status(200).send(req.query['hub.challenge']);
  res.sendStatus(403);
});

app.post('/webhook', express.raw({ type: '*/*', limit: '2mb' }), (req, res) => {
  const raw = req.body instanceof Buffer ? req.body : Buffer.alloc(0);
  if (!verifySignature(raw, req.get('x-hub-signature-256'))) {
    console.warn('[webhook] firma no válida, ignorado');
    return res.sendStatus(401);
  }
  let body;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return res.sendStatus(400);
  }
  // Meta exige responder 200 rápido; el procesamiento sigue en segundo plano.
  res.sendStatus(200);
  for (const ev of normalize(body)) {
    handleEvent(ev).catch((err) => console.error('[evento]', err));
  }
});

// ---------- Panel (protegido) ----------

function isLocalRequest(req) {
  const forwarded = req.get('x-forwarded-for') || req.get('forwarded') || req.get('cf-connecting-ip');
  const host = (req.hostname || '').toLowerCase();
  const addr = req.socket.remoteAddress || '';
  const loopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  return !forwarded && loopback && ['localhost', '127.0.0.1', '[::1]'].includes(host);
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function adminAuth(req, res, next) {
  if (config.adminPassword) {
    const [scheme, encoded] = (req.get('authorization') || '').split(' ');
    const password = scheme === 'Basic' && encoded ? Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':') : '';
    if (safeEqual(password, config.adminPassword)) return next();
    res.set('WWW-Authenticate', 'Basic realm="Panel ManyChat local"');
    return res.status(401).send('Autenticación requerida');
  }
  // Sin contraseña, el panel solo se sirve en localhost (nunca a través del túnel).
  if (isLocalRequest(req)) return next();
  res.status(403).send('Panel solo accesible desde localhost. Define ADMIN_PASSWORD para acceder de otra forma.');
}

app.use('/api', adminAuth, api);
app.use('/', adminAuth, express.static(fileURLToPath(new URL('../public', import.meta.url))));

// ---------- Arranque ----------

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  setInterval(() => runDueJobs().catch((e) => console.error('[tareas]', e)), 2000);
  setInterval(() => pruneProcessed(), 6 * 3600 * 1000);
  app.listen(config.port, () => {
    const ch = channelStatus();
    console.log(`Panel:   http://localhost:${config.port}`);
    console.log(`Webhook: <tu-url-del-túnel>/webhook  (verify token: ${config.verifyToken ? 'configurado' : 'FALTA VERIFY_TOKEN'})`);
    console.log(`Canales: Messenger ${ch.messenger ? '✔' : '✘'} · Instagram ${ch.instagram ? '✔' : '✘'} · WhatsApp ${ch.whatsapp ? '✔' : '✘'}`);
    if (config.dryRun) console.log('DRY_RUN activo: no se envía nada a Meta.');
    if (!config.appSecrets.length) console.log('Aviso: sin APP_SECRET no se verifica la firma de los webhooks.');
  });
}
