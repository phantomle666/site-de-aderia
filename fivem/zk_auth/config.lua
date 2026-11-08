Config = {}

-- URL de ton panel de licences (en dev: http://127.0.0.1:3000 ou en prod: https://ton-domaine.fr)
Config.AuthURL = "http://127.0.0.1:3000/api/licenses/verify"

-- Clé de licence du client (peut être renseignée ici ou via setr aderia_license "sCORE-..." dans server.cfg)
Config.LicenseKey = GetConvar("aderia_license", "sCORE-3650-EE44-B270-A4B5")

-- Nom ou identifiant du produit attendu
Config.ExpectedProduct = "base indulgent"

-- Intervalle de vérification en arrière-plan (Heartbeat en millisecondes - ex: 5 minutes)
Config.HeartbeatInterval = 5 * 60 * 1000
