import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import { isNegativeAction, isPending } from '@/data/audit'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// 链路核对：动作能不能在当前状态上执行。
// - 终态（如应急的「已解除」）不再放行任何动作，不能把办结记录又改回去；
// - 正向动作只能落在状态链的相邻环节，不允许跳步；
// - 「往回走」类动作（撤销/作废/驳回等）不走正向链，任何非终态都可执行并打异常标记。
export function checkAction(meta: ModuleMeta, row: EntryRow, action: string): ActionResult {
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const statuses = meta.statuses
  const current = String(row.status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = statuses[statuses.length - 1]
  if (current === lastStatus) {
    return { ok: false, message: `${meta.entity}已是终态「${lastStatus}」，不能再执行「${action}」` }
  }
  if (!isNegativeAction(action)) {
    const currentIndex = statuses.indexOf(current)
    const targetIndex = statuses.indexOf(target)
    if (currentIndex < 0) {
      return { ok: false, message: `${meta.entity}当前状态「${current}」不在登记的状态链里，无法流转` }
    }
    if (targetIndex !== currentIndex + 1) {
      return { ok: false, message: `${meta.entity}需要按顺序流转，当前「${current}」不能直接跳到「${target}」` }
    }
  }
  return { ok: true, message: '' }
}

// 当前状态下真正可执行的动作，供页面只渲染合规按钮（页面本身不做业务判断）。
export function availableActions(meta: ModuleMeta, row: EntryRow): string[] {
  return meta.actions.filter((action) => checkAction(meta, row, action).ok)
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const guard = checkAction(meta, rows[index], action)
  if (!guard.ok) {
    return guard
  }
  const target = meta.actionTargets[action] as string
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  // 审计标记用统一口径：pending 看是否终态；abnormal 一旦命中过反向动作就保留。
  const negative = isNegativeAction(action)
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: isPending(meta, target),
    abnormal: negative || rows[index].abnormal === true,
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      // 与各业务页共用同一套审计标记：pending/abnormal 由数据层统一迁移与维护。
      pending: entries.filter((row) => row.pending === true).length,
      abnormal: entries.filter((row) => row.abnormal === true).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
