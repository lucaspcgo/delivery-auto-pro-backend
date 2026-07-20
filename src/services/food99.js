const https = require('https');
const crypto = require('crypto');

const BASE_URL = 'openapi.didi-food.com';
const APP_ID = process.env.FOOD99_APP_ID;
const APP_SECRET = process.env.FOOD99_APP_SECRET;

// Gera a assinatura MD5 do 99Food: ordena as chaves, formata chave=valor
// (arrays viram "Array"), junta com & e acrescenta o app_secret no fim.
function generateSign(params) {
  const toSign = Object.keys(params).sort()
    .map(k => `${k}=${params[k]}`).join('&') + APP_SECRET;
  return crypto.createHash('md5').update(toSign).digest('hex');
}

// POST JSON cru para openapi.99food.com (preserva IDs grandes de 64 bits)
function postRaw99(path, rawBody) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'openapi.99food.com', path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(rawBody) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Resposta inválida: ' + data)); } });
    });
    req.on('error', reject);
    req.write(rawBody); req.end();
  });
}

// Gera o LINK DE AUTORIZAÇÃO (página de vínculo self-service) do 99Food.
// POST /v1/auth/authorizationpage/getUrl -> data.url (válido por 7 dias).
// O lojista abre esse link, loga na conta 99 dele e autoriza nosso app.
// Assim não é preciso copiar link manualmente do painel — é sempre fresco.
async function getAuthorizationUrl() {
  const ts = Math.floor(Date.now() / 1000);
  const sign = generateSign({ app_id: String(APP_ID), timestamp: String(ts) });
  const rawBody = `{"app_id":${APP_ID},"timestamp":${ts},"sign":"${sign}"}`;
  const result = await postRaw99('/v1/auth/authorizationpage/getUrl', rawBody);
  if (result.errno !== 0) throw new Error(`[99food] Erro ao gerar link de autorização: ${JSON.stringify(result)}`);
  if (!result.data || !result.data.url) throw new Error(`[99food] resposta sem url: ${JSON.stringify(result)}`);
  return result.data.url;
}

// Vincula (bind) uma loja do 99Food ao app. shopId = ID no 99Food (int);
// appShopId = ID no nosso sistema (usamos o mesmo, único por loja).
async function bindStore(shopId, appShopId) {
  if (!/^\d+$/.test(String(shopId))) throw new Error('shop_id inválido (apenas números)');
  const ts = Math.floor(Date.now() / 1000);
  const sign = generateSign({ app_id: String(APP_ID), timestamp: String(ts), shop_infos: 'Array' });
  const rawBody = `{"app_id":${APP_ID},"timestamp":${ts},"sign":"${sign}","shop_infos":[{"shop_id":${shopId},"app_shop_id":"${appShopId}"}]}`;
  const result = await postRaw99('/v3/auth/authorization/shopBind', rawBody);
  if (result.errno !== 0) throw new Error(`[99food] Erro ao vincular loja: ${JSON.stringify(result)}`);
  return result.data;
}

// Cache de tokens em memória
const tokenCache = {};

function apiGet(path) {
  return new Promise((resolve, reject) => {
    const options = { hostname: BASE_URL, path, method: 'GET', headers: { 'Content-Type': 'application/json' } };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Resposta inválida: ' + data)); } });
    });
    req.on('error', reject);
    req.end();
  });
}

