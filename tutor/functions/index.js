/**
 * All About Korea – 1:1 Korean Tutoring · Cloud Functions (Gen 2)
 * ------------------------------------------------------------------
 * 크레딧(수강권)과 결제에 관한 모든 쓰기는 이 서버 코드에서만 처리됩니다.
 * (Firestore 규칙에서 orders / bookings / creditLogs / busySlots 의 클라이언트 쓰기를 막음)
 *
 *  Callable (클라이언트에서 호출)
 *   - createOrder     : 수강권 구매 요청 생성 (가격은 서버에서 계산)
 *   - updateOrder     : 결제 수정 (학생=Pending만, 튜터/관리자=언제든)
 *   - deleteOrder     : 결제 삭제 (학생=Pending만, 튜터/관리자=사용 이력 없는 건)
 *   - confirmPayment  : 결제 확인 → 크레딧 지급 + 유효기간 설정 (튜터/관리자)
 *   - bookLesson      : 수업 예약 → 크레딧 1개 '예약 중(보류)' + 튜터 캘린더 일정 생성
 *   - cancelLesson    : 수업 취소 → 보류 크레딧 복원 (학생=24시간 전까지)
 *   - submitReview    : 리뷰 작성 (수업 완료한 학생만) → 튜터 평점 재계산
 *   - syncCalendar    : 튜터 Google 캘린더 free/busy 즉시 동기화 (튜터/관리자)
 *   - rescheduleLesson: 수업 시간 변경 (학생=12시간 전까지, 새 시간도 12시간 이후)
 *   - setMemberId     : 회원 표시 ID 지정 (관리자) → 기존 결제·예약에도 반영
 *   - bookLessons     : 매주 같은 시간 반복 예약 (여러 건을 한 번에, 각 건마다 중복 검사)  [추가]
 *   - openChat        : 튜터-학생 채팅방 열기 (현재 수강 관계일 때만)                     [추가]
 *   - googleConnectStart / googleDisconnect : 튜터 Google 계정 연결 (Meet 자동 생성)     [추가]
 *  HTTP
 *   - googleOAuthCallback : Google 계정 연결 완료 처리                                    [추가]
 *  이메일 (Gmail 앱 비밀번호, 한국어+영어)                                                  [추가]
 *   - 수강 신청 → 튜터·학생 / 예약·변경·취소 → 튜터·학생 / 24시간 읽지 않은 채팅 → 하루 1통
 *
 *  Scheduled (10분마다 자동 실행)
 *   - processCredits  : ① 종료된 수업 → '사용 완료'로 최종 차감
 *                       ② 유효기간 지난 수강권 → 잔여 크레딧 만료
 *                       ③ 업로드 7일 지난 자료 → Storage 파일 + 문서 삭제
 *                       ④ 지난 예약 슬롯 정리
 *                       ⑤ 튜터 Google 캘린더 바쁜 시간 동기화 (calBusy)
 *                       ⑥ 30일 지난 채팅 메시지·첨부 파일 삭제                       [추가]
 *  Scheduled (1시간마다)
 *   - chatUnreadDigest: 24시간 넘게 읽지 않은 채팅이 있으면 알림 메일 (받는 사람당 하루 최대 1통)
 *  모든 변경은 트랜잭션으로 처리되어 중복 실행/동시 실행에도 이중 차감되지 않습니다.
 */
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const nodemailer = require("nodemailer");
const crypto = require("crypto");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions } = require("firebase-functions/v2");
const logger = require("firebase-functions/logger");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const { GoogleAuth } = require("google-auth-library");

initializeApp();
setGlobalOptions({ region: "asia-northeast3", maxInstances: 10 });
const db = getFirestore();

const OWNER_EMAIL = "shchung0130@gmail.com";

/* ───────────── 설정 (이메일·Google 계정 연결) ───────────── */
const MAIL_FROM = "shchung0130@gmail.com";                          // 보내는 Gmail 주소
const GMAIL_APP_PASSWORD = defineSecret("GMAIL_APP_PASSWORD");      // 위 Gmail 계정의 "앱 비밀번호"
const GOOGLE_OAUTH_CLIENT_ID = defineSecret("GOOGLE_OAUTH_CLIENT_ID");
const GOOGLE_OAUTH_CLIENT_SECRET = defineSecret("GOOGLE_OAUTH_CLIENT_SECRET");
const PROJECT_ID = "all-about-korea-login";
const OAUTH_REDIRECT = `https://asia-northeast3-${PROJECT_ID}.cloudfunctions.net/googleOAuthCallback`;
const TUTOR_PAGE = "https://www.businesskorean.com/tutor/tutor.html";
const MAIL_SECRETS = [GMAIL_APP_PASSWORD];
const OAUTH_SECRETS = [GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET];
const CUSTOM_MIN = 2, CUSTOM_MAX = 30, CUSTOM_DAYS = 60;            // 맞춤 패키지: 학생이 2~30회 선택, 유효기간 60일
const CHAT_DAYS = 30;                                                // 채팅·첨부 파일 보관 기간
const PKG_KEYS = ["trial", "single", "pack5", "pack10"];
const DURATION = { trial: 25, regular: 50 };
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const r2 = (x) => Math.round(x * 100) / 100;
const rateId = (tid, email) => `${tid}__${String(email).toLowerCase()}`;
const kst = (date) => {
  const k = new Date(date.getTime() + 9 * HOUR);
  const iso = k.toISOString();
  return { ymd: iso.slice(0, 10), hm: iso.slice(11, 16), wd: WD[k.getUTCDay()] };
};
// 튜터별 수강권 구성: 체험 7일·단건 14일 고정, 패키지 A/B는 튜터가 횟수·유효기간 설정
// cr(학생 맞춤 요금)이 있으면 그 학생에게는 맞춤 패키지 구성이 우선 적용됩니다.
// pack5 = 맞춤 패키지(Custom Pack): 학생이 2~30회를 고르고 유효기간은 60일 고정
const customCount = (v, d) => Math.min(CUSTOM_MAX, Math.max(CUSTOM_MIN, Math.round(num(v, d))));
function pkgTable(tutor, cr, count) {
  const p = (tutor && tutor.pricing) || {};
  const o = cr || {};
  const cnt = (v, d) => Math.min(50, Math.max(2, Math.round(num(v, d))));
  const dys = (v, d) => Math.min(365, Math.max(7, Math.round(num(v, d))));
  const pick = (a, b, d) => (a == null || a === "" ? num(b, d) : num(a, d));
  return {
    trial:  { credits: 1, creditType: "trial",   validDays: 7 },
    single: { credits: 1, creditType: "regular", validDays: 14 },
    pack5:  { credits: customCount(count, customCount(pick(o.pack5Count, p.pack5Count, 9), 9)),
      creditType: "regular", validDays: CUSTOM_DAYS },
    pack10: { credits: cnt(pick(o.pack10Count, p.pack10Count, 10), 10),
      creditType: "regular", validDays: dys(pick(o.pack10Days, p.pack10Days, 120), 120) },
  };
}
const logRef = () => db.collection("creditLogs").doc();
const logData = (d) => ({ ...d, at: FieldValue.serverTimestamp() });

/* ───────────── 호출자 정보 ───────────── */
async function caller(req) {
  const email = req.auth && req.auth.token && req.auth.token.email;
  if (!req.auth || !email) throw new HttpsError("unauthenticated", "Please sign in first.");
  const snap = await db.doc(`roles/${email}`).get();
  const r = snap.exists ? snap.data() : {};
  return {
    uid: req.auth.uid,
    email: String(email).toLowerCase(),
    name: req.auth.token.name || String(email).split("@")[0],
    role: email === OWNER_EMAIL ? "admin" : (r.role || "student"),
    tutorId: r.tutorId || null,
    displayId: r.displayId || null,
  };
}
// 모든 Callable 공통: 예상치 못한 오류를 'INTERNAL' 대신 원인이 보이는 메시지로 반환
function friendlyError(e) {
  const msg = String((e && e.message) || e);
  if ((e && e.code === 7) || /PERMISSION_DENIED/.test(msg)) {
    return "Server permission error (Firestore PERMISSION_DENIED). Admin: in Google Cloud IAM, grant the role 'Cloud Datastore User' to the functions service account (PROJECT_NUMBER-compute@developer.gserviceaccount.com).";
  }
  if ((e && e.code === 9) || /requires an index|FAILED_PRECONDITION/i.test(msg)) return "Firestore index required: " + msg.slice(0, 400);
  return "Server error: " + msg.slice(0, 300);
}
const call = (handler, opts = {}) => onCall(opts, async (req) => {
  try { return await handler(req); } catch (e) {
    if (e instanceof HttpsError) throw e;
    logger.error("callable failed", e);
    throw new HttpsError("internal", friendlyError(e));
  }
});
const isManager = (c, tid) => c.role === "admin" || (c.role === "tutor" && c.tutorId === tid);

/* ───────────── 가능 시간 (30분 칸) ─────────────
 * tutors.availability[요일] = 30분 칸 시작 시각 목록 ("08:00","08:30",…), availStep: 30
 * (이전 1시간 단위 데이터는 "HH:00" → HH:00·HH:30 두 칸으로 해석)
 * 수업은 시작 칸부터 수업 길이만큼의 칸이 모두 열려 있어야 예약 가능 (체험 1칸, 정규 2칸)
 */
const LEAD = 12 * HOUR;               // 예약·변경은 최소 12시간 전까지
function availCells(tutor, wd) {
  const a = ((tutor.availability || {})[wd] || []).map(String);
  if (tutor.availStep === 30) return new Set(a);
  const s = new Set();
  a.forEach((hm) => { s.add(hm.slice(0, 2) + ":00"); s.add(hm.slice(0, 2) + ":30"); });
  return s;
}
function addMin(hm, m) {
  const t = Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5)) + m;
  return t >= 1440 ? null : String(Math.floor(t / 60)).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0");
}
function isOpen(tutor, wd, hm, durMin) {
  const cells = availCells(tutor, wd);
  for (let m = 0; m < durMin; m += 30) { const c = addMin(hm, m); if (!c || !cells.has(c)) return false; }
  return true;
}
// 트랜잭션 안에서 새 시간대 검증 (읽기만). ignoreSlotId = 시간 변경 시 기존 자기 슬롯
async function checkSlot(tx, tutorId, start, end, durMin, ignoreSlotId) {
  const k = kst(start);
  const tSnap = await tx.get(db.doc(`tutors/${tutorId}`));
  if (!tSnap.exists || tSnap.data().active === false) throw new HttpsError("not-found", "Tutor not available.");
  const tutor = tSnap.data();
  if (!isOpen(tutor, k.wd, k.hm, durMin)) throw new HttpsError("failed-precondition", "This time is not open for booking.");
  if ((tutor.blockedDates || []).some((b) => b.date === k.ymd)) {
    throw new HttpsError("failed-precondition", "The tutor is off on this date.");
  }
  // 겹치는 다른 수업 (수업 최대 50분 → 시작 60분 전부터 조회)
  const near = await tx.get(db.collection("busySlots")
    .where("startAt", ">", Timestamp.fromMillis(start.getTime() - 60 * 60000))
    .where("startAt", "<", Timestamp.fromDate(end)));
  if (near.docs.some((d) => d.id !== ignoreSlotId && d.data().tutorId === tutorId && d.data().endAt.toMillis() > start.getTime())) {
    throw new HttpsError("already-exists", "This slot was just taken. Please choose another time.");
  }
  return { tutor, k };
}

