try {
  process.loadEnvFile();
} catch {
  // Sin archivo .env: se usan las variables de entorno existentes.
}

const env = process.env;
const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

export const config = {
  port: Number(env.PORT || 3000),
  dbPath: env.DB_PATH || './data/bot.db',
  graphVersion: env.GRAPH_VERSION || 'v23.0',
  verifyToken: env.VERIFY_TOKEN || '',
  appSecrets: list(env.APP_SECRET),
  adminPassword: env.ADMIN_PASSWORD || '',
  dryRun: env.DRY_RUN === 'true',
  messenger: {
    pageId: env.PAGE_ID || '',
    token: env.PAGE_ACCESS_TOKEN || '',
  },
  instagram: {
    userId: env.IG_USER_ID || '',
    token: env.IG_ACCESS_TOKEN || '',
    host: env.IG_GRAPH_HOST || 'graph.instagram.com',
  },
  whatsapp: {
    phoneNumberId: env.WA_PHONE_NUMBER_ID || '',
    token: env.WA_ACCESS_TOKEN || '',
  },
};

export function channelStatus() {
  return {
    messenger: Boolean(config.messenger.pageId && config.messenger.token),
    instagram: Boolean(config.instagram.token),
    whatsapp: Boolean(config.whatsapp.phoneNumberId && config.whatsapp.token),
  };
}
