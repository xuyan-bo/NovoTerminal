<template>
  <el-dialog
    :title="$t('update.title')"
    :visible.sync="visible"
    width="520px"
    append-to-body
    :close-on-click-modal="false"
    @close="onClose"
  >
    <div class="update-line">
      <span class="update-badge">{{ $t('update.newVersion', { version: info.latest }) }}</span>
      <span class="update-current">{{ $t('update.currentVersion', { version: info.current }) }}</span>
    </div>
    <template v-if="info.notes">
      <div class="update-notes-title">{{ $t('update.notes') }}</div>
      <div class="update-notes">{{ info.notes }}</div>
    </template>
    <div slot="footer" class="update-footer">
      <el-checkbox v-model="ignoreChecked">{{ $t('update.ignoreVersion') }}</el-checkbox>
      <div class="update-footer-actions">
        <el-button size="mini" @click="visible = false">{{ $t('msg.cancel') }}</el-button>
        <el-popover v-model="releasePopover" placement="top" width="160" trigger="click">
          <div class="release-picks">
            <button
              v-if="githubReleasesUrl"
              type="button"
              class="release-pick"
              @click="goRelease(githubReleasesUrl)"
            >
              <img class="brand brand-github" :src="'icons/github.svg'" alt="" />GitHub
            </button>
            <button type="button" class="release-pick" @click="goRelease(giteeReleasesUrl)">
              <img class="brand" :src="'icons/gitee.svg'" alt="" />Gitee
            </button>
          </div>
          <el-button slot="reference" size="mini" type="primary">{{ $t('settings.aboutReleases') }}</el-button>
        </el-popover>
      </div>
    </div>
  </el-dialog>
</template>

<script>
import { store, api, ignoreUpdateVersion } from '../../store';

export default {
  name: 'UpdateDialog',
  data() {
    return {
      ignoreChecked: false,
      releasePopover: false,
      giteeReleasesUrl: import.meta.env.VITE_HOMEPAGE + '/releases',
      githubReleasesUrl: import.meta.env.VITE_GITHUB_HOMEPAGE
        ? import.meta.env.VITE_GITHUB_HOMEPAGE + '/releases'
        : '',
    };
  },
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
    goRelease(url) {
      this.releasePopover = false;
      if (url && api.openExternal) api.openExternal(url);
    },
    /** 勾选「忽略此版本」后经任意方式关闭才落盘；同版本下次不再提示。 */
    onClose() {
      if (!this.ignoreChecked) return;
      const latest = store.update && store.update.latest;
      this.ignoreChecked = false;
      ignoreUpdateVersion(latest).catch(() => {});
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
  padding: 3px 12px;
  border-radius: 10px;
  background: var(--success);
  color: #fff;
  font-weight: 700;
  letter-spacing: 0.2px;
  box-shadow: 0 0 0 3px rgba(103, 194, 58, 0.18);
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
.update-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.update-footer-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.release-picks {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.release-pick {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.release-pick:hover {
  background: var(--bg-elevated);
}
.brand {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  object-fit: contain;
}
/* GitHub 原色为黑，深色主题反相为白以保证可见；Gitee 保持原红不动 */
.brand-github {
  filter: invert(1);
}
html.theme-light .brand-github {
  filter: none;
}
</style>
