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
 *   - bookLesson      : 수업 예약 → 크레딧 1개 '예약 중(보류)'
 *   - cancelLesson    : 수업 취소 → 보류 크레딧 복원 (학생=24시간 전까지)
 *   - submitReview    : 리뷰 작성 (수업 완료한 학생만) → 튜터 평점 재계산
 *
 *  Scheduled (10분마다 자동 실행)
 *   - processCredits  : ① 종료된 수업 → '사용 완료'로 최종 차감
 *                       ② 유효기간 지난 수강권 → 잔여 크레딧 만료
 *                       ③ 업로드 7일 지난 자료 → Storage 파일 + 문서 삭제
 *                       ④ 지난 예약 슬롯 정리
 *  모든 변경은 트랜잭션으로 처리되어 중복 실행/동시 실행에도 이중 차감되지 않습니다.
 */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions } = require("firebase-functions/v2");
const logger = require("firebase-functions/logger");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");

initializeApp();
setGlobalOptions({ region: "asia-northeast3", maxInstances: 10 });
const db = getFirestore();

const OWNER_EMAIL = "shchung0130@gmail.com";
const PKG = {
  trial:  { credits: 1,  creditType: "trial",   validDays: 30 },
  single: { credits: 1,  creditType: "regular", validDays: 30 },
  pack5:  { credits: 5,  creditType: "regular", validDays: 60 },
  pack10: { credits: 10, creditType: "regular", validDays: 120 },
};
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
  };
}
const isManager = (c, tid) => c.role === "admin" || (c.role === "tutor" && c.tutorId === tid);

/* ───────────── 가격 계산 (서버 기준) ───────────── */
async function computePrice(tutorId, email, pkg) {
  const tSnap = await db.doc(`tutors/${tutorId}`).get();
  if (!tSnap.exists || tSnap.data().active === false) {
    throw new HttpsError("not-found", "This tutor is not available.");
  }
  const tutor = tSnap.data();
  const p = tutor.pricing || {};
  const trial = num(p.trial, 10);
  const baseSingle = num(p.single, 35);
  const d5 = num(p.disc5, 5);
  const d10 = num(p.disc10, 12);
  const cr = await db.doc(`customRates/${rateId(tutorId, email)}`).get();
  const single = cr.exists ? num(cr.data().rate, baseSingle) : baseSingle;
  const table = {
    trial:  { list: trial, price: trial },
    single: { list: single, price: single },
    pack5:  { list: r2(single * 5),  price: r2(single * 5 * (1 - d5 / 100)) },
    pack10: { list: r2(single * 10), price: r2(single * 10 * (1 - d10 / 100)) },
  };
  return { ...table[pkg], tutor, customRate: cr.exists };
}

