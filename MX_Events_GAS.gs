/* ================================================================
   MX Events Tracker — Google Apps Script Backend
   혼사(wedding) + 조사(funeral/executive) 통합 처리
   ================================================================ */

var SCRIPT_PROP = PropertiesService.getScriptProperties();
var GEMINI_KEY  = SCRIPT_PROP.getProperty('GEMINI_API_KEY') || '';
var SHEET_ID    = SCRIPT_PROP.getProperty('SHEET_ID') || '';

/* ── doGet entry point ────────────────────────────────────────── */
function doGet(e) {
  e = e || {};
  var p   = e.parameter || {};
  var act = p.action || '';
  var cb  = p.callback || 'cb';

  try {
    var result;
    switch (act) {

      /* ── 혼사: 빠른 동기 처리 (≤12s) ── */
      case 'extract_now': {
        var url = p.url || '';
        if (!url) throw new Error('url required');
        result = extractBasic_(url);
        break;
      }

      /* ── 혼사: 비동기 시작 ── */
      case 'extract': {
        var url = p.url || '';
        if (!url) throw new Error('url required');
        var jobId = startWeddingJob_(url);
        result = { jobId: jobId, status: 'pending' };
        break;
      }

      /* ── 조사: 빠른 동기 처리 (≤12s) ── */
      case 'extract_funeral_now': {
        var url = p.url || '';
        if (!url) throw new Error('url required');
        result = extractFuneralBasic_(url);
        break;
      }

      /* ── 조사: 비동기 시작 ── */
      case 'extract_funeral': {
        var url = p.url || '';
        if (!url) throw new Error('url required');
        var jobId = startFuneralJob_(url);
        result = { jobId: jobId, status: 'pending' };
        break;
      }

      /* ── 작업 상태 확인 (혼사/조사 공통) ── */
      case 'check': {
        var jobId = p.jobId || '';
        if (!jobId) throw new Error('jobId required');
        result = checkJob_(jobId);
        break;
      }

      /* ── 작업 재시도 (혼사/조사 공통) ── */
      case 'poke': {
        var jobId = p.jobId || '';
        if (!jobId) throw new Error('jobId required');
        result = pokeJob_(jobId);
        break;
      }

      /* ── 혼사 데이터 제출 ── */
      case 'submit_wedding': {
        result = submitWedding_(p);
        break;
      }

      /* ── 조사 데이터 제출 ── */
      case 'submit_executive': {
        result = submitExecutive_(p);
        break;
      }

      /* ── 연락처 조회 ── */
      case 'contacts_now': {
        result = lookupContacts_(p);
        break;
      }

      default:
        result = { ok: false, error: 'unknown action: ' + act };
    }

    return jsonpOk_(cb, result);
  } catch (err) {
    return jsonpOk_(cb, { ok: false, error: err.message });
  }
}

/* ================================================================
   혼사 (WEDDING) 추출
   ================================================================ */

/**
 * 빠른 경로: 직접 fetch → 휴리스틱 → 렌더러 → Gemini 순서
 */
function extractBasic_(url) {
  var fetched = directFetchMobile_(url);
  var text    = fetched.text || '';
  var og      = fetched.og   || {};

  /* 1단계: 한국어 휴리스틱 파싱 (빠름, LLM 불필요) */
  var heur = parseKoreanWeddingHeuristic_(text);
  if (isWeddingComplete_(heur)) {
    return { ok: true, source: 'heuristic', data: heur };
  }

  /* 2단계: JS 렌더러 (HTML이 너무 짧을 때만) */
  if (text.length < 200) {
    var rendered = renderPage_(url);
    if (rendered) {
      text = rendered;
      heur = mergeObjects_(heur, parseKoreanWeddingHeuristic_(text));
    }
  }

  /* 3단계: Gemini 구조화 추출 */
  var geminiData = runGeminiWeddingStructured_(text, og, 'gemini-1.5-flash', heur);
  var merged     = mergeObjects_(heur, geminiData);
  return { ok: true, source: 'gemini', data: merged };
}

