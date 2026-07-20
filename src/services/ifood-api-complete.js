const https = require('https');
const querystring = require('querystring');

const IFOOD_HOST = 'merchant-api.ifood.com.br';
// Base para montar a URL das imagens a partir do imagePath retornado pelo catálogo
const IFOOD_IMAGE_BASE = 'https://static-images.ifood.com.br/image/upload/t_high/pratos/';

class iFoodAPI {
  constructor() {
    this.clientId = process.env.IFOOD_CLIENT_ID;
    this.clientSecret = process.env.IFOOD_CLIENT_SECRET;
    this.tokenCache = { token: null, expiresAt: 0 };
  }

  // Helper genérico de request HTTPS que checa status e faz parse do JSON
  _request({ path, method = 'GET', headers = {}, body = null }) {
    return new Promise((resolve, reject) => {
      const req = https.request({ hostname: IFOOD_HOST, path, method, headers }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`iFood ${method} ${path} -> HTTP ${res.statusCode}: ${data.slice(0, 500)}`));
          }
          if (!data) return resolve(null);
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(new Error(`Falha ao fazer parse da resposta iFood (${path}): ${data.slice(0, 300)}`));
          }
        });
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  // Gerar (e cachear) token OAuth2 — endpoint/formato corretos da Merchant API
  async getValidToken() {
    if (!this.clientId || !this.clientSecret) {
      throw new Error('Credenciais do iFood não configuradas. Defina IFOOD_CLIENT_ID e IFOOD_CLIENT_SECRET nas variáveis de ambiente.');
    }

    // Reaproveita token em cache se ainda válido (margem de 60s)
    if (this.tokenCache.token && Date.now() < this.tokenCache.expiresAt - 60000) {
      return this.tokenCache.token;
    }

    const postData = querystring.stringify({
      grantType: 'client_credentials',
      clientId: this.clientId,
      clientSecret: this.clientSecret
    });

    const parsed = await this._request({
      path: '/authentication/v1.0/oauth/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      },
      body: postData
    });

    if (!parsed || !parsed.accessToken) {
      throw new Error(`iFood não retornou accessToken: ${JSON.stringify(parsed)}`);
    }

    const expiresInMs = (parsed.expiresIn || 3600) * 1000;
    this.tokenCache = { token: parsed.accessToken, expiresAt: Date.now() + expiresInMs };
    return parsed.accessToken;
  }

  // Buscar merchants (lojas do usuário)
  async getMerchants(token) {
    const merchants = await this._request({
      path: '/merchant/v1.0/merchants?page=1&size=100',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    return Array.isArray(merchants) ? merchants : [];
  }

  // Buscar detalhe de UM merchant (traz o nome real da loja). Retorna null se falhar.
  async getMerchantDetail(merchantId, token) {
    try {
      const d = await this._request({
        path: `/merchant/v1.0/merchants/${merchantId}`,
        headers: { 'Authorization': `Bearer ${token}` }
      });
      return d || null;
    } catch (e) {
      return null;
    }
  }

  // Listar catálogos de um merchant
  async getCatalogs(merchantId, token) {
    const catalogs = await this._request({
      path: `/catalog/v2.0/merchants/${merchantId}/catalogs`,
      headers: { 'Authorization': `Bearer ${token}` }
    });
    return Array.isArray(catalogs) ? catalogs : [];
  }

  // Buscar categorias (com itens) de um catálogo específico
  async getCategories(merchantId, catalogId, token) {
    const categories = await this._request({
      path: `/catalog/v2.0/merchants/${merchantId}/catalogs/${catalogId}/categories?includeItems=true`,
      headers: { 'Authorization': `Bearer ${token}` }
    });
    return Array.isArray(categories) ? categories : [];
  }

  // Monta URL completa da imagem a partir do imagePath do catálogo
  _buildImageUrl(item) {
    const p = item.imagePath || item.image?.path || item.image?.url || null;
    if (!p) return null;
    if (/^https?:\/\//.test(p)) return p; // já é URL completa
    return IFOOD_IMAGE_BASE + p.replace(/^\/+/, '');
  }

  // Extrai o preço lidando com os formatos possíveis do catálogo v2.0
  _extractPrice(item) {
    const price = item.price;
    if (price && typeof price === 'object') {
      return price.value ?? price.originalValue ?? 0; // v2.0: já vem em reais
    }
    if (typeof price === 'number') return price; // fallback
    return 0;
  }

  // Buscar e achatar todos os items do cardápio (fluxo correto: catalogs -> categories -> items)
  async getMenuItems(merchantId, token) {
    const catalogs = await this.getCatalogs(merchantId, token);
    console.log(`[ifood-api] merchant ${merchantId}: ${catalogs.length} catálogo(s)`);

    const items = [];
    let rawLogged = false;

    for (const catalog of catalogs) {
      const catalogId = catalog.catalogId || catalog.id;
      if (!catalogId) continue;

      const categories = await this.getCategories(merchantId, catalogId, token);
      console.log(`[ifood-api] catálogo ${catalogId}: ${categories.length} categoria(s)`);

      for (const category of categories) {
        const catItems = Array.isArray(category.items) ? category.items : [];
        for (const item of catItems) {
          if (!rawLogged) {
            // Loga o primeiro item cru uma vez para calibrar o parsing com dados reais
            console.log('[ifood-api] exemplo de item cru:', JSON.stringify(item).slice(0, 600));
            rawLogged = true;
          }
          items.push({
            id: item.id,
            name: item.name,
            description: item.description || '',
            price: this._extractPrice(item),
            category: category.name,
            image: this._buildImageUrl(item),
            available: (item.status || '').toUpperCase() !== 'UNAVAILABLE' && item.available !== false,
            sku: item.sku || item.externalCode || null,
            productId: item.productId || item.id
          });
        }
      }
    }

    return items;
  }

  // Buscar detalhes de um produto específico
  async getItemDetails(merchantId, itemId, token) {
    const details = await this._request({
      path: `/catalog/v2.0/merchants/${merchantId}/items/${itemId}`,
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!details) return null;
    return {
      id: details.id,
      name: details.name,
      description: details.description,
      price: this._extractPrice(details),
      image: this._buildImageUrl(details),
      available: details.available,
      ingredients: details.ingredients || []
    };
  }
}

module.exports = new iFoodAPI();
