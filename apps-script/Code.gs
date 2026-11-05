/**
 * 글틔움 저장 서버 (Google Apps Script 웹 앱)
 *
 * 선생님 계정(jal0340@gmail.com)으로 배포하면, 학생이 글틔움에서 [저장]을 누를 때
 * 선생님 구글 드라이브의 '글틔움' 폴더에 '학번 이름' 제목의 구글 문서로 저장됩니다.
 * 같은 학번·이름으로 다시 저장하면 같은 문서에 덮어씁니다.
 *
 * 설치 방법은 apps-script/설치안내.md 를 보세요.
 */

const FOLDER_NAME = '글틔움';
const MAX_LEN = 50000; // 글 한 편의 최대 글자 수

/** 저장된 글 불러오기: GET ?action=load&id=학번&name=이름 */
function doGet(e) {
  try {
    const p = (e && e.parameter) || {};
    if (p.action !== 'load') return json_({ ok: true, service: '글틔움' });
    const title = title_(p.id, p.name);
    const file = findDoc_(getFolder_(), title);
    if (!file) return json_({ ok: true, exists: false, title: title });
    return json_({
      ok: true,
      exists: true,
      title: title,
      text: readDoc_(file.getId()),
      updated: file.getLastUpdated().toISOString(),
    });
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

/** 글 저장(덮어쓰기): POST body = {"id":"학번","name":"이름","text":"글"} */
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const title = title_(body.id, body.name);
    const text = String(body.text == null ? '' : body.text).replace(/\r\n?/g, '\n');
    if (text.length > MAX_LEN) throw new Error('글이 너무 길어요. (' + MAX_LEN + '자 이하)');

    lock.waitLock(20000);
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
    return json_({ ok: true, title: title, created: created, updated: new Date().toISOString() });
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

/* ---------- 도우미 ---------- */

function title_(id, name) {
  id = String(id || '').trim();
  name = String(name || '').trim().replace(/\s+/g, ' ');
  if (!/^\d{4,6}$/.test(id)) throw new Error('학번은 숫자 4~6자리로 써 주세요.');
  if (!/^[가-힣A-Za-z ]{2,20}$/.test(name)) throw new Error('이름을 바르게 써 주세요.');
  return id + ' ' + name;
}

function getFolder_() {
  const it = DriveApp.getRootFolder().getFoldersByName(FOLDER_NAME);
  return it.hasNext() ? it.next() : DriveApp.getRootFolder().createFolder(FOLDER_NAME);
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

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** 처음 한 번 편집기에서 실행해 권한을 승인하고 '글틔움' 폴더를 만드는 용도 */
function setup() {
  const folder = getFolder_();
  Logger.log('폴더 준비 완료: ' + folder.getUrl());
}
