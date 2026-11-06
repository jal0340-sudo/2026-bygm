/**
 * 글틔움 저장 서버 (선생님용 Google Apps Script 웹 앱)
 *
 * 수업을 개설하는 선생님이 '자기 구글 계정'에서 이 코드를 웹 앱으로 배포합니다.
 * 학생이 글틔움에서 [저장]을 누르면 이 선생님의 구글 드라이브 › '글틔움' 폴더에
 * '수업명(학번 이름)' 제목의 구글 문서로 저장됩니다. 다시 저장하면 같은 문서에 덮어씁니다.
 *
 * 배포 방법 (글틔움 › 선생님 설정 화면에도 안내되어 있어요)
 *  1. https://script.new 에서 새 프로젝트를 만들고 이 코드를 모두 붙여 넣은 뒤 저장
 *  2. [배포] → [새 배포] → 유형: 웹 앱
 *     - 다음 사용자 인증 정보로 실행: 나
 *     - 액세스 권한이 있는 사용자: 모든 사용자
 *  3. [배포] → 액세스 승인(고급 → 이동 → 허용) → 나온 웹 앱 URL(…/exec)을 글틔움 수업 개설 화면에 붙여 넣기
 *
 * 저장 서버 하나로 수업을 여러 개 개설할 수 있습니다.
 * 학생 비밀번호는 원문이 아니라 해시(SHA-256 + 솔트)로만 '스크립트 속성'에 보관합니다.
 */

const VERSION = 3;
const FOLDER_NAME = '글틔움';
const LIST_DOC = '글틔움 수업 코드 목록';
const MAX_LEN = 50000;     // 글 한 편의 최대 글자 수
const MAX_FAIL = 5;        // 비밀번호를 이만큼 틀리면
const LOCK_SEC = 300;      // 이 시간(초) 동안 로그인을 막음
const EXPIRE_DAYS = 365;   // 이 기간 동안 새로 저장된 글이 없으면 수업 연결 해제

/** 요청은 모두 POST: {"action":"ping"|"bind"|"login"|"register"|"save", ...} */
function doPost(e) {
  try {
    const b = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (b.action === 'ping') return json_(ping_(b.name));
    if (b.action === 'bind') return json_(bind_(b.code, b.name, b.mgmt));
    if (b.action === 'rename') return json_(rename_(b.code, b.name, b.mgmt));
    const cls = getClass_(b.code);
    const who = who_(b.id, b.name);
    const pw = String(b.pw || '');
    if (b.action === 'login') return json_(login_(cls, who, pw));
    if (b.action === 'register') return json_(register_(cls, who, pw));
    if (b.action === 'save') return json_(save_(cls, who, pw, b.text));
    throw new Error('알 수 없는 요청이에요.');
  } catch (err) {
    return json_({ ok: false, code: err.code || 'ERROR', error: String(err.message || err) });
  }
}

function doGet() {
  return json_({ ok: true, service: '글틔움 저장 서버', version: VERSION });
}

/* ---------- 수업 연결 ---------- */

/** 수업 개설 전 확인: 서버가 제대로 배포·승인되었는지, 같은 이름의 수업이 이미 있는지 */
function ping_(name) {
  const folder = getFolder_();   // 드라이브 권한 확인 겸 폴더 준비
  name = cleanName_(name, true);
  const taken = !!name && listClasses_().some(c => c.name === name);
  return { ok: true, service: '글틔움 저장 서버', version: VERSION, folder: folder.getName(), nameTaken: taken };
}

/** 글틔움 수업 목록에 개설된 수업 코드를 이 서버에 연결 */
function bind_(code, name, mgmt) {
  code = cleanCode_(code);
  name = cleanName_(name);
  mgmt = cleanMgmt_(mgmt);
  return withLock_(() => {
    if (!props_().getProperty('mgr:' + code)) props_().setProperty('mgr:' + code, newHash_(mgmt));
    const cur = readClass_(code);
    if (cur) {
      if (cur.name !== name) fail_('CODEUSED', '이 수업 코드는 이미 다른 수업에 연결되어 있어요.');
      return { ok: true, code: code, name: name };
    }
    if (listClasses_().some(c => c.name === name)) fail_('NAMETAKEN', '이 저장 서버에 같은 이름의 수업이 이미 있어요. 수업명을 바꿔 주세요.');
    const now = new Date().toISOString();
    props_().setProperty('class:' + code, JSON.stringify({ name: name, created: now, last: now }));
    writeListDoc_();
    return { ok: true, code: code, name: name };
  });
}

