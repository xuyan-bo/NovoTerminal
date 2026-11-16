<template>
  <el-dialog
    v-model="modalVisible"
    width="min(980px, 94vw)"
    :close-on-click-modal="false"
  >
    <template #header>
      <div class="dlg-head">
        <el-icon class="dlg-icon"><Key /></el-icon>
        <span>{{ $t('cred.title') }}</span>
      </div>
    </template>

    <div class="cred-toolbar">
      <el-input
        v-model="keyword"
        class="cred-search"
        :placeholder="$t('cred.searchPh')"
        clearable
        prefix-icon="Search"
      />
      <el-button type="primary" plain class="cred-add" icon="Plus" @click="openCreate">
        {{ $t('cred.new') }}
      </el-button>
    </div>

    <!-- 落点按光标与卡片几何计算，监听挂在整个可视区上：卡片下方的空白也算末尾 -->
    <div v-loading="revealing" class="cred-body" @dragover="onDragOver" @drop="onDrop">
      <el-scrollbar class="cred-scroll">
        <div ref="grid" class="cred-grid" @click="confirmId = null">
          <div
            v-for="(row, index) in rows"
            :key="row.id"
            class="cred-card"
            :class="{
              'is-dragging': dragId === row.id,
              'drop-before': dropAt === index,
              'drop-after': dropAt === index + 1 && index === rows.length - 1,
            }"
          >
            <el-tooltip :content="$t('cred.drag')" placement="top" :disabled="!!keyword">
              <span
                class="card-grip"
                :class="{ 'is-off': !!keyword }"
                :draggable="!keyword"
                @dragstart="onDragStart(row, $event)"
                @dragend="onDragEnd"
              >
                <el-icon><Rank /></el-icon>
              </span>
            </el-tooltip>
            <span class="kind-ico" :class="{ 'is-key': row.kind === 'key' }">
              <el-icon><Key /></el-icon>
            </span>

            <div class="card-main">
              <div class="card-line">
                <span class="card-title" :title="row.name" @click="openRow(row, 'view')">
                  {{ row.name }}
                </span>
                <span class="pill" :class="row.kind === 'key' ? 'cred-kind-key' : 'cred-kind-pass'">
                  {{ row.kind === 'key' ? $t('cred.kindKey') : $t('cred.kindPassword') }}
                </span>
              </div>
              <div class="card-sub">
                <span class="card-user">
                  <el-icon><User /></el-icon>
                  <span>{{ row.user || '—' }}</span>
                </span>
                <span class="card-note">{{ row.note || '—' }}</span>
              </div>
            </div>

            <span class="card-time">
              <el-icon><Clock /></el-icon>
              <span>{{ fmtTime(row.updatedAt) }}</span>
            </span>

            <div class="card-acts">
              <el-tooltip :content="$t('cred.view')" placement="top">
                <el-button class="ibtn" icon="View" :aria-label="$t('cred.view')" @click="openRow(row, 'view')" />
              </el-tooltip>
              <el-tooltip :content="$t('cred.edit')" placement="top">
                <el-button class="ibtn is-edit" icon="EditPen" :aria-label="$t('cred.edit')" @click="openRow(row, 'edit')" />
              </el-tooltip>
              <el-tooltip :content="$t('cred.del')" placement="top">
                <el-button class="ibtn is-del" icon="Delete" :aria-label="$t('cred.del')" @click.stop="confirmId = row.id" />
              </el-tooltip>
            </div>

            <!-- 删除确认：叠在卡片下方（最后一条改到上方），行内展开不弹浮层，避免滚动容器裁切 -->
            <div
              v-if="confirmId === row.id"
              class="card-confirm"
              :class="{ 'is-up': index === rows.length - 1 }"
              @click.stop
            >
              <span class="confirm-text">{{ $t('msg.confirmDeleteCredential') }}</span>
              <div class="confirm-acts">
                <el-button size="small" @click="confirmId = null">{{ $t('settings.cancel') }}</el-button>
                <el-button size="small" type="danger" @click="confirmRemove(row)">
                  {{ $t('msg.confirm') }}
                </el-button>
              </div>
            </div>
          </div>
        </div>

        <div v-if="!rows.length" class="cred-empty">
          <el-icon><Search /></el-icon>
          <span>{{ keyword ? $t('cred.emptySearch') : $t('cred.empty') }}</span>
        </div>
      </el-scrollbar>
    </div>

    <el-dialog
      :title="formTitle"
      v-model="formOpen"
      width="min(560px, 92vw)"
      append-to-body
      :close-on-click-modal="false"
    >
      <el-form
        ref="form"
        :model="form"
        :rules="rules"
        label-width="100px"
        @submit.prevent
      >
        <el-form-item :label="$t('cred.name')" prop="name">
          <el-input
            v-model="form.name"
            :placeholder="$t('cred.namePh')"
            maxlength="128"
            clearable
            :disabled="readonly"
          />
        </el-form-item>
        <el-form-item :label="$t('cred.kind')" prop="kind">
          <el-select
            v-model="form.kind"
            style="width: 200px"
            :disabled="readonly"
            @change="clearSecretErrors"
          >
            <el-option :label="$t('cred.kindPassword')" value="password" />
            <el-option :label="$t('cred.kindKey')" value="key" />
          </el-select>
        </el-form-item>
        <el-form-item :label="$t('cred.user')" prop="user">
          <el-input
            v-model="form.user"
            :placeholder="$t('cred.userPh')"
            maxlength="256"
            clearable
            :disabled="readonly"
          />
        </el-form-item>
        <el-form-item v-if="form.kind === 'password'" :label="$t('cred.pass')" prop="pass">
          <!-- 秘密字段不写 maxlength：被浏览器静默剪短的内容只会在连接时报解析失败，长度上限由主进程报错 -->
          <!-- 眼睛自绘：Element 的 show-password 在 readonly 下不渲染，查看模式既要锁输入又要能切明文 -->
          <el-input
            v-model="form.pass"
            :type="passVisible ? 'text' : 'password'"
            :placeholder="$t('cred.passPh')"
            :readonly="readonly"
            autocomplete="off"
          >
            <template #append>
              <button
                type="button"
                class="pass-reveal-btn"
                :title="passVisible ? $t('auth.hidePass') : $t('auth.revealPass')"
                @click="passVisible = !passVisible"
              >
                <svg-icon v-if="!passVisible" name="eye-open" :size="20" />
                <svg-icon v-else name="eye-closed" :size="20" />
              </button>
            </template>
          </el-input>
        </el-form-item>
        <template v-else>
          <el-form-item :label="$t('cred.privateKey')" prop="privateKey">
            <el-button
              class="cred-pick"
              icon="FolderOpened"
              :disabled="readonly"
              @click="pickKeyFile"
            >
              {{ $t('cred.pickKey') }}
            </el-button>
            <el-input
              v-model="form.privateKey"
              type="textarea"
              :rows="6"
              :placeholder="$t('cred.privateKeyPh')"
              :disabled="readonly"
            />
          </el-form-item>
          <el-form-item :label="$t('cred.passphrase')" prop="passphrase">
            <el-input
              v-model="form.passphrase"
              :type="passphraseVisible ? 'text' : 'password'"
              :placeholder="$t('cred.passphrasePh')"
              :readonly="readonly"
              autocomplete="off"
            >
              <template #append>
                <button
                  type="button"
                  class="pass-reveal-btn"
                  :title="passphraseVisible ? $t('auth.hidePass') : $t('auth.revealPass')"
                  @click="passphraseVisible = !passphraseVisible"
                >
                  <svg-icon v-if="!passphraseVisible" name="eye-open" :size="20" />
                  <svg-icon v-else name="eye-closed" :size="20" />
                </button>
              </template>
            </el-input>
          </el-form-item>
        </template>
        <el-form-item :label="$t('cred.note')" prop="note">
          <el-input
            v-model="form.note"
            type="textarea"
            :rows="2"
            maxlength="512"
            :disabled="readonly"
          />
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="formOpen = false">
          {{ readonly ? $t('settings.close') : $t('settings.cancel') }}
        </el-button>
        <el-button
          v-if="!readonly"
          type="primary"
          :loading="saving"
          :disabled="revealing"
          @click="save"
        >
          {{ $t('cred.save') }}
        </el-button>
      </template>
    </el-dialog>
  </el-dialog>
