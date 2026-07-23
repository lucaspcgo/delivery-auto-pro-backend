// Integração com o banco Cora (Integração Direta / mTLS) para cobrança do SaaS.
// Autentica com certificado (client cert) + client_id, cria cobrança Pix+boleto
// e consulta status. Credenciais via env (ver README/EasyPanel):
//   CORA_CLIENT_ID  — client-id da credencial
//   CORA_CERT       — conteúdo do certificado (.pem) OU base64 dele
//   CORA_KEY        — conteúdo da chave privada (.key) OU base64 dela
//   CORA_ENV        — 'stage' (teste, padrão) ou 'production'
const https = require('https');

function baseHost() {
  return (process.env.CORA_ENV || 'stage').toLowerCase() === 'production'
    ? 'matls-clients.api.cora.com.br'
    : 'matls-clients.api.stage.cora.com.br';
}

// Aceita o PEM direto (com "BEGIN") ou em base64 (mais seguro de colar no painel).
function normalizePem(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (s.includes('BEGIN')) return s.replace(/\\n/g, '\n');
  try { return Buffer.from(s, 'base64').toString('utf8'); } catch { return s; }
}

function creds() {
  return {
    clientId: process.env.CORA_CLIENT_ID || null,
    cert: normalizePem(process.env.CORA_CERT),
    key: normalizePem(process.env.CORA_KEY),
  };
}

// Diz se as credenciais do Cora estão configuradas (senão, o checkout cai no
// fluxo manual antigo, sem quebrar).
function isConfigured() {
  const c = creds();
  return !!(c.clientId && c.cert && c.key);
}

function httpsRequest({ method, path, headers, body }) {
  const c = creds();
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: baseHost(), port: 443, path, method, headers, cert: c.cert, key: c.key },
      (res) => {
        let data = '';
        res.on('data', ch => (data += ch));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`Cora ${method} ${path} -> HTTP ${res.statusCode}: ${String(data).slice(0, 300)}`));
          }
          try { resolve(data ? JSON.parse(data) : null); } catch { resolve(data); }
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

let cachedToken = null; // { token, exp }

async function getToken() {
  const c = creds();
  const now = Date.now();
  if (cachedToken && cachedToken.exp > now + 60000) return cachedToken.token;
  const body = `grant_type=client_credentials&client_id=${encodeURIComponent(c.clientId)}`;
  const res = await httpsRequest({
    method: 'POST', path: '/token',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    body,
  });
  cachedToken = { token: res.access_token, exp: now + (Number(res.expires_in) || 3600) * 1000 };
  return cachedToken.token;
}

async function apiRequest(method, path, jsonBody, idempotencyKey) {
  const token = await getToken();
  const payload = jsonBody ? JSON.stringify(jsonBody) : null;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' };
  if (idempotencyKey) headers['Idempotency-Key'] = String(idempotencyKey);
  if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
  return httpsRequest({ method, path, headers, body: payload });
}

// Cria uma cobrança (Pix + boleto). amountCents em centavos. dueDate 'AAAA-MM-DD'.
// document = CPF/CNPJ do pagador (obrigatório pela Cora).
async function createInvoice({ code, customerName, document, documentType, amountCents, description, dueDate }) {
  return apiRequest('POST', '/v2/invoices/', {
    code,
    customer: {
      name: String(customerName || 'Cliente').slice(0, 60),
      document: { identity: String(document || '').replace(/\D/g, ''), type: documentType || 'CPF' },
    },
    services: [{
      name: (description || 'Assinatura Zero Tempo').slice(0, 60),
      description: description || 'Assinatura Zero Tempo',
      amount: amountCents,
    }],
    payment_terms: { due_date: dueDate },
    payment_forms: ['BANK_SLIP', 'PIX'],
  }, code);
}

// Consulta uma cobrança pelo id do Cora (usado no webhook pra CONFIRMAR o
// pagamento antes de liberar o plano — não confia cegamente no webhook).
async function getInvoice(id) {
  return apiRequest('GET', `/v2/invoices/${id}`, null);
}

module.exports = { isConfigured, getToken, createInvoice, getInvoice };