/** 수업명 수정: 관리 비밀번호를 확인하고, 이미 저장된 학생 글 문서 제목도 '새 수업명(학번 이름)'으로 바꾼다 */
function rename_(code, name, mgmt) {
  const cls = getClass_(code);
  name = cleanName_(name);
  mgmt = cleanMgmt_(mgmt);
  return withLock_(() => {
    const stored = props_().getProperty('mgr:' + cls.code);
    if (stored) checkSecret_('mfail:' + cls.code, stored, mgmt, 'WRONG', '관리 비밀번호가 맞지 않아요. 수업을 개설할 때 정한 비밀번호를 써 주세요.');
    else props_().setProperty('mgr:' + cls.code, newHash_(mgmt));   // 관리 비밀번호 기능 전에 개설된 수업
    const old = cls.name;
    if (old === name) return { ok: true, name: name, renamed: 0 };
    if (listClasses_().some(c => c.name === name && c.code !== cls.code)) fail_('NAMETAKEN', '이 저장 서버에 같은 이름의 수업이 이미 있어요. 다른 수업명을 써 주세요.');
    let renamed = 0;
    const p = props_();
    const files = getFolder_().getFiles();
    while (files.hasNext()) {
      const f = files.next();
      const t = f.getName();
      if (f.isTrashed() || f.getMimeType() !== MimeType.GOOGLE_DOCS) continue;
      if (t.indexOf(old + '(') !== 0 || t.slice(-1) !== ')') continue;
      const nt = name + t.slice(old.length);
      f.setName(nt);
      const at = p.getProperty('at:' + t);
      if (at) { p.setProperty('at:' + nt, at); p.deleteProperty('at:' + t); }
      renamed++;
    }
    const c = readClass_(cls.code);
    c.name = name;
    p.setProperty('class:' + cls.code, JSON.stringify(c));
    writeListDoc_();
    return { ok: true, name: name, renamed: renamed };
  });
}

function getClass_(code) {
  code = cleanCode_(code);
  const c = readClass_(code);
  if (!c) fail_('NOCLASS', '이 저장 서버에 연결된 수업이 아니에요. 수업 코드를 확인해 주세요.');
  if (Date.now() - Date.parse(c.last) > EXPIRE_DAYS * 864e5) {
    withLock_(() => { props_().deleteProperty('class:' + code); writeListDoc_(); });
    fail_('NOCLASS', '1년 동안 저장된 글이 없어 연결이 해제된 수업이에요.');
  }
  c.code = code;
  return c;
}

function readClass_(code) {
  const v = props_().getProperty('class:' + code);
  return v ? JSON.parse(v) : null;
}

function listClasses_() {
  const all = props_().getProperties();
  return Object.keys(all).filter(k => k.indexOf('class:') === 0)
    .map(k => Object.assign({ code: k.slice(6) }, JSON.parse(all[k])))
    .sort((a, b) => a.created < b.created ? -1 : 1);
}

/** 선생님이 수업 코드를 잊지 않도록 '글틔움' 폴더에 수업 코드 목록 문서를 만들어 둔다 */
function writeListDoc_() {
  const folder = getFolder_();
  let file = findDoc_(folder, LIST_DOC);
  if (!file) {
    const doc = DocumentApp.create(LIST_DOC);
    doc.saveAndClose();
    file = DriveApp.getFileById(doc.getId());
    file.moveTo(folder);
  }
  const day = s => Utilities.formatDate(new Date(s), 'Asia/Seoul', 'yyyy-MM-dd');
  const lines = ['글틔움 수업 코드 목록', '', '학생은 글틔움 첫 화면에서 수업 코드·학번·이름·비밀번호로 로그인합니다.',
    '1년 동안 새로 저장되는 글이 없으면 수업과 수업 코드가 자동으로 삭제되고 연결이 해제됩니다. (저장된 글 문서는 그대로 남아요)', ''];
  const list = listClasses_();
  if (!list.length) lines.push('(연결된 수업이 없어요)');
  list.forEach(c => lines.push('· ' + c.name + '  —  수업 코드: ' + c.code + '  (개설 ' + day(c.created) + ')'));
  writeDoc_(file.getId(), lines.join('\n'));
}

