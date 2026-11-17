// functions/index.js
// 월 $4.99 정기구독 모델 (7일 무료체험 포함, PayPal Plan ID: P-8MM518007F4309714NJZP7II)
//
// 1) verifyPaypalSubscription : payment.html에서 구독을 처음 승인했을 때 호출
//    → 서버가 PayPal에 직접 확인 후 Firestore에 subscriptionActive:true 기록
//
// 2) paypalWebhook : 이후 "매달 자동 결제 성공/실패/취소"는 PayPal이 자동으로 알려주는
//    이벤트(webhook)를 받아서 Firestore를 최신 상태로 유지
//
// 3) cancelSubscription : mypage.html에서 "Cancel Subscription" 클릭 시 호출
//    → 자동 갱신만 중단하고, 현재 결제 기간 끝(subscriptionEndsAt)까지는 계속 이용 가능하게 유지

const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

// 보안 관련 기능 불러오기
Object.assign(exports, require('./aak-security'));

initializeApp();
const db = getFirestore();

const PAYPAL_CLIENT_ID = defineSecret("PAYPAL_CLIENT_ID");
const PAYPAL_SECRET = defineSecret("PAYPAL_SECRET");
const PAYPAL_WEBHOOK_ID = defineSecret("PAYPAL_WEBHOOK_ID");
const PAYPAL_API_BASE = "https://api-m.paypal.com"; // 테스트 중엔 https://api-m.sandbox.paypal.com

// payment.html에서 쓰고 있는 실제 구독 플랜 ID — 다른 플랜 ID로 위조된 요청을 막기 위한 검증용
const EXPECTED_PLAN_ID = "P-8MM518007F4309714NJZP7II";

async function getPaypalAccessToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID.value()}:${PAYPAL_SECRET.value()}`).toString("base64");
  const res = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { "Authorization": `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("PayPal 토큰 발급 실패");
  return data.access_token;
}

// 구독 ID로 PayPal에서 "다음 결제일(next_billing_time)"을 읽어옵니다. (해지 시 이용 만료일로 사용)
async function getNextBillingTime(subscriptionID, accessToken) {
  try {
    const res = await fetch(`${PAYPAL_API_BASE}/v1/billing/subscriptions/${subscriptionID}`, {
      headers: { "Authorization": `Bearer ${accessToken}` },
    });
    const sub = await res.json();
    return (sub && sub.billing_info && sub.billing_info.next_billing_time) || null;
  } catch (e) {
    console.warn("next_billing_time 조회 실패:", e.message);
    return null;
  }
}

// ── ① 구독 시작 시 1회 호출 (payment.html에서 호출) ─────────────────────
exports.verifyPaypalSubscription = onCall({ secrets: [PAYPAL_CLIENT_ID, PAYPAL_SECRET] }, async (request) => {
  const { subscriptionID } = request.data;
  const uid = request.auth?.uid;

  if (!uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  if (!subscriptionID) throw new HttpsError("invalid-argument", "구독 ID가 없습니다.");

  const accessToken = await getPaypalAccessToken();

  // PayPal 서버에 직접 조회 (브라우저가 보낸 값을 그대로 믿지 않음)
  const subRes = await fetch(`${PAYPAL_API_BASE}/v1/billing/subscriptions/${subscriptionID}`, {
    headers: { "Authorization": `Bearer ${accessToken}` },
  });
  const sub = await subRes.json();

  const isActiveOrTrial = sub.status === "ACTIVE";
  const isRightPlan = sub.plan_id === EXPECTED_PLAN_ID;

  if (!isActiveOrTrial || !isRightPlan) {
    throw new HttpsError("failed-precondition", "구독 상태를 확인할 수 없습니다.");
  }

  await db.collection("users").doc(uid).set(
    {
      subscriptionActive: true,
      subscriptionCancelled: false,         // 자동 갱신 중단 여부
      subscriptionEndsAt: null,             // 해지 후 이용 만료일 (가입 시엔 없음)
      subscriptionID,
      subscriptionPlanId: sub.plan_id,
      subscriptionStartedAt: new Date().toISOString(),
      subscriptionNextBilling: (sub.billing_info && sub.billing_info.next_billing_time) || null,
    },
    { merge: true }
  );

  return { success: true };
});

// ── ③ 구독 해지 (mypage.html에서 "Cancel Subscription" 버튼 클릭 시 호출) ──
//    자동 갱신만 중단하고, 이미 결제된 현재 기간 끝(subscriptionEndsAt)까지는 계속 이용 가능.
exports.cancelSubscription = onCall({ secrets: [PAYPAL_CLIENT_ID, PAYPAL_SECRET] }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");

  const userRef = db.collection("users").doc(uid);
  const userSnap = await userRef.get();
  const data = userSnap.data() || {};
  const subscriptionID = data.subscriptionID;

  if (!subscriptionID) {
    throw new HttpsError("failed-precondition", "해지할 구독을 찾을 수 없습니다.");
  }

  const accessToken = await getPaypalAccessToken();

  // 이미 결제된 현재 기간의 종료일(= 이용 가능 만료일). 저장값이 없으면 PayPal에서 다시 조회.
  let endsAt = data.subscriptionNextBilling || null;
  if (!endsAt) endsAt = await getNextBillingTime(subscriptionID, accessToken);

  // PayPal 서버에 직접 해지 요청 (서버가 실행 → 위조 불가, 자동 갱신 중단)
  const cancelRes = await fetch(`${PAYPAL_API_BASE}/v1/billing/subscriptions/${subscriptionID}/cancel`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ reason: "Customer requested cancellation" }),
  });

  // PayPal은 해지 성공 시 204 No Content를 반환합니다.
  if (cancelRes.status !== 204) {
    const errBody = await cancelRes.text();
    console.error("PayPal 해지 실패:", errBody);
    throw new HttpsError("internal", "구독 해지 요청이 실패했습니다.");
  }

  // 현재 결제 기간 끝까지는 계속 이용 가능하게 유지 (자동 갱신만 중단).
  // 실제 이용 종료는 getLessonContent 등의 접근 검사(isSubscriber)가 subscriptionEndsAt로 처리합니다.
  await userRef.set(
    {
      subscriptionActive: true,
      subscriptionCancelled: true,
      subscriptionEndsAt: endsAt,
      subscriptionCancelledAt: new Date().toISOString(),
    },
    { merge: true }
  );

  return { success: true, endsAt };
});

