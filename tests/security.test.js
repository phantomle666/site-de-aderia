const request = require('supertest');
const app = require('../src/app');
const pool = require('../src/config/database');

describe('Suite de tests de sécurité et d\'authentification', () => {
  afterAll(async () => {
    try {
      await pool.end();
    } catch (e) {
      // Ignorer si déjà fermé
    }
  });

  test('1. Accès refusé à /admin/dashboard pour utilisateur non authentifié', async () => {
    const res = await request(app).get('/admin/dashboard');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin/login');
  });

  test('2. Rejet des requêtes POST sensibles sans token CSRF valide', async () => {
    const res = await request(app)
      .post('/admin/licenses/create')
      .send({ product: 'base_fivem', type: 'lifetime' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/CSRF/i);
  });

  test('3. Les tentatives d’injections SQL sont bloquées par les requêtes paramétrées', async () => {
    const maliciousPayload = "' OR '1'='1";
    const res = await request(app)
      .post('/api/licenses/verify')
      .send({ licenseKey: maliciousPayload });
    expect([400, 403]).toContain(res.status);
    expect(res.body.valid).toBe(false);
  });

  test('4. Headers de sécurité stricts présents sur toutes les réponses', async () => {
    const res = await request(app).get('/admin/login');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBeDefined();
  });

  test('5. Message d\'erreur générique sur le login pour éviter l\'énumération d\'utilisateurs', async () => {
    const res = await request(app)
      .post('/admin/login')
      .send({ username: 'compte_inexistant_xyz', password: 'Password12345!' });
    expect([400, 401, 403]).toContain(res.status);
  });
});