/* ───────────── 가격 계산 (서버 기준) ─────────────
 * 학생 맞춤 요금(customRates)이 있으면 50분 단가와 패키지 A·B 구성·할인율을 그 학생 기준으로 적용하고,
 * 체험 수업은 판매하지 않습니다 (이미 체험을 마친 학생을 위한 요금이므로).
 */
async function computePrice(tutorId, email, pkg, count) {
  const tSnap = await db.doc(`tutors/${tutorId}`).get();
  if (!tSnap.exists || tSnap.data().active === false) {
    throw new HttpsError("not-found", "This tutor is not available.");
  }
  const tutor = tSnap.data();
  const p = tutor.pricing || {};
  const crSnap = await db.doc(`customRates/${rateId(tutorId, email)}`).get();
  const cr = crSnap.exists ? crSnap.data() : null;
  if (cr && pkg === "trial") {
    throw new HttpsError("failed-precondition", "The trial lesson is not available on your custom plan.");
  }
  const pick = (a, b, d) => (a == null || a === "" ? num(b, d) : num(a, d));
  const trial = num(p.trial, 10);
  const single = cr ? num(cr.rate, num(p.single, 35)) : num(p.single, 35);
  const d5 = Math.min(90, Math.max(0, pick(cr && cr.disc5, p.disc5, 5)));
  const d10 = Math.min(90, Math.max(0, pick(cr && cr.disc10, p.disc10, 12)));
  const cfg = pkgTable(tutor, cr, count);
  const n5 = cfg.pack5.credits, n10 = cfg.pack10.credits;
  const table = {
    trial:  { list: trial, price: trial },
    single: { list: single, price: single },
    pack5:  { list: r2(single * n5),  price: r2(single * n5 * (1 - d5 / 100)) },
    pack10: { list: r2(single * n10), price: r2(single * n10 * (1 - d10 / 100)) },
  };
  return { ...table[pkg], ...cfg[pkg], tutor, customRate: !!cr };
}

/* ───────────── Google 캘린더 (free/busy만 조회) ─────────────
 * 튜터가 자기 캘린더를 함수 서비스 계정(기본: PROJECT_NUMBER-compute@developer.gserviceaccount.com)에
 * "한가함/바쁨 정보만 보기" 권한으로 공유하면, 일정 제목 없이 바쁜 시간대만 읽어 예약을 막습니다.
 * Google Cloud Console에서 "Google Calendar API"를 사용 설정해야 합니다.
 */
// 예약 일정을 튜터 캘린더에 직접 만들기 위해 쓰기 권한이 포함된 범위를 사용합니다.
// (읽기만 하는 free/busy 조회도 이 범위로 함께 동작합니다)
const CAL_SCOPE = "https://www.googleapis.com/auth/calendar";
const CAL_AHEAD_DAYS = 84;           // 12주 앞까지 동기화
let gAuth = null;
async function calClient() {
  if (!gAuth) gAuth = new GoogleAuth({ scopes: [CAL_SCOPE] });
  return gAuth.getClient();
}
let saEmail = null;
async function serviceAccountEmail() {
  if (saEmail) return saEmail;
  try {
    const r = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email",
      { headers: { "Metadata-Flavor": "Google" } });
    if (r.ok) saEmail = (await r.text()).trim();
  } catch (e) { /* 로컬 실행 등 */ }
  return saEmail;
}
function mergeIntervals(list) {
  const a = list.filter((x) => x.e > x.s).sort((x, y) => x.s - y.s), out = [];
  for (const x of a) {
    const last = out[out.length - 1];
    if (last && x.s <= last.e) last.e = Math.max(last.e, x.e); else out.push({ s: x.s, e: x.e });
  }
  return out;
}
// ids 캘린더들의 [fromMs, toMs) 바쁜 시간. 4주 단위로 나눠 조회
async function freeBusy(ids, fromMs, toMs) {
  const client = await calClient();
  const status = Object.fromEntries(ids.map((id) => [id, "ok"]));
  const busy = [];
  for (let s = fromMs; s < toMs; s += 28 * DAY) {
    const e = Math.min(toMs, s + 28 * DAY);
    const res = await client.request({
      url: "https://www.googleapis.com/calendar/v3/freeBusy", method: "POST",
      data: { timeMin: new Date(s).toISOString(), timeMax: new Date(e).toISOString(), items: ids.map((id) => ({ id })) },
    });
    const cals = (res.data && res.data.calendars) || {};
    for (const id of ids) {
      const c = cals[id] || {};
      if (c.errors && c.errors.length) status[id] = c.errors[0].reason || "error";
      (c.busy || []).forEach((b) => busy.push({ s: Date.parse(b.start), e: Date.parse(b.end) }));
    }
  }
  return { busy: mergeIntervals(busy), status };
}
const calIdsOf = async (tid) => {
  const s = await db.doc(`tutorPrivate/${tid}`).get();
  return ((s.exists && s.data().calendarIds) || []).map((x) => String(x).trim()).filter(Boolean).slice(0, 10);
};
function apiErrorText(e) {
  const msg = (e && e.response && e.response.data && e.response.data.error && e.response.data.error.message) || (e && e.message) || String(e);
  if (/has not been used|is disabled|accessNotConfigured/i.test(msg)) {
    return "Google Calendar API가 꺼져 있습니다. Google Cloud Console에서 'Google Calendar API'를 사용 설정하세요.";
  }
  return msg.slice(0, 300);
}
// 튜터 1명 동기화 → calBusy/{tid} (공개: 시간대만) + tutorPrivate/{tid}.calSync (상태)
async function syncTutorCalendar(tid) {
  const ids = await calIdsOf(tid);
  const now = Date.now();
  const sa = await serviceAccountEmail();
  const result = { status: {}, busyCount: 0, error: null, serviceAccount: sa };
  if (!ids.length) {
    await db.doc(`calBusy/${tid}`).set({ tutorId: tid, busy: [], syncedAt: FieldValue.serverTimestamp() });
  } else {
    try {
      const { busy, status } = await freeBusy(ids, now - DAY, now + CAL_AHEAD_DAYS * DAY);
      result.status = status; result.busyCount = busy.length;
      await db.doc(`calBusy/${tid}`).set({ tutorId: tid, busy, syncedAt: FieldValue.serverTimestamp() });
    } catch (e) {
      result.error = apiErrorText(e);
      logger.warn("calendar sync failed", tid, result.error);
    }
  }
  await db.doc(`tutorPrivate/${tid}`).set({ calSync: { ...result, at: FieldValue.serverTimestamp() } }, { merge: true });
  return result;
}
/* ───────────── 튜터 캘린더에 수업 일정 자동 등록 ─────────────
 * tutorPrivate/{tid}.eventCalendarId (없으면 calendarIds[0]) 캘린더에 일정을 만듭니다.
 * 해당 캘린더를 서비스 계정에 "일정 변경 권한"으로 공유해야 동작하며,
 * 공유 권한이 보기 전용이면 조용히 건너뜁니다 (예약 자체는 항상 성공).
 * transparency: "transparent" → free/busy 에 '한가함'으로 잡혀 자체 예약 차단과 중복되지 않습니다.
 */
