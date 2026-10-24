const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const required = [
  'public/divedeep/index.html', 'public/divedeep/signup.html', 'public/divedeep/login.html',
  'public/divedeep/app.html', 'public/divedeep/privacy.html', 'public/divedeep/terms.html',
  'public/divedeep/legal.html', 'public/divedeep/notice-at-collection.html', 'public/divedeep/responsible-data.html',
  'public/divedeep/authorized-agent.html', 'public/divedeep/electronic-records.html', 'public/divedeep/privacy-rights.html',
  'public/divedeep/security.html',
  'public/css/divedeep.css', 'public/js/divedeep-auth.js', 'public/js/divedeep-app.js',
  'public/admin/divedeep.html', 'public/css/divedeep-admin.css', 'public/js/divedeep-admin.js', 'public/js/divedeep-admin-v1.13.0.js', 'public/js/divedeep-zip.js',
];
for (const relative of required) {
  const full = path.join(root, relative);
  assert.ok(fs.existsSync(full), `Missing DiveDeep UI asset: ${relative}`);
  assert.ok(fs.statSync(full).size > 100, `DiveDeep UI asset is unexpectedly empty: ${relative}`);
}
const app = fs.readFileSync(path.join(root, 'public/divedeep/app.html'), 'utf8');
assert.ok(app.includes('Found online'));
assert.ok(app.includes('Removal activity'));
assert.ok(app.includes('Connected profiles'));
assert.ok(app.includes('Facebook Images'));
assert.ok(app.includes('Facebook Posts'));
assert.ok(app.includes('Instagram Images'));
assert.ok(app.includes('Account Protection'));
assert.ok(app.includes('Authorization'));
assert.ok(app.includes('authorizationContent'));

assert.equal(/command\s*line|shell\s*command|terminal/i.test(app), false, 'Customer UI must not expose command execution');
const signup = fs.readFileSync(path.join(root, 'public/divedeep/signup.html'), 'utf8');
assert.ok(signup.includes('noticeAcknowledged'));
assert.ok(signup.includes('formal authorization'));
assert.equal(signup.includes('authorizationAffirmed'), false);
const customerScript = fs.readFileSync(path.join(root, 'public/js/divedeep-app.js'), 'utf8');
assert.ok(customerScript.includes('/divedeep/api/authorization'));
assert.ok(customerScript.includes('/divedeep/api/authorization/revoke'));
assert.ok(customerScript.includes('electronicRecordsConsent'));
assert.ok(customerScript.includes('signatureIntent'));
const legal = fs.readFileSync(path.join(root, 'public/divedeep/legal.html'), 'utf8');
assert.ok(legal.includes('Formal authorization is separate from signup'));
assert.ok(legal.includes('Responsible Data Use'));
const notice = fs.readFileSync(path.join(root, 'public/divedeep/notice-at-collection.html'), 'utf8');
assert.ok(notice.includes('server-observed network address'));

