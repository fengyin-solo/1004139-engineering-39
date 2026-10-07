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
          <td>{{ row.status }}</td>
          <td>
            <!-- 审计标记与运营概览共用同一判定：末状态「已解除」才算闭环，
                 待响应/响应中/处置中一律展示为未解除，不当成已完成。 -->
            <span v-if="isAbnormalRow(row)" class="audit-tag audit-abnormal">异常</span>
            <span v-else-if="isPendingRow(meta, row)" class="audit-tag audit-pending">未解除</span>
            <span v-else class="audit-tag audit-done">已解除</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              :disabled="!canRunAction(meta, row, meta.actionTargets[action])"
              :title="canRunAction(meta, row, meta.actionTargets[action]) ? '' : '需按 待响应→响应中→处置中→已解除 顺序处置'"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无应急保障数据，可先登记应急保障</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条应急保障记录，其中未解除 {{ openCount }} 条</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { canRunAction, countByStatus, isAbnormalRow, isPendingRow } from '@/data/audit'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('air_emergency')
const columns = ["应急编号", "事件类型", "涉及航班", "事发位置", "响应等级", "响应人员", "处置措施", "应急状态"]
const actions = ["启动响应", "落实处置", "解除应急"]
const statuses = ["待响应", "响应中", "处置中", "已解除"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: countByStatus(rows.value, status),
  })),
)
// 统计指标全部由审计标记派生，与运营概览同口径。
const stats = computed(() => [
  { label: '待响应事件', value: countByStatus(rows.value, '待响应') },
  { label: '处置中事件', value: countByStatus(rows.value, '处置中') },
  { label: '已解除事件', value: countByStatus(rows.value, '已解除') },
])
const openCount = computed(() => rows.value.filter((row) => isPendingRow(meta, row)).length)

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
