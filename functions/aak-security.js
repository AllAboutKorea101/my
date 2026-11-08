/**
 * All About Korea — 유료 콘텐츠 보호용 Cloud Functions (aak-security.js)
 * ─────────────────────────────────────────────────────────────────────
 *  verifyBookOrder      : PayPal 결제를 서버에서 확인한 뒤 구매 기록을 저장 (무료 eBook 받기 포함)
 *  getBookDownloadUrl   : 구매자에게만 10분짜리 PDF 다운로드 링크 발급
 *  getLessonContent     : Masterclass 강의 HTML — 구독자·관리자는 전체, 그 외는 하루 3회 미리보기
 *  migrateSecureContent : (관리자 1회 실행) 공개 문서에 있던 파일 주소·강의 HTML을 비공개 위치로 이동
 *  toggleLessonFavorite : Masterclass 찜하기/해제 + 찜 수 집계 (서버만 숫자 변경)
 *  recordLessonView     : Masterclass 조회수 집계 (같은 사람·같은 강의는 하루 1회)
 *
 * 설치: functions/index.js 맨 아래에 한 줄 추가
 *     Object.assign(exports, require('./aak-security'));
 *   (주의: require('./aak-security'); 만 쓰면 함수가 배포되지 않습니다)
 * 필요 패키지: firebase-functions v4 이상, firebase-admin v11 이상, Node 18 이상 (fetch 내장)
 */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');

// index.js 가 initializeApp() 을 먼저 호출해도 충돌하지 않도록, 실제 실행 시점에 초기화합니다.
let _db = null;
function fdb() {
  if (!admin.apps.length) admin.initializeApp();
  return _db || (_db = admin.firestore());
}
const FieldValue = admin.firestore.FieldValue;

const REGION = 'asia-northeast3';              // tutor.html 과 같은 서울 리전
const PAYPAL_API = 'https://api-m.paypal.com';  // 실결제(Live). 샌드박스 테스트 시 https://api-m.sandbox.paypal.com
const PAYPAL_BOOKSTORE_CLIENT_ID = defineSecret('PAYPAL_BOOKSTORE_CLIENT_ID');
const PAYPAL_BOOKSTORE_SECRET = defineSecret('PAYPAL_BOOKSTORE_SECRET');

const DOWNLOAD_MONTHS = 3;          // 구매 후 다운로드 가능 기간 (기존 화면과 동일)
const SIGNED_URL_MINUTES = 10;      // 다운로드 링크 유효 시간
const PREVIEW_PER_DAY = 3;          // 비구독자 하루 미리보기 횟수
const ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

// ───────────────────────── 공통 ─────────────────────────
function requireUser(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Please sign in first.');
  if (req.auth.token.email_verified !== true) throw new HttpsError('permission-denied', 'Email is not verified.');
  return req.auth;
}

async function isSiteAdmin(uid) {
  const s = await fdb().doc(`admins/${uid}`).get();
  return s.exists && s.get('role') === 'admin';
}

async function isSubscriber(uid) {
  const s = await fdb().doc(`users/${uid}`).get();
  if (!s.exists) return false;
  return s.get('subscriptionStatus') === 'active' || s.get('subscriptionActive') === true;
}

function bookOptions(book) {
  if (Array.isArray(book.purchaseOptions) && book.purchaseOptions.length) return book.purchaseOptions;
  return [{ id: 'default', label: 'Standard PDF', type: 'pdf', price: Number(book.price) || 0 }];
}

function normalizePurchase(d) {
  if (!d) return null;
  return {
    purchaseCount: Number(d.purchaseCount) || 1,
    adminDeletedCount: (d.adminDeletedCount !== undefined && d.adminDeletedCount !== null)
      ? Number(d.adminDeletedCount) || 0 : (d.reviewBlocked ? 1 : 0),
    freeClaimed: !!d.freeClaimed || Number(d.price) === 0,
  };
}

