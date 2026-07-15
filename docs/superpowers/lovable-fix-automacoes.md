# Prompt Lovable — Automações (remover card "Todas", deixar só por loja/plataforma)

Cole no Lovable:

---

Ajustar a página **Automações** (que consome `GET /api/v1/automations`):

1. A API retorna uma lista de regras, cada uma com um campo `platform` que pode ser
   `"all"`, `"ifood"`, `"99food"` ou `"keeta"`.
2. **Não renderizar** o card da regra cujo `platform === "all"` (o "Aceite automático -
   Todas as lojas"). Mostrar **apenas** os cards das regras por plataforma/loja
   (`ifood`, `99food`, `keeta`), pra o usuário configurar cada uma individualmente.
3. Cada card por loja continua igual: toggle de ligar/desligar (`enabled`) e os tempos
   (`accept_delay_seconds` = tempo pra aceitar; `delay_seconds` = tempo pra marcar como
   pronto). Ao salvar, enviar `PUT /api/v1/automations/:id` com
   `{ enabled, accept_delay_seconds, delay_seconds }` e o header
   `Authorization: Bearer <token>`.
4. Se algum card ficar sem informação (ex.: loja não conectada), pode ocultar em vez de
   mostrar campos vazios — deixar a tela limpa.

---

Observação (backend): a regra `platform = "all"` continua existindo no banco, apenas
deixa de aparecer na tela. Se ela estiver LIGADA, ainda pode agir no auto-aceite. Se
quiser que ela pare totalmente, garanta que esteja desligada (ou peça pro backend
desativá-la). Nenhuma mudança de backend é necessária só para esconder o card.
