// functions/index.js
// 이 파일은 Firebase Cloud Functions로 배포됩니다.
// 역할: 브라우저가 아니라 서버가 직접 PayPal에 "이 주문 진짜 결제됐어?"라고 확인한 뒤,
//       진짜일 때만 Firestore에 paid:true 를 기록합니다. (브라우저 조작으로는 결제 상태를 위조할 수 없음)

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

initializeApp();
const db = getFirestore();

// ⚠️ 터미널에서 firebase functions:secrets:set 으로 등록한 값을 여기서 안전하게 불러옵니다.
const PAYPAL_CLIENT_ID = defineSecret("PAYPAL_CLIENT_ID");
const PAYPAL_SECRET = defineSecret("PAYPAL_SECRET");
const PAYPAL_API_BASE = "https://api-m.paypal.com"; // 테스트 중엔 https://api-m.sandbox.paypal.com 사용

async function getPaypalAccessToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID.value()}:${PAYPAL_SECRET.value()}`).toString("base64");
  const res = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("PayPal 토큰 발급 실패");
  return data.access_token;
}

// 클라이언트(payment.html)에서 호출: 결제 완료된 주문 ID를 보내면
// 서버가 PayPal에 직접 조회해서 진짜 결제 완료 상태인지, 금액이 맞는지 확인합니다.
exports.verifyPaypalPayment = onCall({ secrets: [PAYPAL_CLIENT_ID, PAYPAL_SECRET] }, async (request) => {
  const { orderID } = request.data;
  const uid = request.auth?.uid;

  if (!uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  if (!orderID) {
    throw new HttpsError("invalid-argument", "주문 ID가 없습니다.");
  }

  const accessToken = await getPaypalAccessToken();

  // PayPal 서버에 직접 주문 상세 조회 (브라우저가 보낸 값을 그대로 믿지 않음)
  const orderRes = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders/${orderID}`, {
    headers: { "Authorization": `Bearer ${accessToken}` },
  });
  const order = await orderRes.json();

  const isCompleted = order.status === "COMPLETED";
  // 금액 검증 — 실제 판매 금액으로 바꿔주세요 (예: 문법 학습자료 이용권 가격)
  const EXPECTED_AMOUNT = "9.99";
  const EXPECTED_CURRENCY = "USD";
  const paidAmount = order?.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value;
  const paidCurrency = order?.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.currency_code;

  if (!isCompleted || paidAmount !== EXPECTED_AMOUNT || paidCurrency !== EXPECTED_CURRENCY) {
    throw new HttpsError("failed-precondition", "결제 확인에 실패했습니다.");
  }

  // 검증 통과 → Firestore에 이 유저는 결제완료로 기록
  await db.collection("users").doc(uid).set(
    {
      paid: true,
      paidAt: new Date().toISOString(),
      orderID,
    },
    { merge: true }
  );

  return { success: true };
});