</template>

<script>
import {
  connectionErrorMessage,
  store,
  api,
  unwrap,
  createCredential,
  updateCredential,
  deleteCredential,
  reorderCredential,
} from '../../store';
import { t } from '../../i18n';

const TWO = (n) => String(n).padStart(2, '0');

function blankForm() {
  return {
    name: '',
    kind: 'password',
    user: '',
    pass: '',
    privateKey: '',
    passphrase: '',
    note: '',
  };
}

/** credential:reveal 把系统身份验证的错误码原样带回来，文案口径与查看资产密码一致。 */
function authErrorMessage(e) {
  const code = (e && e.code) || '';
  if (/Canceled|UserCanceled/i.test(code)) return t('auth.canceled');
  if (/NotConfigured/i.test(code)) return t('auth.notConfigured');
  return (e && e.message) || t('auth.failed');
}

export default {
  name: 'CredentialDialog',
  data() {
    return {
      keyword: '',
      formOpen: false,
      formMode: 'edit',
      editId: null,
      revealing: false,
      saving: false,
      passVisible: false,
      passphraseVisible: false,
      dragId: null,
      dropAt: -1,
      confirmId: null,
      form: blankForm(),
      rules: {
        name: [
          {
            required: true,
            validator: (rule, value, cb) =>
              cb(String(value || '').trim() ? undefined : new Error(t('cred.nameRequired'))),
            trigger: 'change',
          },
        ],
        user: [
          {
            required: true,
            validator: (rule, value, cb) =>
              cb(String(value || '').trim() ? undefined : new Error(t('cred.userRequired'))),
            trigger: 'change',
          },
        ],
        pass: [
          {
            required: true,
            validator: (rule, value, cb) =>
              cb(this.form.kind !== 'password' || value ? undefined : new Error(t('cred.passRequired'))),
            trigger: 'change',
          },
        ],
        privateKey: [
          {
            required: true,
            validator: (rule, value, cb) =>
              cb(
                this.form.kind !== 'key' || value.trim() ? undefined : new Error(t('cred.keyRequired'))
              ),
            trigger: 'change',
          },
        ],
      },
    };
  },
  computed: {
    modalVisible: {
      get() {
        return store.credentialDialog;
      },
      set(v) {
        store.credentialDialog = v;
      },
    },
    readonly() {
      return this.formMode === 'view';
    },
    rows() {
      const list = store.snapshot.credentials || [];
      const q = this.keyword.trim().toLowerCase();
      if (!q) return list;
      return list.filter(
        (c) =>
          (c.name || '').toLowerCase().includes(q) || (c.user || '').toLowerCase().includes(q)
      );
    },
    formTitle() {
      if (this.readonly) return t('cred.viewTitle');
      return this.editId ? t('cred.editTitle') : t('cred.createTitle');
    },
  },
  watch: {
    modalVisible(v) {
      if (v) return;
      this.formOpen = false;
      this.resetForm();
      this.keyword = '';
      // keyword 本来就是空时上面的赋值不触发 watcher，删除确认会残留到下次打开
      this.confirmId = null;
      this.dragId = null;
      this.dropAt = -1;
    },
    keyword() {
      // 搜索会打乱列表顺序，拖动与删除确认同时失效
      this.confirmId = null;
      this.dragId = null;
      this.dropAt = -1;
    },
    formOpen(v) {
      if (!v) this.resetForm();
    },
  },
  created() {
    this._revealSeq = 0;
    this._dragRow = null;
  },
  methods: {
    fmtTime(ms) {
      if (!ms) return '—';
      const d = new Date(ms);
      return `${d.getFullYear()}-${TWO(d.getMonth() + 1)}-${TWO(d.getDate())} ${TWO(d.getHours())}:${TWO(d.getMinutes())}`;
    },
    openCreate() {
      this.confirmId = null;
      this.resetForm();
      this.formMode = 'edit';
      this.formOpen = true;
    },
    /** 进表单前先过一次系统身份验证，通过才拿到明文；取消或失败就停在列表。 */
    async openRow(row, formMode) {
      if (this.revealing) return;
      this.confirmId = null;
      const seq = ++this._revealSeq;
      this.revealing = true;
      try {
        const full = unwrap(await api.revealCredential(row.id));
        // 认证期间可能又点了别的凭证，晚到的结果只让最后一次生效
        if (seq !== this._revealSeq) return;
        this.resetForm();
        this.editId = row.id;
        this.form = {
          ...blankForm(),
          name: row.name,
          kind: row.kind,
          user: row.user,
          note: row.note,
          pass: full.pass || '',
          privateKey: full.privateKey || '',
          passphrase: full.passphrase || '',
        };
        this.formMode = formMode;
        this.formOpen = true;
      } catch (e) {
        if (seq !== this._revealSeq) return;
        this.$message.error(authErrorMessage(e));
      } finally {
        if (seq === this._revealSeq) this.revealing = false;
      }
    },
    /** 关掉表单弹窗只清草稿，列表弹窗留在原位 */
    resetForm() {
      this._revealSeq++;
      this.revealing = false;
      this.editId = null;
      this.dropAt = -1;
      this._dragRow = null;
      this.dragId = null;
      this.form = blankForm();
      this.passVisible = false;
      this.passphraseVisible = false;
      // el-input 的 value 监听会补发一次 change 校验，清报错必须等这轮渲染完
      this.$nextTick(() => {
        if (this.$refs.form) this.$refs.form.clearValidate();
      });
    },
    clearSecretErrors() {
      if (this.$refs.form) this.$refs.form.clearValidate(['pass', 'privateKey']);
    },
    /** 主进程挑文件并读内容，取消时回 null；私钥内容仍可手改，所以填完再校验一次清掉旧报错。 */
    async pickKeyFile() {
      if (this.readonly) return;
      try {
        const picked = unwrap(await api.browseCredentialKey());
        if (!picked) return;
        this.form.privateKey = picked.content;
        if (this.$refs.form) this.$refs.form.validateField('privateKey', () => {});
      } catch (e) {
        const code = e.code === 'KEY_TOO_LARGE' ? 'cred.keyTooLarge' : e.code === 'NOT_PRIVATE_KEY' ? 'cred.keyInvalid' : '';
        this.$message.error(code ? t(code) : e.message || t('cred.keyInvalid'));
      }
    },
    onDragStart(row, e) {
      if (this.keyword) return;
      this._dragRow = row;
      this.dragId = row.id;
      this.confirmId = null;
      if (!e.dataTransfer) return;
      e.dataTransfer.effectAllowed = 'move';
      // Chromium 要求拖拽带上数据，否则 dragstart 之后没有后续事件
      e.dataTransfer.setData('text/plain', row.id);
    },
    onDragEnd() {
      this._dragRow = null;
      this.dragId = null;
      this.dropAt = -1;
    },
    /** 落点：光标在卡片上半＝插到该卡前，越过全部卡片（含下方空白）＝末尾追加。 */
    dropIndex(e) {
      const grid = this.$refs.grid;
      if (!grid) return this.rows.length;
      const cards = grid.querySelectorAll('.cred-card');
      for (let i = 0; i < cards.length; i++) {
        const box = cards[i].getBoundingClientRect();
        if (e.clientY < box.top + box.height / 2) return i;
      }
      return cards.length;
    },
    onDragOver(e) {
      if (!this._dragRow) return;
      const from = this.rows.findIndex((r) => r.id === this._dragRow.id);
      const i = this.dropIndex(e);
      // 落回自己原位前后（from / from+1）顺序不会变，不画插入线，否则松手看着像没生效
      this.dropAt = i === from || i === from + 1 ? -1 : i;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    },
    async onDrop(e) {
      e.preventDefault();
      const src = this._dragRow;
      const at = this.dropAt;
      this._dragRow = null;
      this.dragId = null;
      this.dropAt = -1;
      if (!src || at < 0) return;
      const list = store.snapshot.credentials || [];
      const from = list.findIndex((c) => c.id === src.id);
      if (from < 0 || from === at || from + 1 === at) return;
      const before = list[at];
      try {
        await reorderCredential({ fromId: src.id, beforeId: before ? before.id : null });
      } catch (err) {
        this.$message.error(connectionErrorMessage(err));
      }
    },
    payload() {
      const base = {
        name: this.form.name.trim(),
        kind: this.form.kind,
        user: this.form.user.trim(),
        note: this.form.note,
      };
      return this.form.kind === 'key'
        ? { ...base, privateKey: this.form.privateKey, passphrase: this.form.passphrase }
        : { ...base, pass: this.form.pass };
    },
    save() {
      this.$refs.form.validate(async (valid) => {
        if (!valid) return;
        this.saving = true;
        try {
          if (this.editId) {
            await updateCredential(this.editId, this.payload());
            this.$message.success(t('msg.credentialUpdated'));
          } else {
            await createCredential(this.payload());
            this.$message.success(t('msg.credentialCreated'));
          }
          this.formOpen = false;
        } catch (e) {
          this.$message.error(connectionErrorMessage(e));
        } finally {
          this.saving = false;
        }
      });
    },
    async confirmRemove(row) {
      this.confirmId = null;
      try {
        await deleteCredential(row.id);
        this.$message.success(t('msg.credentialDeleted'));
      } catch (e) {
        this.$message.error(connectionErrorMessage(e));
      }
    },
  },
};
</script>

