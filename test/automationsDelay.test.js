// Trava de espera antes de aceitar (accept_delay_seconds) — configurável por
// loja, com faixas seguras (sem negativo, sem valores absurdos).
process.env.PLAN_GATING_ENABLED = 'false';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-com-mais-de-32-caracteres-aqui-ok';

jest.mock('../src/db/postgres', () => require('./helpers/mockPool').mockPool());
jest.mock('../src/services/autoAccept', () => ({
  tryAutoAccept: jest.fn(),
  ensureAutomationSchema: jest.fn().mockResolvedValue(),
}));

const jwt = require('jsonwebtoken');
const express = require('express');
const request = require('supertest');
const pool = require('../src/db/postgres');
const { JWT_SECRET } = require('../src/config/env');
const automationsRouter = require('../src/routes/automations');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/automations', automationsRouter);
  return a;
}
const token = () => jwt.sign({ id: 'u1', is_admin: false, role: 'user', plan: 'pro' }, JWT_SECRET, { expiresIn: '1h' });

beforeEach(() => pool.query.mockReset());

test('salva accept_delay_seconds (trava de impressão) por loja', async () => {
  pool.query
    .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 5, user_id: 'u1', action: 'auto_accept' }] }) // ownership
    .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 5, accept_delay_seconds: 60, delay_seconds: 480, action: 'auto_accept', enabled: true }] }); // update

  const res = await request(app()).put('/automations/5')
    .set('Authorization', `Bearer ${token()}`)
    .send({ accept_delay_seconds: '60' });

  expect(res.status).toBe(200);
  const upd = pool.query.mock.calls.find(c => /UPDATE automation_rules SET/.test(c[0]));
  expect(upd[1]).toContain(60); // gravou 60s
});

test('trava valores negativos em 0 e absurdos no teto', async () => {
  pool.query
    .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 5, user_id: 'u1', action: 'auto_accept' }] })
    .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 5, accept_delay_seconds: 900 }] });

  const res = await request(app()).put('/automations/5')
    .set('Authorization', `Bearer ${token()}`)
    .send({ accept_delay_seconds: -50, delay_seconds: 999999 });

  expect(res.status).toBe(200);
  const upd = pool.query.mock.calls.find(c => /UPDATE automation_rules SET/.test(c[0]));
  expect(upd[1]).toContain(0);    // negativo -> 0
  expect(upd[1]).toContain(7200); // absurdo -> teto do pronto (2h)
});