// ── ② PayPal이 매달 자동으로 호출하는 Webhook ──────────────────────────
// 이 함수의 배포된 URL을 PayPal Developer Dashboard의 Webhooks에 등록해야 합니다.
exports.paypalWebhook = onRequest(
  { secrets: [PAYPAL_CLIENT_ID, PAYPAL_SECRET, PAYPAL_WEBHOOK_ID] },
  async (req, res) => {
    try {
      const accessToken = await getPaypalAccessToken();

      // PayPal이 보낸 이벤트가 진짜인지 서명 검증 (위조 요청 차단)
      const verifyRes = await fetch(`${PAYPAL_API_BASE}/v1/notifications/verify-webhook-signature`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          auth_algo: req.headers["paypal-auth-algo"],
          cert_url: req.headers["paypal-cert-url"],
          transmission_id: req.headers["paypal-transmission-id"],
          transmission_sig: req.headers["paypal-transmission-sig"],
          transmission_time: req.headers["paypal-transmission-time"],
          webhook_id: PAYPAL_WEBHOOK_ID.value(),
          webhook_event: req.body,
        }),
      });
      const verification = await verifyRes.json();

      if (verification.verification_status !== "SUCCESS") {
        console.warn("Webhook 서명 검증 실패");
        res.status(400).send("invalid signature");
        return;
      }

      const event = req.body;
      // BILLING.SUBSCRIPTION.* 이벤트는 resource.id가 구독ID지만,
      // PAYMENT.SALE.* 이벤트(매달 자동결제)는 resource.id가 결제(거래) ID이고
      // 실제 구독ID는 resource.billing_agreement_id에 들어있습니다.
      const subscriptionID = event?.resource?.billing_agreement_id || event?.resource?.id;
      if (!subscriptionID) {
        res.status(200).send("ignored");
        return;
      }

      const usersRef = db.collection("users");
      const snap = await usersRef.where("subscriptionID", "==", subscriptionID).limit(1).get();
      if (snap.empty) {
        res.status(200).send("no matching user");
        return;
      }
      const userDoc = snap.docs[0];
      const udata = userDoc.data() || {};

      switch (event.event_type) {
        case "BILLING.SUBSCRIPTION.ACTIVATED":
        case "PAYMENT.SALE.COMPLETED": {
          // 정상 결제/갱신 → 구독 유지, 해지 상태 해제, 다음 갱신일 최신화
          const next = await getNextBillingTime(subscriptionID, accessToken);
          await userDoc.ref.set(
            {
              subscriptionActive: true,
              subscriptionCancelled: false,
              subscriptionEndsAt: null,
              ...(next ? { subscriptionNextBilling: next } : {}),
            },
            { merge: true }
          );
          break;
        }
        case "BILLING.SUBSCRIPTION.CANCELLED":
        case "BILLING.SUBSCRIPTION.EXPIRED":
        case "BILLING.SUBSCRIPTION.SUSPENDED":
        case "PAYMENT.SALE.DENIED": {
          const ends = udata.subscriptionEndsAt;
          const graceful =
            udata.subscriptionCancelled === true && ends && new Date(ends).getTime() > Date.now();
          if (graceful) {
            // 사용자가 직접 해지한 구독 — 남은 기간 동안은 계속 이용 가능.
            // 실제 만료는 접근 검사(isSubscriber)가 subscriptionEndsAt로 처리하므로 여기서 끄지 않습니다.
            await userDoc.ref.set({ subscriptionCancelled: true }, { merge: true });
          } else {
            // 결제 실패·일시정지 등 비자발적 종료 → 즉시 이용 종료
            await userDoc.ref.set(
              {
                subscriptionActive: false,
                subscriptionCancelled: true,
                subscriptionEndsAt: ends || new Date().toISOString(),
              },
              { merge: true }
            );
          }
          break;
        }
        default:
          break;
      }

      res.status(200).send("ok");
    } catch (err) {
      console.error(err);
      res.status(500).send("error");
    }
  }
);
