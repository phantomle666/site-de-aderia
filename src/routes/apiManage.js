const express = require('express');
const router = express.Router();
const fivemDb = require('../config/fivemDb');
const { sendToFiveM } = require('../utils/fivemBridge');
const { parseOxItems } = require('../utils/itemsParser');

// Helper : Parser les comptes d'un joueur
function parseAccounts(accountsRaw) {
  let accounts = { money: 0, bank: 0, black_money: 0 };
  if (!accountsRaw) return accounts;
  try {
    const parsed = typeof accountsRaw === 'string' ? JSON.parse(accountsRaw) : accountsRaw;
    if (Array.isArray(parsed)) {
      parsed.forEach(acc => {
        if (acc.name && typeof acc.money !== 'undefined') {
          accounts[acc.name] = Number(acc.money) || 0;
        }
      });
    } else if (typeof parsed === 'object') {
      accounts.money = Number(parsed.money) || 0;
      accounts.bank = Number(parsed.bank) || 0;
      accounts.black_money = Number(parsed.black_money) || 0;
    }
  } catch (e) {
    // Si parsing échoue, valeurs par défaut 0
  }
  return accounts;
}

// 1. STATISTIQUES GÉNÉRALES
router.get('/stats', async (req, res) => {
  try {
    const [[usersCount]] = await fivemDb.query('SELECT COUNT(*) as total FROM users');
    const [[adminsCount]] = await fivemDb.query("SELECT COUNT(*) as total FROM users WHERE `group` NOT IN ('user', '')");
    
    // Total économie
    const [allUsers] = await fivemDb.query('SELECT accounts FROM users');
    let totalCash = 0;
    let totalBank = 0;
    let totalDirty = 0;
    allUsers.forEach(u => {
      const acc = parseAccounts(u.accounts);
      totalCash += acc.money;
      totalBank += acc.bank;
      totalDirty += acc.black_money;
    });

    // Total sociétés
    let totalSocieties = 0;
    try {
      const [[socRes]] = await fivemDb.query('SELECT COUNT(*) as total FROM aderia_societies');
      totalSocieties = socRes.total;
    } catch {
      const [[jobRes]] = await fivemDb.query("SELECT COUNT(*) as total FROM jobs WHERE name != 'unemployed'");
      totalSocieties = jobRes.total;
    }

    res.json({
      success: true,
      stats: {
        totalPlayers: usersCount.total,
        totalAdmins: adminsCount.total,
        totalEconomy: totalCash + totalBank + totalDirty,
        totalCash,
        totalBank,
        totalDirty,
        totalSocieties
      }
    });
  } catch (err) {
    console.error('[API_MANAGE_STATS_ERROR]', err);
    res.status(500).json({ success: false, error: 'Impossible de charger les statistiques.' });
  }
});

// 2. LISTE DES JOUEURS
router.get('/players', async (req, res) => {
  try {
    const { search, group, job } = req.query;
    let query = `
      SELECT u.identifier, u.id as unique_id, u.firstname, u.lastname, u.job, u.job_grade,
             u.group, u.accounts, u.playtime, j.label as job_label, jg.label as grade_label,
             b.id as ban_id, b.reason as ban_reason,
             v.tier as vip_tier
      FROM users u
      LEFT JOIN jobs j ON u.job = j.name
      LEFT JOIN job_grades jg ON u.job = jg.job_name AND u.job_grade = jg.grade
      LEFT JOIN aderia_bans b ON (u.identifier = b.identifier OR u.identifier = b.license)
      LEFT JOIN aderia_vip v ON u.identifier = v.identifier
      WHERE 1=1
    `;
    const params = [];

    if (search) {
      query += ` AND (u.firstname LIKE ? OR u.lastname LIKE ? OR u.identifier LIKE ? OR CAST(u.id AS CHAR) = ?)`;
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, search);
    }
    if (group) {
      query += ` AND u.group = ?`;
      params.push(group);
    }
    if (job) {
      query += ` AND u.job = ?`;
      params.push(job);
    }

    query += ` ORDER BY u.id DESC LIMIT 100`;

    const [rows] = await fivemDb.query(query, params);
    const players = rows.map(r => {
      const acc = parseAccounts(r.accounts);
      const fullName = (r.firstname || r.lastname) ? `${r.firstname || ''} ${r.lastname || ''}`.trim() : 'Inconnu';
      return {
        identifier: r.identifier,
        uniqueId: r.unique_id || 'N/A',
        name: fullName,
        job: r.job || 'unemployed',
        jobLabel: r.job_label || r.job || 'Sans emploi',
        jobGrade: r.job_grade || 0,
        gradeLabel: r.grade_label || `Grade ${r.job_grade || 0}`,
        group: r.group || 'user',
        playtime: r.playtime || 0,
        money: acc.money,
        bank: acc.bank,
        black_money: acc.black_money,
        totalMoney: acc.money + acc.bank + acc.black_money,
        isBanned: !!r.ban_id,
        banId: r.ban_id || null,
        banReason: r.ban_reason || null,
        isVip: !!r.vip_tier,
        vipTier: r.vip_tier || null
      };
    });

    res.json({ success: true, players });
  } catch (err) {
    console.error('[API_MANAGE_PLAYERS_ERROR]', err);
    res.status(500).json({ success: false, error: 'Erreur lors de la récupération des joueurs.' });
  }
});

// 3. MODIFIER L'ÉCONOMIE D'UN JOUEUR (Cash, Banque, Sale)
router.post('/players/economy', async (req, res) => {
  try {
    const { identifier, accountType, action, amount } = req.body;
    // accountType: 'money' | 'bank' | 'black_money'
    // action: 'set' | 'add' | 'remove'
    if (!identifier || !accountType || !action || typeof amount === 'undefined') {
      return res.status(400).json({ success: false, error: 'Paramètres manquants.' });
    }

    const numericAmount = Math.max(0, parseInt(amount, 10));
    const [[player]] = await fivemDb.query('SELECT accounts FROM users WHERE identifier = ?', [identifier]);
    if (!player) {
      return res.status(404).json({ success: false, error: 'Joueur introuvable.' });
    }

    const accounts = parseAccounts(player.accounts);
    const currentVal = accounts[accountType] || 0;
    let newVal = currentVal;

    if (action === 'set') {
      newVal = numericAmount;
    } else if (action === 'add') {
      newVal = currentVal + numericAmount;
    } else if (action === 'remove') {
      newVal = Math.max(0, currentVal - numericAmount);
    }

    accounts[accountType] = newVal;

    // Sauvegarde en base (format objet standard ESX)
    await fivemDb.query('UPDATE users SET accounts = ? WHERE identifier = ?', [JSON.stringify(accounts), identifier]);

    // Synchronisation en direct avec FiveM (si le serveur est en cours d'exécution)
    const bridgeRes = await sendToFiveM('update_player_economy', { identifier, accountType, amount: newVal });

    res.json({
      success: true,
      message: `Compte ${accountType} mis à jour avec succès : $${newVal.toLocaleString('fr-FR')}` + (bridgeRes.onlinePlayer ? ' (Appliqué en direct en jeu !)' : ''),
      accounts
    });
  } catch (err) {
    console.error('[API_MANAGE_ECONOMY_ERROR]', err);
    res.status(500).json({ success: false, error: "Erreur lors de la mise à jour de l'économie." });
  }
});

