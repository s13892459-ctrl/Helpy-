/**
 * Configuration centralisée de Helpy.
 *
 * Les secrets restent dans .env : ce fichier ne fait que les lire et fournit
 * les réglages non sensibles. Les futurs modules (anti-spam, base de données,
 * dashboard, etc.) importeront cette même configuration.
 */
require('dotenv').config();

/** Vérifie les variables indispensables avant toute connexion à Discord. */
function requireEnvironmentVariable(name) {
  const value = process.env[name];

  if (!value || value.startsWith('remplacez_')) {
    throw new Error(`La variable d'environnement ${name} doit être renseignée dans .env.`);
  }

  return value;
}

module.exports = Object.freeze({
  // Identifiants privés de l'application Discord.
  token: requireEnvironmentVariable('DISCORD_TOKEN'),
  clientId: requireEnvironmentVariable('CLIENT_ID'),
  testGuildId: process.env.TEST_GUILD_ID || null,

  // Valeurs de départ pour les futurs systèmes de protection.
  security: Object.freeze({
    antiSpam: Object.freeze({ messages: 6, intervalMs: 5_000 }),
    antiRaid: Object.freeze({ joins: 10, intervalMs: 15_000 }),
    riskScore: Object.freeze({ minimum: 0, maximum: 100, alertAt: 70 })
  }),

  // Préfixe des messages de journalisation dans Railway et dans la console locale.
  logging: Object.freeze({ serviceName: 'Helpy' })
});
