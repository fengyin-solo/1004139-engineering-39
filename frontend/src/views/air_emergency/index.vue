<template>
  <section class="page" data-module="air_emergency">
    <header class="page-head">
      <div>
        <h2>应急保障管理</h2>
        <p class="page-desc">维护应急保障，围绕应急编号、事件类型、涉及航班、事发位置做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记应急保障</button>
        <button class="btn" type="button" @click="exportRows">导出应急保障清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>审计标记</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>
            {{ row.status }}
            <span v-if="row.abnormal" class="audit-badge" title="该记录命中过撤销/作废等反向操作">异常</span>
          </td>
          <td>
            <span :class="['audit-flag', row.pending ? 'is-pending' : 'is-done']">
              {{ row.pending ? '未解除' : '已办结' }}
            </span>
          </td>
          <td class="row-actions">
            <template v-for="action in actionsFor(row)" :key="action">
              <button class="link" type="button" @click="runAction(action, row)">{{ action }}</button>
            </template>
            <span v-if="!actionsFor(row).length" class="muted-text">—</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无应急保障数据，可先登记应急保障</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条应急保障记录，处置中/响应中均属于未解除，只有「已解除」才办结</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  availableActions,
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

// 字段、状态、动作、指标全部取模块元数据，页面不再各写一份，避免和状态链脱节。
const meta = moduleMeta('air_emergency')
const columns = meta.fields
const filterFields = meta.fields.slice(0, 3)

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})

const statusSummary = computed(() =>
  meta.statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 指标卡与状态链对应：待响应事件→待响应；处置中事件→响应中+处置中（都还没解除）；
// 已解除事件→已解除。未解除的记录绝不计入已解除（已完成）。
function countByStatus(status: string): number {
  return rows.value.filter((row) => String(row.status) === status).length
}

const stats = computed(() => [
  { label: '待响应事件', value: countByStatus('待响应') },
  { label: '处置中事件', value: countByStatus('响应中') + countByStatus('处置中') },
  { label: '已解除事件', value: countByStatus('已解除') },
])

function actionsFor(row: EntryRow): string[] {
  return availableActions(meta, row)
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '应急保障登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '应急保障列表读取失败'
  }
}

onMounted(reload)
</script>