// 4. LISTE DES JOBS & GRADES
router.get('/jobs', async (req, res) => {
  try {
    const [jobs] = await fivemDb.query('SELECT name, label FROM jobs ORDER BY label ASC');
    const [grades] = await fivemDb.query('SELECT job_name, grade, name, label, salary FROM job_grades ORDER BY grade ASC');

    const jobMap = {};
    jobs.forEach(j => {
      jobMap[j.name] = {
        name: j.name,
        label: j.label || j.name,
        grades: []
      };
    });

    grades.forEach(g => {
      if (jobMap[g.job_name]) {
        jobMap[g.job_name].grades.push({
          grade: g.grade,
          name: g.name,
          label: g.label || g.name,
          salary: g.salary || 0
        });
      }
    });

    res.json({ success: true, jobs: Object.values(jobMap) });
  } catch (err) {
    console.error('[API_MANAGE_JOBS_ERROR]', err);
    res.status(500).json({ success: false, error: 'Impossible de charger la liste des métiers.' });
  }
});

// 5. ATTRIBUER UN JOB & GRADE
router.post('/players/job', async (req, res) => {
  try {
    const { identifier, job, grade } = req.body;
    if (!identifier || !job || typeof grade === 'undefined') {
      return res.status(400).json({ success: false, error: 'Paramètres manquants.' });
    }

    const [[jobExists]] = await fivemDb.query('SELECT name, label FROM jobs WHERE name = ?', [job]);
    if (!jobExists) {
      return res.status(400).json({ success: false, error: 'Métier spécifié invalide.' });
    }

    await fivemDb.query('UPDATE users SET job = ?, job_grade = ? WHERE identifier = ?', [job, parseInt(grade, 10), identifier]);

    // Synchronisation en direct avec FiveM (si le joueur est connecté)
    const bridgeRes = await sendToFiveM('update_player_job', { identifier, job, grade: parseInt(grade, 10) });

    res.json({
      success: true,
      message: `Métier mis à jour pour ${jobExists.label} (Grade ${grade}) !` + (bridgeRes.onlinePlayer ? ' (Appliqué en direct au joueur !)' : '')
    });
  } catch (err) {
    console.error('[API_MANAGE_SET_JOB_ERROR]', err);
    res.status(500).json({ success: false, error: "Erreur lors de l'attribution du métier." });
  }
});

// 6. LISTE DES GROUPES / RANGS ADMIN DISPONIBLES
router.get('/groups', async (req, res) => {
  try {
    let groups = [];
    try {
      const [aderiaGroups] = await fivemDb.query('SELECT name, label, color, badge, hierarchy FROM aderia_groups ORDER BY hierarchy DESC');
      groups = aderiaGroups.map(g => ({
        name: g.name,
        label: g.label || g.name,
        color: g.color || '#fff',
        badge: g.badge || '',
        hierarchy: g.hierarchy || 0
      }));
    } catch {
      // Fallback groupes de base
      groups = [
        { name: 'owner', label: 'Fondateur', badge: '👑', hierarchy: 100 },
        { name: 'superadmin', label: 'Super Admin', badge: '🛡️', hierarchy: 80 },
        { name: 'admin', label: 'Administrateur', badge: '⭐', hierarchy: 50 },
        { name: 'mod', label: 'Modérateur', badge: '🔨', hierarchy: 20 },
        { name: 'user', label: 'Joueur', badge: '👤', hierarchy: 0 }
      ];
    }
    res.json({ success: true, groups });
  } catch (err) {
    console.error('[API_MANAGE_GROUPS_ERROR]', err);
    res.status(500).json({ success: false, error: 'Impossible de charger les groupes.' });
  }
});

// 7. GIVE ADMIN / CHANGER LE GROUPE D'UN JOUEUR
router.post('/players/group', async (req, res) => {
  try {
    const { identifier, group } = req.body;
    if (!identifier || !group) {
      return res.status(400).json({ success: false, error: 'Paramètres manquants.' });
    }

    // 1. Mettre à jour la table users
    await fivemDb.query('UPDATE users SET `group` = ? WHERE identifier = ?', [group, identifier]);

    // 2. Mettre à jour la table aderia_user_groups si elle existe
    try {
      await fivemDb.query(
        'INSERT INTO aderia_user_groups (identifier, group_name) VALUES (?, ?) ON DUPLICATE KEY UPDATE group_name = VALUES(group_name)',
        [identifier, group]
      );
    } catch (e) {
      // Table optionnelle
    }

    // Synchronisation en direct avec FiveM (si le joueur est connecté)
    const bridgeRes = await sendToFiveM('update_player_group', { identifier, group });

    res.json({
      success: true,
      message: `Le rang du joueur a été mis à jour vers "${group}" avec succès !` + (bridgeRes.onlinePlayer ? ' (Appliqué en direct au joueur !)' : '')
    });
  } catch (err) {
    console.error('[API_MANAGE_SET_GROUP_ERROR]', err);
    res.status(500).json({ success: false, error: 'Erreur lors du changement de groupe admin.' });
  }
});

// 8. LISTE DES SOCIÉTÉS (ENTREPRISES) & LEURS FONDS
router.get('/societies', async (req, res) => {
  try {
    // 1. Récupérer la liste des sociétés
    let societies = [];
    try {
      const [socList] = await fivemDb.query('SELECT name, label FROM aderia_societies ORDER BY label ASC');
      societies = socList;
    } catch {
      const [jobsList] = await fivemDb.query("SELECT name, label FROM jobs WHERE name NOT IN ('unemployed') ORDER BY label ASC");
      societies = jobsList;
    }

    // 2. Récupérer les soldes dans aderia_society_accounts
    let accountsMap = {};
    try {
      const [accRows] = await fivemDb.query('SELECT name, money FROM aderia_society_accounts');
      accRows.forEach(a => {
        const cleanJob = a.name.replace(/^society_/, '');
        accountsMap[cleanJob] = Number(a.money) || 0;
      });
    } catch (e) {
      // ignore
    }

    // 3. Récupérer les soldes dans core_society_coffre en complément
    try {
      const [coffreRows] = await fivemDb.query('SELECT job, data FROM core_society_coffre');
      coffreRows.forEach(c => {
        try {
          const parsed = JSON.parse(c.data);
          const money = (parsed.accounts && (parsed.accounts.money || parsed.accounts.cash)) || 0;
          if (typeof accountsMap[c.job] === 'undefined' || accountsMap[c.job] === 0) {
            accountsMap[c.job] = Number(money) || 0;
          }
        } catch {}
      });
    } catch (e) {
      // ignore
    }

    // 4. Compter les employés par société
    const [empRows] = await fivemDb.query(`
      SELECT job, COUNT(*) as count 
      FROM users 
      WHERE job IS NOT NULL AND job != 'unemployed' 
      GROUP BY job
    `);
    const empMap = {};
    empRows.forEach(e => {
      empMap[e.job] = e.count;
    });

    const result = societies.map(s => ({
      name: s.name,
      label: s.label || s.name,
      money: accountsMap[s.name] || 0,
      employeesCount: empMap[s.name] || 0
    }));

    res.json({ success: true, societies: result });
  } catch (err) {
    console.error('[API_MANAGE_SOCIETIES_ERROR]', err);
    res.status(500).json({ success: false, error: 'Impossible de charger la liste des sociétés.' });
  }
});

