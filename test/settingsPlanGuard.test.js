// PUT /settings/plan não pode deixar usuário comum subir para plano PAGO sem
// pagamento (bypass). Downgrade para gratuito é permitido; admin pode tudo.
process.env.PLAN_GATING_ENABLED = 'false';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-com-mais-de-32-caracteres-aqui-ok';

jest.mock('../src/db/postgres', () => require('./helpers/mockPool').mockPool());

const jwt = require('jsonwebtoken');
const express = require('express');
const request = require('supertest');
const pool = require('../src/db/postgres');
const { JWT_SECRET } = require('../src/config/env');
const settingsRouter = require('../src/routes/settings');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/settings', settingsRouter);
  return a;
}

function token(user) {
  return jwt.sign(user, JWT_SECRET, { expiresIn: '1h' });
}

test('usuário comum tentando plano PAGO -> 402 requires_payment, sem UPDATE', async () => {
  pool.query.mockResolvedValueOnce({ rows: [{ is_free: false, price: 99 }] }); // SELECT plano
  const res = await request(app())
    .put('/settings/plan')
    .set('Authorization', `Bearer ${token({ id: 5, is_admin: false })}`)
    .send({ plan: 'pro' });

  expect(res.status).toBe(402);
  expect(res.body.requires_payment).toBe(true);
  // Só rodou o SELECT do plano, nenhum UPDATE users
  expect(pool.query).toHaveBeenCalledTimes(1);
});

test('usuário comum trocando para plano GRATUITO -> 200 (downgrade permitido)', async () => {
  pool.query
    .mockResolvedValueOnce({ rows: [{ is_free: true, price: 0 }] })      // SELECT plano
    .mockResolvedValueOnce({ rows: [{ id: 5, plan: 'free' }] });         // UPDATE users
  const res = await request(app())
    .put('/settings/plan')
    .set('Authorization', `Bearer ${token({ id: 5, is_admin: false })}`)
    .send({ plan: 'free' });

  expect(res.status).toBe(200);
  expect(res.body.plan).toBe('free');
});

test('admin pode setar plano pago diretamente -> 200', async () => {
  pool.query
    .mockResolvedValueOnce({ rows: [{ is_free: false, price: 99 }] })    // SELECT plano
    .mockResolvedValueOnce({ rows: [{ id: 1, plan: 'pro' }] });          // UPDATE users
  const res = await request(app())
    .put('/settings/plan')
    .set('Authorization', `Bearer ${token({ id: 1, is_admin: true })}`)
    .send({ plan: 'pro' });

  expect(res.status).toBe(200);
  expect(res.body.plan).toBe('pro');
});
