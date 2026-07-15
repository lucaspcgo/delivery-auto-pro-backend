# Prompt Lovable — Relatórios (isolamento por usuário + coluna Usuário no admin)

Cole no Lovable:

---

Ajustar a página **Relatórios** (que consome `GET /api/v1/reports/summary`):

1. **Sempre enviar o token de login** no header `Authorization: Bearer <token>` na chamada
   de `GET /api/v1/reports/summary` (a rota agora exige autenticação). Se vier **401**,
   redirecionar para login / renovar o token.
2. O backend já faz o isolamento: **usuário comum** recebe apenas os dados das próprias
   lojas; **admin** recebe de todas. O frontend não precisa filtrar por usuário — só
   exibir o que a API retornar.
3. Na tabela **"Por restaurante"** (campo `por_restaurante` da resposta), cada item tem:
   `{ restaurante, platform, usuario, pedidos, faturamento }`.
   - **Se o usuário logado for admin**, exibir uma coluna **"Usuário"** mostrando o campo
     `usuario` (nome ou email do dono da loja). Quando `usuario` for `null`, mostrar "—".
   - **Se não for admin**, ocultar a coluna "Usuário" (ele só vê as próprias lojas, então
     é redundante).
4. Não mudar os outros blocos (resumo, por plataforma, por dia, por status, top itens,
   por hora) — só garantir que o token é enviado.

---

Resposta do backend (`GET /api/v1/reports/summary`), campo relevante:

```json
"por_restaurante": [
  { "restaurante": "Marmita la Priori", "platform": "ifood", "usuario": "Lucas (lucaspc500@gmail.com)", "pedidos": 12, "faturamento": 340.5 }
]
```
(`usuario` só é útil pro admin; para usuário comum sempre será a própria conta.)
