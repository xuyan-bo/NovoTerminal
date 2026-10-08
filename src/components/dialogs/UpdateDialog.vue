<template>
  <el-dialog
    :title="$t('update.title')"
    :visible.sync="visible"
    width="520px"
    append-to-body
    :close-on-click-modal="false"
  >
    <div class="update-line">
      <span class="update-badge">{{ $t('update.newVersion', { version: info.latest }) }}</span>
      <span class="update-current">{{ $t('update.currentVersion', { version: info.current }) }}</span>
    </div>
    <template v-if="info.notes">
      <div class="update-notes-title">{{ $t('update.notes') }}</div>
      <div class="update-notes">{{ info.notes }}</div>
    </template>
    <div slot="footer">
      <el-button size="mini" @click="visible = false">{{ $t('msg.cancel') }}</el-button>
      <el-button size="mini" type="primary" @click="openReleases">{{ $t('settings.aboutReleases') }}</el-button>
    </div>
  </el-dialog>
</template>

<script>
import { store, api } from '../../store';

export default {
  name: 'UpdateDialog',
  computed: {
    visible: {
      get() {
        return store.updateDialog;
      },
      set(v) {
        store.updateDialog = v;
      },
    },
    info() {
      return store.update || { latest: '', current: '', notes: '' };
    },
  },
  methods: {
    openReleases() {
      if (store.update && api.openExternal) api.openExternal(store.update.url);
      this.visible = false;
    },
  },
};
</script>

<style scoped>
.update-line {
  display: flex;
  align-items: center;
  gap: 10px;
}
.update-badge {
  padding: 2px 10px;
  border-radius: 10px;
  background: var(--bg-elevated);
  color: var(--text);
  font-weight: 600;
}
.update-current {
  color: var(--text-3);
}
.update-notes-title {
  margin: 14px 0 6px;
  color: var(--text-2);
  font-size: 12px;
}
.update-notes {
  max-height: 240px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-elevated);
  color: var(--text);
  line-height: 1.6;
  white-space: pre-line;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.update-notes::-webkit-scrollbar {
  width: 8px;
}
.update-notes::-webkit-scrollbar-thumb {
  background: var(--border);
  border-radius: 4px;
}
.update-notes::-webkit-scrollbar-thumb:hover {
  background: var(--text-3);
}
.update-notes::-webkit-scrollbar-track {
  background: transparent;
}
</style>
