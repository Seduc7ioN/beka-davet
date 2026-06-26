const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');

const root = process.cwd();
let failed = false;

function fail(message) {
  failed = true;
  console.error(`✗ ${message}`);
}

function pass(message) {
  console.log(`✓ ${message}`);
}

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function json(file) {
  return JSON.parse(read(file));
}

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(path.join(root, dir), {withFileTypes: true})) {
    const rel = path.join(dir, entry.name);
    if (['.git', '.vercel', 'node_modules'].some(skip => rel === skip || rel.startsWith(`${skip}/`))) continue;
    if (entry.isDirectory()) walk(rel, files);
    else files.push(rel);
  }
  return files;
}

for (const file of ['package.json', 'manifest.json', 'vercel.json', 'firebase.json']) {
  try {
    json(file);
    pass(`${file} geçerli JSON`);
  } catch (error) {
    fail(`${file} JSON hatası: ${error.message}`);
  }
}

for (const file of ['api/create-offer.js', 'api/send-reminders.js']) {
  try {
    execFileSync(process.execPath, ['--check', file], {stdio: 'pipe'});
    pass(`${file} syntax OK`);
  } catch (error) {
    fail(`${file} syntax hatası`);
  }
}

const manifest = json('manifest.json');
if (!manifest.icons || !manifest.icons.length) fail('manifest icon listesi boş');
else {
  for (const icon of manifest.icons) {
    if (String(icon.src).startsWith('data:')) fail(`manifest icon data URI kalmış: ${icon.sizes}`);
    const iconPath = String(icon.src).replace(/^\//, '');
    if (!fs.existsSync(path.join(root, iconPath))) fail(`manifest icon dosyası yok: ${icon.src}`);
  }
  pass('manifest ikonları dosyada');
}

const admin = read('admin.html');
if (!admin.includes('noindex, nofollow')) fail('admin.html noindex meta eksik');
else pass('admin noindex meta var');
if (!admin.includes('id="reviewEditor"') || !admin.includes('function saveReviews()')) fail('admin Google yorum editoru eksik');
else pass('admin Google yorum editoru var');
if (!admin.includes('id="siteImageEditor"') || !admin.includes('function saveSiteImages()')) fail('admin ana görsel yönetimi eksik');
else pass('admin ana görsel yönetimi var');

const index = read('index.html');
if (!index.includes('/api/create-offer')) fail('teklif formu güvenli API kullanmıyor');
else pass('teklif formu /api/create-offer kullanıyor');
if (!index.includes('function reviewsFromSiteContent') || !index.includes('content.reviewsJson')) fail('site Google yorum listesini okumuyor');
else pass('site Google yorum listesini okuyor');
if (!index.includes('Number(r.rating)===5')) fail('site yorum vitrini 5 yıldız filtresi eksik');
else pass('site yorum vitrini 5 yıldız filtreli');
if (!index.includes('heroImageUrl') || !index.includes('aboutImageUrl') || !index.includes('setImageSrc')) fail('site ana görselleri yönetimden okumuyor');
else pass('site ana görselleri yönetimden okuyor');
if (index.includes('/api/notify-new-offer')) fail('eski public notify endpoint referansı kalmış');
else pass('eski public notify endpoint referansı yok');
if (index.includes('og:image" content="data:')) fail('og:image hâlâ data URI');
else pass('og:image dosya URL');
if (/<meta[^>]+content="data:image/i.test(index)) fail('meta görseli hâlâ data URI');
else pass('meta görselleri dosya URL');
if (/<link[^>]+href="data:image/i.test(index)) fail('favicon/apple icon hâlâ data URI');
else pass('favicon ve apple icon dosya URL');
if (/<img[^>]+src="data:image/i.test(index)) fail('HTML img içinde data URI kaldı');
else pass('HTML img görselleri dosya URL');

const sw = read('sw.js');
if (!/beka-davet-v18/.test(sw)) fail('PWA cache versiyonu v18 değil');
else pass('PWA cache v18');

const vercel = json('vercel.json');
const headerRules = JSON.stringify(vercel.headers || []);
for (const needle of ['X-Content-Type-Options', 'Referrer-Policy', 'Permissions-Policy', 'X-Robots-Tag']) {
  if (!headerRules.includes(needle)) fail(`${needle} header eksik`);
}
if (!failed) pass('temel header kuralları var');

let trackedEnv = '';
try {
  trackedEnv = execFileSync('git', ['ls-files'], {encoding: 'utf8'})
    .split('\n')
    .filter(file => /(^|\/)\.env|^\.vercel\//.test(file))
    .join('\n');
} catch (error) {
  fail('git ls-files çalışmadı');
}
if (trackedEnv) fail(`tracked env/vercel dosyası var:\n${trackedEnv}`);
else pass('tracked env/.vercel dosyası yok');

const secretPatterns = [
  /ghp_[A-Za-z0-9_]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /-----BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/,
  /FIREBASE_SERVICE_ACCOUNT_BASE64=[A-Za-z0-9+/=]{80,}/,
  /CRON_SECRET=[A-Za-z0-9_-]{20,}/
];

for (const file of walk('.')) {
  if (/\.(png|jpe?g|gif|webp|ico)$/i.test(file)) continue;
  const text = read(file);
  if (secretPatterns.some(pattern => pattern.test(text))) fail(`olası gizli bilgi bulundu: ${file}`);
}
if (!failed) pass('gizli anahtar paterni bulunmadı');

if (failed) process.exit(1);
console.log('Tüm kontroller geçti.');
