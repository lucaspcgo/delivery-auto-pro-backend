# Configuração e Gating de Planos — Design

**Data:** 2026-07-13
**Branch:** `feature/plan-gating`

## Objetivo

Permitir que o admin configure planos e que o sistema **aplique de verdade** (gating) o
que cada usuário pode usar, com base no plano. Três frentes:

1. **Vitrine** — lista de features exibida na página de planos (já existe).
2. **Gating** — travar/liberar recursos por plano (cardápio, auto-aceite) e aplicar
   limites (nº de lojas, pedidos/mês).
3. **Ativar/desativar usuário** — admin liga/desliga o acesso de um usuário.

Abordagem escolhida: **A — coluna `capabilities` estruturada + serviço central + middleware**.

## Estado atual (baseline)

- `users`: colunas `plan` (texto), `active` (bool), `payment_status`, `plan_expires_at`,
  `is_admin`, `role`.
- `plans`: `slug`, `name`, `price`, `billing_period`, `popular`, `is_free`, `active`,
  `max_restaurants`, `max_orders_month`, `features` (JSON de texto), `sort_order`.
- CRUD de planos completo em [src/routes/plans.js](../../../src/routes/plans.js) (admin).
- **Gaps:** `features` é só texto (sem gating); limites nunca são checados;
  `settings.js` valida `plan` contra lista fixa `['starter','pro','enterprise']`
  (diverge dos slugs reais em `plans`); não há endpoint admin pra gerir usuários;
  o check de `active`/trial está espalhado em `auth.js`.

## Convenções

- **Capacidades booleanas:** `menu_sync`, `auto_accept` (extensível).
- **Limites numéricos:** `max_restaurants`, `max_orders_month`. **`0` = ilimitado.**
- **Período de cobrança (`billing_period`):** `weekly`, `monthly`, `yearly`. Define o
  ciclo do plano e a validade (`plan_expires_at`): `weekly` = +7 dias, `monthly` = +30,
  `yearly` = +365. O admin escolhe o período ao editar o plano.
- **Gating duro** (bloqueia com 403): capacidades e `max_restaurants`.
- **Gating suave** (não bloqueia, só sinaliza): `max_orders_month` — nunca derruba
  pedido real.

## Componentes

### 1. Migração de dados

- `ALTER TABLE plans ADD COLUMN IF NOT EXISTS capabilities JSONB NOT NULL DEFAULT '{}'::jsonb`.
- Garantir que `max_restaurants` e `max_orders_month` existam (já referenciados no CRUD);
  criar com `DEFAULT 0` se faltar.
- Seed: preencher `capabilities` dos planos existentes (via UPDATE idempotente por slug)
  e garantir uma linha de plano `free` com as capabilities/limites do trial.
- Migração idempotente, no mesmo padrão de `ensureSchema()` já usado no projeto
  (ex: [ifood-distributed.js](../../../src/services/ifood-distributed.js)).

### 2. Serviço central — `src/services/planAccess.js`

Fonte única da verdade sobre o que um usuário pode fazer.

- `resolveUserPlan(user)` → `{ slug, name, plan_active, capabilities, max_restaurants,
  max_orders_month }`. Resolve pelo `users.plan` = `plans.slug`; se não achar, cai num
  plano default seguro (`free`).
- `hasCapability(user, key)` → bool.
- `getLimit(user, key)` → número (0 = ilimitado).
- Sem cache nesta primeira versão (consulta direta ao banco); ponto de extensão futuro.

### 3. Middleware de gating — `src/middleware/planGuard.js`

- `requireCapability(key)` → carrega o plano do usuário; se `capabilities[key] !== true`
  responde `403 { error: 'plan_upgrade_required', capability: key }`.
- `requireActiveUser` → centraliza o check de `users.active` e de trial expirado
  (hoje espalhado em `auth.js`); rejeita com mensagem clara.

Aplicação:
- `menu_sync` → rotas de cardápio em [src/routes/menuadmin.js](../../../src/routes/menuadmin.js).
- `auto_accept` → liga/desliga do auto-aceite em [src/routes/automations.js](../../../src/routes/automations.js).

