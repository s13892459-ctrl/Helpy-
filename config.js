/** HelProtect defaults. Runtime changes are stored only in memory and are lost when Railway restarts. */
module.exports = {
  version: '1.0.0',
  prefix: 'HP',
  colors: { ok: 0x2ecc71, warning: 0xf1c40f, danger: 0xe74c3c, info: 0x5865f2 },
  defaults: {
    enabled: true, lockdown: false, logChannelId: '', alertChannelId: '',
    modules: { antiraid: true, antinuke: true, antispam: true, antilink: true, antiphishing: true, antibot: true, antimention: true },
    antiraid: { joins: 10, windowMs: 20000, minimumAccountAgeMs: 86400000, action: 'LOCKDOWN' },
    antispam: { messages: 6, windowMs: 7000, duplicate: 3, mentions: 5, action: 'TIMEOUT', timeoutMs: 600000 },
    antinuke: { actions: 3, windowMs: 12000, action: 'REMOVE_PERMISSIONS' },
    antilink: { action: 'DELETE', timeoutMs: 300000, blockedDomains: [], allowedDomains: [] },
    antibot: { action: 'KICK', dangerousPermissions: ['Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'BanMembers', 'KickMembers', 'ManageWebhooks'] },
    whitelist: { users: [], roles: [], bots: [], channels: [], domains: [] }, blacklist: { users: [], domains: [] }, protectedRoleIds: [],
    risk: { decayMs: 3600000, weights: { channelDelete: 25, channelCreate: 12, roleDelete: 30, roleCreate: 15, webhookCreate: 20, ban: 20, kick: 15, dangerousRole: 25, phishing: 35, spam: 15, raid: 45, bot: 35 }, thresholds: { low: 21, medium: 41, high: 61, critical: 81 } },
    actions: { LOW: ['LOG'], MEDIUM: ['LOG', 'ALERT'], HIGH: ['LOG', 'ALERT', 'REMOVE_PERMISSIONS'], CRITICAL: ['LOG', 'ALERT', 'REMOVE_PERMISSIONS', 'LOCKDOWN'] }
  }
};

