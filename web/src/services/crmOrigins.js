function isConfiguredCrmHost(host) {
  const value = String(process.env.CRM_APP_ORIGIN || '').trim();
  if (!value) return false;
  try { const origin = new URL(value); return origin.protocol === 'https:' && !origin.username && !origin.password && host === origin.hostname; }
  catch { return false; }
}
module.exports = { isConfiguredCrmHost };
