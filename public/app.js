// Panel de administración (JS sin dependencias).
const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const CHANNELS = { messenger: 'Messenger', instagram: 'Instagram', whatsapp: 'WhatsApp' };
const CH_ICON = { messenger: '💬', instagram: '📸', whatsapp: '🟢' };

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 3000);
}

const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const contactLabel = (c) => c.name || (c.username ? `@${c.username}` : c.external_id);

// ---------- Pestañas ----------

const loaders = { dashboard: loadDashboard, inbox: loadContacts, flows: loadFlows, triggers: loadTriggers, broadcast: loadBroadcast };
let currentTab = 'dashboard';
$('#tabs').addEventListener('click', (e) => {
  const tab = e.target.dataset.tab;
  if (!tab) return;
  currentTab = tab;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('active', s.id === tab));
  loaders[tab]();
});

// ---------- Panel ----------

async function loadDashboard() {
  const s = await api('/status');
  const banners = [];
  if (s.dryRun) banners.push('Modo DRY_RUN activo: los mensajes no se envían a Meta, solo se registran.');
  if (!s.signatureCheck) banners.push('Sin APP_SECRET: la firma de los webhooks no se verifica.');
  $('#banner').innerHTML = banners.map((b) => `<div class="banner">${esc(b)}</div>`).join('');
  const labels = {
    contacts: 'Contactos', active24h: 'Activos 24 h', messagesIn: 'Recibidos', messagesOut: 'Enviados',
    errors: 'Errores de envío', flows: 'Flujos', triggers: 'Disparadores activos',
  };
  $('#stats').innerHTML = Object.entries(labels)
    .map(([k, l]) => `<div class="stat"><b>${esc(s.stats[k])}</b><span class="muted">${l}</span></div>`).join('');
  $('#channels').innerHTML = Object.entries(CHANNELS)
    .map(([k, l]) => `<div>${CH_ICON[k]} ${l}: ${s.channels[k] ? '<span class="ok">conectado</span>' : '<span class="bad">sin configurar</span>'}</div>`)
    .join('');
}

// ---------- Bandeja / chat en vivo ----------

let selectedContact = null;
let searchTimer;

$('#contactSearch').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadContacts, 250);
});

async function loadContacts() {
  const q = encodeURIComponent($('#contactSearch').value);
  const contacts = await api(`/contacts?q=${q}`);
  $('#contactList').innerHTML = contacts.map((c) => `
    <li data-id="${c.id}" class="${c.id === selectedContact ? 'active' : ''}">
      ${CH_ICON[c.channel]} <b>${esc(contactLabel(c))}</b> ${c.paused ? '<span class="pill">humano</span>' : ''}
      <small>${esc(c.last_text || '')}</small>
    </li>`).join('') || '<li class="muted">Sin contactos todavía</li>';
}

$('#contactList').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (li) openChat(Number(li.dataset.id));
});

