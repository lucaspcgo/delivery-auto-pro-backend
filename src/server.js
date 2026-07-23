require('dotenv').config();
require('./config/env'); // valida JWT_SECRET na inicialização (falha rápido se ausente)
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const pool = require('./db/postgres');
const redis = require('./db/redis');
const integrationsRouter = require('./routes/integrations');
const webhooks99foodRouter = require('./routes/webhooks99food');
const webhooksifoodRouter = require('./routes/webhooksifood');
const dashboardRouter = require('./routes/dashboard');
const authRouter = require('./routes/auth');
const automationsRouter = require('./routes/automations');
const restaurantsRouter = require('./routes/restaurants');
const reportsRouter = require('./routes/reports');
const settingsRouter = require('./routes/settings');
const adminRouter = require('./routes/admin');
const checkoutRouter = require('./routes/checkout');
const plansRouter = require('./routes/plans');
const usageRouter = require('./routes/usage');
const menuAdminRouter = require('./routes/menuadmin');

const app = express();
const PORT = process.env.PORT || 3001;

// Atrás do proxy do EasyPanel: necessário para o rate limit identificar o IP real
app.set('trust proxy', 1);

// Headers de segurança (CSP, X-Frame-Options, etc.)
app.use(helmet());

// CORS configurável: se ALLOWED_ORIGINS estiver definido (lista separada por vírgula),
// restringe às origens permitidas; caso contrário, mantém o comportamento aberto atual.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(o => o.trim()).filter(Boolean);
app.use(cors(allowedOrigins.length > 0
  ? {
      origin(origin, cb) {
        // Permite requests sem Origin (curl, health checks) e origens na allowlist
        if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
        return cb(new Error('Origem não permitida pelo CORS'));
      },
      credentials: true
    }
  : undefined));

// Limita o tamanho do corpo para mitigar abuso/DoS
// Guarda o corpo cru (texto) para poder extrair IDs de 64 bits sem perder precisão
// (JSON.parse arredonda inteiros grandes como o order_id do 99Food).
app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));
app.use(express.static('public'));

// Rate limit global (proteção básica contra abuso). Teto alto porque o KDS
// fica atualizando os pedidos com frequência — limite baixo deixava a tela sem dados.
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições. Tente novamente em alguns minutos.' }
}));

// Rate limit estrito para autenticação (anti brute-force em login/registro/checkout)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' }
});

app.get('/health', async (req, res) => {
  let dbStatus = 'erro';
  let redisStatus = 'erro';
  try { 
    await pool.query('SELECT 1'); 
    dbStatus = 'ok'; 
  } catch (err) { 
    console.error('[health] postgres:', err.message); 
  }
  try { 
    await redis.ping(); 
    redisStatus = 'ok'; 
  } catch (err) { 
    console.error('[health] redis:', err.message); 
  }
  res.json({ status: 'ok', postgres: dbStatus, redis: redisStatus, timestamp: new Date().toISOString() });
});

app.use('/api/v1/auth', authLimiter, authRouter);
app.use('/api/v1/webhooks/99food', webhooks99foodRouter);
app.use('/api/v1/webhooks/ifood', webhooksifoodRouter);
app.use('/api/v1/integrations', integrationsRouter);
app.use('/api/v1/orders/99food', webhooks99foodRouter);
app.use('/api/v1/orders/ifood', webhooksifoodRouter);
app.use('/api/v1/dashboard', dashboardRouter);
app.use('/api/v1/automations', automationsRouter);
app.use('/api/v1/restaurants', restaurantsRouter);
app.use('/api/v1/tools', require('./routes/tools'));
app.use('/api/v1/reports', reportsRouter);
app.use('/api/v1/settings', settingsRouter);
app.use('/api/v1/admin', adminRouter);
app.use('/api/v1/admin/menu', menuAdminRouter);
app.use('/api/v1/checkout', authLimiter, checkoutRouter);
app.use('/api/v1/webhooks/cora', require('./routes/webhookscora'));
app.use('/api/v1/plans', plansRouter);
app.use('/api/v1/usage', usageRouter);

app.use((req, res) => { res.status(404).json({ error: 'Rota não encontrada' }); });

app.listen(PORT, () => {
  console.log(`Delivery Auto Pro backend rodando na porta ${PORT}`);
  // Inicia o polling de pedidos do iFood (modelo distribuído, sem webhook)
  try {
    require('./services/ifood-poller').startPolling();
  } catch (err) {
    console.error('[server] falha ao iniciar polling do iFood:', err.message);
  }
  // Atualiza o cache do cardápio 99Food periodicamente (fotos frescas no KDS)
  try {
    require('./services/menu-cache-refresher').startMenuCacheRefresh();
  } catch (err) {
    console.error('[server] falha ao iniciar atualização de cardápio:', err.message);
  }
  // Sincroniza o status dos pedidos 99Food com a plataforma (tira concluídos do KDS)
  try {
    require('./services/orderStatusPoller').startOrderStatusPolling();
  } catch (err) {
    console.error('[server] falha ao iniciar sincronização de status:', err.message);
  }
  // Garante schema de plans com capabilities e limites
  try {
    require('./db/planSchema').ensurePlanSchema()
      .then(() => console.log('[planSchema] pronto'))
      .catch(err => console.error('[planSchema] erro:', err.message));
  } catch (err) {
    console.error('[server] falha ao iniciar schema de plans:', err.message);
  }
});
