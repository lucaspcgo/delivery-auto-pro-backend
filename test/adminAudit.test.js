// Auditoria do admin: total de cadastros, data de criação e lojas conectadas
// por usuário (iFood + 99food). Só admin acessa.
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

test('retorna resumo e lista com data de criação e lojas conectadas', async () => {
  pool.query.mockResolvedValueOnce({ rows: [
    { id: 'a', name: 'Loja A', email: 'a@x.com', plan: 'pro', active: true, is_admin: false,
      payment_status: 'active', created_at: '2026-07-01T00:00:00Z',
      stores_connected: '3', ifood_stores: '2', food99_stores: '1',
      last_order_at: '2026-07-20T10:00:00Z', orders_total: '42' },
    { id: 'b', name: 'Loja B', email: 'b@x.com', plan: 'starter', active: false, is_admin: false,
      payment_status: 'suspended', created_at: '2026-06-15T00:00:00Z',
      stores_connected: '0', ifood_stores: '0', food99_stores: '0',
      last_order_at: null, orders_total: '0' },
  ] });

  const res = await request(app())
    .get('/admin/audit')
    .set('Authorization', `Bearer ${adminToken()}`);

  expect(res.status).toBe(200);
  expect(res.body.summary).toEqual({
    users: 2, active_users: 1, stores_connected: 3, ifood_stores: 2, food99_stores: 1,
    expiring_soon: 0, expired: 0,
  });
  expect(res.body.users[0].created_at).toBe('2026-07-01T00:00:00Z');
  expect(res.body.users[0].stores_connected).toBe(3); // número, não string
  expect(res.body.users[0].last_order_at).toBe('2026-07-20T10:00:00Z');
  expect(res.body.users[0].orders_total).toBe(42);
});

test('marca vencendo/vencido/ok conforme dias restantes', async () => {
  const dia = 86400000;
  const base = { name: 'x', email: 'x@x.com', plan: 'pro', active: true, is_admin: false,
    payment_status: 'active', created_at: '2026-01-01T00:00:00Z',
    stores_connected: '0', ifood_stores: '0', food99_stores: '0', last_order_at: null, orders_total: '0' };
  pool.query.mockResolvedValueOnce({ rows: [
    { ...base, plan_expires_at: new Date(Date.now() + 10 * dia).toISOString() }, // ok
    { ...base, plan_expires_at: new Date(Date.now() + 1 * dia).toISOString() },  // vencendo (<=3)
    { ...base, plan_expires_at: new Date(Date.now() - 1 * dia).toISOString() },  // vencido
  ] });

  const res = await request(app())
    .get('/admin/audit')
    .set('Authorization', `Bearer ${adminToken()}`);

  expect(res.status).toBe(200);
  expect(res.body.users[0].expiry_status).toBe('ok');
  expect(res.body.users[1].expiry_status).toBe('vencendo');
  expect(res.body.users[2].expiry_status).toBe('vencido');
  expect(res.body.summary.expiring_soon).toBe(1);
  expect(res.body.summary.expired).toBe(1);
});

test('sem token de admin -> 401/403', async () => {
  const res = await request(app()).get('/admin/audit');
  expect([401, 403]).toContain(res.status);
});
