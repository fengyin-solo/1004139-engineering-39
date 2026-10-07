import { migrateRows } from './audit'
import { MODULE_BY_KEY, MODULES } from './modules'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都在。
//
// 存储分两层：
// - 分模块键 <前缀>:<模块key>：每写好一个模块就落一个键，键存在即断点，
//   下次加载直接跳过，配置/迁移在中途失败可以从断点继续，不从头再来。
// - 整包旧键 STORAGE_KEY：老版本把全部模块写在一个键里，首次升级时逐个
//   模块读出迁移；整包 JSON 损坏时只隔离不覆盖，避免把已有数据清空。
const STORAGE_KEY = 'airport-ground-handling:entries'
const MODULE_KEY_PREFIX = `${STORAGE_KEY}:`

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function storage(): Storage | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  return window.localStorage
}

// 持久化失败（隐私模式 / 配额）不抛出：内存里仍可用，刷新后重新迁移即可，
// 断点没写上就当这次没跑完，符合「从断点继续」。
function persist(key: string, value: string): boolean {
  const target = storage()
  if (!target) {
    return false
  }
  try {
    target.setItem(key, value)
    return true
  } catch {
    return false
  }
}

function readJson(key: string): unknown | null {
  const target = storage()
  if (!target) {
    return null
  }
  let raw: string | null
  try {
    raw = target.getItem(key)
  } catch {
    return null
  }
  if (raw === null) {
    return null
  }
  try {
    return JSON.parse(raw)
  } catch {
    return undefined // 键在但内容损坏：与「没有键」区分开
  }
}

// 读老版本整包数据：解析失败时隔离到时间戳键并返回 null，绝不拿示例数据
// 覆盖用户数据；隔离写失败也保留原键，下次加载再试。
function readLegacyBundle(): Record<string, unknown[]> | null {
  const parsed = readJson(STORAGE_KEY)
  if (parsed === null) {
    return null
  }
  if (parsed === undefined || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const target = storage()
    if (target) {
      const raw = target.getItem(STORAGE_KEY)
      const quarantineKey = `${STORAGE_KEY}:corrupt:${Date.now()}`
      if (persist(quarantineKey, raw ?? '') && persist(STORAGE_KEY, '{}')) {
        try {
          target.removeItem(STORAGE_KEY)
        } catch {
          // 删不掉也不影响：内容已置成空对象，分模块键才是读取入口
        }
      }
    }
    return null
  }
  return parsed as Record<string, unknown[]>
}

// 载入单个模块：分模块键是断点，已迁移过就直接读；键损坏则隔离该模块后
// 用旧整包/示例数据继续，不牵连其它模块。
function loadModule(key: string, legacy: Record<string, unknown[]> | null): EntryRow[] {
  const meta = MODULE_BY_KEY.get(key)!
  const moduleKey = `${MODULE_KEY_PREFIX}${key}`
  const parsed = readJson(moduleKey)
  if (Array.isArray(parsed)) {
    return migrateRows(meta, parsed)
  }
  if (parsed === undefined) {
    // 只有这一个模块的分键坏了：先隔离，后续数据源照常迁移。
    const target = storage()
    if (target) {
      try {
        const raw = target.getItem(moduleKey)
        persist(`${moduleKey}.corrupt.${Date.now()}`, raw ?? '')
        target.removeItem(moduleKey)
      } catch {
        // 隔离失败时退回内存态，不阻断加载
      }
    }
  }
  const source =
    legacy && Array.isArray(legacy[key]) ? legacy[key] : clone(SEED_ROWS[key] ?? [])
  const rows = migrateRows(meta, source as unknown[])
  persist(moduleKey, JSON.stringify(rows))
  return rows
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    const legacy = readLegacyBundle()
    const loaded: Record<string, EntryRow[]> = {}
    let allPersisted = true
    for (const meta of MODULES) {
      const rows = loadModule(meta.key, legacy)
      loaded[meta.key] = rows
      if (storage()?.getItem(`${MODULE_KEY_PREFIX}${meta.key}`) === null) {
        allPersisted = false
      }
    }
    // 所有模块都有断点后，老整包键才算完成迁移，才能清理。
    if (legacy !== null && allPersisted) {
      try {
        storage()?.removeItem(STORAGE_KEY)
      } catch {
        // 留着老键也不影响读取，下次加载再清
      }
    }
    cache = loaded
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  persist(`${MODULE_KEY_PREFIX}${key}`, JSON.stringify(rows))
}

export function resetRows(key: string): EntryRow[] {
  const meta = MODULE_BY_KEY.get(key)
  const rows = meta ? migrateRows(meta, clone(SEED_ROWS[key] ?? [])) : []
  saveRows(key, rows)
  return rows
}

// 调试/排障用：旧整包键与新分模块键共享同一前缀。
export function storageKey(): string {
  return STORAGE_KEY
}

export function moduleStorageKey(key: string): string {
  return `${MODULE_KEY_PREFIX}${key}`
}
