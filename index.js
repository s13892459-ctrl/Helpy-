// ============================================
// HELPY - Bot Discord Sécurité
// Auteur : Sunfire
// Version : 1.0.0
// ============================================

// Charge les variables du fichier .env
require("dotenv").config();

const fs = require("fs");
const path = require("path");

const {
    Client,
    Collection,
    GatewayIntentBits,
    Partials
} = require("discord.js");

const config = require("./config");

// Création du client Discord
const client = new Client({

    intents: [

        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildPresences

    ],

    partials: [

        Partials.Channel,
        Partials.Message,
        Partials.User

    ]

});

// Collections
client.commands = new Collection();
client.cooldowns = new Collection();

client.config = config;

// ============================================
// Bot prêt
// ============================================

client.once("ready", () => {

    console.log("===================================");
    console.log(`✅ ${client.user.tag} connecté`);
    console.log(`📁 Architecture professionnelle`);
    console.log(`🛡️ Helpy Security`);
    console.log("===================================");

});

// ============================================
// Gestion des erreurs
// ============================================

process.on("unhandledRejection", console.error);
process.on("uncaughtException", console.error);
process.on("uncaughtExceptionMonitor", console.error);

// ============================================
// Connexion
// ============================================

client.login(process.env.TOKEN);
