# 1:1 Korean Tutoring — Firebase 설정 가이드

프로젝트: `all-about-korea-login`

## 구성

| 파일 | 역할 |
|---|---|
| `tutor.html` | 웹페이지 (기존처럼 호스팅에 업로드) |
| `functions/index.js` | 크레딧 서버. 결제 확인, 예약, 10분마다 자동 차감·만료·자료 삭제 |
| `firestore.rules` | Firestore 규칙. 북스토어 규칙 포함 전체본 |
| `storage.rules` | 파일 업로드 규칙 (자료 10MB, 프로필 사진 5MB) |
| `firestore.indexes.json` | 자동 처리용 인덱스 2개 |
| `firebase.json`, `.firebaserc` | 배포 설정 |

---

## 1. Blaze 요금제로 전환 (필수)

다음 기능은 모두 Blaze(종량제) 요금제가 필요합니다.

- Cloud Functions
- 자동 실행 스케줄러
- 신규 Storage 버킷

설정 방법: Firebase Console → 좌측 하단 **Upgrade** → Blaze 선택 → 결제 계정 연결.

비용 참고:
- 이 규모에서는 대부분 무료 사용량 안에서 처리됩니다.
- 무료 사용량 예시: Functions 월 200만 회 호출, 스케줄러 작업 3개, Storage 5GB.
- 결제 계정에서 **예산 알림**(예: $5)을 설정해 두세요.

## 2. Storage 활성화

1. Firebase Console → **Build → Storage → Get started**
2. 위치는 **asia-northeast3 (Seoul)** 을 선택합니다. Firestore와 같은 지역이면 더 좋습니다.
3. 규칙은 아무거나 선택해도 됩니다. 4단계에서 `storage.rules`로 덮어씁니다.

## 3. Firebase CLI 준비 (PC에서 1회)

```bash
# Node.js 22 설치 후
npm install -g firebase-tools
firebase login
```

이 폴더(`firebase-project`)에서 다음을 실행합니다.

```bash
cd functions && npm install && cd ..
```

## 4. 배포

```bash
firebase deploy --only functions,firestore:rules,firestore:indexes,storage
```

배포 중 확인 사항:
- **Storage 규칙이 Firestore를 읽도록 권한을 줄지** 물으면 **Y**를 누릅니다. (튜터 권한 확인에 필요)
- **인덱스 삭제** 여부를 물으면 **N**을 누릅니다. 기존 북스토어 인덱스를 지우지 않기 위해서입니다.
- 처음 배포하면 Cloud Build·Artifact Registry·Cloud Scheduler API를 켜라는 안내가 나올 수 있습니다. 모두 **Y**를 누르세요.

배포가 끝나면 다음을 확인합니다.
- Console → Functions 목록에 `createOrder`, `bookLesson`, `processCredits` 등 **8개**가 보여야 합니다.
- Google Cloud Console → Cloud Scheduler에 `processCredits`가 **10분 주기**로 등록되어 있어야 합니다.

> ⚠️ `firestore.rules`는 **북스토어 규칙까지 포함한 전체본**입니다. 콘솔에서 직접 붙여 넣을 때도 기존 규칙을 전부 이 내용으로 교체하세요.

## 5. Storage 수명주기 규칙 (7일 자동 삭제 보조 장치)

7일 지난 자료는 `processCredits` 함수가 지웁니다. 아래 규칙은 함수가 놓친 파일까지 지우는 안전장치입니다.

1. Google Cloud Console → **Cloud Storage → Buckets** → `all-about-korea-login.firebasestorage.app`
2. **Lifecycle** 탭 → **Add a rule**
3. Action: **Delete object**
4. Conditions:
   - **Age = 7 days**
   - **Object name matches prefix = `materials/`**
5. Create

> 반드시 prefix를 `materials/`로 지정하세요. 지정하지 않으면 튜터 프로필 사진(`tutorPhotos/`)까지 7일 뒤에 삭제됩니다.

## 6. 인증 도메인

Console → **Authentication → Settings → Authorized domains**에 페이지를 올릴 도메인을 추가합니다.

예: `www.businesskorean.com`

## 7. 첫 사용 순서

1. `shchung0130@gmail.com`으로 로그인합니다. 관리자(admin) 역할이 자동으로 생성됩니다.
2. **Admin → 튜터 관리**에서 튜터를 등록합니다.
   - 입력: Tutor ID(예: `sunhee`), 이름, 튜터의 Google 이메일, 플랫폼 수수료 %
   - 본인이 직접 가르치는 경우 본인 이메일로 등록합니다. 관리자 권한은 유지되고 Tutor ID만 추가됩니다.
3. **Tutor 메뉴**에서 다음 순서로 설정하면 학생 화면에 예약 가능한 시간이 나타납니다.
   - 가능 시간 → 가격 → 내 프로필(사진·한 줄 소개)
4. 결제 흐름:
   - 학생이 수강권 구매를 요청합니다.
   - 튜터가 WISE 링크를 보냅니다.
   - 입금을 확인한 뒤 **Tutor → 결제 요청 → 결제 확인**을 누르면 크레딧이 지급됩니다.

## 8. 기존 테스트 데이터 정리

구조가 바뀌어 이전 데이터는 더 이상 사용되지 않습니다. Firestore 콘솔에서 아래 데이터를 삭제해도 됩니다.

- 예전 `bookings` 테스트 문서 (스크린샷의 Pending 목록)
- `settings/pricing`, `settings/availability`, `settings/tutorProfile`, `settings/calendars`, `settings/blockedDates`
- `availability`, `tutorProfile`, `feedback` 컬렉션

## 9. EmailJS (선택)

`tutor.html` 상단의 `EMAILJS_PUBLIC_KEY / SERVICE_ID / TEMPLATE_ID` 값을 채우면 다음과 같이 동작합니다.
- 구매 요청이 들어오면 **튜터 등록 이메일**로 알림이 갑니다.

## 자동 처리 동작 요약 (`processCredits`, 10분마다)

| 대상 | 처리 |
|---|---|
| 종료 시각이 지난 예약 수업 | `수업 완료`로 바꾸고 크레딧 1개 최종 차감 |
| 유효기간이 지난 수강권 | 남은 크레딧 만료. 이미 예약된 수업은 유지됩니다 |
| 업로드 7일이 지난 자료 | 파일과 기록 삭제 |
| 하루 지난 예약 슬롯 기록 | 정리 |

모든 처리는 트랜잭션으로 이루어집니다. 함수가 중복 실행되거나 재시도되어도 이중 차감되지 않습니다.