async function openChat(id) {
  selectedContact = id;
  const c = await api(`/contacts/${id}`);
  const fields = Object.entries(c.fields || {}).filter(([k]) => !k.startsWith('_'));
  $('#chat').innerHTML = `
    <div class="chat-head">
      <div class="row">
        <div><b>${CH_ICON[c.channel]} ${esc(contactLabel(c))}</b>
          <div class="muted">${esc(CHANNELS[c.channel])} · ID ${esc(c.external_id)} · ventana 24 h:
          ${c.can_message ? '<span class="ok">abierta</span>' : '<span class="bad">cerrada</span>'}</div></div>
        <button id="togglePause">${c.paused ? '▶ Reanudar bot' : '⏸ Tomar control (pausar bot)'}</button>
        <button id="deleteContact" class="danger">Eliminar</button>
      </div>
      <label>Etiquetas (separadas por comas)</label>
      <div class="row"><input id="tagsInput" value="${esc((c.tags || []).join(', '))}" /><button id="saveTags">Guardar</button></div>
      ${fields.length ? `<div style="margin-top:8px">${fields.map(([k, v]) => `<span class="pill">${esc(k)}: ${esc(v)}</span>`).join('')}</div>` : ''}
    </div>
    <div class="messages">${c.messages.map(renderMsg).join('') || '<p class="muted center">Sin mensajes</p>'}</div>
    <form class="composer" id="composer">
      <input id="composerText" placeholder="${c.can_message ? 'Escribe un mensaje…' : 'Fuera de la ventana de 24 h'}" ${c.can_message ? '' : 'disabled'} />
      <button class="primary" ${c.can_message ? '' : 'disabled'}>Enviar</button>
    </form>`;
  const box = $('.messages');
  box.scrollTop = box.scrollHeight;

  $('#togglePause').onclick = async () => { await api(`/contacts/${id}`, { method: 'PATCH', body: { paused: !c.paused } }); openChat(id); loadContacts(); };
  $('#deleteContact').onclick = async () => {
    if (!confirm('¿Eliminar este contacto y su historial?')) return;
    await api(`/contacts/${id}`, { method: 'DELETE' });
    selectedContact = null;
    $('#chat').innerHTML = '<p class="muted center">Selecciona una conversación</p>';
    loadContacts();
  };
  $('#saveTags').onclick = async () => {
    const tags = $('#tagsInput').value.split(',').map((t) => t.trim()).filter(Boolean);
    await api(`/contacts/${id}`, { method: 'PATCH', body: { tags } });
    toast('Etiquetas guardadas');
  };
  $('#composer').onsubmit = async (e) => {
    e.preventDefault();
    const text = $('#composerText').value.trim();
    if (!text) return;
    try {
      await api(`/contacts/${id}/send`, { method: 'POST', body: { text } });
      openChat(id);
    } catch (err) { toast(err.message); }
  };
  loadContacts();
}

function renderMsg(m) {
  const cls = m.kind === 'error' ? 'error' : m.direction;
  const meta = m.meta || {};
  let extra = '';
  if (m.kind === 'comment') extra = '💬 comentario';
  if (m.kind === 'button') extra = '🔘 botón';
  if (meta.privateReply) extra = '🔒 respuesta privada a comentario';
  if (meta.buttons?.length) extra += ` · [${meta.buttons.map(esc).join('] [')}]`;
  const body = m.kind === 'image' && m.direction === 'out' ? `🖼 ${esc(m.text)}` : esc(m.text || `(${m.kind})`);
  return `<div class="msg ${cls}">${m.kind === 'error' ? '⚠ ' : ''}${body}<small>${extra ? `${extra} · ` : ''}${fmtDate(m.created_at)}</small></div>`;
}

// Refresco automático del chat abierto
setInterval(() => {
  if (currentTab === 'inbox' && selectedContact && document.activeElement?.id !== 'composerText' && document.activeElement?.id !== 'tagsInput') {
    openChat(selectedContact).catch(() => {});
  }
}, 5000);

// ---------- Flujos ----------

let flows = [];
let editing = null;

async function loadFlows() {
  flows = await api('/flows');
  $('#flowList').innerHTML = flows.map((f) => `<li data-id="${f.id}" class="${editing?.id === f.id ? 'active' : ''}"><b>${esc(f.name)}</b><small>${f.steps.length} pasos · #${f.id}</small></li>`).join('')
    || '<li class="muted">Aún no hay flujos</li>';
}

$('#flowList').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  editing = structuredClone(flows.find((f) => f.id === Number(li.dataset.id)));
  renderEditor();
  loadFlows();
});

$('#newFlow').onclick = async () => {
  const f = await api('/flows', { method: 'POST', body: { name: 'Nuevo flujo', steps: [{ type: 'message', text: '¡Hola {{first_name}}! 👋', buttons: [] }] } });
  editing = f;
  await loadFlows();
  renderEditor();
};

const STEP_LABELS = {
  message: '💬 Mensaje', image: '🖼 Imagen', question: '❓ Pregunta (guarda respuesta)', delay: '⏱ Espera',
  tag: '🏷 Etiqueta', field: '✏️ Campo personalizado', goto: '↪ Ir a otro flujo',
};

