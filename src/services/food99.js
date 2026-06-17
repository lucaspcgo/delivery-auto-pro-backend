const https = require('https');

const BASE_URL = 'openapi.didi-food.com';
const APP_ID = process.env.FOOD99_APP_ID;
const APP_SECRET = process.env.FOOD99_APP_SECRET;

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

async function cancelOrder(authToken, orderId, cancelCode = 1040) {
  const result = await apiPost('/v1/order/order/cancel', { auth_token: authToken, order_id: orderId, cancel_info: { cancel_code: cancelCode } });
  if (result.errno !== 0) throw new Error(`[99food] Erro ao cancelar pedido: ${JSON.stringify(result)}`);
  return result.data;
}

module.exports = { refreshToken, getToken, getValidToken, getOrderDetail, confirmOrder, cancelOrder };