function apiPost(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = { hostname: BASE_URL, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Resposta inválida: ' + data)); } });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function refreshToken(appShopId) {
  const path = `/v1/auth/authtoken/refresh?app_id=${APP_ID}&app_secret=${APP_SECRET}&app_shop_id=${encodeURIComponent(appShopId)}`;
  const result = await apiGet(path);
  if (result.errno !== 0) throw new Error(`[99food] Erro ao renovar token: ${JSON.stringify(result)}`);
  return result;
}

async function getToken(appShopId) {
  const path = `/v1/auth/authtoken/get?app_id=${APP_ID}&app_secret=${APP_SECRET}&app_shop_id=${encodeURIComponent(appShopId)}`;
  const result = await apiGet(path);
  if (result.errno !== 0) throw new Error(`[99food] Erro ao buscar token: ${JSON.stringify(result)}`);
  return result.data;
}

// Retorna token válido, renovando automaticamente se necessário
async function getValidToken(appShopId) {
  const cached = tokenCache[appShopId];
  const agora = Math.floor(Date.now() / 1000);

  // Se tem token com mais de 5 minutos de validade, usa o cache
  if (cached && cached.expiration > agora + 300) {
    console.log(`[99food] usando token em cache para ${appShopId}`);
    return cached.token;
  }

  // Renova o token
  console.log(`[99food] renovando token para ${appShopId}...`);
  await refreshToken(appShopId);
  const data = await getToken(appShopId);

  // Salva no cache
  tokenCache[appShopId] = {
    token: data.auth_token,
    expiration: data.token_expiration_time,
  };

  console.log(`[99food] token renovado, expira em ${new Date(data.token_expiration_time * 1000).toISOString()}`);
  return data.auth_token;
}

async function getOrderDetail(authToken, orderId) {
  const path = `/v1/order/order/detail?auth_token=${encodeURIComponent(authToken)}&order_id=${orderId}`;
  const result = await apiGet(path);
  if (result.errno !== 0) throw new Error(`[99food] Erro ao buscar pedido: ${JSON.stringify(result)}`);
  return result.data;
}

async function confirmOrder(authToken, orderId) {
  const result = await apiPost('/v1/order/order/confirm', { auth_token: authToken, order_id: orderId });
  if (result.errno !== 0) throw new Error(`[99food] Erro ao confirmar pedido: ${JSON.stringify(result)}`);
  return result.data;
}

async function readyOrder(authToken, orderId) {
  const result = await apiPost('/v1/order/order/ready', { auth_token: authToken, order_id: orderId });
  if (result.errno !== 0) throw new Error(`[99food] Erro ao marcar pronto: ${JSON.stringify(result)}`);
  return result.data;
}

async function cancelOrder(authToken, orderId, cancelCode = 1040) {
  const result = await apiPost('/v1/order/order/cancel', { auth_token: authToken, order_id: orderId, cancel_info: { cancel_code: cancelCode } });
  if (result.errno !== 0) throw new Error(`[99food] Erro ao cancelar pedido: ${JSON.stringify(result)}`);
  return result.data;
}

// Confirma o recebimento do pagamento EM DINHEIRO adiantado pelo entregador da 99Food.
// Só vale quando: entrega é da plataforma (não do lojista), status=200 (aceito) e
// pagamento em dinheiro. Host: openapi.99food.com. order_id é long (64 bits) → mando cru.
async function payConfirm(authToken, orderId) {
  if (!/^\d+$/.test(String(orderId))) throw new Error('order_id inválido (apenas números)');
  const rawBody = `{"auth_token":${JSON.stringify(String(authToken))},"order_id":${orderId}}`;
  const result = await postRaw99('/v1/order/order/payConfirm', rawBody);
  if (result.errno !== 0) throw new Error(`[99food] Erro ao confirmar pagamento em dinheiro: ${JSON.stringify(result)}`);
  return result.data;
}

// Detalhes da loja (nome, logo, endereço, etc.). Host: openapi.99food.com
// GET /v1/shop/shop/detail?auth_token=...  → data.name = nome da loja
function getStoreDetail(authToken) {
  const path = `/v1/shop/shop/detail?auth_token=${encodeURIComponent(authToken)}`;
  return new Promise((resolve, reject) => {
    https.get({ hostname: 'openapi.99food.com', path }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data); // só usamos `name` (string), sem risco de int 64-bit
          if (parsed.errno !== 0) return reject(new Error(`[99food] detalhe da loja: ${parsed.errmsg} (errno ${parsed.errno})`));
          resolve(parsed.data || {});
        } catch (e) { reject(new Error('resposta inválida (detalhe da loja): ' + data.slice(0, 200))); }
      });
    }).on('error', (err) => reject(new Error('falha de rede (detalhe da loja): ' + err.message)));
  });
}

module.exports = { refreshToken, getToken, getValidToken, getOrderDetail, confirmOrder, readyOrder, cancelOrder, payConfirm, bindStore, getStoreDetail, getAuthorizationUrl };
