const https = require('https');

const BASE_HOST = 'merchant-api.ifood.com.br';
const CLIENT_ID = process.env.IFOOD_CLIENT_ID;
const CLIENT_SECRET = process.env.IFOOD_CLIENT_SECRET;

let tokenCache = { token: null, expiresAt: 0 };

function apiRequest(method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const options = {
      hostname: BASE_HOST, path, method,
      headers: { 'Content-Type': 'application/json', ...headers }
    };
    if (payload && !headers?.['Content-Type']?.includes('urlencoded')) {
      options.headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, data: data }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function getValidToken() {
  const agora = Math.floor(Date.now() / 1000);
  if (tokenCache.token && tokenCache.expiresAt > agora + 300) {
    console.log('[ifood] usando token em cache');
    return tokenCache.token;
  }
  console.log('[ifood] buscando novo token...');
  const body = `grantType=client_credentials&clientId=${CLIENT_ID}&clientSecret=${CLIENT_SECRET}`;
  const res = await apiRequest('POST', '/authentication/v1.0/oauth/token', body, {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': Buffer.byteLength(body)
  });
  if (res.status !== 200) throw new Error(`[ifood] Erro auth: ${JSON.stringify(res.data)}`);
  tokenCache = {
    token: res.data.accessToken,
    expiresAt: agora + res.data.expiresIn
  };
  console.log(`[ifood] token obtido, expira em ${res.data.expiresIn}s`);
  return tokenCache.token;
}

async function getOrderDetails(orderId) {
  const token = await getValidToken();
  const res = await apiRequest('GET', `/order/v1.0/orders/${orderId}`, null, {
    'Authorization': `Bearer ${token}`
  });
  if (res.status !== 200) throw new Error(`[ifood] Erro ao buscar pedido: ${JSON.stringify(res.data)}`);
  return res.data;
}

async function confirmOrder(orderId) {
  const token = await getValidToken();
  const res = await apiRequest('POST', `/order/v1.0/orders/${orderId}/confirm`, null, {
    'Authorization': `Bearer ${token}`
  });
  if (res.status !== 202 && res.status !== 200) throw new Error(`[ifood] Erro ao confirmar: ${JSON.stringify(res.data)}`);
  return res.data;
}

async function cancelOrder(orderId, reason) {
  const token = await getValidToken();
  const res = await apiRequest('POST', `/order/v1.0/orders/${orderId}/requestCancellation`,
    { reason: reason || 'INTERNAL_DIFFICULTIES', cancelCodeId: 'INTERNAL' },
    { 'Authorization': `Bearer ${token}` }
  );
  if (res.status !== 202 && res.status !== 200) throw new Error(`[ifood] Erro ao cancelar: ${JSON.stringify(res.data)}`);
  return res.data;
}

async function dispatchOrder(orderId) {
  const token = await getValidToken();
  const res = await apiRequest('POST', `/order/v1.0/orders/${orderId}/dispatch`, null, {
    'Authorization': `Bearer ${token}`
  });
  return res.data;
}

module.exports = { getValidToken, getOrderDetails, confirmOrder, cancelOrder, dispatchOrder };
