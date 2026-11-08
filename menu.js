/*!
 * All About Korea — shared burger menu (menu.js)
 * ------------------------------------------------------------
 * 버거 메뉴 링크는 이 파일의 MENU_LINKS 만 수정하면
 * 이 파일을 불러오는 모든 페이지에 자동 반영됩니다.
 *
 * 업로드 위치:  https://www.businesskorean.com/menu.js  (사이트 루트)
 * 각 페이지에서: <script src="https://www.businesskorean.com/menu.js" defer></script>
 * 버거 버튼 위치: <div data-site-menu></div>  (없으면 화면 왼쪽 위에 고정 표시)
 * ------------------------------------------------------------
 */
(function () {
  'use strict';

  /* ============ ✏️ 여기만 수정하세요 ============ */
  var MENU_LINKS = [
    { key: 'home',        icon: '🏠', label: 'Home',         url: 'https://www.businesskorean.com/' },
    { key: 'homestay',    icon: '🏡', label: 'Homestay',     url: 'https://www.businesskorean.com/homestay/homestay.html' },
    { key: 'tour',        icon: '🧭', label: 'Guided Tour',  url: 'https://www.businesskorean.com/guidedtour/guidedtour.html' },
    { key: 'tutor',       icon: '👩‍🏫', label: 'Korean Tutor', url: 'https://www.businesskorean.com/tutor/tutor.html' },
    { key: 'blog',        icon: '📝', label: 'Korean Blog',  url: 'https://www.businesskorean.com/blog/blog.html' },
    { key: 'masterclass', icon: '🎓', label: 'Masterclass',  url: 'https://www.businesskorean.com/masterclass/masterclass.html' },
    { key: 'books',       icon: '📚', label: 'Korean Books', url: 'https://www.businesskorean.com/bookstore/bookstore.html' }
  ];
  /* ============================================= */

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
  // [메뉴 열기, 메뉴 닫기, 로그인, 내 계정, 로그아웃, 사이트 메뉴]
  var UI = {
    en: ['Open menu', 'Close menu', 'Sign In', 'My Account', 'Sign Out', 'Explore All About Korea'],
    ko: ['메뉴 열기', '메뉴 닫기', '로그인', '내 계정', '로그아웃', 'All About Korea 둘러보기'],
    es: ['Abrir menú', 'Cerrar menú', 'Iniciar sesión', 'Mi cuenta', 'Cerrar sesión', 'Explora All About Korea'],
    zh: ['打开菜单', '关闭菜单', '登录', '我的账户', '退出登录', '浏览 All About Korea'],
    ja: ['メニューを開く', 'メニューを閉じる', 'ログイン', 'マイアカウント', 'ログアウト', 'All About Korea のサービス'],
    fr: ['Ouvrir le menu', 'Fermer le menu', 'Se connecter', 'Mon compte', 'Se déconnecter', 'Découvrir All About Korea'],
    de: ['Menü öffnen', 'Menü schließen', 'Anmelden', 'Mein Konto', 'Abmelden', 'All About Korea entdecken'],
    pl: ['Otwórz menu', 'Zamknij menu', 'Zaloguj się', 'Moje konto', 'Wyloguj się', 'Odkryj All About Korea']
  };

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
    '.aak-link{display:flex;align-items:center;gap:14px;padding:13px 12px;margin:0;border-radius:12px;font-weight:600;font-size:15px;line-height:1.3;color:#0f172a;text-decoration:none;transition:background .15s}' +
    '.aak-link:hover{background:#f8fafc}' +
    '.aak-link.aak-active{background:#eef2ff;color:#2563eb}' +
    '.aak-ico{width:24px;text-align:center;font-size:18px;line-height:1;flex-shrink:0}' +
    '.aak-foot{padding:14px 16px;border-top:1px solid #e2e8f0;font-size:11.5px;color:#64748b;text-align:center}' +
    '.aak-acct{padding:12px 16px;border-top:1px solid #e2e8f0;display:flex;flex-direction:column;gap:8px}' +
    '.aak-acct-email{font-size:12.5px;color:#475569;word-break:break-all}' +
    '.aak-acct-row{display:flex;gap:8px}' +
    '.aak-btn{all:unset;box-sizing:border-box;flex:1;text-align:center;padding:10px 12px;border-radius:10px;font-weight:700;font-size:13.5px;cursor:pointer;font-family:inherit}' +
    '.aak-btn-primary{background:#3d5afe;color:#fff}.aak-btn-primary:hover{background:#2c40c9}' +
    '.aak-btn-ghost{background:#f1f5f9;color:#0f172a}.aak-btn-ghost:hover{background:#e2e8f0}' +
    '.aak-authbtn{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;white-space:nowrap;padding:8px 16px;border-radius:999px;background:#3d5afe;color:#fff !important;font-weight:700;font-size:13px;line-height:1.2;cursor:pointer;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans KR",Arial,sans-serif;text-decoration:none}' +
    '.aak-authbtn:hover{background:#2c40c9}' +
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

  function normPath(p) {
    p = (p || '/').toLowerCase().replace(/\/index\.html?$/, '/');
    try { p = decodeURIComponent(p); } catch (e) {}
    return p;
  }
  function pageLang() {
    var l = (document.documentElement.getAttribute('lang') || 'en').toLowerCase().slice(0, 2);
    return l;
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
        ' data-aak-key="' + l.key + '"><span class="aak-ico" aria-hidden="true">' + l.icon + '</span><span class="aak-txt">' + l.label + '</span></a>';
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
    window.AAKMenu = { open: open, close: close, links: MENU_LINKS };

    // Translate labels to the page language
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
    function renderAuth() {
      var ui = UI[pageLang()] || UI.en;
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
      // 헤더 로그인 버튼 자리 (data-site-auth) — 로그인 기능이 없던 페이지용
      document.querySelectorAll('[data-site-auth]').forEach(function (slot) {
        if (!authReady) { slot.innerHTML = ''; return; }
        slot.innerHTML = authUser
          ? '<a class="aak-authbtn" href="' + ACCOUNT_URL + '">' + ui[3] + '</a>'
          : '<a class="aak-authbtn" href="' + loginHref() + '">' + ui[2] + '</a>';
      });
    }
    function initAuth() {
      var base = 'https://www.gstatic.com/firebasejs/' + FB_VERSION + '/';
      Promise.all([import(base + 'firebase-app.js'), import(base + 'firebase-auth.js')]).then(function (m) {
        var appMod = m[0], authMod = m[1];
        // 페이지가 이미 Firebase 를 초기화했다면 그 앱을 그대로 사용 (같은 로그인 세션 공유)
        var app = appMod.getApps().length ? appMod.getApp() : appMod.initializeApp(FB_CONFIG);
        fbAuth = authMod.getAuth(app);
        fbSignOut = authMod.signOut;
        authMod.onAuthStateChanged(fbAuth, function (u) { authUser = u; authReady = true; renderAuth(); });
      }).catch(function (e) { if (window.console) console.warn('[menu.js] auth unavailable', e); });
    }
    // 페이지 자체의 Firebase 초기화가 끝난 뒤(load) 연결
    if (document.readyState === 'complete') initAuth(); else window.addEventListener('load', initAuth);

    translate();
    if (window.MutationObserver) {
      new MutationObserver(translate).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