function flowOptions(selected) {
  return `<option value="">— elige flujo —</option>` + flows.map((f) => `<option value="${f.id}" ${Number(selected) === f.id ? 'selected' : ''}>${esc(f.name)} (#${f.id})</option>`).join('');
}

function stepBody(s, i) {
  const field = (key, label, attrs = '') => `<label>${label}</label><input data-i="${i}" data-k="${key}" value="${esc(s[key] ?? '')}" ${attrs} />`;
  switch (s.type) {
    case 'message':
      return `<label>Texto (variables: {{first_name}}, {{username}}, {{campo}})</label>
        <textarea data-i="${i}" data-k="text">${esc(s.text)}</textarea>
        <label>Botones de respuesta rápida (máx. 13; WhatsApp máx. 3)</label>
        ${(s.buttons || []).map((b, j) => `<div class="row" style="margin-bottom:6px">
            <input data-i="${i}" data-b="${j}" data-bk="title" placeholder="Texto del botón" value="${esc(b.title)}" maxlength="20" />
            <select data-i="${i}" data-b="${j}" data-bk="flowId">${flowOptions(b.flowId)}</select>
            <button type="button" class="small danger" data-act="delbtn" data-i="${i}" data-b="${j}">✕</button></div>`).join('')}
        <button type="button" class="small" data-act="addbtn" data-i="${i}">+ Botón</button>`;
    case 'image': return field('url', 'URL pública de la imagen');
    case 'question':
      return `<label>Pregunta</label><textarea data-i="${i}" data-k="text">${esc(s.text)}</textarea>${field('field', 'Guardar respuesta en el campo')}`;
    case 'delay': return field('seconds', 'Segundos de espera', 'type="number" min="1"');
    case 'tag':
      return `<label>Acción</label><select data-i="${i}" data-k="action">
        <option value="add" ${s.action !== 'remove' ? 'selected' : ''}>Añadir</option>
        <option value="remove" ${s.action === 'remove' ? 'selected' : ''}>Quitar</option></select>${field('tag', 'Etiqueta')}`;
    case 'field': return field('field', 'Campo') + field('value', 'Valor (admite variables)');
    case 'goto': return `<label>Flujo destino</label><select data-i="${i}" data-k="flowId">${flowOptions(s.flowId)}</select>`;
    default: return '';
  }
}

function renderEditor() {
  if (!editing) return;
  $('#flowEditor').innerHTML = `
    <div class="row"><input id="flowName" value="${esc(editing.name)}" /><span class="muted" style="flex:0">#${editing.id}</span></div>
    <div id="steps">${editing.steps.map((s, i) => `
      <div class="step">
        <div class="step-head"><span>${i + 1}. ${STEP_LABELS[s.type]}</span>
          <span><button type="button" class="small" data-act="up" data-i="${i}">↑</button>
          <button type="button" class="small" data-act="down" data-i="${i}">↓</button>
          <button type="button" class="small danger" data-act="del" data-i="${i}">Eliminar</button></span></div>
        ${stepBody(s, i)}
      </div>`).join('')}</div>
    <div class="row" style="margin-top:8px">
      <select id="newStepType">${Object.entries(STEP_LABELS).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
      <button type="button" data-act="add">+ Añadir paso</button>
    </div>
    <div class="row" style="margin-top:16px">
      <button class="primary" data-act="save">Guardar flujo</button>
      <button class="danger" data-act="delflow">Eliminar flujo</button>
    </div>
    <p class="muted">Desde un comentario, Meta solo permite enviar <b>un</b> mensaje privado: el resto del flujo continúa cuando la persona responde o pulsa un botón.</p>`;
}

$('#flowEditor').addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'flowName') { editing.name = t.value; return; }
  const i = Number(t.dataset.i);
  if (Number.isNaN(i)) return;
  if (t.dataset.b !== undefined) editing.steps[i].buttons[Number(t.dataset.b)][t.dataset.bk] = t.value;
  else if (t.dataset.k) editing.steps[i][t.dataset.k] = t.value;
});

