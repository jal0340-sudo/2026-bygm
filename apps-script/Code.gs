/**
 * 글틔움 수업 목록 서버 (Google Apps Script 웹 앱)
 *
 * 선생님들이 개설한 수업(수업명 · 수업 코드 · 저장 서버 주소)만 보관합니다.
 * 학생 글과 비밀번호는 여기에 저장되지 않고, 수업을 개설한 선생님의 저장 서버
 * (save-server/Code.gs, 선생님 본인 계정에 배포)로 바로 갑니다.
 *
 * - 수업 코드는 다른 수업과 겹치지 않게 자동으로 만듭니다.
 * - 개설된 수업은 누구도 지울 수 없고, 목록으로 확인만 할 수 있습니다.
 * - 1년 동안 새로 저장된 글이 없으면 수업과 수업 코드를 자동으로 지우고 저장 서버 연결을 끊습니다.
 *
 * 다시 배포하는 방법은 apps-script/설치안내.md 를 보세요.
 */

const EXPIRE_DAYS = 365;
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // 헷갈리는 0·O·1·I·L은 뺌
const CODE_LEN = 6;
const MAX_CREATE_PER_HOUR = 30;                          // 장난 개설 막기
const TEACHER_KEY = 'writingT';                         // 선생님 설정 화면 접속 코드
const MAX_FAIL = 5;                                      // 관리 비밀번호를 이만큼 틀리면
const LOCK_SEC = 300;                                    // 이 시간(초) 동안 막음
const URL_RE =/^https:\/\/script\.google\.com\/(a\/[^\/]+\/)?macros\/s\/[\w-]{20,}\/exec$/;

/** 요청은 모두 POST: {"action":"lookup"|"create"|"touch"|"list", ...} */
function doPost(e) {
  try {
    const b = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (b.action === 'lookup') return json_(lookup_(b.code));
    if (b.action === 'touch') return json_(touch_(b.code));
    // 아래는 선생님 설정 화면에서만 쓰는 요청 (접속 코드 필요)
    if (b.key !== TEACHER_KEY) fail_('NOKEY', '선생님 설정 접속 코드가 맞지 않아요.');
    if (b.action === 'check') return json_({ ok: true });
    if (b.action === 'create') return json_(create_(b.name, b.url, b.mgmt));
    if (b.action === 'rename') return json_(rename_(b.code, b.name, b.mgmt));
    if (b.action === 'list') return json_(list_());
    throw new Error('알 수 없는 요청이에요.');
  } catch (err) {
    return json_({ ok: false, code: err.code || 'ERROR', error: String(err.message || err) });
  }
}

function doGet() {
  return json_({ ok: true, service: '글틔움 수업 목록' });
}

/* ---------- 동작 ---------- */

/** 학생이 수업 코드를 쓰면 수업명과 저장 서버 주소를 알려 준다 */
function lookup_(code) {
  code = cleanCode_(code);
  const c = read_(code);
  if (!c) fail_('NOCLASS', '없는 수업 코드예요.');
  if (expired_(c)) {
    withLock_(() => props_().deleteProperty(key_(code)));
    fail_('NOCLASS', '1년 동안 저장된 글이 없어 삭제된 수업 코드예요.');
  }
  return { ok: true, code: code, name: c.name, url: c.url };
}

/** 수업 개설: 겹치지 않는 수업 코드를 만들어 수업명·저장 서버 주소와 함께 보관 */
function create_(name, url, mgmt) {
  name = cleanName_(name);
  url = String(url || '').trim();
  mgmt = cleanMgmt_(mgmt);
  if (!URL_RE.test(url)) fail_('BADURL', '저장 서버 주소가 올바르지 않아요. https://script.google.com/macros/s/…/exec 모양이어야 해요.');
  const cache = CacheService.getScriptCache();
  const made = Number(cache.get('made') || 0);
  if (made >= MAX_CREATE_PER_HOUR) fail_('BUSY', '지금은 수업 개설 요청이 많아요. 잠시 뒤에 다시 해 주세요.');
  return withLock_(() => {
    purge_();
    let code;
    do {
      code = '';
      for (let i = 0; i < CODE_LEN; i++) code += CODE_CHARS.charAt(Math.floor(Math.random() * CODE_CHARS.length));
    } while (props_().getProperty(key_(code)));
    const now = new Date().toISOString();
    props_().setProperty(key_(code), JSON.stringify({ name: name, url: url, created: now, last: now, mgr: newHash_(mgmt) }));
    cache.put('made', String(made + 1), 3600);
    return { ok: true, code: code, name: name, created: now, expires: addDays_(now) };
  });
}

/** 수업명 수정: 수업을 개설할 때 정한 관리 비밀번호가 맞아야 한다.
 *  (관리 비밀번호 기능이 생기기 전에 개설된 수업은 처음 수정할 때 쓴 비밀번호로 정해짐) */
