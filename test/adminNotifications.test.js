// Sininho do admin: junta vencidos, vencendo, faturas pendentes e novos cadastros.
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

test('monta notificações a partir das contagens', async () => {
  pool.query
    .mockResolvedValueOnce({ rows: [{ vencidos: 2, vencendo: 1 }] }) // venc
    .mockResolvedValueOnce({ rows: [{ n: 3 }] })                      // novos hoje
    .mockResolvedValueOnce({ rows: [{ n: 0 }] });                     // faturas pendentes

  const res = await request(app())
    .get('/admin/notifications')
    .set('Authorization', `Bearer ${adminToken()}`);

  expect(res.status).toBe(200);
  expect(res.body.unread_count).toBe(3); // vencidos + vencendo + novos (faturas=0 não entra)
  const tipos = res.body.notifications.map(n => n.type);
  expect(tipos).toContain('plan_expired');
  expect(tipos).toContain('plan_expiring');
  expect(tipos).toContain('new_signups');
  expect(tipos).not.toContain('invoice_pending');
});

test('nada a avisar -> lista vazia', async () => {
  pool.query
    .mockResolvedValueOnce({ rows: [{ vencidos: 0, vencendo: 0 }] })
    .mockResolvedValueOnce({ rows: [{ n: 0 }] })
    .mockResolvedValueOnce({ rows: [{ n: 0 }] });

  const res = await request(app())
    .get('/admin/notifications')
    .set('Authorization', `Bearer ${adminToken()}`);

  expect(res.status).toBe(200);
  expect(res.body.unread_count).toBe(0);
  expect(res.body.notifications).toEqual([]);
});