const LESSON_TAG = "aak-tutoring";
async function writeCalendarId(tid) {
  const s = await db.doc(`tutorPrivate/${tid}`).get();
  const d = s.exists ? s.data() : {};
  if (d.calendarWrite === false) return null;
  const ids = (d.calendarIds || []).map((x) => String(x).trim()).filter(Boolean);
  return String(d.eventCalendarId || ids[0] || "").trim() || null;
}
function lessonEventBody(b, extra) {
  const who = b.studentId || b.studentName || String(b.studentEmail || "").split("@")[0];
  const type = b.creditType === "trial" ? "체험 25분" : "정규 50분";
  const lines = [
    `학생: ${who} (${b.studentEmail})`,
    `유형: ${type}`,
    b.studentTZ ? `학생 현지 시간대: ${b.studentTZ}` : null,
    b.meetLink ? `Google Meet: ${b.meetLink}` : null,
    "",
    "All About Korea · 1:1 Korean Tutoring",
  ].filter(Boolean);
  return {
    summary: `🇰🇷 ${who} · ${type}`,
    description: lines.join("\n"),
    location: b.meetLink || undefined,
    start: { dateTime: b.startAt.toDate().toISOString(), timeZone: "Asia/Seoul" },
    end: { dateTime: b.endAt.toDate().toISOString(), timeZone: "Asia/Seoul" },
    transparency: "transparent",
    reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 15 }] },
    extendedProperties: { private: { app: LESSON_TAG, bookingId: extra.bookingId } },
  };
}
async function calApi(method, calId, path, data) {
  const client = await calClient();
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events${path || ""}`;
  const res = await client.request({ url, method, data });
  return res.data || {};
}
// 예약 생성·변경 후 호출: 일정이 없으면 만들고, 있으면 수정합니다.
async function upsertLessonEvent(bookingId, opts = {}) {
  const bRef = db.doc(`bookings/${bookingId}`);
  const snap = await bRef.get();
  if (!snap.exists) return;
  const b = snap.data();
  if (b.status !== "reserved") return;
  // 튜터가 Google 계정을 연결했다면: 튜터 기본 캘린더에 일정 + Google Meet 링크 자동 생성
  if (await meetUpsert(bRef, b, opts)) return;
  const calId = await writeCalendarId(b.tutorId);
  if (!calId) return;
  const body = lessonEventBody(b, { bookingId });
  try {
    if (b.calEventId && b.calEventCalId === calId) {
      await calApi("PUT", calId, `/${encodeURIComponent(b.calEventId)}`, body);
      await bRef.update({ calEventError: FieldValue.delete() });
    } else {
      const ev = await calApi("POST", calId, "", body);
      await bRef.update({ calEventId: ev.id || null, calEventCalId: calId, calEventError: FieldValue.delete() });
    }
  } catch (e) {
    const msg = apiErrorText(e);
    logger.warn("calendar event write failed", bookingId, msg);
    await bRef.update({ calEventError: msg }).catch(() => {});
  }
}
async function deleteLessonEvent(b) {
  if (b && b.gEventId) { await meetDelete(b); return; }
  if (!b || !b.calEventId || !b.calEventCalId) return;
  try { await calApi("DELETE", b.calEventCalId, `/${encodeURIComponent(b.calEventId)}`); }
  catch (e) { logger.warn("calendar event delete failed", apiErrorText(e)); }
}

// 예약 직전 실시간 확인. API 실패 시 마지막 동기화 결과로 판단
async function calendarConflict(tid, startMs, endMs) {
  const ids = await calIdsOf(tid);
  if (!ids.length) return false;
  try {
    const { busy } = await freeBusy(ids, startMs, endMs);
    return busy.some((b) => b.s < endMs && b.e > startMs);
  } catch (e) {
    logger.warn("live free/busy failed, using cache", tid, apiErrorText(e));
    const c = await db.doc(`calBusy/${tid}`).get();
    return ((c.exists && c.data().busy) || []).some((b) => b.s < endMs && b.e > startMs);
  }
}

/* ═════════════ syncCalendar ═════════════ */
exports.syncCalendar = call(async (req) => {
  const c = await caller(req);
  const { tutorId } = req.data || {};
  if (!tutorId || !isManager(c, tutorId)) throw new HttpsError("permission-denied", "Not allowed.");
  return syncTutorCalendar(tutorId);
});

/* ═════════════ createOrder ═════════════ */
exports.createOrder = call(async (req) => {
  const c = await caller(req);
  const { tutorId, pkg, count } = req.data || {};
  if (!tutorId || !PKG_KEYS.includes(pkg)) throw new HttpsError("invalid-argument", "Invalid plan.");
  if (pkg === "pack5" && count != null) {
    const n = Number(count);
    if (!Number.isInteger(n) || n < CUSTOM_MIN || n > CUSTOM_MAX) {
      throw new HttpsError("invalid-argument", `Custom Pack must be ${CUSTOM_MIN}–${CUSTOM_MAX} lessons.`);
    }
  }

  if (pkg === "trial") {
    const prev = await db.collection("orders")
      .where("studentEmail", "==", c.email).where("tutorId", "==", tutorId)
      .where("package", "==", "trial").get();
    if (!prev.empty) throw new HttpsError("already-exists", "The trial lesson can be purchased only once per tutor.");
  }

  const pr = await computePrice(tutorId, c.email, pkg, count);
  const ref = db.collection("orders").doc();
  const order = {
    studentEmail: c.email, studentUid: c.uid, studentName: c.name, studentId: c.displayId || null,
    tutorId, tutorName: pr.tutor.name || tutorId,
    package: pkg, creditType: pr.creditType, credits: pr.credits, validDays: pr.validDays,
    listPrice: pr.list, price: pr.price, currency: "USD", customRate: pr.customRate,
    commission: num(pr.tutor.commission, 0),
    status: "pending", used: 0, reserved: 0, expiredCredits: 0,
    createdAt: FieldValue.serverTimestamp(),
  };
  const batch = db.batch();
  batch.set(ref, order);
  batch.set(logRef(), logData({
    studentEmail: c.email, tutorId, orderId: ref.id, type: "order_created", delta: 0,
    creditType: order.creditType, note: `${pkg} · $${pr.price}`,
  }));
  await batch.commit();
  await mailOrderCreated({ ...order, id: ref.id }, pr.tutor);   // 튜터·학생에게 안내 메일 (실패해도 신청은 유지)
  return { orderId: ref.id, price: pr.price, listPrice: pr.list, credits: order.credits,
    tutorEmail: pr.tutor.email || null, tutorName: order.tutorName };
}, { secrets: MAIL_SECRETS });

/* ═════════════ updateOrder ═════════════ */
exports.updateOrder = call(async (req) => {
  const c = await caller(req);
  const { orderId, pkg, price, note, count } = req.data || {};
  if (!orderId) throw new HttpsError("invalid-argument", "orderId required.");
  const ref = db.doc(`orders/${orderId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Payment not found.");
  const o = snap.data();
  const mgr = isManager(c, o.tutorId);
  const own = o.studentEmail === c.email;
  if (!mgr && !own) throw new HttpsError("permission-denied", "Not allowed.");

  const upd = { updatedAt: FieldValue.serverTimestamp(), updatedBy: c.email };
  if (o.status !== "pending") {
    if (!mgr) throw new HttpsError("failed-precondition", "Only pending payments can be edited.");
    // 결제 완료 후에는 금액/메모만 수정 (크레딧 수량은 변경 불가)
    if (price != null) upd.price = r2(num(price, o.price));
    if (note != null) upd.note = String(note).slice(0, 500);
    await ref.update(upd);
    return { ok: true };
  }
  const countChanged = (pkg || o.package) === "pack5" && count != null && Number(count) !== o.credits;
  if ((pkg && pkg !== o.package) || countChanged) {
    if (pkg && !PKG_KEYS.includes(pkg)) throw new HttpsError("invalid-argument", "Invalid plan.");
    if (count != null && (!Number.isInteger(Number(count)) || Number(count) < CUSTOM_MIN || Number(count) > CUSTOM_MAX)) {
      throw new HttpsError("invalid-argument", `Custom Pack must be ${CUSTOM_MIN}–${CUSTOM_MAX} lessons.`);
    }
    const newPkg = pkg || o.package;
    if (newPkg === "trial") {
      const prev = await db.collection("orders").where("studentEmail", "==", o.studentEmail)
        .where("tutorId", "==", o.tutorId).where("package", "==", "trial").get();
      if (prev.docs.some((d) => d.id !== orderId)) throw new HttpsError("already-exists", "Trial already purchased.");
    }
    const pr = await computePrice(o.tutorId, o.studentEmail, newPkg, count);
    Object.assign(upd, { package: newPkg, creditType: pr.creditType, credits: pr.credits,
      validDays: pr.validDays, listPrice: pr.list, price: pr.price });
  }
  if (mgr && price != null) upd.price = r2(num(price, o.price));
  if (mgr && note != null) upd.note = String(note).slice(0, 500);
  await ref.update(upd);
  return { ok: true };
});

/* ═════════════ deleteOrder ═════════════ */
exports.deleteOrder = call(async (req) => {
  const c = await caller(req);
  const { orderId } = req.data || {};
  const ref = db.doc(`orders/${orderId || "_"}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Payment not found.");
    const o = snap.data();
    const mgr = isManager(c, o.tutorId);
    const own = o.studentEmail === c.email;
    if (!mgr && !own) throw new HttpsError("permission-denied", "Not allowed.");
    if (!mgr && o.status !== "pending") throw new HttpsError("failed-precondition", "Only pending payments can be deleted.");
    if ((o.used || 0) > 0 || (o.reserved || 0) > 0) {
      throw new HttpsError("failed-precondition", "Credits from this payment are already booked or used. Cancel those lessons first.");
    }
    const lost = o.status === "paid" ? o.credits : 0;
    tx.delete(ref);
    tx.set(logRef(), logData({ studentEmail: o.studentEmail, tutorId: o.tutorId, orderId, type: "order_deleted",
      delta: -lost, creditType: o.creditType, note: `${o.package} · by ${c.email}` }));
    return { ok: true };
  });
});

/* ═════════════ confirmPayment ═════════════ */
exports.confirmPayment = call(async (req) => {
  const c = await caller(req);
  const { orderId } = req.data || {};
  const ref = db.doc(`orders/${orderId || "_"}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Payment not found.");
    const o = snap.data();
    if (!isManager(c, o.tutorId)) throw new HttpsError("permission-denied", "Only the tutor or admin can confirm payments.");
    if (o.status !== "pending") throw new HttpsError("failed-precondition", "This payment is not pending.");
    const now = Date.now();
    tx.update(ref, {
      status: "paid",
      paidAt: Timestamp.fromMillis(now),
      expiresAt: Timestamp.fromMillis(now + num(o.validDays, 60) * DAY),
      confirmedBy: c.email,
    });
    tx.set(logRef(), logData({ studentEmail: o.studentEmail, tutorId: o.tutorId, orderId, type: "paid",
      delta: o.credits, creditType: o.creditType, note: `${o.package} · $${o.price}` }));
    return { ok: true };
  });
});

