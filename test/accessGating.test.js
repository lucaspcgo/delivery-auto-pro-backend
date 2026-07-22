// Corte de acesso em tempo real (flag PLAN_GATING_ENABLED). Conta inativa,
// pagamento suspenso ou plano vencido é derrubada no middleware. Admin nunca.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);

jest.mock('../src/db/postgres', () => require('./helpers/mockPool').mockPool());

const jwt = require('jsonwebtoken');
const pool = require('../src/db/postgres');
const { JWT_SECRET } = require('../src/config/env');
const { authenticateToken } = require('../src/middleware/auth');
const { accessBlockReason } = require('../src/services/accessControl');

function mockRes() {
  return { statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
const call = (userRow) => {
  pool.query.mockReset();
  pool.query.mockResolvedValue({ rows: userRow ? [userRow] : [] });
  const token = jwt.sign({ id: 7, is_admin: !!(userRow && userRow.is_admin), plan: 'pro' }, JWT_SECRET);
  const req = { headers: { authorization: `Bearer ${token}` } };
  const res = mockRes();
  const next = jest.fn();
  return authenticateToken(req, res, next).then(() => ({ res, next }));
};

afterEach(() => { delete process.env.PLAN_GATING_ENABLED; });

test('accessBlockReason: cobre inativo, suspenso, vencido e admin', () => {
  const futuro = new Date(Date.now() + 86400000).toISOString();
  const passado = new Date(Date.now() - 86400000).toISOString();
  expect(accessBlockReason({ active: true, payment_status: 'active', plan_expires_at: futuro })).toBeNull();
  expect(accessBlockReason({ active: false })).toBe('account_inactive');
  expect(accessBlockReason({ active: true, payment_status: 'suspended' })).toBe('payment_suspended');
  expect(accessBlockReason({ active: true, payment_status: 'active', plan_expires_at: passado })).toBe('plan_expired');
  // admin passa mesmo com plano vencido
  expect(accessBlockReason({ is_admin: true, active: false, plan_expires_at: passado })).toBeNull();
});

test('flag OFF: não checa banco, deixa passar', async () => {
  const { res, next } = await call({ active: false });
  expect(next).toHaveBeenCalled();
  expect(res.statusCode).toBe(0);
});

test('flag ON + conta suspensa: 403 e não chama next', async () => {
  process.env.PLAN_GATING_ENABLED = 'true';
  const { res, next } = await call({ active: true, payment_status: 'suspended' });
  expect(next).not.toHaveBeenCalled();
  expect(res.statusCode).toBe(403);
  expect(res.body.access_blocked).toBe(true);
});

test('flag ON + admin: passa mesmo inativo', async () => {
  process.env.PLAN_GATING_ENABLED = 'true';
  const { res, next } = await call({ is_admin: true, active: false });
  expect(next).toHaveBeenCalled();
  expect(res.statusCode).toBe(0);
});
