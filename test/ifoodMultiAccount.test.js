// Multi-conta iFood: um usuário pode ter VÁRIOS acessos (contas iFood), e cada
// loja (merchant) usa o token do SEU acesso. Verifica a resolução de token por
// merchant, a listagem de autorizações (poller) e as ações de pedido usando o
// merchant certo.
process.env.PLAN_GATING_ENABLED = 'false';
process.env.IFOOD_CLIENT_ID = 'cid';
process.env.IFOOD_CLIENT_SECRET = 'csecret';

jest.mock('../src/db/postgres', () => require('./helpers/mockPool').mockPool());

const pool = require('../src/db/postgres');
const ifood = require('../src/services/ifood-distributed');

const futuro = () => new Date(Date.now() + 3600 * 1000);

// ensureSchema é memoizado (roda só uma vez). "Aquece" aqui pra que, nos
// testes, as chamadas de schema não consumam os mocks das queries de dados.
beforeAll(async () => {
  pool.query.mockResolvedValue({ rows: [] });
  await ifood.listAuthorizations(); // dispara ensureSchema uma vez (tolera vazio)
});

beforeEach(() => {
  pool.query.mockReset();
  pool.query.mockResolvedValue({ rows: [] }); // default p/ queries não especificadas
});

test('getAccessTokenByMerchant usa o acesso vinculado à loja (token válido em cache)', async () => {
  pool.query.mockResolvedValueOnce({
    rows: [{ id: 10, access_token: 'TOKEN_LOJA_A', refresh_token: 'r', expires_at: futuro() }],
  });
  const token = await ifood.getAccessTokenByMerchant('MERCH_A');
  expect(token).toBe('TOKEN_LOJA_A');
});

test('lojas de contas diferentes resolvem tokens diferentes', async () => {
  pool.query.mockResolvedValueOnce({ rows: [{ id: 1, access_token: 'TOK_A', refresh_token: 'ra', expires_at: futuro() }] });
  const a = await ifood.getAccessTokenByMerchant('MERCH_A');

  pool.query.mockResolvedValueOnce({ rows: [{ id: 2, access_token: 'TOK_B', refresh_token: 'rb', expires_at: futuro() }] });
  const b = await ifood.getAccessTokenByMerchant('MERCH_B');

  expect(a).toBe('TOK_A');
  expect(b).toBe('TOK_B');
  expect(a).not.toBe(b);
});

test('getAccessTokenByMerchant cai para acesso do usuário quando loja não tem vínculo', async () => {
  // 1º SELECT (por ifood_auth_id) vazio -> fallback; 2º (por user_id) acha
  pool.query
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ id: 7, access_token: 'TOK_FALLBACK', refresh_token: 'r', expires_at: futuro() }] });
  const token = await ifood.getAccessTokenByMerchant('MERCH_SEM_VINCULO');
  expect(token).toBe('TOK_FALLBACK');
});

test('loja sem nenhum acesso -> erro claro', async () => {
  pool.query
    .mockResolvedValueOnce({ rows: [] })  // por ifood_auth_id
    .mockResolvedValueOnce({ rows: [] }); // por user_id
  await expect(ifood.getAccessTokenByMerchant('MERCH_X')).rejects.toThrow(/sem acesso autorizado/i);
});

test('listAuthorizations retorna todas as autorizações válidas (para o poller)', async () => {
  pool.query.mockResolvedValueOnce({
    rows: [{ id: 1, user_id: 'u1' }, { id: 2, user_id: 'u1' }, { id: 3, user_id: 'u2' }],
  });
  const auths = await ifood.listAuthorizations();
  expect(auths).toHaveLength(3);
  expect(auths.map(a => a.id)).toEqual([1, 2, 3]);
});

test('countAuthorizations conta acessos do usuário', async () => {
  pool.query.mockResolvedValueOnce({ rows: [{ n: 2 }] });
  const n = await ifood.countAuthorizations('u1');
  expect(n).toBe(2);
});
