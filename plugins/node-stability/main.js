/* SPDX-License-Identifier: GPL-3.0-only */
var bunPlugin = (() => {
  const WINDOW = 7 * 86400000
  const INTERVAL = 300000
  const FRESH = 90000
  const TARGET = 'https://cp.cloudflare.com/generate_204'
  const regions = [
    [
      '美国',
      /美国|美國|🇺🇸|United[ _-]?States|America|洛杉[矶磯]|西雅[图圖]|纽约|紐約|芝加哥|达拉斯|達拉斯|硅谷|矽谷|(?:^|[^A-Za-z])(?:US|USA)(?=$|[^A-Za-z])/i,
    ],
    ['香港', /香港|🇭🇰|Hong[ _-]?Kong|(?:^|[^A-Za-z])HK(?=$|[^A-Za-z])/i],
    [
      '台湾',
      /台湾|台灣|🇹🇼|Taiwan|台北|新北|高雄|彰化|(?:^|[^A-Za-z])TW(?=$|[^A-Za-z])/i,
    ],
  ]
  const junk =
    /剩余|剩餘|流量|到期|官网|官網|订阅|訂閱|电报群|電報群|防失联|防失聯|https?:\/\//i
  const specs = [
    ['自动选择-稳定', null],
    ...regions.map(([name, re]) => [`自动选择(${name})-稳定`, re]),
  ]
  const reserved = specs.map(([name]) => name)
  const builtins = [
    'DIRECT',
    'REJECT',
    'REJECT-DROP',
    'PASS',
    'PASS-RULE',
    'COMPATIBLE',
  ]

  function onConfig({ config }) {
    const nodes = (config.proxies || []).filter(
      (p) => p.name && !junk.test(p.name) && !builtins.includes(p.name),
    )
    const providers = Object.keys(config['proxy-providers'] || {})
    const originals = (config['proxy-groups'] || []).filter(
      (g) => !reserved.includes(g.name),
    )
    const added = specs.map(([name, re]) => {
      const group = {
        name,
        type: 'select',
        proxies: nodes
          .filter((p) => !re || re.test(p.name))
          .map((p) => p.name)
          .concat('REJECT'),
      }
      if (providers.length) {
        group.use = providers
        if (re) group.filter = re.source
        group['exclude-filter'] = junk.source
      }
      return group
    })
    for (const g of originals) {
      if (
        g.name === 'AI' ||
        g.name === 'Google' ||
        /美国节点.*7891/.test(g.name)
      ) {
        g.type = 'select'
        g.proxies = (g.proxies || [])
          .filter((n) => !reserved.includes(n))
          .concat(reserved[1])
      } else if (
        g.type === 'select' &&
        ((g.proxies || []).some((n) => !builtins.includes(n)) ||
          g.use ||
          g['include-all'])
      ) {
        g.proxies = (g.proxies || []).concat(
          reserved.filter((n) => !(g.proxies || []).includes(n)),
        )
      }
    }
    config['proxy-groups'] = originals.concat(added)
    config.profile = { ...config.profile, 'store-selected': true }
    return { config }
  }

  function initialize(input) {
    const state = input.state || {}
    state.nodes = state.nodes || {}
    const records = input.view ? Object.values(input.view.records) : []
    for (const record of records) {
      if (
        junk.test(record.name) ||
        builtins.includes(record.name) ||
        ['Direct', 'Reject', 'Pass', 'PassRule', 'Compatible'].includes(
          record.type,
        )
      )
        continue
      const key = record.fingerprint || record.recordId
      let node = state.nodes[key]
      if (!node) node = state.nodes[key] = { samples: [], seen: {}, last: null }
      node.recordId = record.recordId
      node.name = record.name
      node.source = record.source
      node.region = (regions.find(([, re]) => re.test(record.name)) || [
        '其他',
      ])[0]
      node.present = input.now
      node.samples = node.samples.filter((s) => s[0] > input.now - WINDOW)
      for (const [event, time] of Object.entries(node.seen)) {
        if (time <= input.now - WINDOW) delete node.seen[event]
      }
      // Core history is a short ring buffer: absorb unseen observations, never re-count a poll.
      if (input.online) {
        const histories = Object.entries(record.extra || {}).map(
          ([url, value]) => [url, value.history],
        )
        histories.push(['core', record.history])
        for (const [, history] of histories) {
          for (const sample of history || []) {
            const time = Date.parse(sample.time)
            const event = `${time}:${sample.delay}`
            if (
              !Number.isFinite(time) ||
              time <= input.now - WINDOW ||
              time > input.now ||
              node.seen[event]
            )
              continue
            // A probe we issued is already recorded from the response.
            if (
              node.samples.some(
                (s) => Math.abs(s[0] - time) < 2000 && s[1] === sample.delay,
              )
            ) {
              node.seen[event] = time
              continue
            }
            node.seen[event] = time
            node.samples.push([time, sample.delay, 'observed'])
          }
        }
      }
    }
    for (const [key, node] of Object.entries(state.nodes)) {
      if (node.present <= input.now - WINDOW) delete state.nodes[key]
    }
    return state
  }

  function candidates(state, now) {
    return Object.entries(state.nodes)
      .filter(([, n]) => n.present === now)
      .map(([key, n]) => {
        const samples = n.samples.filter((s) => s[2] === 'scheduled')
        const successes = samples.filter((s) => s[1] > 0 && s[1] < 65535)
        const delays = successes.map((s) => s[1]).sort((a, b) => a - b)
        return {
          key,
          ...n,
          total: samples.length,
          successes: successes.length,
          rate: samples.length ? successes.length / samples.length : 0,
          median: delays.length ? delays[Math.floor(delays.length / 2)] : 65535,
          reachable:
            !!n.last &&
            n.last[1] > 0 &&
            n.last[1] < 65535 &&
            now - n.last[0] <= FRESH,
        }
      })
  }

  function render(state, input) {
    const nodes = candidates(state, input.now).sort(
      (a, b) =>
        b.rate - a.rate || a.median - b.median || a.name.localeCompare(b.name),
    )
    const actions = []
    const selections = []
    for (const [name, re] of specs) {
      const group = (input.view?.groups || []).find((g) => g.name === name)
      if (!group) continue
      const members = new Set(
        group.members.filter((m) => m.kind === 'node').map((m) => m.recordId),
      )
      const available = nodes.filter(
        (n) =>
          n.reachable && members.has(n.recordId) && (!re || re.test(n.name)),
      )
      const winner = available[0]
      const selected = winner ? winner.name : 'REJECT'
      selections.push({
        name,
        selected,
        provisional: !!winner && winner.total < 24,
      })
      if (input.online && group.now !== selected)
        actions.push({ type: 'select', group: name, name: selected })
    }
    const rows = nodes.map((n) => {
      const days = Array.from({ length: 7 }, (_, day) => {
        const start = input.now - (7 - day) * 86400000
        const samples = n.samples.filter(
          (s) =>
            s[0] > start && s[0] <= start + 86400000 && s[2] === 'scheduled',
        )
        return samples.length
          ? Math.round(
              (samples.filter((s) => s[1] > 0 && s[1] < 65535).length /
                samples.length) *
                1000,
            ) / 10
          : null
      })
      return {
        id: n.key,
        name: n.name,
        region: n.region,
        available: n.reachable,
        rate: n.total ? Math.round(n.rate * 10000) / 100 : null,
        total: n.total,
        failures: n.total - n.successes,
        observations: n.samples.length,
        median: n.median === 65535 ? null : n.median,
        lastTest: n.last?.[0] || null,
        provisional: n.total < 24,
        days,
      }
    })
    return {
      state,
      actions,
      dashboard: {
        title: '节点稳定性',
        description:
          '近七天定时成功率 · 当前可达后选择 · 低于 24 个样本为观察期',
        updatedAt: input.now,
        status: input.online ? 'running' : 'paused',
        selections,
        rows,
        metrics: [
          { label: '节点', value: rows.length },
          { label: '当前可达', value: rows.filter((n) => n.available).length },
          {
            label: '定时测试',
            value: rows.reduce((sum, n) => sum + n.total, 0),
          },
          {
            label: '所有观测',
            value: rows.reduce((sum, n) => sum + n.observations, 0),
          },
        ],
      },
    }
  }

  function onTick(input) {
    const state = initialize(input)
    const output = render(state, input)
    if (!input.online) return output
    const full = !state.lastRound || input.now - state.lastRound >= INTERVAL
    const ids = full
      ? candidates(state, input.now).map((n) => n.recordId)
      : [
          ...new Set(
            (input.view.groups || [])
              .filter((g) => reserved.includes(g.name))
              .flatMap((g) =>
                g.members
                  .filter(
                    (m) =>
                      m.kind === 'node' &&
                      (m.name === g.now || g.now === 'REJECT'),
                  )
                  .map((m) => m.recordId),
              ),
          ),
        ]
    if (ids.length)
      output.actions.unshift({
        type: 'probe',
        records: ids,
        url: TARGET,
        timeout: 5000,
        tag: full ? 'scheduled' : 'watch',
      })
    if (full) state.lastRound = input.now
    // Selections are recalculated after fresh probe responses.
    output.actions = output.actions.filter((a) => a.type !== 'select')
    return output
  }

  function onResults(input) {
    const state = initialize(input)
    for (const result of input.results || []) {
      const node = Object.values(state.nodes).find(
        (n) => n.recordId === result.recordId,
      )
      if (!node || result.delay === null) continue
      const time = result.time || input.now
      node.samples.push([time, result.delay, result.tag])
      node.last = [time, result.delay]
    }
    const output = render(state, input)
    // A failure may require checking another candidate before selecting it.
    const missingNames = output.dashboard.selections
      .filter((s) => s.selected === 'REJECT')
      .map((s) => s.name)
    const needed = new Set(
      (input.view?.groups || [])
        .filter((g) => missingNames.includes(g.name))
        .flatMap((g) =>
          g.members.filter((m) => m.kind === 'node').map((m) => m.recordId),
        ),
    )
    if (
      input.online &&
      needed.size > 0 &&
      !(input.results || []).some((r) => r.tag === 'recovery')
    ) {
      const ids = candidates(state, input.now)
        .filter(
          (n) =>
            needed.has(n.recordId) &&
            (!n.last || input.now - n.last[0] > FRESH),
        )
        .map((n) => n.recordId)
      if (ids.length)
        output.actions.unshift({
          type: 'probe',
          records: ids,
          url: TARGET,
          timeout: 5000,
          tag: 'recovery',
        })
    }
    return output
  }

  function onCommand(input) {
    if (input.command !== 'test-now') throw new Error('Unknown command')
    input.state = input.state || {}
    input.state.lastRound = 0
    return onTick(input)
  }
  return { onConfig, onTick, onResults, onCommand }
})()