// 9. MODIFIER LES FONDS D'UNE SOCIÉTÉ
router.post('/societies/money', async (req, res) => {
  try {
    const { societyName, action, amount } = req.body;
    // action: 'set' | 'add' | 'remove'
    if (!societyName || !action || typeof amount === 'undefined') {
      return res.status(400).json({ success: false, error: 'Paramètres manquants.' });
    }

    const numericAmount = Math.max(0, parseInt(amount, 10));
    const fullAccName = societyName.startsWith('society_') ? societyName : `society_${societyName}`;
    const cleanJobName = societyName.replace(/^society_/, '');

    // Récupération de l'ancien solde
    let currentMoney = 0;
    const [[accRow]] = await fivemDb.query('SELECT money FROM aderia_society_accounts WHERE name = ?', [fullAccName]);
    if (accRow) {
      currentMoney = Number(accRow.money) || 0;
    }

    let newMoney = currentMoney;
    if (action === 'set') {
      newMoney = numericAmount;
    } else if (action === 'add') {
      newMoney = currentMoney + numericAmount;
    } else if (action === 'remove') {
      newMoney = Math.max(0, currentMoney - numericAmount);
    }

    // Mise à jour aderia_society_accounts
    await fivemDb.query(
      'INSERT INTO aderia_society_accounts (name, money) VALUES (?, ?) ON DUPLICATE KEY UPDATE money = VALUES(money)',
      [fullAccName, newMoney]
    );

    // Mise à jour synchrone de core_society_coffre si la ligne existe
    try {
      const [[coffreRow]] = await fivemDb.query('SELECT data FROM core_society_coffre WHERE job = ?', [cleanJobName]);
      if (coffreRow) {
        let coffreData = {};
        try { coffreData = JSON.parse(coffreRow.data); } catch {}
        if (!coffreData.accounts) coffreData.accounts = {};
        coffreData.accounts.money = newMoney;
        coffreData.accounts.cash = newMoney;
        await fivemDb.query('UPDATE core_society_coffre SET data = ? WHERE job = ?', [JSON.stringify(coffreData), cleanJobName]);
      }
    } catch (e) {
      // Optionnel
    }

    res.json({
      success: true,
      message: `Solde de la société mis à jour : $${newMoney.toLocaleString('fr-FR')}`,
      newMoney
    });
  } catch (err) {
    console.error('[API_MANAGE_SET_SOCIETY_MONEY_ERROR]', err);
    res.status(500).json({ success: false, error: 'Erreur lors de la modification des fonds de la société.' });
  }
});

// ========================================================
// 10. GESTION DES SALAIRES DES MÉTIERS (JOB GRADES)
// ========================================================
router.get('/economy/salaries', async (req, res) => {
  try {
    const [rows] = await fivemDb.query(`
      SELECT jg.id, jg.job_name, jg.grade, jg.name as grade_name, jg.label as grade_label, jg.salary,
             j.label as job_label
      FROM job_grades jg
      LEFT JOIN jobs j ON jg.job_name = j.name
      ORDER BY j.label ASC, jg.grade ASC
    `);

    res.json({ success: true, salaries: rows });
  } catch (err) {
    console.error('[API_MANAGE_SALARIES_ERROR]', err);
    res.status(500).json({ success: false, error: 'Impossible de charger les salaires.' });
  }
});

router.post('/economy/salaries', async (req, res) => {
  try {
    const { gradeId, salary } = req.body;
    if (!gradeId || typeof salary === 'undefined') {
      return res.status(400).json({ success: false, error: 'Paramètres manquants.' });
    }

    const numericSalary = Math.max(0, parseInt(salary, 10));
    await fivemDb.query('UPDATE job_grades SET salary = ? WHERE id = ?', [numericSalary, gradeId]);

    // Rechargement immédiat de ESX.Jobs en jeu
    await sendToFiveM('refresh_jobs', {});

    const [[grade]] = await fivemDb.query('SELECT job_name, label FROM job_grades WHERE id = ?', [gradeId]);

    res.json({
      success: true,
      message: `Salaire du grade "${grade ? grade.label : gradeId}" mis à jour : $${numericSalary.toLocaleString('fr-FR')}`
    });
  } catch (err) {
    console.error('[API_MANAGE_UPDATE_SALARY_ERROR]', err);
    res.status(500).json({ success: false, error: 'Erreur lors de la modification du salaire.' });
  }
});

