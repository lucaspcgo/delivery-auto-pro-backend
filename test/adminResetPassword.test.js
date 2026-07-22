// Admin redefine a senha de um usuário (sem email): usa a senha enviada ou
// gera uma temporária; grava o hash; só devolve a senha quando é gerada.
process.env.PLAN_GATING_ENABLED = 'false';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-com-mais-de-32-caracteres-aqui-ok';

jest.mock('../src/db/postgres', () => require('./helpers/mockPool').mockPool());

const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
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

test('senha informada pelo admin -> grava hash, NÃO devolve a senha', async () => {
  pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 9, email: 'u@x.com' }] });
  const res = await request(app())
    .post('/admin/users/9/reset-password')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ new_password: 'novaSenha123' });

  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
  expect(res.body.temporary_password).toBeUndefined();
  // gravou um hash (não a senha crua)
  const [sql, params] = pool.query.mock.calls[0];
  expect(sql).toMatch(/UPDATE users SET password_hash/);
  expect(await bcrypt.compare('novaSenha123', params[0])).toBe(true);
});

test('sem senha -> gera temporária e devolve pro admin repassar', async () => {
  pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 9, email: 'u@x.com' }] });
  const res = await request(app())
    .post('/admin/users/9/reset-password')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({});

  expect(res.status).toBe(200);
  expect(typeof res.body.temporary_password).toBe('string');
  expect(res.body.temporary_password.length).toBeGreaterThanOrEqual(6);
});

test('senha muito curta -> 400', async () => {
  const res = await request(app())
    .post('/admin/users/9/reset-password')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ new_password: '123' });
  expect(res.status).toBe(400);
});

test('sem token de admin -> 401/403', async () => {
  const res = await request(app()).post('/admin/users/9/reset-password').send({ new_password: 'abcdef' });
  expect([401, 403]).toContain(res.status);
});