const money = (n) => Math.round(Number(n) * 100);   // 센트 단위 정수 비교

// Firebase Storage 다운로드 URL → 저장 경로 ("book-files/…")
function storagePathFromUrl(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/\/o\/([^?#]+)/);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch (e) { return null; }
}

async function paypalAccessToken() {
  const basic = Buffer.from(`${PAYPAL_BOOKSTORE_CLIENT_ID.value()}:${PAYPAL_BOOKSTORE_SECRET.value()}`).toString('base64');
  const r = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) throw new HttpsError('internal', 'Payment verification is unavailable (PayPal auth).');
  return (await r.json()).access_token;
}

async function paypalOrder(orderID) {
  const token = await paypalAccessToken();
  const r = await fetch(`${PAYPAL_API}/v2/checkout/orders/${encodeURIComponent(orderID)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new HttpsError('failed-precondition', 'Payment could not be found.');
  return r.json();
}

// ───────────────────────── 1. 결제 확인 + 구매 기록 ─────────────────────────
exports.verifyBookOrder = onCall(
  { region: REGION, secrets: [PAYPAL_BOOKSTORE_CLIENT_ID, PAYPAL_BOOKSTORE_SECRET] },
  async (req) => {
    const auth = requireUser(req);
    const uid = auth.uid;
    const { orderID = null, items } = req.data || {};

    if (!Array.isArray(items) || items.length < 1 || items.length > 30) throw new HttpsError('invalid-argument', 'Invalid cart.');
    for (const it of items) {
      if (!it || !ID_RE.test(String(it.bookId || '')) || !ID_RE.test(String(it.optionId || ''))) {
        throw new HttpsError('invalid-argument', 'Invalid item.');
      }
    }
    if (orderID !== null && !/^[A-Z0-9]{8,30}$/.test(String(orderID))) throw new HttpsError('invalid-argument', 'Invalid order.');

    // 가격은 반드시 서버(Firestore)의 책 정보로 계산
    const lines = [];
    for (const it of items) {
      const snap = await fdb().doc(`books/${it.bookId}`).get();
      if (!snap.exists) throw new HttpsError('not-found', 'Book not found.');
      const book = snap.data();
      const opt = bookOptions(book).find((o) => String(o.id) === String(it.optionId));
      if (!opt) throw new HttpsError('not-found', 'Purchase option not found.');
      lines.push({ bookId: it.bookId, book, opt, price: Number(opt.price) || 0 });
    }
    const expectedCents = lines.reduce((s, l) => s + money(l.price), 0);

    if (orderID === null) {
      if (expectedCents !== 0) throw new HttpsError('failed-precondition', 'Payment is required.');
    } else {
      const order = await paypalOrder(orderID);
      if (order.status !== 'COMPLETED') throw new HttpsError('failed-precondition', 'Payment is not completed.');
      let paidCents = 0;
      for (const pu of order.purchase_units || []) {
        for (const c of (pu.payments && pu.payments.captures) || []) {
          if (c.status === 'COMPLETED' && c.amount && c.amount.currency_code === 'USD') paidCents += money(c.amount.value);
        }
      }
      if (paidCents !== expectedCents) throw new HttpsError('failed-precondition', 'Paid amount does not match the cart.');
    }

    const now = new Date();
    const expires = new Date(now);
    expires.setMonth(expires.getMonth() + DOWNLOAD_MONTHS);
    const orderKey = orderID || `FREE-${uid}-${now.getTime()}`;

    await fdb().runTransaction(async (tx) => {
      // 같은 결제를 두 번 쓰는 것 방지
      let orderRef = null;
      if (orderID) {
        orderRef = fdb().doc(`paypalOrders/${orderID}`);
        const o = await tx.get(orderRef);
        if (o.exists) throw new HttpsError('already-exists', 'This payment was already used.');
      }
      // 읽기 먼저 (트랜잭션 규칙)
      const prevByBook = {};
      for (const l of lines) {
        if (prevByBook[l.bookId] !== undefined) continue;
        const p = await tx.get(fdb().doc(`purchases/${uid}_${l.bookId}`));
        prevByBook[l.bookId] = p.exists ? normalizePurchase(p.data()) : null;
      }
      // 무료 eBook 은 책마다 1회만
      for (const l of lines) {
        if (l.price <= 0 && prevByBook[l.bookId] && prevByBook[l.bookId].freeClaimed) {
          throw new HttpsError('already-exists', 'You already claimed this free eBook.');
        }
      }
      // 쓰기
      const count = {};
      for (const l of lines) {
        const prev = prevByBook[l.bookId];
        count[l.bookId] = (count[l.bookId] || 0) + 1;
        const thumb = (l.book.thumbnail && !String(l.book.thumbnail).startsWith('data:')) ? l.book.thumbnail : '';
        tx.set(fdb().doc(`purchases/${uid}_${l.bookId}`), {
          purchaseCount: (prev ? prev.purchaseCount : 0) + count[l.bookId],
          adminDeletedCount: prev ? prev.adminDeletedCount : 0,
          freeClaimed: (prev ? prev.freeClaimed : false) || l.price <= 0,
          reviewBlocked: false,
          hidden: false,
          uid,
          bookId: l.bookId,
          bookTitle: l.book.title || '',
          thumbnail: thumb,
          optionId: String(l.opt.id),
          optionLabel: l.opt.label || 'Standard PDF',
          price: l.price,
          orderId: orderKey,
          purchaseDate: now.toISOString(),
          downloadExpiresAt: expires.toISOString(),
          fileURL: FieldValue.delete(),
          createdAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        tx.update(fdb().doc(`books/${l.bookId}`), { salesCount: FieldValue.increment(1) });
      }
      if (orderRef) {
        tx.set(orderRef, {
          uid, amountCents: expectedCents, items: lines.map((l) => ({ bookId: l.bookId, optionId: String(l.opt.id), price: l.price })),
          createdAt: FieldValue.serverTimestamp(),
        });
      }
    });
    return { ok: true, orderId: orderKey, downloadExpiresAt: expires.toISOString() };
  }
);

// ───────────────────────── 2. 구매자 전용 다운로드 링크 ─────────────────────────
exports.getBookDownloadUrl = onCall({ region: REGION }, async (req) => {
  const auth = requireUser(req);
  const bookId = String((req.data && req.data.bookId) || '');
  if (!ID_RE.test(bookId)) throw new HttpsError('invalid-argument', 'Invalid book.');

  const adminUser = await isSiteAdmin(auth.uid);
  let optionId = req.data && req.data.optionId ? String(req.data.optionId) : null;
  if (!adminUser) {
    const p = await fdb().doc(`purchases/${auth.uid}_${bookId}`).get();
    if (!p.exists || p.get('uid') !== auth.uid) throw new HttpsError('permission-denied', 'You have not purchased this eBook.');
    if (new Date() > new Date(p.get('downloadExpiresAt'))) throw new HttpsError('failed-precondition', 'The download period has ended.');
    optionId = String(p.get('optionId') || 'default');
  }

  const f = await fdb().doc(`bookFiles/${bookId}`).get();
  const options = (f.exists && f.get('options')) || {};
  const entry = (optionId && options[optionId]) || options.default || Object.values(options)[0];
  if (!entry || !entry.path) throw new HttpsError('not-found', 'The file for this eBook is not available yet.');

  const fileName = String(entry.fileName || entry.path.split('/').pop() || 'ebook.pdf').replace(/["\\\r\n]/g, '');
  const [url] = await admin.storage().bucket().file(entry.path).getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: Date.now() + SIGNED_URL_MINUTES * 60 * 1000,
    responseDisposition: `attachment; filename="${fileName}"`,
  });
  return { url, expiresInMinutes: SIGNED_URL_MINUTES };
});

// ───────────────────────── 3. Masterclass 강의 HTML ─────────────────────────
exports.getLessonContent = onCall({ region: REGION, memory: '512MiB' }, async (req) => {
  const auth = requireUser(req);
  const id = String((req.data && req.data.id) || '');
  if (!ID_RE.test(id)) throw new HttpsError('invalid-argument', 'Invalid lesson.');
  const wantPreview = !!(req.data && req.data.preview);

  const full = (await isSiteAdmin(auth.uid)) || (await isSubscriber(auth.uid));
  if (!full) {
    if (!wantPreview) throw new HttpsError('permission-denied', 'Subscription required.');
    const today = new Date().toISOString().slice(0, 10);
    const qRef = fdb().doc(`previewQuota/${auth.uid}`);
    await fdb().runTransaction(async (tx) => {
      const q = await tx.get(qRef);
      const used = q.exists && q.get('day') === today ? Number(q.get('count')) || 0 : 0;
      if (used >= PREVIEW_PER_DAY) throw new HttpsError('resource-exhausted', 'Daily free preview limit reached.');
      tx.set(qRef, { day: today, count: used + 1, updatedAt: FieldValue.serverTimestamp() });
    });
  }

  const c = await fdb().doc(`masterclassContent/${id}`).get();
  return { html: c.exists ? String(c.get('htmlContent') || '') : '', full };
});

// ───────────────────────── 4. 1회 이전 작업 (관리자) ─────────────────────────
exports.migrateSecureContent = onCall({ region: REGION, timeoutSeconds: 540, memory: '1GiB' }, async (req) => {
  const auth = requireUser(req);
  if (!(await isSiteAdmin(auth.uid))) throw new HttpsError('permission-denied', 'Admins only.');
  const bucket = admin.storage().bucket();
  const report = { books: 0, bookFiles: 0, purchases: 0, lessons: 0, tokensRevoked: 0, errors: [] };

  async function revokeToken(path) {
    try {
      await bucket.file(path).setMetadata({ metadata: { firebaseStorageDownloadTokens: null } });
      report.tokensRevoked++;
    } catch (e) { report.errors.push(`revoke ${path}: ${e.message}`); }
  }

  // (1) 책: 파일 주소 → bookFiles/{bookId} (비공개), 공개 문서에서 주소 삭제
  const books = await fdb().collection('books').get();
  for (const d of books.docs) {
    const b = d.data();
    const files = {};
    const opts = Array.isArray(b.purchaseOptions) ? b.purchaseOptions : [];
    const cleanOpts = opts.map((o) => {
      const path = storagePathFromUrl(o.fileURL);
      if (path) files[String(o.id)] = { path, fileName: o.fileName || path.split('/').pop() };
      const { fileURL, ...rest } = o;
      return { ...rest, hasFile: !!(path || o.hasFile) };
    });
    const pdfPath = storagePathFromUrl(b.pdfUrl);
    if (pdfPath && !files.default && !opts.length) files.default = { path: pdfPath, fileName: pdfPath.split('/').pop() };
    if (Object.keys(files).length) {
      await fdb().doc(`bookFiles/${d.id}`).set({ options: files, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      report.bookFiles++;
      for (const f of Object.values(files)) await revokeToken(f.path);
    }
    const upd = { pdfUrl: FieldValue.delete() };
    if (opts.length) upd.purchaseOptions = cleanOpts;
    await d.ref.update(upd);
    report.books++;
  }

  // (2) 구매 기록에 저장돼 있던 파일 주소 삭제
  const purchases = await fdb().collection('purchases').get();
  let batch = fdb().batch(), n = 0;
  for (const d of purchases.docs) {
    if (d.get('fileURL') === undefined) continue;
    batch.update(d.ref, { fileURL: FieldValue.delete() });
    report.purchases++;
    if (++n % 400 === 0) { await batch.commit(); batch = fdb().batch(); }
  }
  await batch.commit();

  // (3) Masterclass: 강의 HTML → masterclassContent/{id} (비공개)
  const lessons = await fdb().collection('masterclass').get();
  for (const d of lessons.docs) {
    const m = d.data();
    let html = typeof m.htmlContent === 'string' ? m.htmlContent : '';
    const sPath = storagePathFromUrl(m.htmlStorageUrl);
    if (!html && sPath) {
      try { html = (await bucket.file(sPath).download())[0].toString('utf8'); }
      catch (e) { report.errors.push(`lesson ${d.id}: ${e.message}`); }
    }
    if (m.htmlContent === undefined && m.htmlStorageUrl === undefined) continue;
    if (html) await fdb().doc(`masterclassContent/${d.id}`).set({ htmlContent: html, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    await d.ref.update({ htmlContent: FieldValue.delete(), htmlStorageUrl: FieldValue.delete(), hasHtml: !!html });
    if (sPath) await revokeToken(sPath);
    report.lessons++;
  }
  return report;
});

// ───────────────────────── 5. Masterclass 찜하기 ─────────────────────────
exports.toggleLessonFavorite = onCall({ region: REGION }, async (req) => {
  const auth = requireUser(req);
  const id = String((req.data && req.data.id) || '');
  if (!ID_RE.test(id)) throw new HttpsError('invalid-argument', 'Invalid lesson.');
  const on = !!(req.data && req.data.on);
  const favRef = fdb().doc(`userFavorites/${auth.uid}`);
  const lessonRef = fdb().doc(`masterclass/${id}`);
  return fdb().runTransaction(async (tx) => {
    const [fav, lesson] = [await tx.get(favRef), await tx.get(lessonRef)];
    if (!lesson.exists) throw new HttpsError('not-found', 'Lesson not found.');
    let ids = (fav.exists && Array.isArray(fav.get('ids'))) ? fav.get('ids').map(String) : [];
    let favCount = Math.max(0, Number(lesson.get('favCount')) || 0);
    const has = ids.includes(id);
    if (on && !has) {
      if (ids.length >= 500) throw new HttpsError('resource-exhausted', 'Too many favorites.');
      ids.push(id); favCount += 1;
    } else if (!on && has) {
      ids = ids.filter((x) => x !== id); favCount = Math.max(0, favCount - 1);
    } else {
      return { ids, favCount };            // 이미 같은 상태 → 숫자 변화 없음
    }
    tx.set(favRef, { ids, updatedAt: FieldValue.serverTimestamp() });
    tx.update(lessonRef, { favCount, favUpdatedAt: FieldValue.serverTimestamp() });
    return { ids, favCount };
  });
});

// ───────────────────────── 6. Masterclass 조회수 ─────────────────────────
exports.recordLessonView = onCall({ region: REGION }, async (req) => {
  const auth = requireUser(req);
  const id = String((req.data && req.data.id) || '');
  if (!ID_RE.test(id)) throw new HttpsError('invalid-argument', 'Invalid lesson.');
  const today = new Date().toISOString().slice(0, 10);
  const seenRef = fdb().doc(`lessonViews/${auth.uid}_${id}`);
  const lessonRef = fdb().doc(`masterclass/${id}`);
  return fdb().runTransaction(async (tx) => {
    const [seen, lesson] = [await tx.get(seenRef), await tx.get(lessonRef)];
    if (!lesson.exists) throw new HttpsError('not-found', 'Lesson not found.');
    const views = Number(lesson.get('views')) || 0;
    if (seen.exists && seen.get('day') === today) return { views, counted: false };   // 오늘 이미 집계됨
    tx.set(seenRef, { uid: auth.uid, lessonId: id, day: today, at: FieldValue.serverTimestamp() });
    tx.update(lessonRef, { views: FieldValue.increment(1), lastViewedAt: FieldValue.serverTimestamp() });
    return { views: views + 1, counted: true };
  });
});
