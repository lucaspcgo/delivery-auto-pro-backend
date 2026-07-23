// Verificador de pagamento Cora: libera o plano quando a cobrança está PAID.
jest.mock('../src/db/postgres', () => require('./helpers/mockPool').mockPool());
jest.mock('../src/services/cora');
jest.mock('../src/services/planActivation');

const pool = require('../src/db/postgres');
const cora = require('../src/services/cora');
const { markInvoicePaidAndActivate } = require('../src/services/planActivation');
const { pollOnce } = require('../src/services/cora-payment-poller');

beforeEach(() => { pool.query.mockReset(); cora.isConfigured.mockReset(); cora.getInvoice.mockReset(); markInvoicePaidAndActivate.mockReset(); });

test('cobrança PAID -> libera o plano', async () => {
  cora.isConfigured.mockReturnValue(true);
  pool.query.mockResolvedValueOnce({ rows: [{ id: 10, gateway_transaction_id: 'cora-abc' }] });
  cora.getInvoice.mockResolvedValue({ status: 'PAID' });
  markInvoicePaidAndActivate.mockResolvedValue({ ok: true });

  await pollOnce();

  expect(cora.getInvoice).toHaveBeenCalledWith('cora-abc');
  expect(markInvoicePaidAndActivate).toHaveBeenCalledWith(10, 'cora-abc');
});

test('cobrança ainda OPEN -> não libera', async () => {
  cora.isConfigured.mockReturnValue(true);
  pool.query.mockResolvedValueOnce({ rows: [{ id: 10, gateway_transaction_id: 'cora-abc' }] });
  cora.getInvoice.mockResolvedValue({ status: 'OPEN' });

  await pollOnce();
  expect(markInvoicePaidAndActivate).not.toHaveBeenCalled();
});

test('Cora não configurado -> não faz nada', async () => {
  cora.isConfigured.mockReturnValue(false);
  await pollOnce();
  expect(pool.query).not.toHaveBeenCalled();
});