function startWeddingJob_(url) {
  var jobId = 'wedding_' + Utilities.getUuid();
  var cache = CacheService.getScriptCache();
  cache.put(jobId, JSON.stringify({ status: 'pending', url: url }), 1800);
  SCRIPT_PROP.setProperty('pending_wedding_job', JSON.stringify({ jobId: jobId, url: url }));
  ScriptApp.newTrigger('runWeddingJob_').timeBased().after(1000).create();
  return jobId;
}

function runWeddingJob_() {
  deleteTrigger_('runWeddingJob_');
  var raw = SCRIPT_PROP.getProperty('pending_wedding_job');
  if (!raw) return;
  var meta = JSON.parse(raw);
  SCRIPT_PROP.deleteProperty('pending_wedding_job');

  var cache = CacheService.getScriptCache();
  try {
    var result = extractBasic_(meta.url);
    cache.put(meta.jobId, JSON.stringify({ status: 'done', result: result }), 1800);
  } catch (e) {
    cache.put(meta.jobId, JSON.stringify({ status: 'error', error: e.message }), 1800);
  }
}

/* ================================================================
   조사 (FUNERAL) 추출
   ================================================================ */

function extractFuneralBasic_(url) {
  var fetched = directFetchMobile_(url);
  var text    = fetched.text || '';
  var og      = fetched.og   || {};

  /* 1단계: 한국어 휴리스틱 파싱 */
  var heur = parseKoreanFuneralHeuristic_(text);
  if (isFuneralComplete_(heur)) {
    return { ok: true, source: 'heuristic', data: heur };
  }

  /* 2단계: JS 렌더러 (HTML이 너무 짧을 때만) */
  if (text.length < 200) {
    var rendered = renderPage_(url);
    if (rendered) {
      text = rendered;
      heur = mergeObjects_(heur, parseKoreanFuneralHeuristic_(text));
    }
  }

  /* 3단계: Gemini 구조화 추출 */
  var geminiData = runGeminiFuneralStructured_(text, og, 'gemini-1.5-flash', heur);
  var merged     = mergeObjects_(heur, geminiData);
  return { ok: true, source: 'gemini', data: merged };
}

function startFuneralJob_(url) {
  var jobId = 'funeral_' + Utilities.getUuid();
  var cache = CacheService.getScriptCache();
  cache.put(jobId, JSON.stringify({ status: 'pending', url: url }), 1800);
  SCRIPT_PROP.setProperty('pending_funeral_job', JSON.stringify({ jobId: jobId, url: url }));
  ScriptApp.newTrigger('runFuneralJob_').timeBased().after(1000).create();
  return jobId;
}

function runFuneralJob_() {
  deleteTrigger_('runFuneralJob_');
  var raw = SCRIPT_PROP.getProperty('pending_funeral_job');
  if (!raw) return;
  var meta = JSON.parse(raw);
  SCRIPT_PROP.deleteProperty('pending_funeral_job');

  var cache = CacheService.getScriptCache();
  try {
    var result = extractFuneralBasic_(meta.url);
    cache.put(meta.jobId, JSON.stringify({ status: 'done', result: result }), 1800);
  } catch (e) {
    cache.put(meta.jobId, JSON.stringify({ status: 'error', error: e.message }), 1800);
  }
}

/* ================================================================
   작업 관리 (JOB MANAGEMENT)
   ================================================================ */

function checkJob_(jobId) {
  var cache = CacheService.getScriptCache();
  var raw   = cache.get(jobId);
  if (!raw) return { status: 'missing' };
  return JSON.parse(raw);
}

