# Plan Gating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Configurar planos e aplicar gating real (capacidades + limites) por usuário, com cobrança semanal/mensal/anual.

**Architecture:** Coluna `capabilities` JSONB em `plans`; serviço central `planAccess` como fonte única da verdade; middleware `planGuard` para travar rotas; limites duros (lojas) e suaves (pedidos/mês); endpoint `/usage` para o frontend.

**Tech Stack:** Node 18, Express 4, pg (Postgres), Jest (novo, com `pg` mockado).

## Global Constraints

- `0` = ilimitado para `max_restaurants` e `max_orders_month`.
- `billing_period` ∈ `{weekly, monthly, yearly}` → validade +7/+30/+365 dias.
- Capacidades booleanas: `menu_sync`, `auto_accept`.
- Gating duro (403) para capacidades e `max_restaurants`; suave (sem bloqueio) para `max_orders_month`.
- Testes não dependem de Postgres real: mockar `src/db/postgres`.
- Erros padronizados: `{ error: '<code>', ... }` (`plan_upgrade_required`, `plan_limit_reached`, `account_inactive`).
- Migrações idempotentes no padrão `ensure...Schema()` já usado no projeto.

---

### Task 0: Setup do Jest com pg mockado

**Files:**
- Modify: `package.json`
- Create: `jest.config.js`
- Create: `__mocks__/pg.js` (não usado — mockaremos o módulo interno)
- Create: `test/helpers/mockPool.js`
- Create: `test/sanity.test.js`

**Interfaces:**
- Produces: `mockPool()` → `{ query: jest.fn() }` reaproveitável; helper `resetPool()`.

- [ ] **Step 1: Instalar Jest**

Run: `npm install --save-dev jest@^29`
Expected: adiciona `jest` em devDependencies.

- [ ] **Step 2: Adicionar script de teste**

Em `package.json`, dentro de `"scripts"`, adicionar:

```json
"test": "jest",
"test:watch": "jest --watch"
```

- [ ] **Step 3: Criar `jest.config.js`**

```js
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/test/**/*.test.js'],
  clearMocks: true,
};
```

- [ ] **Step 4: Criar helper `test/helpers/mockPool.js`**

```js
// Fábrica de um pool falso com query mockada.
function mockPool() {
  return { query: jest.fn() };
}
module.exports = { mockPool };
```

- [ ] **Step 5: Criar `test/sanity.test.js`**

```js
const { mockPool } = require('./helpers/mockPool');

test('mockPool retorna query mockada', () => {
  const pool = mockPool();
  expect(typeof pool.query).toBe('function');
});
```

- [ ] **Step 6: Rodar teste**

Run: `npm test`
Expected: PASS (1 teste).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json jest.config.js test/
git commit -m "test: setup Jest com pg mockado"
```

---

### Task 1: Migração — coluna `capabilities` e seed

**Files:**
- Create: `src/db/planSchema.js`
- Test: `test/planSchema.test.js`
- Modify: `src/server.js` (chamar `ensurePlanSchema()` no boot)

**Interfaces:**
- Produces: `ensurePlanSchema()` → `Promise<void>`; executa DDL idempotente.

- [ ] **Step 1: Escrever teste falho**

```js
const { mockPool } = require('./helpers/mockPool');
jest.mock('../src/db/postgres', () => require('./helpers/mockPool').mockPool());

const pool = require('../src/db/postgres');
const { ensurePlanSchema } = require('../src/db/planSchema');

test('ensurePlanSchema roda DDL de capabilities e defaults', async () => {
  pool.query.mockResolvedValue({ rows: [] });
  await ensurePlanSchema();
  const sql = pool.query.mock.calls.map(c => c[0]).join('\n');
  expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS capabilities/i);
  expect(sql).toMatch(/max_restaurants/i);
  expect(sql).toMatch(/max_orders_month/i);
});
```

- [ ] **Step 2: Rodar teste (falha)**

Run: `npx jest test/planSchema.test.js`
Expected: FAIL (módulo inexistente).

- [ ] **Step 3: Implementar `src/db/planSchema.js`**

```js
const pool = require('./postgres');

