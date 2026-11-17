/*!
 * All About Korea — shared burger menu + header widget (menu.js)
 * ------------------------------------------------------------
 * 버거 메뉴 링크는 이 파일의 MENU_LINKS 만 수정하면
 * 이 파일을 불러오는 모든 페이지에 자동 반영됩니다.
 *
 * ▣ 공통 헤더 위젯 (오른쪽 끝: My Account / Sign In · 그 왼쪽: 번역기)
 *    각 페이지의 헤더 오른쪽에 <div data-site-auth></div> 만 두면
 *    이 파일이 "번역 버튼 + My Account(또는 Sign In)"를 자동으로 그려 넣습니다.
 *    → 모양·링크·언어 목록을 바꾸려면 이 파일만 수정하면 모든 페이지에 반영됩니다.
 *
 * ▣ 언어 전환
 *    번역 버튼에서 언어를 고르면: localStorage('aak_lang') 저장 + <html lang> 변경 +
 *    window 에 'aak:langchange' 이벤트 발생(detail.lang). 각 페이지는 이 이벤트를 듣고
 *    자기 번역 함수를 다시 실행하면 됩니다(아래 "페이지 어댑터" 예시 참고).
 *    선택 언어는 페이지를 옮겨도 유지됩니다.
 *
 * 업로드 위치:  https://www.businesskorean.com/menu.js  (사이트 루트)
 * 각 페이지에서: <script src="https://www.businesskorean.com/menu.js" defer></script>
 * 버거 버튼 위치: <div data-site-menu></div>  (없으면 화면 왼쪽 위에 고정 표시)
 * 헤더 위젯 위치: <div data-site-auth></div>  (헤더 오른쪽 끝)
 *
 * ── 페이지 어댑터 예시(각 페이지 </body> 직전에 1회) ──
 *   <script>
 *     window.addEventListener('aak:langchange', function(e){
 *       var code = e.detail.lang;
 *       // 이 페이지 번역 사전에 없는 언어면 영어로:
 *       myTranslate(SUPPORTED[code] ? code : 'en');
 *     });
 *     if (window.AAK_LANG) window.dispatchEvent(new CustomEvent('aak:langchange',{detail:{lang:window.AAK_LANG}}));
 *   </script>
 * ------------------------------------------------------------
 */
