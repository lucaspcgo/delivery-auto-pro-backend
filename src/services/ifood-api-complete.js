const https = require('https');
const querystring = require('querystring');

class iFoodAPI {
  constructor() {
    this.clientId = 'f0b06afc-d264-401f-90c4-629c40077a73';
    this.clientSecret = 'r4amkmqeif0dgrd2at3blle7ykn8qw50xnlr8p0lvjt5fcu3nfxn22tyvpqm3affmsj1ovpyxm4wq65q8vhtinpxyafa9oq1miq';
    this.tokenCache = {};
  }

  // Gerar token OAuth2
  async getValidToken() {
    try {
      const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
      
      const token = await new Promise((resolve, reject) => {
        const postData = querystring.stringify({ grant_type: 'client_credentials' });
        
        const req = https.request({
          hostname: 'merchant-api.ifood.com.br',
          path: '/oauth/token',
          method: 'POST',
          headers: {
            'Authorization': `Basic ${credentials}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': postData.length
          }
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              resolve(parsed.access_token);
            } catch (err) {
              reject(new Error('Falha ao fazer parse do token'));
            }
          });
        });
        
        req.on('error', reject);
        req.write(postData);
        req.end();
      });

      return token;
    } catch (err) {
      console.error('[ifood-api] erro ao gerar token:', err.message);
      throw err;
    }
  }

  // Buscar merchants (lojas do usuário)
  async getMerchants(token) {
    try {
      const merchants = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'merchant-api.ifood.com.br',
          path: '/merchant/v1.0/merchants',
          method: 'GET',
          headers: { 'Authorization': `Bearer ${token}` }
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              resolve(Array.isArray(parsed) ? parsed : []);
            } catch (err) {
              resolve([]);
            }
          });
        });
        req.on('error', reject);
        req.end();
      });

      return merchants;
    } catch (err) {
      console.error('[ifood-api] erro ao buscar merchants:', err.message);
      return [];
    }
  }

  // Buscar menu completo
  async getMenuFull(merchantId, token) {
    try {
      const menu = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'merchant-api.ifood.com.br',
          path: `/catalog/v2.0/merchants/${merchantId}/menu`,
          method: 'GET',
          headers: { 'Authorization': `Bearer ${token}` }
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              resolve(parsed);
            } catch (err) {
              reject(err);
            }
          });
        });
        req.on('error', reject);
        req.end();
      });

      return menu;
    } catch (err) {
      console.error('[ifood-api] erro ao buscar menu:', err.message);
      throw err;
    }
  }

  // Processar menu e extrair items com imagens
  async getMenuItems(merchantId, token) {
    try {
      const menu = await this.getMenuFull(merchantId, token);
      const items = [];

      if (menu.sections && Array.isArray(menu.sections)) {
        for (const section of menu.sections) {
          if (section.items && Array.isArray(section.items)) {
            for (const item of section.items) {
              items.push({
                id: item.id,
                name: item.name,
                description: item.description || '',
                price: (item.price || 0) / 100, // iFood retorna em centavos
                category: section.name,
                image: item.image?.url || null, // URL da imagem
                available: item.available !== false,
                sku: item.sku || null,
                productId: item.productId || item.id
              });
            }
          }
        }
      }

      return items;
    } catch (err) {
      console.error('[ifood-api] erro ao processar items:', err.message);
      throw err;
    }
  }

  // Buscar detalhes de um produto
  async getItemDetails(merchantId, itemId, token) {
    try {
      const details = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'merchant-api.ifood.com.br',
          path: `/catalog/v2.0/merchants/${merchantId}/items/${itemId}`,
          method: 'GET',
          headers: { 'Authorization': `Bearer ${token}` }
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              resolve(parsed);
            } catch (err) {
              reject(err);
            }
          });
        });
        req.on('error', reject);
        req.end();
      });

      return {
        id: details.id,
        name: details.name,
        description: details.description,
        price: (details.price || 0) / 100,
        image: details.image?.url,
        available: details.available,
        ingredients: details.ingredients || []
      };
    } catch (err) {
      console.error('[ifood-api] erro ao buscar detalhes:', err.message);
      throw err;
    }
  }
}

module.exports = new iFoodAPI();
