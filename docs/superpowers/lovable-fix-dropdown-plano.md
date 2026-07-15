# Prompt Lovable — corrigir dropdown "Plano" no modal Editar usuário

Cole no Lovable:

---

Corrigir o dropdown "Plano" no modal "Editar usuário" (aba Usuários do painel admin):

1. Ao abrir a tela de Usuários, buscar a lista de planos com `GET /api/v1/plans/all`
   (header `Authorization: Bearer <token admin>`). Se der 403/erro, cair para
   `GET /api/v1/plans`. Guardar a lista em estado.
2. No dropdown "Plano", gerar uma `<option>` para cada plano: `value = plano.slug`,
   texto = `plano.name`. Adicionar uma opção vazia no topo ("Selecione um plano").
3. Ao abrir "Editar usuário", pré-selecionar a opção cujo `value` (slug) seja igual ao
   campo `plan` do usuário (vindo de `GET /api/v1/admin/users`). Se `plan` estiver vazio,
   deixar em "Selecione um plano".
4. Ao clicar "Salvar", enviar `PUT /api/v1/admin/users/:id` com o corpo
   `{ plan: <slug selecionado>, active: <toggle Conta ativa>, payment_status: <status> }`.
   Tratar resposta 400 `{error:'Plano inválido'}` mostrando um aviso (ocorre se o plano
   escolhido não existir ou estiver inativo).
5. O toggle "Conta ativa" deve refletir o campo `active` do usuário e enviar
   `active: true/false` no Salvar (isso reativa/desativa o acesso).

---

Referência de dados do backend:
- `GET /api/v1/plans/all` (admin) → todos os planos, incl. inativos, com `slug`, `name`, `active`, `capabilities`, limites.
- `GET /api/v1/plans` (público) → só planos ativos.
- `GET /api/v1/admin/users` → cada usuário tem `plan` (o **slug** do plano).
- `PUT /api/v1/admin/users/:id` → valida o `plan` contra os planos ativos.
