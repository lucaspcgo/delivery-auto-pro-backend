// Fluxo de autorização DISTRIBUÍDA do iFood (para integrar lojas de terceiros).
// Diferente do modelo centralizado (client_credentials), aqui cada dono de loja
// autoriza o app digitando um código no portal do iFood. Recebemos um
// refresh_token por autorização, que guardamos no banco e usamos para renovar
// o access_token automaticamente.

const https = require('https');
const querystring = require('querystring');
const pool = require('../db/postgres');

const IFOOD_HOST = 'merchant-api.ifood.com.br';

function clientId() { return process.env.IFOOD_CLIENT_ID; }
function clientSecret() { return process.env.IFOOD_CLIENT_SECRET; }

// Request HTTPS com checagem de status e parse de JSON
function request({ path, method = 'POST', body = null, token = null }) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (body) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const req = https.request({ hostname: IFOOD_HOST, path, method, headers }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`iFood ${method} ${path} -> HTTP ${res.statusCode}: ${data.slice(0, 400)}`));
        }
        if (!data) return resolve(null);
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Falha ao parsear resposta iFood (${path}): ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Cria/migra o schema de autorização do iFood (idempotente).
//
// MULTI-CONTA: antes era UMA autorização por usuário (ifood_auth.user_id era
// PRIMARY KEY). Agora um usuário pode ter VÁRIAS autorizações (contas iFood
// diferentes), cada uma com seu próprio refresh_token. A tabela passa a ter
// `id` como PK; cada loja (restaurant_platforms) aponta para o acesso dono do
// seu token via `ifood_auth_id`. O código "pendente" (fluxo de autorização em
// andamento) vai para uma tabela separada, 1 por usuário.
let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = migrate().catch(err => { schemaReady = null; throw err; });
  }
  return schemaReady;
}

async function migrate() {
  // Tabela de "pendências" de autorização (código/verifier em andamento).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ifood_auth_pending (
      user_id            TEXT PRIMARY KEY,
      pending_code       TEXT,
      pending_verifier   TEXT,
      pending_expires_at TIMESTAMPTZ,
      updated_at         TIMESTAMPTZ DEFAULT now()
    )
  `);

  // Cria (instalações novas) ou migra (instalações antigas com user_id PK) a
  // tabela ifood_auth para o modelo multi-conta com id como PK.
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'ifood_auth') THEN
        CREATE TABLE ifood_auth (
          id            BIGSERIAL PRIMARY KEY,
          user_id       TEXT NOT NULL,
          access_token  TEXT,
          refresh_token TEXT,
          expires_at    TIMESTAMPTZ,
          created_at    TIMESTAMPTZ DEFAULT now(),
          updated_at    TIMESTAMPTZ DEFAULT now()
        );
      ELSIF NOT EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_name = 'ifood_auth' AND column_name = 'id') THEN
        -- Preserva pendências antigas
        INSERT INTO ifood_auth_pending (user_id, pending_code, pending_verifier, pending_expires_at)
          SELECT user_id, pending_code, pending_verifier, pending_expires_at
          FROM ifood_auth WHERE pending_verifier IS NOT NULL
          ON CONFLICT (user_id) DO NOTHING;
        -- Troca a PK de user_id para id (mantém as linhas/tokens existentes)
        ALTER TABLE ifood_auth DROP CONSTRAINT IF EXISTS ifood_auth_pkey;
        ALTER TABLE ifood_auth ADD COLUMN id BIGSERIAL PRIMARY KEY;
        ALTER TABLE ifood_auth DROP COLUMN IF EXISTS pending_code;
        ALTER TABLE ifood_auth DROP COLUMN IF EXISTS pending_verifier;
        ALTER TABLE ifood_auth DROP COLUMN IF EXISTS pending_expires_at;
      END IF;
    END $$;
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ifood_auth_user ON ifood_auth(user_id)`);
  await pool.query(`ALTER TABLE restaurant_platforms ADD COLUMN IF NOT EXISTS ifood_auth_id BIGINT`);

  // Liga lojas iFood já existentes ao acesso (único) do usuário migrado.
  // rp.user_id é UUID e ifood_auth.user_id é TEXT — cast p/ comparar.
  await pool.query(`
    UPDATE restaurant_platforms rp SET ifood_auth_id = a.id
    FROM ifood_auth a
    WHERE rp.platform = 'ifood' AND rp.ifood_auth_id IS NULL AND a.user_id = rp.user_id::text
  `);
}