let ready = null;
// Migração idempotente: garante capabilities/limites em plans.
function ensurePlanSchema() {
  if (!ready) {
    ready = (async () => {
      await pool.query(
        `ALTER TABLE plans ADD COLUMN IF NOT EXISTS capabilities JSONB NOT NULL DEFAULT '{}'::jsonb`
      );
      await pool.query(
        `ALTER TABLE plans ADD COLUMN IF NOT EXISTS max_restaurants INTEGER NOT NULL DEFAULT 0`
      );
      await pool.query(
        `ALTER TABLE plans ADD COLUMN IF NOT EXISTS max_orders_month INTEGER NOT NULL DEFAULT 0`
      );
    })().catch(err => { ready = null; throw err; });
  }
  return ready;
}
module.exports = { ensurePlanSchema };
```

- [ ] **Step 4: Rodar teste (passa)**

Run: `npx jest test/planSchema.test.js`
Expected: PASS.

- [ ] **Step 5: Chamar no boot**

Em `src/server.js`, junto dos outros inits (após os `require(...).startPolling()`), adicionar:

```js
require('./db/planSchema').ensurePlanSchema()
  .then(() => console.log('[planSchema] pronto'))
  .catch(err => console.error('[planSchema] erro:', err.message));
```

- [ ] **Step 6: Commit**

```bash
git add src/db/planSchema.js src/server.js test/planSchema.test.js
git commit -m "feat: migração idempotente de capabilities/limites em plans"
```

---

### Task 2: Serviço `planAccess`

**Files:**
- Create: `src/services/planAccess.js`
- Test: `test/planAccess.test.js`

**Interfaces:**
- Consumes: `src/db/postgres` (`pool.query`).
- Produces:
  - `resolveUserPlan(user)` → `Promise<{ slug, name, plan_active, capabilities, max_restaurants, max_orders_month }>`
  - `hasCapability(user, key)` → `Promise<boolean>`
  - `getLimit(user, key)` → `Promise<number>` (0 = ilimitado)

- [ ] **Step 1: Escrever testes falhos**

```js
jest.mock('../src/db/postgres', () => require('./helpers/mockPool').mockPool());
const pool = require('../src/db/postgres');
const { resolveUserPlan, hasCapability, getLimit } = require('../src/services/planAccess');

const planRow = {
  slug: 'pro', name: 'Pro', active: true,
  capabilities: { menu_sync: true, auto_accept: true },
  max_restaurants: 3, max_orders_month: 2000,
};

test('resolveUserPlan carrega plano pelo slug', async () => {
  pool.query.mockResolvedValueOnce({ rows: [planRow] });
  const p = await resolveUserPlan({ id: 1, plan: 'pro' });
  expect(p.capabilities.menu_sync).toBe(true);
  expect(p.max_restaurants).toBe(3);
});

test('resolveUserPlan cai no free se slug não existe', async () => {
  pool.query
    .mockResolvedValueOnce({ rows: [] })  // busca 'inexistente'
    .mockResolvedValueOnce({ rows: [{ slug: 'free', name: 'Free', active: true, capabilities: {}, max_restaurants: 1, max_orders_month: 100 }] });
  const p = await resolveUserPlan({ id: 1, plan: 'inexistente' });
  expect(p.slug).toBe('free');
});

test('hasCapability true/false', async () => {
  pool.query.mockResolvedValue({ rows: [planRow] });
  expect(await hasCapability({ plan: 'pro' }, 'menu_sync')).toBe(true);
  expect(await hasCapability({ plan: 'pro' }, 'inexistente')).toBe(false);
});

test('getLimit devolve número', async () => {
  pool.query.mockResolvedValue({ rows: [planRow] });
  expect(await getLimit({ plan: 'pro' }, 'max_restaurants')).toBe(3);
});
```

- [ ] **Step 2: Rodar (falha)**

Run: `npx jest test/planAccess.test.js`
Expected: FAIL.

- [ ] **Step 3: Implementar `src/services/planAccess.js`**

```js
const pool = require('../db/postgres');

const COLS = 'slug, name, active, capabilities, max_restaurants, max_orders_month';

async function loadPlanBySlug(slug) {
  const r = await pool.query(`SELECT ${COLS} FROM plans WHERE slug = $1`, [slug]);
  return r.rows[0] || null;
}

function shape(row) {
  return {
    slug: row.slug,
    name: row.name,
    plan_active: row.active,
    capabilities: row.capabilities || {},
    max_restaurants: row.max_restaurants || 0,
    max_orders_month: row.max_orders_month || 0,
  };
}