const landing = fs.readFileSync(path.join(root, 'public/divedeep/index.html'), 'utf8');
assert.ok(landing.includes('OSINT Dive Deep v1'));
assert.ok(landing.includes('fid-brand-logo'));
assert.ok(landing.includes('People &amp; Identity'));
assert.ok(landing.includes('Property Research'));
assert.equal(/\$\d+\.\d{2}/.test(landing), false);
const admin = fs.readFileSync(path.join(root, 'public/admin/divedeep.html'), 'utf8');
assert.ok(admin.includes('Service operations overview'));
assert.ok(admin.includes('Source Catalog'));
assert.ok(admin.includes('Published versions are immutable'));
assert.ok(admin.includes('Manual Export'));
assert.equal(admin.includes('DiveDeep Nodes'), false);
assert.ok(admin.includes('Image Recon Bundle'));
assert.ok(admin.includes('Import Evidence Bundle'));
assert.ok(admin.includes('DiveDeep Evidence Bundle'));
assert.ok(admin.includes('Secure Integrations'));
const customerCss = fs.readFileSync(path.join(root, 'public/css/divedeep.css'), 'utf8');
const adminCss = fs.readFileSync(path.join(root, 'public/css/divedeep-admin.css'), 'utf8');
const adminScript = fs.readFileSync(path.join(root, 'public/js/divedeep-admin.js'), 'utf8');
const versionedAdminScript = fs.readFileSync(path.join(root, 'public/js/divedeep-admin-v1.13.0.js'), 'utf8');
assert.ok(adminScript.includes('X-Admin-CSRF'));
assert.ok(adminScript.includes('/divedeep/connect/facebook/callback'));
assert.ok(adminScript.includes('metaRedirectInput.readOnly = true'));
assert.ok(adminScript.includes('postImportEnabled'));
assert.ok(adminScript.includes('DIVEDEEP_RESULT_PACKET_MAX_BYTES = 5 * 1024 * 1024'));
assert.ok(adminScript.includes('Result packet exceeds the 5 MB metadata limit'));
assert.ok(adminScript.includes('divedeep.image-recon-intake'));
assert.ok(adminScript.includes('DiveDeepZip.createStoredZipBlob'));
assert.ok(adminScript.includes('IMAGE_RECON_MAX_IMAGES = 20'));
assert.ok(adminScript.includes('IMAGE_RECON_MAX_EXPANDED_BYTES = 75 * 1024 * 1024'));
assert.ok(adminScript.includes('divedeep.recon-result-manifest'));
assert.ok(adminScript.includes('Upload & Run in Background') || admin.includes('Upload &amp; Run in Background'));
assert.ok(adminScript.includes('data-publication'));
assert.ok(adminScript.includes("signed ${esc(date(authorization.signedAt))}"), 'Authorization banner must use the defined admin date helper');
assert.match(adminScript, /function\s+formatDate\s*\(/, 'DiveDeep admin must define the compatibility date formatter');
assert.match(versionedAdminScript, /function\s+formatDate\s*\(/, 'Versioned DiveDeep admin bundle must define the date formatter');
assert.match(admin, /divedeep-admin-v1\.13\.0\.js/, 'DiveDeep admin must load the physical v1.12.0 bundle filename');
assert.equal(adminScript.includes('240 * 1024'), false, 'DiveDeep result imports must not retain the old 240 KB browser limit');
assert.equal(/localStorage|sessionStorage/.test(adminScript), false, 'Admin integration credentials must not use browser storage');
assert.ok(adminScript.includes('/import-batches/upload'), 'Admin must upload a durable server-side import bundle');
assert.ok(adminScript.includes('/status'), 'Admin progress polling must use the lightweight status endpoint');
assert.ok(adminScript.includes('safe to close or refresh'), 'Admin must explain durable background progress');
assert.ok(adminScript.includes('/findings/publication'), 'Admin must use the bulk publication endpoint');
assert.ok(adminScript.includes('/api/divedeep/catalog'), 'Admin must load the shared resource catalog');
assert.ok(adminScript.includes('/catalog/pool-versions/'), 'Admin must manage versioned pool membership');
assert.ok(adminScript.includes('/catalog/source-set-versions/'), 'Admin must manage versioned source sets');
assert.ok(adminScript.includes('/source-manifest'), 'Admin must resolve package coverage manifests');
assert.equal(adminScript.includes('/divedeep/nodes'), false, 'Persistent DiveDeep node administration is superseded');
assert.equal(adminScript.includes('/recon-runs'), false, 'Persistent recon-run polling is superseded');
assert.ok(customerScript.includes('FINDING_PAGE_SIZE = 20'), 'Customer findings must be paged instead of rendering the full import at once');
assert.ok(adminScript.includes('findingImportMessage'), 'Admin must render grouped finding-level import diagnostics');

console.log('DiveDeep UI checks passed');
