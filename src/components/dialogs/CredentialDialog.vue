<template>
  <el-dialog
    :title="$t('cred.title')"
    :visible.sync="modalVisible"
    width="min(980px, 94vw)"
    top="8vh"
    :close-on-click-modal="false"
  >
    <div class="cred-toolbar">
      <el-input
        v-model="keyword"
        size="small"
        :placeholder="$t('cred.searchPh')"
        clearable
        prefix-icon="el-icon-search"
        style="width: 220px"
      />
      <el-button size="small" type="primary" plain class="cred-add" icon="el-icon-plus" @click="openCreate">
        {{ $t('cred.new') }}
      </el-button>
    </div>
    <div v-loading="revealing" class="cred-table" @dragover="onDragOver" @drop="onDrop">
      <el-table
        :data="rows"
        stripe
        size="small"
        height="min(440px, calc(100vh - 260px))"
        row-key="id"
        :row-class-name="dropRowClass"
      >
        <el-table-column width="40">
          <template slot-scope="{ row }">
            <span
              class="cred-handle"
              :class="{ 'is-off': !!keyword }"
              :draggable="!keyword"
              @dragstart="onDragStart(row, $event)"
              @dragend="onDragEnd"
            >
              <i class="el-icon-rank"></i>
            </span>
          </template>
        </el-table-column>
        <el-table-column :label="$t('cred.name')" prop="name" min-width="140" show-overflow-tooltip />
        <el-table-column :label="$t('cred.kind')" width="92">
          <template slot-scope="{ row }">
            <span class="pill" :class="row.kind === 'key' ? 'cred-kind-key' : 'cred-kind-pass'">
              {{ row.kind === 'key' ? $t('cred.kindKey') : $t('cred.kindPassword') }}
            </span>
          </template>
        </el-table-column>
        <el-table-column :label="$t('cred.user')" min-width="140" show-overflow-tooltip>
          <template slot-scope="{ row }">{{ row.user || '—' }}</template>
        </el-table-column>
        <el-table-column :label="$t('cred.note')" min-width="150" show-overflow-tooltip>
          <template slot-scope="{ row }">{{ row.note || '—' }}</template>
        </el-table-column>
        <el-table-column :label="$t('cred.updated')" width="130">
          <template slot-scope="{ row }">{{ fmtTime(row.updatedAt) }}</template>
        </el-table-column>
        <el-table-column :label="$t('cred.ops')" width="180" align="center" class-name="cred-ops">
          <template slot-scope="{ row }">
            <el-button type="text" size="mini" icon="el-icon-view" @click="openView(row)">
              {{ $t('cred.view') }}
            </el-button>
            <el-button type="text" size="mini" icon="el-icon-edit" @click="openEdit(row)">
              {{ $t('cred.edit') }}
            </el-button>
            <el-popconfirm
              placement="top-end"
              :title="$t('msg.confirmDeleteCredential')"
              :confirm-button-text="$t('msg.confirm')"
              :cancel-button-text="$t('settings.cancel')"
              @confirm="remove(row)"
            >
              <el-button slot="reference" type="text" size="mini" class="cred-del" icon="el-icon-delete">
                {{ $t('cred.del') }}
              </el-button>
            </el-popconfirm>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <template #footer>
      <el-button size="mini" @click="modalVisible = false">{{ $t('settings.close') }}</el-button>
    </template>

    <el-dialog
      :title="formTitle"
      :visible.sync="formOpen"
      width="min(560px, 92vw)"
      top="12vh"
      append-to-body
      :close-on-click-modal="false"
    >
      <el-form
        ref="form"
        :model="form"
        :rules="rules"
        label-width="100px"
        size="small"
        @submit.native.prevent
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
          <!-- 密码框不能禁用：Element 的眼睛在 disabled/readonly 下不渲染（element-ui.common.js 的 showPwdVisible） -->
          <el-input
            v-model="form.pass"
            type="password"
            :placeholder="$t('cred.passPh')"
            maxlength="8192"
            show-password
            autocomplete="off"
          />
        </el-form-item>
        <template v-else>
          <el-form-item :label="$t('cred.privateKey')" prop="privateKey">
            <el-button
              class="cred-pick"
              size="mini"
              icon="el-icon-folder-opened"
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
              maxlength="8192"
              :disabled="readonly"
            />
          </el-form-item>
          <el-form-item :label="$t('cred.passphrase')" prop="passphrase">
            <el-input
              v-model="form.passphrase"
              type="password"
              :placeholder="$t('cred.passphrasePh')"
              maxlength="512"
              show-password
              autocomplete="off"
            />
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
        <el-button size="mini" @click="formOpen = false">
          {{ readonly ? $t('settings.close') : $t('settings.cancel') }}
        </el-button>
        <el-button
          v-if="!readonly"
          size="mini"
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
      dropAt: -1,
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
      this.resetForm();
      this.formMode = 'edit';
      this.formOpen = true;
    },
    openView(row) {
      this.openRow(row, 'view');
    },
    openEdit(row) {
      this.openRow(row, 'edit');
    },
    /** 进表单前先过一次系统身份验证，通过才拿到明文；取消或失败就停在列表。 */
    async openRow(row, formMode) {
      if (this.revealing) return;
      const seq = ++this._revealSeq;
      this.revealing = true;
      try {
        const full = unwrap(await api.revealCredential(row.id));
        // 认证期间可能又点了别的凭据，晚到的结果只让最后一次生效
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
      this.form = blankForm();
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
        if (this.$refs.form) this.$refs.form.validateField('privateKey');
      } catch (e) {
        const code = e.code === 'KEY_TOO_LARGE' ? 'cred.keyTooLarge' : e.code === 'NOT_PRIVATE_KEY' ? 'cred.keyInvalid' : '';
        this.$message.error(code ? t(code) : e.message || t('cred.keyInvalid'));
      }
    },
    onDragStart(row, e) {
      if (this.keyword) return;
      this._dragRow = row;
      if (!e.dataTransfer) return;
      e.dataTransfer.effectAllowed = 'move';
      // Chromium 要求拖拽带上数据，否则 dragstart 之后没有后续事件
      e.dataTransfer.setData('text/plain', row.id);
    },
    onDragEnd() {
      this._dragRow = null;
      this.dropAt = -1;
    },
    /** 落点：行上半＝插到该行前、下半＝插到该行后；行区空白视为末尾追加，表头不算落点。 */
    dropIndex(e) {
      const target = e.target;
      if (!target || !target.closest) return -1;
      if (target.closest('.el-table__header-wrapper')) return -1;
      const tr = target.closest('tbody tr');
      if (!tr) return this.rows.length;
      const i = Array.prototype.indexOf.call(tr.parentNode.children, tr);
      const box = tr.getBoundingClientRect();
      return e.clientY > box.top + box.height / 2 ? i + 1 : i;
    },
    onDragOver(e) {
      if (!this._dragRow) return;
      const i = this.dropIndex(e);
      if (i < 0) return;
      if (i !== this.dropAt) this.dropAt = i;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    },
    async onDrop(e) {
      e.preventDefault();
      const src = this._dragRow;
      const at = this.dropAt;
      this._dragRow = null;
      this.dropAt = -1;
      if (!src || at < 0) return;
      const list = store.snapshot.credentials || [];
      const from = list.findIndex((c) => c.id === src.id);
      if (from < 0 || from === at || from + 1 === at) return;
      const before = list[at];
      try {
        await reorderCredential({ fromId: src.id, beforeId: before ? before.id : null });
      } catch (err) {
        this.$message.error(err.message || String(err));
      }
    },
    /** Element 把 row-class-name 当单个 { row, rowIndex } 参数调用 */
    dropRowClass({ rowIndex }) {
      if (rowIndex === this.dropAt) return 'is-drop-row';
      return this.dropAt === this.rows.length && rowIndex === this.rows.length - 1
        ? 'is-drop-tail'
        : '';
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
          this.$message.error(e.message);
        } finally {
          this.saving = false;
        }
      });
    },
    async remove(row) {
      try {
        await deleteCredential(row.id);
        this.$message.success(t('msg.credentialDeleted'));
      } catch (e) {
        this.$message.error(e.message || String(e));
      }
    },
  },
};
</script>

<style scoped>
.cred-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.cred-del {
  color: var(--danger);
}
.cred-kind-pass {
  border-color: var(--accent);
  color: var(--accent);
}
.cred-kind-key {
  border-color: var(--success);
  color: var(--success);
}
.cred-pick + .el-textarea {
  margin-top: 8px;
}
/* plain 的浅蓝底是 Element 写死的，暗色主题下是一块亮斑，用 token 压住（.el-button 前缀抬权重压过 is-plain） */
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
.cred-table /deep/ td.cred-ops .el-popover__reference-wrapper {
  margin-left: 10px;
}
.cred-table /deep/ td.cred-ops .el-button [class*='el-icon-'] + span {
  margin-left: 2px;
}
.cred-handle {
  display: inline-block;
  color: var(--text-3);
  cursor: grab;
}
.cred-handle:active {
  cursor: grabbing;
}
.cred-handle.is-off {
  cursor: default;
  opacity: 0.35;
}
.cred-table /deep/ .el-table__body tr.is-drop-row > td.el-table__cell {
  box-shadow: inset 0 2px 0 var(--accent);
}
.cred-table /deep/ .el-table__body tr.is-drop-tail > td.el-table__cell {
  box-shadow: inset 0 -2px 0 var(--accent);
}
</style>