$('#flowEditor').addEventListener('click', async (e) => {
  const act = e.target.dataset.act;
  if (!act) return;
  const i = Number(e.target.dataset.i);
  const steps = editing.steps;
  if (act === 'add') {
    const type = $('#newStepType').value;
    const defaults = { message: { text: '', buttons: [] }, delay: { seconds: 5 }, tag: { action: 'add', tag: '' }, question: { text: '', field: '' } };
    steps.push({ type, ...(defaults[type] || {}) });
  }
  if (act === 'del') steps.splice(i, 1);
  if (act === 'up' && i > 0) [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]];
  if (act === 'down' && i < steps.length - 1) [steps[i + 1], steps[i]] = [steps[i], steps[i + 1]];
  if (act === 'addbtn') (steps[i].buttons ||= []).push({ title: '', flowId: '' });
  if (act === 'delbtn') steps[i].buttons.splice(Number(e.target.dataset.b), 1);
  if (act === 'save') {
    try {
      editing = await api(`/flows/${editing.id}`, { method: 'PUT', body: { name: editing.name, steps } });
      toast('Flujo guardado');
      await loadFlows();
    } catch (err) { toast(err.message); }
  }
  if (act === 'delflow') {
    if (!confirm('¿Eliminar el flujo? También se borrarán sus disparadores.')) return;
    await api(`/flows/${editing.id}`, { method: 'DELETE' });
    editing = null;
    $('#flowEditor').innerHTML = '<p class="muted">Selecciona o crea un flujo</p>';
    await loadFlows();
    return;
  }
  renderEditor();
});

// ---------- Disparadores ----------

const TRIGGER_LABELS = {
  keyword: '🔑 Palabra clave en DM',
  comment: '💬 Comentario en publicación → DM',
  welcome: '👋 Bienvenida (primer mensaje)',
  default: '🤷 Respuesta por defecto',
};
const lines = (v) => v.split('\n').map((s) => s.trim()).filter(Boolean);

async function loadTriggers() {
  flows = await api('/flows');
  renderTriggerForm();
  const triggers = await api('/triggers');
  const flowName = (id) => flows.find((f) => f.id === id)?.name || `#${id}`;
  $('#triggerList').innerHTML = triggers.map((t) => `
    <div class="card trigger">
      <div>
        <b>${TRIGGER_LABELS[t.type]}</b> ${t.name ? `· ${esc(t.name)}` : ''} ${t.active ? '' : '<span class="pill">pausado</span>'}
        <div class="muted">Flujo: ${esc(flowName(t.flow_id))} · Canales: ${t.channels.length ? t.channels.map((c) => CHANNELS[c]).join(', ') : 'todos'}
        ${t.post_id ? ` · Publicación: ${esc(t.post_id)}` : ''}</div>
        ${t.keywords.length ? `<div>${t.keywords.map((k) => `<span class="pill">${esc(k)}</span>`).join('')} <span class="muted">(${esc(t.match_type)})</span></div>` : ''}
        ${t.public_replies.length ? `<div class="muted">Respuestas públicas: ${t.public_replies.map(esc).join(' | ')}</div>` : ''}
      </div>
      <div class="row" style="flex:0 0 auto">
        <button class="small" data-toggle="${t.id}">${t.active ? 'Pausar' : 'Activar'}</button>
        <button class="small danger" data-del="${t.id}">Eliminar</button>
      </div>
    </div>`).join('') || '<p class="muted">Sin disparadores</p>';
  $('#triggerList').onclick = async (e) => {
    const del = e.target.dataset.del;
    const tog = e.target.dataset.toggle;
    if (del && confirm('¿Eliminar disparador?')) await api(`/triggers/${del}`, { method: 'DELETE' });
    if (tog) {
      const t = triggers.find((x) => x.id === Number(tog));
      await api(`/triggers/${tog}`, { method: 'PUT', body: { ...t, active: !t.active } });
    }
    if (del || tog) loadTriggers();
  };
}

