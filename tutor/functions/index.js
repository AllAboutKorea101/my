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
 *
 *  Scheduled (10분마다 자동 실행)
 *   - processCredits  : ① 종료된 수업 → '사용 완료'로 최종 차감
 *                       ② 유효기간 지난 수강권 → 잔여 크레딧 만료
 *                       ③ 업로드 7일 지난 자료 → Storage 파일 + 문서 삭제
 *                       ④ 지난 예약 슬롯 정리
 *                       ⑤ 튜터 Google 캘린더 바쁜 시간 동기화 (calBusy)
 *  모든 변경은 트랜잭션으로 처리되어 중복 실행/동시 실행에도 이중 차감되지 않습니다.
 */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
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
function pkgTable(tutor, cr) {
  const p = (tutor && tutor.pricing) || {};
  const o = cr || {};
  const cnt = (v, d) => Math.min(50, Math.max(2, Math.round(num(v, d))));
  const dys = (v, d) => Math.min(365, Math.max(7, Math.round(num(v, d))));
  const pick = (a, b, d) => (a == null || a === "" ? num(b, d) : num(a, d));
  return {
    trial:  { credits: 1, creditType: "trial",   validDays: 7 },
    single: { credits: 1, creditType: "regular", validDays: 14 },
    pack5:  { credits: cnt(pick(o.pack5Count, p.pack5Count, 5), 5),
      creditType: "regular", validDays: dys(pick(o.pack5Days, p.pack5Days, 60), 60) },
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
const call = (handler) => onCall(async (req) => {
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
async function computePrice(tutorId, email, pkg) {
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
  const cfg = pkgTable(tutor, cr);
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
async function upsertLessonEvent(bookingId) {
  const bRef = db.doc(`bookings/${bookingId}`);
  const snap = await bRef.get();
  if (!snap.exists) return;
  const b = snap.data();
  if (b.status !== "reserved") return;
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
  const { tutorId, pkg } = req.data || {};
  if (!tutorId || !PKG_KEYS.includes(pkg)) throw new HttpsError("invalid-argument", "Invalid plan.");

  if (pkg === "trial") {
    const prev = await db.collection("orders")
      .where("studentEmail", "==", c.email).where("tutorId", "==", tutorId)
      .where("package", "==", "trial").get();
    if (!prev.empty) throw new HttpsError("already-exists", "The trial lesson can be purchased only once per tutor.");
  }

  const pr = await computePrice(tutorId, c.email, pkg);
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
  return { orderId: ref.id, price: pr.price, listPrice: pr.list, credits: order.credits,
    tutorEmail: pr.tutor.email || null, tutorName: order.tutorName };
});

/* ═════════════ updateOrder ═════════════ */
exports.updateOrder = call(async (req) => {
  const c = await caller(req);
  const { orderId, pkg, price, note } = req.data || {};
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
  if (pkg && pkg !== o.package) {
    if (!PKG_KEYS.includes(pkg)) throw new HttpsError("invalid-argument", "Invalid plan.");
    if (pkg === "trial") {
      const prev = await db.collection("orders").where("studentEmail", "==", o.studentEmail)
        .where("tutorId", "==", o.tutorId).where("package", "==", "trial").get();
      if (prev.docs.some((d) => d.id !== orderId)) throw new HttpsError("already-exists", "Trial already purchased.");
    }
    const pr = await computePrice(o.tutorId, o.studentEmail, pkg);
    Object.assign(upd, { package: pkg, creditType: pr.creditType, credits: pr.credits,
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
exports.bookLesson = call(async (req) => {
  const c = await caller(req);
  const { tutorId, creditType, startISO, studentTZ } = req.data || {};
  const dur = DURATION[creditType];
  const start = new Date(startISO);
  if (!tutorId || !dur || isNaN(start.getTime())) throw new HttpsError("invalid-argument", "Invalid booking request.");
  if (start.getTime() < Date.now() + LEAD) {
    throw new HttpsError("failed-precondition", "Lessons must be booked at least 12 hours in advance.");
  }
  const end = new Date(start.getTime() + dur * 60000);
  const busyRef = db.doc(`busySlots/${tutorId}_${start.getTime()}`);
  if (await calendarConflict(tutorId, start.getTime(), end.getTime())) {
    throw new HttpsError("failed-precondition", "The tutor is not available at this time. Please choose another slot.");
  }
  // 같은 튜터와의 가장 최근 예약에 저장된 Meet 링크를 자동으로 이어받습니다 (튜터가 나중에 수정 가능).
  let meetLink = "";
  try {
    const prev = await db.collection("bookings")
      .where("studentEmail", "==", c.email).where("tutorId", "==", tutorId).get();
    const withLink = prev.docs.map((d) => d.data()).filter((x) => x.meetLink)
      .sort((a, b) => b.startAt.toMillis() - a.startAt.toMillis());
    if (withLink.length) meetLink = String(withLink[0].meetLink).slice(0, 500);
  } catch (e) { logger.warn("meet link carry-over failed", e); }

  const out = await db.runTransaction(async (tx) => {
    const { tutor, k } = await checkSlot(tx, tutorId, start, end, dur, null);
    const mine = await tx.get(db.collection("bookings").where("studentEmail", "==", c.email).where("status", "==", "reserved"));
    if (mine.docs.some((d) => d.data().startAt.toMillis() === start.getTime())) {
      throw new HttpsError("already-exists", "You already have a lesson at this time.");
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
  await upsertLessonEvent(out.bookingId);   // 튜터 Google 캘린더에 일정 생성 (실패해도 예약은 유지)
  return out;
});

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
  return res;
});

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
  return res;
});

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
  for (const s of snaps) if (s.exists) await upsertLessonEvent(s.id);
  return { ok: true, count: n };
});

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
  // ⑤ Google 캘린더 동기화 (캘린더 ID를 등록한 튜터만)
  let synced = 0;
  const privs = await db.collection("tutorPrivate").get();
  for (const d of privs.docs) {
    if (!(d.data().calendarIds || []).length) continue;
    try { await syncTutorCalendar(d.id); synced++; } catch (e) { logger.error("calendar sync failed", d.id, e); }
  }
  logger.info(`processCredits: consumed=${consumed} expired=${expired} materialsRemoved=${removed} slotsCleaned=${old.size} calendarsSynced=${synced}`);
});