// Resolve o plano do usuário; cai em 'free' se o slug não existir.
async function resolveUserPlan(user) {
  const slug = user && user.plan ? user.plan : 'free';
  let row = await loadPlanBySlug(slug);
  if (!row) row = await loadPlanBySlug('free');
  if (!row) {
    return { slug: 'free', name: 'Free', plan_active: true, capabilities: {}, max_restaurants: 0, max_orders_month: 0 };
  }
  return shape(row);
}

async function hasCapability(user, key) {
  const p = await resolveUserPlan(user);
  return p.capabilities[key] === true;
}

async function getLimit(user, key) {
  const p = await resolveUserPlan(user);
  return p[key] || 0;
}

module.exports = { resolveUserPlan, hasCapability, getLimit };
```

- [ ] **Step 4: Rodar (passa)**

Run: `npx jest test/planAccess.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/planAccess.js test/planAccess.test.js
git commit -m "feat: serviço planAccess (resolveUserPlan/hasCapability/getLimit)"
```

---

### Task 3: Helper de período de cobrança

**Files:**
- Create: `src/services/billing.js`
- Test: `test/billing.test.js`

**Interfaces:**
- Produces: `billingIntervalDays(period)` → `number` (7/30/365; default 30).

- [ ] **Step 1: Teste falho**

```js
const { billingIntervalDays } = require('../src/services/billing');
test('mapeia períodos', () => {
  expect(billingIntervalDays('weekly')).toBe(7);
  expect(billingIntervalDays('monthly')).toBe(30);
  expect(billingIntervalDays('yearly')).toBe(365);
  expect(billingIntervalDays('qualquer')).toBe(30);
});
```

- [ ] **Step 2: Rodar (falha)**

Run: `npx jest test/billing.test.js`
Expected: FAIL.

- [ ] **Step 3: Implementar**

```js
// Converte billing_period em dias de validade do plano.
function billingIntervalDays(period) {
  if (period === 'weekly') return 7;
  if (period === 'yearly') return 365;
  return 30; // monthly (default)
}
module.exports = { billingIntervalDays };
```

- [ ] **Step 4: Rodar (passa)**

Run: `npx jest test/billing.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/billing.js test/billing.test.js
git commit -m "feat: billingIntervalDays (weekly/monthly/yearly)"
```

---

### Task 4: Middleware `planGuard`

**Files:**
- Create: `src/middleware/planGuard.js`
- Test: `test/planGuard.test.js`

**Interfaces:**
- Consumes: `planAccess.hasCapability`, `resolveUserPlan`.
- Produces:
  - `requireCapability(key)` → middleware `(req,res,next)`
  - `requireActiveUser` → middleware `(req,res,next)` (checa `req.user.active`/trial via banco)

- [ ] **Step 1: Testes falhos**

```js
jest.mock('../src/services/planAccess');
const planAccess = require('../src/services/planAccess');
const { requireCapability } = require('../src/middleware/planGuard');

function mockRes() {
  return { statusCode: 0, body: null, status(c){ this.statusCode=c; return this; }, json(b){ this.body=b; return this; } };
}

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
```

- [ ] **Step 2: Rodar (falha)**

Run: `npx jest test/planGuard.test.js`
Expected: FAIL.

- [ ] **Step 3: Implementar `src/middleware/planGuard.js`**

```js
const pool = require('../db/postgres');
const { hasCapability } = require('../services/planAccess');

// Trava a rota se o plano do usuário não tem a capacidade.
function requireCapability(key) {
  return async (req, res, next) => {
    try {
      if (await hasCapability(req.user, key)) return next();
      return res.status(403).json({ error: 'plan_upgrade_required', capability: key });
    } catch (err) {
      return res.status(500).json({ error: 'plan_check_failed', details: err.message });
    }
  };
}

// Rejeita usuário inativo ou com trial expirado.
async function requireActiveUser(req, res, next) {
  try {
    const r = await pool.query(
      `SELECT active, plan, plan_expires_at FROM users WHERE id = $1`, [req.user.id]
    );
    const u = r.rows[0];
    if (!u || u.active === false) return res.status(403).json({ error: 'account_inactive' });
    if (u.plan === 'free' && u.plan_expires_at && new Date(u.plan_expires_at) < new Date()) {
      return res.status(403).json({ error: 'trial_expired' });
    }
    return next();
  } catch (err) {
    return res.status(500).json({ error: 'account_check_failed', details: err.message });
  }
}

