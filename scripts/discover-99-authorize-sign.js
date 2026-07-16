#!/usr/bin/env node
/**
 * Descobre a fórmula da assinatura (sign) do link de autorização do 99food
 * (página merchant.99app.com/.../app-authorize).
 *
 * Rode NO SERVIDOR (onde existe FOOD99_APP_SECRET):
 *   node scripts/discover-99-authorize-sign.js
 *
 * Ele testa várias combinações (subconjuntos de parâmetros, ordenações,
 * separadores, posição do secret, md5/sha256, maiúsc/minúsc) contra os dois
 * links válidos conhecidos e imprime qual fórmula reproduz os DOIS signs.
 */
const crypto = require('crypto');

const SECRET = process.env.FOOD99_APP_SECRET;
if (!SECRET) {
  console.error('ERRO: defina FOOD99_APP_SECRET no ambiente antes de rodar.');
  process.exit(1);
}

// Amostras reais de links que funcionaram (mesmo enterprise/app/uid).
const SAMPLES = [
  { app_id: '5764607554401863557', enterprise_name: 'Bs Solucoes', uid: '646635983587325546', time: '1784141322', sign: 'e8b6abf1c32fe171559fdee5231081c6' },
  { app_id: '5764607554401863557', enterprise_name: 'Bs Solucoes', uid: '646635983587325546', time: '1784207142', sign: '8e8892ff793173233336d9ad1e7e52f3' },
  { app_id: '5764607554401863557', enterprise_name: 'Bs Solucoes', uid: '646635983587325546', time: '1783378247', sign: 'a95b43f6ccebbc1f32df5f257b314b4b' },
];

// enterprise_name pode entrar de várias formas na string a assinar.
function enterpriseVariants(s) {
  return {
    raw: s.enterprise_name,                       // "Bs Solucoes"
    plus: s.enterprise_name.replace(/ /g, '+'),   // "Bs+Solucoes"
    enc: encodeURIComponent(s.enterprise_name),   // "Bs%20Solucoes"
  };
}

const KEYSETS = [
  ['app_id', 'enterprise_name', 'time', 'uid'],
  ['app_id', 'time', 'uid'],
  ['app_id', 'enterprise_name', 'uid', 'time'],
  ['app_id', 'uid', 'time'],
  ['app_id', 'time'],
  ['time', 'uid'],
];

const SEPARATORS = ['&', '', '|'];
const HASHES = ['md5', 'sha256'];

function build(sample, keys, encName) {
  const ev = enterpriseVariants(sample);
  const obj = {
    app_id: sample.app_id,
    enterprise_name: encName === 'raw' ? ev.raw : encName === 'plus' ? ev.plus : ev.enc,
    uid: sample.uid,
    time: sample.time,
  };
  return keys.map(k => obj[k]);
}

function candidates(sample) {
  const out = [];
  for (const encName of ['raw', 'plus', 'enc']) {
    for (const keys of KEYSETS) {
      if (!keys.includes('enterprise_name') && encName !== 'raw') continue; // sem enterprise, encName não importa
      const vals = build(sample, keys, encName);
      const kv = keys.map((k, i) => `${k}=${vals[i]}`);
      for (const sep of SEPARATORS) {
        const joinedKV = kv.join(sep);
        const joinedVals = vals.join(sep);
        // várias formas de montar a base
        out.push({ id: `kv|${keys}|${encName}|sep='${sep}'|secret_suffix`, base: joinedKV + SECRET });
        out.push({ id: `kv|${keys}|${encName}|sep='${sep}'|secret_prefix`, base: SECRET + joinedKV });
        out.push({ id: `kv|${keys}|${encName}|sep='${sep}'|secret_amp`, base: joinedKV + sep + 'app_secret=' + SECRET });
        out.push({ id: `vals|${keys}|${encName}|sep='${sep}'|secret_suffix`, base: joinedVals + SECRET });
        out.push({ id: `vals|${keys}|${encName}|sep='${sep}'|secret_prefix`, base: SECRET + joinedVals });
      }
    }
  }
  return out;
}

function hashes(base) {
  const res = [];
  for (const algo of HASHES) {
    const h = crypto.createHash(algo).update(base).digest('hex');
    res.push({ algo: algo + '-lower', v: h });
    res.push({ algo: algo + '-upper', v: h.toUpperCase() });
  }
  return res;
}

// Gera os candidatos da 1ª amostra e valida contra a 2ª.
const first = SAMPLES[0];
const rest = SAMPLES.slice(1);
let found = 0;

for (const cand of candidates(first)) {
  for (const h of hashes(cand.base)) {
    if (h.v.toLowerCase() !== first.sign.toLowerCase()) continue;
    // bateu na 1ª — confirma nas demais
    const okAll = rest.every(s => {
      const c2 = candidates(s).find(c => c.id === cand.id);
      if (!c2) return false;
      const hs = hashes(c2.base).find(x => x.algo === h.algo);
      return hs && hs.v.toLowerCase() === s.sign.toLowerCase();
    });
    if (okAll) {
      found++;
      console.log('==> FÓRMULA ENCONTRADA:');
      console.log('    id   :', cand.id);
      console.log('    hash :', h.algo);
      console.log('    base (1ª amostra):', cand.base.replace(SECRET, '<SECRET>'));
      console.log('');
    }
  }
}

if (!found) {
  console.log('Nenhuma fórmula candidata reproduziu os dois signs.');
  console.log('Me avise — eu amplio o espaço de busca (outros params/encodings).');
} else {
  console.log(`Total de fórmulas que batem: ${found}. Use a de id acima para gerar o link.`);
}
