process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);

const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../src/config/env');
const { authenticateToken } = require('../src/middleware/auth');

function mockRes() {
  return { statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

test('authenticateToken propaga plan e role do JWT para req.user', () => {
  const token = jwt.sign({ id: 1, email: 'a@b.com', is_admin: false, plan: 'pro' }, JWT_SECRET);
  const req = { headers: { authorization: `Bearer ${token}` } };
  const res = mockRes();
  const next = jest.fn();

  authenticateToken(req, res, next);

  expect(next).toHaveBeenCalled();
  expect(req.user.plan).toBe('pro');
  expect(req.user.id).toBe(1);
  expect(req.user.email).toBe('a@b.com');
});
