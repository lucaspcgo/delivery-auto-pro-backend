// Configuração central e validação de variáveis de ambiente sensíveis.
// Falha rápido na inicialização se algo obrigatório estiver ausente,
// evitando rodar com segredos default (inseguros).

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error(
    '[config] ERRO FATAL: variável de ambiente JWT_SECRET ausente ou fraca.\n' +
    '          Defina JWT_SECRET com pelo menos 32 caracteres aleatórios.\n' +
    '          Ex.: JWT_SECRET=$(node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))")'
  );
  // Encerra o processo: rodar sem um segredo forte permite forjar tokens de admin.
  process.exit(1);
}

module.exports = {
  JWT_SECRET,
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '24h'
};