function pokeJob_(jobId) {
  var cache = CacheService.getScriptCache();
  var raw   = cache.get(jobId);
  var meta  = raw ? JSON.parse(raw) : null;
  var url   = (meta && meta.url) ? meta.url : '';

  if (jobId.indexOf('funeral_') === 0) {
    if (!url) url = SCRIPT_PROP.getProperty('last_funeral_url') || '';
    if (!url) return { ok: false, error: 'no url to re-kick' };
    SCRIPT_PROP.setProperty('pending_funeral_job', JSON.stringify({ jobId: jobId, url: url }));
    ScriptApp.newTrigger('runFuneralJob_').timeBased().after(1000).create();
  } else {
    if (!url) url = SCRIPT_PROP.getProperty('last_wedding_url') || '';
    if (!url) return { ok: false, error: 'no url to re-kick' };
    SCRIPT_PROP.setProperty('pending_wedding_job', JSON.stringify({ jobId: jobId, url: url }));
    ScriptApp.newTrigger('runWeddingJob_').timeBased().after(1000).create();
  }

  cache.put(jobId, JSON.stringify({ status: 'pending', url: url }), 1800);
  return { ok: true, status: 're-kicked' };
}

/* ================================================================
   HTTP FETCH 헬퍼
   ================================================================ */

/**
 * 모바일 User-Agent로 직접 fetch (한국 SSR 사이트에 효과적).
 * iPhone → Android → Desktop 순서로 시도.
 */
function directFetchMobile_(url) {
  var agents = [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  ];

  var html = '';
  for (var i = 0; i < agents.length; i++) {
    try {
      var resp = UrlFetchApp.fetch(url, {
        muteHttpExceptions: true,
        followRedirects: true,
        headers: {
          'User-Agent': agents[i],
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
          'Cache-Control': 'no-cache'
        }
      });
      if (resp.getResponseCode() === 200) {
        html = resp.getContentText('UTF-8');
        if (html.length > 500) break;
      }
    } catch (e) { /* 다음 UA 시도 */ }
  }

  return {
    text: stripHtmlTags_(html),
    og:   extractOgTags_(html),
    html: html
  };
}

/** JS 렌더러 폴백 — jina.ai reader 사용 (무료, API 키 불필요) */
function renderPage_(url) {
  try {
    var apiUrl = 'https://r.jina.ai/' + encodeURIComponent(url);
    var resp = UrlFetchApp.fetch(apiUrl, {
      muteHttpExceptions: true,
      headers: { 'Accept': 'text/plain' }
    });
    if (resp.getResponseCode() === 200) return resp.getContentText('UTF-8');
  } catch (e) {}
  return '';
}