// ========================================================
// 11. GESTION DE L'ÉCONOMIE DES VÉHICULES (CONCESSIONNAIRES)
// ========================================================
router.get('/economy/vehicles', async (req, res) => {
  try {
    const { dealer, category, search, page = 1, limit = 50 } = req.query;
    let query = 'SELECT id, dealer, model, name, category, price, stock FROM cardealer_vehicles WHERE 1=1';
    const params = [];

    if (dealer) {
      query += ' AND dealer = ?';
      params.push(dealer);
    }
    if (category) {
      query += ' AND category = ?';
      params.push(category);
    }
    if (search) {
      query += ' AND (name LIKE ? OR model LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    // Compteur total
    const countQuery = query.replace('SELECT id, dealer, model, name, category, price, stock', 'SELECT COUNT(*) as total');
    const [[countRes]] = await fivemDb.query(countQuery, params);
    const totalVehicles = countRes.total;

    // Pagination
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const offset = (pageNum - 1) * limitNum;

    query += ' ORDER BY dealer ASC, price DESC LIMIT ? OFFSET ?';
    params.push(limitNum, offset);

    const [vehicles] = await fivemDb.query(query, params);

    // Récupération des catégories et dealers distincts
    const [categories] = await fivemDb.query('SELECT DISTINCT category FROM cardealer_vehicles ORDER BY category ASC');
    const [dealers] = await fivemDb.query('SELECT DISTINCT dealer FROM cardealer_vehicles ORDER BY dealer ASC');

    res.json({
      success: true,
      vehicles,
      total: totalVehicles,
      page: pageNum,
      totalPages: Math.ceil(totalVehicles / limitNum),
      categories: categories.map(c => c.category),
      dealers: dealers.map(d => d.dealer)
    });
  } catch (err) {
    console.error('[API_MANAGE_VEHICLES_ERROR]', err);
    res.status(500).json({ success: false, error: 'Impossible de charger les véhicules.' });
  }
});

router.post('/economy/vehicles', async (req, res) => {
  try {
    const { vehicleId, price } = req.body;
    if (!vehicleId || typeof price === 'undefined') {
      return res.status(400).json({ success: false, error: 'Paramètres manquants.' });
    }

    const numericPrice = Math.max(0, parseInt(price, 10));
    await fivemDb.query('UPDATE cardealer_vehicles SET price = ? WHERE id = ?', [numericPrice, vehicleId]);

    const [[veh]] = await fivemDb.query('SELECT name, model FROM cardealer_vehicles WHERE id = ?', [vehicleId]);

    res.json({
      success: true,
      message: `Prix de "${veh ? veh.name : vehicleId}" mis à jour : $${numericPrice.toLocaleString('fr-FR')}`
    });
  } catch (err) {
    console.error('[API_MANAGE_UPDATE_VEHICLE_ERROR]', err);
    res.status(500).json({ success: false, error: 'Erreur lors de la modification du prix.' });
  }
});

// ========================================================
// 12. GESTION DE L'ÉCONOMIE DES BRAQUAGES (BANQUE, DAB, SUPÉRETTE)
// ========================================================
router.get('/economy/heists', async (req, res) => {
  try {
    const [rows] = await fivemDb.query("SELECT name, value FROM aderia_variables WHERE category = 'heist'");
    const varsMap = {};
    rows.forEach(r => {
      try {
        const parsed = JSON.parse(r.value);
        varsMap[r.name] = parsed.v;
      } catch {}
    });

    // Valeurs configurées avec fallbacks réalistes
    const heists = {
      atm: {
        rewardMin: typeof varsMap.atmRewardMin !== 'undefined' ? varsMap.atmRewardMin : 5000,
        rewardMax: typeof varsMap.atmRewardMax !== 'undefined' ? varsMap.atmRewardMax : 15000,
        cooldown: typeof varsMap.atmCooldown !== 'undefined' ? varsMap.atmCooldown : 10,
        dailyLimit: typeof varsMap.atmDailyLimit !== 'undefined' ? varsMap.atmDailyLimit : 5,
        requiredCops: typeof varsMap.atmRequiredCops !== 'undefined' ? varsMap.atmRequiredCops : 0
      },
      fleeca: {
        cashCap: typeof varsMap.fleecaCashCap !== 'undefined' ? varsMap.fleecaCashCap : 45000,
        cooldown: typeof varsMap.fleecaCooldown !== 'undefined' ? varsMap.fleecaCooldown : 1800,
        maxLootPoints: typeof varsMap.fleecaMaxLootPoints !== 'undefined' ? varsMap.fleecaMaxLootPoints : 6,
        requiredCops: typeof varsMap.fleecaRequiredCops !== 'undefined' ? varsMap.fleecaRequiredCops : 0
      },
      ltd: {
        rewardMin: typeof varsMap.ltdRewardMin !== 'undefined' ? varsMap.ltdRewardMin : 1500,
        rewardMax: typeof varsMap.ltdRewardMax !== 'undefined' ? varsMap.ltdRewardMax : 4000,
        cooldown: typeof varsMap.ltdCooldown !== 'undefined' ? varsMap.ltdCooldown : 15
      }
    };

    res.json({ success: true, heists });
  } catch (err) {
    console.error('[API_MANAGE_HEISTS_ERROR]', err);
    res.status(500).json({ success: false, error: 'Impossible de charger l’économie des braquages.' });
  }
});

router.post('/economy/heists', async (req, res) => {
  try {
    const { atm, fleeca, ltd } = req.body;

    const updates = [];
    if (atm) {
      if (typeof atm.rewardMin !== 'undefined') updates.push(['atmRewardMin', parseInt(atm.rewardMin, 10)]);
      if (typeof atm.rewardMax !== 'undefined') updates.push(['atmRewardMax', parseInt(atm.rewardMax, 10)]);
      if (typeof atm.cooldown !== 'undefined') updates.push(['atmCooldown', parseInt(atm.cooldown, 10)]);
      if (typeof atm.dailyLimit !== 'undefined') updates.push(['atmDailyLimit', parseInt(atm.dailyLimit, 10)]);
      if (typeof atm.requiredCops !== 'undefined') updates.push(['atmRequiredCops', parseInt(atm.requiredCops, 10)]);
    }
    if (fleeca) {
      if (typeof fleeca.cashCap !== 'undefined') updates.push(['fleecaCashCap', parseInt(fleeca.cashCap, 10)]);
      if (typeof fleeca.cooldown !== 'undefined') updates.push(['fleecaCooldown', parseInt(fleeca.cooldown, 10)]);
      if (typeof fleeca.maxLootPoints !== 'undefined') updates.push(['fleecaMaxLootPoints', parseInt(fleeca.maxLootPoints, 10)]);
      if (typeof fleeca.requiredCops !== 'undefined') updates.push(['fleecaRequiredCops', parseInt(fleeca.requiredCops, 10)]);
    }
    if (ltd) {
      if (typeof ltd.rewardMin !== 'undefined') updates.push(['ltdRewardMin', parseInt(ltd.rewardMin, 10)]);
      if (typeof ltd.rewardMax !== 'undefined') updates.push(['ltdRewardMax', parseInt(ltd.rewardMax, 10)]);
      if (typeof ltd.cooldown !== 'undefined') updates.push(['ltdCooldown', parseInt(ltd.cooldown, 10)]);
    }

    for (const [name, val] of updates) {
      await fivemDb.query(
        "INSERT INTO aderia_variables (category, name, value) VALUES ('heist', ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)",
        [name, JSON.stringify({ v: val })]
      );
    }

    // Synchronisation en direct avec le serveur FiveM
    await sendToFiveM('reload_heists', {});

    res.json({
      success: true,
      message: 'Paramètres des braquages mis à jour avec succès en base de données et rechargés en jeu !'
    });
  } catch (err) {
    console.error('[API_MANAGE_UPDATE_HEISTS_ERROR]', err);
    res.status(500).json({ success: false, error: 'Erreur lors de la mise à jour des braquages.' });
  }
});

// ========================================================
// 13. GESTION DES BANS & MODÉRATION
// ========================================================
router.get('/moderation/bans', async (req, res) => {
  try {
    const [bans] = await fivemDb.query(`
      SELECT b.id, b.identifier, b.license, b.discord, b.ip, b.reason, b.banned_by,
             b.created_at, b.expires_at, u.firstname, u.lastname, u.id as unique_id
      FROM aderia_bans b
      LEFT JOIN users u ON b.identifier = u.identifier
      ORDER BY b.id DESC
    `);
    res.json({ success: true, bans });
  } catch (err) {
    console.error('[API_MANAGE_BANS_ERROR]', err);
    res.status(500).json({ success: false, error: 'Impossible de récupérer la liste des bannissements.' });
  }
});

router.post('/moderation/bans', async (req, res) => {
  try {
    const { identifier, reason, durationDays } = req.body;
    if (!identifier || !reason) {
      return res.status(400).json({ success: false, error: 'Identifier et raison requis.' });
    }

    const [[user]] = await fivemDb.query('SELECT identifier, license FROM users WHERE identifier = ? OR id = ?', [identifier, identifier]);
    const targetIdentifier = user ? user.identifier : identifier;
    let targetLicense = user ? user.license : null;

    // Si la license n'a pas le préfixe 'license:', formater avec 'license:'
    const fullLicense = targetLicense ? (targetLicense.startsWith('license:') ? targetLicense : `license:${targetLicense}`) : null;

    // Récupérer d'éventuels identifiants connus (discord, ip)
    const [[savedIdent]] = await fivemDb.query('SELECT discord, ip FROM aderia_player_identifiers WHERE identifier = ? OR license = ? LIMIT 1', [targetIdentifier, targetLicense]);
    const targetDiscord = savedIdent ? savedIdent.discord : null;
    const targetIp = savedIdent ? savedIdent.ip : null;

    let expiresAt = null;
    if (durationDays && parseInt(durationDays, 10) > 0) {
      expiresAt = new Date(Date.now() + parseInt(durationDays, 10) * 24 * 3600 * 1000);
    }

    await fivemDb.query(
      'INSERT INTO aderia_bans (identifier, license, discord, ip, reason, banned_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, NOW(), ?)',
      [targetIdentifier, fullLicense || targetLicense, targetDiscord, targetIp, reason, 'Web Panel Admin', expiresAt]
    );

    // Expulser en direct si en jeu
    await sendToFiveM('ban_player', { identifier: targetIdentifier, reason });

    res.json({
      success: true,
      message: `Le joueur a été banni avec succès : ${reason}`
    });
  } catch (err) {
    console.error('[API_MANAGE_ADD_BAN_ERROR]', err);
    res.status(500).json({ success: false, error: 'Erreur lors de l’application du ban.' });
  }
});

router.delete('/moderation/bans/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await fivemDb.query('DELETE FROM aderia_bans WHERE id = ? OR identifier = ? OR license = ?', [id, id, id]);
    res.json({ success: true, message: 'Le joueur a été débanni avec succès !' });
  } catch (err) {
    console.error('[API_MANAGE_DEL_BAN_ERROR]', err);
    res.status(500).json({ success: false, error: 'Erreur lors du débannissement.' });
  }
});

