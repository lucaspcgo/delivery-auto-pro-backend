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

// Cria a tabela de tokens se ainda não existir (idempotente).
let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = pool.query(`
      CREATE TABLE IF NOT EXISTS ifood_auth (
        user_id            TEXT PRIMARY KEY,
        access_token       TEXT,
        refresh_token      TEXT,
        expires_at         TIMESTAMPTZ,
        pending_code       TEXT,
        pending_verifier   TEXT,
        pending_expires_at TIMESTAMPTZ,
        created_at         TIMESTAMPTZ DEFAULT now(),
        updated_at         TIMESTAMPTZ DEFAULT now()
      )
    `).catch(err => { schemaReady = null; throw err; });
  }
  return schemaReady;
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
    `INSERT INTO ifood_auth (user_id, pending_code, pending_verifier, pending_expires_at, updated_at)
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
    `SELECT pending_verifier, pending_expires_at FROM ifood_auth WHERE user_id = $1`,
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
  await pool.query(
    `UPDATE ifood_auth SET
       access_token = $2, refresh_token = $3, expires_at = $4,
       pending_code = NULL, pending_verifier = NULL, pending_expires_at = NULL,
       updated_at = now()
     WHERE user_id = $1`,
    [String(userId), data.accessToken, data.refreshToken, expiresAt]
  );

  return { accessToken: data.accessToken };
}

// Renova o access_token usando o refresh_token guardado.
async function refreshToken(userId, refresh) {
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
     WHERE user_id = $1`,
    [String(userId), data.accessToken, data.refreshToken || refresh, expiresAt]
  );
  return data.accessToken;
}

// Retorna um access_token válido para o usuário, renovando se necessário.
async function getAccessToken(userId) {
  await ensureSchema();
  const row = (await pool.query(
    `SELECT access_token, refresh_token, expires_at FROM ifood_auth WHERE user_id = $1`,
    [String(userId)]
  )).rows[0];

  if (!row || !row.refresh_token) {
    throw new Error('Loja iFood ainda não autorizada. Conecte a loja pelo fluxo de autorização.');
  }

  // Usa o token atual se ainda válido (margem de 60s)
  if (row.access_token && row.expires_at && new Date(row.expires_at).getTime() - 60000 > Date.now()) {
    return row.access_token;
  }
  return refreshToken(userId, row.refresh_token);
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
          return reject(new Error(`iFood ${method} ${path} -> HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
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

// ===== Ações de pedido usando o token da loja autorizada =====
async function getOrderDetails(userId, orderId) {
  const token = await getAccessToken(userId);
  return orderRequest(token, 'GET', `/order/v1.0/orders/${orderId}`, null);
}

async function confirmOrder(userId, orderId) {
  const token = await getAccessToken(userId);
  return orderRequest(token, 'POST', `/order/v1.0/orders/${orderId}/confirm`, null);
}

async function readyToPickup(userId, orderId) {
  const token = await getAccessToken(userId);
  return orderRequest(token, 'POST', `/order/v1.0/orders/${orderId}/readyToPickup`, null);
}

async function dispatchOrder(userId, orderId) {
  const token = await getAccessToken(userId);
  return orderRequest(token, 'POST', `/order/v1.0/orders/${orderId}/dispatch`, null);
}

async function cancelOrder(userId, orderId, reason) {
  const token = await getAccessToken(userId);
  return orderRequest(token, 'POST', `/order/v1.0/orders/${orderId}/requestCancellation`,
    { reason: reason || 'INTERNAL_DIFFICULTIES', cancellationCode: '501' });
}

// Indica se o usuário já tem uma autorização válida
async function isAuthorized(userId) {
  await ensureSchema();
  const row = (await pool.query(
    `SELECT refresh_token FROM ifood_auth WHERE user_id = $1`, [String(userId)]
  )).rows[0];
  return !!(row && row.refresh_token);
}

module.exports = {
  startAuthorization,
  completeAuthorization,
  getAccessToken,
  isAuthorized,
  getOrderDetails,
  confirmOrder,
  readyToPickup,
  dispatchOrder,
  cancelOrder
};
