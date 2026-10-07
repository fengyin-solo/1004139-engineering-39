<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h2>运营概览</h2>
        <p class="page-desc">汇总各业务模块的关键指标，先看总量再看异常。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="refresh">重新统计</button>
      </div>
    </header>
    <div class="stat-row">
      <article v-for="card in cards" :key="card.label" class="stat-card">
        <span class="stat-label">{{ card.label }}</span>
        <strong class="stat-value">{{ card.value }}</strong>
      </article>
    </div>
    <table class="data-table">
      <thead>
        <tr><th>业务模块</th><th>今日新增</th><th>待处理</th><th>异常量</th><th>审计标记</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in moduleRows" :key="row.name">
          <td>{{ row.name }}</td>
          <td>{{ row.created }}</td>
          <td>{{ row.pending }}</td>
          <td>{{ row.abnormal }}</td>
          <td>
            <span class="audit-tag" :class="auditTagClass(row.mark)">{{ auditTagText(row.mark) }}</span>
          </td>
        </tr>
      </tbody>
    </table>
    <footer class="page-foot">
      <span>数据保存在本机浏览器里，换浏览器或清缓存会回到示例数据；未解除/未闭环记录不会计入已完成</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

import { loadOverview } from '@/api/local-service'
import type { OverviewResult } from '@/data/types'

const cards = ref<OverviewResult['cards']>([])
const moduleRows = ref<OverviewResult['modules']>([])

// 审计标记的展示与业务页面共用同一来源（local-service 按末状态判定）。
function auditTagClass(mark: OverviewResult['modules'][number]['mark']): string {
  if (mark === 'abnormal') {
    return 'audit-abnormal'
  }
  if (mark === 'pending') {
    return 'audit-pending'
  }
  return 'audit-done'
}

function auditTagText(mark: OverviewResult['modules'][number]['mark']): string {
  if (mark === 'abnormal') {
    return '异常'
  }
  if (mark === 'pending') {
    return '未闭环'
  }
  return '已闭环'
}

function refresh() {
  const payload = loadOverview()
  cards.value = payload.cards
  moduleRows.value = payload.modules
}

onMounted(refresh)
</script>
