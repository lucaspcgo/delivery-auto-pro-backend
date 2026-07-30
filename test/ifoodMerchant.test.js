// Módulo Merchant (homologação iFood): status, interrupções e horários, com
// isolamento por conta e repasse do código de erro do iFood.
process.env.PLAN_GATING_ENABLED = 'false';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-com-mais-de-32-caracteres-aqui-ok';

jest.mock('../src/db/postgres', () => require('./helpers/mockPool').mockPool());
jest.mock('../src/services/ifood-distributed', () => ({
  getMerchantStatus: jest.fn(),
  getInterruptions: jest.fn(),
  createInterruption: jest.fn(),
  deleteInterruption: jest.fn(),
  getOpeningHours: jest.fn(),
  updateOpeningHours: jest.fn(),
}));

const jwt = require('jsonwebtoken');
const express = require('express');
const request = require('supertest');
const pool = require('../src/db/postgres');
const ifood = require('../src/services/ifood-distributed');
const { JWT_SECRET } = require('../src/config/env');
const integrationsRouter = require('../src/routes/integrations');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/integrations', integrationsRouter);
  return a;
}
const token = () => jwt.sign({ id: 'u1', is_admin: false, role: 'user', plan: 'pro' }, JWT_SECRET, { expiresIn: '1h' });
const owns = () => pool.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }); // ownsMerchant true

beforeEach(() => { pool.query.mockReset(); Object.values(ifood).forEach(fn => fn.mockReset && fn.mockReset()); });

test('status: loja de outro usuário é barrada (404)', async () => {
  pool.query.mockResolvedValueOnce({ rows: [] }); // não é dono
  const res = await request(app()).get('/integrations/ifood/merchants/M1/status')
    .set('Authorization', `Bearer ${token()}`);
  expect(res.status).toBe(404);
  expect(ifood.getMerchantStatus).not.toHaveBeenCalled();
});

test('status: retorna estado da loja', async () => {
  owns();
  ifood.getMerchantStatus.mockResolvedValueOnce([{ state: 'OK', available: true }]);
  const res = await request(app()).get('/integrations/ifood/merchants/M1/status')
    .set('Authorization', `Bearer ${token()}`);
  expect(res.status).toBe(200);
  expect(res.body[0].state).toBe('OK');
});

test('interrupções: criar com sobreposição repassa 409 do iFood', async () => {
  owns();
  const err = new Error('conflito'); err.statusCode = 409; err.body = { error: 'InterruptionOverlap' };
  ifood.createInterruption.mockRejectedValueOnce(err);
  const res = await request(app()).post('/integrations/ifood/merchants/M1/interruptions')
    .set('Authorization', `Bearer ${token()}`)
    .send({ description: 'Almoço', start: '2026-07-30T12:00:00Z', end: '2026-07-30T13:00:00Z' });
  expect(res.status).toBe(409);
  expect(res.body.code).toBe(409);
  expect(res.body.details).toMatch(/Overlap/);
});

test('interrupções: criar sem start/end dá 400', async () => {
  owns();
  const res = await request(app()).post('/integrations/ifood/merchants/M1/interruptions')
    .set('Authorization', `Bearer ${token()}`).send({ description: 'x' });
  expect(res.status).toBe(400);
});

test('interrupções: remover retorna 204', async () => {
  owns();
  ifood.deleteInterruption.mockResolvedValueOnce(null);
  const res = await request(app()).delete('/integrations/ifood/merchants/M1/interruptions/INT1')
    .set('Authorization', `Bearer ${token()}`);
  expect(res.status).toBe(204);
});

test('horários: atualizar sem shifts dá 400; com shifts retorna 201', async () => {
  owns();
  const r1 = await request(app()).put('/integrations/ifood/merchants/M1/opening-hours')
    .set('Authorization', `Bearer ${token()}`).send({});
  expect(r1.status).toBe(400);

  owns();
  ifood.updateOpeningHours.mockResolvedValueOnce({ success: true });
  const r2 = await request(app()).put('/integrations/ifood/merchants/M1/opening-hours')
    .set('Authorization', `Bearer ${token()}`)
    .send({ shifts: [{ dayOfWeek: 'MONDAY', start: '08:00', duration: 600 }] });
  expect(r2.status).toBe(201);
});

test('429 repassa Retry-After', async () => {
  owns();
  const err = new Error('rate'); err.statusCode = 429; err.retryAfter = '30';
  ifood.getInterruptions.mockRejectedValueOnce(err);
  const res = await request(app()).get('/integrations/ifood/merchants/M1/interruptions')
    .set('Authorization', `Bearer ${token()}`);
  expect(res.status).toBe(429);
  expect(res.headers['retry-after']).toBe('30');
});
