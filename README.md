# Panel d'Administration et Système de Licences FiveM

Système sécurisé de gestion de licences logicielles FiveM avec authentification renforcée, 2FA TOTP obligatoire, chiffrement AES-256-GCM / SHA-256 et journal d'audit complet.

---

## 🚀 Démarrage Rapide

### 1. Installation des dépendances
```bash
npm install
```

### 2. Configuration (.env)
Copiez `.env.example` en `.env` (déjà créé pour vous) et adaptez si nécessaire vos identifiants MySQL :
```ini
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=votre_mot_de_passe
DB_NAME=fivem_licenses
```

### 3. Migration Base de Données
Importez le schéma dans votre serveur MySQL :
```bash
mysql -u root -p < database/schema.sql
```
*(ou ouvrez `database/schema.sql` dans HeidiSQL / phpMyAdmin et exécutez la requête)*

### 4. Créer le premier compte Superadmin
```bash
npm run cli:create-admin
```
Suivez les instructions dans la console et ajoutez la clé TOTP dans votre application (Google Authenticator, etc.).

### 5. Lancer l'application
```bash
npm start
```
Accédez au panel sur [http://localhost:3000/admin/login](http://localhost:3000/admin/login).

---

## 🔒 Sécurités Implémentées

- **Argon2id** : Hachage mémoire-dur de dernière génération pour les mots de passe.
- **2FA TOTP Obligatoire** : Authentification à 2 facteurs temporelle sur chaque session admin.
- **Protection Anti-Bruteforce** : Rate limiting à 5 tentatives par 15 min + verrouillage temporaire en base.
- **Mitigation Timing Attack** : Hash fictif exécuté lors des tentatives sur comptes inexistants.
- **Anti-XSS & Anti-CSRF** : Échappement automatique EJS `<%= %>` + double vérification CSRF cryptographique sur toutes les requêtes d'action (`POST`).
- **Chiffrement Hybride des Licences** : 
  - Hash **SHA-256** indexé pour les requêtes FiveM ultra-rapides sans déchiffrement.
  - Chiffrement **AES-256-GCM** avec tag d'authentification et IV unique pour la protection des clés au repos.
- **Zero Backdoor / Zero Clé Maître** : Aucun bypass ni clé codée en dur.

---

## 📡 Endpoint FiveM pour votre ressource

Pour vérifier une licence dans un script FiveM côté serveur (`server.lua`) :

```lua
local licenseKey = "sCORE-XXXX-XXXX-XXXX-XXXX"

PerformHttpRequest("http://localhost:3000/api/licenses/verify", function(status, body, headers)
    if status == 200 then
        local res = json.decode(body)
        if res.valid then
            print("^2[LICENCE VALIDE]^7 Produit: " .. res.product)
        end
    else
        print("^1[LICENCE INVALIDE]^7 " .. tostring(body))
    end
end, "POST", json.encode({ licenseKey = licenseKey, serverName = "Serveur FiveM Test" }), { ["Content-Type"] = "application/json" })
```
