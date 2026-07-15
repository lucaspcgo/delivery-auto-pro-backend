// Isolamento por usuário no relatório: usuário comum só vê os próprios pedidos
// (filtro o.user_id); admin vê tudo (sem esse filtro).
process.env.PLAN_GATING_ENABLED = 'false';

jest.mock('../src/db/postgres', () => require('./helpers/mockPool').mockPool());
jest.mock('../src/middleware/auth', () => ({
  authenticateToken: (req, _res, next) => {
    req.user = JSON.parse(req.headers['x-test-user'] || '{"id":1,"is_admin":false}');
    next();
  },
}));

const express = require('express');
const request = require('supertest');
const pool = require('../src/db/postgres');
const reportsRouter = require('../src/routes/reports');

const GERAL_ROW = {
  total_pedidos: 0, faturamento_total: 0, ticket_medio: 0,
  aceitos: 0, cancelados: 0, pendentes: 0,
};

function app() {
  const a = express();
  a.use('/reports', reportsRouter);
  return a;
}

beforeEach(() => { pool.query.mockResolvedValue({ rows: [GERAL_ROW] }); });

test('usuário comum: filtra por o.user_id com o próprio id', async () => {
  const res = await request(app())
    .get('/reports/summary')
    .set('x-test-user', JSON.stringify({ id: 42, is_admin: false }));

  expect(res.status).toBe(200);
  const [sql, params] = pool.query.mock.calls[0];
  expect(sql).toMatch(/o\.user_id = \$/);
  expect(params).toContain(42);
});

test('admin: NÃO filtra por o.user_id', async () => {
  const res = await request(app())
    .get('/reports/summary')
    .set('x-test-user', JSON.stringify({ id: 1, is_admin: true }));

  expect(res.status).toBe(200);
  const [sql] = pool.query.mock.calls[0];
  expect(sql).not.toMatch(/o\.user_id/);
});