/* ═════════════ bookLesson ═════════════ */
// 수업 1건 예약 (검증 + 트랜잭션). 일정 생성·메일은 호출하는 쪽에서 처리합니다.
async function bookOne(c, tutorId, creditType, start, studentTZ) {
  const dur = DURATION[creditType];
  if (!tutorId || !dur || isNaN(start.getTime())) throw new HttpsError("invalid-argument", "Invalid booking request.");
  if (start.getTime() < Date.now() + LEAD) {
    throw new HttpsError("failed-precondition", "Lessons must be booked at least 12 hours in advance.");
  }
  const end = new Date(start.getTime() + dur * 60000);
  const busyRef = db.doc(`busySlots/${tutorId}_${start.getTime()}`);
  if (await calendarConflict(tutorId, start.getTime(), end.getTime())) {
    throw new HttpsError("failed-precondition", "The tutor is not available at this time. Please choose another slot.");
  }
  // 같은 튜터와의 가장 최근 예약에 저장된 Meet 링크를 이어받습니다 (Google 계정 연결 시에는 새 Meet 링크가 자동 생성됨).
  let meetLink = "";
  try {
    const prev = await db.collection("bookings")
      .where("studentEmail", "==", c.email).where("tutorId", "==", tutorId).get();
    const withLink = prev.docs.map((d) => d.data()).filter((x) => x.meetLink)
      .sort((a, b) => b.startAt.toMillis() - a.startAt.toMillis());
    if (withLink.length) meetLink = String(withLink[0].meetLink).slice(0, 500);
  } catch (e) { logger.warn("meet link carry-over failed", e); }

  return db.runTransaction(async (tx) => {
    const { tutor, k } = await checkSlot(tx, tutorId, start, end, dur, null);
    // 학생 본인의 다른 수업(다른 튜터 포함)과 시간이 겹치면 거절
    const mine = await tx.get(db.collection("bookings").where("studentEmail", "==", c.email).where("status", "==", "reserved"));
    if (mine.docs.some((d) => { const x = d.data(); const xs = x.startAt.toMillis(); const xe = x.endAt ? x.endAt.toMillis() : xs + 50 * 60000; return xs < end.getTime() && xe > start.getTime(); })) {
      throw new HttpsError("already-exists", "You already have another lesson at this time.");
    }

    const oq = await tx.get(db.collection("orders")
      .where("studentEmail", "==", c.email).where("tutorId", "==", tutorId)
      .where("creditType", "==", creditType).where("status", "==", "paid"));
    const cands = oq.docs
      .filter((d) => {
        const o = d.data();
        return o.credits - (o.used || 0) - (o.reserved || 0) > 0 && o.expiresAt && o.expiresAt.toMillis() > start.getTime();
      })
      .sort((a, b) => a.data().expiresAt.toMillis() - b.data().expiresAt.toMillis()); // 만료 임박 수강권부터 사용
    if (!cands.length) {
      throw new HttpsError("failed-precondition", "No credits available for this lesson type (or they expire before the lesson date).");
    }
    const od = cands[0];
    const bRef = db.collection("bookings").doc();
    tx.update(od.ref, { reserved: FieldValue.increment(1) });
    tx.set(bRef, {
      studentEmail: c.email, studentUid: c.uid, studentName: c.name, studentId: c.displayId || null,
      studentTZ: String(studentTZ || "").slice(0, 60),
      tutorId, tutorName: tutor.name || tutorId, orderId: od.id, creditType, durationMin: dur,
      startAt: Timestamp.fromDate(start), endAt: Timestamp.fromDate(end), kstDate: k.ymd, kstTime: k.hm,
      status: "reserved", meetLink, createdAt: FieldValue.serverTimestamp(),
    });
    tx.set(busyRef, { tutorId, bookingId: bRef.id, startAt: Timestamp.fromDate(start), endAt: Timestamp.fromDate(end) });
    tx.set(logRef(), logData({ studentEmail: c.email, tutorId, orderId: od.id, bookingId: bRef.id, type: "reserve",
      delta: -1, creditType, note: `${k.ymd} ${k.hm} KST` }));
    return { bookingId: bRef.id, meetLink };
  });
}

exports.bookLesson = call(async (req) => {
  const c = await caller(req);
  const { tutorId, creditType, startISO, studentTZ } = req.data || {};
  const out = await bookOne(c, tutorId, creditType, new Date(startISO), studentTZ);
  await upsertLessonEvent(out.bookingId);   // 튜터 캘린더 일정 + (연결 시) Meet 링크 자동 생성. 실패해도 예약은 유지
  const b = await getBooking(out.bookingId);
  await mailBookings("booked", b ? [b] : []);
  return { bookingId: out.bookingId, meetLink: (b && b.meetLink) || out.meetLink };
}, { secrets: [...MAIL_SECRETS, ...OAUTH_SECRETS] });

/* ═════════════ bookLessons (매주 반복 예약) ═════════════
 * startISOs 의 각 시간을 하나씩 예약합니다. 각 건은 bookLesson 과 같은 검증(가능 시간·휴무일·다른 예약·
 * Google 캘린더·학생 본인 수업 중복·크레딧 유효기간)을 거치며, 실패한 건은 건너뛰고 결과에 이유를 돌려줍니다.
 */
exports.bookLessons = call(async (req) => {
  const c = await caller(req);
  const { tutorId, creditType, startISOs, studentTZ } = req.data || {};
  if (creditType !== "regular") throw new HttpsError("invalid-argument", "Weekly booking is for 50-min lessons.");
  const list = [...new Set((Array.isArray(startISOs) ? startISOs : []).map(String))]
    .map((x) => new Date(x)).filter((d) => !isNaN(d.getTime())).sort((a, b) => a - b);
  if (!list.length || list.length > CUSTOM_MAX) throw new HttpsError("invalid-argument", `Choose 1–${CUSTOM_MAX} lessons.`);
  const results = [], booked = [];
  for (const start of list) {
    try {
      const r = await bookOne(c, tutorId, "regular", start, studentTZ);
      results.push({ startISO: start.toISOString(), ok: true, bookingId: r.bookingId });
      booked.push(r.bookingId);
    } catch (e) {
      results.push({ startISO: start.toISOString(), ok: false, error: (e && e.message) || String(e) });
    }
  }
  const docs = [];
  for (const id of booked) { await upsertLessonEvent(id); const b = await getBooking(id); if (b) docs.push(b); }
  await mailBookings("booked", docs);
  return { results, booked: booked.length };
}, { secrets: [...MAIL_SECRETS, ...OAUTH_SECRETS], timeoutSeconds: 300 });

async function getBooking(id) {
  const s = await db.doc(`bookings/${id}`).get();
  return s.exists ? { id: s.id, ...s.data() } : null;
}

/* ═════════════ rescheduleLesson ═════════════ */
exports.rescheduleLesson = call(async (req) => {
  const c = await caller(req);
  const { bookingId, startISO } = req.data || {};
  const start = new Date(startISO);
  if (!bookingId || isNaN(start.getTime())) throw new HttpsError("invalid-argument", "Invalid request.");
  if (start.getTime() < Date.now() + LEAD) {
    throw new HttpsError("failed-precondition", "The new time must be at least 12 hours from now.");
  }
  const bRef = db.doc(`bookings/${bookingId}`);
  const pre = await bRef.get();
  if (!pre.exists) throw new HttpsError("not-found", "Lesson not found.");
  const b0 = pre.data();
  const oldStart = b0.startAt.toDate();
  const dur = b0.durationMin || DURATION[b0.creditType] || 50;
  const end = new Date(start.getTime() + dur * 60000);
  if (await calendarConflict(b0.tutorId, start.getTime(), end.getTime())) {
    throw new HttpsError("failed-precondition", "The tutor is not available at this time. Please choose another slot.");
  }
  const res = await db.runTransaction(async (tx) => {
    const bSnap = await tx.get(bRef);
    const b = bSnap.data();
    const mgr = isManager(c, b.tutorId);
    if (!mgr && b.studentEmail !== c.email) throw new HttpsError("permission-denied", "Not allowed.");
    if (b.status !== "reserved") throw new HttpsError("failed-precondition", "Only booked lessons can be changed.");
    if (!mgr && b.startAt.toMillis() - Date.now() < LEAD) {
      throw new HttpsError("failed-precondition", "Lessons can be changed up to 12 hours before start.");
    }
    if (b.startAt.toMillis() === start.getTime()) throw new HttpsError("invalid-argument", "Please choose a different time.");
    const oldSlot = `${b.tutorId}_${b.startAt.toMillis()}`;
    const { k } = await checkSlot(tx, b.tutorId, start, end, dur, oldSlot);
    const oSnap = await tx.get(db.doc(`orders/${b.orderId}`));
    if (oSnap.exists && oSnap.data().expiresAt && oSnap.data().expiresAt.toMillis() <= start.getTime()) {
      throw new HttpsError("failed-precondition", "Your credit expires before this date.");
    }
    tx.update(bRef, { startAt: Timestamp.fromDate(start), endAt: Timestamp.fromDate(end), kstDate: k.ymd, kstTime: k.hm,
      rescheduledFrom: `${b.kstDate} ${b.kstTime}`, rescheduledAt: FieldValue.serverTimestamp(), rescheduledBy: c.email });
    tx.delete(db.doc(`busySlots/${oldSlot}`));
    tx.set(db.doc(`busySlots/${b.tutorId}_${start.getTime()}`), { tutorId: b.tutorId, bookingId, startAt: Timestamp.fromDate(start), endAt: Timestamp.fromDate(end) });
    tx.set(logRef(), logData({ studentEmail: b.studentEmail, tutorId: b.tutorId, orderId: b.orderId, bookingId, type: "reschedule",
      delta: 0, creditType: b.creditType, note: `${b.kstDate} ${b.kstTime} → ${k.ymd} ${k.hm} KST · by ${c.email}` }));
    return { ok: true };
  });
  await upsertLessonEvent(bookingId);   // 튜터 캘린더 일정도 같이 이동
  const b = await getBooking(bookingId);
  if (b) await mailBookings("rescheduled", [b], { oldStart, by: c });
  return res;
}, { secrets: [...MAIL_SECRETS, ...OAUTH_SECRETS] });

/* ═════════════ cancelLesson ═════════════ */
exports.cancelLesson = call(async (req) => {
  const c = await caller(req);
  const { bookingId } = req.data || {};
  const bRef = db.doc(`bookings/${bookingId || "_"}`);
  let toRemove = null;
  const res = await db.runTransaction(async (tx) => {
    const bSnap = await tx.get(bRef);
    if (!bSnap.exists) throw new HttpsError("not-found", "Lesson not found.");
    const b = bSnap.data();
    toRemove = b;
    const mgr = isManager(c, b.tutorId);
    const own = b.studentEmail === c.email;
    if (!mgr && !own) throw new HttpsError("permission-denied", "Not allowed.");
    if (b.status !== "reserved") throw new HttpsError("failed-precondition", "Only booked lessons can be cancelled.");
    if (!mgr && b.startAt.toMillis() - Date.now() < DAY) {
      throw new HttpsError("failed-precondition", "Lessons can be cancelled up to 24 hours before start.");
    }
    const oRef = db.doc(`orders/${b.orderId}`);
    const oSnap = await tx.get(oRef);
    tx.update(bRef, { status: "cancelled", cancelledAt: FieldValue.serverTimestamp(), cancelledBy: c.email });
    tx.delete(db.doc(`busySlots/${b.tutorId}_${b.startAt.toMillis()}`));
    if (oSnap.exists) {
      const o = oSnap.data();
      const upd = { reserved: FieldValue.increment(-1) };
      if (o.status === "expired") upd.expiredCredits = FieldValue.increment(1); // 이미 만료된 수강권이면 복원 대신 만료 처리
      tx.update(oRef, upd);
      tx.set(logRef(), logData({ studentEmail: b.studentEmail, tutorId: b.tutorId, orderId: b.orderId, bookingId,
        type: o.status === "expired" ? "expire" : "release", delta: o.status === "expired" ? 0 : 1,
        creditType: b.creditType, note: `${b.kstDate} ${b.kstTime} KST · by ${c.email}` }));
    }
    return { ok: true };
  });
  await deleteLessonEvent(toRemove);   // 튜터 캘린더 일정도 삭제
  if (toRemove) await mailBookings("cancelled", [{ id: bookingId, ...toRemove }], { by: c });
  return res;
}, { secrets: [...MAIL_SECRETS, ...OAUTH_SECRETS] });