function renderTriggerForm() {
  const form = $('#triggerForm');
  const type = form.elements.type?.value || 'keyword';
  form.innerHTML = `
    <div class="row">
      <div><label>Tipo</label><select name="type">${Object.entries(TRIGGER_LABELS).map(([k, l]) => `<option value="${k}" ${k === type ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div><label>Nombre (opcional)</label><input name="name" /></div>
      <div><label>Flujo a ejecutar</label><select name="flow_id">${flowOptions()}</select></div>
    </div>
    <label>Canales</label>
    <div class="row">${Object.entries(CHANNELS).filter(([k]) => type !== 'comment' || k !== 'whatsapp').map(([k, l]) => `<label style="flex:0 0 auto"><input type="checkbox" name="channels" value="${k}" style="width:auto" checked /> ${l}</label>`).join('')}</div>
    ${type === 'keyword' || type === 'comment' ? `
      <div class="row">
        <div><label>Palabras clave (una por línea${type === 'comment' ? '; vacío = cualquier comentario' : ''})</label><textarea name="keywords"></textarea></div>
        <div><label>Coincidencia</label><select name="match_type"><option value="contains">Contiene la palabra</option><option value="exact">Exacta</option><option value="starts">Empieza por</option></select></div>
      </div>` : ''}
    ${type === 'comment' ? `
      <label>ID de la publicación (vacío = todas)</label><input name="post_id" placeholder="Ej. 17895695668004550" />
      <label>Respuestas públicas al comentario (una por línea, se elige al azar; vacío = no responder en público)</label>
      <textarea name="public_replies">¡Te lo envié por DM! 📩\n¡Revisa tus mensajes! 🙌</textarea>` : ''}
    ${type === 'default' ? '<label>No repetir antes de (horas)</label><input name="cooldown_hours" type="number" value="24" min="0" />' : ''}
    <div style="margin-top:12px"><button class="primary">Crear disparador</button></div>`;
  form.elements.type.onchange = renderTriggerForm;
}

$('#triggerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const body = {
    type: f.type.value,
    name: f.name.value,
    flow_id: Number(f.flow_id.value),
    channels: [...e.target.querySelectorAll('input[name=channels]:checked')].map((c) => c.value),
    keywords: f.keywords ? lines(f.keywords.value) : [],
    match_type: f.match_type?.value,
    post_id: f.post_id?.value,
    public_replies: f.public_replies ? lines(f.public_replies.value) : [],
    cooldown_hours: f.cooldown_hours ? Number(f.cooldown_hours.value) : 24,
  };
  const available = e.target.querySelectorAll('input[name=channels]').length;
  if (body.channels.length === available) body.channels = [];
  try {
    await api('/triggers', { method: 'POST', body });
    toast('Disparador creado');
    loadTriggers();
  } catch (err) { toast(err.message); }
});

// ---------- Difusión ----------

async function loadBroadcast() {
  flows = await api('/flows');
  $('#broadcastForm').innerHTML = `
    <div class="row">
      <div><label>Flujo</label><select name="flowId">${flowOptions()}</select></div>
      <div><label>Solo con etiqueta (opcional)</label><input name="tag" /></div>
      <div><label>Canal</label><select name="channel"><option value="">Todos</option>${Object.entries(CHANNELS).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div>
    </div>
    <div style="margin-top:12px"><button class="primary">Enviar</button></div>`;
}

$('#broadcastForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  if (!confirm('¿Enviar la difusión ahora?')) return;
  try {
    const r = await api('/broadcast', { method: 'POST', body: { flowId: f.flowId.value, tag: f.tag.value, channel: f.channel.value } });
    $('#broadcastResult').textContent = `Enviado a ${r.sent} contacto(s).`;
  } catch (err) { toast(err.message); }
});

loadDashboard().catch((e) => toast(e.message));