/* ═════════════ createOrder ═════════════ */
exports.createOrder = onCall(async (req) => {
  const c = await caller(req);
  const { tutorId, pkg } = req.data || {};
  if (!tutorId || !PKG[pkg]) throw new HttpsError("invalid-argument", "Invalid plan.");

  if (pkg === "trial") {
    const prev = await db.collection("orders")
      .where("studentEmail", "==", c.email).where("tutorId", "==", tutorId)
      .where("package", "==", "trial").get();
    if (!prev.empty) throw new HttpsError("already-exists", "The trial lesson can be purchased only once per tutor.");
  }

  const pr = await computePrice(tutorId, c.email, pkg);
  const ref = db.collection("orders").doc();
  const order = {
    studentEmail: c.email, studentUid: c.uid, studentName: c.name,
    tutorId, tutorName: pr.tutor.name || tutorId,
    package: pkg, creditType: PKG[pkg].creditType, credits: PKG[pkg].credits, validDays: PKG[pkg].validDays,
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
exports.updateOrder = onCall(async (req) => {
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
    if (!PKG[pkg]) throw new HttpsError("invalid-argument", "Invalid plan.");
    if (pkg === "trial") {
      const prev = await db.collection("orders").where("studentEmail", "==", o.studentEmail)
        .where("tutorId", "==", o.tutorId).where("package", "==", "trial").get();
      if (prev.docs.some((d) => d.id !== orderId)) throw new HttpsError("already-exists", "Trial already purchased.");
    }
    const pr = await computePrice(o.tutorId, o.studentEmail, pkg);
    Object.assign(upd, { package: pkg, creditType: PKG[pkg].creditType, credits: PKG[pkg].credits,
      validDays: PKG[pkg].validDays, listPrice: pr.list, price: pr.price });
  }
  if (mgr && price != null) upd.price = r2(num(price, o.price));
  if (mgr && note != null) upd.note = String(note).slice(0, 500);
  await ref.update(upd);
  return { ok: true };
});

/* ═════════════ deleteOrder ═════════════ */
exports.deleteOrder = onCall(async (req) => {
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
exports.confirmPayment = onCall(async (req) => {
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
exports.bookLesson = onCall(async (req) => {
  const c = await caller(req);
  const { tutorId, creditType, startISO, studentTZ } = req.data || {};
  const dur = DURATION[creditType];
  const start = new Date(startISO);
  if (!tutorId || !dur || isNaN(start.getTime())) throw new HttpsError("invalid-argument", "Invalid booking request.");
  if (start.getTime() < Date.now() + 12 * HOUR) {
    throw new HttpsError("failed-precondition", "Lessons must be booked at least 12 hours in advance.");
  }
  const end = new Date(start.getTime() + dur * 60000);
  const k = kst(start);
  const busyRef = db.doc(`busySlots/${tutorId}_${start.getTime()}`);

  return db.runTransaction(async (tx) => {
    const tSnap = await tx.get(db.doc(`tutors/${tutorId}`));
    if (!tSnap.exists || tSnap.data().active === false) throw new HttpsError("not-found", "Tutor not available.");
    const tutor = tSnap.data();
    const open = ((tutor.availability || {})[k.wd] || []).includes(k.hm);
    if (!open) throw new HttpsError("failed-precondition", "This time is not open for booking.");
    if ((tutor.blockedDates || []).some((b) => b.date === k.ymd)) {
      throw new HttpsError("failed-precondition", "The tutor is off on this date.");
    }
    const busy = await tx.get(busyRef);
    if (busy.exists) throw new HttpsError("already-exists", "This slot was just taken. Please choose another time.");

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
      studentEmail: c.email, studentUid: c.uid, studentName: c.name, studentTZ: String(studentTZ || "").slice(0, 60),
      tutorId, tutorName: tutor.name || tutorId, orderId: od.id, creditType, durationMin: dur,
      startAt: Timestamp.fromDate(start), endAt: Timestamp.fromDate(end), kstDate: k.ymd, kstTime: k.hm,
      status: "reserved", meetLink: "", createdAt: FieldValue.serverTimestamp(),
    });
    tx.set(busyRef, { tutorId, bookingId: bRef.id, startAt: Timestamp.fromDate(start), endAt: Timestamp.fromDate(end) });
    tx.set(logRef(), logData({ studentEmail: c.email, tutorId, orderId: od.id, bookingId: bRef.id, type: "reserve",
      delta: -1, creditType, note: `${k.ymd} ${k.hm} KST` }));
    return { bookingId: bRef.id };
  });
});

/* ═════════════ cancelLesson ═════════════ */
exports.cancelLesson = onCall(async (req) => {
  const c = await caller(req);
  const { bookingId } = req.data || {};
  const bRef = db.doc(`bookings/${bookingId || "_"}`);
  return db.runTransaction(async (tx) => {
    const bSnap = await tx.get(bRef);
    if (!bSnap.exists) throw new HttpsError("not-found", "Lesson not found.");
    const b = bSnap.data();
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
});

/* ═════════════ submitReview ═════════════ */
exports.submitReview = onCall(async (req) => {
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
  logger.info(`processCredits: consumed=${consumed} expired=${expired} materialsRemoved=${removed} slotsCleaned=${old.size}`);
});
