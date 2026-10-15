/**
 * Missed-call revenue calculator.
 * Kept jobs = pickups − already hired.
 * Lost jobs = missed − kept.
 * Monthly = weekly jobs × job value × 52 ÷ 12.
 */
(function (root) {
  const WEEKS_PER_MONTH = 52 / 12;

  function clampInputs(raw) {
    const missed = Math.min(100, Math.max(0, Math.round(Number(raw.missed) || 0)));
    let called = Math.min(100, Math.max(0, Math.round(Number(raw.called) || 0)));
    let pickup = Math.min(100, Math.max(0, Math.round(Number(raw.pickup) || 0)));
    let hired = Math.min(100, Math.max(0, Math.round(Number(raw.hired) || 0)));
    const value = Math.min(10000, Math.max(50, Math.round(Number(raw.value) || 0)));
    let clamped = false;
    if (called > missed) { called = missed; clamped = true; }
    if (pickup > called) { pickup = called; clamped = true; }
    if (hired > pickup) { hired = pickup; clamped = true; }
    return { missed, called, pickup, hired, value, clamped };
  }

  function compute(raw) {
    const v = clampInputs(raw);
    const never = v.missed - v.called;
    const silent = v.called - v.pickup;
    const kept = v.pickup - v.hired;
    const lostJobs = never + silent + v.hired;
    const month = (jobs) => Math.round(jobs * v.value * WEEKS_PER_MONTH);
    const year = (jobs) => Math.round(jobs * v.value * 52);
    return {
      ...v,
      never,
      silent,
      kept,
      lostJobs,
      lostMonth: month(lostJobs),
      keptMonth: month(kept),
      neverMonth: month(never),
      silentMonth: month(silent),
      hiredMonth: month(v.hired),
      lostYear: year(lostJobs),
      offeringMonth: month(v.missed)
    };
  }

  function money(n) {
    return '$' + Math.round(n).toLocaleString('en-US');
  }

  function nText(n, one, many) {
    return n === 1 ? one : n + ' ' + many;
  }

  function paint(result) {
    const big = document.getElementById('mcc-big');
    const label = document.getElementById('mcc-label');
    const story = document.getElementById('mcc-story');
    const rows = document.getElementById('mcc-rows');
    const year = document.getElementById('mcc-year');
    const payoff = document.getElementById('mcc-payoff');
    const split = document.getElementById('mcc-split');
    const legend = document.getElementById('mcc-legend');
    const clampNote = document.getElementById('mcc-clamp');
    if (!big) return;

    if (clampNote) clampNote.hidden = !result.clamped;

    if (result.missed === 0) {
      big.textContent = '$0';
      if (label) label.textContent = 'Nothing to lose on these inputs.';
      if (story) story.textContent = 'Set the missed calls above zero to see the week.';
      if (split) split.hidden = true;
      if (legend) legend.hidden = true;
      if (rows) rows.innerHTML = '';
      if (year) year.textContent = '';
      if (payoff) payoff.textContent = '';
      return;
    }

    if (split) {
      split.hidden = false;
      const lostEl = document.getElementById('mcc-split-lost');
      const keptEl = document.getElementById('mcc-split-kept');
      if (lostEl) lostEl.style.width = (result.lostJobs / result.missed * 100) + '%';
      if (keptEl) keptEl.style.width = (result.kept / result.missed * 100) + '%';
    }
    if (legend) {
      legend.hidden = false;
      const lostL = document.getElementById('mcc-legend-lost');
      const keptL = document.getElementById('mcc-legend-kept');
      if (lostL) lostL.textContent = result.lostJobs + ' of ' + result.missed + ' calls';
      if (keptL) keptL.textContent = result.kept + ' of ' + result.missed;
    }

    big.textContent = money(result.lostMonth);
    if (label) {
      label.textContent = result.lostJobs === 0
        ? 'a month. On these numbers, calling back keeps every job.'
        : 'a month, from customer calls that do not become your job';
    }
    if (story) {
      story.textContent =
        'You miss ' + nText(result.missed, '1 customer call', result.missed + ' customer calls') + ' a week. ' +
        'You call ' + nText(result.called, '1 back', result.called + ' back') + '. ' +
        nText(result.pickup, '1 picks up', result.pickup + ' pick up') + '. ' +
        nText(result.hired, '1 of those already hired someone else', result.hired + ' of those already hired someone else') + '. ' +
        'You keep ' + nText(result.kept, '1 job', result.kept + ' jobs') + '.';
    }

    const rowData = [
      { title: nText(result.never, '1 never called back', result.never + ' never called back'), sub: 'They hung up and called the next name.', jobs: result.never, amount: result.neverMonth, cls: 'never' },
      { title: nText(result.silent, '1 you called, and they did not pick up', result.silent + ' you called, and they did not pick up'), sub: 'You tried. The conversation never happened.', jobs: result.silent, amount: result.silentMonth, cls: 'silent' },
      { title: nText(result.hired, '1 picked up, and the job was already taken', result.hired + ' picked up, and the job was already taken'), sub: 'You reached them. Someone else had already been hired.', jobs: result.hired, amount: result.hiredMonth, cls: 'taken' },
      { title: nText(result.kept, '1 was still waiting. You keep that job.', result.kept + ' were still waiting. You keep those jobs.'), sub: 'Called back, picked up, and had not hired anyone else.', jobs: result.kept, amount: result.keptMonth, cls: 'kept', keep: true }
    ];

    if (rows) {
      rows.innerHTML = rowData.map((row) => {
        const width = (row.jobs / result.missed) * 100;
        return '<div class="mcc-row' + (row.keep ? ' keep' : '') + '">' +
          '<i class="mcc-swatch ' + row.cls + '" aria-hidden="true"></i>' +
          '<div class="mcc-row-copy"><div class="mcc-row-title">' + row.title + '</div>' +
          '<div class="mcc-row-sub">' + row.sub + '</div>' +
          '<div class="mcc-bar"><span class="' + row.cls + '" style="width:' + width + '%"></span></div></div>' +
          '<div class="mcc-row-money">' + money(row.amount) + (row.keep ? ' kept' : '') + '</div></div>';
      }).join('');
    }

    if (year) {
      year.innerHTML = 'About <strong>' + money(result.lostYear) + '</strong> a year at this pace. Callbacks still save <strong>' + money(result.keptMonth) + '</strong> a month.';
    }
    if (payoff) {
      payoff.textContent = result.lostJobs === 0
        ? 'That only holds if you call every one back, they all pick up, and none of them have hired someone else.'
        : 'One of those jobs in a month is usually enough to cover a receptionist. The rest is work that goes to whoever answered first.';
    }
  }

  function readFromDom() {
    return {
      missed: document.getElementById('mcc-missed')?.value,
      called: document.getElementById('mcc-called')?.value,
      pickup: document.getElementById('mcc-pickup')?.value,
      hired: document.getElementById('mcc-hired')?.value,
      value: document.getElementById('mcc-value')?.value
    };
  }

  function writeToDom(v) {
    const map = {
      'mcc-missed': v.missed,
      'mcc-called': v.called,
      'mcc-pickup': v.pickup,
      'mcc-hired': v.hired,
      'mcc-value': v.value
    };
    Object.entries(map).forEach(([id, val]) => {
      const el = document.getElementById(id);
      if (el && String(el.value) !== String(val)) el.value = val;
    });
  }

  function update() {
    const result = compute(readFromDom());
    writeToDom(result);
    paint(result);
  }

  function init() {
    const ids = ['mcc-missed', 'mcc-called', 'mcc-pickup', 'mcc-hired', 'mcc-value'];
    const steps = { 'mcc-missed': 1, 'mcc-called': 1, 'mcc-pickup': 1, 'mcc-hired': 1, 'mcc-value': 50 };
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', update);
    });
    document.querySelectorAll('.mcc-stepper button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.key;
        const dir = Number(btn.dataset.dir);
        const el = document.getElementById(key);
        if (!el) return;
        const current = Math.round(Number(el.value)) || 0;
        el.value = String(current + dir * (steps[key] || 1));
        update();
      });
    });
    update();
  }

  const api = { clampInputs, compute, money, WEEKS_PER_MONTH, init };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.MissedCallCalculator = api;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