/* ═════════════ setMeetLink ═════════════
 * 튜터가 선택한 예약에 Meet 링크를 저장하고, 튜터 캘린더 일정에도 같이 반영합니다.
 */
exports.setMeetLink = call(async (req) => {
  const c = await caller(req);
  const { bookingIds, link } = req.data || {};
  const ids = Array.isArray(bookingIds) ? bookingIds.filter(Boolean).slice(0, 200) : [];
  const url = String(link || "").trim().slice(0, 500);
  if (!ids.length) throw new HttpsError("invalid-argument", "Select at least one lesson.");
  if (url && !/^https:\/\//i.test(url)) throw new HttpsError("invalid-argument", "The link must start with https://");

  const snaps = await db.getAll(...ids.map((id) => db.doc(`bookings/${id}`)));
  const batch = db.batch();
  let n = 0;
  for (const s of snaps) {
    if (!s.exists) continue;
    if (!isManager(c, s.data().tutorId)) throw new HttpsError("permission-denied", "Not allowed.");
    batch.update(s.ref, { meetLink: url });
    n++;
  }
  if (!n) throw new HttpsError("not-found", "No lessons found.");
  await batch.commit();
  for (const s of snaps) if (s.exists) await upsertLessonEvent(s.id, { keepLink: true });
  return { ok: true, count: n };
}, { secrets: OAUTH_SECRETS });

/* ═════════════ setMemberId ═════════════
 * 관리자가 회원 표시 ID를 지정합니다. 튜터 화면에서 이메일 대신 이 ID가 보이도록
 * 기존 결제·예약 문서에도 함께 반영합니다.
 */
exports.setMemberId = call(async (req) => {
  const c = await caller(req);
  if (c.role !== "admin") throw new HttpsError("permission-denied", "Admin only.");
  const email = String((req.data || {}).email || "").toLowerCase().trim();
  const raw = String((req.data || {}).displayId || "").trim().slice(0, 30);
  if (!email) throw new HttpsError("invalid-argument", "email required.");
  if (raw && !/^[\w가-힣][\w가-힣 .\-]{0,29}$/.test(raw)) {
    throw new HttpsError("invalid-argument", "ID must be 1–30 characters (letters, numbers, spaces, . -).");
  }
  if (raw) {
    const dup = await db.collection("roles").where("displayId", "==", raw).get();
    if (dup.docs.some((d) => d.id !== email)) throw new HttpsError("already-exists", `The ID "${raw}" is already in use.`);
  }
  const displayId = raw || null;
  await db.doc(`roles/${email}`).set({ email, displayId }, { merge: true });

  let updated = 0;
  for (const col of ["orders", "bookings"]) {
    const q = await db.collection(col).where("studentEmail", "==", email).get();
    for (let i = 0; i < q.docs.length; i += 400) {
      const batch = db.batch();
      q.docs.slice(i, i + 400).forEach((d) => batch.update(d.ref, { studentId: displayId }));
      await batch.commit();
      updated += Math.min(400, q.docs.length - i);
    }
  }
  return { ok: true, displayId, updated };
});

/* ═════════════ submitReview ═════════════ */
exports.submitReview = call(async (req) => {
  const c = await caller(req);
  const { tutorId, rating, text } = req.data || {};
  const r = Math.round(num(rating, 0));
  if (!tutorId || r < 1 || r > 5) throw new HttpsError("invalid-argument", "Rating must be 1–5.");
  const done = await db.collection("bookings").where("studentEmail", "==", c.email)
    .where("tutorId", "==", tutorId).where("status", "==", "completed").limit(1).get();
  if (done.empty) throw new HttpsError("failed-precondition", "You can review after completing a lesson with this tutor.");

  const parts = c.name.trim().split(/\s+/);
  const display = parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0];
  const revRef = db.doc(`tutors/${tutorId}/reviews/${c.uid}`);
  const prev = await revRef.get();
  await revRef.set({
    rating: r, text: String(text || "").slice(0, 1000), name: display,
    createdAt: prev.exists ? prev.data().createdAt : FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  const all = await db.collection(`tutors/${tutorId}/reviews`).get();
  const sum = all.docs.reduce((s, d) => s + num(d.data().rating, 0), 0);
  await db.doc(`tutors/${tutorId}`).update({ rating: all.size ? r2(sum / all.size) : 0, reviewCount: all.size });
  return { ok: true };
});

/* ═════════════ processCredits (10분마다) ═════════════ */
exports.processCredits = onSchedule({ schedule: "every 10 minutes", timeZone: "Asia/Seoul", retryCount: 3 }, async () => {
  const now = Timestamp.now();
  let consumed = 0, expired = 0, removed = 0;

  // ① 종료된 수업 → 사용 완료 (최종 차감)
  const due = await db.collection("bookings").where("status", "==", "reserved").where("endAt", "<=", now).limit(400).get();
  for (const d of due.docs) {
    try {
      await db.runTransaction(async (tx) => {
        const b = await tx.get(d.ref);
        if (!b.exists || b.data().status !== "reserved") return; // 이미 처리됨 → 이중 차감 방지
        const bo = b.data();
        const oRef = db.doc(`orders/${bo.orderId}`);
        const o = await tx.get(oRef);
        tx.update(d.ref, { status: "completed", completedAt: FieldValue.serverTimestamp() });
        if (o.exists) tx.update(oRef, { reserved: FieldValue.increment(-1), used: FieldValue.increment(1) });
        tx.set(logRef(), logData({ studentEmail: bo.studentEmail, tutorId: bo.tutorId, orderId: bo.orderId, bookingId: d.id,
          type: "consume", delta: 0, creditType: bo.creditType, note: `${bo.kstDate} ${bo.kstTime} KST` }));
      });
      consumed++;
    } catch (e) { logger.error("consume failed", d.id, e); }
  }

  // ② 유효기간 만료
  const exp = await db.collection("orders").where("status", "==", "paid").where("expiresAt", "<=", now).limit(400).get();
  for (const d of exp.docs) {
    try {
      await db.runTransaction(async (tx) => {
        const s = await tx.get(d.ref);
        if (!s.exists || s.data().status !== "paid") return;
        const o = s.data();
        const remain = Math.max(0, o.credits - (o.used || 0) - (o.reserved || 0));
        tx.update(d.ref, { status: "expired", expiredCredits: remain, expiredAt: FieldValue.serverTimestamp() });
        tx.set(logRef(), logData({ studentEmail: o.studentEmail, tutorId: o.tutorId, orderId: d.id, type: "expire",
          delta: -remain, creditType: o.creditType, note: `${o.package}` }));
      });
      expired++;
    } catch (e) { logger.error("expire failed", d.id, e); }
  }

  // ③ 7일 지난 자료 삭제
  const mats = await db.collection("materials").where("expiresAt", "<=", now).limit(200).get();
  const bucket = getStorage().bucket();
  for (const d of mats.docs) {
    try {
      const m = d.data();
      if (m.storagePath) await bucket.file(m.storagePath).delete({ ignoreNotFound: true });
      await d.ref.delete();
      removed++;
    } catch (e) { logger.error("material delete failed", d.id, e); }
  }

  // ④ 지난 예약 슬롯 정리 (1일 경과)
  const old = await db.collection("busySlots").where("endAt", "<=", Timestamp.fromMillis(Date.now() - DAY)).limit(400).get();
  if (!old.empty) {
    const batch = db.batch();
    old.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
  // ⑥ 30일 지난 채팅 메시지 + 첨부 파일 삭제
  let chatRemoved = 0;
  try {
    const oldMsgs = await db.collection("chatMessages").where("expireAt", "<=", now).limit(400).get();
    for (const d of oldMsgs.docs) {
      try {
        const f = d.data().file;
        if (f && f.path) await bucket.file(f.path).delete({ ignoreNotFound: true });
        await d.ref.delete();
        chatRemoved++;
      } catch (e) { logger.error("chat message delete failed", d.id, e); }
    }
  } catch (e) { logger.error("chat cleanup failed", e); }

  // ⑤ Google 캘린더 동기화 (캘린더 ID를 등록한 튜터만)
  let synced = 0;
  const privs = await db.collection("tutorPrivate").get();
  for (const d of privs.docs) {
    if (!(d.data().calendarIds || []).length) continue;
    try { await syncTutorCalendar(d.id); synced++; } catch (e) { logger.error("calendar sync failed", d.id, e); }
  }
  logger.info(`processCredits: consumed=${consumed} expired=${expired} materialsRemoved=${removed} slotsCleaned=${old.size} calendarsSynced=${synced} chatRemoved=${chatRemoved}`);
});

/* ═══════════════════════════════════════════════════════════════════
 *  이메일 (Gmail 앱 비밀번호로 서버에서 발송 · 한국어 + 영어)
 *  - 발송에 실패해도 신청·예약·변경·취소 자체는 그대로 성공합니다.
 * ═══════════════════════════════════════════════════════════════════ */
let mailer = null;
function mailPass() { try { return GMAIL_APP_PASSWORD.value() || ""; } catch (e) { return ""; } }
async function sendMail({ to, replyTo, subject, html }) {
  const pass = mailPass();
  if (!to) return;
  if (!pass || pass === "none") { logger.info("mail skipped (GMAIL_APP_PASSWORD not set)", subject, to); return; }
  try {
    if (!mailer) mailer = nodemailer.createTransport({ service: "gmail", auth: { user: MAIL_FROM, pass } });
    await mailer.sendMail({
      from: `"All About Korea" <${MAIL_FROM}>`, to, replyTo: replyTo || undefined, subject, html,
      text: html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|h2|h3|li)>/gi, "\n").replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'").replace(/\n{3,}/g, "\n\n").trim(),
    });
  } catch (e) { logger.error("mail send failed", subject, to, e.message); }
}
const h = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (x) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[x]));
const usd = (n) => "$" + r2(Number(n || 0)).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + " USD";
function fmtAt(date, tz, lang) {
  const opts = { weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false };
  let zone = tz || "Asia/Seoul";
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(date); } catch (e) { zone = "UTC"; }
  return new Intl.DateTimeFormat(lang === "ko" ? "ko-KR" : "en-US", { ...opts, timeZone: zone }).format(date) + ` (${zone})`;
}
const toD = (x) => (x && x.toDate ? x.toDate() : (x instanceof Date ? x : new Date(x)));
const tbl = (rows) => `<table style="border-collapse:collapse;margin:10px 0;font-size:14px">${rows.filter(Boolean).map(([k, v]) =>
  `<tr><td style="padding:5px 14px 5px 0;color:#64748b;white-space:nowrap;vertical-align:top">${h(k)}</td><td style="padding:5px 0;font-weight:600;color:#0f172a">${v}</td></tr>`).join("")}</table>`;
