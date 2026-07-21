/* OwnerAI Tools — website chat widget.
 *
 * Talks to /api/chat (Anthropic proxy; system prompt server-side). Lead
 * capture posts to the same endpoint, which emails info@owneraitools.com via
 * Resend. Mounts lazily on first scroll / pointer move / 8s so it never
 * competes with page load.
 */
(function () {
  'use strict';

  var API = '/api/chat';
  var DEMO_TEL = '+15169731973';
  var DEMO_DISPLAY = '(516) 973-1973';
  var CAL_URL = 'https://cal.com/owneraitools/30min';

  var GREETING =
    "Hi — I'm the OwnerAI Assistant. I can explain how our AI receptionist answers your business's calls 24/7, walk you through pricing, or get you set up. Fair warning: I'm the same technology that answers our phones. What kind of business do you run?";

  var QUICK = [
    'How much does it cost?',
    'How does setup work?',
    'Will callers know it\u2019s AI?',
  ];

  var mounted = false;
  var messages = [];
  var userTurns = 0;
  var leadShown = false;
  var leadSent = false;

  var CSS =
    '#oat-chat .cw-launch{position:fixed;right:20px;bottom:20px;z-index:150;display:flex;align-items:center;gap:10px;' +
    'background:#f97125;color:#fff;border:1px solid #f97125;border-radius:999px;padding:13px 22px 13px 16px;' +
    'font-family:"Source Sans 3",ui-sans-serif,system-ui,sans-serif;font-size:.95rem;font-weight:700;cursor:pointer;' +
    'box-shadow:0 14px 34px -8px rgba(226,90,18,.5);transition:transform .22s cubic-bezier(.34,1.56,.64,1);' +
    'animation:cw-pop .45s cubic-bezier(.34,1.56,.64,1) both}' +
    '#oat-chat .cw-launch:hover{transform:translateY(-2px) scale(1.03)}' +
    '#oat-chat .cw-launch svg{flex:none}' +
    '#oat-chat .cw-badge{position:absolute;top:-3px;right:-1px;width:12px;height:12px;border-radius:50%;' +
    'background:#22a06b;border:2px solid #fff}' +
    '#oat-chat .cw-badge::after{content:"";position:absolute;inset:-2px;border-radius:50%;border:2px solid #22a06b;' +
    'animation:cw-ping 2.2s ease-out infinite}' +
    '@keyframes cw-ping{0%{transform:scale(1);opacity:.8}70%,100%{transform:scale(2.1);opacity:0}}' +
    '@keyframes cw-pop{from{transform:translateY(14px) scale(.9);opacity:0}to{transform:translateY(0) scale(1);opacity:1}}' +
    '#oat-chat .cw-teaser{position:fixed;right:20px;bottom:84px;z-index:150;max-width:270px;background:#fff;' +
    'border:1px solid rgba(20,53,94,.16);border-radius:14px 14px 4px 14px;padding:14px 34px 14px 16px;' +
    'font-family:"Source Sans 3",ui-sans-serif,system-ui,sans-serif;font-size:.9rem;line-height:1.45;color:#3d5169;' +
    'box-shadow:0 18px 40px -12px rgba(20,53,94,.35);cursor:pointer;animation:cw-pop .45s cubic-bezier(.34,1.56,.64,1) both}' +
    '#oat-chat .cw-teaser strong{display:block;margin-bottom:2px;color:#14355e}' +
    '#oat-chat .cw-teaser-x{position:absolute;top:6px;right:8px;background:none;border:0;color:#5a6b81;' +
    'font-size:.95rem;cursor:pointer;padding:2px 4px}' +
    '#oat-chat .cw-win{position:fixed;right:20px;bottom:88px;z-index:151;width:min(390px,calc(100vw - 32px));' +
    'height:min(600px,calc(100dvh - 120px));background:#fff;border:1px solid rgba(20,53,94,.16);border-radius:16px;' +
    'box-shadow:0 30px 70px -18px rgba(20,53,94,.4);display:none;flex-direction:column;' +
    'overflow:hidden;font-family:"Source Sans 3",ui-sans-serif,system-ui,sans-serif}' +
    '#oat-chat .cw-win.open{display:flex}' +
    '#oat-chat .cw-head{background:#14355e;color:#fff;padding:15px 18px;display:flex;justify-content:space-between;' +
    'align-items:center;border-bottom:1px solid rgba(255,255,255,.12)}' +
    '#oat-chat .cw-head strong{font-size:.98rem;display:flex;align-items:center;gap:8px}' +
    '#oat-chat .cw-dot{width:8px;height:8px;border-radius:50%;background:#4ade80;flex:none}' +
    '#oat-chat .cw-head p{margin:3px 0 0;font-size:.76rem;color:#b9c6dd}' +
    '#oat-chat .cw-x{background:none;border:0;color:#d7ddea;font-size:1.1rem;cursor:pointer;padding:4px 8px}' +
    '#oat-chat .cw-body{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px;background:#f2f7fc}' +
    '#oat-chat .cw-msg{max-width:85%;padding:10px 14px;border-radius:12px;font-size:.92rem;line-height:1.5;white-space:pre-wrap;overflow-wrap:break-word}' +
    '#oat-chat .cw-msg--bot{background:#fff;border:1px solid rgba(20,53,94,.12);color:#3d5169;align-self:flex-start;border-bottom-left-radius:4px}' +
    '#oat-chat .cw-msg--user{background:#d9ebfa;border:1px solid #b6d8f5;color:#17528e;align-self:flex-end;border-bottom-right-radius:4px}' +
    '#oat-chat .cw-msg a{color:#1a66b0}' +
    '#oat-chat .cw-quick{display:flex;flex-wrap:wrap;gap:8px}' +
    '#oat-chat .cw-quick button{font-family:inherit;font-size:.82rem;padding:7px 12px;border:1px solid #1a66b0;' +
    'color:#1a66b0;background:#fff;border-radius:999px;cursor:pointer;font-weight:600}' +
    '#oat-chat .cw-quick button:hover{background:#eef6fd}' +
    '#oat-chat .cw-lead{display:flex;flex-direction:column;gap:8px;background:#fff;border:1px solid rgba(20,53,94,.12);' +
    'border-radius:12px;padding:14px}' +
    '#oat-chat .cw-lead input{font-family:inherit;font-size:16px;padding:10px 12px;border:1px solid rgba(20,53,94,.2);' +
    'border-radius:8px;background:#fff;color:#24384f}' +
    '#oat-chat .cw-lead input::placeholder{color:rgba(90,107,129,.55)}' +
    '#oat-chat .cw-lead button{font-family:inherit;font-size:.9rem;font-weight:700;margin-top:2px;padding:11px 14px;' +
    'border-radius:999px;border:1px solid #f97125;background:#f97125;color:#fff;cursor:pointer}' +
    '#oat-chat .cw-lead button:hover{background:#e25a12;border-color:#e25a12}' +
    '#oat-chat .cw-foot{display:flex;gap:8px;padding:12px;border-top:1px solid rgba(20,53,94,.12);background:#fff}' +
    '#oat-chat .cw-input{flex:1;font-family:inherit;font-size:16px;padding:11px 14px;border:1px solid rgba(20,53,94,.2);' +
    'border-radius:9px;background:#fff;color:#24384f}' +
    '#oat-chat .cw-input::placeholder{color:rgba(90,107,129,.55)}' +
    '#oat-chat .cw-send{background:#f97125;color:#fff;border:0;border-radius:9px;padding:0 18px;font-family:inherit;' +
    'font-weight:700;cursor:pointer}' +
    '#oat-chat .cw-send:hover{background:#e25a12}' +
    '#oat-chat .cw-typing{font-size:.85rem;color:#5a6b81;align-self:flex-start;padding:4px 6px}' +
    '@media (max-width:480px){#oat-chat .cw-win{left:8px;right:8px;bottom:80px;width:auto}}' +
    '@media (prefers-reduced-motion:reduce){#oat-chat .cw-launch,#oat-chat .cw-teaser{animation:none}' +
    '#oat-chat .cw-badge::after{animation:none;display:none}}';

  function mount() {
    if (mounted) return;
    mounted = true;

    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    var root = document.createElement('div');
    root.id = 'oat-chat';
    root.innerHTML =
      '<button class="cw-launch" aria-label="Open chat with the OwnerAI Assistant">' +
      '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>' +
      'Chat with us' +
      '<span class="cw-badge" aria-hidden="true"></span>' +
      '</button>' +
      '<div class="cw-win" role="dialog" aria-label="OwnerAI Assistant chat">' +
      '<div class="cw-head">' +
      '<div><strong><span class="cw-dot"></span>OwnerAI Assistant</strong><p>The same AI that answers our phones</p></div>' +
      '<button class="cw-x" aria-label="Close chat">\u2715</button>' +
      '</div>' +
      '<div class="cw-body"></div>' +
      '<div class="cw-foot">' +
      '<input class="cw-input" type="text" placeholder="Type your question\u2026" aria-label="Your message" />' +
      '<button class="cw-send">Send</button>' +
      '</div></div>';
    document.body.appendChild(root);

    var launch = root.querySelector('.cw-launch');
    var win = root.querySelector('.cw-win');
    var body = root.querySelector('.cw-body');
    var input = root.querySelector('.cw-input');

    function esc(s) {
      return s.replace(/[&<>"]/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
      });
    }

    // Bot messages: escape first, then linkify the demo number and cal.com.
    function botHtml(text) {
      var h = esc(text);
      h = h.replace(/\(516\)\s?973-1973/g, '<a href="tel:' + DEMO_TEL + '">' + DEMO_DISPLAY + '</a>');
      h = h.replace(/https:\/\/cal\.com\/owneraitools\/30min/g, '<a href="' + CAL_URL + '" target="_blank" rel="noopener">cal.com/owneraitools/30min</a>');
      return h;
    }

    function add(cls, html) {
      var el = document.createElement('div');
      el.className = 'cw-msg cw-msg--' + cls;
      el.innerHTML = html;
      body.appendChild(el);
      body.scrollTop = body.scrollHeight;
      return el;
    }

    function showQuick() {
      var q = document.createElement('div');
      q.className = 'cw-quick';
      QUICK.forEach(function (t) {
        var b = document.createElement('button');
        b.textContent = t;
        b.onclick = function () {
          q.remove();
          send(t);
        };
        q.appendChild(b);
      });
      body.appendChild(q);
      body.scrollTop = body.scrollHeight;
    }

    function showLeadForm() {
      leadShown = true;
      add(
        'bot',
        'Want us to follow up directly? Leave your details below \u2014 or book a free setup call at ' +
          '<a href="' + CAL_URL + '" target="_blank" rel="noopener">cal.com/owneraitools/30min</a>.'
      );
      var f = document.createElement('div');
      f.className = 'cw-lead';
      f.innerHTML =
        '<input type="text" placeholder="Name" aria-label="Name" />' +
        '<input type="tel" placeholder="Phone number" aria-label="Phone number" />' +
        '<input type="text" placeholder="What does your business do?" aria-label="Business" />' +
        '<button>Request a callback</button>';
      var inputs = f.querySelectorAll('input');
      f.querySelector('button').onclick = function () {
        var name = inputs[0].value.trim();
        var phone = inputs[1].value.trim();
        var business = inputs[2].value.trim();
        if (!name || !phone) return;
        if (!leadSent) {
          leadSent = true;
          fetch(API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              lead: { name: name, phone: phone, business: business, page: location.href },
              transcript: messages,
            }),
          }).catch(function () {});
        }
        f.remove();
        add('bot', 'Got it \u2014 we\u2019ll reach out shortly. If you want to hear the receptionist right now, call the demo line: <a href="tel:' + DEMO_TEL + '">' + DEMO_DISPLAY + '</a>.');
      };
      body.appendChild(f);
      body.scrollTop = body.scrollHeight;
    }

    function send(text) {
      text = text.trim();
      if (!text) return;
      input.value = '';
      add('user', esc(text));
      messages.push({ role: 'user', content: text });
      userTurns++;
      var typing = document.createElement('div');
      typing.className = 'cw-typing';
      typing.textContent = '\u2026';
      body.appendChild(typing);
      body.scrollTop = body.scrollHeight;
      fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: messages }),
      })
        .then(function (res) { return res.json(); })
        .then(function (data) {
          typing.remove();
          var reply =
            (data.content && data.content[0] && data.content[0].text) ||
            'I hit a snag \u2014 please try again, or call us at ' + DEMO_DISPLAY + '.';
          add('bot', botHtml(reply));
          messages.push({ role: 'assistant', content: reply });
          if (userTurns >= 3 && !leadShown) setTimeout(showLeadForm, 700);
        })
        .catch(function () {
          typing.remove();
          add('bot', 'Connection issue \u2014 please try again in a moment.');
        });
    }

    function removeTeaser() {
      var t = root.querySelector('.cw-teaser');
      if (t) t.remove();
    }

    function openChat() {
      removeTeaser();
      var opening = !win.classList.contains('open');
      win.classList.toggle('open');
      if (opening && messages.length === 0) {
        add('bot', esc(GREETING));
        showQuick();
        if (window.matchMedia('(min-width: 640px)').matches) input.focus();
      }
    }

    // Teaser bubble: once per session, a few seconds after mount.
    if (!sessionStorage.getItem('oatChatTeaser')) {
      setTimeout(function () {
        if (win.classList.contains('open')) return;
        sessionStorage.setItem('oatChatTeaser', '1');
        var t = document.createElement('div');
        t.className = 'cw-teaser';
        t.setAttribute('role', 'status');
        t.innerHTML =
          '<strong>Questions about pricing or setup?</strong>' +
          'Ask the OwnerAI Assistant \u2014 answers in seconds.' +
          '<button class="cw-teaser-x" aria-label="Dismiss">\u2715</button>';
        t.querySelector('.cw-teaser-x').onclick = function (e) {
          e.stopPropagation();
          t.remove();
        };
        t.onclick = openChat;
        root.appendChild(t);
        setTimeout(function () { t.remove(); }, 20000);
      }, 4000);
    }

    launch.onclick = openChat;
    root.querySelector('.cw-x').onclick = function () { win.classList.remove('open'); };
    root.querySelector('.cw-send').onclick = function () { send(input.value); };
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') send(input.value);
    });
  }

  // Defer mounting: first scroll, first pointer move, or 8s — whichever first.
  function arm() {
    mount();
    window.removeEventListener('scroll', arm);
    window.removeEventListener('pointermove', arm);
  }
  window.addEventListener('scroll', arm, { once: true, passive: true });
  window.addEventListener('pointermove', arm, { once: true });
  setTimeout(arm, 8000);
})();
