// Recalcula a validade de todos os clientes de uma vez (criação + ciclo do plano).
process.env.PLAN_GATING_ENABLED = 'false';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-com-mais-de-32-caracteres-aqui-ok';

jest.mock('../src/db/postgres', () => require('./helpers/mockPool').mockPool());

const jwt = require('jsonwebtoken');
const express = require('express');
const request = require('supertest');
const pool = require('../src/db/postgres');
const { JWT_SECRET } = require('../src/config/env');
const adminRouter = require('../src/routes/admin');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/admin', adminRouter);
  return a;
}
const adminToken = () => jwt.sign({ id: 1, is_admin: true }, JWT_SECRET, { expiresIn: '1h' });

beforeEach(() => pool.query.mockReset());

test('recalcula e devolve quantos foram atualizados', async () => {
  pool.query.mockResolvedValueOnce({ rowCount: 25, rows: Array.from({ length: 25 }, (_, i) => ({ id: i })) });
  const res = await request(app())
    .post('/admin/recalculate-expiry')
    .set('Authorization', `Bearer ${adminToken()}`);
  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
  expect(res.body.updated).toBe(25);
  const sql = pool.query.mock.calls[0][0];
  expect(sql).toMatch(/created_at \+/);
  expect(sql).toMatch(/is_admin = false/);
});

test('sem token de admin -> 401/403', async () => {
  const res = await request(app()).post('/admin/recalculate-expiry');
  expect([401, 403]).toContain(res.status);
});
