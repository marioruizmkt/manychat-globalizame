# ManyChat Local

Réplica de ManyChat para uso propio que funciona **en tu ordenador** y habla directamente con la **API oficial de Meta**: Instagram, Facebook Messenger y WhatsApp Cloud API. Sin suscripciones ni intermediarios.

## Qué incluye

| Función de ManyChat | Aquí |
|---|---|
| Palabras clave en DM | Disparador «Palabra clave» (contiene / exacta / empieza por; ignora mayúsculas, tildes y signos) |
| Comentario → DM (Instagram y Facebook) | Disparador «Comentario»: respuesta pública aleatoria + mensaje privado al comentarista, filtrable por publicación y palabra |
| Mensaje de bienvenida | Disparador «Bienvenida» (primer mensaje de un contacto nuevo) |
| Respuesta por defecto | Disparador «Por defecto», con tiempo mínimo entre repeticiones |
| Constructor de flujos | Pasos: mensaje con botones de respuesta rápida, imagen, pregunta que guarda la respuesta en un campo, espera, etiqueta, campo personalizado, ir a otro flujo |
| Variables | `{{first_name}}`, `{{name}}`, `{{username}}` y cualquier campo personalizado `{{email}}`… |
| Chat en vivo | Bandeja con el historial, respuesta manual y botón para pausar el bot en una conversación |
| Contactos, etiquetas y campos | Sí |
| Difusiones | Envía un flujo a los contactos (filtrables por etiqueta y canal) que te escribieron en las últimas 24 h |

## Requisitos

- **Node.js 22.13 o superior** (usa el SQLite integrado en Node; no hace falta instalar ninguna base de datos).
- Una **app de Meta** en <https://developers.facebook.com> (tipo *Business*).
- Un **túnel HTTPS** para que Meta llegue a tu ordenador: [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) o [ngrok](https://ngrok.com).

## Puesta en marcha

```bash
npm install
cp .env.example .env      # y rellénalo (ver abajo)
npm start                 # panel en http://localhost:3000
```

En otra terminal abre el túnel:

```bash
cloudflared tunnel --url http://localhost:3000
# o: ngrok http 3000
```

Tu URL de webhook será `https://<url-del-túnel>/webhook`.

> **Para probar sin Meta**: pon `DRY_RUN=true` en `.env`. El bot no envía nada a Meta y solo muestra en consola lo que enviaría.

### Seguridad

- El panel **solo se abre desde `localhost`**. A través del túnel solo es accesible `/webhook`. Si quieres abrir el panel desde otro sitio, define `ADMIN_PASSWORD` (usuario: cualquiera).
- Rellena `APP_SECRET`: así se verifica la firma `X-Hub-Signature-256` de cada webhook y nadie puede hacerse pasar por Meta.
- El archivo `.env` y la base de datos (`data/`) están en `.gitignore`. No los subas nunca.

## Conectar los canales

En tu app de Meta ve a **Webhooks**, pon como URL de devolución de llamada `https://<túnel>/webhook` y como token de verificación el mismo valor que `VERIFY_TOKEN`.

### Instagram (recomendado: «Instagram API with Instagram Login»)

1. Tu cuenta de Instagram debe ser **profesional** (empresa o creador).
2. En la app de Instagram: *Configuración → Mensajes y respuestas → Herramientas conectadas → Permitir acceso a los mensajes*.
3. En la app de Meta añade el producto **Instagram** → *Configuración de la API con inicio de sesión de Instagram*. Añade tu cuenta y genera el token.
4. Permisos: `instagram_business_basic`, `instagram_business_manage_messages`, `instagram_business_manage_comments`.
5. Suscribe los campos del webhook: `messages`, `messaging_postbacks`, `comments`.
6. En `.env`: `IG_ACCESS_TOKEN`, `IG_USER_ID` (el ID de tu cuenta profesional) y `IG_GRAPH_HOST=graph.instagram.com`. El *Instagram App Secret* añádelo a `APP_SECRET` separado por coma.

Si conectas Instagram a través de una Página de Facebook (Facebook Login), usa `IG_GRAPH_HOST=graph.facebook.com` y como `IG_ACCESS_TOKEN` el token de la Página.

### Facebook Messenger

1. Añade el producto **Messenger** y vincula tu Página. Genera el token de acceso de la Página.
2. Permisos: `pages_messaging`, `pages_manage_metadata`, `pages_read_engagement`, `pages_manage_engagement` y `pages_read_user_content` (para los comentarios).
3. Suscribe la Página a los campos: `messages`, `messaging_postbacks`, `feed`.
4. En `.env`: `PAGE_ID` y `PAGE_ACCESS_TOKEN`.

### WhatsApp (Cloud API)

1. Añade el producto **WhatsApp**. Meta te da un número de prueba y un token temporal (24 h); para algo duradero, crea un *usuario del sistema* en el Business Manager y genera un token permanente.
2. Suscribe el webhook al campo `messages`.
3. En `.env`: `WA_PHONE_NUMBER_ID` y `WA_ACCESS_TOKEN`.

## Cómo se usa

1. **Flujos** → crea los mensajes. Los botones apuntan a otro flujo (al pulsarlos se ejecuta ese flujo).
2. **Disparadores** → decide qué arranca cada flujo.
3. **Bandeja** → mira las conversaciones, contesta a mano o pausa el bot con «Tomar control».

Ejemplo típico de Instagram («comenta GUÍA y te la mando»):

- Flujo «Guía»: mensaje «¡Hola {{first_name}}! ¿Te la mando?» con botón «Sí, envíamela» → flujo «Enviar guía».
- Flujo «Enviar guía»: mensaje con el enlace + etiqueta `lead-guia`.
- Disparador «Comentario» con palabra `guia`, publicación (opcional) y respuestas públicas.

## Límites que impone Meta (y que este bot respeta)

- **Ventana de 24 h**: solo puedes escribir a alguien en las 24 h siguientes a su último mensaje. Las difusiones y el chat manual se limitan a esos contactos. (En WhatsApp, fuera de la ventana solo se permiten plantillas aprobadas, que este proyecto no gestiona.)
- **Respuesta privada a comentarios**: Meta permite **un solo** mensaje privado por comentario. Por eso el flujo se detiene tras el primer mensaje y continúa cuando la persona responde o pulsa un botón. Usa un botón en ese primer mensaje, igual que hace ManyChat.
- **Modo desarrollo**: mientras la app esté en modo desarrollo, Meta solo entrega webhooks de personas con un rol en la app (administradores o testers). Para responder a cualquier seguidor tendrás que pasar la app a modo *Live* y, normalmente, solicitar *Advanced Access* de los permisos en la revisión de apps.
- **Botones**: hasta 13 respuestas rápidas en Instagram y Messenger; hasta 3 en WhatsApp. Títulos de 20 caracteres como máximo.

## Desarrollo

```bash
npm test      # simula webhooks reales de Instagram y WhatsApp en modo DRY_RUN
npm run dev   # reinicia el servidor al guardar cambios
```

Estructura:

```
src/server.js   servidor Express: /webhook (público) y panel + /api (local)
src/webhook.js  verificación de firma y normalización de eventos de Meta
src/engine.js   contactos, disparadores, ejecución de flujos, esperas y difusiones
src/meta.js     llamadas a la Graph API (envío, respuestas a comentarios, perfiles)
src/api.js      API REST del panel
src/db.js       SQLite (data/bot.db)
public/         panel web
```

Las esperas se guardan en la base de datos y se ejecutan cada 2 s, así que sobreviven a un reinicio, pero solo corren mientras el ordenador y `npm start` estén encendidos.
