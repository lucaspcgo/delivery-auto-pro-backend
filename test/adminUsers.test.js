process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);
jest.mock('../src/db/postgres', () => require('./helpers/mockPool').mockPool());
jest.mock('../src/middleware/auth', () => ({
  authenticateToken: (req, res, next) => { req.user = { id: 1 }; next(); },
}));
jest.mock('jsonwebtoken', () => ({
  verify: jest.fn(() => ({ is_admin: true, id: 1 })),
}));

const express = require('express');
const request = require('supertest');
const pool = require('../src/db/postgres');

describe('settings PUT /plan — validação dinâmica contra tabela plans', () => {
  const settingsRouter = require('../src/routes/settings');
  const app = express();
  app.use(express.json());
  app.use('/', settingsRouter);

  beforeEach(() => pool.query.mockReset());

  test('plano inexistente na tabela plans -> 400', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ active: true, plan: 'free', plan_expires_at: null }] }) // requireActiveUser
      .mockResolvedValueOnce({ rows: [] }); // SELECT em plans
    const res = await request(app).put('/plan').set('Authorization', 'Bearer faketoken').send({ plan: 'inexistente' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Plano inválido' });
  });

  test('plano existente na tabela plans -> 200 e atualiza', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ active: true, plan: 'free', plan_expires_at: null }] }) // requireActiveUser
      .mockResolvedValueOnce({ rows: [{}] }) // SELECT em plans
      .mockResolvedValueOnce({ rows: [{ id: 1, plan: 'pro' }] }); // UPDATE users
    const res = await request(app).put('/plan').set('Authorization', 'Bearer faketoken').send({ plan: 'pro' });
    expect(res.status).toBe(200);
    expect(pool.query).toHaveBeenCalledTimes(3);
    expect(pool.query.mock.calls[2][0]).toMatch(/UPDATE users SET plan/);
  });
});

describe('admin PUT /users/:id — reativação e validação de plano', () => {
  const adminRouter = require('../src/routes/admin');
  const app = express();
  app.use(express.json());
  app.use('/', adminRouter);

  beforeEach(() => pool.query.mockReset());

  test('active:true reativa o usuário', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 5, active: true }] });
    const res = await request(app)
      .put('/users/5')
      .set('Authorization', 'Bearer faketoken')
      .send({ active: true });
    expect(res.status).toBe(200);
    const [query, params] = pool.query.mock.calls[0];
    expect(query).toMatch(/active=COALESCE/);
    expect(params).toContain(true);
  });

  test('plano inválido enviado -> 400', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] }); // SELECT em plans -> não existe
    const res = await request(app)
      .put('/users/5')
      .set('Authorization', 'Bearer faketoken')
      .send({ plan: 'inexistente' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Plano inválido' });
    // Verify that the WHERE clause includes AND active = true
    const [query] = pool.query.mock.calls[0];
    expect(query).toContain('AND active = true');
  });
});
