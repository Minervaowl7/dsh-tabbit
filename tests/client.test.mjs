// client/client.js（web 客户端插件）的冒烟测试：模拟宿主的 ModuleLoader
// 装载协议取出工厂，用假宿主服务驱动 apply，验证 @tab 输入源的注册，以及
// 客户端【不再】向宿主注册任何会话节点/聊天插槽（issue #22 的回归守卫：
// 状态卡曾靠一条自定义会话事件驱动，那条事件会让整个会话冷加载失败）。
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

/* 装载一次 client.js 并返回其模块导出。客户端零依赖：工厂不应 require 任何东西。 */
function loadClient() {
  globalThis.window = { __ModuleLoader__: { load: (handoff) => { globalThis.__handoff = handoff } } }
  eval(readFileSync(new URL('../client/client.js', import.meta.url), 'utf8'))
  return globalThis.__handoff.factory((spec) => {
    throw new Error(`unexpected require: ${spec}`)
  })
}

/*
 * 宿主服务的最小假件。刻意把两代会话节点服务和 slots 都摆出来：客户端
 * 不该碰它们中的任何一个——requested 记录 ctx.get 被问过哪些服务，
 * registeredNodes / slotRegistrations 记录真实的注册结果。
 */
function mockServices({ requested, registeredNodes, slotRegistrations, sources, withInputTriggers = true }) {
  return {
    get(name) {
      requested.push(name)
      if (name === 'inputTriggers' && withInputTriggers) {
        return { registerSource: (source) => { sources.push(source); return () => {} } }
      }
      if (name === 'uiConversation') {
        return { events: { register: (definition) => { registeredNodes.push(definition); return () => {} } } }
      }
      if (name === 'conversationEvents') {
        return { register: (definition) => { registeredNodes.push(definition); return () => {} } }
      }
      if (name === 'slots') {
        return {
          inject: (slot, callback) => { slotRegistrations.push({ slot, callback }); return () => {} },
          register: (spec, view) => ({ spec, view }),
        }
      }
      return undefined
    },
    effect(fn) { const cleanup = fn(); return () => cleanup?.() },
  }
}

test('registers the tab and tab-group sources and nothing else', () => {
  const client = loadClient()
  assert.equal(client.name, 'dsh-tabbit-client')
  assert.deepEqual(client.inject, ['inputTriggers'])

  const requested = []
  const registeredNodes = []
  const slotRegistrations = []
  const sources = []
  client.apply(mockServices({ requested, registeredNodes, slotRegistrations, sources }))

  // 两个独立 @ 源："网页标签"（单页）在前，"标签组"（整组）在后——宿主的
  // @ 菜单按源分节渲染，标签组由此单独成组展示。
  assert.equal(sources.length, 2)
  assert.equal(sources[0].name, '网页标签')
  assert.equal(sources[0].order, 10)
  assert.equal(sources[1].name, '标签组')
  assert.equal(sources[1].order, 11)

  // issue #22 回归守卫：不注册会话节点、不占聊天插槽，也不去探测那几个服务。
  assert.equal(registeredNodes.length, 0)
  assert.equal(slotRegistrations.length, 0)
  assert.deepEqual(requested, ['inputTriggers'])
})

test('tab-group source lists roster groups, filters by member titles, shares the roster, and serializes to a group extraction', async () => {
  const client = loadClient()
  const sources = []
  client.apply(mockServices({ requested: [], registeredNodes: [], slotRegistrations: [], sources }))
  const groupSource = sources.find((s) => s.name === '标签组')
  const tabSource = sources.find((s) => s.name === '网页标签')

  const roster = {
    tabs: [{ kind: 'user-tab', url: 'https://docs.example/a', title: '文档', tabId: 11 }],
    groups: [
      { groupId: 'G1', title: '调研', members: [{ url: 'https://docs.example/a', title: '文档' }] },
      {
        groupId: 'G2',
        title: '商业化',
        members: [
          { url: 'https://a.example/1', title: '定价' },
          { url: 'https://a.example/2', title: '复盘' },
        ],
      },
    ],
  }
  const fetched = []
  globalThis.fetch = async (url, init) => {
    fetched.push({ url: String(url), init })
    if (String(url).startsWith('/tabbit/mention/tabs')) return { ok: true, json: async () => roster }
    if (String(url) === '/tabbit/mention/extract') return { ok: true, json: async () => ({ token: 'tok-1', title: '调研' }) }
    throw new Error('unexpected fetch: ' + url)
  }
  try {
    const session = { sessionId: 's1' }
    // 无过滤词：两组都出；描述带可提取页数；folder 图标。
    const all = await groupSource.candidates(session, { query: '' })
    assert.deepEqual(
      all.map((c) => [c.name, c.description, c.icon, c.hint]),
      [
        ['调研', '1 个页面', 'folder', 'Tabbit'],
        ['商业化', '2 个页面', 'folder', 'Tabbit'],
      ],
    )
    // 成员页标题/URL 也能把组搜出来（想不起组名时按内容找组）。
    const byMember = await groupSource.candidates(session, { query: '定价' })
    assert.deepEqual(byMember.map((c) => c.name), ['商业化'])

    // 两个源共用一份 roster：2 秒 TTL 内网页标签源不应再发请求。
    const rosterCalls = () => fetched.filter((f) => f.url.startsWith('/tabbit/mention/tabs')).length
    const before = rosterCalls()
    await tabSource.candidates(session, { query: '' })
    assert.equal(rosterCalls(), before)

    // onPick → ref 携带组引用（groupId + 成员清单）；serialize → POST
    // {"groupRef":{...}}（零抓取，毫秒级），产出短标记。
    const pick = groupSource.onPick({ candidate: all[0] })
    assert.equal(pick.insert.source, '标签组')
    const pickRef = JSON.parse(pick.insert.ref)
    assert.equal(pickRef.groupId, 'G1')
    assert.deepEqual(pickRef.members, [{ url: 'https://docs.example/a', title: '文档' }])
    const marker = await groupSource.codec.serialize(pick.insert.ref)
    assert.equal(marker, '@[调研](tabbit-tab:tok-1)')
    const extractCall = fetched.find((f) => f.url === '/tabbit/mention/extract')
    assert.deepEqual(JSON.parse(extractCall.init.body), {
      groupRef: { groupId: 'G1', title: '调研', members: [{ url: 'https://docs.example/a', title: '文档' }] },
    })
  } finally {
    delete globalThis.fetch
  }
})

test('stays silent when the input-trigger service is missing', () => {
  const client = loadClient()
  const requested = []
  const sources = []
  client.apply(mockServices({
    requested, registeredNodes: [], slotRegistrations: [], sources, withInputTriggers: false,
  }))
  assert.equal(sources.length, 0)
})
