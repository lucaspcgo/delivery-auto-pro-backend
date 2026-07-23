// Perfis de acesso: gerente vê o Painel Administrativo e cuida da cobrança,
// mas NÃO troca planos/perfis nem exclui/reseta usuários (só admin).
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
const gerenteToken = () => jwt.sign({ id: 2, is_admin: false, role: 'gerente' }, JWT_SECRET, { expiresIn: '1h' });
const clienteToken = () => jwt.sign({ id: 3, is_admin: false, role: 'user' }, JWT_SECRET, { expiresIn: '1h' });
const adminToken = () => jwt.sign({ id: 1, is_admin: true, role: 'admin' }, JWT_SECRET, { expiresIn: '1h' });

beforeEach(() => pool.query.mockReset());

test('cliente comum é barrado do painel administrativo', async () => {
  const res = await request(app()).get('/admin/users').set('Authorization', `Bearer ${clienteToken()}`);
  expect(res.status).toBe(403);
});

test('gerente pode listar usuários (ver o painel)', async () => {
  pool.query.mockResolvedValueOnce({ rows: [{ id: 'a', name: 'Loja A' }] });
  const res = await request(app()).get('/admin/users').set('Authorization', `Bearer ${gerenteToken()}`);
  expect(res.status).toBe(200);
});

test('gerente pode ver e filtrar faturas', async () => {
  pool.query.mockResolvedValueOnce({ rows: [{ id: 1, amount: '97', status: 'pending', days_overdue: 5 }] });
  const res = await request(app())
    .get('/admin/invoices?overdue=1').set('Authorization', `Bearer ${gerenteToken()}`);
  expect(res.status).toBe(200);
  expect(res.body).toHaveProperty('invoices');
  expect(res.body).toHaveProperty('summary');
  expect(res.body.summary.overdue_count).toBe(1);
});

test('gerente NÃO pode excluir usuário', async () => {
  const res = await request(app()).delete('/admin/users/9').set('Authorization', `Bearer ${gerenteToken()}`);
  expect(res.status).toBe(403);
  expect(pool.query).not.toHaveBeenCalled();
});

test('gerente NÃO pode resetar senha nem criar usuário', async () => {
  const r1 = await request(app()).post('/admin/users/9/reset-password')
    .set('Authorization', `Bearer ${gerenteToken()}`).send({});
  const r2 = await request(app()).post('/admin/users')
    .set('Authorization', `Bearer ${gerenteToken()}`).send({ name: 'x', email: 'x@x.com', password: '123456' });
  expect(r1.status).toBe(403);
  expect(r2.status).toBe(403);
});

test('gerente edita contato mas NÃO troca plano/perfil (campos são ignorados)', async () => {
  pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 9, name: 'Novo Nome' }] });
  const res = await request(app()).put('/admin/users/9')
    .set('Authorization', `Bearer ${gerenteToken()}`)
    .send({ name: 'Novo Nome', phone: '11999', plan: 'enterprise', role: 'admin', is_admin: true });
  expect(res.status).toBe(200);
  // O UPDATE roda, mas plan/role/is_admin chegam como null (ignorados p/ gerente).
  const call = pool.query.mock.calls.find(c => /UPDATE users SET/.test(c[0]));
  expect(call).toBeTruthy();
  const params = call[1];
  // ordem: name,email,phone,plan,active,payment_status,role,is_admin,plan_expires_at,renewDays,id
  expect(params[3]).toBeUndefined(); // plan ignorado
  expect(params[6]).toBeUndefined(); // role ignorado
  expect(params[7]).toBeUndefined(); // is_admin ignorado
});

test('admin PODE trocar plano e perfil', async () => {
  // valida o plano, checa plano atual, faz o UPDATE
  pool.query
    .mockResolvedValueOnce({ rows: [{ billing_period: 'monthly', is_free: false }] })
    .mockResolvedValueOnce({ rows: [{ plan: 'starter' }] })
    .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 9, plan: 'pro', role: 'gerente' }] });
  const res = await request(app()).put('/admin/users/9')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ plan: 'pro', role: 'gerente' });
  expect(res.status).toBe(200);
});
