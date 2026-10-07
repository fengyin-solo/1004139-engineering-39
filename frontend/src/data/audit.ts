import type { EntryRow, ModuleMeta } from './types'

// 审计标记的唯一口径来源：应急保障页与运营概览共用，避免两个页面各算各的。
//
// - pending：记录尚未走到该模块的终态（状态链最后一个状态）。
//   注意：在应急保障里「处置中」不是终态，不能算已完成，只有「已解除」才是。
// - abnormal：命中过「往回走」类动作（撤销/作废/驳回等）。
//
// 状态含义本身不在这里改动，状态文案与终态都以 modules.ts 的元数据为准。

// 会写进数据的「往回走」动作：命中就把这条记录打上异常审计标记。
export const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function isNegativeAction(action: string): boolean {
  return NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb))
}

// 是否仍待处理：只有终态才算办结。不改变状态含义，只依据元数据里的状态链推导。
export function isPending(meta: ModuleMeta, status: string): boolean {
  return status !== meta.statuses[meta.statuses.length - 1]
}

// 旧数据兼容迁移：补齐缺失的审计标记与登记字段，不覆盖已有值、不改写状态文案。
export function normalizeRow(meta: ModuleMeta, raw: Partial<EntryRow>, fallbackId: number): EntryRow {
  const status = raw.status === undefined || raw.status === null ? meta.statuses[0] : String(raw.status)
  // 缺 abnormal 的老记录按「未发现异常」补位；一旦打过 true 就保留，作为审计痕迹。
  const abnormal = typeof raw.abnormal === 'boolean' ? raw.abnormal : false
  const filled: EntryRow = {
    ...(raw as EntryRow),
    id: typeof raw.id === 'number' && Number.isFinite(raw.id) ? raw.id : fallbackId,
    status,
    // 缺 pending 的老记录按「是否终态」重新推导，避免未解除记录被当成已完成。
    pending: typeof raw.pending === 'boolean' ? raw.pending : isPending(meta, status),
    abnormal,
  }
  // 缺业务字段不报错，统一补空串，页面上由「—」占位呈现。
  for (const field of meta.fields) {
    if (filled[field] === undefined || filled[field] === null) {
      filled[field] = ''
    }
  }
  return filled
}

// 同一行样例的判重键：登记 id 相同，或首个业务编号（如应急编号）相同即视为重复。
function rowIdentity(row: EntryRow, meta: ModuleMeta): string {
  const codeField = meta.fields[0]
  return `${String(row.id)}::${String(row[codeField] ?? '')}`
}

// 一组记录去重并迁移，保留首次出现的那条；重复上线/重复播种不会产生重复样例。
export function normalizeRows(meta: ModuleMeta, rows: unknown): EntryRow[] {
  if (!Array.isArray(rows)) {
    return []
  }
  const objects = rows.filter((item): item is Partial<EntryRow> => !!item && typeof item === 'object')
  // 缺 id 的老记录从现有最大 id 之后补号，避免和真实登记 id 撞号。
  let nextId = objects.reduce((max, item) => {
    return typeof item.id === 'number' && Number.isFinite(item.id) && item.id > max ? item.id : max
  }, 0)
  const seen = new Set<string>()
  const result: EntryRow[] = []
  for (const item of objects) {
    if (typeof item.id !== 'number' || !Number.isFinite(item.id)) {
      nextId += 1
      item.id = nextId
    }
    const row = normalizeRow(meta, item, item.id)
    const identity = rowIdentity(row, meta)
    if (seen.has(identity)) {
      continue
    }
    seen.add(identity)
    result.push(row)
  }
  return result
}