const btn = (url, label) => `<p style="margin:16px 0"><a href="${h(url)}" style="background:#16a34a;color:#fff;text-decoration:none;padding:10px 18px;border-radius:10px;font-weight:700;display:inline-block">${h(label)}</a></p>`;
function wrap(first, second) {
  const box = (x) => `<div style="padding:4px 0">${x}</div>`;
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Noto Sans KR',Arial,sans-serif;max-width:620px;margin:0 auto;color:#0f172a;line-height:1.6">
  <div style="background:#16a34a;color:#fff;padding:14px 20px;border-radius:14px 14px 0 0;font-weight:800;font-size:15px">All About Korea · 1:1 Korean Tutoring</div>
  <div style="border:1px solid #e2e8f0;border-top:0;padding:20px;border-radius:0 0 14px 14px;font-size:14px">
    ${box(first)}<hr style="border:0;border-top:1px dashed #cbd5e1;margin:22px 0">${box(second)}
  </div>
  <p style="font-size:11px;color:#94a3b8;text-align:center;margin-top:12px">All About Korea · businesskorean.com</p></div>`;
}
const tutorCache = new Map();
async function tutorDoc(tid) {
  if (tutorCache.has(tid)) return tutorCache.get(tid);
  const s = await db.doc(`tutors/${tid}`).get();
  const t = s.exists ? s.data() : {};
  tutorCache.set(tid, t);
  return t;
}
const tutorMail = (t) => String((t && t.email) || OWNER_EMAIL).toLowerCase();
function pkgLabels(o) {
  const n = o.credits;
  return ({
    trial: ["25분 체험 수업", "25-Min Trial Lesson"],
    single: ["50분 단건 수업", "50-Min Single Lesson"],
    pack5: [`맞춤 패키지 (${n}회)`, `Custom Pack (${n} lessons)`],
    pack10: [`${n}회 패키지 · 4주 집중 과정`, `${n}-Lesson Pack · 4-Week Intensive Course`],
  })[o.package] || [`${n}회 수강권`, `${n}-lesson plan`];
}

/* ── 수강 신청 (Buy Plans) ── */
async function mailOrderCreated(o, tutor) {
  const [ko, en] = pkgLabels(o);
  const tName = (tutor && tutor.name) || o.tutorName || o.tutorId;
  const tEmail = tutorMail(tutor);
  const sName = o.studentName || o.studentEmail.split("@")[0];
  const sLabel = `${h(sName)} &lt;${h(o.studentEmail)}&gt;${o.studentId ? ` · ID ${h(o.studentId)}` : ""}`;
  const priceKo = o.listPrice !== o.price ? `${usd(o.price)} <span style="color:#94a3b8;text-decoration:line-through;font-weight:400">${usd(o.listPrice)}</span>` : usd(o.price);

  // 튜터에게: 누가 어떤 패키지를 얼마에 신청했는지
  await sendMail({
    to: tEmail, replyTo: o.studentEmail,
    subject: `[All About Korea] 새 수강 신청 / New plan request — ${sName} · ${ko}`,
    html: wrap(
      `<h2 style="margin:0 0 6px;font-size:18px">새 수강 신청이 들어왔습니다 📩</h2>
       ${tbl([["학생", sLabel], ["수강권", h(ko)], ["수업 횟수", `${o.credits}회`], ["결제 금액", priceKo],
              ["유효기간", `결제 확인 후 ${o.validDays}일`], ["신청 번호", h(o.id)]])}
       <p><b>24시간 이내</b>에 학생에게 <b>WISE 결제 링크</b>를 이메일로 보내 주세요.
       입금이 확인되면 튜터 화면 → <b>결제 요청</b>에서 <b>결제 확인</b>을 눌러 주세요. 그때 학생에게 수업권이 지급됩니다.</p>
       <p style="color:#64748b;font-size:12px">이 메일에 답장하면 학생에게 바로 전달됩니다.</p>
       ${btn(TUTOR_PAGE, "튜터 화면 열기")}`,
      `<h2 style="margin:0 0 6px;font-size:18px">New plan request 📩</h2>
       ${tbl([["Student", sLabel], ["Plan", h(en)], ["Lessons", String(o.credits)], ["Amount", priceKo],
              ["Validity", `${o.validDays} days after payment`], ["Request ID", h(o.id)]])}
       <p>Please send the student a <b>WISE payment link</b> by email <b>within 24 hours</b>.
       Once the payment arrives, click <b>Confirm payment</b> in your tutor console → <b>Payments</b> to release the credits.</p>
       <p style="color:#64748b;font-size:12px">Reply to this email to contact the student directly.</p>`),
  });

  // 학생에게: 친절한 접수 안내 + WISE 결제 링크 안내 + 튜터 이메일
  await sendMail({
    to: o.studentEmail, replyTo: tEmail,
    subject: `[All About Korea] Your plan request was received / 수강 신청이 접수되었습니다 — ${en}`,
    html: wrap(
      `<h2 style="margin:0 0 6px;font-size:18px">Hi ${h(sName)}, thank you! 😊</h2>
       <p>Your request for <b>${h(en)}</b> with <b>${h(tName)}</b> has been received. We're so happy you're learning Korean with us!</p>
       ${tbl([["Plan", h(en)], ["Lessons", String(o.credits)], ["Amount", usd(o.price)], ["Validity", `${o.validDays} days from payment`]])}
       <p><b>What happens next?</b><br>
       Within <b>24 hours</b>, your tutor will email you a <b>WISE payment link</b>. When you receive it, simply follow the instructions in the link to complete your payment.
       Your lesson credits will be added as soon as the payment is confirmed — then you can book your lessons right away.</p>
       <p>If you have any questions about the payment, please feel free to email your tutor directly at
       <a href="mailto:${h(tEmail)}">${h(tEmail)}</a> (or just reply to this email). We'll be glad to help!</p>
       ${btn(TUTOR_PAGE, "Go to My Dashboard")}
       <p>See you in class soon! 🇰🇷</p>`,
      `<h2 style="margin:0 0 6px;font-size:18px">${h(sName)}님, 감사합니다! 😊</h2>
       <p><b>${h(tName)}</b> 선생님과의 <b>${h(ko)}</b> 수강 신청이 잘 접수되었습니다. 함께 한국어를 공부하게 되어 정말 기뻐요!</p>
       ${tbl([["수강권", h(ko)], ["수업 횟수", `${o.credits}회`], ["결제 금액", usd(o.price)], ["유효기간", `결제 확인 후 ${o.validDays}일`]])}
       <p><b>다음 단계 안내</b><br>
       <b>24시간 이내</b>에 선생님이 <b>WISE 결제 링크</b>를 이메일로 보내 드릴 예정입니다. 링크를 받으시면 안내에 따라 입금해 주세요.
       결제가 확인되는 대로 수업권이 지급되고, 바로 수업을 예약하실 수 있습니다.</p>
       <p>결제와 관련해 궁금한 점이 있으시면 선생님 이메일 <a href="mailto:${h(tEmail)}">${h(tEmail)}</a>로 언제든 편하게 문의해 주세요 (이 메일에 답장하셔도 됩니다).</p>
       <p>곧 수업에서 만나요! 🇰🇷</p>`),
  });
}

/* ── 예약 / 변경 / 취소 ── */
async function mailBookings(kind, list, extra = {}) {
  if (!list || !list.length) return;
  const b0 = list[0];
  const tutor = await tutorDoc(b0.tutorId);
  const tName = tutor.name || b0.tutorName || b0.tutorId;
  const tEmail = tutorMail(tutor);
  const sName = b0.studentName || String(b0.studentEmail).split("@")[0];
  const sLabel = b0.studentId || sName;
  const tz = b0.studentTZ || "UTC";
  const typeKo = (b) => (b.creditType === "trial" ? "체험 25분" : "정규 50분");
  const typeEn = (b) => (b.creditType === "trial" ? "25-min trial" : "50-min lesson");
  const meet = (b) => (b.meetLink ? `<a href="${h(b.meetLink)}">${h(b.meetLink)}</a>` : "");
  const byStudent = extra.by && extra.by.email === String(b0.studentEmail).toLowerCase();
  const n = list.length;
  const sorted = [...list].sort((a, b) => toD(a.startAt) - toD(b.startAt));
  const lineStu = (b, lang) => `<li style="margin:4px 0"><b>${h(fmtAt(toD(b.startAt), tz, lang))}</b><br><span style="color:#64748b;font-size:12px">${h(fmtAt(toD(b.startAt), "Asia/Seoul", lang))} · ${h(lang === "ko" ? typeKo(b) : typeEn(b))}</span>${b.meetLink ? `<br><span style="font-size:12px">Google Meet: ${meet(b)}</span>` : ""}</li>`;
  const lineTut = (b, lang) => `<li style="margin:4px 0"><b>${h(fmtAt(toD(b.startAt), "Asia/Seoul", lang))}</b> · ${h(lang === "ko" ? typeKo(b) : typeEn(b))}<br><span style="color:#64748b;font-size:12px">${lang === "ko" ? "학생 현지" : "Student local"}: ${h(fmtAt(toD(b.startAt), tz, lang))}</span>${b.meetLink ? `<br><span style="font-size:12px">Meet: ${meet(b)}</span>` : ""}</li>`;
  const ul = (fn, lang) => `<ul style="padding-left:18px;margin:8px 0">${sorted.map((b) => fn(b, lang)).join("")}</ul>`;
  const policyEn = "You can cancel up to 24 hours and reschedule up to 12 hours before each lesson.";
  const policyKo = "수업 시작 24시간 전까지 취소, 12시간 전까지 시간 변경이 가능합니다.";
  let sub, stuEn, stuKo, tutKo, tutEn;

  if (kind === "booked") {
    sub = [`수업 예약 완료 / Lesson booked${n > 1 ? ` ×${n}` : ""}`, `새 수업 예약 / New booking${n > 1 ? ` ×${n}` : ""}`];
    stuEn = `<h2 style="margin:0 0 6px;font-size:18px">Your lesson${n > 1 ? "s are" : " is"} booked! 🎉</h2>
      <p>Hi ${h(sName)}, here ${n > 1 ? `are your ${n} lessons` : "is your lesson"} with <b>${h(tName)}</b>:</p>${ul(lineStu, "en")}
      <p style="font-size:13px;color:#475569">${policyEn}</p>${btn(TUTOR_PAGE, "Open My Dashboard")}`;
    stuKo = `<h2 style="margin:0 0 6px;font-size:18px">수업 예약이 완료되었습니다 🎉</h2>
      <p>${h(sName)}님, <b>${h(tName)}</b> 선생님과의 수업${n > 1 ? ` ${n}건` : ""}이 예약되었습니다.</p>${ul(lineStu, "ko")}
      <p style="font-size:13px;color:#475569">${policyKo}</p>`;
    tutKo = `<h2 style="margin:0 0 6px;font-size:18px">새 수업 예약 📅</h2>
      <p><b>${h(sLabel)}</b> (${h(b0.studentEmail)}) 학생이 수업${n > 1 ? ` ${n}건` : ""}을 예약했습니다.</p>${ul(lineTut, "ko")}${btn(TUTOR_PAGE, "튜터 화면 열기")}`;
    tutEn = `<h2 style="margin:0 0 6px;font-size:18px">New booking 📅</h2>
      <p><b>${h(sLabel)}</b> (${h(b0.studentEmail)}) booked ${n > 1 ? `${n} lessons` : "a lesson"}:</p>${ul(lineTut, "en")}`;
  } else if (kind === "rescheduled") {
    const b = b0, oldS = extra.oldStart;
    const who = byStudent ? ["학생", "the student"] : ["튜터", "the tutor"];
    sub = ["수업 시간 변경 / Lesson rescheduled", "수업 시간 변경 / Lesson rescheduled"];
    const rowsStu = (lang) => tbl([
      [lang === "ko" ? "이전 시간" : "Original time", `<s style="color:#94a3b8">${h(fmtAt(oldS, tz, lang))}</s>`],
      [lang === "ko" ? "변경된 시간" : "New time", `${h(fmtAt(toD(b.startAt), tz, lang))}<br><span style="color:#64748b;font-size:12px;font-weight:400">${h(fmtAt(toD(b.startAt), "Asia/Seoul", lang))}</span>`],
      [lang === "ko" ? "수업" : "Lesson", h(lang === "ko" ? typeKo(b) : typeEn(b))],
      b.meetLink ? ["Google Meet", meet(b)] : null]);
    const rowsTut = (lang) => tbl([
      [lang === "ko" ? "학생" : "Student", `${h(sLabel)} (${h(b.studentEmail)})`],
      [lang === "ko" ? "이전 시간" : "Original time", `<s style="color:#94a3b8">${h(fmtAt(oldS, "Asia/Seoul", lang))}</s>`],
      [lang === "ko" ? "변경된 시간" : "New time", `${h(fmtAt(toD(b.startAt), "Asia/Seoul", lang))}<br><span style="color:#64748b;font-size:12px;font-weight:400">${lang === "ko" ? "학생 현지" : "Student local"}: ${h(fmtAt(toD(b.startAt), tz, lang))}</span>`],
      [lang === "ko" ? "수업" : "Lesson", h(lang === "ko" ? typeKo(b) : typeEn(b))]]);
    stuEn = `<h2 style="margin:0 0 6px;font-size:18px">Your lesson time has changed 🔄</h2><p>Your lesson with <b>${h(tName)}</b> was rescheduled by ${who[1]}.</p>${rowsStu("en")}${btn(TUTOR_PAGE, "Open My Dashboard")}`;
    stuKo = `<h2 style="margin:0 0 6px;font-size:18px">수업 시간이 변경되었습니다 🔄</h2><p><b>${h(tName)}</b> 선생님과의 수업 시간이 ${who[0]}에 의해 변경되었습니다.</p>${rowsStu("ko")}`;
    tutKo = `<h2 style="margin:0 0 6px;font-size:18px">수업 시간 변경 🔄</h2><p>${who[0]}이(가) 수업 시간을 변경했습니다.</p>${rowsTut("ko")}${btn(TUTOR_PAGE, "튜터 화면 열기")}`;
    tutEn = `<h2 style="margin:0 0 6px;font-size:18px">Lesson rescheduled 🔄</h2><p>The lesson was rescheduled by ${who[1]}.</p>${rowsTut("en")}`;
  } else if (kind === "cancelled") {
    const b = b0;
    const who = byStudent ? ["학생", "the student"] : ["튜터", "the tutor"];
    sub = ["수업 취소 / Lesson cancelled", "수업 취소 / Lesson cancelled"];
    const rows = (lang, zone) => tbl([
      [lang === "ko" ? "취소된 수업" : "Cancelled lesson", `<s style="color:#94a3b8">${h(fmtAt(toD(b.startAt), zone, lang))}</s>`],
      [lang === "ko" ? "수업" : "Lesson", h(lang === "ko" ? typeKo(b) : typeEn(b))],
      [lang === "ko" ? "취소한 사람" : "Cancelled by", lang === "ko" ? who[0] : who[1]]]);
    stuEn = `<h2 style="margin:0 0 6px;font-size:18px">Lesson cancelled</h2><p>Your lesson with <b>${h(tName)}</b> has been cancelled.</p>${rows("en", tz)}
      <p style="font-size:13px;color:#475569">The credit used for this lesson has been returned to your plan (within its validity period), so you can book another time.</p>${btn(TUTOR_PAGE, "Book another time")}`;
    stuKo = `<h2 style="margin:0 0 6px;font-size:18px">수업이 취소되었습니다</h2><p><b>${h(tName)}</b> 선생님과의 수업이 취소되었습니다.</p>${rows("ko", tz)}
      <p style="font-size:13px;color:#475569">이 수업에 사용된 수업권은 다시 사용할 수 있도록 복원되었습니다 (수강권 유효기간 내). 다른 시간으로 다시 예약해 주세요.</p>`;
    tutKo = `<h2 style="margin:0 0 6px;font-size:18px">수업 취소</h2><p><b>${h(sLabel)}</b> (${h(b.studentEmail)}) 학생의 수업이 취소되었습니다.</p>${rows("ko", "Asia/Seoul")}${btn(TUTOR_PAGE, "튜터 화면 열기")}`;
    tutEn = `<h2 style="margin:0 0 6px;font-size:18px">Lesson cancelled</h2><p>The lesson with <b>${h(sLabel)}</b> (${h(b.studentEmail)}) was cancelled.</p>${rows("en", "Asia/Seoul")}`;
  } else return;

  await sendMail({ to: b0.studentEmail, replyTo: tEmail, subject: `[All About Korea] ${sub[0]}`, html: wrap(stuEn, stuKo) });
  await sendMail({ to: tEmail, replyTo: b0.studentEmail, subject: `[All About Korea] ${sub[1]} — ${sLabel}`, html: wrap(tutKo, tutEn) });
}

/* ── 읽지 않은 채팅 알림 ── */
async function mailChatDigest(to, side, names) {
  const list = `<ul style="padding-left:18px">${names.map((x) => `<li>${h(x)}</li>`).join("")}</ul>`;
  if (side === "Tutor") {
    await sendMail({ to, subject: "[All About Korea] 읽지 않은 메시지 / Unread messages",
      html: wrap(`<h2 style="margin:0 0 6px;font-size:18px">읽지 않은 메시지가 있습니다 💬</h2><p>아래 학생이 보낸 메시지를 24시간 넘게 확인하지 않았습니다.</p>${list}${btn(TUTOR_PAGE, "메시지 확인하기")}`,
                 `<h2 style="margin:0 0 6px;font-size:18px">You have unread messages 💬</h2><p>Messages from these students have been unread for over 24 hours:</p>${list}`) });
  } else {
    await sendMail({ to, subject: "[All About Korea] You have unread messages / 읽지 않은 메시지",
      html: wrap(`<h2 style="margin:0 0 6px;font-size:18px">You have unread messages 💬</h2><p>Your tutor sent you a message that has been unread for over 24 hours:</p>${list}${btn(TUTOR_PAGE, "Read messages")}`,
                 `<h2 style="margin:0 0 6px;font-size:18px">읽지 않은 메시지가 있습니다 💬</h2><p>선생님이 보낸 메시지를 24시간 넘게 확인하지 않으셨어요.</p>${list}`) });
  }
}

/* ═══════════════════════════════════════════════════════════════════
 *  Google 계정 연결 → 수업 예약 시 Google Meet 링크 자동 생성
 *  튜터가 한 번 "Google 계정 연결"을 허락하면, 이후 예약마다 튜터 기본 캘린더에 일정과 Meet 링크가 만들어집니다.
 *  (연결하지 않은 튜터는 기존 방식: 서비스 계정 캘린더 등록 + 직접 붙여 넣은 Meet 링크)
 * ═══════════════════════════════════════════════════════════════════ */
const secretVal = (s) => { try { return s.value() || ""; } catch (e) { return ""; } };
const oauthOk = () => { const id = secretVal(GOOGLE_OAUTH_CLIENT_ID); return !!id && id !== "none"; };
const gTokenCache = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function googleToken(tid) {
  const c = gTokenCache.get(tid);
  if (c && c.exp > Date.now() + 60000) return c.token;
  const ref = db.doc(`tutorSecrets/${tid}`);
  const sec = await ref.get();
  const rt = sec.exists && sec.data().refreshToken;
  if (!rt) return null;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: secretVal(GOOGLE_OAUTH_CLIENT_ID), client_secret: secretVal(GOOGLE_OAUTH_CLIENT_SECRET),
      refresh_token: rt, grant_type: "refresh_token" }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (j.error === "invalid_grant") {
      await ref.update({ refreshToken: FieldValue.delete() }).catch(() => {});
      await db.doc(`tutorPrivate/${tid}`).set({ googleMeet: { connected: false, error: "Google 연결이 만료되었습니다. 다시 연결해 주세요.", at: FieldValue.serverTimestamp() } }, { merge: true });
    }
    throw new Error("Google token refresh failed: " + (j.error || r.status));
  }
  gTokenCache.set(tid, { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 });
  return j.access_token;
}
async function gcal(tid, method, path, data) {
  const token = await googleToken(tid);
  if (!token) return null;
  const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: data ? JSON.stringify(data) : undefined,
  });
  if (method === "DELETE") { if (!r.ok && r.status !== 404 && r.status !== 410) throw new Error("HTTP " + r.status); return {}; }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || ("HTTP " + r.status));
  return j;
}
async function meetUpsert(bRef, b, opts = {}) {
  if (!oauthOk()) return false;
  const sec = await db.doc(`tutorSecrets/${b.tutorId}`).get();
  if (!sec.exists || !sec.data().refreshToken) return false;
  try {
    const base = lessonEventBody({ ...b, meetLink: opts.keepLink ? b.meetLink : "" }, { bookingId: bRef.id });
    delete base.location;
    base.attendees = [{ email: b.studentEmail }];
    let ev;
    if (b.gEventId) {
      ev = await gcal(b.tutorId, "PATCH", `/${encodeURIComponent(b.gEventId)}?conferenceDataVersion=1&sendUpdates=none`,
        { summary: base.summary, description: base.description, start: base.start, end: base.end, attendees: base.attendees });
    } else {
      base.conferenceData = { createRequest: { requestId: `${bRef.id}-${Date.now()}`, conferenceSolutionKey: { type: "hangoutsMeet" } } };
      ev = await gcal(b.tutorId, "POST", "?conferenceDataVersion=1&sendUpdates=none", base);
    }
    if (!ev) return false;
    let link = ev.hangoutLink || "";
    for (let i = 0; !link && ev.id && i < 3; i++) {   // Meet 생성이 잠시 대기 상태일 수 있음
      await sleep(1200);
      const g = await gcal(b.tutorId, "GET", `/${encodeURIComponent(ev.id)}`);
      link = (g && g.hangoutLink) || "";
    }
    const upd = { gEventId: ev.id, calEventError: FieldValue.delete() };
    if (link && !(opts.keepLink && b.meetLink)) upd.meetLink = link;
    await bRef.update(upd);
    return true;
  } catch (e) {
    logger.warn("google meet event failed", bRef.id, e.message);
    await bRef.update({ calEventError: "Google Meet: " + String(e.message).slice(0, 200) }).catch(() => {});
    return false;
  }
}
async function meetDelete(b) {
  try { await gcal(b.tutorId, "DELETE", `/${encodeURIComponent(b.gEventId)}?sendUpdates=none`); }
  catch (e) { logger.warn("google meet event delete failed", e.message); }
}

exports.googleConnectStart = call(async (req) => {
  const c = await caller(req);
  const { tutorId } = req.data || {};
  if (!tutorId || !isManager(c, tutorId)) throw new HttpsError("permission-denied", "Not allowed.");
  if (!oauthOk()) throw new HttpsError("failed-precondition", "Google 계정 연결이 아직 설정되지 않았습니다. 관리자에게 문의하세요. (GOOGLE_OAUTH_CLIENT_ID)");
  const state = crypto.randomBytes(24).toString("hex");
  await db.doc(`tutorSecrets/${tutorId}`).set({ oauthState: state, oauthStateExp: Date.now() + 15 * 60000, oauthBy: c.email }, { merge: true });
  const p = new URLSearchParams({
    client_id: secretVal(GOOGLE_OAUTH_CLIENT_ID), redirect_uri: OAUTH_REDIRECT, response_type: "code",
    scope: "openid email https://www.googleapis.com/auth/calendar.events",
    access_type: "offline", prompt: "consent", include_granted_scopes: "true", state,
  });
  return { url: "https://accounts.google.com/o/oauth2/v2/auth?" + p.toString() };
}, { secrets: OAUTH_SECRETS });

exports.googleOAuthCallback = onRequest({ secrets: OAUTH_SECRETS }, async (req, res) => {
  const back = (q) => res.redirect(302, `${TUTOR_PAGE}?gcal=${q}`);
  try {
    if (req.query.error) return back("denied");
    const state = String(req.query.state || ""), code = String(req.query.code || "");
    if (!state || !code) return back("error");
    const q = await db.collection("tutorSecrets").where("oauthState", "==", state).limit(1).get();
    if (q.empty) return back("expired");
    const doc = q.docs[0], tid = doc.id;
    if (num(doc.data().oauthStateExp, 0) < Date.now()) return back("expired");
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: secretVal(GOOGLE_OAUTH_CLIENT_ID), client_secret: secretVal(GOOGLE_OAUTH_CLIENT_SECRET),
        redirect_uri: OAUTH_REDIRECT, grant_type: "authorization_code" }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.refresh_token) { logger.warn("oauth exchange failed", j.error || r.status); return back("error"); }
    let email = "";
    try { email = JSON.parse(Buffer.from(String(j.id_token || "").split(".")[1] || "", "base64url").toString()).email || ""; } catch (e) {}
    await doc.ref.set({ refreshToken: j.refresh_token, googleEmail: email, connectedAt: FieldValue.serverTimestamp(),
      oauthState: FieldValue.delete(), oauthStateExp: FieldValue.delete() }, { merge: true });
    gTokenCache.delete(tid);
    await db.doc(`tutorPrivate/${tid}`).set({ googleMeet: { connected: true, email, error: null, at: FieldValue.serverTimestamp() } }, { merge: true });
    return back("connected");
  } catch (e) {
    logger.error("oauth callback failed", e);
    return back("error");
  }
});

exports.googleDisconnect = call(async (req) => {
  const c = await caller(req);
  const { tutorId } = req.data || {};
  if (!tutorId || !isManager(c, tutorId)) throw new HttpsError("permission-denied", "Not allowed.");
  const ref = db.doc(`tutorSecrets/${tutorId}`);
  const s = await ref.get();
  const rt = s.exists && s.data().refreshToken;
  if (rt) { try { await fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(rt), { method: "POST" }); } catch (e) {} }
  await ref.set({ refreshToken: FieldValue.delete(), googleEmail: FieldValue.delete() }, { merge: true });
  gTokenCache.delete(tutorId);
  await db.doc(`tutorPrivate/${tutorId}`).set({ googleMeet: { connected: false, error: null, at: FieldValue.serverTimestamp() } }, { merge: true });
  return { ok: true };
});

/* ═══════════════════════════════════════════════════════════════════
 *  튜터 ↔ 학생 채팅
 *  채팅방(chats/{tutorId}__{studentEmail})은 서버만 만들고, 결제 대기·유효한 수강권·예정된 수업 중
 *  하나라도 있을 때만 열립니다. 메시지(chatMessages)와 첨부 파일(chat-files/)은 30일 후 자동 삭제됩니다.
 * ═══════════════════════════════════════════════════════════════════ */
async function chatRelation(tutorId, email) {
  const now = Date.now();
  const os = await db.collection("orders").where("studentEmail", "==", email).where("tutorId", "==", tutorId).get();
  const info = os.docs.map((d) => d.data());
  const ok = info.some((o) => o.status === "pending" || (o.status === "paid" && o.expiresAt && o.expiresAt.toMillis() > now));
  const named = info.find((o) => o.studentName || o.studentId) || {};
  if (ok) return { ok, name: named.studentName || "", sid: named.studentId || null };
  const bs = await db.collection("bookings").where("studentEmail", "==", email).where("tutorId", "==", tutorId)
    .where("status", "==", "reserved").get();
  const future = bs.docs.map((d) => d.data()).filter((b) => b.startAt.toMillis() > now);
  return { ok: future.length > 0, name: (future[0] && future[0].studentName) || named.studentName || "", sid: (future[0] && future[0].studentId) || named.studentId || null };
}

exports.openChat = call(async (req) => {
  const c = await caller(req);
  const d = req.data || {};
  const tutorId = String(d.tutorId || "").trim();
  if (!tutorId) throw new HttpsError("invalid-argument", "tutorId required.");
  let email;
  if (d.studentEmail) {
    if (!isManager(c, tutorId)) throw new HttpsError("permission-denied", "Not allowed.");
    email = String(d.studentEmail).toLowerCase().trim();
  } else email = c.email;
  const rel = await chatRelation(tutorId, email);
  if (!rel.ok) throw new HttpsError("failed-precondition", "Chat is available while there is a pending or active plan, or an upcoming lesson.");
  const id = `${tutorId}__${email}`;
  const ref = db.doc(`chats/${id}`);
  const snap = await ref.get();
  if (!snap.exists) {
    const t = await tutorDoc(tutorId);
    await ref.set({
      chatId: id, tutorId, tutorName: t.name || tutorId, studentEmail: email,
      studentName: rel.name || (email === c.email ? c.name : email.split("@")[0]), studentId: rel.sid || null,
      createdAt: FieldValue.serverTimestamp(), lastAt: null, lastText: "", lastFrom: "",
      firstUnreadForTutorAt: null, firstUnreadForStudentAt: null,
    });
  }
  return { chatId: id };
});

// 1시간마다: 24시간 넘게 읽지 않은 채팅이 있으면 알림 메일 (받는 사람당 하루 최대 1통)
exports.chatUnreadDigest = onSchedule({ schedule: "every 60 minutes", timeZone: "Asia/Seoul", secrets: MAIL_SECRETS }, async () => {
  const cutoff = Timestamp.fromMillis(Date.now() - DAY);
  const groups = new Map();
  for (const side of ["Tutor", "Student"]) {
    const q = await db.collection("chats").where(`firstUnreadFor${side}At`, "<=", cutoff).limit(300).get();
    for (const d of q.docs) {
      const ch = d.data();
      const first = ch[`firstUnreadFor${side}At`], notified = ch[`notified${side}At`];
      if (!first || (notified && notified.toMillis() >= first.toMillis())) continue;   // 이미 알린 묶음
      const to = side === "Tutor" ? tutorMail(await tutorDoc(ch.tutorId)) : ch.studentEmail;
      const key = `${side}|${to}`;
      if (!groups.has(key)) groups.set(key, { to, side, items: [] });
      groups.get(key).items.push({ ref: d.ref, name: side === "Tutor" ? (ch.studentId || ch.studentName || ch.studentEmail.split("@")[0]) : (ch.tutorName || ch.tutorId) });
    }
  }
  let sent = 0;
  for (const g of groups.values()) {
    const st = db.doc(`mailState/${g.to}`);
    const ss = await st.get();
    const last = ss.exists && ss.data()[`chatDigest${g.side}At`];
    if (last && last.toMillis() > Date.now() - DAY + 10 * 60000) continue;   // 하루 1통 제한
    await mailChatDigest(g.to, g.side, [...new Set(g.items.map((x) => x.name))]);
    const batch = db.batch();
    g.items.forEach((x) => batch.update(x.ref, { [`notified${g.side}At`]: FieldValue.serverTimestamp() }));
    batch.set(st, { [`chatDigest${g.side}At`]: FieldValue.serverTimestamp() }, { merge: true });
    await batch.commit();
    sent++;
  }
  logger.info(`chatUnreadDigest: groups=${groups.size} sent=${sent}`);
});
