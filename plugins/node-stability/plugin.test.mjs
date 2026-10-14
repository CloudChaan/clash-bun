import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('./main.js', import.meta.url), 'utf8')
const plugin = vm.runInNewContext(`${source}; bunPlugin`)
const NOW = Date.UTC(2026, 9, 14, 12)
const record = (id, name) => ({
  recordId: id,
  fingerprint: id,
  name,
  source: { kind: 'core', proxyName: name },
  history: [],
})
const view = () => ({
  records: {
    a: record('a', '美国 A'),
    b: record('b', '美国 B'),
    c: record('c', '台湾 C'),
  },
  groups: [
    {
      name: '自动选择-稳定',
      now: 'REJECT',
      members: [
        { kind: 'node', recordId: 'a' },
        { kind: 'node', recordId: 'b' },
        { kind: 'node', recordId: 'c' },
      ],
    },
    {
      name: '自动选择(美国)-稳定',
      now: 'REJECT',
      members: [
        { kind: 'node', recordId: 'a' },
        { kind: 'node', recordId: 'b' },
      ],
    },
    { name: '自动选择(香港)-稳定', now: 'REJECT', members: [] },
  ],
})
const input = (state = {}, time = NOW) => ({
  state,
  now: time,
  online: true,
  view: view(),
})
const seed = () => {
  const state = plugin.onTick(input()).state
  state.nodes.a.samples = Array.from({ length: 30 }, (_, i) => [
    NOW - 300000 * (i + 1),
    i < 12 ? 0 : 10,
    'scheduled',
  ])
  state.nodes.b.samples = Array.from({ length: 30 }, (_, i) => [
    NOW - 300000 * (i + 1),
    180,
    'scheduled',
  ])
  return state
}

test('availability wins over lower latency, with an independent US choice', () => {
  const result = plugin.onResults({
    ...input(seed()),
    results: [
      { recordId: 'a', delay: 10, tag: 'scheduled' },
      { recordId: 'b', delay: 180, tag: 'scheduled' },
    ],
  })
  assert.equal(
    result.dashboard.selections.find((s) => s.name === '自动选择(美国)-稳定')
      .selected,
    '美国 B',
  )
  assert.equal(
    result.dashboard.selections.find((s) => s.name === '自动选择(香港)-稳定')
      .selected,
    'REJECT',
  )
})

test('unreachable historical winner cannot be selected', () => {
  const result = plugin.onResults({
    ...input(seed()),
    results: [
      { recordId: 'a', delay: 10, tag: 'scheduled' },
      { recordId: 'b', delay: 0, tag: 'scheduled' },
    ],
  })
  assert.equal(
    result.dashboard.selections.find((s) => s.name === '自动选择(美国)-稳定')
      .selected,
    '美国 A',
  )
})

test('samples expire at the exact seven-day boundary', () => {
  const state = seed()
  state.nodes.a.samples.push([NOW - 7 * 86400000, 0, 'scheduled'])
  const result = plugin.onTick(input(state))
  assert.equal(result.dashboard.rows.find((n) => n.id === 'a').total, 30)
})

test('manual/watch tests are visible without biasing scheduled ranking', () => {
  const state = seed()
  const output = plugin.onResults({
    ...input(state),
    results: [{ recordId: 'a', delay: 10, tag: 'watch' }],
  })
  const node = output.dashboard.rows.find((n) => n.id === 'a')
  assert.equal(node.total, 30)
  assert.equal(node.observations, 31)
})

test('offline ticks neither probe nor select nor record failures', () => {
  const result = plugin.onTick({ ...input(seed()), online: false })
  assert.equal(result.actions.length, 0)
  assert.equal(result.dashboard.status, 'paused')
  assert.equal(result.dashboard.rows.find((n) => n.id === 'b').failures, 0)
})

test('transport errors do not become reachability failures', () => {
  const result = plugin.onResults({
    ...input(seed()),
    results: [{ recordId: 'b', delay: null, tag: 'scheduled' }],
  })
  assert.equal(result.dashboard.rows.find((n) => n.id === 'b').total, 30)
})

test('stale successes trigger recovery and are never treated as current reachability', () => {
  const state = seed()
  state.nodes.b.last = [NOW - 100000, 180]
  const result = plugin.onResults({
    ...input(state),
    results: [{ recordId: 'a', delay: 0, tag: 'watch' }],
  })
  assert.equal(
    result.dashboard.selections.find((s) => s.name === '自动选择(美国)-稳定')
      .selected,
    'REJECT',
  )
  assert.ok(
    result.actions.some((a) => a.type === 'probe' && a.records.includes('b')),
  )
})

test('core ring history polling counts each event once', () => {
  const data = input()
  data.view.records.a.history = [
    { time: new Date(NOW - 10000).toISOString(), delay: 100 },
  ]
  const once = plugin.onTick(data)
  const again = plugin.onTick({ ...data, state: once.state })
  assert.equal(again.dashboard.rows.find((n) => n.id === 'a').observations, 1)
})

test('configuration is idempotent and US stable choice is available in target groups', () => {
  const config = {
    proxies: [{ name: '美国 A' }, { name: '香港 B' }, { name: '台湾 C' }],
    'proxy-groups': [
      { name: 'AI', type: 'fallback', proxies: ['美国 A'] },
      { name: 'Google', type: 'fallback', proxies: ['美国 A'] },
      { name: '美国节点（7891端口）', type: 'fallback', proxies: ['美国 A'] },
    ],
  }
  const first = plugin.onConfig({ config: structuredClone(config) }).config
  const second = plugin.onConfig({ config: structuredClone(first) }).config
  assert.equal(JSON.stringify(first), JSON.stringify(second))
  for (const name of ['AI', 'Google', '美国节点（7891端口）']) {
    const group = second['proxy-groups'].find((g) => g.name === name)
    assert.equal(group.type, 'select')
    assert.ok(group.proxies.includes('自动选择(美国)-稳定'))
  }
})

test('provider-only subscriptions generate filtered regional groups', () => {
  const config = plugin.onConfig({
    config: { 'proxy-providers': { airport: {} } },
  }).config
  const group = config['proxy-groups'].find(
    (g) => g.name === '自动选择(台湾)-稳定',
  )
  assert.equal(group.use[0], 'airport')
  assert.match(group.filter, /Taiwan/)
})

test('node replacement does not inherit the old endpoint statistics', () => {
  const data = input(seed())
  data.view.records.a.fingerprint = 'replacement'
  const result = plugin.onTick(data)
  assert.equal(
    result.dashboard.rows.find((n) => n.id === 'replacement').total,
    0,
  )
})

test('empty regions do not cause continuous recovery scans of unrelated nodes', () => {
  const state = seed()
  const result = plugin.onResults({
    ...input(state),
    results: [
      { recordId: 'a', delay: 10, tag: 'watch' },
      { recordId: 'b', delay: 180, tag: 'watch' },
    ],
  })
  assert.equal(result.actions.filter((a) => a.type === 'probe').length, 0)
})

test('Mihomo builtins are excluded even when their names look like regional nodes', () => {
  const data = input()
  data.view.records.pass = {
    ...record('pass', '美国 PASS-RULE'),
    type: 'PassRule',
  }
  const result = plugin.onTick(data)
  assert.equal(
    result.dashboard.rows.some((n) => n.id === 'pass'),
    false,
  )
})

test('a group on REJECT checks for recovery on the next watch interval', () => {
  const state = seed()
  state.lastRound = NOW
  const result = plugin.onTick(input(state, NOW + 30000))
  assert.ok(
    result.actions.some((a) => a.type === 'probe' && a.records.includes('b')),
  )
})