/* ---------- 학생: 로그인·저장 ---------- */

function login_(cls, who, pw) {
  if (!getPw_(cls, who)) return { ok: false, code: 'NEW', error: '처음 로그인하는 학번·이름이에요.' };
  checkPw_(cls, who, pw);
  return loaded_(cls, who);
}

function register_(cls, who, pw) {
  if (!/^.{4,20}$/.test(pw)) fail_('BADPW', '비밀번호는 4~20자로 정해 주세요.');
  return withLock_(() => {
    if (getPw_(cls, who)) {        // 그 사이 이미 정해졌다면 일반 로그인처럼 확인
      checkPw_(cls, who, pw);
      return loaded_(cls, who);
    }
    const salt = Utilities.getUuid();
    props_().setProperty(pwKey_(cls, who), salt + ':' + hash_(salt, pw));
    return loaded_(cls, who);
  });
}

function save_(cls, who, pw, text) {
  checkPw_(cls, who, pw);
  text = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  if (text.length > MAX_LEN) fail_('TOOLONG', '글이 너무 길어요. (' + MAX_LEN + '자 이하)');
  const title = docTitle_(cls, who);
  return withLock_(() => {
    const folder = getFolder_();
    let file = findDoc_(folder, title);
    let created = false;
    if (!file) {
      const doc = DocumentApp.create(title);
      doc.saveAndClose();
      file = DriveApp.getFileById(doc.getId());
      file.moveTo(folder);
      created = true;
    }
    writeDoc_(file.getId(), text);
    const now = new Date().toISOString();
    props_().setProperty('at:' + title, now);   // 드라이브의 '수정한 날짜'는 늦게 바뀌어서 따로 기록
    const c = readClass_(cls.code);
    if (c) {
      c.last = now;
      props_().setProperty('class:' + cls.code, JSON.stringify(c));
    }
    return { ok: true, title: title, created: created, updated: now };
  });
}

function loaded_(cls, who) {
  const title = docTitle_(cls, who);
  const file = findDoc_(getFolder_(), title);
  if (!file) return { ok: true, title: title, exists: false };
  const updated = props_().getProperty('at:' + title) || file.getLastUpdated().toISOString();
  return { ok: true, title: title, exists: true, text: readDoc_(file.getId()), updated: updated };
}

/* ---------- 비밀번호 ---------- */

function props_() { return PropertiesService.getScriptProperties(); }
function pwKey_(cls, who) { return 'pw:' + cls.code + ':' + who; }
function getPw_(cls, who) { return props_().getProperty(pwKey_(cls, who)); }

function hash_(salt, pw) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + '|' + pw, Utilities.Charset.UTF_8);
  return Utilities.base64Encode(bytes);
}

function checkPw_(cls, who, pw) {
  const stored = getPw_(cls, who);
  if (!stored) fail_('NEW', '처음 로그인하는 학번·이름이에요.');
  checkSecret_('fail:' + cls.code + ':' + who, stored, pw, 'WRONG', '비밀번호가 맞지 않아요.');
}

function newHash_(pw) { const salt = Utilities.getUuid(); return salt + ':' + hash_(salt, pw); }

/** 저장된 해시(salt:hash)와 비교. 여러 번 틀리면 잠시 막는다 */
function checkSecret_(failKey, stored, pw, code, wrongMsg) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get(failKey) || 0);
  const lockMsg = '비밀번호를 여러 번 틀렸어요. ' + Math.round(LOCK_SEC / 60) + '분 뒤에 다시 해 보세요.';
  if (fails >= MAX_FAIL) fail_('LOCKED', lockMsg);
  const i = stored.indexOf(':');
  if (hash_(stored.slice(0, i), pw) !== stored.slice(i + 1)) {
    cache.put(failKey, String(fails + 1), LOCK_SEC);
    const left = MAX_FAIL - fails - 1;
    fail_(code, left > 0 ? wrongMsg + ' (' + left + '번 더 틀리면 잠시 막혀요)' : lockMsg);
  }
  cache.remove(failKey);
}

