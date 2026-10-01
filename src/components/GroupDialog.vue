<template>
  <el-dialog
    :title="isEdit ? $t('group.dialogEdit') : $t('group.dialogNew')"
    :visible.sync="visible"
    width="440px"
    top="5vh"
    :close-on-click-modal="false"
  >
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
          :placeholder="isUngrouped ? $t('group.ungroupedLocked') : $t('group.namePh')"
          maxlength="64"
          clearable
          :disabled="isUngrouped"
          @keyup.enter.native="save"
        />
        <div v-if="isUngrouped" class="hint" style="margin-top:4px">{{ $t('group.ungroupedHint') }}</div>
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
import { store, api, unwrap, refresh } from '../store';
import { t } from '../i18n';
import { UNGROUPED_ID, isUngroupedGroup } from '../constants';

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

export default {
  name: 'GroupDialog',
  data() {
    return {
      saving: false,
      form: {
        name: '',
        color: '#409EFF',
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
    isUngrouped() {
      const id = store.groupDialog.editId;
      if (!id) return false;
      if (id === UNGROUPED_ID || id === 'g-default') return true;
      const g = (store.snapshot.groups || []).find((x) => x.id === id);
      return isUngroupedGroup(g);
    },
  },
  watch: {
    visible(v) {
      if (!v) return;
      this.$nextTick(() => {
        if (this.$refs.form) this.$refs.form.clearValidate();
      });
      if (this.isEdit) {
        const g = (store.snapshot.groups || []).find(
          (x) => x.id === store.groupDialog.editId
        );
        this.form.name = g ? g.name : '';
        this.form.color = normalizeHex(g && g.color);
        if (this.isUngrouped) this.form.name = this.form.name || t('sidebar.untitled');
      } else {
        this.form.name = '';
        this.form.color = '#409EFF';
      }
    },
  },
  methods: {
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
        try {
          const name = this.isUngrouped ? '未分组' : this.form.name.trim();
          const color = normalizeHex(this.form.color);
          if (this.isEdit) {
            unwrap(
              await api.updateGroup(store.groupDialog.editId, { name, color })
            );
            this.$message.success(t('msg.groupUpdated'));
          } else {
            unwrap(await api.createGroup({ name, color }));
            this.$message.success(t('msg.groupCreated'));
          }
          await refresh();
          this.visible = false;
        } catch (e) {
          this.$message.error(e.message);
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
