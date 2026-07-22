// Admin renova o acesso por +1 ciclo do plano; reativa e tira suspensão.
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

test('renova pelo ciclo do plano (semanal=7) e devolve nova validade', async () => {
  pool.query
    .mockResolvedValueOnce({ rows: [{ id: 9, plan: 'semanal', plan_expires_at: null }] }) // busca user
    .mockResolvedValueOnce({ rows: [{ billing_period: 'weekly' }] })                       // billing_period
    .mockResolvedValueOnce({ rows: [{ id: 9, email: 'u@x.com', plan: 'semanal', payment_status: 'active', plan_expires_at: '2026-08-01T00:00:00Z' }] });

  const res = await request(app())
    .post('/admin/users/9/renew')
    .set('Authorization', `Bearer ${adminToken()}`);

  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
  expect(res.body.days).toBe(7);
  // o UPDATE reativa a conta e tira a suspensão
  const updateSql = pool.query.mock.calls[2][0];
  expect(updateSql).toMatch(/payment_status='active'/);
  expect(updateSql).toMatch(/active=true/);
});

test('usuário inexistente -> 404', async () => {
  pool.query.mockResolvedValueOnce({ rows: [] });
  const res = await request(app())
    .post('/admin/users/999/renew')
    .set('Authorization', `Bearer ${adminToken()}`);
  expect(res.status).toBe(404);
});