function cleanMgmt_(pw) {
  pw = String(pw || '');
  if (!/^.{4,20}$/.test(pw)) fail_('BADPW', '관리 비밀번호는 4~20자로 써 주세요.');
  return pw;
}

function fail_(code, msg) {
  const err = new Error(msg);
  err.code = code;
  throw err;
}

/* ---------- 입력 확인 ---------- */

function cleanCode_(code) {
  code = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) fail_('BADCODE', '수업 코드는 6자리로 써 주세요.');
  return code;
}

function cleanName_(name, optional) {
  name = String(name || '').trim().replace(/\s+/g, ' ');
  if (optional && !name) return '';
  if (name.length < 1 || name.length > 30 || /[\\\/:*?"<>|()]/.test(name)) fail_('BADNAME', '수업명은 30자 이하로, 괄호·특수 기호 없이 써 주세요.');
  return name;
}

function who_(id, name) {
  id = String(id || '').trim();
  name = String(name || '').trim().replace(/\s+/g, ' ');
  if (!/^\d{4,6}$/.test(id)) fail_('BADID', '학번은 숫자 4~6자리로 써 주세요.');
  if (!/^[가-힣A-Za-z ]{2,20}$/.test(name)) fail_('BADNAME', '이름을 바르게 써 주세요.');
  return id + ' ' + name;
}

/** 저장 문서 제목: 수업명(학번 이름) */
function docTitle_(cls, who) { return cls.name + '(' + who + ')'; }

/* ---------- 드라이브 ---------- */

function getFolder_() {
  const root = DriveApp.getRootFolder();
  const it = root.getFoldersByName(FOLDER_NAME);
  return it.hasNext() ? it.next() : root.createFolder(FOLDER_NAME);
}

function findDoc_(folder, title) {
  const it = folder.getFilesByName(title);
  while (it.hasNext()) {
    const f = it.next();
    if (!f.isTrashed() && f.getMimeType() === MimeType.GOOGLE_DOCS) return f;
  }
  return null;
}

function readDoc_(docId) {
  return DocumentApp.openById(docId).getBody().getParagraphs().map(p => p.getText()).join('\n');
}

function writeDoc_(docId, text) {
  const doc = DocumentApp.openById(docId);
  const body = doc.getBody();
  const lines = text.split('\n');
  body.clear();
  body.getParagraphs()[0].setText(lines[0]);
  for (let i = 1; i < lines.length; i++) body.appendParagraph(lines[i]);
  doc.saveAndClose();
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------- 선생님용 (편집기에서 직접 실행) ---------- */

/** 연결된 수업과 비밀번호를 정한 학생 수를 로그에 보여 줍니다. */
function listClasses() {
  const all = Object.keys(props_().getProperties());
  const list = listClasses_();
  Logger.log(list.length ? list.map(c => c.name + ' — ' + c.code + ' (학생 ' + all.filter(k => k.indexOf('pw:' + c.code + ':') === 0).length + '명)').join('\n') : '연결된 수업이 없어요.');
}

/** 학생이 비밀번호를 잊었을 때: 아래 따옴표 안에 '수업 코드'와 '학번 이름'을 쓰고 실행하세요.
 *  비밀번호만 지워지고 글은 그대로 남습니다. 학생은 다음 로그인 때 새 비밀번호를 정합니다. */
function resetPassword() {
  const CODE = 'ABC234';
  const WHO = '10101 홍길동';
  const key = 'pw:' + CODE + ':' + WHO;
  if (!props_().getProperty(key)) { Logger.log('등록된 비밀번호가 없어요: ' + CODE + ' / ' + WHO); return; }
  props_().deleteProperty(key);
  CacheService.getScriptCache().remove('fail:' + CODE + ':' + WHO);
  Logger.log('비밀번호를 초기화했어요: ' + CODE + ' / ' + WHO);
}