// Passo 1: gera o código que o dono da loja vai digitar no portal do iFood.
async function startAuthorization(userId) {
  await ensureSchema();
  if (!clientId() || !clientSecret()) {
    throw new Error('IFOOD_CLIENT_ID/IFOOD_CLIENT_SECRET não configurados (use as credenciais do app DISTRIBUÍDO).');
  }

  const body = querystring.stringify({ clientId: clientId() });
  const data = await request({ path: '/authentication/v1.0/oauth/userCode', body });
  // data: { userCode, authorizationCodeVerifier, verificationUrl, verificationUrlComplete, expiresIn }

  const expiresAt = new Date(Date.now() + (data.expiresIn || 600) * 1000);
  await pool.query(
    `INSERT INTO ifood_auth_pending (user_id, pending_code, pending_verifier, pending_expires_at, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (user_id) DO UPDATE SET
       pending_code = EXCLUDED.pending_code,
       pending_verifier = EXCLUDED.pending_verifier,
       pending_expires_at = EXCLUDED.pending_expires_at,
       updated_at = now()`,
    [String(userId), data.userCode, data.authorizationCodeVerifier, expiresAt]
  );

  return {
    userCode: data.userCode,
    verificationUrl: data.verificationUrl,
    verificationUrlComplete: data.verificationUrlComplete,
    expiresIn: data.expiresIn || 600
  };
}

// Passo 2: troca o código autorizado por access_token + refresh_token.
// O `authorizationCode` é o código que o PORTAL do iFood devolve depois que o
// dono da loja cola o código de ativação lá — o usuário copia e cola de volta.
async function completeAuthorization(userId, authorizationCode) {
  await ensureSchema();
  if (!authorizationCode) {
    throw new Error('Código de autorização não informado (copie o código que o portal do iFood devolveu).');
  }
  const row = (await pool.query(
    `SELECT pending_verifier, pending_expires_at FROM ifood_auth_pending WHERE user_id = $1`,
    [String(userId)]
  )).rows[0];

  if (!row || !row.pending_verifier) {
    throw new Error('Nenhuma autorização pendente. Gere um novo código de ativação primeiro.');
  }
  if (row.pending_expires_at && new Date(row.pending_expires_at) < new Date()) {
    throw new Error('O código de ativação expirou. Gere um novo.');
  }

  const body = querystring.stringify({
    grantType: 'authorization_code',
    clientId: clientId(),
    clientSecret: clientSecret(),
    authorizationCode: authorizationCode.trim(),
    authorizationCodeVerifier: row.pending_verifier
  });

  // Se o dono ainda não autorizou no portal, o iFood retorna erro aqui.
  const data = await request({ path: '/authentication/v1.0/oauth/token', body });
  // data: { accessToken, refreshToken, expiresIn, type }

  const expiresAt = new Date(Date.now() + (data.expiresIn || 3600) * 1000);
  // MULTI-CONTA: cada autorização vira uma NOVA linha (um novo acesso/token).
  // Lojas duplicadas de uma re-autorização da MESMA conta são reconciliadas
  // depois, ao vincular os merchants (ver /ifood/authorize/complete).
  const inserted = await pool.query(
    `INSERT INTO ifood_auth (user_id, access_token, refresh_token, expires_at, updated_at)
     VALUES ($1, $2, $3, $4, now()) RETURNING id`,
    [String(userId), data.accessToken, data.refreshToken, expiresAt]
  );
  await pool.query(`DELETE FROM ifood_auth_pending WHERE user_id = $1`, [String(userId)]);

  return { accessToken: data.accessToken, authId: inserted.rows[0].id };
}