function stripHtmlTags_(html) {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function extractOgTags_(html) {
  var og = {};
  if (!html) return og;
  var pat  = /<meta[^>]+property=["']og:([^"']+)["'][^>]+content=["']([^"']*)["'][^>]*>/gi;
  var pat2 = /<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:([^"']+)["'][^>]*>/gi;
  var m;
  while ((m = pat.exec(html))  !== null) { og[m[1]] = m[2]; }
  while ((m = pat2.exec(html)) !== null) { if (!og[m[2]]) og[m[2]] = m[1]; }
  return og;
}

/* ================================================================
   한국어 휴리스틱 파서
   ================================================================ */

/** 모바일 청첩장 텍스트에서 혼사 정보 추출 */
function parseKoreanWeddingHeuristic_(text) {
  var r = {};
  if (!text) return r;

  /* 날짜 */
  var dm = text.match(/(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
  if (dm) r.weddingDate = dm[1] + '-' + pad2_(dm[2]) + '-' + pad2_(dm[3]);

  /* 시간 */
  var tm = text.match(/(오전|오후)\s*(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?/);
  if (tm) {
    var h = parseInt(tm[2], 10);
    var min = tm[3] ? parseInt(tm[3], 10) : 0;
    if (tm[1] === '오후' && h < 12) h += 12;
    if (tm[1] === '오전' && h === 12) h = 0;
    r.weddingTime = pad2_(h) + ':' + pad2_(min);
  }

  /* 예식장명 */
  var venuePats = [
    /예식장[：:\s]*([^\n,。]{2,20})/,
    /웨딩홀[：:\s]*([^\n,。]{2,20})/,
    /([가-힣\s]{2,20}(?:웨딩|웨딩홀|컨벤션|채플|하우스|파크))/
  ];
  for (var i = 0; i < venuePats.length; i++) {
    var vm = text.match(venuePats[i]);
    if (vm) { r.venueName = vm[1].trim(); break; }
  }

  /* 주소 */
  var am = text.match(/([가-힣]+(?:시|도)\s+[가-힣]+(?:구|군|시)\s+[가-힣\d\s\-]+(?:로|길)[^\n,]{0,40})/);
  if (am) r.venueAddr = am[1].trim();

  /* 홀/층 */
  var hm = text.match(/([^\s]+(?:홀|층|관|B\d|b\d))/i);
  if (hm) r.venueHall = hm[1].trim();

  /* 신랑/신부 이름 */
  var gm = text.match(/신\s*랑\s*[：:·]?\s*([가-힣]{2,5})/);
  var bm = text.match(/신\s*부\s*[：:·]?\s*([가-힣]{2,5})/);
  if (gm) r.groomName = gm[1];
  if (bm) r.brideName = bm[1];

  /* 가족 관계 패턴 (○○의 장남/장녀 ○○) */
  var familyPat = /([가-힣]{2,5})\s*[·&]\s*([가-힣]{2,5})\s*의\s*(장남|차남|삼남|사남|오남|장녀|차녀|삼녀|사녀|오녀)\s+([가-힣]{2,5})/g;
  var fm, groomDone = false, brideDone = false;
  while ((fm = familyPat.exec(text)) !== null) {
    var isSon = fm[3].indexOf('남') !== -1;
    if (isSon && !groomDone) {
      r.groomName   = r.groomName || fm[4];
      r.groomFather = fm[1];
      r.groomMother = fm[2];
      groomDone = true;
    } else if (!isSon && !brideDone) {
      r.brideName   = r.brideName || fm[4];
      r.brideFather = fm[1];
      r.brideMother = fm[2];
      brideDone = true;
    }
  }

  return r;
}

/** 모바일 부고장 텍스트에서 조사 정보 추출 */
function parseKoreanFuneralHeuristic_(text) {
  var r = {};
  if (!text) return r;

  /* 고인 성함 */
  var deceasedPats = [
    /고\s*인\s*[：:·\s]*([가-힣]{2,5})/,
    /([가-힣]{2,5})\s*님께서/,
    /삼가\s+([가-힣]{2,5})\s*님의/
  ];
  for (var i = 0; i < deceasedPats.length; i++) {
    var dm = text.match(deceasedPats[i]);
    if (dm) { r.deceasedName = dm[1]; break; }
  }

  /* 상의 종류 */
  var relationMap = {
    '부친상': '부친상', '부친': '부친상',
    '모친상': '모친상', '모친': '모친상',
    '배우자상': '배우자상', '남편상': '배우자상', '아내상': '배우자상',
    '형상': '형상', '제상': '제상',
    '장인상': '장인상', '장모상': '장모상',
    '빙부상': '빙부상', '빙모상': '빙모상',
    '조부상': '조부상', '조모상': '조모상',
    '자녀상': '자녀상', '본인상': '본인상'
  };
  for (var key in relationMap) {
    if (text.indexOf(key) !== -1) { r.relationship = relationMap[key]; break; }
  }

  /* 상주 */
  var chiefPats = [
    /상\s*주\s*[：:·\s]*([가-힣]{2,5})/,
    /유족\s+대표\s*[：:·\s]*([가-힣]{2,5})/
  ];
  for (var i = 0; i < chiefPats.length; i++) {
    var cm = text.match(chiefPats[i]);
    if (cm) { r.chiefMourner = cm[1]; break; }
  }

  /* 빈소 */
  var hallPats = [
    /빈\s*소\s*[：:·\s]*([^\n,。]{2,30})/,
    /장\s*례\s*식\s*장\s*[：:·\s]*([^\n,。]{2,30})/,
    /([가-힣\s]{2,20}(?:장례식장|장례원|병원|의료원))/
  ];
  for (var i = 0; i < hallPats.length; i++) {
    var hm = text.match(hallPats[i]);
    if (hm) { r.funeralHall = hm[1].trim(); break; }
  }

  /* 빈소 주소 */
  var am = text.match(/([가-힣]+(?:시|도)\s+[가-힣]+(?:구|군|시)\s+[가-힣\d\s\-]+(?:로|길)[^\n,]{0,40})/);
  if (am) r.funeralAddr = am[1].trim();

  /* 발인 날짜 */
  var fdm = text.match(/발\s*인\s*[：:·\s]*(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/)
         || text.match(/(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일\s*(?:발인|출발)/);
  if (fdm) r.funeralDate = fdm[1] + '-' + pad2_(fdm[2]) + '-' + pad2_(fdm[3]);

  /* 발인 시간 */
  var ftm = text.match(/발\s*인.*?(오전|오후)\s*(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?/);
  if (ftm) {
    var h = parseInt(ftm[2], 10);
    var min = ftm[3] ? parseInt(ftm[3], 10) : 0;
    if (ftm[1] === '오후' && h < 12) h += 12;
    if (ftm[1] === '오전' && h === 12) h = 0;
    r.funeralTime = pad2_(h) + ':' + pad2_(min);
  }

  /* 장지 */
  var burialPats = [
    /장\s*지\s*[：:·\s]*([^\n,。]{2,30})/,
    /묘\s*지\s*[：:·\s]*([^\n,。]{2,30})/,
    /화장(?:장)?\s*[：:·\s]*([^\n,。]{2,20})/
  ];
  for (var i = 0; i < burialPats.length; i++) {
    var bm = text.match(burialPats[i]);
    if (bm) { r.burialSite = bm[1].trim(); break; }
  }

  return r;
}

function isWeddingComplete_(d) {
  return !!(d.weddingDate && d.weddingTime && d.venueName && (d.groomName || d.brideName));
}

function isFuneralComplete_(d) {
  return !!(d.deceasedName && d.funeralHall && d.funeralDate);
}

/* ================================================================
   GEMINI 구조화 추출
   ================================================================ */

function runGeminiWeddingStructured_(text, og, model, heur) {
  var prompt = [
    '아래는 한국 모바일 청첩장 페이지에서 추출한 텍스트입니다.',
    '이미 파악된 정보(heuristic)도 함께 제공합니다. 비어있는 항목만 추출해 주세요.',
    '',
    '=== 텍스트 ===',
    (text || '').substring(0, 4000),
    '',
    '=== OG 태그 ===',
    JSON.stringify(og || {}),
    '',
    '=== 이미 파악된 정보 ===',
    JSON.stringify(heur || {}),
    '',
    '다음 JSON 형식으로만 답하세요 (설명 없이):',
    '{',
    '  "groomName": "신랑 이름 (한글 2-4자)",',
    '  "brideName": "신부 이름 (한글 2-4자)",',
    '  "groomFather": "신랑 부친 이름",',
    '  "groomMother": "신랑 모친 이름",',
    '  "brideFather": "신부 부친 이름",',
    '  "brideMother": "신부 모친 이름",',
    '  "weddingDate": "YYYY-MM-DD",',
    '  "weddingTime": "HH:MM",',
    '  "venueName": "예식장명",',
    '  "venueHall": "홀/층 정보",',
    '  "venueAddr": "도로명 주소"',
    '}',
    '',
    '모르는 값은 빈 문자열("")로 남기세요.'
  ].join('\n');

  return callGemini_(model, prompt);
}

function runGeminiFuneralStructured_(text, og, model, heur) {
  var prompt = [
    '아래는 한국 모바일 부고장(訃告狀) 페이지에서 추출한 텍스트입니다.',
    '이미 파악된 정보(heuristic)도 함께 제공합니다. 비어있는 항목만 추출해 주세요.',
    '',
    '=== 텍스트 ===',
    (text || '').substring(0, 4000),
    '',
    '=== OG 태그 ===',
    JSON.stringify(og || {}),
    '',
    '=== 이미 파악된 정보 ===',
    JSON.stringify(heur || {}),
    '',
    '다음 JSON 형식으로만 답하세요 (설명 없이):',
    '{',
    '  "deceasedName": "고인 성함 (한글 2-5자)",',
    '  "relationship": "관계 (부친상|모친상|배우자상|형상|제상|장인상|장모상|빙부상|빙모상|조부상|조모상|자녀상|본인상 중 하나)",',
    '  "chiefMourner": "상주 이름 (한글 2-5자)",',
    '  "funeralHall": "빈소 장례식장명",',
    '  "funeralAddr": "빈소 주소 (도로명)",',
    '  "funeralDate": "발인일 YYYY-MM-DD",',
    '  "funeralTime": "발인시간 HH:MM",',
    '  "burialSite": "장지"',
    '}',
    '',
    '모르는 값은 빈 문자열("")로 남기세요.'
  ].join('\n');

  return callGemini_(model, prompt);
}

function callGemini_(model, prompt) {
  if (!GEMINI_KEY) return {};
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model
          + ':generateContent?key=' + GEMINI_KEY;
  try {
    var resp = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 1024 }
      }),
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) return {};
    var body    = JSON.parse(resp.getContentText());
    var rawText = ((((body.candidates || [])[0] || {}).content || {}).parts || [])[0];
    if (!rawText || !rawText.text) return {};
    var jsonStr = rawText.text.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
    return JSON.parse(jsonStr);
  } catch (e) {
    return {};
  }
}

/* ================================================================
   데이터 제출 (SUBMIT)
   ================================================================ */

function submitWedding_(p) {
  if (!SHEET_ID) return { ok: false, error: 'SHEET_ID not configured' };
  try {
    var ss    = SpreadsheetApp.openById(SHEET_ID);
    var sheet = ss.getSheetByName('wedding') || ss.insertSheet('wedding');
    sheet.appendRow([
      new Date().toISOString(),
      p.submitter    || '',
      p.groomName    || '', p.brideName   || '',
      p.weddingDate  || '', p.weddingTime || '',
      p.venueName    || '', p.venueHall   || '', p.venueAddr || '',
      p.dept         || '', p.rank        || '',
      p.relationship || '',
      p.accountNo    || '', p.accountPublic || '',
      p.signature    || ''
    ]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function submitExecutive_(p) {
  if (!SHEET_ID) return { ok: false, error: 'SHEET_ID not configured' };
  try {
    var ss    = SpreadsheetApp.openById(SHEET_ID);
    var sheet = ss.getSheetByName('executive') || ss.insertSheet('executive');
    sheet.appendRow([
      new Date().toISOString(),
      p.submitter     || '',
      p.deceasedName  || '', p.relationship  || '',
      p.chiefMourner  || '',
      p.funeralHall   || '', p.funeralAddr   || '',
      p.funeralDate   || '', p.funeralTime   || '',
      p.burialSite    || '',
      p.wreath        || '',
      p.employed      || '',
      p.dept          || '', p.rank          || '',
      p.company       || '',
      p.antiGraft     || '',
      p.accountNo     || '', p.accountPublic || '',
      p.signature     || ''
    ]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function lookupContacts_(p) {
  return { ok: true, contacts: [] };
}

/* ================================================================
   공통 유틸리티
   ================================================================ */

function pad2_(n) {
  return ('0' + parseInt(n, 10)).slice(-2);
}

/** addon 값을 base에 병합 (base에 값이 없는 항목만 채움) */
function mergeObjects_(base, addon) {
  var result = {}, k;
  for (k in base)  { result[k] = base[k]; }
  for (k in addon) { if (!result[k] || result[k] === '') result[k] = addon[k]; }
  return result;
}

function jsonpOk_(cb, data) {
  return ContentService
    .createTextOutput(cb + '(' + JSON.stringify(data) + ')')
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

function deleteTrigger_(handlerName) {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === handlerName) ScriptApp.deleteTrigger(t);
  });
}
