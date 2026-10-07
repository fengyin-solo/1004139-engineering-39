import type { EntryRow, ModuleMeta } from './types'

// 审计标记（audit marks）的唯一来源：待处理/异常都由这里判定，
// 业务页面和运营概览共用同一套口径，避免各页面各算各的。
//
// 约定：状态本身的含义一律不改，这里只做只读判定；
// 末状态视为「已闭环」，其余状态都算待处理，因此未解除的应急记录
// 绝不会被当成已完成。
export function isTerminalRow(meta: ModuleMeta, row: Pick<EntryRow, 'status'>): boolean {
  return String(row.status) === meta.statuses[meta.statuses.length - 1]
}

export function isPendingRow(meta: ModuleMeta, row: Pick<EntryRow, 'status'>): boolean {
  return !isTerminalRow(meta, row)
}

export function isAbnormalRow(row: Pick<EntryRow, 'abnormal'>): boolean {
  return row.abnormal === true
}

// 链路核对用：只允许沿登记的状态顺序向前走一步。
// 停在当前态、回退、跨级都返回 false，处置措施因此只能按
// 「待响应 → 响应中 → 处置中 → 已解除」推进。
export function canRunAction(
  meta: ModuleMeta,
  row: Pick<EntryRow, 'status'>,
  target: string,
): boolean {
  const currentIndex = meta.statuses.indexOf(String(row.status))
  const targetIndex = meta.statuses.indexOf(target)
  return currentIndex >= 0 && targetIndex === currentIndex + 1
}

// 业务字段（各模块 fields 之外的列），迁移时用来补缺失字段。
function toId(value: unknown): number | null {
  const num = Number(value)
  return Number.isFinite(num) && num > 0 ? Math.trunc(num) : null
}

// 兼容迁移：旧版本地记录可能缺 pending/abnormal 或个别业务字段，
// 这里只补缺失、按状态重算待处理标记，不改写任何已有状态的含义。
export function normalizeRow(meta: ModuleMeta, raw: unknown, fallbackId: number): EntryRow | null {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const source = raw as Record<string, unknown>
  const id = toId(source.id) ?? fallbackId
  const status = typeof source.status === 'string' && source.status ? source.status : meta.statuses[0]
  const row: EntryRow = {
    id,
    status,
    pending: true,
    abnormal: false,
  }
  for (const field of meta.fields) {
    if (source[field] !== undefined && source[field] !== null) {
      row[field] = source[field] as string | number | boolean
    } else {
      row[field] = ''
    }
  }
  row.pending = isPendingRow(meta, { status })
  row.abnormal = source.abnormal === true
  return row
}

// 迁移整模块：按业务主键去重（重复上线/重复播种不会产生重复样例），
// 业务主键缺失时退回按编号去重；编号缺失或撞号的统一补发新号。
export function migrateRows(meta: ModuleMeta, rawRows: unknown[]): EntryRow[] {
  const migrated: EntryRow[] = []
  const seenKeys = new Set<string>()
  for (const raw of rawRows) {
    const candidate = normalizeRow(meta, raw, 0)
    if (!candidate) {
      continue
    }
    const businessValue = candidate[meta.fields[0]]
    const dedupeKey =
      businessValue !== '' && businessValue !== undefined
        ? `biz:${String(businessValue)}`
        : `id:${candidate.id}`
    if (seenKeys.has(dedupeKey)) {
      continue
    }
    seenKeys.add(dedupeKey)
    migrated.push(candidate)
  }
  const usedIds = new Set<number>()
  for (const row of migrated) {
    if (row.id > 0) {
      usedIds.add(row.id)
    }
  }
  let nextId = 0
  const takeId = () => {
    nextId += 1
    while (usedIds.has(nextId)) {
      nextId += 1
    }
    usedIds.add(nextId)
    return nextId
  }
  for (const row of migrated) {
    if (row.id <= 0) {
      row.id = takeId()
    }
  }
  return migrated
}

// 各页面统计某状态数量时也走这里，保证和概览页同一口径。
export function countByStatus(rows: Pick<EntryRow, 'status'>[], status: string): number {
  return rows.filter((row) => String(row.status) === status).length
}