<style scoped>
.cred-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
.cred-search {
  width: 250px;
}
.el-button.cred-add {
  background: transparent;
  border-color: var(--accent);
  color: var(--accent);
}
.el-button.cred-add:hover,
.el-button.cred-add:focus {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}

/* 列表操作列：纯图标按钮，文案放 tooltip */
.el-button.ibtn {
  width: 26px;
  height: 26px;
  min-width: 26px;
  padding: 0;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  color: var(--text-2);
  font-size: 13px;
}
.el-button.ibtn + .el-button.ibtn {
  margin-left: 0;
}
.el-button.ibtn:hover,
.el-button.ibtn:focus {
  background: var(--bg-hover);
  border-color: var(--accent);
  color: var(--accent);
}
/* 编辑走浅蓝、删除走红，与查看的默认蓝边区分开 */
.el-button.ibtn.is-edit:hover,
.el-button.ibtn.is-edit:focus {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}
.el-button.ibtn.is-del:hover,
.el-button.ibtn.is-del:focus {
  background: rgba(245, 108, 108, 0.15);
  border-color: var(--danger);
  color: var(--danger);
}

.cred-scroll {
  height: min(430px, calc(100vh - 250px));
  min-height: 240px;
}
/* 上下留白给拖拽插入线与卡片 hover 外发光，左右 3px 防止描边被裁 */
.cred-scroll :deep(.el-scrollbar__view) {
  padding: 6px 3px 8px;
}