router.post('/moderation/unban', async (req, res) => {
  try {
    const { identifier, id } = req.body;
    if (id) {
      await fivemDb.query('DELETE FROM aderia_bans WHERE id = ?', [id]);
    } else if (identifier) {
      await fivemDb.query('DELETE FROM aderia_bans WHERE identifier = ? OR license = ?', [identifier, identifier]);
    } else {
      return res.status(400).json({ success: false, error: 'Identifier ou ID de ban manquant.' });
    }
    res.json({ success: true, message: 'Le joueur a été débanni avec succès !' });
  } catch (err) {
    console.error('[API_MANAGE_UNBAN_ERROR]', err);
    res.status(500).json({ success: false, error: 'Erreur lors du débannissement.' });
  }
});

// AVERTISSEMENTS (WARNS)
router.get('/moderation/warns', async (req, res) => {
  try {
    const [warns] = await fivemDb.query(`
      SELECT w.id, w.identifier, w.char_id, w.reason, w.created_by, w.created_at,
             u.firstname, u.lastname, u.id as unique_id
      FROM aderia_warns w
      LEFT JOIN users u ON w.identifier = u.identifier
      ORDER BY w.id DESC
    `);
    res.json({ success: true, warns });
  } catch (err) {
    console.error('[API_MANAGE_WARNS_ERROR]', err);
    res.status(500).json({ success: false, error: 'Impossible de récupérer la liste des avertissements.' });
  }
});

router.post('/moderation/warns', async (req, res) => {
  try {
    const { identifier, reason, createdBy } = req.body;
    if (!identifier || !reason) {
      return res.status(400).json({ success: false, error: 'Identifier et motif requis.' });
    }

    const [[user]] = await fivemDb.query('SELECT identifier, id FROM users WHERE identifier = ? OR id = ?', [identifier, identifier]);
    const targetIdentifier = user ? user.identifier : identifier;
    const targetCharId = user ? (user.id || 1) : 1;

    await fivemDb.query(
      'INSERT INTO aderia_warns (identifier, char_id, reason, created_by, created_at) VALUES (?, ?, ?, ?, NOW())',
      [targetIdentifier, targetCharId, reason, createdBy || 'Web Panel Admin']
    );

    // Notification en direct en jeu si le joueur est connecté
    await sendToFiveM('warn_player', { identifier: targetIdentifier, reason });

    res.json({
      success: true,
      message: `Avertissement ajouté avec succès pour : "${reason}"`
    });
  } catch (err) {
    console.error('[API_MANAGE_ADD_WARN_ERROR]', err);
    res.status(500).json({ success: false, error: 'Erreur lors de l’ajout de l’avertissement.' });
  }
});

router.delete('/moderation/warns/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await fivemDb.query('DELETE FROM aderia_warns WHERE id = ?', [id]);
    res.json({ success: true, message: 'L’avertissement a été retiré avec succès !' });
  } catch (err) {
    console.error('[API_MANAGE_DEL_WARN_ERROR]', err);
    res.status(500).json({ success: false, error: 'Erreur lors de la suppression de l’avertissement.' });
  }
});

// ========================================================
// 14. GESTION BOUTIQUE & GIVE VIP / COINS
// ========================================================
router.get('/boutique/players', async (req, res) => {
  try {
    const [players] = await fivemDb.query(`
      SELECT u.identifier, u.id as unique_id, u.firstname, u.lastname,
             COALESCE(uc.coins, 0) as coins, COALESCE(uc.fidelity, 0) as fidelity,
             v.tier as vip_tier, v.expires_at as vip_expires_at
      FROM users u
      LEFT JOIN aderia_user_coins uc ON u.identifier = uc.identifier
      LEFT JOIN aderia_vip v ON u.identifier = v.identifier
      ORDER BY u.id DESC
    `);
    res.json({ success: true, players });
  } catch (err) {
    console.error('[API_MANAGE_BOUTIQUE_PLAYERS_ERROR]', err);
    res.status(500).json({ success: false, error: 'Impossible de charger la boutique.' });
  }
});