function rename_(code, name, mgmt) {
  code = cleanCode_(code);
  name = cleanName_(name);
  mgmt = cleanMgmt_(mgmt);
  return withLock_(() => {
    const c = read_(code);
    if (!c || expired_(c)) fail_('NOCLASS', '없는 수업 코드예요.');
    if (c.mgr) checkMgmt_(code, c.mgr, mgmt); else c.mgr = newHash_(mgmt);
    const old = c.name;
    c.name = name;
    props_().setProperty(key_(code), JSON.stringify(c));
    return { ok: true, code: code, name: name, oldName: old, url: c.url };
  });
}

/** 학생 글이 저장될 때마다 마지막 저장 시각을 새로 고친다 (1년 기한이 다시 시작) */
function touch_(code) {
  code = cleanCode_(code);
  const c = read_(code);
  if (!c || expired_(c)) return { ok: true };
  if (c.last === c.created || Date.now() - Date.parse(c.last) > 3600 * 1000) {   // 첫 저장 뒤에는 한 시간에 한 번만 기록
    c.last = new Date().toISOString();
    props_().setProperty(key_(code), JSON.stringify(c));
  }
  return { ok: true };
}

/** 개설된 수업 목록 (확인용). 학생 보호를 위해 수업 코드는 일부만, 저장 서버 주소는 보여 주지 않는다 */
function list_() {
  withLock_(purge_);
  const all = props_().getProperties();
  const list = Object.keys(all).filter(k => k.indexOf('c:') === 0).map(k => {
    const c = JSON.parse(all[k]);
    const code = k.slice(2);
    return { name: c.name, code: code.slice(0, 2) + '••••', created: c.created, last: c.last, expires: addDays_(c.last) };
  }).sort((a, b) => a.created < b.created ? 1 : -1);
  return { ok: true, classes: list };
}

/* ---------- 도우미 ---------- */

function props_() { return PropertiesService.getScriptProperties(); }
function key_(code) { return 'c:' + code; }
function read_(code) { const v = props_().getProperty(key_(code)); return v ? JSON.parse(v) : null; }
function expired_(c) { return Date.now() - Date.parse(c.last) > EXPIRE_DAYS * 864e5; }
function addDays_(iso) { return new Date(Date.parse(iso) + EXPIRE_DAYS * 864e5).toISOString(); }

/** 기한이 지난 수업을 지운다 (수업 코드와 저장 서버 연결이 함께 사라짐) */
function purge_() {
  const all = props_().getProperties();
  Object.keys(all).forEach(k => {
    if (k.indexOf('c:') !== 0) return;
    try { if (expired_(JSON.parse(all[k]))) props_().deleteProperty(k); } catch (e) { props_().deleteProperty(k); }
  });
}

function cleanName_(name) {
  name = String(name || '').trim().replace(/\s+/g, ' ');
  if (name.length < 1 || name.length > 30 || /[\\\/:*?"<>|()]/.test(name)) fail_('BADNAME', '수업명은 30자 이하로, 괄호·특수 기호 없이 써 주세요.');
  return name;
}

function cleanMgmt_(pw) {
  pw = String(pw || '');
  if (!/^.{4,20}$/.test(pw)) fail_('BADPW', '관리 비밀번호는 4~20자로 써 주세요.');
  return pw;
}

function hash_(salt, pw) {
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + '|' + pw, Utilities.Charset.UTF_8));
}
function newHash_(pw) { const salt = Utilities.getUuid(); return salt + ':' + hash_(salt, pw); }

function checkMgmt_(code, stored, pw) {
  const cache = CacheService.getScriptCache();
  const failKey = 'mfail:' + code;
  const fails = Number(cache.get(failKey) || 0);
  if (fails >= MAX_FAIL) fail_('LOCKED', '관리 비밀번호를 여러 번 틀렸어요. ' + Math.round(LOCK_SEC / 60) + '분 뒤에 다시 해 주세요.');
  const i = stored.indexOf(':');
  if (hash_(stored.slice(0, i), pw) !== stored.slice(i + 1)) {
    cache.put(failKey, String(fails + 1), LOCK_SEC);
    fail_('WRONG', '관리 비밀번호가 맞지 않아요. 수업을 개설할 때 정한 비밀번호를 써 주세요.');
  }
  cache.remove(failKey);
}

function cleanCode_(code) {
  code = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) fail_('BADCODE', '수업 코드는 6자리로 써 주세요.');
  return code;
}

function fail_(code, msg) {
  const err = new Error(msg);
  err.code = code;
  throw err;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------- 관리용 (편집기에서 직접 실행) ---------- */

/** 개설된 수업 전체(코드·저장 서버 주소 포함)를 실행 로그에 보여 줍니다. */
function showClasses() {
  const all = props_().getProperties();
  const keys = Object.keys(all).filter(k => k.indexOf('c:') === 0);
  Logger.log(keys.length + '개\n' + keys.map(k => k.slice(2) + '  ' + all[k]).join('\n'));
}

/** 예전 방식(이 계정에 직접 저장)에서 남은 학생 비밀번호·저장 시각 기록을 지웁니다. 글 문서는 지우지 않아요. */
function cleanupOldStudentData() {
  const all = props_().getProperties();
  const old = Object.keys(all).filter(k => k.indexOf('pw:') === 0 || k.indexOf('at:') === 0);
  old.forEach(k => props_().deleteProperty(k));
  Logger.log('지운 예전 기록: ' + old.length + '개');
}
