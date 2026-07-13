jest.mock('../src/services/planAccess');
jest.mock('../src/db/postgres');
const planAccess = require('../src/services/planAccess');
const pool = require('../src/db/postgres');
const { requireCapability, requireActiveUser } = require('../src/middleware/planGuard');

function mockRes() {
  return { statusCode: 0, body: null, status(c){ this.statusCode=c; return this; }, json(b){ this.body=b; return this; } };
}

describe('planGuard middleware', () => {
  describe('requireCapability', () => {
    test('requireCapability libera quando tem', async () => {
      planAccess.hasCapability.mockResolvedValue(true);
      const res = mockRes(); const next = jest.fn();
      await requireCapability('menu_sync')({ user: { plan: 'pro' } }, res, next);
      expect(next).toHaveBeenCalled();
    });

    test('requireCapability bloqueia com 403 quando não tem', async () => {
      planAccess.hasCapability.mockResolvedValue(false);
      const res = mockRes(); const next = jest.fn();
      await requireCapability('menu_sync')({ user: { plan: 'free' } }, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
      expect(res.body.error).toBe('plan_upgrade_required');
      expect(res.body.capability).toBe('menu_sync');
    });

    test('requireCapability retorna 500 em erro', async () => {
      planAccess.hasCapability.mockRejectedValue(new Error('DB error'));
      const res = mockRes(); const next = jest.fn();
      await requireCapability('menu_sync')({ user: { plan: 'pro' } }, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(500);
      expect(res.body.error).toBe('plan_check_failed');
    });
  });

  describe('requireActiveUser', () => {
    test('requireActiveUser libera usuário ativo', async () => {
      pool.query.mockResolvedValue({
        rows: [{ active: true, plan: 'pro', plan_expires_at: null }]
      });
      const res = mockRes(); const next = jest.fn();
      await requireActiveUser({ user: { id: 1 } }, res, next);
      expect(next).toHaveBeenCalled();
    });

    test('requireActiveUser bloqueia usuário inativo', async () => {
      pool.query.mockResolvedValue({
        rows: [{ active: false, plan: 'pro', plan_expires_at: null }]
      });
      const res = mockRes(); const next = jest.fn();
      await requireActiveUser({ user: { id: 1 } }, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
      expect(res.body.error).toBe('account_inactive');
    });

    test('requireActiveUser bloqueia trial expirado', async () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      pool.query.mockResolvedValue({
        rows: [{ active: true, plan: 'free', plan_expires_at: yesterday.toISOString() }]
      });
      const res = mockRes(); const next = jest.fn();
      await requireActiveUser({ user: { id: 1 } }, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
      expect(res.body.error).toBe('trial_expired');
    });

    test('requireActiveUser libera trial ativo', async () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      pool.query.mockResolvedValue({
        rows: [{ active: true, plan: 'free', plan_expires_at: tomorrow.toISOString() }]
      });
      const res = mockRes(); const next = jest.fn();
      await requireActiveUser({ user: { id: 1 } }, res, next);
      expect(next).toHaveBeenCalled();
    });

    test('requireActiveUser retorna 500 em erro', async () => {
      pool.query.mockRejectedValue(new Error('DB error'));
      const res = mockRes(); const next = jest.fn();
      await requireActiveUser({ user: { id: 1 } }, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(500);
      expect(res.body.error).toBe('account_check_failed');
    });
  });
});
