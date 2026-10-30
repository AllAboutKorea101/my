# 1:1 Korean Tutoring — Firebase 설정 가이드

프로젝트: `all-about-korea-login`

## 구성

| 파일 | 역할 |
|---|---|
| `tutor.html` | 웹페이지 (기존처럼 호스팅에 업로드) |
| `functions/index.js` | 크레딧 서버. 결제 확인, 예약, 10분마다 자동 차감·만료·자료 삭제·Google 캘린더 동기화 |
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
- Console → Functions 목록에 `createOrder`, `bookLesson`, `rescheduleLesson`, `setMeetLink`, `setMemberId`, `syncCalendar`, `processCredits` 등 **12개**가 보여야 합니다.
- Google Cloud Console → Cloud Scheduler에 `processCredits`가 **10분 주기**로 등록되어 있어야 합니다.

### 4-1. 버튼을 누르면 오류가 날 때 (예전 "INTERNAL")
이제 서버 오류는 원인이 보이는 메시지로 표시됩니다.
- **`Server permission error (Firestore PERMISSION_DENIED)`**: 함수 서비스 계정에 Firestore 권한이 없는 경우입니다. 2024년 이후 만든 프로젝트는 기본 서비스 계정에 권한이 자동으로 붙지 않아 자주 생깁니다.
  1. [Google Cloud Console → IAM](https://console.cloud.google.com/iam-admin/iam?project=all-about-korea-login) 열기
  2. **액세스 권한 부여** → 주 구성원에 `20771155142-compute@developer.gserviceaccount.com`
  3. 역할 **Cloud Datastore 사용자**와 **스토리지 객체 관리자** 추가 → 저장 (1~2분 뒤 다시 시도)
- **그 밖의 메시지**: 터미널에서 `firebase functions:log` 를 실행하면 자세한 기록이 보입니다.

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

## 5-1. Google 캘린더 연동 (튜터 일정 시간 자동 차단)

튜터의 Google 캘린더에 일정이 있는 시간은 학생이 예약할 수 없게 됩니다. 서버는 **바쁜 시간대만** 읽고, 일정 제목·내용은 읽지 않습니다.

**관리자 1회 설정**
1. Google Cloud Console → **API 및 서비스 → 라이브러리** → `Google Calendar API` 검색 → **사용**
   (프로젝트: `all-about-korea-login`)

**튜터별 설정 (캘린더마다 1회)**
1. Google 캘린더 → 해당 캘린더 **⋮ → 설정 및 공유**
2. **특정 사용자 또는 그룹과 공유 → 사용자 추가**에 아래 주소를 입력합니다.
   `20771155142-compute@developer.gserviceaccount.com`
   (Cloud Functions 기본 서비스 계정. Tutor → 스케줄 → Google 캘린더 연동 → "연동 방법"에도 표시됩니다)
3. 권한: **일정 변경** → 보내기
   - 이 권한이면 학생이 예약한 수업이 **1번 캘린더에 자동으로 등록**되고 **15분 전 알림**이 설정됩니다. 수업을 변경·취소하면 캘린더 일정도 같이 바뀝니다.
   - 예약 차단만 필요하고 자동 등록은 원하지 않으면 **한가함/바쁨 정보만 보기(세부정보 숨기기)** 로 두고, Tutor → 스케줄 → 연동 방법 안의 **자동 등록** 체크를 해제하세요.
   - 자동 등록된 일정은 '한가함'으로 표시되므로, 같은 수업이 두 번 차단되지 않습니다.
4. 같은 화면 **캘린더 통합 → 캘린더 ID**를 복사해 Tutor → 스케줄 → Google 캘린더 연동 칸에 붙여넣고 **저장**
   - 기본 캘린더의 ID는 Gmail 주소입니다 (예: `shchung0130@gmail.com`).
   - 추가 캘린더는 `…@group.calendar.google.com` 형식입니다.
   - 공개 URL·삽입 코드를 붙여넣어도 ID만 자동 추출됩니다.

저장하면 바로 동기화되고 캘린더별 결과(✓ 연결됨 / ✗ 공유 안 됨)가 표시됩니다. 이후 10분마다 자동 동기화되며, 학생이 예약하는 순간에도 해당 시간을 한 번 더 실시간 확인합니다.

> 참고: Google 캘린더의 **종일 일정은 기본값이 '한가함'** 이라 예약을 막지 않습니다. 하루 전체를 막으려면 Tutor 캘린더 상단의 날짜를 클릭해 휴일로 지정하세요.

## 5-2. 학생 캘린더

학생 캘린더에 서버가 직접 쓰는 것은 Google 정책상 불가능합니다(학생마다 OAuth 동의와 앱 심사 필요). 대신 학생 화면의 **내 캘린더에 추가** 버튼으로 Google 캘린더에 바로 추가하거나 `.ics` 파일을 받을 수 있고, 어느 쪽이든 **15분 전 알림**이 함께 설정됩니다. 별도 설정은 필요하지 않습니다.

## 5-3. 회원 ID (튜터 화면에서 이메일 대신 표시)

Admin → **회원·역할**의 맨 왼쪽 **ID** 칸에 이름을 적고 저장하면(예: `david`), 튜터 화면의 캘린더·예약 목록·맞춤요금·자료 피드백에서 이메일 대신 그 ID가 보입니다. 저장하면 기존 결제·예약 기록에도 함께 반영됩니다.

## 5-4. 학생 맞춤 요금

Tutor → **가격·맞춤요금** 아래쪽에서 학생 한 명의 **50분 단가와 패키지 A·B(횟수·유효기간·할인율)** 를 직접 구성합니다. 해당 학생이 로그인하면 그 가격이 보이고, **체험 수업은 표시되지 않습니다**(이미 결제한 체험 크레딧이 남아 있으면 예약은 그대로 가능). Admin → 학생 맞춤요금에서 같은 내용을 조회할 수 있습니다.

## 6. 인증 도메인

Console → **Authentication → Settings → Authorized domains**에 페이지를 올릴 도메인을 추가합니다.

예: `www.businesskorean.com`

## 7. 첫 사용 순서

1. `shchung0130@gmail.com`으로 로그인합니다. 관리자(admin) 역할이 자동으로 생성됩니다.
2. **Admin → 튜터 관리**에서 튜터를 등록합니다.
   - 입력: Tutor ID(예: `sunhee`), 이름, 튜터의 Google 이메일, 플랫폼 수수료 %
   - 본인이 직접 가르치는 경우 본인 이메일로 등록합니다. 관리자 권한은 유지되고 Tutor ID만 추가됩니다.
3. **Tutor 메뉴**에서 다음 순서로 설정하면 학생 화면에 예약 가능한 시간이 나타납니다.
   - 가능 시간 → 가격(패키지 A·B 횟수·유효기간 포함) → 내 프로필(사진·한 줄 소개) → (선택) Google 캘린더 연동
   - 수강권 유효기간: 체험 25분 7일, 50분 단건 14일 (고정), 패키지 A·B는 튜터가 선택
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
| 캘린더 ID를 등록한 튜터 | Google 캘린더 바쁜 시간 12주치 동기화 (`calBusy`) |

모든 처리는 트랜잭션으로 이루어집니다. 함수가 중복 실행되거나 재시도되어도 이중 차감되지 않습니다.

## 10. 이번 업데이트 요약 (2026-10-30)

**학생 화면**
- **Tutor** 탭이 새로 생겼습니다 (맨 왼쪽). 튜터 프로필·전문분야·구사 언어·리뷰와 수업 진행 안내가 이 탭에 모였고, 구매·예약 화면은 단순해졌습니다. 튜터가 2명 이상이면 이 탭에서 선택하며, 선택한 튜터가 계속 유지됩니다.
- 날짜 선택 달력을 직접 만든 달력으로 교체했습니다. 요일·월 이름이 선택한 언어로 표시되고, **예약 가능한 날짜에 초록 점**이 찍힙니다.
- 예약 화면이 달력과 시간 슬롯 좌우 배치로 바뀌었고, 선택한 시간이 또렷하게 보이도록 고쳤습니다.
- 상단 탭이 고정되고, 모바일에서는 **화면 하단 탭 바**로 바뀝니다. 모든 탭 위에 `수강권 구매 → 수업 예약 → 수업 듣기` 진행 표시가 나옵니다.
- 대시보드 상단은 **잔여 크레딧·예약 중** 2개만 남기고, 나머지 5개 카드는 **수업·크레딧 히스토리** 화면으로 옮겼습니다. 기간은 최근 1주~12개월 드롭다운으로도 고를 수 있습니다.
- 수업이 끝나면 **바로 완료로 집계**되고 예정 목록에서 사라집니다 (서버 정산을 기다리지 않습니다).
- 결제 확인·수업 완료가 **새로고침 없이 즉시 반영**됩니다 (실시간 구독).
- 예정 수업마다 **내 캘린더에 추가** 버튼 (Google 캘린더 / .ics, 15분 전 알림).

**튜터 화면**
- 메뉴 전체가 선택한 언어로 표시됩니다 (Admin은 한국어 유지).
- Google 캘린더 입력칸이 기본 1개이고, **예약된 수업이 캘린더에 자동 등록**됩니다 (15분 전 알림, 변경·취소 시 같이 반영).
- Meet 링크: 학생별 필터, 지난 수업 숨김, 학생 ID 표시. 같은 학생이 다시 예약하면 **최신 링크가 자동으로 들어갑니다** (수정 가능).
- 학생 맞춤 요금을 **50분 단가 + 패키지 A·B** 구성으로 설정합니다.
- 프로필에 **구사 언어와 CEFR 레벨(A1~C2·모국어)** 을 추가했고, 전문 분야는 학생 화면에서 번역됩니다.
- 학생 히스토리에 **누적 잔액** 표와 **CSV 내보내기**가 생겼습니다 (분쟁 시 증빙용).
- 프로필 사진은 업로드 전에 자동으로 512px WebP로 줄여 저장합니다. **기존 사진은 한 번 다시 올려주세요.**

**Admin**
- 회원·역할에 **ID** 칸이 생겼습니다.
