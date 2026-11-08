-- ====================================================================
-- zk_auth : Protection de Licence Avancée FiveM (Anti-Bypass & Entrelacement)
-- ====================================================================

local isLicenseValid = false
local sessionAuthToken = nil

local function generateLocalToken()
    local chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    local token = ""
    math.randomseed(os.time() + math.random(1000, 9999))
    for i = 1, 32 do
        local rand = math.random(#chars)
        token = token .. string.sub(chars, rand, rand)
    end
    return token
end

local function crashServer(reason)
    print("^1==========================================================^7")
    print("^1[aderia SECURITY] ALERTE DE SÉCURITÉ CRITIQUE :^7")
    print("^1" .. tostring(reason) .. "^7")
    print("^1ARRÊT IMMÉDIAT DU SERVEUR FIVEM.^7")
    print("^1==========================================================^7")
    
    Citizen.Wait(2000)
    -- Arrêt forcé du processus FiveM
    os.exit(1)
end

local function verifyLicense(cb)
    local key = Config.LicenseKey
    if not key or key == "" or key == "VOTRE_CLE_ICI" then
        crashServer("Aucune clé de licence configurée dans server.cfg ou config.lua")
        return
    end

    local serverName = GetConvar("sv_hostname", "Serveur FiveM")

    PerformHttpRequest(Config.AuthURL, function(statusCode, responseText, headers)
        if statusCode == 200 then
            local data = json.decode(responseText)
            if data and data.valid == true then
                if Config.ExpectedProduct and data.product ~= Config.ExpectedProduct then
                    crashServer("Cette clé est valide pour '" .. tostring(data.product) .. "' mais pas pour '" .. tostring(Config.ExpectedProduct) .. "'.")
                    return
                end

                isLicenseValid = true
                sessionAuthToken = generateLocalToken()
                
                print("^2[aderia SECURITY] Licence vérifiée avec succès !^7")
                print("^2[aderia SECURITY] Produit : " .. tostring(data.product) .. " | Type : " .. tostring(data.type) .. "^7")
                
                if cb then cb(true) end
            else
                crashServer("Réponse invalide du serveur de licence : " .. (data and data.error or "Inconnu"))
            end
        else
            local err = "Code HTTP: " .. tostring(statusCode)
            if responseText then
                local d = json.decode(responseText)
                if d and d.error then err = d.error end
            end
            crashServer("Échec de la validation de licence : " .. err)
        end
    end, "POST", json.encode({
        licenseKey = key,
        serverName = serverName
    }), { ["Content-Type"] = "application/json" })
end

-- 1. Vérification bloquante au démarrage
Citizen.CreateThread(function()
    print("^3[aderia SECURITY] Initialisation de la protection de licence...^7")
    verifyLicense(function(success)
        -- Déclenchement de l'événement interne pour déverrouiller le Core
        TriggerEvent("zk_auth:onLicenseVerified", sessionAuthToken)
    end)
end)

-- 2. Heartbeat en tâche de fond (vérification périodique toutes les X minutes)
Citizen.CreateThread(function()
    while true do
        Citizen.Wait(Config.HeartbeatInterval or 300000)
        if not isLicenseValid then
            crashServer("Piratage détecté : Le statut de licence a été altéré.")
        end

        verifyLicense(function(success)
            if not success then
                crashServer("La vérification périodique de licence a échoué.")
            end
        end)
    end
end)

-- 3. Export sécurisé consommable uniquement par votre Core
exports("IsCoreAuthorized", function(providedToken)
    -- Si quelqu'un appelle la fonction sans le bon token généré lors de la vérification HTTP
    if not isLicenseValid or not sessionAuthToken or providedToken ~= sessionAuthToken then
        return false
    end
    return true
end)

exports("GetAuthToken", function()
    return sessionAuthToken
end)

-- 4. Surveillance anti-suppression / anti-arrêt de la ressource
AddEventHandler("onResourceStop", function(resourceName)
    if resourceName == GetCurrentResourceName() then
        print("^1[aderia SECURITY] Tentative d'arrêt de zk_auth détectée !^7")
        crashServer("La ressource de sécurité zk_auth ne peut pas être arrêtée.")
    end
end)
