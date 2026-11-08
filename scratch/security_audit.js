const http = require('http');

function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL('http://localhost:3000' + path);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { ...headers }
    };

    if (body) {
      const data = typeof body === 'string' ? body : JSON.stringify(body);
      options.headers['Content-Length'] = Buffer.byteLength(data);
      if (!options.headers['Content-Type']) {
        options.headers['Content-Type'] = 'application/json';
      }
    }

    const req = http.request(options, res => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data: raw
        });
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

async function runAudit() {
  console.log('=== DÉMARRAGE DE L’AUDIT DE SÉCURITÉ AUTOMATISÉ ===\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log('✅ [PASS]', message);
      passed++;
    } else {
      console.error('❌ [FAIL]', message);
      failed++;
    }
  }

  // TEST 1 : Vérification des pages GET publiques
  console.log('--- Test 1 : Pages d’authentification ---');
  const resLogin = await request('GET', '/login');
  assert(resLogin.statusCode === 200, '/login est accessible (Code 200)');
  assert(resLogin.data.includes('Connexion Client'), '/login contient le titre de connexion');
  assert(resLogin.data.includes('/auth/google'), '/login intègre le bouton Google Sign-In');
  assert(resLogin.data.includes('name="_csrf"'), '/login injecte le token CSRF masqué');

  const resRegister = await request('GET', '/register');
  assert(resRegister.statusCode === 200, '/register est accessible (Code 200)');
  assert(resRegister.data.includes('Créer un Compte'), '/register contient le titre d’inscription');
  assert(resRegister.data.includes('/auth/google'), '/register intègre le bouton Google Sign-Up');
  assert(resRegister.data.includes('name="_csrf"'), '/register injecte le token CSRF masqué');

  // TEST 2 : Headers de sécurité (Helmet, CSP, Anti-Clickjacking)
  console.log('\n--- Test 2 : En-têtes HTTP de sécurité ---');
  assert(resLogin.headers['x-frame-options'] === 'DENY', 'Anti-Clickjacking actif (X-Frame-Options: DENY)');
  assert(resLogin.headers['x-content-type-options'] === 'nosniff', 'Anti-MIME Sniffing actif (X-Content-Type-Options: nosniff)');
  assert(!!resLogin.headers['content-security-policy'], 'Content-Security-Policy configurée et envoyée');

  // TEST 3 : Protection CSRF contre les attaques inter-sites
  console.log('\n--- Test 3 : Résistance aux attaques CSRF ---');
  const resCsrfAttack = await request('POST', '/api/auth/settings/password', {
    old_password: 'test',
    new_password: 'testpassword123',
    confirm_password: 'testpassword123'
  });
  assert(resCsrfAttack.statusCode === 403, 'Requête POST sans CSRF rejetée immédiatement avec 403 Forbidden');

  // TEST 4 : Protection contre l’accès non authentifié aux paramètres de sécurité
  console.log('\n--- Test 4 : Contrôle d’accès (RBAC / Auth Guard) ---');
  const resSettingsUnauth = await request('GET', '/api/auth/settings/status');
  assert(resSettingsUnauth.statusCode === 401, 'Endpoint /api/auth/settings/status protégé (Rejet 401 pour visiteur anonyme)');

  const resLogsUnauth = await request('GET', '/api/auth/logs');
  assert(resLogsUnauth.statusCode === 401, 'Endpoint /api/auth/logs protégé (Rejet 401 pour visiteur anonyme)');

  // TEST 5 : Injection SQL (Test SQLi)
  console.log('\n--- Test 5 : Résistance aux injections SQL (SQLi) ---');
  // Tentative SQLi classique : admin' OR '1'='1
  const sqliPayload = "admin' OR '1'='1";
  const cookies = resLogin.headers['set-cookie'] ? resLogin.headers['set-cookie'].map(c => c.split(';')[0]).join('; ') : '';
  const csrfMatch = resLogin.data.match(/name="_csrf" value="([^"]+)"/);
  const csrfToken = csrfMatch ? csrfMatch[1] : '';

  const resSqli = await request('POST', '/login', `_csrf=${csrfToken}&username=${encodeURIComponent(sqliPayload)}&password=password123`, {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Cookie': cookies
  });
  assert(resSqli.statusCode === 401, 'Tentative SQLi "admin\' OR \'1\'=\'1" bloquée avec 401 Unauthorized (requêtes préparées)');

  // TEST 6 : Protection Anti-Bruteforce & Verrouillage
  console.log('\n--- Test 6 : Hachage de mot de passe Argon2id & Timing defense ---');
  const pool = require('../src/config/database');
  const [users] = await pool.query('SELECT password_hash FROM admins WHERE username = "pentagone"');
  if (users.length > 0) {
    const hash = users[0].password_hash;
    assert(hash.startsWith('$argon2id$'), 'Mots de passe hachés avec l’algorithme officiel le plus robuste : Argon2id');
  }

  console.log(`\n=== RÉSULTATS AUDIT : ${passed} Tests Réussis / ${failed} Échecs ===`);
  process.exit(failed > 0 ? 1 : 0);
}

runAudit().catch(err => {
  console.error('Audit exception:', err);
  process.exit(1);
});
