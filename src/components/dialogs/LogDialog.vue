<template>
  <el-dialog
    :title="$t('log.title')"
    :visible.sync="modalVisible"
    width="920px"
    top="7vh"
    :close-on-click-modal="false"
    class="log-dialog"
  >
    <div class="log-toolbar">
      <el-select
        v-model="level"
        size="mini"
        style="width: 120px"
        :placeholder="$t('log.allLevels')"
        @change="reload"
      >
        <el-option :label="$t('log.allLevels')" value="" />
        <el-option label="error" value="error" />
        <el-option label="warn" value="warn" />
        <el-option label="info" value="info" />
      </el-select>
      <el-input
        v-model="keyword"
        size="mini"
        :placeholder="$t('log.keyword')"
        clearable
        style="width: 240px"
        @keyup.enter.native="reload"
        @clear="reload"
      />
      <el-button size="mini" :loading="loading" @click="load">{{ $t('log.refresh') }}</el-button>
      <div class="spacer"></div>
      <el-button size="mini" type="danger" plain :disabled="!total" @click="onClear">
        {{ $t('log.clear') }}
      </el-button>
    </div>

    <el-table
      v-loading="loading"
      :data="rows"
      border
      stripe
      size="small"
      height="430"
      class="log-table"
      @cell-contextmenu="onCellCtx"
    >
      <el-table-column :label="$t('log.colTime')" width="158">
        <template slot-scope="{ row }">{{ fmtTime(row.time) }}</template>
      </el-table-column>
      <el-table-column :label="$t('log.colLevel')" width="80" align="center">
        <template slot-scope="{ row }">
          <span class="log-level" :class="'lv-' + row.level">{{ row.level }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="$t('log.colSource')" width="98">
        <template slot-scope="{ row }">{{ row.source }}</template>
      </el-table-column>
      <el-table-column :label="$t('log.colMessage')" min-width="360" show-overflow-tooltip>
        <template slot-scope="{ row }">
          {{ row.message }}<template v-if="metaText(row)"><span class="log-meta">{{ metaText(row) }}</span></template>
        </template>
      </el-table-column>
    </el-table>

    <div class="log-pager">
      <el-pagination
        background
        layout="total, sizes, prev, pager, next"
        :total="total"
        :current-page="page"
        :page-size="pageSize"
        :page-sizes="[50, 100, 200, 500]"
        @current-change="onPage"
        @size-change="onSize"
      />
    </div>

    <ctx-menu ref="ctxMenu" @select="onCtxSelect" />

    <template #footer>
      <el-button size="mini" @click="modalVisible = false">{{ $t('log.close') }}</el-button>
    </template>
  </el-dialog>
</template>

<script>
import { store, api } from '../../store';
import { t } from '../../i18n';
import CtxMenu from '../common/CtxMenu.vue';

const TWO = (n) => String(n).padStart(2, '0');

export default {
  name: 'LogDialog',
  components: { CtxMenu },
  data() {
    return {
      rows: [],
      level: '',
      keyword: '',
      loading: false,
      total: 0,
      page: 1,
      pageSize: 100,
    };
  },
  computed: {
    modalVisible: {
      get() {
        return store.logDialog;
      },
      set(v) {
        store.logDialog = v;
      },
    },
  },
  created() {
    this._ctxText = '';
  },
  watch: {
    modalVisible(v) {
      if (v) this.load();
    },
  },
  mounted() {
    this._offLog = api.onLog && api.onLog((entry) => this.push(entry));
  },
  beforeDestroy() {
    if (this._offLog) this._offLog();
  },
  methods: {
    onCellCtx(row, column, cell, e) {
      e.preventDefault();
      this._ctxText = (cell.innerText || cell.textContent || '').trim();
      if (!this._ctxText) return;
      this.$refs.ctxMenu.open(e, [{ label: t('log.copy'), action: 'copy' }]);
    },
    async onCtxSelect(item) {
      if (!item || item.action !== 'copy' || !this._ctxText) return;
      const value = this._ctxText;
      try {
        if (api.clipboardWriteText) {
          const ok = await api.clipboardWriteText(value);
          if (ok) {
            this.$message.success(t('log.copied'));
            return;
          }
        }
      } catch (_) {}
      try {
        await navigator.clipboard.writeText(value);
        this.$message.success(t('log.copied'));
      } catch (_) {}
    },
    async load() {
      if (!api.logList) {
        this.rows = [];
        this.total = 0;
        return;
      }
      this.loading = true;
      try {
        const r = await api.logList({
          level: this.level || undefined,
          keyword: this.keyword || undefined,
          limit: this.pageSize,
          offset: (this.page - 1) * this.pageSize,
        });
        this.total = (r && r.total) || 0;
        this.rows = (r && r.entries) || [];
        const maxPage = Math.max(1, Math.ceil(this.total / this.pageSize));
        if (this.page > maxPage) {
          this.page = maxPage;
          await this.load();
        }
      } catch (e) {
        this.$message.error(e.message || String(e));
      } finally {
        this.loading = false;
      }
    },
    reload() {
      this.page = 1;
      this.load();
    },
    onPage(p) {
      this.page = p;
      this.load();
    },
    onSize(s) {
      this.pageSize = s;
      this.page = 1;
      this.load();
    },
    push(entry) {
      if (!entry || typeof entry !== 'object' || !entry.time) return;
      this.total++;
      // 仅在第一页且未筛选时实时插入，避免分页偏移错乱
      if (this.page === 1 && !this.level && !String(this.keyword).trim()) {
        this.rows.unshift(entry);
        if (this.rows.length > this.pageSize) this.rows.pop();
      }
    },
    async onClear() {
      try {
        await this.$confirm(t('log.clearConfirm'), t('log.clearTitle'), { type: 'warning' });
      } catch (_) {
        return;
      }
      try {
        if (api.logClear) await api.logClear();
        this.rows = [];
        this.total = 0;
        this.page = 1;
        this.$message.success(t('log.cleared'));
      } catch (e) {
        this.$message.error(e.message || String(e));
      }
    },
    fmtTime(ms) {
      const d = new Date(ms);
      return `${d.getFullYear()}-${TWO(d.getMonth() + 1)}-${TWO(d.getDate())} ${TWO(d.getHours())}:${TWO(d.getMinutes())}:${TWO(d.getSeconds())}`;
    },
    metaText(e) {
      const m = e && e.meta;
      if (m == null) return '';
      try {
        return ' · ' + JSON.stringify(m);
      } catch (_) {
        return '';
      }
    },
  },
};
</script>

<style scoped>
.log-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.log-toolbar .spacer {
  flex: 1;
}
.log-pager {
  display: flex;
  justify-content: flex-end;
  margin-top: 10px;
}
.log-level {
  display: inline-block;
  min-width: 44px;
  padding: 0 4px;
  text-align: center;
  font-weight: 600;
  border-radius: 3px;
  font-size: 10px;
  line-height: 16px;
}
.log-level.lv-error {
  color: #f56c6c;
  background: rgba(245, 108, 108, 0.14);
}
.log-level.lv-warn {
  color: #e6a23c;
  background: rgba(230, 162, 60, 0.14);
}
.log-level.lv-info {
  color: var(--text-2);
  background: rgba(128, 128, 128, 0.14);
}
.log-meta {
  color: var(--text-3);
}
</style>