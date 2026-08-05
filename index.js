/**
 * Point d'entrée de Helpy.
 *
 * Cette version garde volontairement le socle dans un seul fichier. À mesure
 * que le bot grandira, déplacez les commandes vers commands/, les écouteurs
 * vers events/, et les services de sécurité vers services/ ou utils/ sans
 * modifier l'initialisation du client ci-dessous.
 */
const {
  Client,
  Collection,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder
} = require('discord.js');
const config = require('./config');

// Les intents sont les événements que Discord autorise Helpy à recevoir.
// GuildMembers et MessageContent doivent aussi être activés dans le portail
// développeur Discord avant d'implémenter l'anti-raid et l'anti-spam.
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration
  ]
});

// Une Collection sert de registre extensible : plus tard, chaque fichier de
// commands/ pourra y ajouter sa commande sans modifier le routeur ci-dessous.
client.commands = new Collection();

/** Affiche une ligne de log cohérente, prête à être capturée par Railway. */
function log(level, message, error) {
  const prefix = `[${new Date().toISOString()}] [${config.logging.serviceName}] [${level}]`;
  if (error) console.error(prefix, message, error);
  else console.log(prefix, message);
}

// Chaque commande contient les données envoyées à Discord et son exécuteur.
// Dans une future architecture, exportez le même objet depuis commands/ping.js.
const commandDefinitions = [
  {
    data: new SlashCommandBuilder()
      .setName('ping')
      .setDescription('Vérifie que Helpy est disponible.'),
    async execute(interaction) {
      await interaction.reply({ content: `Helpy est opérationnel — ${client.ws.ping} ms.`, ephemeral: true });
    }
  },
  {
    data: new SlashCommandBuilder()
      .setName('help')
      .setDescription('Affiche les fonctions actuellement disponibles.'),
    async execute(interaction) {
      await interaction.reply({
        content: 'Helpy est prêt. Les protections anti-spam, anti-raid, anti-liens, anti-phishing, anti-nuke, les logs et le score de risque seront ajoutés sous forme de modules.',
        ephemeral: true
      });
    }
  }
];

for (const command of commandDefinitions) {
  client.commands.set(command.data.name, command);
}

/**
 * Enregistre les commandes Slash auprès de l'API Discord.
 * Les commandes de test sont instantanées ; les commandes globales peuvent
 * prendre un peu de temps à se propager après leur premier enregistrement.
 */
async function registerSlashCommands() {
  const rest = new REST({ version: '10' }).setToken(config.token);
  const body = commandDefinitions.map((command) => command.data.toJSON());
  const route = config.testGuildId
    ? Routes.applicationGuildCommands(config.clientId, config.testGuildId)
    : Routes.applicationCommands(config.clientId);

  await rest.put(route, { body });
  log('INFO', `${body.length} commande(s) Slash enregistrée(s)${config.testGuildId ? ' sur le serveur de test' : ' globalement'}.`);
}

// Ce routeur reste stable même lorsque les commandes seront réparties en fichiers.
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (error) {
    log('ERROR', `Échec de la commande /${interaction.commandName}.`, error);
    const reply = { content: 'Une erreur est survenue lors de cette commande.', ephemeral: true };
    if (interaction.replied || interaction.deferred) await interaction.followUp(reply);
    else await interaction.reply(reply);
  }
});

client.once(Events.ClientReady, (readyClient) => {
  log('INFO', `Connecté à Discord en tant que ${readyClient.user.tag}.`);
});

// Les erreurs réseau ne doivent jamais révéler le token dans les journaux.
client.on(Events.Error, (error) => log('ERROR', 'Erreur Discord non gérée.', error));
process.on('unhandledRejection', (error) => log('ERROR', 'Promesse rejetée non gérée.', error));
process.on('uncaughtException', (error) => log('ERROR', 'Exception non gérée.', error));

// L'ordre est important : les commandes sont disponibles avant la connexion du bot.
async function start() {
  try {
    await registerSlashCommands();
    await client.login(config.token);
  } catch (error) {
    log('ERROR', 'Impossible de démarrer Helpy.', error);
    process.exitCode = 1;
  }
}

start();
