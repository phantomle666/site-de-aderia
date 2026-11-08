# 🛡️ Protection Anti-Bypass & Entrelacement avec le Core FiveM

Si un client achète ta base et décide de :
1. **Supprimer `zk_auth`** du dossier resources
2. Ou **enlever `ensure zk_auth`** de son `server.cfg`
3. Ou **modifier `zk_auth`** pour renvoyer `true` sans vérifier la licence

Voici exactement comment empêcher le serveur de tourner :

---

## 🔒 Étape 1 : Entrelacer le Core (Dans ton script Core principal)

Dans un fichier central de ton core (par exemple `server/main.lua` ou `server/init.lua`), intègre ce bloc **au tout début** :

```lua
-- ====================================================================
-- aderia Core Security Lock (Entrelacement obligatoire)
-- ====================================================================
local CoreUnlocked = false
local InternalSecurityKey = nil

-- 1. Si zk_auth n'est pas démarré, crash direct
if GetResourceState("zk_auth") ~= "started" and GetResourceState("zk_auth") ~= "starting" then
    print("^1[CORE ERROR] La ressource de sécurité zk_auth est manquante ou arrêtée !^7")
    Citizen.Wait(1000)
    os.exit(1)
end

-- 2. Attente de la validation de la licence
AddEventHandler("zk_auth:onLicenseVerified", function(receivedToken)
    InternalSecurityKey = receivedToken
    CoreUnlocked = true
    print("^2[CORE] Base déverrouillée et fonctionnelle.^7")
end)

-- 3. Watchdog : si dans 15 secondes la licence n'est pas validée, crash
Citizen.CreateThread(function()
    Citizen.Wait(15000)
    if not CoreUnlocked then
        print("^1[CORE ERROR] Échec de l'authentification de la base (Timeout ou contournement). Arrêt du serveur.^7")
        os.exit(1)
    end
end)
```

---

## 🔒 Étape 2 : Conditionner les fonctions critiques du Core

Pour éviter qu'un pirate ne fasse simplement un faux event `TriggerEvent("zk_auth:onLicenseVerified")`, lie les fonctions vitales du core (ex: chargement joueur, spawn, inventaire) à l'export sécurisé de `zk_auth` :

```lua
-- Exemple dans une fonction essentielle de ton Core (ex: création de joueur / base de données)
RegisterNetEvent("core:playerLoaded", function()
    local src = source
    
    -- Vérification auprès de zk_auth avec le token de session dynamique
    local isAuthorized = exports["zk_auth"]:IsCoreAuthorized(InternalSecurityKey)
    if not isAuthorized then
        DropPlayer(src, "Authentification de base invalide.")
        return
    end

    -- Code normal de chargement du joueur...
end)
```

---

## 🔒 Étape 3 : Dépendance dure dans le `fxmanifest.lua` du Core

Dans le fichier `fxmanifest.lua` de ton core (ou tes scripts vendus), ajoute la dépendance obligatoire :

```lua
dependencies {
    'zk_auth'
}
```
Si `zk_auth` est absent, FiveM refusera même de lancer ton core.

---

## 🔒 Étape 4 : Obfuscation (Optionnel mais recommandé pour la vente)

- Passe les fichiers clés (`zk_auth/server.lua` et l'initialisation de ton core) dans un obfuscateur Lua (ou via le système d'Asset Escrow officiel de Tebex / Keymaster).
- Comme le code `server.lua` appelle ton API locale (`http://.../api/licenses/verify`), si le client change d'IP ou dépasse son quota de serveurs, son serveur se coupera automatiquement.
