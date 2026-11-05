/**
 * 글틔움 저장 서버 (Google Apps Script 웹 앱)
 *
 * 선생님 계정(jal0340@gmail.com)으로 배포하면, 학생이 글틔움에서 [저장]을 누를 때
 * 선생님 구글 드라이브의 '글틔움' 폴더에 '학번 이름' 제목의 구글 문서로 저장됩니다.
 * 같은 학번·이름으로 다시 저장하면 같은 문서에 덮어씁니다.
 *
 * 학생은 처음 로그인할 때 비밀번호를 정하고, 다음부터는 그 비밀번호로 로그인합니다.
 * 비밀번호는 원문이 아니라 해시(SHA-256 + 솔트)로 '스크립트 속성'에 보관합니다.
 *
 * 설치 방법은 apps-script/설치안내.md 를 보세요.
 */

const FOLDER_NAME = '글틔움';
const MAX_LEN = 50000;   // 글 한 편의 최대 글자 수
const MAX_FAIL = 5;      // 비밀번호를 이만큼 틀리면
const LOCK_SEC = 300;    // 이 시간(초) 동안 로그인을 막음

/** 요청은 모두 POST: {"action":"login"|"register"|"save","id","name","pw","text"} */
function doPost(e) {
  try {
    const b = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const title = title_(b.id, b.name);
    const pw = String(b.pw || '');
    if (b.action === 'login') return json_(login_(title, pw));
    if (b.action === 'register') return json_(register_(title, pw));
    if (b.action === 'save') return json_(save_(title, pw, b.text));
    throw new Error('알 수 없는 요청이에요.');
  } catch (err) {
    return json_({ ok: false, code: err.code || 'ERROR', error: String(err.message || err) });
  }
}

function doGet() {
  return json_({ ok: true, service: '글틔움' });
}

/* ---------- 동작 ---------- */

function login_(title, pw) {
  if (!getPw_(title)) return { ok: false, code: 'NEW', error: '처음 로그인하는 학번·이름이에요.' };
  checkPw_(title, pw);
  return loaded_(title);
}

function register_(title, pw) {
  if (!/^.{4,20}$/.test(pw)) fail_('BADPW', '비밀번호는 4~20자로 정해 주세요.');
  return withLock_(() => {
    if (getPw_(title)) {        // 그 사이 이미 정해졌다면 일반 로그인처럼 확인
      checkPw_(title, pw);
      return loaded_(title);
    }
    const salt = Utilities.getUuid();
    props_().setProperty(key_(title), salt + ':' + hash_(salt, pw));
    return loaded_(title);
  });
}

function save_(title, pw, text) {
  checkPw_(title, pw);
  text = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  if (text.length > MAX_LEN) fail_('TOOLONG', '글이 너무 길어요. (' + MAX_LEN + '자 이하)');
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
    return { ok: true, title: title, created: created, updated: new Date().toISOString() };
  });
}

function loaded_(title) {
  const file = findDoc_(getFolder_(), title);
  if (!file) return { ok: true, title: title, exists: false };
  return { ok: true, title: title, exists: true, text: readDoc_(file.getId()), updated: file.getLastUpdated().toISOString() };
}

/* ---------- 비밀번호 ---------- */

function props_() { return PropertiesService.getScriptProperties(); }
function key_(title) { return 'pw:' + title; }
function getPw_(title) { return props_().getProperty(key_(title)); }

function hash_(salt, pw) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + '|' + pw, Utilities.Charset.UTF_8);
  return Utilities.base64Encode(bytes);
}

function checkPw_(title, pw) {
  const stored = getPw_(title);
  if (!stored) fail_('NEW', '처음 로그인하는 학번·이름이에요.');
  const cache = CacheService.getScriptCache();
  const failKey = 'fail:' + title;
  const fails = Number(cache.get(failKey) || 0);
  if (fails >= MAX_FAIL) fail_('LOCKED', '비밀번호를 여러 번 틀렸어요. ' + Math.round(LOCK_SEC / 60) + '분 뒤에 다시 해 보세요.');
  const i = stored.indexOf(':');
  if (hash_(stored.slice(0, i), pw) !== stored.slice(i + 1)) {
    cache.put(failKey, String(fails + 1), LOCK_SEC);
    const left = MAX_FAIL - fails - 1;
    fail_('WRONG', left > 0 ? '비밀번호가 맞지 않아요. (' + left + '번 더 틀리면 잠시 막혀요)' : '비밀번호를 여러 번 틀렸어요. ' + Math.round(LOCK_SEC / 60) + '분 뒤에 다시 해 보세요.');
  }
  cache.remove(failKey);
}

function fail_(code, msg) {
  const err = new Error(msg);
  err.code = code;
  throw err;
}

/* ---------- 드라이브 ---------- */

function title_(id, name) {
  id = String(id || '').trim();
  name = String(name || '').trim().replace(/\s+/g, ' ');
  if (!/^\d{4,6}$/.test(id)) fail_('BADID', '학번은 숫자 4~6자리로 써 주세요.');
  if (!/^[가-힣A-Za-z ]{2,20}$/.test(name)) fail_('BADNAME', '이름을 바르게 써 주세요.');
  return id + ' ' + name;
}

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

/** 처음 한 번 실행해 권한을 승인하고 '글틔움' 폴더를 만듭니다. */
function setup() {
  Logger.log('폴더 준비 완료: ' + getFolder_().getUrl());
}

/** 학생이 비밀번호를 잊었을 때: 아래 따옴표 안에 '학번 이름'을 쓰고 실행하세요.
 *  비밀번호만 지워지고 글은 그대로 남습니다. 학생은 다음 로그인 때 새 비밀번호를 정합니다. */
function resetPassword() {
  const TITLE = '10101 홍길동';
  if (!getPw_(TITLE)) { Logger.log('등록된 비밀번호가 없어요: ' + TITLE); return; }
  props_().deleteProperty(key_(TITLE));
  CacheService.getScriptCache().remove('fail:' + TITLE);
  Logger.log('비밀번호를 초기화했어요: ' + TITLE);
}

/** 비밀번호를 등록한 학생 목록을 로그에 보여 줍니다. */
function listStudents() {
  const names = Object.keys(props_().getProperties()).filter(k => k.indexOf('pw:') === 0).map(k => k.slice(3)).sort();
  Logger.log(names.length + '명\n' + names.join('\n'));
}