router.post('/boutique/coins', async (req, res) => {
  try {
    const { identifier, action, amount } = req.body;
    // action: 'add' | 'set' | 'remove'
    if (!identifier || !action || typeof amount === 'undefined') {
      return res.status(400).json({ success: false, error: 'Paramètres manquants.' });
    }

    const numericAmount = Math.max(0, parseInt(amount, 10));
    const [[userCoins]] = await fivemDb.query('SELECT coins FROM aderia_user_coins WHERE identifier = ?', [identifier]);
    const currentCoins = userCoins ? (userCoins.coins || 0) : 0;
    let newCoins = currentCoins;

    if (action === 'set') newCoins = numericAmount;
    else if (action === 'add') newCoins = currentCoins + numericAmount;
    else if (action === 'remove') newCoins = Math.max(0, currentCoins - numericAmount);

    await fivemDb.query(
      'INSERT INTO aderia_user_coins (identifier, coins, fidelity, level) VALUES (?, ?, 0, 1) ON DUPLICATE KEY UPDATE coins = VALUES(coins)',
      [identifier, newCoins]
    );

    // Notification en jeu si connecté
    await sendToFiveM('give_coins', { identifier, coins: newCoins });

    res.json({
      success: true,
      message: `Coins boutique mis à jour : ${newCoins.toLocaleString('fr-FR')} Coins !`,
      coins: newCoins
    });
  } catch (err) {
    console.error('[API_MANAGE_COINS_ERROR]', err);
    res.status(500).json({ success: false, error: 'Erreur lors de la mise à jour des coins.' });
  }
});

router.post('/boutique/vip', async (req, res) => {
  try {
    const { identifier, tier, durationDays } = req.body;
    // tier: 'bronze' | 'silver' | 'gold' | 'diamond'
    if (!identifier || !tier) {
      return res.status(400).json({ success: false, error: 'Paramètres manquants.' });
    }

    let expiresAt = null;
    const days = parseInt(durationDays, 10);
    if (days > 0) {
      expiresAt = new Date(Date.now() + days * 24 * 3600 * 1000);
    }

    const badge = `VIP ${tier.toUpperCase()}`;
    await fivemDb.query(
      'INSERT INTO aderia_vip (identifier, tier, badge, expires_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE tier = VALUES(tier), badge = VALUES(badge), expires_at = VALUES(expires_at)',
      [identifier, tier, badge, expiresAt]
    );

    // Notification en jeu si connecté
    await sendToFiveM('give_vip', { identifier, tier });

    res.json({
      success: true,
      message: `Statut VIP ${tier.toUpperCase()} attribué avec succès pour ${days > 0 ? days + ' jours' : 'durée permanente'} !`
    });
  } catch (err) {
    console.error('[API_MANAGE_VIP_ERROR]', err);
    res.status(500).json({ success: false, error: 'Erreur lors de l’attribution du VIP.' });
  }
});

router.delete('/boutique/vip/:identifier', async (req, res) => {
  try {
    const { identifier } = req.params;
    await fivemDb.query('DELETE FROM aderia_vip WHERE identifier = ?', [identifier]);
    await sendToFiveM('revoke_vip', { identifier });
    res.json({ success: true, message: 'Le statut VIP a été retiré avec succès.' });
  } catch (err) {
    console.error('[API_MANAGE_DEL_VIP_ERROR]', err);
    res.status(500).json({ success: false, error: 'Erreur lors du retrait du VIP.' });
  }
});

// ========================================================
// 15. GIVE ITEMS & ARMES (OX_INVENTORY)
// ========================================================
router.get('/items/list', async (req, res) => {
  try {
    const items = parseOxItems();
    res.json({ success: true, items });
  } catch (err) {
    console.error('[API_MANAGE_ITEMS_LIST_ERROR]', err);
    res.status(500).json({ success: false, error: 'Impossible de charger les items.' });
  }
});

router.post('/items/give', async (req, res) => {
  try {
    const { identifier, item, count } = req.body;
    if (!identifier || !item || !count) {
      return res.status(400).json({ success: false, error: 'Paramètres manquants.' });
    }

    const numCount = Math.max(1, parseInt(count, 10));

    // 1. Tenter le give en direct via FiveM
    const bridgeRes = await sendToFiveM('give_item', { identifier, item, count: numCount });

    // 2. Si le joueur n'est pas en ligne, insérer / empiler dans ox_inventory
    if (!bridgeRes.onlinePlayer) {
      const [[invRow]] = await fivemDb.query('SELECT data FROM ox_inventory WHERE owner = ?', [identifier]);
      let invItems = [];
      if (invRow && invRow.data) {
        try { invItems = JSON.parse(invRow.data); } catch {}
      }

      // Recherche si l'item existe déjà dans un slot pour incrémenter
      let found = false;
      for (const slot of invItems) {
        if (slot.name === item) {
          slot.count = (slot.count || 0) + numCount;
          found = true;
          break;
        }
      }

      if (!found) {
        const nextSlot = (invItems.length > 0 ? Math.max(...invItems.map(i => i.slot || 0)) : 0) + 1;
        invItems.push({
          slot: nextSlot,
          name: item,
          count: numCount
        });
      }

      await fivemDb.query(
        'INSERT INTO ox_inventory (owner, name, data, lastupdated) VALUES (?, ?, ?, NOW()) ON DUPLICATE KEY UPDATE data = VALUES(data), lastupdated = NOW()',
        [identifier, identifier, JSON.stringify(invItems)]
      );
    }

    res.json({
      success: true,
      message: `${numCount}x "${item}" attribué avec succès !` + (bridgeRes.onlinePlayer ? ' (Reçu en jeu instantanément !)' : ' (Sauvegardé dans son inventaire)')
    });
  } catch (err) {
    console.error('[API_MANAGE_GIVE_ITEM_ERROR]', err);
    res.status(500).json({ success: false, error: 'Erreur lors du give d’item.' });
  }
});