// Renova o access_token de UMA autorização (por id) usando seu refresh_token.
async function refreshToken(authId, refresh) {
  const body = querystring.stringify({
    grantType: 'refresh_token',
    clientId: clientId(),
    clientSecret: clientSecret(),
    refreshToken: refresh
  });
  const data = await request({ path: '/authentication/v1.0/oauth/token', body });
  const expiresAt = new Date(Date.now() + (data.expiresIn || 3600) * 1000);
  await pool.query(
    `UPDATE ifood_auth SET access_token = $2, refresh_token = $3, expires_at = $4, updated_at = now()
     WHERE id = $1`,
    [authId, data.accessToken, data.refreshToken || refresh, expiresAt]
  );
  return data.accessToken;
}

// Dado uma linha de acesso, devolve um token válido (renovando se necessário).
async function tokenFromRow(row) {
  if (!row || !row.refresh_token) {
    throw new Error('Loja iFood ainda não autorizada. Conecte a loja pelo fluxo de autorização.');
  }
  if (row.access_token && row.expires_at && new Date(row.expires_at).getTime() - 60000 > Date.now()) {
    return row.access_token;
  }
  return refreshToken(row.id, row.refresh_token);
}

// Token válido de uma autorização específica (por id).
async function getAccessTokenByAuthId(authId) {
  await ensureSchema();
  const row = (await pool.query(
    `SELECT id, access_token, refresh_token, expires_at FROM ifood_auth WHERE id = $1`,
    [authId]
  )).rows[0];
  return tokenFromRow(row);
}

// Token válido da loja (merchant): usa o acesso vinculado à loja. Se a loja
// ainda não tiver vínculo (ifood_auth_id nulo — legado), cai para o acesso mais
// recente do usuário dono da loja.
async function getAccessTokenByMerchant(merchantId) {
  await ensureSchema();
  let row = (await pool.query(
    `SELECT a.id, a.access_token, a.refresh_token, a.expires_at
     FROM restaurant_platforms rp
     JOIN ifood_auth a ON a.id = rp.ifood_auth_id
     WHERE rp.platform = 'ifood' AND rp.platform_merchant_id = $1
     LIMIT 1`,
    [String(merchantId)]
  )).rows[0];
  if (!row) {
    row = (await pool.query(
      `SELECT a.id, a.access_token, a.refresh_token, a.expires_at
       FROM restaurant_platforms rp
       JOIN ifood_auth a ON a.user_id = rp.user_id::text
       WHERE rp.platform = 'ifood' AND rp.platform_merchant_id = $1
       ORDER BY a.updated_at DESC LIMIT 1`,
      [String(merchantId)]
    )).rows[0];
  }
  if (!row) {
    throw new Error(`Loja iFood ${merchantId} sem acesso autorizado. Reconecte a loja.`);
  }
  return tokenFromRow(row);
}

// Compatibilidade: token válido do usuário (acesso mais recente). Usado como
// fallback quando não há merchant em contexto.
async function getAccessToken(userId) {
  await ensureSchema();
  const row = (await pool.query(
    `SELECT id, access_token, refresh_token, expires_at FROM ifood_auth
     WHERE user_id = $1 AND refresh_token IS NOT NULL
     ORDER BY updated_at DESC LIMIT 1`,
    [String(userId)]
  )).rows[0];
  return tokenFromRow(row);
}