(function () {
  'use strict';

  /* ============ ✏️ 메뉴 링크: 여기만 수정하세요 ============ */
  var MENU_LINKS = [
    { key: 'home',        icon: 'home', label: 'Home',         url: 'https://www.businesskorean.com/' },
    { key: 'homestay',    icon: 'bed', label: 'Homestay',     url: 'https://www.businesskorean.com/homestay/homestay.html' },
    { key: 'tour',        icon: 'compass', label: 'Guided Tour',  url: 'https://www.businesskorean.com/guidedtour/guidedtour.html' },
    { key: 'tutor',       icon: 'person', label: 'Korean Tutor', url: 'https://www.businesskorean.com/tutor/tutor.html' },
    { key: 'blog',        icon: 'article', label: 'Korean Blog',  url: 'https://www.businesskorean.com/blog/blog.html' },
    { key: 'masterclass', icon: 'school', label: 'Masterclass',  url: 'https://www.businesskorean.com/masterclass/masterclass.html' },
    { key: 'books',       icon: 'books', label: 'Korean Books', url: 'https://www.businesskorean.com/bookstore/bookstore.html' }
  ];
  /* icon 에 쓸 수 있는 이름: home, bed, compass, person, article, school, books, pencil, play, book (아래 ICONS) */

  /* ============ ✏️ 번역 버튼에 보일 언어 목록: 여기만 수정하세요 ============ */
  var LANGS = [
    { code: 'en', flag: '🇬🇧', label: 'English' },
    { code: 'ko', flag: '🇰🇷', label: '한국어' },
    { code: 'ja', flag: '🇯🇵', label: '日本語' },
    { code: 'zh', flag: '🇨🇳', label: '中文' },
    { code: 'es', flag: '🇪🇸', label: 'Español' },
    { code: 'fr', flag: '🇫🇷', label: 'Français' },
    { code: 'de', flag: '🇩🇪', label: 'Deutsch' },
    { code: 'pl', flag: '🇵🇱', label: 'Polski' }
  ];
  var LANG_KEY = 'aak_lang';
  /* ======================================================================= */

  // 애플 스타일 라인 아이콘 (선 굵기 1.6, 글자 색을 따라감)
  var ICONS = {
    home:    '<path d="M3.5 10.2 12 3.5l8.5 6.7"/><path d="M5.5 8.8V19a1.5 1.5 0 0 0 1.5 1.5h3.2V15h3.6v5.5H17a1.5 1.5 0 0 0 1.5-1.5V8.8"/>',
    bed:     '<path d="M3 5.5v14"/><path d="M3 15h18v4.5"/><path d="M21 15v-2.5A2.5 2.5 0 0 0 18.5 10H11v5"/><circle cx="7" cy="11.6" r="1.9"/>',
    compass: '<circle cx="12" cy="12" r="8.75"/><path d="m15.4 8.6-1.9 4.9-4.9 1.9 1.9-4.9z"/>',
    person:  '<circle cx="12" cy="8" r="3.6"/><path d="M4.8 20.2c.9-3.6 3.7-5.7 7.2-5.7s6.3 2.1 7.2 5.7"/>',
    pencil:  '<path d="M11 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V13"/><path d="M17.6 3.9a1.9 1.9 0 0 1 2.7 2.7l-7.6 7.6-3.4.8.8-3.4z"/>',
    play:    '<rect x="3" y="5" width="18" height="14" rx="3.2"/><path d="m10.2 9.2 4.6 2.8-4.6 2.8z"/>',
    article: '<path d="M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M7 8h10M7 12h10M7 16h10"/>',
    school:  '<path d="M22 9 12 5 2 9l10 4 10-4v6"/><path d="M6 10.6V16a6 3 0 0 0 12 0v-5.4"/>',
    books:   '<path d="M5 5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z"/><path d="M9 5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1z"/><path d="M5 8h4M9 16h4"/><path d="M13.8 4.56 16 4.03c.56-.14 1.13.19 1.28.73l3.7 13.42a1.02 1.02 0 0 1-.64 1.22l-.13.04-2.18.53c-.56.14-1.13-.19-1.28-.73L13.04 5.82a1.02 1.02 0 0 1 .63-1.22z"/><path d="m14 9 4-1M16 16l3.92-.98"/>',
    book:    '<path d="M12 6.8C10.4 5.4 7.9 4.8 4 4.8v12.9c3.9 0 6.4.6 8 2 1.6-1.4 4.1-2 8-2V4.8c-3.9 0-6.4.6-8 2z"/><path d="M12 6.8v12.9"/>'
  };
  function iconSvg(name) {
    var d = ICONS[name];
    if (!d) return name || '';
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';
  }

  // 로그인(공통) — login.html 과 같은 Firebase 프로젝트를 사용합니다.
  var LOGIN_URL   = 'https://www.businesskorean.com/login.html';
  var ACCOUNT_URL = 'https://www.businesskorean.com/mypage.html';
  var FB_VERSION  = '10.13.0';
  var FB_CONFIG = {
    apiKey: "AIzaSyA-qZfGlrEEAQRpl4KQzJmU7f4j1R0Usl8",
    authDomain: "all-about-korea-login.firebaseapp.com",
    projectId: "all-about-korea-login",
    storageBucket: "all-about-korea-login.firebasestorage.app",
    messagingSenderId: "20771155142",
    appId: "1:20771155142:web:bbfeb19541625e750cbbc7"
  };

  // 다국어 지원 코드 집합
  var SUPPORTED = {};
  LANGS.forEach(function (l) { SUPPORTED[l.code] = l; });
  function supported(c) { return !!SUPPORTED[c]; }

  // 메뉴 이름 번역 (페이지 언어 <html lang> 에 맞춰 자동 전환)
  var LABELS = {
    ko: { home: '홈', homestay: '홈스테이', tour: '가이드 투어', tutor: '한국어 튜터', blog: '한국어 블로그', masterclass: '마스터클래스', books: '한국어 교재' },
    es: { home: 'Inicio', homestay: 'Homestay', tour: 'Tour guiado', tutor: 'Tutor de coreano', blog: 'Blog de coreano', masterclass: 'Masterclass', books: 'Libros de coreano' },
    zh: { home: '首页', homestay: '民宿', tour: '导览行程', tutor: '韩语家教', blog: '韩语博客', masterclass: '大师课', books: '韩语书籍' },
    ja: { home: 'ホーム', homestay: 'ホームステイ', tour: 'ガイドツアー', tutor: '韓国語チューター', blog: '韓国語ブログ', masterclass: 'マスタークラス', books: '韓国語の本' },
    fr: { home: 'Accueil', homestay: 'Homestay', tour: 'Visite guidée', tutor: 'Tuteur de coréen', blog: 'Blog coréen', masterclass: 'Masterclass', books: 'Livres de coréen' },
    de: { home: 'Startseite', homestay: 'Homestay', tour: 'Geführte Tour', tutor: 'Koreanisch-Tutor', blog: 'Koreanisch-Blog', masterclass: 'Masterclass', books: 'Koreanisch-Bücher' },
    pl: { home: 'Strona główna', homestay: 'Homestay', tour: 'Wycieczka z przewodnikiem', tutor: 'Korepetytor koreańskiego', blog: 'Blog o koreańskim', masterclass: 'Masterclass', books: 'Książki do koreańskiego' }
  };
  // [메뉴 열기, 메뉴 닫기, 로그인, 내 계정, 로그아웃, 사이트 메뉴, 언어]
  var UI = {
    en: ['Open menu', 'Close menu', 'Sign In', 'My Account', 'Sign Out', 'Explore All About Korea', 'Language'],
    ko: ['메뉴 열기', '메뉴 닫기', '로그인', '내 계정', '로그아웃', 'All About Korea 둘러보기', '언어'],
    es: ['Abrir menú', 'Cerrar menú', 'Iniciar sesión', 'Mi cuenta', 'Cerrar sesión', 'Explora All About Korea', 'Idioma'],
    zh: ['打开菜单', '关闭菜单', '登录', '我的账户', '退出登录', '浏览 All About Korea', '语言'],
    ja: ['メニューを開く', 'メニューを閉じる', 'ログイン', 'マイアカウント', 'ログアウト', 'All About Korea のサービス', '言語'],
    fr: ['Ouvrir le menu', 'Fermer le menu', 'Se connecter', 'Mon compte', 'Se déconnecter', 'Découvrir All About Korea', 'Langue'],
    de: ['Menü öffnen', 'Menü schließen', 'Anmelden', 'Mein Konto', 'Abmelden', 'All About Korea entdecken', 'Sprache'],
    pl: ['Otwórz menu', 'Zamknij menu', 'Zaloguj się', 'Moje konto', 'Wyloguj się', 'Odkryj All About Korea', 'Język']
  };

  // 멀티컬러 Google G (Sign In 버튼용) — 외부 아이콘 폰트 의존 없음
  var GOOGLE_G = '<svg class="aak-g" width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">' +
    '<path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"/>' +
    '<path fill="#FF3D00" d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"/>' +
    '<path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"/>' +
    '<path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 0 1-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"/></svg>';

  var CSS = '' +
    '.aak-burger{all:unset;box-sizing:border-box;width:40px;height:40px;border-radius:10px;background:#f1f5f9;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;transition:background .15s}' +
    '.aak-burger:hover{background:#e2e8f0}.aak-burger:focus-visible{outline:2px solid #2563eb;outline-offset:2px}' +
    '.aak-burger svg{width:20px;height:20px;display:block}' +
    '.aak-burger.aak-fixed{position:fixed;top:12px;left:12px;z-index:9990;box-shadow:0 4px 14px rgba(15,23,42,.15);background:#fff}' +
    '.aak-overlay{position:fixed;inset:0;background:rgba(15,23,42,.45);opacity:0;pointer-events:none;transition:opacity .25s ease;z-index:9998}' +
    '.aak-overlay.aak-show{opacity:1;pointer-events:auto}' +
    '.aak-drawer{position:fixed;top:0;left:0;bottom:0;width:280px;max-width:84vw;background:#fff;z-index:9999;transform:translateX(-100%);transition:transform .28s cubic-bezier(.4,0,.2,1);box-shadow:12px 0 32px -12px rgba(0,0,0,.25);display:flex;flex-direction:column;box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans KR","Helvetica Neue",Arial,sans-serif;color:#0f172a;-webkit-font-smoothing:antialiased}' +
    '.aak-drawer.aak-show{transform:translateX(0)}' +
    '.aak-drawer *{box-sizing:border-box}' +
    '.aak-head{display:flex;align-items:center;justify-content:space-between;padding:18px 16px;margin:0;border-bottom:1px solid #e2e8f0}' +
    '.aak-brand{font-weight:800;font-size:17px;letter-spacing:-.2px;color:#0f172a;text-decoration:none;white-space:nowrap}' +
    '.aak-brand span{color:#2563eb}' +
    '.aak-close{all:unset;width:34px;height:34px;border-radius:9px;background:#f1f5f9;display:flex;align-items:center;justify-content:center;cursor:pointer}' +
    '.aak-close:hover{background:#e2e8f0}.aak-close svg{width:16px;height:16px;display:block}' +
    '.aak-nav{padding:10px;margin:0;display:flex;flex-direction:column;gap:2px;overflow-y:auto;flex:1}' +
    '.aak-link{display:flex;align-items:center;gap:14px;padding:12px 12px;margin:0;border-radius:12px;font-weight:500;font-size:15px;line-height:1.3;letter-spacing:-.1px;color:#1d1d1f;text-decoration:none;transition:background .15s,color .15s}' +
    '.aak-link:hover{background:#f5f5f7}' +
    '.aak-link.aak-active{background:#f0f4ff;color:#0071e3;font-weight:600}' +
    '.aak-ico{width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;font-size:18px;line-height:1;flex-shrink:0;color:#86868b;transition:color .15s}' +
    '.aak-ico svg{width:22px;height:22px;display:block}' +
    '.aak-link:hover .aak-ico{color:#1d1d1f}.aak-link.aak-active .aak-ico{color:#0071e3}' +
    '.aak-foot{padding:14px 16px;border-top:1px solid #e2e8f0;font-size:11.5px;color:#64748b;text-align:center}' +
    '.aak-acct{padding:12px 16px;border-top:1px solid #e2e8f0;display:flex;flex-direction:column;gap:8px}' +
    '.aak-acct-email{font-size:12.5px;color:#475569;word-break:break-all}' +
    '.aak-acct-row{display:flex;gap:8px}' +
    '.aak-btn{all:unset;box-sizing:border-box;flex:1;text-align:center;padding:10px 12px;border-radius:10px;font-weight:700;font-size:13.5px;cursor:pointer;font-family:inherit}' +
    '.aak-btn-primary{background:#3d5afe;color:#fff}.aak-btn-primary:hover{background:#2c40c9}' +
    '.aak-btn-ghost{background:#f1f5f9;color:#0f172a}.aak-btn-ghost:hover{background:#e2e8f0}' +
    /* ===== 공통 헤더 위젯 (번역 + 계정) ===== */
    '.aak-authwrap{display:inline-flex;align-items:center;gap:8px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans KR",Arial,sans-serif}' +
    '.aak-lang{position:relative}' +
    '.aak-lang-btn{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;padding:7px 12px;border:1px solid #e2e8f0;border-radius:999px;background:#fff;color:#0f172a;font-size:13px;font-weight:600;line-height:1.2;cursor:pointer;white-space:nowrap;font-family:inherit}' +
    '.aak-lang-btn:hover{border-color:#cbd5e1}' +
    '.aak-lang-flag{font-size:15px;line-height:1}' +
    '.aak-lang-cue{width:12px;height:12px;display:block;opacity:.55}' +
    '.aak-lang-menu{position:absolute;top:calc(100% + 8px);right:0;background:#fff;border:1px solid #e2e8f0;border-radius:14px;box-shadow:0 12px 30px rgba(0,0,0,.12);min-width:190px;padding:6px;display:none;z-index:9995;max-height:min(360px,70vh);overflow-y:auto}' +
    '.aak-lang-menu.aak-open{display:block}' +
    '.aak-lang-item{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:10px;width:100%;padding:9px 10px;border-radius:9px;font-size:14px;color:#0f172a;cursor:pointer;font-family:inherit}' +
    '.aak-lang-item:hover{background:#f5f5f7}' +
    '.aak-lang-item.aak-active{color:#2563eb;font-weight:700}' +
    '.aak-lang-item .flag{font-size:16px;line-height:1}' +
    '.aak-authbtn{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;gap:7px;white-space:nowrap;padding:8px 16px;border-radius:999px;background:#3d5afe;color:#fff !important;font-weight:700;font-size:13px;line-height:1.2;cursor:pointer;font-family:inherit;text-decoration:none}' +
    '.aak-authbtn:hover{background:#2c40c9}' +
    '.aak-authbtn .aak-g{background:#fff;border-radius:50%;padding:2px;box-sizing:content-box;display:block}' +
    '.aak-acct-av{width:20px;height:20px;border-radius:50%;object-fit:cover;display:block}' +
    '@media(max-width:480px){.aak-lang-name{display:none}.aak-lang-btn{padding:7px 10px}}' +
    /* ===== 하단 사이트 링크 ===== */
    '.aak-sitefoot{background:#fff;border-top:1px solid #e2e8f0;padding:24px 16px 28px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans KR",Arial,sans-serif;color:#475569;text-align:center}' +
    '.aak-sitefoot-title{font-size:13px;font-weight:800;color:#0f172a;margin:0 0 10px}' +
    '.aak-sitefoot-links{display:flex;flex-wrap:wrap;justify-content:center;gap:6px 18px;margin:0 auto;max-width:900px;padding:0;list-style:none}' +
    '.aak-sitefoot-links a{font-size:13px;font-weight:600;color:#334155;text-decoration:none}' +
    '.aak-sitefoot-links a:hover{color:#2563eb;text-decoration:underline}' +
    '.aak-sitefoot-copy{font-size:11.5px;margin-top:12px;color:#64748b}' +
    '@media(max-width:899px){.aak-sitefoot{padding-bottom:calc(84px + env(safe-area-inset-bottom,0px))}}' +
    'html.aak-lock,html.aak-lock body{overflow:hidden}';

  var ICON_BURGER = '<svg viewBox="0 0 24 24" fill="none" stroke="#0f172a" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18"/></svg>';
  var ICON_CLOSE  = '<svg viewBox="0 0 24 24" fill="none" stroke="#0f172a" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  var ICON_CHEV   = '<svg class="aak-lang-cue" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';

  function normPath(p) {
    p = (p || '/').toLowerCase().replace(/\/index\.html?$/, '/');
    try { p = decodeURIComponent(p); } catch (e) {}
    return p;
  }
  function pageLang() {
    var l = (document.documentElement.getAttribute('lang') || 'en').toLowerCase().slice(0, 2);
    return l;
  }
  function activeLang() {
    var l = pageLang();
    return supported(l) ? l : 'en';
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function resolveLang() {
    var q = null;
    try { q = new URLSearchParams(location.search).get('lang'); } catch (e) {}
    if (q && supported(q)) return q;
    var ls = null;
    try { ls = localStorage.getItem(LANG_KEY); } catch (e) {}
    if (ls && supported(ls)) return ls;
    var h = (document.documentElement.getAttribute('lang') || '').slice(0, 2).toLowerCase();
    if (supported(h)) return h;
    return 'en';
  }

  function init() {
    if (document.getElementById('aak-drawer')) return;

    var style = document.createElement('style');
    style.id = 'aak-menu-style';
    style.textContent = CSS;
    document.head.appendChild(style);

    var here = normPath(location.pathname);

    // Burger button
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'aak-burger';
    btn.setAttribute('aria-controls', 'aak-drawer');
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = ICON_BURGER;

    var slot = document.querySelector('[data-site-menu]');
    if (slot) { slot.replaceWith(btn); }
    else { btn.classList.add('aak-fixed'); document.body.appendChild(btn); }

    // Overlay + drawer
    var overlay = document.createElement('div');
    overlay.className = 'aak-overlay';

    var drawer = document.createElement('nav');
    drawer.id = 'aak-drawer';
    drawer.className = 'aak-drawer';
    drawer.setAttribute('aria-label', 'Site menu');
    drawer.setAttribute('aria-hidden', 'true');

    var html = '<div class="aak-head"><a class="aak-brand" href="' + MENU_LINKS[0].url + '">All About <span>Korea</span></a>' +
      '<button type="button" class="aak-close">' + ICON_CLOSE + '</button></div><div class="aak-nav">';
    MENU_LINKS.forEach(function (l) {
      var active = false;
      try { active = normPath(new URL(l.url, location.href).pathname) === here; } catch (e) {}
      html += '<a class="aak-link' + (active ? ' aak-active' : '') + '" href="' + l.url + '"' + (active ? ' aria-current="page"' : '') +
        ' data-aak-key="' + l.key + '"><span class="aak-ico" aria-hidden="true">' + iconSvg(l.icon) + '</span><span class="aak-txt">' + l.label + '</span></a>';
    });
    html += '</div><div class="aak-acct" id="aak-acct"></div><div class="aak-foot">© ' + new Date().getFullYear() + ' All About Korea</div>';
    drawer.innerHTML = html;

    document.body.appendChild(overlay);
    document.body.appendChild(drawer);

    var closeBtn = drawer.querySelector('.aak-close');
    function open() {
      drawer.classList.add('aak-show'); overlay.classList.add('aak-show');
      drawer.setAttribute('aria-hidden', 'false'); btn.setAttribute('aria-expanded', 'true');
      document.documentElement.classList.add('aak-lock');
      closeBtn.focus();
    }
    function close() {
      drawer.classList.remove('aak-show'); overlay.classList.remove('aak-show');
      drawer.setAttribute('aria-hidden', 'true'); btn.setAttribute('aria-expanded', 'false');
      document.documentElement.classList.remove('aak-lock');
    }
    btn.addEventListener('click', open);
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', close);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

    // 열려있는 언어 메뉴는 바깥 클릭 시 닫기
    document.addEventListener('click', function () {
      var m = document.querySelectorAll('.aak-lang-menu.aak-open');
      for (var i = 0; i < m.length; i++) m[i].classList.remove('aak-open');
    });

    /* ---------- 언어 전환 ---------- */
    function applyLang(code, silent) {
      if (!supported(code)) code = 'en';
      try { localStorage.setItem(LANG_KEY, code); } catch (e) {}
      window.AAK_LANG = code;
      var changed = (document.documentElement.getAttribute('lang') || '').slice(0, 2).toLowerCase() !== code;
      document.documentElement.setAttribute('lang', code);  // menu/footer/auth 는 MutationObserver 가 다시 그림
      if (!changed) translate();
      if (!silent) {
        try { window.dispatchEvent(new CustomEvent('aak:langchange', { detail: { lang: code } })); } catch (e) {}
      }
    }
    window.AAKMenu = { open: open, close: close, links: MENU_LINKS, setLang: applyLang };

    /* ---------- 번역 (메뉴·푸터·헤더 위젯) ---------- */
    function translate() {
      var lang = pageLang();
      var dict = LABELS[lang];
      drawer.querySelectorAll('.aak-link').forEach(function (a) {
        var k = a.getAttribute('data-aak-key');
        var item = MENU_LINKS.filter(function (l) { return l.key === k; })[0];
        a.querySelector('.aak-txt').textContent = (dict && dict[k]) || (item && item.label) || '';
      });
      var ui = UI[lang] || UI.en;
      btn.setAttribute('aria-label', ui[0]);
      closeBtn.setAttribute('aria-label', ui[1]);
      renderFooter(dict);
      renderAuth();
    }

    /* ---------- 하단 사이트 링크 (data-site-footer) ---------- */
    function renderFooter(dict) {
      var ui = UI[pageLang()] || UI.en;
      document.querySelectorAll('[data-site-footer]').forEach(function (f) {
        f.className = 'aak-sitefoot';
        f.setAttribute('aria-label', 'Site links');
        f.innerHTML = '<p class="aak-sitefoot-title">' + ui[5] + '</p><ul class="aak-sitefoot-links">' +
          MENU_LINKS.map(function (l) {
            return '<li><a href="' + l.url + '">' + ((dict && dict[l.key]) || l.label) + '</a></li>';
          }).join('') + '</ul><p class="aak-sitefoot-copy">© ' + new Date().getFullYear() + ' All About Korea</p>';
      });
    }

    /* ---------- 공통 로그인 상태 ---------- */
    var authUser = null, authReady = false, fbAuth = null, fbSignOut = null;
    function loginHref() {
      var path = location.pathname.replace(/^\/+/, '');
      try { path = decodeURIComponent(path); } catch (e) {}
      return /\.html$/i.test(path) && !/^login\.html$/i.test(path)
        ? LOGIN_URL + '?redirect=' + encodeURIComponent(path) : LOGIN_URL;
    }
    function doSignOut() {
      if (fbAuth && fbSignOut) fbSignOut(fbAuth).then(function () { location.reload(); });
    }

    // 번역 버튼(언어 알약) HTML
    function langPillHtml() {
      var active = activeLang();
      var cur = SUPPORTED[active] || LANGS[0];
      var ui = UI[pageLang()] || UI.en;
      var items = LANGS.map(function (l) {
        return '<button type="button" class="aak-lang-item' + (l.code === active ? ' aak-active' : '') + '" data-aak-lang="' + l.code + '">' +
          '<span class="flag">' + l.flag + '</span><span>' + esc(l.label) + '</span></button>';
      }).join('');
      return '<div class="aak-lang"><button type="button" class="aak-lang-btn" aria-haspopup="true" aria-expanded="false" aria-label="' + esc(ui[6]) + '">' +
        '<span class="aak-lang-flag">' + cur.flag + '</span><span class="aak-lang-name">' + esc(cur.label) + '</span>' + ICON_CHEV +
        '</button><div class="aak-lang-menu" role="menu">' + items + '</div></div>';
    }
    // 계정 버튼 HTML (My Account / Sign In) — 로그인 상태 확인 전엔 비움
    function accountBtnHtml() {
      var ui = UI[pageLang()] || UI.en;
      if (!authReady) return '';
      if (authUser) {
        var av = authUser.photoURL ? '<img class="aak-acct-av" src="' + esc(authUser.photoURL) + '" alt="" referrerpolicy="no-referrer" onerror="this.style.display=\'none\'">' : '';
        return '<a class="aak-authbtn" href="' + ACCOUNT_URL + '">' + av + '<span>' + ui[3] + '</span></a>';
      }
      return '<a class="aak-authbtn" href="' + loginHref() + '">' + GOOGLE_G + '<span>' + ui[2] + '</span></a>';
    }

    function renderAuth() {
      var ui = UI[pageLang()] || UI.en;
      // 서랍(drawer) 안의 계정 영역
      var box = document.getElementById('aak-acct');
      if (box) {
        if (!authReady) box.innerHTML = '';
        else if (authUser) {
          box.innerHTML = '<div class="aak-acct-email"></div><div class="aak-acct-row">' +
            '<a class="aak-btn aak-btn-primary" href="' + ACCOUNT_URL + '">' + ui[3] + '</a>' +
            '<button type="button" class="aak-btn aak-btn-ghost" data-aak-signout>' + ui[4] + '</button></div>';
          box.querySelector('.aak-acct-email').textContent = authUser.email || '';
          box.querySelector('[data-aak-signout]').addEventListener('click', doSignOut);
        } else {
          box.innerHTML = '<a class="aak-btn aak-btn-primary" href="' + loginHref() + '">' + ui[2] + '</a>';
        }
      }
      // 헤더 오른쪽 위젯 (data-site-auth): [번역 버튼][My Account / Sign In]
      document.querySelectorAll('[data-site-auth]').forEach(function (slotEl) {
        slotEl.innerHTML = '<div class="aak-authwrap">' + langPillHtml() + accountBtnHtml() + '</div>';
        // 언어 버튼 동작 연결
        var lbtn = slotEl.querySelector('.aak-lang-btn'), lmenu = slotEl.querySelector('.aak-lang-menu');
        if (lbtn && lmenu) {
          lbtn.addEventListener('click', function (e) {
            e.stopPropagation();
            var opened = lmenu.classList.toggle('aak-open');
            lbtn.setAttribute('aria-expanded', opened ? 'true' : 'false');
          });
          lmenu.querySelectorAll('.aak-lang-item').forEach(function (it) {
            it.addEventListener('click', function (e) {
              e.stopPropagation();
              lmenu.classList.remove('aak-open');
              applyLang(it.getAttribute('data-aak-lang'));
            });
          });
        }
      });
    }

    function initAuth() {
      var base = 'https://www.gstatic.com/firebasejs/' + FB_VERSION + '/';
      Promise.all([import(base + 'firebase-app.js'), import(base + 'firebase-auth.js')]).then(function (m) {
        var appMod = m[0], authMod = m[1];
        var app = appMod.getApps().length ? appMod.getApp() : appMod.initializeApp(FB_CONFIG);
        fbAuth = authMod.getAuth(app);
        fbSignOut = authMod.signOut;
        authMod.onAuthStateChanged(fbAuth, function (u) { authUser = u; authReady = true; renderAuth(); });
      }).catch(function (e) { if (window.console) console.warn('[menu.js] auth unavailable', e); });
    }
    if (document.readyState === 'complete') initAuth(); else window.addEventListener('load', initAuth);

    // 초기 언어 적용: ?lang → localStorage → <html lang> → en
    var L0 = resolveLang();
    applyLang(L0, true);   // 크롬(메뉴/푸터/위젯)만 먼저 맞춤 — 페이지 본문엔 아래에서 신호
    translate();
    if (window.MutationObserver) {
      new MutationObserver(translate).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    }
    // 페이지 어댑터가 모두 등록된 뒤(매크로태스크) 본문 번역 신호 1회
    setTimeout(function () {
      try { window.dispatchEvent(new CustomEvent('aak:langchange', { detail: { lang: window.AAK_LANG || L0 } })); } catch (e) {}
    }, 0);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