### 4. Enforcement de limites

- **`max_restaurants` (duro):** no POST de criação de loja em
  [src/routes/restaurants.js](../../../src/routes/restaurants.js), contar as lojas do
  usuário; se `limite != 0 && count >= limite` → `403 { error: 'plan_limit_reached',
  limit: 'max_restaurants' }`.
- **`max_orders_month` (suave):** na ingestão de pedido (ponto compartilhado
  [src/services/ifood-events.js](../../../src/services/ifood-events.js) e
  webhook 99food), contar pedidos do mês do usuário; se exceder, **não bloquear** —
  expor `over_limit` no endpoint de uso. Sem coluna nova: contagem calculada on-the-fly.

### 5. Endpoint de uso — `GET /api/v1/usage`

Retorna para o frontend montar avisos e travar botões:

```json
{
  "plan": "pro",
  "capabilities": { "menu_sync": true, "auto_accept": true },
  "restaurants_count": 2, "max_restaurants": 3,
  "orders_this_month": 1450, "max_orders_month": 2000,
  "over_limit": false
}
```

### 6. Gestão de usuários (admin)

- `GET /api/v1/admin/users` → lista `{id, name, email, plan, active, payment_status,
  created_at}`.
- `PUT /api/v1/admin/users/:id` → atualiza `active` e/ou `plan` (valida `plan` contra
  `plans.slug`). Protegido pelo mesmo `adminAuth` já usado.
- Ajustar `settings.js /plan` para validar dinamicamente contra `plans` (remove a lista
  fixa).

### 7. Extensão do CRUD de planos

- `POST`/`PUT` em [src/routes/plans.js](../../../src/routes/plans.js) passam a aceitar e
  persistir `capabilities` (JSONB), mantendo `features` para texto. `billing_period`
  aceita `weekly`/`monthly`/`yearly`.
- [src/routes/checkout.js](../../../src/routes/checkout.js) hoje fixa `plan_expires_at`
  em `INTERVAL '30 days'`; passa a derivar o intervalo do `billing_period` do plano
  (7/30/365 dias).

### 8. Frontend Lovable (fora deste repo)

Entregável: um **prompt** descrevendo:
- Aba **Planos**: editar nome, preço, `active`, toggles de capabilities
  (`menu_sync`, `auto_accept`), limites (`max_restaurants`, `max_orders_month`),
  e o texto de `features`.
- Aba **Usuários**: listar, toggle `active`, trocar `plan`.
- UX do usuário final: consumir `GET /usage` para travar botões e mostrar avisos de
  upgrade (inclusive `over_limit` suave para pedidos/mês).

## Fluxo de dados

1. Admin edita plano (capabilities/limites) → `plans`.
2. Admin/checkout define `users.plan` e `users.active`.
3. Requisição do usuário → `requireActiveUser` → `requireCapability`/limite consulta
   `resolveUserPlan` → libera ou 403.
4. Frontend chama `GET /usage` para refletir estado (travas + avisos).

## Tratamento de erros

- Capacidade ausente: `403 { error: 'plan_upgrade_required', capability }`.
- Limite duro atingido: `403 { error: 'plan_limit_reached', limit }`.
- Usuário inativo/trial expirado: `403 { error: 'account_inactive' | 'trial_expired' }`.
- Limite suave: sem erro; `over_limit: true` em `/usage`.

## Testes

- Unit: `resolveUserPlan` (slug válido, inválido→free, 0=ilimitado), `hasCapability`,
  `getLimit`, contagem de limites.
- Integração: rota de cardápio sem `menu_sync` → 403; criar loja além do limite → 403;
  exceder pedidos/mês → 200 + `over_limit`; usuário inativo → 403.

## Fora de escopo (YAGNI agora)

- Cache de planos; tabela normalizada de features; cobrança/prorata automática;
  histórico de mudança de plano; capacidades além das quatro definidas.