// Request autenticado para as APIs de pedido (JSON + Bearer). Aceita 200/202.
function orderRequest(token, method, path, jsonBody) {
  return new Promise((resolve, reject) => {
    const payload = jsonBody ? JSON.stringify(jsonBody) : null;
    const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);

    const req = https.request({ hostname: IFOOD_HOST, path, method, headers }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`iFood ${method} ${path} -> HTTP ${res.statusCode}: ${data.slice(0, 300)}`);
          err.statusCode = res.statusCode;         // p/ o tratamento de erros (401/403/409/429/5xx)
          err.retryAfter = res.headers['retry-after'] || null;
          try { err.body = data ? JSON.parse(data) : null; } catch (e) { err.body = data || null; }
          return reject(err);
        }
        try { resolve(data ? JSON.parse(data) : null); }
        catch (e) { resolve(data); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ===== Ações de pedido usando o token da LOJA (merchantId) autorizada =====
// merchantId identifica a loja e, por consequência, qual acesso/token usar
// (multi-conta). Assim cada pedido é aceito/confirmado com o token certo.
async function getOrderDetails(merchantId, orderId) {
  const token = await getAccessTokenByMerchant(merchantId);
  return orderRequest(token, 'GET', `/order/v1.0/orders/${orderId}`, null);
}

async function confirmOrder(merchantId, orderId) {
  const token = await getAccessTokenByMerchant(merchantId);
  return orderRequest(token, 'POST', `/order/v1.0/orders/${orderId}/confirm`, null);
}

async function readyToPickup(merchantId, orderId) {
  const token = await getAccessTokenByMerchant(merchantId);
  return orderRequest(token, 'POST', `/order/v1.0/orders/${orderId}/readyToPickup`, null);
}

async function dispatchOrder(merchantId, orderId) {
  const token = await getAccessTokenByMerchant(merchantId);
  return orderRequest(token, 'POST', `/order/v1.0/orders/${orderId}/dispatch`, null);
}

async function cancelOrder(merchantId, orderId, reason) {
  const token = await getAccessTokenByMerchant(merchantId);
  // O iFood NÃO aceita um código fixo: cada pedido tem sua própria lista de
  // motivos válidos (dependem do momento/estado do pedido). Buscamos os motivos
  // permitidos e usamos um deles; senão o cancelamento é rejeitado (foi o que
  // reprovou na homologação). Se por acaso não vier lista, tenta o 501 (padrão).
  let cancellationCode = '501';
  let cancelReason = reason || 'PROBLEMAS_SISTEMA';
  try {
    const reasons = await orderRequest(token, 'GET',
      `/order/v1.0/orders/${orderId}/cancellationReasons`, null);
    if (Array.isArray(reasons) && reasons.length > 0) {
      // Prefere um motivo do lado do restaurante; senão, o primeiro válido.
      const chosen = reasons.find(r => String(r.cancelCodeId) === '501') || reasons[0];
      cancellationCode = String(chosen.cancelCodeId);
      cancelReason = chosen.description || cancelReason;
    }
  } catch (e) {
    console.warn(`[ifood cancel] não consegui buscar motivos válidos do pedido ${orderId} (usando ${cancellationCode}): ${e.message}`);
  }
  return orderRequest(token, 'POST', `/order/v1.0/orders/${orderId}/requestCancellation`,
    { reason: cancelReason, cancellationCode });
}

// Indica se o usuário já tem ao menos uma autorização válida
async function isAuthorized(userId) {
  await ensureSchema();
  const row = (await pool.query(
    `SELECT 1 FROM ifood_auth WHERE user_id = $1 AND refresh_token IS NOT NULL LIMIT 1`,
    [String(userId)]
  )).rows[0];
  return !!row;
}

// Lista TODAS as autorizações válidas (para o polling — cada conta iFood tem
// sua própria fila de eventos, então o poller consulta uma por uma).
async function listAuthorizations() {
  await ensureSchema();
  const rows = (await pool.query(
    `SELECT id, user_id FROM ifood_auth WHERE refresh_token IS NOT NULL`
  )).rows;
  return rows;
}

// Quantidade de acessos (contas) iFood de um usuário.
async function countAuthorizations(userId) {
  await ensureSchema();
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM ifood_auth WHERE user_id = $1 AND refresh_token IS NOT NULL`,
    [String(userId)]
  );
  return r.rows[0].n;
}

// Remove acessos "órfãos" do usuário (sem nenhuma loja vinculada), exceto o
// acesso recém-criado (keepAuthId). Usado após vincular merchants para
// reconciliar re-autorização da MESMA conta (as lojas migram para o acesso
// novo e o antigo fica órfão).
async function pruneOrphanAuths(userId, keepAuthId) {
  await ensureSchema();
  await pool.query(
    `DELETE FROM ifood_auth a
     WHERE a.user_id = $1 AND a.id <> $2
       AND NOT EXISTS (
         SELECT 1 FROM restaurant_platforms rp
         WHERE rp.platform = 'ifood' AND rp.ifood_auth_id = a.id
       )`,
    [String(userId), keepAuthId]
  );
}

// Busca eventos de pedido pendentes (polling). Retorna [] se não houver (HTTP 204).
async function pollEvents(token) {
  const data = await orderRequest(token, 'GET', '/events/v1.0/events:polling', null);
  return Array.isArray(data) ? data : [];
}

// Confirma o recebimento dos eventos para o iFood não reenviar
async function acknowledgeEvents(token, eventIds) {
  if (!eventIds || eventIds.length === 0) return;
  await orderRequest(token, 'POST', '/events/v1.0/events/acknowledgment',
    eventIds.map(id => ({ id })));
}

// ===== Módulo MERCHANT (homologação) ========================================
// Todas as ações usam o token da LOJA (modelo distribuído). Cada função é um
// endpoint exigido no checklist de homologação do módulo Merchant.

// Retry com backoff exponencial APENAS em erros 5xx (idempotente/seguro).
// Exigência da homologação: "Implemente retry com backoff exponencial p/ 5xx".
async function withRetry(fn, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      if (!(e.statusCode >= 500 && e.statusCode < 600)) throw e; // só 5xx tenta de novo
      if (i < tries - 1) await new Promise(r => setTimeout(r, 500 * Math.pow(2, i))); // 0.5s, 1s, 2s
    }
  }
  throw lastErr;
}

// GET status da loja (OK/WARNING/CLOSED/ERROR + validações is-connected, opening-hours...)
async function getMerchantStatus(merchantId) {
  const token = await getAccessTokenByMerchant(merchantId);
  return withRetry(() => orderRequest(token, 'GET', `/merchant/v1.0/merchants/${merchantId}/status`, null));
}

// GET interrupções (pausas) ativas — array (pode vir vazio)
async function getInterruptions(merchantId) {
  const token = await getAccessTokenByMerchant(merchantId);
  return withRetry(() => orderRequest(token, 'GET', `/merchant/v1.0/merchants/${merchantId}/interruptions`, null));
}

// POST cria uma pausa (interrupção). start/end em ISO 8601. Retorna 201 com id.
async function createInterruption(merchantId, { description, start, end }) {
  const token = await getAccessTokenByMerchant(merchantId);
  return orderRequest(token, 'POST', `/merchant/v1.0/merchants/${merchantId}/interruptions`,
    { description: description || 'Pausa', start, end });
}

// DELETE remove uma pausa pelo id. Retorna 204 (sem conteúdo).
async function deleteInterruption(merchantId, interruptionId) {
  const token = await getAccessTokenByMerchant(merchantId);
  return orderRequest(token, 'DELETE', `/merchant/v1.0/merchants/${merchantId}/interruptions/${interruptionId}`, null);
}

// GET horários de funcionamento — array de turnos (dayOfWeek, start, duration).
async function getOpeningHours(merchantId) {
  const token = await getAccessTokenByMerchant(merchantId);
  return withRetry(() => orderRequest(token, 'GET', `/merchant/v1.0/merchants/${merchantId}/opening-hours`, null));
}

// PUT atualiza os horários de funcionamento. shifts = array de turnos. Retorna 201.
async function updateOpeningHours(merchantId, shifts) {
  const token = await getAccessTokenByMerchant(merchantId);
  return orderRequest(token, 'PUT', `/merchant/v1.0/merchants/${merchantId}/opening-hours`,
    { shifts: Array.isArray(shifts) ? shifts : [] });
}

module.exports = {
  startAuthorization,
  completeAuthorization,
  getAccessToken,
  getAccessTokenByAuthId,
  getAccessTokenByMerchant,
  isAuthorized,
  listAuthorizations,
  countAuthorizations,
  pruneOrphanAuths,
  pollEvents,
  acknowledgeEvents,
  getOrderDetails,
  confirmOrder,
  readyToPickup,
  dispatchOrder,
  cancelOrder,
  // Módulo Merchant (homologação)
  getMerchantStatus,
  getInterruptions,
  createInterruption,
  deleteInterruption,
  getOpeningHours,
  updateOpeningHours
};
