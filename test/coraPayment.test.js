// Pagamento via Cora: liberação do plano + config + webhook.
process.env.TRIAL_DAYS = process.env.TRIAL_DAYS || '3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-com-mais-de-32-caracteres-aqui-ok';

jest.mock('../src/db/postgres', () => require('./helpers/mockPool').mockPool());

const pool = require('../src/db/postgres');

beforeEach(() => { pool.query.mockReset(); delete process.env.CORA_CLIENT_ID; delete process.env.CORA_CERT; delete process.env.CORA_KEY; });

describe('cora.isConfigured', () => {
  test('false sem credenciais, true com as três', () => {
    jest.resetModules();
    let cora = require('../src/services/cora');
    expect(cora.isConfigured()).toBe(false);
    process.env.CORA_CLIENT_ID = 'int-x';
    process.env.CORA_CERT = '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----';
    process.env.CORA_KEY = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----';
    expect(cora.isConfigured()).toBe(true);
  });
});

describe('markInvoicePaidAndActivate', () => {
  const { markInvoicePaidAndActivate } = require('../src/services/planActivation');

  test('libera o plano e calcula validade pelo ciclo (mensal=30)', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 5, status: 'pending', user_id: 'u1', plan: 'pro' }] }) // SELECT invoice
      .mockResolvedValueOnce({ rows: [] })                                                          // UPDATE invoice
      .mockResolvedValueOnce({ rows: [{ billing_period: 'monthly', is_free: false }] })             // SELECT plan
      .mockResolvedValueOnce({ rows: [] })                                                          // UPDATE user
      .mockResolvedValueOnce({ rows: [] });                                                         // create_user_defaults

    const r = await markInvoicePaidAndActivate(5, 'cora-123');
    expect(r.ok).toBe(true);
    expect(r.days).toBe(30);
    const updateUserSql = pool.query.mock.calls[3][0];
    expect(updateUserSql).toMatch(/payment_status='active'/);
    expect(updateUserSql).toMatch(/plan_expires_at/);
  });

  test('fatura já paga -> idempotente (não reprocessa)', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 5, status: 'paid', user_id: 'u1', plan: 'pro' }] });
    const r = await markInvoicePaidAndActivate(5, 'cora-123');
    expect(r.already_paid).toBe(true);
    expect(pool.query).toHaveBeenCalledTimes(1); // não fez UPDATE
  });
});
