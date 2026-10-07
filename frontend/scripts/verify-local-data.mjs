// 本地数据层核对脚本（不依赖浏览器/DOM）：
//   node scripts/verify-local-data.mjs
// 用 esbuild 把 TS 源码打成临时 ESM，在 Node 里注入 localStorage 桩后逐项断言。
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ENTRIES_KEY = 'airport-ground-handling:entries'
const CHECKPOINT_KEY = 'airport-ground-handling:entries:schema'
const CORRUPT_KEY = 'airport-ground-handling:entries:corrupt-backup'

function resolve(rel) {
  return new URL(`../${rel}`, import.meta.url).pathname
}

function createMemoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  let failAtCall = Infinity // 第 N 次 setItem 抛一次错
  let calls = 0
  const store = {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem(key, value) {
      calls += 1
      if (calls === failAtCall) {
        // 抛错的这次不能真的写进去，模拟真正的写入失败。
        throw new Error('mock write failed (配额耗尽/配置中断)')
      }
      map.set(key, String(value))
    },
    removeItem: (key) => map.delete(key),
    clear: () => map.clear(),
    // 仅让第 n 次 setItem 抛错，模拟数据已写、断点没写成的中断场景。
    failOnSet(n) {
      failAtCall = n
      calls = 0
    },
  }
  return store
}