// ========================================================
// 16. INFO JOUEUR COMPLET (PROFIL, IP, DISCORD, SANCTIONS, INVENTAIRE)
// ========================================================
function formatPlaytime(mins) {
  if (!mins || isNaN(mins)) return '0 min';
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const minutes = mins % 60;
  const parts = [];
  if (days > 0) parts.push(`${days}j`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes}min`);
  return parts.join(' ');
}

router.get('/player/suggestions', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    let sql = 'SELECT id, firstname, lastname, identifier FROM users';
    let params = [];
    if (q) {
      const cleanId = q.startsWith('#') ? q.substring(1) : q;
      sql += ' WHERE id = ? OR firstname LIKE ? OR lastname LIKE ? OR CONCAT(firstname, " ", lastname) LIKE ? LIMIT 10';
      params = [cleanId, `%${q}%`, `%${q}%`, `%${q}%`];
    } else {
      sql += ' ORDER BY id DESC LIMIT 10';
    }
    const [rows] = await fivemDb.query(sql, params);
    const suggestions = rows.map(r => ({
      id: r.id,
      name: (r.firstname || r.lastname) ? `${r.firstname || ''} ${r.lastname || ''}`.trim() : 'Inconnu',
      identifier: r.identifier
    }));
    res.json({ success: true, suggestions });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Erreur suggestions.' });
  }
});

router.get('/player/profile', async (req, res) => {
  try {
    let query = (req.query.query || '').trim();
    let sql = `
      SELECT u.*, j.label as job_label, jg.label as grade_label
      FROM users u
      LEFT JOIN jobs j ON u.job = j.name
      LEFT JOIN job_grades jg ON u.job = jg.job_name AND u.job_grade = jg.grade
    `;
    let params = [];

    if (query) {
      if (query.startsWith('#')) query = query.substring(1);
      sql += ` WHERE u.id = ? OR u.identifier = ? OR u.license = ? OR u.firstname LIKE ? OR u.lastname LIKE ? OR CONCAT(u.firstname, ' ', u.lastname) LIKE ? LIMIT 1`;
      params = [query, query, query, `%${query}%`, `%${query}%`, `%${query}%`];
    } else {
      sql += ` ORDER BY u.id DESC LIMIT 1`;
    }

    const [rows] = await fivemDb.query(sql, params);
    if (!rows || rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Aucun joueur trouvé avec ces critères de recherche.' });
    }

    const user = rows[0];
    const identifier = user.identifier;
    const license = user.license || identifier;

    // 1. Sanctions : Bans et Warns
    const [bans] = await fivemDb.query(
      'SELECT * FROM aderia_bans WHERE identifier = ? OR license = ? ORDER BY id DESC',
      [identifier, license]
    );

    const [warns] = await fivemDb.query(
      'SELECT * FROM aderia_warns WHERE identifier = ? ORDER BY id DESC',
      [identifier]
    );

    // 2. Identifiants persistés (Discord, IP)
    const [[savedIdent]] = await fivemDb.query(
      'SELECT * FROM aderia_player_identifiers WHERE identifier = ? OR license = ? LIMIT 1',
      [identifier, license]
    );

    // 3. Statut en ligne et identifiants en direct via FiveM Bridge
    let isOnline = false;
    let livePing = null;
    let liveHealth = null;
    let liveSource = null;
    let currentIp = savedIdent ? savedIdent.ip : null;
    let currentDiscord = savedIdent ? savedIdent.discord : null;

    if (!currentIp && bans.length > 0) {
      const banWithIp = bans.find(b => b.ip);
      if (banWithIp) currentIp = banWithIp.ip;
    }
    if (!currentDiscord && bans.length > 0) {
      const banWithDisc = bans.find(b => b.discord);
      if (banWithDisc) currentDiscord = banWithDisc.discord;
    }

    try {
      const bridgeRes = await sendToFiveM('get_player_info', { identifier, id: user.id });
      if (bridgeRes && bridgeRes.liveData && bridgeRes.liveData.online) {
        isOnline = true;
        liveSource = bridgeRes.liveData.source;
        livePing = bridgeRes.liveData.ping;
        liveHealth = bridgeRes.liveData.health;
        if (bridgeRes.liveData.ip) currentIp = bridgeRes.liveData.ip;
        if (bridgeRes.liveData.discord) currentDiscord = bridgeRes.liveData.discord;

        await fivemDb.query(
          'INSERT INTO aderia_player_identifiers (identifier, license, discord, ip, last_seen) VALUES (?, ?, ?, ?, NOW()) ON DUPLICATE KEY UPDATE discord = COALESCE(VALUES(discord), discord), ip = COALESCE(VALUES(ip), ip), last_seen = NOW()',
          [identifier, license, currentDiscord, currentIp]
        );
      }
    } catch (e) {}

    // 4. Inventaire ox_inventory du joueur
    let rawInventory = [];
    try {
      rawInventory = JSON.parse(user.inventory || '[]');
    } catch {}

    const oxCatalog = parseOxItems();
    const catalogMap = new Map(oxCatalog.map(x => [x.name.toLowerCase(), x.label]));

    const inventory = rawInventory.map(it => ({
      slot: it.slot || 1,
      name: it.name,
      label: catalogMap.get((it.name || '').toLowerCase()) || it.name,
      count: it.count || 1,
      metadata: it.metadata || null
    })).sort((a, b) => a.slot - b.slot);

    // 5. Comptes & Statuts
    const accounts = parseAccounts(user.accounts);
    const fullName = (user.firstname || user.lastname) ? `${user.firstname || ''} ${user.lastname || ''}`.trim() : 'Inconnu';

    res.json({
      success: true,
      player: {
        id: user.id,
        uniqueId: user.id,
        identifier: user.identifier,
        license: user.license,
        name: fullName,
        firstname: user.firstname,
        lastname: user.lastname,
        dateofbirth: user.dateofbirth,
        sex: user.sex === 'm' ? 'Homme' : (user.sex === 'f' ? 'Femme' : user.sex),
        nationality: user.nationality || 'FR',
        group: user.group || 'user',
        job: user.job || 'unemployed',
        jobLabel: user.job_label || user.job || 'Sans emploi',
        jobGrade: user.job_grade || 0,
        gradeLabel: user.grade_label || `Grade ${user.job_grade || 0}`,
        playtimeRaw: user.playtime || 0,
        playtimeFormatted: formatPlaytime(user.playtime || 0),
        money: accounts.money,
        bank: accounts.bank,
        black_money: accounts.black_money,
        totalMoney: accounts.money + accounts.bank + accounts.black_money,
        isOnline,
        inGameId: liveSource,
        ping: livePing,
        health: liveHealth,
        ip: currentIp || 'Non enregistrée (Hors ligne)',
        discord: {
          linked: !!currentDiscord,
          id: currentDiscord || null,
          mention: currentDiscord ? `<@${currentDiscord}>` : null
        },
        sanctions: {
          bansCount: bans.length,
          warnsCount: warns.length,
          isCurrentlyBanned: bans.some(b => !b.expires_at || new Date(b.expires_at) > new Date()),
          bans,
          warns
        },
        inventory
      }
    });
  } catch (err) {
    console.error('[API_MANAGE_PLAYER_PROFILE_ERROR]', err);
    res.status(500).json({ success: false, error: 'Erreur lors du chargement du profil joueur.' });
  }
});

// ==========================================
// 12. GESTION DES BLIPS EN DIRECT
// ==========================================

// Liste tous les blips
router.get('/blips', async (req, res) => {
  try {
    const [rows] = await fivemDb.query('SELECT * FROM aderia_blips ORDER BY category ASC, label ASC');
    res.json({
      success: true,
      count: rows.length,
      blips: rows
    });
  } catch (err) {
    console.error('[API_MANAGE_BLIPS_GET_ERROR]', err);
    res.status(500).json({ success: false, error: 'Erreur lors de la récupération des blips.' });
  }
});

// Activer / Désactiver un blip spécifique
router.post('/blips/toggle', async (req, res) => {
  try {
    const { id, is_active } = req.body;
    if (!id || typeof is_active === 'undefined') {
      return res.status(400).json({ success: false, error: 'Paramètres id et is_active requis.' });
    }

    const newStatus = is_active ? 1 : 0;
    await fivemDb.query('UPDATE aderia_blips SET is_active = ? WHERE id = ?', [newStatus, id]);

    // Notification en jeu via FiveM bridge
    let fivemSync = false;
    try {
      const bridgeRes = await sendToFiveM('toggle_blip', {
        id,
        isActive: !!newStatus
      });
      fivemSync = bridgeRes.success || false;
    } catch (bridgeErr) {
      // FiveM potentiellement hors ligne
    }

    res.json({
      success: true,
      id,
      is_active: newStatus,
      fivemSync,
      message: `Blip ${newStatus ? 'activé' : 'désactivé'} avec succès.`
    });
  } catch (err) {
    console.error('[API_MANAGE_BLIPS_TOGGLE_ERROR]', err);
    res.status(500).json({ success: false, error: 'Erreur lors du changement de statut du blip.' });
  }
});

// Activer / Désactiver toute une catégorie de blips
router.post('/blips/toggle-category', async (req, res) => {
  try {
    const { category, is_active } = req.body;
    if (!category || typeof is_active === 'undefined') {
      return res.status(400).json({ success: false, error: 'Paramètres category et is_active requis.' });
    }

    const newStatus = is_active ? 1 : 0;
    await fivemDb.query('UPDATE aderia_blips SET is_active = ? WHERE category = ?', [newStatus, category]);

    // Notification en jeu via FiveM bridge
    let fivemSync = false;
    try {
      const bridgeRes = await sendToFiveM('toggle_blip_category', {
        category,
        isActive: !!newStatus
      });
      fivemSync = bridgeRes.success || false;
    } catch (bridgeErr) {
      // FiveM hors ligne
    }

    res.json({
      success: true,
      category,
      is_active: newStatus,
      fivemSync,
      message: `Catégorie ${category} mise à jour.`
    });
  } catch (err) {
    console.error('[API_MANAGE_BLIPS_TOGGLE_CAT_ERROR]', err);
    res.status(500).json({ success: false, error: 'Erreur lors de la mise à jour de la catégorie.' });
  }
});

// Mettre à jour les propriétés d'un blip (nom, sprite, couleur, échelle)
router.post('/blips/update', async (req, res) => {
  try {
    const { id, label, sprite, color, scale } = req.body;
    if (!id) return res.status(400).json({ success: false, error: 'ID requis.' });

    await fivemDb.query(
      'UPDATE aderia_blips SET label = COALESCE(?, label), sprite = COALESCE(?, sprite), color = COALESCE(?, color), scale = COALESCE(?, scale) WHERE id = ?',
      [label || null, sprite ? parseInt(sprite) : null, color !== undefined ? parseInt(color) : null, scale ? parseFloat(scale) : null, id]
    );

    // Notification en direct
    try {
      await sendToFiveM('refresh_blips', {});
    } catch (e) {}

    res.json({ success: true, message: 'Blip mis à jour avec succès.' });
  } catch (err) {
    console.error('[API_MANAGE_BLIP_UPDATE_ERROR]', err);
    res.status(500).json({ success: false, error: 'Erreur lors de la mise à jour du blip.' });
  }
});

// Proxy haute performance et mise en cache des tuiles de la carte GTA V
const https = require('https');
const fs = require('fs');
const path = require('path');

// Pixel océan 1x1 couleur eau GTA V (#1a3a4a) en PNG
const WATER_PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOQsvICAAEQAJ+lYp46AAAAAElFTkSuQmCC', 'base64');

router.get('/map-tiles/:style/:z/:x/:y', (req, res) => {
  try {
    const { style, z, x, y } = req.params;
    const cleanY = (y || '').replace(/\.(jpg|png|webp)$/i, '');
    const cleanZ = parseInt(z, 10);
    const cleanX = parseInt(x, 10);

    const isGrid = style === 'grid';
    const isSat = style === 'satellite';
    const ext = isGrid ? 'png' : 'jpg';
    const folder = isSat ? 'styleSatelite' : (isGrid ? 'styleGrid' : 'styleAtlas');

    const cacheDir = path.join(__dirname, '../../public/cache/tiles', folder, String(cleanZ), String(cleanX));
    const cacheFile = path.join(cacheDir, `${cleanY}.${ext}`);

    // 1. Si déjà en cache local, envoyer directement
    if (fs.existsSync(cacheFile)) {
      res.setHeader('Content-Type', isGrid ? 'image/png' : 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
      return res.sendFile(cacheFile);
    }

    // 2. Récupérer depuis le dépôt officiel de tuiles GTA V
    const upstreamUrl = `https://raw.githubusercontent.com/Trusted-Studios/mapStyles/master/${folder}/${cleanZ}/${cleanX}/${cleanY}.${ext}`;

    let hasReplied = false;
    const sendFallback = () => {
      if (hasReplied || res.headersSent) return;
      hasReplied = true;
      try {
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.end(WATER_PIXEL_PNG);
      } catch (e) {}
    };

    const request = https.get(upstreamUrl, { timeout: 6000 }, (upstreamRes) => {
      if (hasReplied || res.headersSent) return;
      if (upstreamRes.statusCode === 200) {
        hasReplied = true;
        fs.mkdirSync(cacheDir, { recursive: true });
        const fileStream = fs.createWriteStream(cacheFile);
        upstreamRes.pipe(fileStream);

        res.setHeader('Content-Type', isGrid ? 'image/png' : 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
        upstreamRes.pipe(res);
      } else {
        sendFallback();
      }
    });

    request.on('error', () => {
      sendFallback();
    });

    request.on('timeout', () => {
      request.destroy();
      sendFallback();
    });
  } catch (err) {
    if (!res.headersSent) {
      try {
        res.setHeader('Content-Type', 'image/png');
        res.end(WATER_PIXEL_PNG);
      } catch (e) {}
    }
  }
});

module.exports = router;
