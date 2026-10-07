import { MODULES, MODULE_BY_KEY } from './modules'
import { normalizeRows } from './audit'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'airport-ground-handling:entries'
// 迁移断点：记录每个模块已经完成迁移的版本，实现幂等与断点续迁。
const CHECKPOINT_KEY = 'airport-ground-handling:entries:schema'
// 当前数据结构版本：元数据/播种数据发生变化时只升版本号，老数据按模块增量兼容。
const SCHEMA_VERSION = 2
// 迁移失败时把读不出来的原始数据隔离到这里，不覆盖用户原有数据，便于排查。
const QUARANTINE_KEY = 'airport-ground-handling:entries:corrupt-backup'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function storage(): Storage | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  return window.localStorage
}

function writeStorage(key: string, value: string): boolean {
  const target = storage()
  if (!target) {
    return false
  }
  try {
    target.setItem(key, value)
    return true
  } catch {
    // 隐私模式/配额耗尽等写入失败：内存数据照常用，下次打开再从断点续迁。
    return false
  }
}

function seedAll(): Record<string, EntryRow[]> {
  return clone(SEED_ROWS)
}

type Checkpoint = { version?: number; migrated?: Record<string, number> }

function readCheckpoint(): Checkpoint {
  const target = storage()
  if (!target) {
    return {}
  }
  const raw = target.getItem(CHECKPOINT_KEY)
  if (!raw) {
    return {}
  }
  try {
    const parsed = JSON.parse(raw) as Checkpoint
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

// 把读不出来的原始串隔离保存，不丢弃；保存失败也不影响本次用迁移后的数据运行。
function quarantine(raw: string): void {
  writeStorage(QUARANTINE_KEY, JSON.stringify({ at: new Date().toISOString(), raw }))
}

// 读取并迁移全部数据：内存里逐模块规范化（所有模块都过一遍），再按断点逐模块持久化；
// 任何一步写入失败都立即停下，内存里保留完整的迁移结果，下次打开从断点继续。
function bootstrap(): Record<string, EntryRow[]> {
  const fallback = seedAll()
  const target = storage()
  if (!target) {
    return fallback
  }
  const raw = target.getItem(STORAGE_KEY)
  if (!raw) {
    return persistMigration(fallback, null)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // 整份数据解析不出来：隔离原文、回退样例，再尝试落盘，绝不拿半截数据覆盖原记录。
    quarantine(raw)
    return persistMigration(fallback, null)
  }
  if (!parsed || typeof parsed !== 'object') {
    quarantine(raw)
    return persistMigration(fallback, null)
  }
  const stored = parsed as Record<string, unknown>

  // 先在内存里完成全部模块的兼容迁移，保证页面永远拿到结构完整的数据。
  const migrated: Record<string, EntryRow[]> = {}
  for (const meta of MODULES) {
    if (!Array.isArray(stored[meta.key])) {
      // 老版本缺整个模块（重复上线新增模块的场景）：补播种，不会因为多开几次而重复追加。
      migrated[meta.key] = clone(fallback[meta.key] ?? [])
      continue
    }
    // 单个模块结构坏了：该模块回退样例，其他模块照常迁移，不连坐。
    migrated[meta.key] = normalizeRows(meta, stored[meta.key])
  }
  // 元数据里没有的老模块原样保留，升级后也不丢数据。
  for (const [key, value] of Object.entries(stored)) {
    if (!MODULE_BY_KEY.has(key)) {
      migrated[key] = clone(value as EntryRow[])
    }
  }

  return persistMigration(migrated, readCheckpoint())
}

// 按断点逐模块推进迁移：完整数据先落盘，再逐模块推进断点；
// 任何一步写入失败都立即停下，内存里始终是完整的迁移结果，下次打开从断点继续。
function persistMigration(
  data: Record<string, EntryRow[]>,
  checkpoint: Checkpoint | null,
): Record<string, EntryRow[]> {
  const target = storage()
  // 没有 localStorage（SSR/测试环境）时直接返回内存数据。
  if (!target) {
    return data
  }
  const mark = checkpoint ?? readCheckpoint()
  const migrated = mark.version === SCHEMA_VERSION ? mark.migrated ?? {} : {}
  const pendingModules = MODULES.some((meta) => migrated[meta.key] !== SCHEMA_VERSION)

  // 完整的迁移结果先落一次盘：即便紧接着在断点推进处失败，存储里也是结构完整的数据；
  // 全部模块都已完成迁移（重复上线）时跳过，避免无谓写入，也不会产生重复样例。
  if (pendingModules && !writeStorage(STORAGE_KEY, JSON.stringify(data))) {
    return data
  }

  for (const meta of MODULES) {
    if (migrated[meta.key] === SCHEMA_VERSION) {
      continue
    }
    const nextMark: Checkpoint = {
      version: SCHEMA_VERSION,
      migrated: { ...migrated, [meta.key]: SCHEMA_VERSION },
    }
    // 先落数据、后落断点：断点没写成时重开会重做这一模块，迁移是幂等的，安全。
    if (!writeStorage(STORAGE_KEY, JSON.stringify(data))) {
      break
    }
    if (!writeStorage(CHECKPOINT_KEY, JSON.stringify(nextMark))) {
      break
    }
    migrated[meta.key] = SCHEMA_VERSION
  }
  return data
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = bootstrap()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (writeStorage(STORAGE_KEY, JSON.stringify(next))) {
    // 用户改动已落盘，该模块的数据版本与当前结构一致，顺手把断点补齐。
    const mark = readCheckpoint()
    const migrated = mark.version === SCHEMA_VERSION ? mark.migrated ?? {} : {}
    writeStorage(
      CHECKPOINT_KEY,
      JSON.stringify({
        version: SCHEMA_VERSION,
        migrated: { ...migrated, [key]: SCHEMA_VERSION },
      }),
    )
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
