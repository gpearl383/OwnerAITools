/* OwnerAI Tools — cookie consent + tracking loader.
 *
 * Fill in the IDs below to activate tracking. While all IDs are empty this
 * script does nothing: no banner, no cookies, no requests.
 *
 * Consent model:
 *   - Google (GA4 + Ads) loads immediately with Consent Mode v2, all consent
 *     flags defaulted to "denied" (cookieless pings only). Flags flip to
 *     "granted" when the visitor accepts.
 *   - Meta Pixel loads only after the visitor accepts.
 *   - Choice is stored in a first-party cookie for 12 months and can be
 *     changed any time via the "Cookie settings" link in the footer
 *     (any element with data-cookie-settings).
 */
(function () {
  'use strict';

  var GA4_ID = '';        // e.g. 'G-XXXXXXXXXX'  (Google Analytics 4)
  var ADS_ID = '';        // e.g. 'AW-XXXXXXXXXX' (Google Ads)
  var META_PIXEL_ID = ''; // e.g. '1234567890123456' (Meta/Facebook Pixel)

  var COOKIE = 'oat_consent';
  var hasGoogle = !!(GA4_ID || ADS_ID);
  var hasMeta = !!META_PIXEL_ID;
  if (!hasGoogle && !hasMeta) return;

  function getConsent() {
    var m = document.cookie.match(new RegExp('(?:^|; )' + COOKIE + '=([^;]*)'));
    return m ? m[1] : null; // 'granted' | 'denied' | null
  }

  function setConsent(value) {
    var maxAge = 60 * 60 * 24 * 365;
    document.cookie =
      COOKIE + '=' + value + '; max-age=' + maxAge + '; path=/; SameSite=Lax; Secure';
  }

  /* ---------- Google (gtag + Consent Mode v2) ---------- */

  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = gtag;

  if (hasGoogle) {
    gtag('consent', 'default', {
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
      analytics_storage: 'denied',
      wait_for_update: 500,
    });
    gtag('js', new Date());
    if (GA4_ID) gtag('config', GA4_ID);
    if (ADS_ID) gtag('config', ADS_ID);

    var gs = document.createElement('script');
    gs.async = true;
    gs.src = 'https://www.googletagmanager.com/gtag/js?id=' + (GA4_ID || ADS_ID);
    document.head.appendChild(gs);
  }

  function grantGoogle() {
    if (!hasGoogle) return;
    gtag('consent', 'update', {
      ad_storage: 'granted',
      ad_user_data: 'granted',
      ad_personalization: 'granted',
      analytics_storage: 'granted',
    });
  }

  /* ---------- Meta Pixel (loads only on accept) ---------- */

  var metaLoaded = false;
  function loadMeta() {
    if (!hasMeta || metaLoaded) return;
    metaLoaded = true;
    !(function (f, b, e, v, n, t, s) {
      if (f.fbq) return;
      n = f.fbq = function () {
        n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
      };
      if (!f._fbq) f._fbq = n;
      n.push = n; n.loaded = true; n.version = '2.0'; n.queue = [];
      t = b.createElement(e); t.async = true; t.src = v;
      s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
    })(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    window.fbq('init', META_PIXEL_ID);
    window.fbq('track', 'PageView');
  }

  function applyGranted() {
    grantGoogle();
    loadMeta();
  }

  /* ---------- Conversion events ---------- */

  function track(eventName, params, metaEvent) {
    if (hasGoogle) gtag('event', eventName, params || {});
    if (metaLoaded && window.fbq) window.fbq('track', metaEvent || 'Lead');
  }

  function wireEvents() {
    document.addEventListener('click', function (e) {
      var a = e.target && e.target.closest && e.target.closest('a[href]');
      if (!a) return;
      var href = a.getAttribute('href') || '';
      if (href.indexOf('tel:') === 0) {
        track('phone_call_click', { link_url: href }, 'Contact');
      } else if (href.indexOf('cal.com') !== -1) {
        track('booking_click', { link_url: href }, 'Schedule');
      }
    });

    var form = document.getElementById('fallbackForm');
    if (form) {
      form.addEventListener('submit', function () {
        track('generate_lead', { form_id: 'fallbackForm' }, 'Lead');
      });
    }
  }

  /* ---------- Banner UI ---------- */

  var banner = null;

  function hideBanner() {
    if (banner) banner.classList.remove('visible');
  }

  function showBanner() {
    if (banner) { banner.classList.add('visible'); return; }

    var style = document.createElement('style');
    style.textContent =
      '.cookie-banner{position:fixed;left:16px;right:16px;bottom:16px;z-index:200;' +
      'max-width:480px;margin:0 auto;padding:20px 22px;border-radius:14px;' +
      'background:#fff;border:1px solid rgba(20,53,94,.16);' +
      'box-shadow:0 18px 50px rgba(20,53,94,.35);' +
      'font-family:"Source Sans 3",ui-sans-serif,system-ui,sans-serif;font-size:.86rem;line-height:1.55;color:#3d5169;' +
      'opacity:0;transform:translateY(12px);pointer-events:none;transition:opacity .3s ease,transform .3s ease}' +
      '.cookie-banner.visible{opacity:1;transform:none;pointer-events:auto}' +
      '.cookie-banner a{color:#1a66b0;text-decoration:underline;text-underline-offset:2px}' +
      '.cookie-banner-actions{display:flex;gap:10px;margin-top:14px}' +
      '.cookie-banner-actions button{flex:1;padding:10px 14px;border-radius:999px;cursor:pointer;' +
      'font-family:inherit;font-size:.86rem;font-weight:700;transition:opacity .15s ease}' +
      '.cookie-accept{background:#f97125;border:1px solid #f97125;color:#fff}' +
      '.cookie-decline{background:#fff;border:1px solid rgba(20,53,94,.3);color:#3d5169}' +
      '.cookie-banner-actions button:hover{opacity:.85}';
    document.head.appendChild(style);

    banner = document.createElement('div');
    banner.className = 'cookie-banner';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', 'Cookie consent');
    banner.innerHTML =
      'We use cookies for analytics and advertising to understand how the site is used ' +
      'and measure our ads. See our <a href="/privacy#privacy">Privacy Policy</a>.' +
      '<div class="cookie-banner-actions">' +
      '<button type="button" class="cookie-decline">Decline</button>' +
      '<button type="button" class="cookie-accept">Accept</button>' +
      '</div>';
    document.body.appendChild(banner);

    banner.querySelector('.cookie-accept').addEventListener('click', function () {
      setConsent('granted');
      applyGranted();
      hideBanner();
    });
    banner.querySelector('.cookie-decline').addEventListener('click', function () {
      setConsent('denied');
      hideBanner();
    });

    requestAnimationFrame(function () { banner.classList.add('visible'); });
  }

  /* ---------- Init ---------- */

  function init() {
    wireEvents();

    document.querySelectorAll('[data-cookie-settings]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.preventDefault();
        showBanner();
      });
    });

    var choice = getConsent();
    if (choice === 'granted') {
      applyGranted();
    } else if (choice === null) {
      // Honor Global Privacy Control: treat as an automatic decline.
      if (navigator.globalPrivacyControl) setConsent('denied');
      else showBanner();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
