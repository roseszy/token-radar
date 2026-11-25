// Token Radar's dashboard. It reads window.RADAR (written beside dashboard/ by main.ts)
// and renders the ranked board, a filterable table, a per-protocol detail view with the
// model's own inputs and the protocol's farm plan, and a live-token view. No network: every
// byte it shows is in data.js. State lives in the URL hash so a view can be linked and
// screenshotted.
(function () {
  'use strict';

  var RADAR = window.RADAR;
  if (!RADAR) return;
  var mount = document.getElementById('board');
  var view = { q: '', category: 'all', chain: 'all', minTvl: 0, watchlist: false, tab: 'pre-token', sort: 'implied', dir: -1, selected: null };

  var usdFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function money(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usdFmt.format(n);
  }
  function pct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function ageLabel(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function sumImplied(rows) {
    var total = 0;
    for (var i = 0; i < rows.length; i++) total += rows[i].implied_value_usd;
    return total;
  }
  // The model in one function: the page recomputes a row from the snapshot figures and checks
  // the number board.json carries, so the page's code and the board's data are visibly the
  // same arithmetic.
  function recomputeImplied(row, model) {
    var rawGrowth = row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d;
    var growth = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
    var growthMult = 1 + (growth / 100) * model.growth_weight;
    var age = row.age_days === null || row.age_days === undefined ? model.unknown_age_days : row.age_days;
    var maturity = model.maturity_floor + (Math.min(Math.max(age, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
    var breadth = 1 + model.breadth_per_chain * Math.min((row.chains || []).length, model.breadth_max_chains);
    return Math.max(1, Math.round(row.tvl_usd * model.base_multiple * growthMult * maturity * breadth));
  }

  function h(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      var keys = Object.keys(attrs);
      for (var k = 0; k < keys.length; k++) {
        var key = keys[k];
        var value = attrs[key];
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'html') node.innerHTML = value;
        else if (key.indexOf('on') === 0) node.addEventListener(key.slice(2), value);
        else if (value !== null && value !== undefined) node.setAttribute(key, value);
      }
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) {
        for (var j = 0; j < child.length; j++) if (child[j]) node.appendChild(child[j]);
      } else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  // The farm plan is the same derivation main.ts writes to board.json: category, chains, TVL
  // and age decide the action, the capital, the hold and every cost and time. No name is
  // special-cased.
  function firstChain(p) { return p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain'; }
  var STAKE_TIERS = [[5e9, 250], [1e9, 150], [1e8, 100]];
  function stakeSize(p) {
    for (var i = 0; i < STAKE_TIERS.length; i++) {
      if (p.tvl_usd >= STAKE_TIERS[i][0]) return STAKE_TIERS[i][1];
    }
    return 50;
  }
  function holdSpan(age) {
    return age === null || age === undefined ? 30 : age < 180 ? 60 : age < 365 ? 45 : 30;
  }
  var ACTION_RULES = [
    { keys: ['lend', 'cdp', 'collateral'], line: function (name, capital, chain) { return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`; } },
    { keys: ['dex', 'yield', 'leveraged farm'], line: function (name, capital, chain) { return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`; } },
    { keys: ['bridge'], line: function (name, capital, chain) { return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`; } },
    { keys: ['staking', 'restak'], line: function (name, capital, chain) { return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt token.`; } },
    { keys: ['perpetual', 'derivative'], line: function (name, capital, chain) { return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`; } },
    { keys: ['prediction'], line: function (name, capital) { return `Fund $${capital} and place one market position on ${name}.`; } },
    { keys: ['curator', 'allocator', 'risk'], line: function (name, capital, chain) { return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`; } },
    { keys: ['stable'], line: function (name, capital, chain) { return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`; } },
    { keys: ['rwa'], line: function (name, capital, chain) { return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`; } },
    { keys: ['insurance'], line: function (name, capital, chain) { return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`; } },
    { keys: ['launchpad'], line: function (name, capital) { return `Stake $${capital} of the launchpad's asset on ${name} and join one sale.`; } },
    { keys: ['farm'], line: function (name, capital, chain) { return `Deposit $${capital} of USDC into ${name}'s farm on ${chain} and harvest weekly.`; } }
  ];
  function actionLine(p, capital, chain) {
    var c = (p.category || '').toLowerCase();
    for (var i = 0; i < ACTION_RULES.length; i++) {
      var rule = ACTION_RULES[i];
      if (rule.keys.some(function (key) { return c.indexOf(key) >= 0; })) return rule.line(p.name, capital, chain);
    }
    return `Deposit $${capital} of USDC into ${p.name} on ${chain} and keep the position open.`;
  }
  function stepLine(step) {
    var s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + " Hold the position and check the protocol's own page.";
    return s;
  }
  function farmPlan(p) {
    var chain = firstChain(p);
    var capital = stakeSize(p);
    var hold = holdSpan(p.age_days);
    var multi = p.chains && p.chains.length > 1;
    var second = multi ? p.chains[1] : chain;
    var steps = [];
    steps.push({ text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', cost: 'under $3 of gas for the first transaction', time: '5 minutes' });
    steps.push({ text: actionLine(p, capital, chain), cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`, time: '15 minutes to set up' });
    steps.push(multi
      ? { text: `Repeat the same position on ${second} so the activity is recorded on a second chain.`, cost: `about $${Math.round(capital / 2)} of capital and $3 of gas`, time: '10 minutes' }
      : { text: 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.', cost: 'about $2 of gas a week', time: '10 minutes a week' });
    steps.push({ text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`, cost: `the $${capital} stays in the position`, time: `${hold} days` });
    steps.push({ text: "Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.", cost: 'no fee to check, and never pay to claim', time: '10 minutes' });
    steps.push({ text: 'Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.', cost: 'nothing but the log', time: '5 minutes' });
    return steps.map(stepLine);
  }

  var ON_WATCHLIST = {};
  (RADAR.watchlist || []).forEach(function (s) { ON_WATCHLIST[s] = true; });
  function onWatchlist(r) {
    return !!ON_WATCHLIST[r.slug];
  }

  function loadHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    var q = params.get('q');
    if (q) view.q = q;
    var selected = params.get('p');
    if (selected) view.selected = selected;
    var category = params.get('category');
    if (category) view.category = category;
    var chain = params.get('chain');
    if (chain) view.chain = chain;
    var minTvl = params.get('minTvl');
    if (minTvl) view.minTvl = Number(minTvl) || 0;
    if (params.get('watchlist') === '1') view.watchlist = true;
    var tab = params.get('tab');
    if (tab) view.tab = tab;
  }
  function saveHash() {
    var params = new URLSearchParams();
    if (view.q) params.set('q', view.q);
    if (view.category !== 'all') params.set('category', view.category);
    if (view.chain !== 'all') params.set('chain', view.chain);
    if (view.minTvl) params.set('minTvl', String(view.minTvl));
    if (view.watchlist) params.set('watchlist', '1');
    if (view.tab !== 'pre-token') params.set('tab', view.tab);
    if (view.selected) params.set('p', view.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function passesFilters(r, q) {
    if (view.category !== 'all' && (r.category || 'Other') !== view.category) return false;
    if (view.chain !== 'all' && !(r.chains || []).some(function (c) { return c === view.chain; })) return false;
    if (view.minTvl && r.tvl_usd < view.minTvl) return false;
    if (view.watchlist && !onWatchlist(r)) return false;
    if (!q) return true;
    var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
    return hay.indexOf(q) >= 0;
  }
  function visibleRows() {
    var q = view.q.trim().toLowerCase();
    return RADAR.rows.filter(function (r) { return passesFilters(r, q); });
  }
  function sortValue(r) {
    if (view.sort === 'name') return r.name.toLowerCase();
    if (view.sort === 'tvl') return r.tvl_usd;
    if (view.sort === 'growth') return r.change_7d === null ? -Infinity : r.change_7d;
    if (view.sort === 'age') return r.age_days === null ? Infinity : r.age_days;
    return r.implied_value_usd;
  }
  function orderedRows(list) {
    return list.slice().sort(function (a, b) {
      var av = sortValue(a);
      var bv = sortValue(b);
      if (av < bv) return -view.dir;
      if (av > bv) return view.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function topBar() {
    return h('header', { class: 'top' },
      h('div', { class: 'brand' }, h('span', { class: 'mark' }),
        h('div', null,
          h('span', { class: 'brand-name', text: 'Token Radar' }),
          h('div', { class: 'brand-tag', text: 'Pre-token protocols, ranked by what a launch would be worth' })
        )),
      h('div', { class: 'top-meta' },
        h('span', { class: 'pill' }, 'Snapshot ', h('b', { text: RADAR.as_of })),
        h('span', { class: 'pill' }, 'Source ', h('b', { text: 'DefiLlama' })),
        h('span', { class: 'pill' }, 'Model ', h('b', { text: RADAR.model_version }))
      )
    );
  }

  function intro() {
    var top = RADAR.rows[0];
    return h('section', { class: 'lede' },
      h('h1', null,
        h('span', { text: RADAR.watchlist_size + ' watchlist protocols, ranked by ' }),
        h('em', { text: 'implied value' })
      ),
      h('p', { text: `The watchlist is the floor: every protocol with at least $${Math.round(RADAR.floor_usd / 1e6)}M of TVL and no token on record. The early radar adds ${RADAR.early_size} more pre-token protocols below that floor, so the board covers every pre-token protocol the snapshot carries. Implied value is a model, not a promise — and no launch is guaranteed.` }),
      h('div', { class: 'facts' },
        h('div', { class: 'fact' }, h('span', { text: 'Watchlist covered' }), h('b', { text: RADAR.watchlist_size + ' / ' + RADAR.watchlist_size }), h('small', { text: 'every watchlist protocol is on the board' })),
        h('div', { class: 'fact' }, h('span', { text: 'Pre-token rows scored' }), h('b', { text: String(RADAR.board_size) }), h('small', { text: 'watchlist + early radar' })),
        h('div', { class: 'fact' }, h('span', { text: 'Total implied value' }), h('b', { class: 'gold', text: money(sumImplied(RADAR.rows)) }), h('small', { text: 'sum of the board, model estimate' })),
        h('div', { class: 'fact' }, h('span', { text: 'Most valuable' }), h('b', { class: 'gold', text: top ? money(top.implied_value_usd) : 'n/a' }), h('small', { text: top ? top.name : '' }))
      )
    );
  }

  function topFive() {
    var top5 = RADAR.rows.slice(0, 5);
    var max = top5.length ? top5[0].implied_value_usd : 1;
    return h('section', { class: 'spot' },
      h('h2', { text: 'Top 5 by implied value' }),
      h('div', { class: 'cards' }, top5.map(function (r) {
        return h('button', { type: 'button', class: 'card', onclick: function () { showDetail(r.slug); } },
          h('span', { class: 'rk', text: 'RANK ' + r.rank }),
          h('div', { class: 'nm', text: r.name }),
          h('div', { class: 'ct', text: (r.category || 'Other') + ' · TVL ' + money(r.tvl_usd) }),
          h('div', { class: 'vl num', text: money(r.implied_value_usd) }),
          h('div', { class: 'bar', 'aria-hidden': 'true' }, h('i', { style: 'width:' + Math.max(4, Math.round((r.implied_value_usd / max) * 100)) + '%' }))
        );
      }))
    );
  }

  function selectField(id, label, options, current, onPick) {
    var sel = h('select', { id: id, 'aria-label': label },
      options.map(function (o) {
        return h('option', { value: o.value, text: o.label, selected: String(current) === String(o.value) ? 'selected' : null });
      })
    );
    sel.addEventListener('change', function () { onPick(sel.value); });
    return h('div', { class: 'field' }, h('label', { for: id, text: label }), sel);
  }

  function filterBar() {
    var categories = Array.from(new Set(RADAR.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chainSet = {};
    RADAR.rows.forEach(function (r) { (r.chains || []).forEach(function (c) { chainSet[c] = true; }); });
    var chains = Object.keys(chainSet).sort();
    var search = h('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: view.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { view.q = search.value; saveHash(); draw(); });
    var catField = selectField('category', 'Category',
      [{ value: 'all', label: 'All categories' }].concat(categories.map(function (c) { return { value: c, label: c }; })),
      view.category,
      function (v) { view.category = v; saveHash(); draw(); });
    var chainField = selectField('chain', 'Chain',
      [{ value: 'all', label: 'All chains' }].concat(chains.map(function (c) { return { value: c, label: c }; })),
      view.chain,
      function (v) { view.chain = v; saveHash(); draw(); });
    var tvlField = selectField('minTvl', 'Minimum TVL', [
      { value: '0', label: 'Any TVL' },
      { value: '50000000', label: 'TVL $50M+' },
      { value: '100000000', label: 'TVL $100M+' },
      { value: '500000000', label: 'TVL $500M+' },
      { value: '1000000000', label: 'TVL $1B+' }
    ], view.minTvl, function (v) { view.minTvl = Number(v) || 0; saveHash(); draw(); });
    var watch = h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: view.watchlist ? 'checked' : null }),
      'Watchlist only'
    );
    watch.querySelector('input').addEventListener('change', function (e) { view.watchlist = e.target.checked; saveHash(); draw(); });
    var pre = h('button', { type: 'button', 'aria-pressed': view.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token', onclick: function () { view.tab = 'pre-token'; draw(); } });
    var live = h('button', { type: 'button', 'aria-pressed': view.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { view.tab = 'live'; draw(); } });
    return h('div', { class: 'controls' },
      h('div', { class: 'field grow' }, h('label', { for: 'q', text: 'Search' }), search),
      catField,
      chainField,
      tvlField,
      watch,
      h('div', { class: 'field' }, h('span', { class: 'sub', text: 'Token status' }), h('div', { class: 'tabs' }, pre, live)),
      h('span', { class: 'count', text: view.tab === 'pre-token' ? visibleRows().length + ' rows shown' : RADAR.live.length + ' live-token protocols' })
    );
  }

  function rankChip(rank) {
    var cls = 'rank-badge';
    if (rank === 1) cls += ' gold';
    else if (rank === 2) cls += ' silver';
    else if (rank === 3) cls += ' bronze';
    return h('span', { class: cls, text: String(rank) });
  }
  function tagChips(r) {
    var chips = [h('span', { class: 'chip' }, h('span', { class: 'dot' }), (r.category || 'Other'))];
    (r.chains || []).slice(0, 2).forEach(function (c) {
      chips.push(h('span', { class: 'chip chain', text: c }));
    });
    if (onWatchlist(r)) chips.push(h('span', { class: 'chip watch', text: 'Watchlist' }));
    return h('div', { class: 'chips' }, chips);
  }

  function headCell(key, label) {
    return h('th', { scope: 'col' },
      h('button', { type: 'button', onclick: function () { if (view.sort === key) view.dir = -view.dir; else { view.sort = key; view.dir = -1; } draw(); } },
        label,
        view.sort === key ? h('span', { 'aria-hidden': 'true', text: view.dir < 0 ? ' v' : ' ^' }) : null
      )
    );
  }

  function protocolRow(r, max) {
    var growth = r.change_7d === null ? 'n/a' : pct(r.change_7d);
    var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
    return h('tr', {
      'data-selected': view.selected === r.slug ? 'true' : 'false',
      tabindex: '0',
      onclick: function () { showDetail(r.slug); },
      onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showDetail(r.slug); } }
    },
      h('td', { class: 'num' }, rankChip(r.rank)),
      h('td', null, h('div', { class: 'name' },
        h('b', { text: r.name }),
        h('span', { class: 'sub', text: 'on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }),
        tagChips(r)
      )),
      h('td', { class: 'num', text: money(r.tvl_usd) }),
      h('td', { class: 'num ' + growthClass, text: growth }),
      h('td', { class: 'num', text: ageLabel(r.age_days) }),
      h('td', null, h('div', { class: 'implied' },
        h('div', { class: 'bar', 'aria-hidden': 'true' }, h('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
        h('span', { class: 'val num', text: money(r.implied_value_usd) })
      )),
      h('td', null, h('span', { class: 'status pre', text: 'no token' }))
    );
  }

  function boardGrid() {
    var list = orderedRows(visibleRows());
    if (list.length === 0) {
      return h('div', { class: 'panel' }, h('div', { class: 'empty' },
        h('h2', { text: 'No protocol matches that filter' }),
        h('p', { text: 'Clear the search or pick another category, chain or TVL to see the board again.' }),
        h('button', { class: 'button', type: 'button', text: 'Clear filters', onclick: function () { view.q = ''; view.category = 'all'; view.chain = 'all'; view.minTvl = 0; view.watchlist = false; saveHash(); draw(); } })
      ));
    }
    var max = 1;
    list.forEach(function (r) { if (r.implied_value_usd > max) max = r.implied_value_usd; });
    var tbody = h('tbody');
    list.forEach(function (r) { tbody.appendChild(protocolRow(r, max)); });
    return h('div', { class: 'panel' },
      h('div', { class: 'table-wrap' },
        h('table', null,
          h('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its model and farm plan.' }),
          h('thead', null, h('tr', null,
            headCell('implied', 'Rank'),
            headCell('name', 'Protocol'),
            headCell('tvl', 'TVL'),
            headCell('growth', '7d'),
            headCell('age', 'Age'),
            headCell('implied', 'Implied value'),
            h('th', { scope: 'col', text: 'Token' })
          )),
          tbody
        )
      )
    );
  }

  function liveGrid() {
    var tbody = h('tbody');
    RADAR.live.forEach(function (r) {
      tbody.appendChild(h('tr', null,
        h('td', { class: 'num', text: 'live' }),
        h('td', null, h('div', { class: 'name' }, h('b', { text: r.name }), h('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }))),
        h('td', { class: 'num', text: money(r.tvl_usd) }),
        h('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: pct(r.change_7d) }),
        h('td', { class: 'num', text: money(r.mcap_usd) }),
        h('td', null, h('span', { class: 'status live', text: 'already trades' }))
      ));
    });
    return h('div', { class: 'panel' },
      h('div', { class: 'table-wrap' },
        h('table', null,
          h('caption', { class: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking.' }),
          h('thead', null, h('tr', null, h('th', { scope: 'col', text: 'Status' }), h('th', { scope: 'col', text: 'Protocol' }), h('th', { scope: 'col', text: 'TVL' }), h('th', { scope: 'col', text: '7d' }), h('th', { scope: 'col', text: 'Market cap' }), h('th', { scope: 'col', text: 'Token' }))),
          tbody
        )
      )
    );
  }

  function modelCard() {
    var m = RADAR.model;
    return h('section', { class: 'panel model' },
      h('h2', { text: 'How implied value is computed' }),
      h('p', { class: 'sub', text: 'Every row is scored by one function of the snapshot figures. No protocol name is special-cased, and no row is hand-picked.' }),
      h('div', { class: 'formula' },
        `implied = round( tvl_usd x ${m.base_multiple} x (1 + clamp(change_7d, ${m.growth_floor}, ${m.growth_cap}) / 100 x ${m.growth_weight}) x (${m.maturity_floor} + min(age_days, ${m.maturity_days}) / ${m.maturity_days} x ${m.maturity_range}) x (1 + ${m.breadth_per_chain} x min(chains, ${m.breadth_max_chains})) )`
      ),
      h('p', { class: 'sub', text: `TVL is the size of the prize, seven-day growth is its momentum, age with no token is how long the launch has been waited for (an unlisted age uses ${m.unknown_age_days} days), and chain breadth is how many chains the protocol already serves. The early radar is every pre-token protocol below the watchlist floor, and the live-token protocols are set aside with their market caps shown.` })
    );
  }

  function notesCard() {
    return h('section', { class: 'panel notes' },
      h('h2', { text: 'Read this before you farm' }),
      h('ul', null,
        h('li', { text: 'Data: a frozen DefiLlama protocol index, snapshot ' + RADAR.as_of + '. Nothing here is live, and nothing is fetched from the network.' }),
        h('li', { text: '"No token" means the record carries no token — a protocol on the list may still have a token its DefiLlama record does not carry.' }),
        h('li', { text: "Implied value is the radar's own estimate from TVL, growth, age and chain breadth. It is not a price, not a prediction, and not a promise that a token will launch." }),
        h('li', { text: 'Farm plans are steps, not guarantees: a protocol may never issue a token, and an airdrop may never come. Never spend more than you can afford to lose, and never pay to claim.' })
      )
    );
  }

  var detail = h('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  detail.addEventListener('close', function () { view.selected = null; saveHash(); });

  function showDetail(slug) {
    var row = RADAR.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    view.selected = slug;
    saveHash();
    detail.textContent = '';
    var steps = farmPlan(row);
    var recomputed = recomputeImplied(row, RADAR.model);
    detail.appendChild(h('div', { class: 'detail-head' },
      h('div', null,
        h('span', { class: 'rk', text: 'Rank ' + row.rank + ' of ' + RADAR.board_size + (onWatchlist(row) ? ' · watchlist' : ' · early radar') }),
        h('h2', { id: 'detail-title', text: row.name }),
        h('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') + ' · listed ' + (row.listed_at || 'unknown') }),
        tagChips(row)
      ),
      h('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { detail.close(); } })
    ));
    detail.appendChild(h('div', { class: 'detail-stats' },
      h('div', { class: 'dstat' }, h('span', { text: 'TVL' }), h('b', { class: 'num', text: money(row.tvl_usd) })),
      h('div', { class: 'dstat' }, h('span', { text: '7-day growth' }), h('b', { class: 'num ' + (row.change_7d !== null && row.change_7d >= 0 ? 'pos' : row.change_7d === null ? '' : 'neg'), text: pct(row.change_7d) })),
      h('div', { class: 'dstat' }, h('span', { text: 'Age, no token' }), h('b', { class: 'num', text: ageLabel(row.age_days) })),
      h('div', { class: 'dstat' }, h('span', { text: 'Implied value' }), h('b', { class: 'num gold', text: money(row.implied_value_usd) }))
    ));
    detail.appendChild(h('section', { class: 'detail-section' },
      h('h3', { text: 'Implied value' }),
      h('div', { class: 'equation' },
        h('div', null, h('span', { text: 'TVL' }), h('b', { class: 'num', text: money(row.tvl_usd) })),
        h('div', null, h('span', { text: 'Seven-day growth' }), h('b', { class: 'num', text: pct(row.change_7d) })),
        h('div', null, h('span', { text: 'Age with no token' }), h('b', { class: 'num', text: ageLabel(row.age_days) })),
        h('div', null, h('span', { text: 'Chains served' }), h('b', { class: 'num', text: String((row.chains || []).length) })),
        h('div', null, h('span', { text: 'Growth multiplier' }), h('b', { class: 'num', text: String(row.growth_multiplier) })),
        h('div', null, h('span', { text: 'Maturity multiplier' }), h('b', { class: 'num', text: String(row.maturity_multiplier) })),
        h('div', null, h('span', { text: 'Breadth multiplier' }), h('b', { class: 'num', text: String(row.breadth_multiplier) })),
        h('div', null, h('span', { text: 'Implied value' }), h('b', { class: 'num gold', text: money(row.implied_value_usd) }))
      ),
      h('p', { class: 'sub', text: `Model ${RADAR.model_version}: the same function scores every protocol. The page recomputes this row as ${money(recomputed)}${recomputed === row.implied_value_usd ? ', the same number board.json carries.' : ', which differs from the board: the data would be stale.'} This is an estimate, not a price.` })
    ));
    detail.appendChild(h('section', { class: 'detail-section' },
      h('h3', { text: 'Farm plan' }),
      h('ol', { class: 'steps' }, steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return h('li', null, h('b', { text: action }), h('span', { class: 'cost', text: tail }));
      })),
      h('p', { class: 'warn', text: 'A plan is steps, not a promise: this protocol may never issue a token. Never pay to claim, and never spend more than you can afford to lose.' })
    ));
    if (typeof detail.showModal === 'function') {
      if (!detail.open) detail.showModal();
    } else {
      detail.setAttribute('open', '');
    }
  }

  function draw() {
    mount.textContent = '';
    var shell = h('div', { class: 'shell' });
    shell.appendChild(topBar());
    shell.appendChild(intro());
    shell.appendChild(topFive());
    shell.appendChild(filterBar());
    shell.appendChild(view.tab === 'pre-token' ? boardGrid() : liveGrid());
    if (view.tab === 'pre-token') shell.appendChild(modelCard());
    shell.appendChild(notesCard());
    mount.appendChild(shell);
    mount.setAttribute('aria-busy', 'false');
    if (!detail.isConnected) mount.appendChild(detail);
    if (view.selected) showDetail(view.selected);
  }

  loadHash();
  draw();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && detail.open) detail.close();
  });
})();
