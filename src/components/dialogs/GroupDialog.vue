<template>
  <el-dialog
    :visible.sync="visible"
    width="440px"
    top="5vh"
    :close-on-click-modal="false"
  >
    <div slot="title" class="dlg-head">
      <i class="dlg-icon" :class="isEdit ? 'el-icon-edit' : 'el-icon-folder-add'"></i>
      <span>{{ isEdit ? $t('group.dialogEdit') : $t('group.dialogNew') }}</span>
    </div>

    <el-form
      ref="form"
      :model="form"
      :rules="rules"
      label-width="80px"
      size="small"
      @submit.native.prevent
    >
      <el-form-item :label="$t('group.name')" prop="name">
        <el-input
          v-model="form.name"
          :placeholder="$t('group.namePh')"
          maxlength="64"
          clearable
          @keyup.enter.native="save"
        />
      </el-form-item>
      <el-form-item :label="$t('group.parent')">
        <el-cascader
          v-model="form.path"
          :options="parentOptions"
          :props="cascaderProps"
          :placeholder="$t('group.parentRoot')"
          clearable
          style="width:100%"
          @change="onParentChange"
        />
      </el-form-item>
      <el-form-item :label="$t('group.color')" prop="color">
        <div class="color-row">
          <el-color-picker
            v-model="form.color"
            :predefine="predefine"
            @change="onColorChange"
          />
          <el-input
            v-model="form.color"
            class="hex-input"
            placeholder="#409EFF"
            maxlength="7"
            @blur="normalizeColor"
          />
          <span class="hint">#RRGGBB</span>
        </div>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button size="mini" @click="visible = false">{{ $t('group.cancel') }}</el-button>
      <el-button size="mini" type="primary" :loading="saving" @click="save">
        {{ isEdit ? $t('group.save') : $t('group.create') }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script>
import { connectionErrorMessage, store, createGroup, updateGroup } from '../../store';
import { t } from '../../i18n';
import { cascaderOptions, folderIdPath, subtreeIds } from '../../lib/assetTree';

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

export default {
  name: 'GroupDialog',
  data() {
    return {
      saving: false,
      form: {
        name: '',
        color: '#409EFF',
        pid: '',
        path: [],
      },
      cascaderProps: {
        checkStrictly: true,
        emitPath: true,
        value: 'value',
        label: 'label',
        children: 'children',
      },
      predefine: [
        '#409EFF',
        '#67C23A',
        '#E6A23C',
        '#A78BFA',
        '#F56C6C',
        '#34D399',
        '#3B82F6',
        '#60A5FA',
        '#14B8A6',
        '#F97316',
        '#EC4899',
        '#8B5CF6',
        '#0EA5E9',
        '#84CC16',
        '#64748B',
        '#0F172A',
      ],
      rules: {
        name: [
          {
            required: true,
            validator(rule, value, cb) {
              if (!String(value || '').trim()) cb(new Error(t('group.nameRequired')));
              else cb();
            },
            trigger: 'blur',
          },
          {
            validator(rule, value, cb) {
              const n = String(value || '').trim().length;
              if (n && (n < 1 || n > 64)) cb(new Error(t('group.len64')));
              else cb();
            },
            trigger: 'blur',
          },
        ],
        color: [
          {
            validator(rule, value, cb) {
              if (!value) cb(new Error(t('group.colorRequired')));
              else if (!HEX_RE.test(String(value).trim()))
                cb(new Error(t('group.colorInvalid')));
              else cb();
            },
            trigger: ['blur', 'change'],
          },
        ],
      },
    };
  },
  computed: {
    visible: {
      get() {
        return store.groupDialog.visible;
      },
      set(v) {
        store.groupDialog = { ...store.groupDialog, visible: v };
        if (!v && this.$refs.form) {
          this.$nextTick(() => this.$refs.form.clearValidate());
        }
      },
    },
    isEdit() {
      return !!store.groupDialog.editId;
    },
    groups() {
      return store.snapshot.groups || [];
    },
    /** 编辑时把自身连同子孙摘掉，否则父级可以选到自己内部形成环 */
    parentOptions() {
      const omit = this.isEdit ? subtreeIds(this.groups, store.groupDialog.editId) : [];
      return cascaderOptions(this.groups, omit);
    },
  },
  watch: {
    visible(v) {
      if (!v) return;
      this.$nextTick(() => {
        if (this.$refs.form) this.$refs.form.clearValidate();
      });
      if (this.isEdit) {
        const g = this.groups.find((x) => x.id === store.groupDialog.editId);
        this.form.name = g ? g.name : '';
        this.form.color = normalizeHex(g && g.color);
        this.form.pid = g ? g.pid || '' : '';
      } else {
        this.form.name = '';
        this.form.color = '#409EFF';
        this.form.pid = store.groupDialog.pid || '';
      }
      this.form.path = this.form.pid ? folderIdPath(this.groups, this.form.pid) : [];
    },
  },
  methods: {
    onParentChange(val) {
      this.form.pid = Array.isArray(val) && val.length ? val[val.length - 1] : '';
      // Element 的选项是 aria-hidden 的 el-radio 原生 input，面板收起时焦点还在它上面，Chrome 会报 a11y 警告
      const focused = document.activeElement;
      if (focused && focused.closest('.el-cascader__dropdown')) focused.blur();
    },
    onColorChange(val) {
      if (val) this.form.color = normalizeHex(val);
    },
    normalizeColor() {
      this.form.color = normalizeHex(this.form.color);
      if (this.$refs.form) {
        this.$refs.form.validateField('color');
      }
    },
    save() {
      this.$refs.form.validate(async (valid) => {
        if (!valid) return;
        this.saving = true;
        const payload = { name: this.form.name.trim(), color: normalizeHex(this.form.color), pid: this.form.pid };
        try {
          if (this.isEdit) {
            await updateGroup(store.groupDialog.editId, payload);
            this.$message.success(t('msg.groupUpdated'));
          } else {
            await createGroup(payload);
            this.$message.success(t('msg.groupCreated'));
          }
          this.visible = false;
        } catch (e) {
          this.$message.error(connectionErrorMessage(e));
        } finally {
          this.saving = false;
        }
      });
    },
  },
};

function normalizeHex(v) {
  if (!v) return '#409EFF';
  let s = String(v).trim();
  if (s.startsWith('rgb')) {
    const m = s.match(/(\d+)\D+(\d+)\D+(\d+)/);
    if (m) {
      const toHex = (n) =>
        Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, '0');
      return (
        '#' + toHex(m[1]) + toHex(m[2]) + toHex(m[3])
      ).toUpperCase();
    }
    return '#409EFF';
  }
  if (s[0] !== '#') s = '#' + s;
  if (/^#[0-9A-Fa-f]{3}$/.test(s)) {
    s =
      '#' +
      s[1] +
      s[1] +
      s[2] +
      s[2] +
      s[3] +
      s[3];
  }
  if (!/^#[0-9A-Fa-f]{6}$/.test(s)) return '#409EFF';
  return s.toUpperCase();
}
</script>

<style scoped>
.color-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.hex-input {
  width: 120px;
}
.hex-input /deep/ .el-input__inner {
  font-family: Consolas, monospace;
  text-transform: uppercase;
}
</style>
