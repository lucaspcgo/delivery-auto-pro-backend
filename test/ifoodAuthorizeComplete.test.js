// /ifood/authorize/complete deve:
// - devolver 400 só quando a AUTORIZAÇÃO em si falha (código errado/expirado);
// - devolver 200 sucesso com pending=true quando a autorização foi salva mas as
//   lojas ainda não propagaram (até 10 min) — lista vazia OU falha no sync.
process.env.PLAN_GATING_ENABLED = 'false';

jest.mock('../src/db/postgres', () => require('./helpers/mockPool').mockPool());
jest.mock('../src/middleware/auth', () => ({
  authenticateToken: (req, _res, next) => { req.user = { id: 7 }; next(); },
}));
jest.mock('../src/services/ifood-distributed', () => ({
  completeAuthorization: jest.fn(),
  getAccessToken: jest.fn(),
  isAuthorized: jest.fn(),
}));
jest.mock('../src/services/ifood-api-complete', () => ({
  getMerchants: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const pool = require('../src/db/postgres');
const ifoodDistributed = require('../src/services/ifood-distributed');
const ifoodAPI = require('../src/services/ifood-api-complete');
const integrationsRouter = require('../src/routes/integrations');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/integrations', integrationsRouter);
  return a;
}

function post() {
  return request(app()).post('/integrations/ifood/authorize/complete').send({ authorizationCode: 'ABC-123' });
}

test('código inválido/expirado (autorização falha) -> 400', async () => {
  ifoodDistributed.completeAuthorization.mockRejectedValue(new Error('O código de ativação expirou.'));
  const res = await post();
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/concluir autoriza/i);
});

test('autorização OK mas lojas ainda não propagaram (getMerchants vazio) -> 200 pending', async () => {
  ifoodDistributed.completeAuthorization.mockResolvedValue();
  ifoodDistributed.getAccessToken.mockResolvedValue('tok');
  ifoodAPI.getMerchants.mockResolvedValue([]);
  const res = await post();
  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
  expect(res.body.pending).toBe(true);
});

test('autorização OK mas sync falha (propagação) -> 200 pending, não 400', async () => {
  ifoodDistributed.completeAuthorization.mockResolvedValue();
  ifoodDistributed.getAccessToken.mockResolvedValue('tok');
  ifoodAPI.getMerchants.mockRejectedValue(new Error('403 forbidden to access merchant'));
  const res = await post();
  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
  expect(res.body.pending).toBe(true);
});

test('autorização OK e loja já disponível -> 200 connected com a loja', async () => {
  ifoodDistributed.completeAuthorization.mockResolvedValue();
  ifoodDistributed.getAccessToken.mockResolvedValue('tok');
  ifoodAPI.getMerchants.mockResolvedValue([{ id: '3883561', name: 'Loja Teste' }]);
  pool.query
    .mockResolvedValueOnce({ rows: [] })            // SELECT existing
    .mockResolvedValueOnce({ rows: [{ id: 99 }] })  // INSERT restaurants
    .mockResolvedValueOnce({ rows: [] });           // INSERT restaurant_platforms
  const res = await post();
  expect(res.status).toBe(200);
  expect(res.body.connected).toHaveLength(1);
  expect(res.body.connected[0].id).toBe('3883561');
});
