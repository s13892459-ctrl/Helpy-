require('dotenv').config();
const {
  Client, GatewayIntentBits, Partials, Events, AuditLogEvent, PermissionsBitField,
  REST, Routes, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, StringSelectMenuBuilder, ChannelSelectMenuBuilder, UserSelectMenuBuilder, RoleSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  ChannelType
} = require('discord.js');
const base = require('./config');

if (!process.env.DISCORD_TOKEN || !process.env.CLIENT_ID) throw new Error('DISCORD_TOKEN and CLIENT_ID are required.');
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildModeration, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildWebhooks], partials: [Partials.Channel, Partials.Message, Partials.GuildMember] });
const state = new Map(); // Per-guild operational state is deliberately volatile: it disappears on restart/deploy.
const actionEvents = new Map(); const memberEvents = new Map(); const messageEvents = new Map(); const incidents = new Map();
const clone = x => JSON.parse(JSON.stringify(x));
const cfg = guild => { if (!state.has(guild.id)) state.set(guild.id, clone(base.defaults)); return state.get(guild.id); };
const now = () => Date.now();
const trimWindow = (map, key, ms) => { const a = map.get(key) || []; const keep = a.filter(t => now() - t < ms); keep.push(now()); map.set(key, keep); return keep.length; };
const elapsed = ms => { const s = Math.floor(ms / 1000); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m`; };
const level = (score, c) => score >= c.risk.thresholds.critical ? 'CRITICAL' : score >= c.risk.thresholds.high ? 'HIGH' : score >= c.risk.thresholds.medium ? 'MEDIUM' : score >= c.risk.thresholds.low ? 'LOW' : 'SAFE';
const isOwner = (member, guild) => member.id === guild.ownerId || member.id === process.env.OWNER_ID;
const isTrusted = (member, c) => !member || isOwner(member, member.guild) || c.whitelist.users.includes(member.id) || member.roles.cache.some(r => c.whitelist.roles.includes(r.id)) || (member.user.bot && c.whitelist.bots.includes(member.id));
const canManage = i => i.member && (isOwner(i.member, i.guild) || i.member.permissions.has(PermissionsBitField.Flags.ManageGuild) || i.member.permissions.has(PermissionsBitField.Flags.Administrator));
const safeReply = async (i, data) => { try { if (i.deferred || i.replied) await i.followUp(data); else await i.reply(data); } catch (e) { console.error('Interaction reply:', e.message); } };
const botCan = (guild, permission) => guild.members.me?.permissions.has(permission);
async function sendLog(guild, title, description, color = base.colors.info, alert = false) {
  const c = cfg(guild); const id = alert ? (c.alertChannelId || c.logChannelId) : c.logChannelId;
  const ch = id && guild.channels.cache.get(id);
  const embed = new EmbedBuilder().setColor(color).setTitle(title).setDescription(description.slice(0, 4096)).setTimestamp().setFooter({ text: `HelProtect ${base.version}` });
  if (ch?.isTextBased()) try { await ch.send({ embeds: [embed] }); } catch (e) { console.warn('Log unavailable:', e.message); }
  console.log(`[${guild.name}] ${title}: ${description.replace(/\n/g, ' ')}`);
}
function rememberIncident(guild, item) { const list = incidents.get(guild.id) || []; list.unshift({ at: now(), ...item }); incidents.set(guild.id, list.slice(0, 30)); }
async function setLockdown(guild, on, reason) {
  const c = cfg(guild); if (c.lockdown === on) return false; c.lockdown = on;
  // Discord has no server-wide "freeze". Safely deny @everyone SendMessages in text channels we can edit; restoration is approximate.
  for (const ch of guild.channels.cache.values()) {
    if (!ch.isTextBased() || !ch.permissionOverwrites || !botCan(guild, PermissionsBitField.Flags.ManageChannels)) continue;
    try { await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: !on }, { reason: `HelProtect lockdown: ${reason}` }); } catch (e) { console.warn(`Lockdown ${ch.id}:`, e.message); }
  }
  await sendLog(guild, on ? '🔒 LOCKDOWN ACTIVÉ' : '🔓 Lockdown désactivé', `Raison : ${reason}`, on ? base.colors.danger : base.colors.ok, true);
  return true;
}
async function enforce(member, action, reason, c) {
  if (!member || isTrusted(member, c) || isOwner(member, member.guild)) return 'Aucune action (membre approuvé/propriétaire).';
  const me = member.guild.members.me; if (!me || member.roles.highest.comparePositionTo(me.roles.highest) >= 0) return 'Aucune action (hiérarchie Discord).';
  try {
    if (action === 'TIMEOUT' && member.moderatable) await member.timeout(c.antispam.timeoutMs, reason);
    else if (action === 'KICK' && member.kickable) await member.kick(reason);
    else if (action === 'BAN' && member.bannable) await member.ban({ reason });
    else if (action === 'REMOVE_PERMISSIONS') { const roles = member.roles.cache.filter(r => r.editable && r.permissions.any(['Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'BanMembers', 'KickMembers', 'ManageWebhooks'])); for (const r of roles.values()) await member.roles.remove(r, reason); }
    else return 'Journalisé.';
    return action;
  } catch (e) { console.warn('Enforcement:', e.message); return `Échec ${action}: ${e.message}`; }
}
async function risk(guild, actorId, weight, type, detail) {
  const c = cfg(guild); const key = `${guild.id}:${actorId}`; const old = actionEvents.get(key)?.risk || { score: 0, at: now() };
  const score = Math.min(100, Math.max(0, old.score - Math.floor((now() - old.at) / c.risk.decayMs) * 10) + weight);
  actionEvents.set(key, { ...(actionEvents.get(key) || {}), risk: { score, at: now() } }); const severity = level(score, c);
  const actor = await guild.members.fetch(actorId).catch(() => null); let outcome = 'LOG';
  for (const a of c.actions[severity] || []) { if (a === 'REMOVE_PERMISSIONS') outcome = await enforce(actor, a, `HelProtect ${type}: ${detail}`, c); if (a === 'LOCKDOWN') await setLockdown(guild, true, `${type}: ${detail}`); }
  const text = `Type : **${type}**\nResponsable : ${actor ? `${actor} (${actor.id})` : `inconnu (${actorId})`}\nDétail : ${detail}\nRisque : **${severity} ${score}/100**\nAction : ${outcome}`;
  rememberIncident(guild, { severity, type, detail, actorId, score }); await sendLog(guild, `🚨 Incident ${severity}`, text, severity === 'CRITICAL' ? base.colors.danger : base.colors.warning, severity === 'HIGH' || severity === 'CRITICAL');
}
async function auditActor(guild, type, targetId) {
  try { const logs = await guild.fetchAuditLogs({ type, limit: 6 }); const entry = logs.entries.find(e => !targetId || e.targetId === targetId); return entry && now() - entry.createdTimestamp < 15000 ? entry : null; } catch (e) { console.warn('Audit log inaccessible:', e.message); return null; }
}
const urlRE = /(?:https?:\/\/|www\.)[^\s<]+|discord(?:\.gg|\.com\/invite)\/[\w-]+/gi;
function inspectLinks(text, c) {
  const links = text.match(urlRE) || []; let phishing = 0, blocked = false;
  for (const raw of links) { const s = raw.toLowerCase(); const domain = s.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    const allowed = c.whitelist.domains.includes(domain) || c.antlink.allowedDomains.includes(domain); if (allowed) continue;
    if (c.blacklist.domains.includes(domain) || c.antlink.blockedDomains.includes(domain)) blocked = true;
    if (/bit\.ly|tinyurl|t\.co|discord\.(?:gg|gift)|d[ií1]sc[o0]rd|steamcommunit[yv]|nitro|token|login|verify|gift/i.test(s) || /[\u0400-\u04ff\u200b-\u200f]/.test(raw)) phishing += 15;
  }
  if (/\b(token|password|credential|qr code)\b.{0,50}\b(verify|claim|free|nitro|login)\b/i.test(text)) phishing += 20;
  return { links, blocked, phishing };
}
function dashboard(guild) { const c = cfg(guild); const enabled = n => c.modules[n] ? '🟢' : '🔴'; return { embeds: [new EmbedBuilder().setColor(c.lockdown ? base.colors.danger : base.colors.ok).setTitle('🛡️ HelProtect Dashboard').setDescription(`Protection : ${c.enabled ? '🟢 ACTIVE' : '🔴 PAUSED'}${c.lockdown ? '\n🔒 **LOCKDOWN ACTIF**' : ''}`).addFields({ name: 'Modules', value: `Anti-Raid ${enabled('antiraid')} · Anti-Nuke ${enabled('antinuke')} · Anti-Spam ${enabled('antispam')}\nAnti-Link ${enabled('antilink')} · Anti-Phishing ${enabled('antiphishing')} · Anti-Bot ${enabled('antibot')}` }).setFooter({ text: 'Les réglages de ce bot sont en mémoire et seront perdus au redémarrage.' })], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('hp:lock').setLabel(c.lockdown ? 'Déverrouiller' : 'Lockdown').setStyle(c.lockdown ? ButtonStyle.Success : ButtonStyle.Danger), new ButtonBuilder().setCustomId('hp:status').setLabel('Statut').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId('hp:incidents').setLabel('Incidents').setStyle(ButtonStyle.Secondary)), new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('hp:module').setPlaceholder('Activer/désactiver un module').addOptions(Object.keys(c.modules).map(x => ({ label: x, value: x, description: c.modules[x] ? 'Actif — cliquer pour désactiver' : 'Inactif — cliquer pour activer' }))))] }; }
function dashboardPanel(guild) {
  const c = cfg(guild); const states = Object.entries(c.modules).map(([k, v]) => `${v ? '🟢' : '🔴'} ${k}`).join(' · ');
  const overview = new EmbedBuilder().setColor(c.lockdown ? base.colors.danger : base.colors.ok).setTitle('🛡️ HelProtect Dashboard').setDescription(`${c.enabled ? '🟢 Protection active' : '🔴 Protection en pause'}${c.lockdown ? ' · 🔒 LOCKDOWN' : ''}`).addFields({ name: 'Modules', value: states }).setFooter({ text: 'État temporaire : perdu au redémarrage Railway.' });
  const control = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('hp:lock').setLabel(c.lockdown ? 'Déverrouiller' : 'Lockdown').setStyle(c.lockdown ? ButtonStyle.Success : ButtonStyle.Danger), new ButtonBuilder().setCustomId('hp:status').setLabel('Statut').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId('hp:incidents').setLabel('Incidents').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId('hp:channels').setLabel('Salons').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId('hp:cfg-home').setEmoji('◀️').setLabel('Config').setStyle(ButtonStyle.Secondary));
  const modules = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('hp:module').setPlaceholder('Activer/désactiver un module').addOptions(Object.keys(c.modules).map(k => ({ label: k, value: k, description: c.modules[k] ? 'Actif — cliquer pour désactiver' : 'Inactif — cliquer pour activer' }))));
  return { embeds: [overview], components: [control, modules] };
}
function configPanel(guild) {
  const c = cfg(guild);
  const active = Object.values(c.modules).filter(Boolean).length;
  const channels = [c.logChannelId, c.alertChannelId].filter(Boolean).length;
  const icon = guild.iconURL({ size: 256 });
  const embed = new EmbedBuilder().setColor(0x3b82f6).setTitle('⚙️ Configuration de HelProtect').setDescription(`**${guild.name}**\n> Configure les défenses, les alertes et les accès de ton serveur.`).addFields(
    { name: `🛡️ Protection & Modération · ${active}/7`, value: 'Anti-Raid, Anti-Nuke, Anti-Spam, Anti-Link, Anti-Phishing, Anti-Bot et Anti-Mention.', inline: false },
    { name: `📂 Journaux & Alertes · ${channels}/2`, value: `Logs : ${c.logChannelId ? `<#${c.logChannelId}>` : '`Non configuré`'}\nAlertes : ${c.alertChannelId ? `<#${c.alertChannelId}>` : '`Non configuré`'}`, inline: false },
    { name: `👥 Accès & rôles protégés · ${c.whitelist.users.length + c.protectedRoleIds.length}`, value: `${c.whitelist.users.length} membre(s) approuvé(s) · ${c.protectedRoleIds.length} rôle(s) staff protégé(s) · ${c.blacklist.users.length} membre(s) bloqué(s)`, inline: false },
    { name: '📊 Surveillance', value: `${(incidents.get(guild.id) || []).length} incident(s) en mémoire · Lockdown ${c.lockdown ? '🔒 actif' : '🟢 inactif'}`, inline: false }
  ).setFooter({ text: 'HelProtect • Les réglages sont temporaires (mémoire Railway).' });
  if (icon) embed.setThumbnail(icon);
  return { ephemeral: true, embeds: [embed], components: [
    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('hp:cfg-open:protection').setEmoji('🛡️').setLabel('Protection').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId('hp:cfg-open:channels').setEmoji('📂').setLabel('Journaux').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId('hp:cfg-open:access').setEmoji('👥').setLabel('Accès').setStyle(ButtonStyle.Secondary)),
    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('hp:cfg-open:incidents').setEmoji('📊').setLabel('Surveillance').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId('hp:cfg-open:advanced').setEmoji('⚙️').setLabel('Réglages avancés').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId('hp:cfg-close').setEmoji('✖️').setLabel('Fermer').setStyle(ButtonStyle.Danger))
  ] };
}
function channelPicker(kind) { return { content: `Choisis le salon pour **${kind === 'logs' ? 'les logs' : 'les alertes'}**.`, components: [new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId(`hp:cfg-channel:${kind}`).setPlaceholder('Sélectionner un salon').setChannelTypes(ChannelType.GuildText).setMinValues(1).setMaxValues(1))] }; }
function configPicker(kind = 'advanced') {
  const choices = kind === 'channels' ? [{ label: 'Salon de logs', value: 'logs', description: 'Sélectionner un salon Discord' }, { label: 'Salon d’alertes', value: 'alerts', description: 'Sélectionner un salon Discord' }] : kind === 'access' ? [{ label: 'Liste blanche — membre', value: 'whitelist-user', description: 'Ajouter/enlever un membre' }, { label: 'Liste noire — membre', value: 'blacklist-user', description: 'Ajouter/enlever un membre' }, { label: 'Rôles staff protégés', value: 'protected-role', description: 'Ajouter/enlever un rôle' }] : [{ label: 'Salon de logs', value: 'logs', description: 'Choisir un salon' }, { label: 'Salon d’alertes', value: 'alerts', description: 'Choisir un salon' }, { label: 'Liste blanche — membre', value: 'whitelist-user', description: 'Gérer les membres approuvés' }, { label: 'Liste noire — membre', value: 'blacklist-user', description: 'Gérer les membres bloqués' }, { label: 'Rôles staff protégés', value: 'protected-role', description: 'Gérer les rôles protégés' }, { label: 'Modules de protection', value: 'modules', description: 'Anti-raid, anti-nuke, etc.' }, { label: 'Toutes les commandes', value: 'commands', description: 'Voir les commandes disponibles' }];
  return { embeds: [new EmbedBuilder().setColor(base.colors.info).setTitle(kind === 'channels' ? '📂 Journaux & alertes' : kind === 'access' ? '👥 Accès & rôles' : '⚙️ Réglages avancés').setDescription('Choisis une option dans le menu ci-dessous.')], components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('hp:cfg-action').setPlaceholder('Sélectionner une configuration').addOptions(choices)), new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('hp:cfg-home').setEmoji('◀️').setLabel('Retour').setStyle(ButtonStyle.Secondary))] };
}
const commands = [
  new SlashCommandBuilder().setName('dashboard').setDescription('Ouvre le tableau de bord HelProtect'),
  new SlashCommandBuilder().setName('status').setDescription('Affiche l’état de HelProtect'), new SlashCommandBuilder().setName('ping').setDescription('Affiche la latence'), new SlashCommandBuilder().setName('help').setDescription('Aide HelProtect'),
  new SlashCommandBuilder().setName('protection').setDescription('Gère la protection').addSubcommand(s => s.setName('enable').setDescription('Active HelProtect')).addSubcommand(s => s.setName('disable').setDescription('Désactive HelProtect')).addSubcommand(s => s.setName('lockdown').setDescription('Active ou coupe le lockdown').addBooleanOption(o => o.setName('on').setDescription('Activer ?').setRequired(true))),
  new SlashCommandBuilder().setName('lockdown').setDescription('Active le lockdown'), new SlashCommandBuilder().setName('unlockdown').setDescription('Désactive le lockdown'),
  new SlashCommandBuilder().setName('config').setDescription('Ouvre le panneau de configuration HelProtect'),
  ...['antiraid','antinuke','antispam','antlink','antiphishing','antibot'].map(n => new SlashCommandBuilder().setName(n).setDescription(`Active ou désactive ${n}`).addBooleanOption(o => o.setName('enabled').setDescription('Activer ?').setRequired(true))),
  new SlashCommandBuilder().setName('whitelist').setDescription('Gère la liste blanche').addSubcommand(s => s.setName('user').setDescription('Ajoute/enlève un utilisateur').addUserOption(o => o.setName('member').setDescription('Membre').setRequired(true)).addBooleanOption(o => o.setName('add').setDescription('Ajouter ?').setRequired(true))).addSubcommand(s => s.setName('domain').setDescription('Ajoute/enlève un domaine').addStringOption(o => o.setName('domain').setDescription('Domaine').setRequired(true)).addBooleanOption(o => o.setName('add').setDescription('Ajouter ?').setRequired(true))),
  new SlashCommandBuilder().setName('blacklist').setDescription('Gère la liste noire de domaines').addStringOption(o => o.setName('domain').setDescription('Domaine').setRequired(true)).addBooleanOption(o => o.setName('add').setDescription('Ajouter ?').setRequired(true)),
  new SlashCommandBuilder().setName('risk').setDescription('Affiche le risque d’un membre').addUserOption(o => o.setName('member').setDescription('Membre').setRequired(true)),
  new SlashCommandBuilder().setName('security').setDescription('Résumé sécurité'), new SlashCommandBuilder().setName('logs').setDescription('Affiche les derniers incidents'), new SlashCommandBuilder().setName('incidents').setDescription('Affiche les incidents récents')
].map(x => x.toJSON());

client.once(Events.ClientReady, async () => { console.log(`HelProtect online as ${client.user.tag}`); const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN); try { const route = process.env.GUILD_ID ? Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID) : Routes.applicationCommands(process.env.CLIENT_ID); await rest.put(route, { body: commands }); console.log(`Registered ${commands.length} slash commands.`); } catch (e) { console.error('Command registration failed:', e); } });
client.on(Events.GuildMemberAdd, async member => { const c = cfg(member.guild); if (!c.enabled) return; if (c.blacklist.users.includes(member.id)) { const outcome = await enforce(member, 'BAN', 'Membre présent dans la liste noire HelProtect', c); await sendLog(member.guild, '🚫 Liste noire', `${member.user.tag} a rejoint : ${outcome}`, base.colors.danger, true); return; } const count = trimWindow(memberEvents, member.guild.id, c.antiraid.windowMs); const young = now() - member.user.createdTimestamp < c.antiraid.minimumAccountAgeMs; if (c.modules.antibot && member.user.bot) { const a = await auditActor(member.guild, AuditLogEvent.BotAdd, member.id); const dangerous = member.permissions?.any(c.antibot.dangerousPermissions) || false; if (a && !isTrusted(a.executor, c)) { const outcome = await enforce(member, dangerous ? c.antibot.action : 'LOG', 'Bot non approuvé ajouté', c); await risk(member.guild, a.executorId, dangerous ? c.risk.weights.bot : 10, 'Anti-Bot', `Bot ${member.user.tag}; ${outcome}`); } }
  if (c.modules.antiraid && (count >= c.antiraid.joins || (young && count >= Math.ceil(c.antiraid.joins * .7)))) { await sendLog(member.guild, '☢️ Suspicion de raid', `${count} arrivées en ${c.antiraid.windowMs / 1000}s${young ? '; compte récent détecté' : ''}`, base.colors.danger, true); await risk(member.guild, member.id, c.risk.weights.raid, 'Anti-Raid', `${count} arrivées rapides`); if (c.antiraid.action === 'LOCKDOWN') await setLockdown(member.guild, true, 'Détection anti-raid'); }
});
client.on(Events.MessageCreate, async m => { if (!m.guild || m.author.bot) return; const c = cfg(m.guild); if (!c.enabled || isTrusted(m.member, c) || c.whitelist.channels.includes(m.channel.id)) return; const key = `${m.guild.id}:${m.author.id}`; const arr = messageEvents.get(key) || []; arr.push({ at: now(), text: m.content }); const recent = arr.filter(x => now() - x.at < c.antispam.windowMs); messageEvents.set(key, recent);
  const mentions = m.mentions.users.size + m.mentions.roles.size + (m.mentions.everyone ? c.antispam.mentions : 0); const duplicates = recent.filter(x => x.text && x.text === m.content).length; const check = inspectLinks(m.content, c); let reason = '';
  if (c.modules.antimention && (m.mentions.everyone || mentions >= c.antispam.mentions)) reason = 'mentions massives';
  else if (c.modules.antispam && (recent.length >= c.antispam.messages || duplicates >= c.antispam.duplicate)) reason = `spam (${recent.length} messages / ${c.antispam.windowMs / 1000}s)`;
  else if (c.modules.antilink && (check.blocked || (check.links.length && !c.whitelist.domains.length && /discord\.gg|discord\.com\/invite/i.test(m.content)))) reason = 'lien interdit';
  else if (c.modules.antiphishing && check.phishing >= 30) reason = 'signaux de phishing multiples';
  if (reason) { if (m.deletable) await m.delete().catch(() => null); const action = reason.includes('spam') ? c.antispam.action : reason.includes('lien') || reason.includes('phishing') ? c.antlink.action : 'TIMEOUT'; const out = await enforce(m.member, action, `HelProtect: ${reason}`, c); await risk(m.guild, m.author.id, reason.includes('phishing') ? c.risk.weights.phishing : c.risk.weights.spam, 'Protection message', `${reason}; ${out}`); }
});
async function auditNuke(guild, type, targetId, weight, detail) { const c = cfg(guild); if (!c.enabled || !c.modules.antinuke) return; const e = await auditActor(guild, type, targetId); if (!e || e.executorId === client.user.id) return; const member = await guild.members.fetch(e.executorId).catch(() => null); if (isTrusted(member, c)) return; const n = trimWindow(actionEvents, `${guild.id}:${e.executorId}:${type}`, c.antinuke.windowMs); if (n >= c.antinuke.actions) await risk(guild, e.executorId, weight, 'Anti-Nuke', `${detail} (${n} actions)`); else await sendLog(guild, '🛡️ Action sensible', `${detail} par <@${e.executorId}> (${n}/${c.antinuke.actions})`, base.colors.warning); }
client.on(Events.ChannelCreate, ch => auditNuke(ch.guild, AuditLogEvent.ChannelCreate, ch.id, cfg(ch.guild).risk.weights.channelCreate, `création du salon #${ch.name}`));
client.on(Events.ChannelDelete, ch => auditNuke(ch.guild, AuditLogEvent.ChannelDelete, ch.id, cfg(ch.guild).risk.weights.channelDelete, `suppression du salon ${ch.name}`));
client.on(Events.ChannelUpdate, (_, ch) => auditNuke(ch.guild, AuditLogEvent.ChannelUpdate, ch.id, 10, `modification du salon ${ch.name}`));
client.on(Events.GuildRoleCreate, r => auditNuke(r.guild, AuditLogEvent.RoleCreate, r.id, cfg(r.guild).risk.weights.roleCreate, `création du rôle ${r.name}`));
client.on(Events.GuildRoleDelete, r => auditNuke(r.guild, AuditLogEvent.RoleDelete, r.id, cfg(r.guild).risk.weights.roleDelete, `suppression du rôle ${r.name}`));
client.on(Events.GuildRoleUpdate, (_, r) => auditNuke(r.guild, AuditLogEvent.RoleUpdate, r.id, r.permissions.has('Administrator') ? cfg(r.guild).risk.weights.dangerousRole : 10, `modification du rôle ${r.name}`));
client.on(Events.GuildBanAdd, ban => auditNuke(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id, cfg(ban.guild).risk.weights.ban, `bannissement de ${ban.user.tag}`));
client.on(Events.WebhooksUpdate, ch => auditNuke(ch.guild, AuditLogEvent.WebhookCreate, null, cfg(ch.guild).risk.weights.webhookCreate, `webhook modifié dans #${ch.name}`));
client.on(Events.GuildMemberUpdate, async (before, after) => {
  const c = cfg(after.guild); if (!c.enabled || !c.modules.antinuke) return;
  const added = after.roles.cache.filter(r => !before.roles.cache.has(r.id));
  const protectedRemoved = before.roles.cache.some(r => !after.roles.cache.has(r.id) && c.protectedRoleIds.includes(r.id));
  const dangerous = added.some(r => r.permissions.any(['Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'BanMembers', 'KickMembers', 'ManageWebhooks']));
  if (!dangerous && !protectedRemoved) return;
  const e = await auditActor(after.guild, AuditLogEvent.MemberRoleUpdate, after.id);
  if (e && !isTrusted(await after.guild.members.fetch(e.executorId).catch(() => null), c)) await risk(after.guild, e.executorId, dangerous ? c.risk.weights.dangerousRole : 20, 'Protection rôles/staff', dangerous ? `rôle dangereux attribué à ${after.user.tag}` : `rôle staff protégé retiré de ${after.user.tag}`);
});
client.on(Events.InteractionCreate, async i => { if (!i.guild) return safeReply(i, { content: 'Cette commande doit être utilisée dans un serveur.', ephemeral: true }); const c = cfg(i.guild);
  if (i.isButton() && i.customId === 'hp:channels') { if (!canManage(i)) return safeReply(i, { content: 'Permission Manage Server requise.', ephemeral: true }); const panel = configPanel(i.guild); delete panel.ephemeral; return i.update(panel); }
  if (i.isButton() && i.customId === 'hp:cfg-dashboard') { if (!canManage(i)) return safeReply(i, { content: 'Permission Manage Server requise.', ephemeral: true }); return i.update(dashboardPanel(i.guild)); }
  if (i.isButton() && i.customId === 'hp:cfg-home') { if (!canManage(i)) return safeReply(i, { content: 'Permission Manage Server requise.', ephemeral: true }); const panel = configPanel(i.guild); delete panel.ephemeral; return i.update(panel); }
  if (i.isButton() && i.customId === 'hp:cfg-close') { if (!canManage(i)) return safeReply(i, { content: 'Permission Manage Server requise.', ephemeral: true }); return i.update({ embeds: [new EmbedBuilder().setColor(base.colors.ok).setDescription('✅ Panneau de configuration fermé.')], components: [] }); }
  if (i.isButton() && i.customId.startsWith('hp:cfg-open:')) { if (!canManage(i)) return safeReply(i, { content: 'Permission Manage Server requise.', ephemeral: true }); const section = i.customId.split(':')[2]; if (section === 'protection') return i.update(dashboardPanel(i.guild)); if (section === 'channels' || section === 'access' || section === 'advanced') return i.update(configPicker(section)); if (section === 'incidents') { const view = incidentView(i.guild, false); view.components = [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('hp:cfg-home').setEmoji('◀️').setLabel('Retour').setStyle(ButtonStyle.Secondary))]; return i.update(view); } }
  if (i.isStringSelectMenu() && i.customId === 'hp:cfg-action') {
    if (!canManage(i)) return safeReply(i, { content: 'Permission Manage Server requise.', ephemeral: true }); const choice = i.values[0];
    if (choice === 'logs' || choice === 'alerts') return i.update(channelPicker(choice));
    if (choice === 'whitelist-user' || choice === 'blacklist-user') return i.update({ content: `Sélectionne le membre à ajouter/enlever de la ${choice === 'whitelist-user' ? 'liste blanche' : 'liste noire'}.`, components: [new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId(`hp:cfg-user:${choice}`).setPlaceholder('Sélectionner un membre').setMinValues(1).setMaxValues(1))] });
    if (choice === 'protected-role') return i.update({ content: 'Sélectionne un rôle staff à ajouter/enlever de la protection.', components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('hp:cfg-role:protected').setPlaceholder('Sélectionner un rôle').setMinValues(1).setMaxValues(1))] });
    if (choice === 'modules') return i.update(dashboardPanel(i.guild));
    return i.update({ embeds: [new EmbedBuilder().setColor(base.colors.info).setTitle('📋 Commandes HelProtect').setDescription('`/dashboard` ` /protection` ` /config` ` /security` ` /logs` ` /incidents` ` /lockdown` ` /unlockdown`\n`/whitelist` ` /blacklist` ` /antiraid` ` /antinuke` ` /antispam` ` /antlink` ` /antiphishing` ` /antibot`\n`/risk` ` /status` ` /ping` ` /help`\n\nLes modules, salons, membres et rôles sont aussi gérables depuis ces menus.')], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('hp:cfg-dashboard').setLabel('Retour au dashboard').setStyle(ButtonStyle.Primary))] });
  }
  if (i.isChannelSelectMenu() && i.customId.startsWith('hp:cfg-channel:')) { if (!canManage(i)) return safeReply(i, { content: 'Permission Manage Server requise.', ephemeral: true }); const kind = i.customId.split(':')[1]; c[kind === 'logs' ? 'logChannelId' : 'alertChannelId'] = i.values[0]; return i.update({ content: `${kind === 'logs' ? 'Salon de logs' : 'Salon d’alertes'} : <#${i.values[0]}>.`, components: [] }); }
  if (i.isUserSelectMenu() && i.customId.startsWith('hp:cfg-user:')) { if (!canManage(i)) return safeReply(i, { content: 'Permission Manage Server requise.', ephemeral: true }); const which = i.customId.split(':')[1]; const list = which === 'whitelist-user' ? c.whitelist.users : c.blacklist.users; const userId = i.values[0]; const exists = list.includes(userId); if (exists) list.splice(list.indexOf(userId), 1); else list.push(userId); return i.update({ content: `<@${userId}> ${exists ? 'retiré de la' : 'ajouté à la'} ${which === 'whitelist-user' ? 'liste blanche' : 'liste noire'}.`, components: [] }); }
  if (i.isRoleSelectMenu() && i.customId === 'hp:cfg-role:protected') { if (!canManage(i)) return safeReply(i, { content: 'Permission Manage Server requise.', ephemeral: true }); const roleId = i.values[0]; const exists = c.protectedRoleIds.includes(roleId); if (exists) c.protectedRoleIds.splice(c.protectedRoleIds.indexOf(roleId), 1); else c.protectedRoleIds.push(roleId); return i.update({ content: `<@&${roleId}> ${exists ? 'n’est plus' : 'est désormais'} protégé.`, components: [] }); }
  if (i.isButton()) { if (!canManage(i)) return safeReply(i, { content: 'Permission Manage Server requise.', ephemeral: true }); if (i.customId === 'hp:lock') { await setLockdown(i.guild, !c.lockdown, `Demandé par ${i.user.tag}`); return i.update(dashboardPanel(i.guild)); } if (i.customId === 'hp:status') return safeReply(i, { embeds: [statusEmbed(i.guild)], ephemeral: true }); if (i.customId === 'hp:incidents') return safeReply(i, incidentView(i.guild, true)); if (i.customId === 'hp:channels') { const modal = new ModalBuilder().setCustomId('hp:channels-modal').setTitle('Salons HelProtect'); const logs = new TextInputBuilder().setCustomId('logs').setLabel('ID salon de logs (vide = laisser)').setStyle(TextInputStyle.Short).setRequired(false).setValue(c.logChannelId || ''); const alerts = new TextInputBuilder().setCustomId('alerts').setLabel('ID salon d’alertes (vide = laisser)').setStyle(TextInputStyle.Short).setRequired(false).setValue(c.alertChannelId || ''); return i.showModal(modal.addComponents(new ActionRowBuilder().addComponents(logs), new ActionRowBuilder().addComponents(alerts))); } }
  if (i.isModalSubmit() && i.customId === 'hp:channels-modal') { if (!canManage(i)) return safeReply(i, { content: 'Permission Manage Server requise.', ephemeral: true }); for (const [field, target] of [['logs', 'logChannelId'], ['alerts', 'alertChannelId']]) { const id = i.fields.getTextInputValue(field).trim(); if (!id) continue; const ch = i.guild.channels.cache.get(id); if (!ch?.isTextBased()) return safeReply(i, { content: `Le salon ${field} est introuvable ou non textuel.`, ephemeral: true }); c[target] = id; } return safeReply(i, { content: 'Salons enregistrés en mémoire.', ephemeral: true }); }
  if (i.isStringSelectMenu() && i.customId === 'hp:module') { if (!canManage(i)) return safeReply(i, { content: 'Permission Manage Server requise.', ephemeral: true }); const k = i.values[0]; c.modules[k] = !c.modules[k]; await sendLog(i.guild, '⚙️ Configuration', `${k} : ${c.modules[k] ? 'activé' : 'désactivé'} par ${i.user.tag}`); return i.update(dashboardPanel(i.guild)); }
  if (!i.isChatInputCommand()) return; const publicCommands = ['dashboard','status','ping','help','security','logs','incidents']; if (!publicCommands.includes(i.commandName) && !canManage(i)) return safeReply(i, { content: 'Permission **Manage Server** (ou administrateur/propriétaire) requise.', ephemeral: true });
  const reply = (data) => safeReply(i, data); const name = i.commandName;
  if (name === 'dashboard') return reply({ ...dashboardPanel(i.guild), ephemeral: true }); if (name === 'status') return reply({ embeds: [statusEmbed(i.guild)], ephemeral: true }); if (name === 'ping') return reply({ embeds: [new EmbedBuilder().setColor(base.colors.info).setTitle('❤️ HelProtect Ping').setDescription(`Gateway : **${client.ws.ping} ms**\nUptime : **${elapsed(client.uptime)}**`)], ephemeral: true });
  if (name === 'help') return reply({ embeds: [new EmbedBuilder().setColor(base.colors.info).setTitle('🆘 HelProtect — Aide').setDescription('**Protection** : /antiraid, /antinuke, /antispam, /antlink, /antiphishing, /antibot\n**Sécurité** : /protection, /lockdown, /unlockdown, /risk\n**Configuration** : /config, /whitelist, /blacklist\n**Informations** : /dashboard, /status, /logs, /incidents, /ping')], ephemeral: true });
  if (name === 'security') return reply({ embeds: [new EmbedBuilder().setColor(base.colors.info).setTitle('🛡️ Résumé sécurité').setDescription(`Lockdown : ${c.lockdown ? '🔒 actif' : '🟢 inactif'}\nIncidents mémorisés : ${(incidents.get(i.guild.id) || []).length}\nJournal : ${c.logChannelId ? `<#${c.logChannelId}>` : 'non configuré'}\nAlertes : ${c.alertChannelId ? `<#${c.alertChannelId}>` : 'non configuré'}`)], ephemeral: true });
  if (name === 'logs' || name === 'incidents') return reply(incidentView(i.guild, true));
  if (name === 'lockdown' || name === 'unlockdown') { await setLockdown(i.guild, name === 'lockdown', `Commande de ${i.user.tag}`); return reply({ content: `Lockdown ${name === 'lockdown' ? 'activé' : 'désactivé'}.`, ephemeral: true }); }
  if (['antiraid','antinuke','antispam','antlink','antiphishing','antibot'].includes(name)) { const k = name === 'antlink' ? 'antilink' : name; c.modules[k] = i.options.getBoolean('enabled'); return reply({ content: `${k} ${c.modules[k] ? 'activé' : 'désactivé'}.`, ephemeral: true }); }
  if (name === 'protection') { const sub = i.options.getSubcommand(); if (sub === 'enable' || sub === 'disable') c.enabled = sub === 'enable'; else await setLockdown(i.guild, i.options.getBoolean('on'), `Commande de ${i.user.tag}`); return reply({ content: 'Protection mise à jour.', ephemeral: true }); }
  if (name === 'config') return reply(configPanel(i.guild));
  if (name === 'whitelist') { const sub = i.options.getSubcommand(); const value = sub === 'user' ? i.options.getUser('member').id : i.options.getString('domain').toLowerCase(); const list = sub === 'user' ? c.whitelist.users : c.whitelist.domains; const add = i.options.getBoolean('add'); if (add && !list.includes(value)) list.push(value); if (!add) list.splice(list.indexOf(value), 1); return reply({ content: `Liste blanche mise à jour : ${value}`, ephemeral: true }); }
  if (name === 'blacklist') { const value = i.options.getString('domain').toLowerCase(); const add = i.options.getBoolean('add'); if (add && !c.blacklist.domains.includes(value)) c.blacklist.domains.push(value); if (!add) c.blacklist.domains.splice(c.blacklist.domains.indexOf(value), 1); return reply({ content: `Liste noire mise à jour : ${value}`, ephemeral: true }); }
  if (name === 'risk') { const u = i.options.getUser('member'); const r = actionEvents.get(`${i.guild.id}:${u.id}`)?.risk || { score: 0 }; return reply({ embeds: [new EmbedBuilder().setColor(base.colors.warning).setTitle('🧠 Risk score').setDescription(`${u} : **${level(r.score, c)} ${r.score}/100**\nLe score décroit après ${elapsed(c.risk.decayMs)} sans incident.`)], ephemeral: true }); }
});
function statusEmbed(guild) { const c = cfg(guild); return new EmbedBuilder().setColor(c.enabled ? base.colors.ok : base.colors.danger).setTitle('HelProtect Status').setDescription(`Bot : 🟢 Online\nProtection : ${c.enabled ? '🟢 Active' : '🔴 Pausée'}\nAnti-Raid : ${c.modules.antiraid ? '🟢' : '🔴'}\nAnti-Nuke : ${c.modules.antinuke ? '🟢' : '🔴'}\nAnti-Spam : ${c.modules.antispam ? '🟢' : '🔴'}\nAnti-Link : ${c.modules.antilink ? '🟢' : '🔴'}\nAnti-Phishing : ${c.modules.antiphishing ? '🟢' : '🔴'}\nAnti-Bot : ${c.modules.antibot ? '🟢' : '🔴'}\nLatency : ${client.ws.ping} ms\nUptime : ${elapsed(client.uptime)}\nVersion : ${base.version}`); }
function incidentView(guild, ephemeral) { const list = incidents.get(guild.id) || []; return { ephemeral, embeds: [new EmbedBuilder().setColor(base.colors.warning).setTitle('🚨 Incidents récents').setDescription(list.length ? list.slice(0, 10).map(x => `**${x.severity}** · ${x.type} · <t:${Math.floor(x.at / 1000)}:R>\n${x.detail}`).join('\n\n') : 'Aucun incident en mémoire.')] }; }
process.on('unhandledRejection', e => console.error('Unhandled rejection:', e)); process.on('uncaughtException', e => console.error('Uncaught exception:', e));
client.login(process.env.DISCORD_TOKEN).catch(e => { console.error('Login failed:', e.message); process.exitCode = 1; });
