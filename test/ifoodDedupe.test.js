// Limpeza de lojas iFood duplicadas: mantém 1 por merchant, remove as cópias.
process.env.PLAN_GATING_ENABLED = 'false';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-com-mais-de-32-caracteres-aqui-ok';

jest.mock('../src/db/postgres', () => require('./helpers/mockPool').mockPool());
jest.mock('../src/services/ifood-distributed', () => ({ pruneOrphanAuths: jest.fn().mockResolvedValue() }));

const jwt = require('jsonwebtoken');
const express = require('express');
const request = require('supertest');
const pool = require('../src/db/postgres');
const { JWT_SECRET } = require('../src/config/env');
const integrationsRouter = require('../src/routes/integrations');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/integrations', integrationsRouter);
  return a;
}
const token = () => jwt.sign({ id: 'u1', is_admin: false, role: 'user', plan: 'pro' }, JWT_SECRET, { expiresIn: '1h' });

beforeEach(() => pool.query.mockReset());

test('remove as duplicadas e limpa restaurante órfão', async () => {
  pool.query
    .mockResolvedValueOnce({ rows: [{ id: 'p2', restaurant_id: 'r2' }] }) // duplicadas (rn>1)
    .mockResolvedValueOnce({ rowCount: 1 })                               // DELETE rp por id
    .mockResolvedValueOnce({ rows: [] })                                  // r2 sem outras plataformas
    .mockResolvedValueOnce({ rowCount: 1 });                             // DELETE restaurants r2

  const res = await request(app()).post('/integrations/ifood/stores/dedupe')
    .set('Authorization', `Bearer ${token()}`);

  expect(res.status).toBe(200);
  expect(res.body.removed).toBe(1);
});

test('sem duplicadas, não remove nada', async () => {
  pool.query.mockResolvedValueOnce({ rows: [] });
  const res = await request(app()).post('/integrations/ifood/stores/dedupe')
    .set('Authorization', `Bearer ${token()}`);
  expect(res.status).toBe(200);
  expect(res.body.removed).toBe(0);
});
