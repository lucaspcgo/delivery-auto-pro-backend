// Desconectar UMA loja iFood deve remover TODOS os vínculos dela (inclusive
// registros duplicados) — antes ficava um pra trás e a loja "não sumia".
process.env.PLAN_GATING_ENABLED = 'false';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-com-mais-de-32-caracteres-aqui-ok';

jest.mock('../src/db/postgres', () => require('./helpers/mockPool').mockPool());
jest.mock('../src/services/ifood-distributed', () => ({
  pruneOrphanAuths: jest.fn().mockResolvedValue(),
}));

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

test('remove todos os vínculos duplicados da loja', async () => {
  pool.query
    // SELECT rp (2 duplicatas, mesmo restaurante)
    .mockResolvedValueOnce({ rows: [
      { id: 'p1', restaurant_id: 'r1' },
      { id: 'p2', restaurant_id: 'r1' },
    ] })
    // DELETE restaurant_platforms (todos)
    .mockResolvedValueOnce({ rowCount: 2 })
    // SELECT outras plataformas do r1 -> nenhuma
    .mockResolvedValueOnce({ rows: [] })
    // DELETE restaurants r1
    .mockResolvedValueOnce({ rowCount: 1 });

  const res = await request(app()).delete('/integrations/ifood/stores/M1')
    .set('Authorization', `Bearer ${token()}`);

  expect(res.status).toBe(200);
  expect(res.body.removed).toBe(2);
  // Confirma que o DELETE apagou por merchant_id (todos), não por id único.
  const del = pool.query.mock.calls.find(c => /DELETE FROM restaurant_platforms[\s\S]*platform_merchant_id/.test(c[0]));
  expect(del).toBeTruthy();
});

test('404 quando a loja não é do usuário', async () => {
  pool.query.mockResolvedValueOnce({ rows: [] });
  const res = await request(app()).delete('/integrations/ifood/stores/M9')
    .set('Authorization', `Bearer ${token()}`);
  expect(res.status).toBe(404);
});