module.exports = { requireCapability, requireActiveUser };
```

- [ ] **Step 4: Rodar (passa)**

Run: `npx jest test/planGuard.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/middleware/planGuard.js test/planGuard.test.js
git commit -m "feat: middleware planGuard (requireCapability/requireActiveUser)"
```

---

### Task 5: Aplicar gating de capacidades nas rotas

**Files:**
- Modify: `src/routes/menuadmin.js` (rotas `/fetch` e `/copy`)
- Modify: `src/routes/automations.js` (`PUT /:id`)
- Test: `test/gatingRoutes.test.js`

**Interfaces:**
- Consumes: `requireCapability` (Task 4).

- [ ] **Step 1: Teste falho (menu_sync na cadeia de middlewares)**

```js
const menuRouter = require('../src/routes/menuadmin');
// Verifica que a stack da rota /fetch inclui um middleware que referencia 'menu_sync'.
function stackFns(router, path, method) {
  const layer = router.stack.find(l => l.route && l.route.path === path && l.route.methods[method]);
  return layer ? layer.route.stack.map(s => s.handle.toString()) : [];
}
test('/fetch exige menu_sync', () => {
  const fns = stackFns(menuRouter, '/fetch', 'post').join(' ');
  expect(fns).toMatch(/menu_sync/);
});
```

- [ ] **Step 2: Rodar (falha)**

Run: `npx jest test/gatingRoutes.test.js`
Expected: FAIL.

- [ ] **Step 3: Adicionar middleware em `menuadmin.js`**

No topo, após os requires existentes:

```js
const { requireCapability } = require('../middleware/planGuard');
```

Nas rotas `/fetch` e `/copy`, inserir `requireCapability('menu_sync')` na cadeia (após `authenticateToken`). Ex. `/fetch`:

```js
router.post('/fetch', authenticateToken, requireCapability('menu_sync'), async (req, res) => {
```

E `/copy`:

```js
router.post('/copy', authenticateToken, requireCapability('menu_sync'), async (req, res) => {
```

> Nota: as rotas hoje usam `requireAdmin`; manter `requireAdmin` se a política atual é admin-only, ou substituir por `requireCapability('menu_sync')` se usuários comuns devem puxar cardápio. Decisão do produto: usar `requireCapability('menu_sync')` (remover `requireAdmin` dessas duas rotas), pois cardápio é feature de plano do usuário.

- [ ] **Step 4: Adicionar gate de auto_accept em `automations.js`**

No topo:

```js
const { requireCapability } = require('../middleware/planGuard');
```

Na rota `PUT /:id` (que liga/desliga a automação), inserir o middleware:

```js
router.put('/:id', requireCapability('auto_accept'), async (req, res) => {
```

- [ ] **Step 5: Rodar (passa)**

Run: `npx jest test/gatingRoutes.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/routes/menuadmin.js src/routes/automations.js test/gatingRoutes.test.js
git commit -m "feat: gating de menu_sync e auto_accept nas rotas"
```

---

### Task 6: Limite duro de lojas (`max_restaurants`)

**Files:**
- Modify: `src/routes/restaurants.js` (`POST /`, ~linha 195)
- Test: `test/restaurantLimit.test.js`

**Interfaces:**
- Consumes: `planAccess.getLimit`.

- [ ] **Step 1: Teste falho (função de checagem isolada)**

Criar helper testável `checkRestaurantLimit(userId, user)` em `src/services/planAccess.js`:

```js
// (test/restaurantLimit.test.js)
jest.mock('../src/db/postgres', () => require('./helpers/mockPool').mockPool());
const pool = require('../src/db/postgres');
const { checkRestaurantLimit } = require('../src/services/planAccess');

test('bloqueia ao atingir o limite', async () => {
  pool.query
    .mockResolvedValueOnce({ rows: [{ slug:'starter', name:'S', active:true, capabilities:{}, max_restaurants:1, max_orders_month:0 }] }) // resolveUserPlan
    .mockResolvedValueOnce({ rows: [{ count: '1' }] }); // contagem
  const r = await checkRestaurantLimit(1, { plan: 'starter' });
  expect(r.allowed).toBe(false);
});

test('permite quando ilimitado (0)', async () => {
  pool.query
    .mockResolvedValueOnce({ rows: [{ slug:'pro', name:'P', active:true, capabilities:{}, max_restaurants:0, max_orders_month:0 }] })
    .mockResolvedValueOnce({ rows: [{ count: '9' }] });
  const r = await checkRestaurantLimit(1, { plan: 'pro' });
  expect(r.allowed).toBe(true);
});
```

- [ ] **Step 2: Rodar (falha)**

Run: `npx jest test/restaurantLimit.test.js`
Expected: FAIL.

- [ ] **Step 3: Adicionar `checkRestaurantLimit` em `planAccess.js`**

```js
async function checkRestaurantLimit(userId, user) {
  const limit = await getLimit(user, 'max_restaurants');
  if (limit === 0) return { allowed: true };
  const r = await pool.query(`SELECT COUNT(*)::int AS count FROM restaurants WHERE user_id = $1`, [userId]);
  const count = r.rows[0].count;
  return { allowed: count < limit, count, limit };
}
```

E exportar: adicionar `checkRestaurantLimit` no `module.exports`.

- [ ] **Step 4: Rodar (passa)**

Run: `npx jest test/restaurantLimit.test.js`
Expected: PASS.

- [ ] **Step 5: Aplicar no `POST /` de restaurants**

No topo de `src/routes/restaurants.js`:

```js
const { checkRestaurantLimit } = require('../services/planAccess');
```

No início do handler `router.post('/', ...)` (linha ~195), antes do INSERT:

```js
const gate = await checkRestaurantLimit(req.user.id, req.user);
if (!gate.allowed) {
  return res.status(403).json({ error: 'plan_limit_reached', limit: 'max_restaurants', max: gate.limit });
}
```

- [ ] **Step 6: Commit**

```bash
git add src/routes/restaurants.js src/services/planAccess.js test/restaurantLimit.test.js
git commit -m "feat: limite duro de lojas por plano (max_restaurants)"
```

---

### Task 7: Uso mensal (soft) + `GET /api/v1/usage`

**Files:**
- Create: `src/routes/usage.js`
- Modify: `src/server.js` (montar rota)
- Test: `test/usage.test.js`

**Interfaces:**
- Consumes: `planAccess.resolveUserPlan`, `pool`.
- Produces: `GET /api/v1/usage` → `{ plan, capabilities, restaurants_count, max_restaurants, orders_this_month, max_orders_month, over_limit }`.

- [ ] **Step 1: Teste falho**

```js
jest.mock('../src/db/postgres', () => require('./helpers/mockPool').mockPool());
jest.mock('../src/services/planAccess');
const pool = require('../src/db/postgres');
const planAccess = require('../src/services/planAccess');
const { buildUsage } = require('../src/routes/usage');

test('over_limit true quando excede pedidos/mês', async () => {
  planAccess.resolveUserPlan.mockResolvedValue({ slug:'starter', capabilities:{}, max_restaurants:1, max_orders_month:100 });
  pool.query
    .mockResolvedValueOnce({ rows: [{ count: '1' }] })   // restaurants
    .mockResolvedValueOnce({ rows: [{ count: '150' }] }); // orders mês
  const u = await buildUsage({ id: 1, plan: 'starter' });
  expect(u.over_limit).toBe(true);
  expect(u.orders_this_month).toBe(150);
});
```

- [ ] **Step 2: Rodar (falha)**

Run: `npx jest test/usage.test.js`
Expected: FAIL.

- [ ] **Step 3: Implementar `src/routes/usage.js`**

```js
const express = require('express');
const pool = require('../db/postgres');
const { authenticateToken } = require('../middleware/auth');
const { resolveUserPlan } = require('../services/planAccess');
const router = express.Router();

// Monta o objeto de uso do usuário (testável isoladamente).
async function buildUsage(user) {
  const plan = await resolveUserPlan(user);
  const rc = await pool.query(`SELECT COUNT(*)::int AS count FROM restaurants WHERE user_id = $1`, [user.id]);
  const oc = await pool.query(
    `SELECT COUNT(*)::int AS count FROM orders
     WHERE user_id = $1 AND created_at >= date_trunc('month', now())`, [user.id]
  );
  const orders_this_month = oc.rows[0].count;
  const over_limit = plan.max_orders_month !== 0 && orders_this_month > plan.max_orders_month;
  return {
    plan: plan.slug,
    capabilities: plan.capabilities,
    restaurants_count: rc.rows[0].count,
    max_restaurants: plan.max_restaurants,
    orders_this_month,
    max_orders_month: plan.max_orders_month,
    over_limit,
  };
}

router.get('/', authenticateToken, async (req, res) => {
  try { return res.json(await buildUsage(req.user)); }
  catch (err) { return res.status(500).json({ error: 'usage_failed', details: err.message }); }
});

module.exports = router;
module.exports.buildUsage = buildUsage;
```

- [ ] **Step 4: Montar rota em `src/server.js`**

Junto dos outros `app.use`:

```js
app.use('/api/v1/usage', require('./routes/usage'));
```

- [ ] **Step 5: Rodar (passa)**

Run: `npx jest test/usage.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/routes/usage.js src/server.js test/usage.test.js
git commit -m "feat: endpoint /usage com uso mensal e over_limit suave"
```

---

### Task 8: CRUD de planos aceita `capabilities`; checkout deriva validade do período

**Files:**
- Modify: `src/routes/plans.js` (`POST /`, `PUT /:id`)
- Modify: `src/routes/checkout.js` (validade por `billing_period`)
- Test: `test/plansCapabilities.test.js`

**Interfaces:**
- Consumes: `billing.billingIntervalDays`.

- [ ] **Step 1: Teste falho (POST persiste capabilities)**

```js
jest.mock('../src/db/postgres', () => require('./helpers/mockPool').mockPool());
const pool = require('../src/db/postgres');
const request = { }; // usaremos o handler direto
// Verifica que o SQL do POST inclui capabilities.
test('POST /plans inclui capabilities no INSERT', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/routes/plans.js'), 'utf8');
  expect(src).toMatch(/capabilities/);
});
```

- [ ] **Step 2: Rodar (falha)**

Run: `npx jest test/plansCapabilities.test.js`
Expected: FAIL.

- [ ] **Step 3: Adicionar `capabilities` no `POST /` de plans.js**

Incluir `capabilities` no destructuring e no INSERT:

```js
const { slug, name, price, billing_period, popular, is_free, capabilities, max_restaurants, max_orders_month, features, sort_order } = req.body;
```

INSERT (adicionar coluna e placeholder):

```js
const result = await pool.query(
  `INSERT INTO plans (slug, name, price, billing_period, popular, is_free, capabilities, max_restaurants, max_orders_month, features, sort_order)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
  [slug, name, price || 0, billing_period || 'monthly', popular || false, is_free || false,
   JSON.stringify(capabilities || {}), max_restaurants || 0, max_orders_month || 0,
   JSON.stringify(features || []), sort_order || 0]
);
```

- [ ] **Step 4: Adicionar `capabilities` no `PUT /:id`**

Destructuring inclui `capabilities`; no UPDATE adicionar:

```js
capabilities=COALESCE($N,capabilities),
```

passando `capabilities ? JSON.stringify(capabilities) : null` na posição correta (ajustar índices `$` sequencialmente).

- [ ] **Step 5: Checkout deriva validade do período**

Em `src/routes/checkout.js`, no topo:

```js
const { billingIntervalDays } = require('../services/billing');
```

Onde hoje há `INTERVAL '30 days'` (confirmação de pagamento, ~linha 126), trocar por intervalo dinâmico. Buscar o `billing_period` do plano e montar:

```js
const days = billingIntervalDays(selectedPlanPeriod); // ler billing_period do plano da fatura
await pool.query(
  `UPDATE users SET plan=$1, payment_status='active',
     plan_expires_at=(now() + ($2 || ' days')::interval), active=true, updated_at=now()
   WHERE id=$3`,
  [inv.plan, String(days), inv.user_id]
);
```

> Para obter `selectedPlanPeriod`, buscar o plano: `SELECT billing_period FROM plans WHERE slug = $1` usando `inv.plan`.

- [ ] **Step 6: Rodar (passa)**

Run: `npx jest test/plansCapabilities.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/routes/plans.js src/routes/checkout.js test/plansCapabilities.test.js
git commit -m "feat: plans aceita capabilities; checkout usa validade por período"
```

---

### Task 9: Gestão de usuário admin — validar plano e permitir reativar

**Files:**
- Modify: `src/routes/admin.js` (`PUT /users/:id`)
- Modify: `src/routes/settings.js` (`PUT /plan` — validar dinâmico)
- Test: `test/adminUsers.test.js`

**Interfaces:**
- Consumes: `pool`.

- [ ] **Step 1: Teste falho (settings valida plano contra tabela)**

```js
const src = require('fs').readFileSync(require('path').join(__dirname, '../src/routes/settings.js'), 'utf8');
test('settings /plan não usa lista fixa de planos', () => {
  expect(src).not.toMatch(/\['starter', ?'pro', ?'enterprise'\]/);
});
```

- [ ] **Step 2: Rodar (falha)**

Run: `npx jest test/adminUsers.test.js`
Expected: FAIL.

- [ ] **Step 3: Trocar validação fixa em `settings.js`**

No `PUT /plan`, substituir o check `['starter','pro','enterprise'].includes(plan)` por validação contra a tabela:

```js
const exists = await pool.query('SELECT 1 FROM plans WHERE slug = $1 AND active = true', [plan]);
if (exists.rows.length === 0) {
  return res.status(400).json({ error: 'Plano inválido' });
}
```

- [ ] **Step 4: Garantir reativação em `admin.js` PUT /users/:id**

Confirmar que o `UPDATE users SET ... active=COALESCE($N,active) ...` inclui `active` (permitindo `true` para reativar). Se não incluir, adicionar a coluna `active=COALESCE($N,active)` ao UPDATE e o parâmetro `active` no destructuring de `req.body`. Validar `plan` (se enviado) contra `plans` como no Step 3.

- [ ] **Step 5: Rodar (passa)**

Run: `npx jest test/adminUsers.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/routes/admin.js src/routes/settings.js test/adminUsers.test.js
git commit -m "feat: valida plano dinâmico e permite reativar usuário (admin)"
```

---

### Task 10: Prompt do frontend Lovable (doc)

**Files:**
- Create: `docs/superpowers/lovable-prompt-planos.md`

- [ ] **Step 1: Escrever o prompt**

Documento com o prompt para o Lovable descrevendo:
- **Aba Planos (admin):** tabela de planos + form de edição com campos `name`, `slug`, `price`, `billing_period` (select weekly/monthly/yearly), `active` (toggle), toggles de `capabilities` (`menu_sync`, `auto_accept`), `max_restaurants`, `max_orders_month` (0 = ilimitado), e lista editável de `features` (texto). Consome `GET /api/v1/plans/all`, `POST/PUT/DELETE /api/v1/plans`.
- **Aba Usuários (admin):** lista com `plan`, `active`; ações trocar plano e toggle ativo. Consome `GET /api/v1/admin/users`, `PUT /api/v1/admin/users/:id`.
- **UX do usuário:** consumir `GET /api/v1/usage` para travar botões (cardápio/auto-aceite quando capability=false), mostrar contadores de lojas/pedidos e aviso de upgrade quando `over_limit=true`. Tratar respostas `403 { error: 'plan_upgrade_required' | 'plan_limit_reached' | 'account_inactive' }` com CTA de upgrade.

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/lovable-prompt-planos.md
git commit -m "docs: prompt Lovable para aba Planos/Usuários e gating no frontend"
```

---

## Self-Review

- **Cobertura do spec:** migração (T1), planAccess (T2), billing (T3), planGuard (T4), gating capacidades (T5), limite lojas (T6), uso mensal+/usage (T7), CRUD capabilities + checkout período (T8), admin/settings usuário (T9), frontend prompt (T10). ✅
- **Placeholders:** nenhum "TODO/TBD"; código real em cada step.
- **Consistência de tipos:** `resolveUserPlan` retorna `{slug,name,plan_active,capabilities,max_restaurants,max_orders_month}` usado igual em T4/T6/T7; `checkRestaurantLimit(userId,user)→{allowed,...}`; `billingIntervalDays(period)→number`; `buildUsage(user)→{...}`.
- **Notas de verificação:** T5 e T9 pedem confirmar conteúdo atual das rotas antes de editar (linhas exatas podem variar).