async function loadFresh(store) {
  const dir = mkdtempSync(join(tmpdir(), 'audit-verify-'))
  const entry = join(dir, 'entry.ts')
  writeFileSync(
    entry,
    `import { allRows } from ${JSON.stringify(resolve('src/data/local-store.ts'))}
     export * from ${JSON.stringify(resolve('src/data/local-store.ts'))}
     export * as service from ${JSON.stringify(resolve('src/api/local-service.ts'))}
     // 应用一挂载就读数据，迁移在首次读取时启动（这里按该顺序显式触发一次）。
     await Promise.resolve(allRows())
    `,
  )
  const out = join(dir, 'bundle.mjs')
  await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    outfile: out,
    write: true,
    logLevel: 'silent',
    alias: { '@': resolve('src') },
  })
  globalThis.window = { localStorage: store }
  const mod = await import(`${pathToFileURL(out).href}?t=${Date.now()}-${Math.random()}`)
  return { mod, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

let passed = 0
function check(name, condition, detail = '') {
  if (!condition) {
    throw new Error(`✗ ${name}${detail ? `：${detail}` : ''}`)
  }
  passed += 1
  console.log(`✓ ${name}`)
}

// 1. 应急链路：顺序流转 + 审计标记 + 未解除不算办结
{
  const store = createMemoryStorage()
  const { mod, cleanup } = await loadFresh(store)
  const { listEntries, runAction } = mod.service

  const before = listEntries('air_emergency').items
  check('首开播种 3 条应急样例', before.length === 3, `实际 ${before.length}`)
  const handling = before.find((r) => r.status === '处置中')
  check('处置中记录仍是未解除（pending=true）', handling.pending === true)

  const waiting = before.find((r) => r.status === '待响应')
  const skip = runAction('air_emergency', waiting.id, '解除应急')
  check('禁止跳步：待响应不能直接解除', skip.ok === false)

  const step1 = runAction('air_emergency', waiting.id, '启动响应')
  check('启动响应成功', step1.ok && step1.message.includes('响应中'))
  const step2 = runAction('air_emergency', waiting.id, '落实处置')
  check('落实处置成功', step2.ok)
  let row = listEntries('air_emergency').items.find((r) => r.id === waiting.id)
  check('处置中 pending=true（未解除）', row.pending === true && row.abnormal === false)
  const step3 = runAction('air_emergency', waiting.id, '解除应急')
  check('解除应急成功', step3.ok)
  row = listEntries('air_emergency').items.find((r) => r.id === waiting.id)
  check('已解除 pending=false（办结）', row.pending === false && row.status === '已解除')

  const again = runAction('air_emergency', waiting.id, '启动响应')
  check('终态保护：已解除不能再流转', again.ok === false)
  const repeat = runAction('air_emergency', waiting.id, '解除应急')
  check('重复解除被拒绝', repeat.ok === false)
  cleanup()
}

// 2. 运营概览共用审计标记（应急处置中计入待处理）
{
  const store = createMemoryStorage()
  const { mod, cleanup } = await loadFresh(store)
  const overview = mod.service.loadOverview()
  const emergency = overview.modules.find((m) => m.name === '应急保障')
  check('概览-应急待处理=3（待响应/响应中/处置中均未解除）', emergency.pending === 3, `实际 ${emergency.pending}`)
  check('概览-应急异常量=1（样例中响应中一条 abnormal）', emergency.abnormal === 1, `实际 ${emergency.abnormal}`)
  cleanup()
}

// 3. 缺字段记录兼容迁移
{
  const legacy = {
    air_emergency: [
      { id: 99, status: '响应中' },
      { id: 100, status: '处置中', pending: false, abnormal: true, 应急编号: 'AIR_-0100' },
    ],
  }
  const store = createMemoryStorage({ [ENTRIES_KEY]: JSON.stringify(legacy) })
  const { mod, cleanup } = await loadFresh(store)
  const rows = mod.service.listEntries('air_emergency').items
  const r99 = rows.find((r) => r.id === 99)
  check('缺 pending 按状态推导（响应中=true）', r99.pending === true)
  check('缺 abnormal 补 false', r99.abnormal === false)
  check('缺业务字段补空串不报错', r99['应急编号'] === '' && r99['处置措施'] === '')
  const r100 = rows.find((r) => r.id === 100)
  check('已有 abnormal=true 保留为审计痕迹', r100.abnormal === true)
  cleanup()
}

// 4. 流转动作后审计标记按统一口径重算
{
  const store = createMemoryStorage()
  const { mod, cleanup } = await loadFresh(store)
  const row = mod.service.listEntries('air_emergency').items.find((r) => r.status === '处置中')
  const res = mod.service.runAction('air_emergency', row.id, '解除应急')
  check('处置中可解除', res.ok)
  const done = mod.service.listEntries('air_emergency').items.find((r) => r.id === row.id)
  check('解除后才办结', done.pending === false)
  cleanup()
}

// 5. 重复上线不产生重复样例
{
  const store = createMemoryStorage()
  let bundle = await loadFresh(store)
  const first = bundle.mod.service.listEntries('air_emergency').items.length
  bundle.cleanup()
  bundle = await loadFresh(store)
  const second = bundle.mod.service.listEntries('air_emergency').items.length
  check('重复冷启动样例不重复', first === 3 && second === 3, `${first} → ${second}`)
  check('断点写入完成', JSON.parse(store.getItem(CHECKPOINT_KEY)).version === 2)
  bundle.cleanup()

  const dup = {
    air_emergency: [
      { id: 1, status: '待响应', pending: true, abnormal: false, 应急编号: 'AIR_-0001' },
      { id: 1, status: '待响应', pending: true, abnormal: false, 应急编号: 'AIR_-0001' },
      { id: 2, status: '待响应', pending: true, abnormal: false, 应急编号: 'AIR_-0002' },
      { id: 3, status: '待响应', pending: true, abnormal: false, 应急编号: 'AIR_-0003' },
    ],
  }
  const store2 = createMemoryStorage({ [ENTRIES_KEY]: JSON.stringify(dup) })
  const b2 = await loadFresh(store2)
  const rows = b2.mod.service.listEntries('air_emergency').items
  check('同 id/同业务编号的重复样例去重', rows.length === 3, `实际 ${rows.length}`)
  b2.cleanup()
}

// 6. 配置/落盘失败从断点继续：数据先落、断点后落，中断后重开自动补齐
{
  const store = createMemoryStorage()
  // 首开播种时写入顺序：① 完整数据（前置）② 完整数据（循环内首模块）③ 断点(模块1) ……
  // 让第 3 次 setItem 失败：完整数据已两次落盘，但一个模块断点都没提交。
  store.failOnSet(3)
  let b = await loadFresh(store)
  check('中断时尚无模块断点', store.getItem(CHECKPOINT_KEY) === null)
  const onDisk = store.getItem(ENTRIES_KEY)
  check('中断时完整数据已落盘（页面不丢数据）', onDisk !== null && JSON.parse(onDisk).air_emergency.length === 3)
  b.cleanup()

  // 重开：从断点继续，不重头播种，样例不重复
  b = await loadFresh(store)
  const after = JSON.parse(store.getItem(CHECKPOINT_KEY))
  check('断点续迁后版本补齐', after.version === 2)
  check('断点续迁覆盖全部模块', Object.keys(after.migrated).length === 18, `实际 ${Object.keys(after.migrated).length}`)
  const rows = b.mod.service.listEntries('air_emergency').items
  check('续迁后样例不重复', rows.length === 3, `实际 ${rows.length}`)
  b.cleanup()
}

// 7. 数据损坏：隔离备份 + 回退样例，不拿半截数据覆盖原记录
{
  const garbage = '{不是合法JSON'
  const store = createMemoryStorage({ [ENTRIES_KEY]: garbage })
  const { mod, cleanup } = await loadFresh(store)
  check('损坏数据回退到样例', mod.service.listEntries('air_emergency').items.length === 3)
  const backup = JSON.parse(store.getItem(CORRUPT_KEY))
  check('损坏原文已隔离备份', backup.raw === garbage)
  cleanup()
}

// 8. 老版本缺整个模块：补播种且幂等
{
  const store = createMemoryStorage({
    [ENTRIES_KEY]: JSON.stringify({ stand: [] }),
    [CHECKPOINT_KEY]: JSON.stringify({ version: 1 }),
  })
  const { mod, cleanup } = await loadFresh(store)
  check('缺模块补播种应急 3 条', mod.service.listEntries('air_emergency').items.length === 3)
  check('老模块数据保留', mod.service.listEntries('stand').items.length === 0)
  cleanup()
}

// 9. 动作可用集合与页面一致：只暴露当前状态下合法的动作
{
  const store = createMemoryStorage()
  const { mod, cleanup } = await loadFresh(store)
  const { listEntries, availableActions, runAction, moduleMeta } = mod.service
  const meta = moduleMeta('air_emergency')
  const waiting = listEntries('air_emergency').items.find((r) => r.status === '待响应')
  const handling = listEntries('air_emergency').items.find((r) => r.status === '处置中')
  check('待响应只可「启动响应」', availableActions(meta, waiting).join(',') === '启动响应')
  check('处置中只可「解除应急」', availableActions(meta, handling).join(',') === '解除应急')
  runAction('air_emergency', waiting.id, '启动响应')
  runAction('air_emergency', waiting.id, '落实处置')
  runAction('air_emergency', waiting.id, '解除应急')
  const done = listEntries('air_emergency').items.find((r) => r.id === waiting.id)
  check('已解除无可执行动作', availableActions(meta, done).length === 0)
  cleanup()
}

console.log(`\n全部通过：${passed} 项断言`)
