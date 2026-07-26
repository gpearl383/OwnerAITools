/* OwnerAI shared marketing page behaviors */
(function () {
  const nav = document.getElementById('nav');
  if (nav) {
    const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });

    const toggle = nav.querySelector('.nav-toggle');
    const menu = document.getElementById('nav-menu');
    if (toggle && menu) {
      const setOpen = (open) => {
        nav.classList.toggle('is-open', open);
        document.body.classList.toggle('nav-open', open);
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
      };
      const close = () => setOpen(false);
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        setOpen(!nav.classList.contains('is-open'));
      });
      menu.querySelectorAll('a').forEach((link) => {
        link.addEventListener('click', close);
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') close();
      });
      document.addEventListener('click', (e) => {
        if (!nav.classList.contains('is-open')) return;
        if (nav.contains(e.target)) return;
        close();
      });
      window.addEventListener('resize', () => {
        if (window.matchMedia('(min-width: 961px)').matches) close();
      });
    }
  }

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
  document.querySelectorAll('.reveal').forEach((el) => observer.observe(el));

  document.querySelectorAll('.faq-item').forEach((item) => {
    const btn = item.querySelector('.faq-q');
    const answer = item.querySelector('.faq-a');
    if (!btn || !answer) return;
    btn.addEventListener('click', () => {
      const isOpen = item.classList.contains('open');
      document.querySelectorAll('.faq-item.open').forEach((other) => {
        other.classList.remove('open');
        const a = other.querySelector('.faq-a');
        const q = other.querySelector('.faq-q');
        if (a) a.style.maxHeight = null;
        if (q) q.setAttribute('aria-expanded', 'false');
      });
      if (!isOpen) {
        item.classList.add('open');
        answer.style.maxHeight = answer.scrollHeight + 'px';
        btn.setAttribute('aria-expanded', 'true');
      }
    });
  });

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fmt = (el, val) => {
    el.textContent = (el.dataset.prefix || '') + Math.round(val).toLocaleString('en-US') + (el.dataset.suffix || '');
  };
  const counterObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      counterObserver.unobserve(entry.target);
      const el = entry.target;
      const target = Number(el.dataset.count);
      if (reducedMotion) { fmt(el, target); return; }
      const t0 = performance.now();
      const dur = 1400;
      const tick = (t) => {
        const p = Math.min(1, (t - t0) / dur);
        fmt(el, target * (1 - Math.pow(1 - p, 3)));
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }, { threshold: 0.5 });
  document.querySelectorAll('.cnt[data-count]').forEach((el) => counterObserver.observe(el));

  const roiCalls = document.getElementById('roi-calls');
  const roiValue = document.getElementById('roi-value');
  if (roiCalls && roiValue) {
    const updateRoi = () => {
      const calls = Number(roiCalls.value);
      const value = Number(roiValue.value);
      const lost = Math.round(calls * 4.33 * value);
      const callsOut = document.getElementById('roi-calls-out');
      const valueOut = document.getElementById('roi-value-out');
      const lostEl = document.getElementById('roi-lost');
      const note = document.getElementById('roi-note');
      if (callsOut) callsOut.textContent = calls;
      if (valueOut) valueOut.textContent = '$' + value.toLocaleString('en-US');
      if (lostEl) lostEl.textContent = '$' + lost.toLocaleString('en-US');
      if (note) {
        note.innerHTML = value >= 400
          ? 'Win back just <strong>one</strong> of those jobs a month and the service typically pays for itself — with change.'
          : 'Win back a couple of those jobs a month and the service typically pays for itself.';
      }
    };
    [roiCalls, roiValue].forEach((el) => el.addEventListener('input', updateRoi));
    updateRoi();
  }

  const fallbackForm = document.getElementById('fallbackForm');
  if (fallbackForm) {
    fallbackForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const btn = document.getElementById('f-submit');
      const errEl = document.getElementById('f-error');
      const name = document.getElementById('f-name').value.trim();
      const phone = document.getElementById('f-phone').value.trim();
      const biz = document.getElementById('f-biz').value.trim();
      const smsConsent = document.getElementById('f-sms-consent').checked;
      if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
      if (!name || !phone || !biz) return;
      if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lead: {
              name,
              phone,
              business: biz,
              page: location.href,
              source: 'callback_form',
              sms_consent: smsConsent,
            },
          }),
        });
        if (!res.ok) throw new Error('bad status');
        form.innerHTML =
          '<h3>Got it — we\'ll call you.</h3>' +
          '<p class="form-sub">Thanks' + (name ? ', ' + name.replace(/[<>&]/g, '') : '') +
          '. We\'ll reach out within one business day. Prefer to hear it now? Call the live demo: ' +
          '<a href="tel:+15169731973">(516) 973-1973</a> · ' +
          '<a href="https://cal.com/owneraitools/30min" target="_blank" rel="noopener">Book a free setup call</a>.</p>';
      } catch {
        if (btn) { btn.disabled = false; btn.textContent = 'Request a callback'; }
        if (errEl) {
          errEl.style.display = 'block';
          errEl.innerHTML =
            'Something went wrong. Email us at ' +
            '<a href="mailto:info@owneraitools.com">info@owneraitools.com</a> or call ' +
            '<a href="tel:+15169731973">(516) 973-1973</a>.';
        }
      }
    });
  }
})();