.cred-grid {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.cred-card {
  position: relative;
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr) 138px auto;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 9px;
  transition: border-color 0.18s, box-shadow 0.18s;
}
.cred-card:hover {
  border-color: var(--accent);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28);
}
html.theme-light .cred-card:hover {
  box-shadow: 0 4px 14px rgba(31, 45, 61, 0.1);
}
.cred-card.is-dragging {
  opacity: 0.42;
}
.cred-card.drop-before::before,
.cred-card.drop-after::after {
  content: '';
  position: absolute;
  left: 8px;
  right: 8px;
  height: 2px;
  border-radius: 2px;
  background: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.cred-card.drop-before::before {
  top: -6px;
}
.cred-card.drop-after::after {
  bottom: -6px;
}

.card-grip {
  display: inline-flex;
  color: var(--text-3);
  cursor: grab;
  font-size: 15px;
}
.card-grip:active {
  cursor: grabbing;
}
.card-grip.is-off {
  cursor: default;
  opacity: 0.35;
}
.kind-ico {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  background: var(--accent-soft);
  color: var(--accent);
}
.kind-ico.is-key {
  background: rgba(103, 194, 58, 0.14);
  color: var(--success);
}
/* 基础外观与 cred-kind-* 配色在全局 main.css（下拉选项 teleport 到 body，只能全局），这里只补卡片内布局 */
.pill {
  white-space: nowrap;
  flex: 0 0 auto;
}

.card-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.card-line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.card-title {
  font-size: 14px;
  font-weight: 600;
  line-height: 1.3;
  color: var(--text);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.card-title:hover {
  color: var(--accent);
}
.card-sub {
  display: flex;
  align-items: center;
  gap: 18px;
  min-width: 0;
  font-size: 12px;
}
.card-user {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--text-2);
  flex: 0 0 auto;
  max-width: 40%;
}
.card-user .el-icon {
  font-size: 13px;
  color: var(--text-3);
}
.card-user span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card-note {
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.card-time {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-3);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.card-time .el-icon {
  font-size: 12px;
}
.card-acts {
  display: flex;
  gap: 6px;
}
@media (max-width: 720px) {
  .cred-card {
    grid-template-columns: auto auto minmax(0, 1fr) auto;
  }
  .card-time {
    display: none;
  }
}

.card-confirm {
  position: absolute;
  z-index: 6;
  top: calc(100% + 6px);
  right: 12px;
  width: max-content;
  max-width: 320px;
  padding: 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.36);
}
.card-confirm.is-up {
  top: auto;
  bottom: calc(100% + 6px);
}
html.theme-light .card-confirm {
  box-shadow: 0 10px 26px rgba(31, 45, 61, 0.16);
}
.card-confirm .confirm-text {
  flex: 1;
  color: var(--text);
  font-size: 12px;
  line-height: 1.4;
}
.card-confirm .confirm-acts {
  display: flex;
  gap: 6px;
}

.cred-empty {
  height: 240px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text-3);
  font-size: 12px;
}
.cred-empty .el-icon {
  font-size: 42px;
}

.cred-pick + .el-textarea {
  margin-top: 8px;
}
.pass-reveal-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 40px;
  height: 100%;
  padding: 0 8px;
  border: none;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
}
.pass-reveal-btn:hover {
  color: var(--accent);
}
</style>
