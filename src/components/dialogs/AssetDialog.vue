<template>
  <el-dialog
    :visible.sync="visible"
    width="760px"
    top="5vh"
    :close-on-click-modal="false"
  >
    <div slot="title" class="dlg-head">
      <i class="dlg-icon" :class="dialogIcon"></i>
      <span>{{ dialogTitle }}</span>
    </div>

    <el-divider content-position="left" class="section-divider">{{ $t('asset.info') }}</el-divider>

    <el-form
      ref="form"
      :model="form"
      :rules="rules"
      :disabled="isView"
      label-width="100px"
      size="small"
      style="margin-bottom:8px"
      @submit.native.prevent
    >
      <el-form-item :label="$t('asset.iconLabel')">
        <el-tooltip v-for="ic in icons" :key="ic.id" :content="$t(ic.nameKey)" placement="top">
          <div
            class="icon-cell"
            :class="{ on: form.icon === ic.id, disabled: isView }"
            @click="!isView && (form.icon = ic.id)"
          >
            <i v-if="ic.glyph" class="glyph" :class="ic.glyph" aria-hidden="true"></i>
            <span v-else class="slot" :class="ic.id" v-html="iconSvg(ic.id)"></span>
          </div>
        </el-tooltip>
      </el-form-item>
      <el-form-item :label="$t('asset.name')" prop="name">
        <el-input v-model="form.name" :placeholder="$t('asset.namePh')" maxlength="128" clearable />
      </el-form-item>
      <el-form-item :label="$t('asset.group')" prop="path">
        <el-cascader
          v-model="form.path"
          :options="folderOptions"
          :props="cascaderProps"
          :placeholder="$t('asset.groupPh')"
          :clearable="false"
          style="width:100%"
          @change="onFolderChange"
        />
      </el-form-item>
      <el-form-item :label="$t('asset.host')" prop="host">
        <el-input v-model="form.host" :placeholder="$t('asset.hostPh')" clearable />
      </el-form-item>
      <!-- 红星只按 label 渲染，所以挂在这段有 label 的行上；不用 el-form-item 的 required 属性——这一段没有 prop，Element 会把它当校验规则塞进去 -->
      <el-form-item :label="$t('asset.mainAuth')" class="auth-row" :class="{ 'is-required': form.auth.mode !== 'none' }">
        <el-radio-group v-model="form.auth.mode" class="auth-modes" @change="onMainModeChange">
          <el-radio label="inline">{{ $t('asset.mainInline') }}</el-radio>
          <el-radio label="credential">{{ $t('asset.mainCredential') }}</el-radio>
          <el-radio label="none">{{ $t('asset.mainNone') }}</el-radio>
        </el-radio-group>
      </el-form-item>
      <!-- 用户名与凭证各占一个 form-item：必填提示才会落在自己那一格下面，而不是整组的最末行 -->
      <el-form-item v-if="form.auth.mode === 'inline'" prop="auth.user">
        <el-input v-model="form.auth.user" :placeholder="$t('asset.userPh')" />
      </el-form-item>
      <el-form-item v-if="form.auth.mode === 'inline'" prop="auth.pass">
        <el-input
          v-model="form.auth.pass"
          :type="passVisible ? 'text' : 'password'"
          :placeholder="$t('asset.passPh')"
        >
          <button
            slot="append"
            type="button"
            class="pass-reveal-btn"
            :disabled="authChecking"
            :title="authChecking ? $t('auth.verifying') : (passVisible ? $t('auth.hidePass') : $t('auth.revealPass'))"
            @click="onTogglePassVisible"
          >
            <svg-icon v-if="authChecking" class="spin-icon" name="spinner" :size="14" />
            <svg-icon v-else-if="!passVisible" name="eye-open" :size="20" />
            <svg-icon v-else name="eye-closed" :size="20" />
          </button>
        </el-input>
      </el-form-item>
      <el-form-item v-if="form.auth.mode === 'credential'" prop="auth.credentialId">
        <el-select v-model="form.auth.credentialId" :placeholder="$t('asset.credentialPh')">
          <el-option v-for="c in mainCredentialOptions" :key="c.id" :label="c.name" :value="c.id">
            <span class="opt-name">{{ c.name }}</span>
            <span class="pill" :class="c.kind === 'key' ? 'cred-kind-key' : 'cred-kind-pass'">
              {{ c.kind === 'key' ? $t('cred.kindKey') : $t('cred.kindPassword') }}
            </span>
          </el-option>
        </el-select>
      </el-form-item>
      <el-form-item :label="$t('asset.note')" prop="note">
        <el-input v-model="form.note" type="textarea" :rows="2" />
      </el-form-item>
      <el-divider content-position="left" class="section-divider">{{ $t('asset.methods') }}</el-divider>
      <el-form-item label="" label-width="0" prop="methods" class="methods-item">
        <MethodConfig
          :draft="draft"
          :main-mode="form.auth.mode"
          :testing="testing"
          :testing-id="testingId"
          :disabled="isView"
          @add="addMethod"
          @remove="removeMethod"
          @port-change="onPortChange"
          @advanced="openAdvanced"
          @auth="openAuth"
          @test="testMethod"
        />
      </el-form-item>
    </el-form>

    <template #footer>
      <span style="float:left;color:var(--text-3);font-size:11px;line-height:28px" v-if="!isView">{{ summary }}</span>
      <el-button size="mini" @click="visible = false">
        {{ isView ? $t('settings.close') : $t('settings.cancel') }}
      </el-button>
      <el-button size="mini" type="primary" :loading="saving" @click="save" v-if="!isView">
        {{ $t('asset.save') }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script>
import {
  connectionErrorMessage,
  store,
  api,
  unwrap,
  createAsset,
  updateAsset,
  findAsset,
  openMethodAdvanced,
  openMethodAuth,
} from '../../store';
import { ASSET_ICONS, assetIcon } from '../../constants';
import { getProtocol, protocolLabel } from '../../protocols';
import { cascaderOptions, folderIdPath } from '../../lib/assetTree';
import { t } from '../../i18n';
import MethodConfig from '../common/MethodConfig.vue';

// 主机字段只收主机名、IPv4 与 IPv6，端口一律来自各访问方式的端口框
const HOSTNAME_RE =
  /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
const HEX_GROUP_RE = /^[0-9a-fA-F]{1,4}$/;

// `[fe80::1]` 只是命令行写法，持久化与 socket 都用裸地址，外部 RDP 适配器再补回方括号
function normalizeHost(value) {
  const v = String(value || '').trim();
  return v.startsWith('[') && v.endsWith(']') ? v.slice(1, -1) : v;
}

/** IPv6：完整 8 段，或用 `::` 省略一段（最多一处，被省略的段可以位于任意位置） */
function isIpv6(host) {
  const sides = host.split('::');
  if (sides.length > 2) return false;
  const groups = (side) => (side === '' ? [] : side.split(':'));
  if (sides.length === 1) {
    const all = groups(host);
    return all.length === 8 && all.every((g) => HEX_GROUP_RE.test(g));
  }
  const all = groups(sides[0]).concat(groups(sides[1]));
  return all.length <= 7 && all.every((g) => HEX_GROUP_RE.test(g));
}

function isHost(value) {
  const v = normalizeHost(value);
  return !!v && (HOSTNAME_RE.test(v) || isIpv6(v));
}

/** 端口收进 1–65535 的整数；越界、空值或脏数据一律回落到协议默认端口 */
function normalizePort(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
}

function emptyMainAuth() {
  // 新建默认落在「手动输入」：先把账号口令填上，引用凭证库是后面才需要整理的分支
  return { mode: 'inline', user: '', pass: '', credentialId: '' };
}

export default {
  name: 'AssetDialog',
  components: { MethodConfig },
  data() {
    return {
      saving: false,
      testing: false,
      testingId: null,
      icons: ASSET_ICONS,
      form: {
        name: '',
        icon: 'linux',
        gid: '',
        path: [],
        host: '',
        note: '',
        auth: emptyMainAuth(),
      },
      cascaderProps: {
        checkStrictly: true,
        emitPath: true,
        value: 'value',
        label: 'label',
        children: 'children',
      },
      /** 已添加的访问方式：{ [methodId]: { port, advanced?, auth? } }，键序即展示顺序 */
      draft: {},
      passVisible: false,
      authChecking: false,
      rules: {
        name: [
          {
            required: true,
            validator(rule, value, cb) {
              if (!String(value || '').trim()) cb(new Error(t('msg.nameRequired')));
              else cb();
            },
            trigger: 'blur',
          },
          {
            validator(rule, value, cb) {
              const n = String(value || '').trim().length;
              if (n && n > 128) cb(new Error(t('asset.len128')));
              else cb();
            },
            trigger: 'blur',
          },
        ],
        // 校验级联自身绑定的 path，避免依赖 change 与表单校验的先后顺序
        path: [
          {
            required: true,
            validator(rule, value, cb) {
              if (!Array.isArray(value) || !value.length) cb(new Error(t('msg.groupSelect')));
              else cb();
            },
            trigger: 'change',
          },
        ],
        host: [
          {
            required: true,
            validator(rule, value, cb) {
              const v = String(value || '').trim();
              if (!v) cb(new Error(t('msg.hostRequired')));
              else if (!isHost(v)) cb(new Error(t('msg.hostInvalid')));
              else cb();
            },
            trigger: 'blur',
          },
        ],
        'auth.user': [
          {
            validator: (rule, value, cb) => {
              if (this.form.auth.mode === 'inline' && !String(value || '').trim()) cb(new Error(t('msg.userRequired')));
              else cb();
            },
            trigger: 'blur',
          },
        ],
        'auth.pass': [
          {
            validator: (rule, value, cb) => {
              if (this.form.auth.mode === 'inline' && !String(value || '').trim()) cb(new Error(t('msg.passRequired')));
              else cb();
            },
            trigger: 'blur',
          },
        ],
        'auth.credentialId': [
          {
            validator: (rule, value, cb) => {
              if (this.form.auth.mode === 'credential' && !value) cb(new Error(t('asset.credentialSelect')));
              else cb();
            },
            trigger: 'change',
          },
        ],
        methods: [
          {
            required: true,
            validator: (rule, value, cb) => {
              if (Object.keys(this.draft).length) cb();
              else cb(new Error(t('msg.methodsRequired')));
            },
            trigger: 'change',
          },
        ],
      },
    };
  },
  computed: {
    visible: {
      get() {
        return store.assetDialog.visible;
      },
      set(v) {
        store.assetDialog = {
          ...store.assetDialog,
          visible: v,
          ...(v ? {} : { viewId: null }),
        };
        if (!v && this.$refs.form) {
          this.$nextTick(() => this.$refs.form.clearValidate());
        }
      },
    },
    isEdit() {
      return !!store.assetDialog.editId;
    },
    isClone() {
      return !store.assetDialog.editId && !!store.assetDialog.cloneId;
    },
    isView() {
      return !!store.assetDialog.viewId;
    },
    dialogTitle() {
      if (this.isView) return this.$t('asset.dialogView');
      if (this.isEdit) return this.$t('asset.dialogEdit');
      return this.isClone ? this.$t('asset.dialogClone') : this.$t('asset.dialogNew');
    },
    dialogIcon() {
      if (this.isView) return 'el-icon-view';
      if (this.isEdit) return 'el-icon-edit';
      return this.isClone ? 'el-icon-document-copy' : 'el-icon-plus';
    },
    groups() {
      return store.snapshot.groups || [];
    },
    folderOptions() {
      return cascaderOptions(this.groups);
    },
    credentials() {
      return store.snapshot.credentials || [];
    },
    /** 主凭证只能选当前已配方式吃得下的类型；已选中的那条始终留在列表里，否则下拉会显示成裸 id */
    mainCredentialOptions() {
      const ids = Object.keys(this.draft);
      if (!ids.length) return this.credentials;
      const kinds = new Set();
      ids.forEach((id) => {
        const protocol = getProtocol(id);
        (protocol && protocol.authKinds ? protocol.authKinds : []).forEach((kind) => kinds.add(kind));
      });
      return this.credentials.filter(
        (c) => kinds.has(c.kind) || c.id === this.form.auth.credentialId
      );
    },
    /** 主凭证的真实类型：引用凭证时取库里的 kind，手填口令恒为 password */
    mainKind() {
      if (this.form.auth.mode !== 'credential') {
        return this.form.auth.mode === 'inline' ? 'password' : '';
      }
      const hit = this.credentials.find((c) => c.id === this.form.auth.credentialId);
      return hit ? hit.kind : '';
    },
    summary() {
      const on = Object.keys(this.draft).map((id) => `${protocolLabel(id)}:${this.draft[id].port}`);
      return `${this.iconName(this.form.icon)} · ${this.form.host || '?'} · ${
        on.join(' | ') || t('asset.notEnabled')
      }`;
    },
    methodAdvancedResult() {
      return store.methodAdvancedResult;
    },
    methodAuthResult() {
      return store.methodAuthResult;
    },
  },
  watch: {
    visible(v) {
      if (v) this.load();
      else this.passVisible = false;
    },
    methodAdvancedResult(r) {
      if (!r || !this.visible) return;
      const row = this.draft[r.methodId];
      if (row) {
        this.$set(row, 'advanced', r.advanced);
        this.draft = { ...this.draft };
      }
    },
    methodAuthResult(r) {
      if (!r || !this.visible) return;
      const row = this.draft[r.methodId];
      if (row) {
        this.$set(row, 'auth', r.auth);
        this.draft = { ...this.draft };
      }
    },
  },
  methods: {
    iconName(id) {
      const hit = this.icons.find((ic) => ic.id === id);
      return hit ? t(hit.nameKey) : '';
    },
    iconSvg(id) {
      return assetIcon(id);
    },
    onMainModeChange(mode) {
      // 三选一互斥：换模式即清掉另一模式的字段，不留填了却不生效的输入框
      if (mode !== 'inline') {
        this.form.auth.user = '';
        this.form.auth.pass = '';
      }
      if (mode !== 'credential') this.form.auth.credentialId = '';
      this.passVisible = false;
    },
    addMethod(id) {
      const protocol = getProtocol(id);
      if (!protocol || this.draft[id]) return;
      this.$set(this.draft, id, { port: protocol.defaultPort });
      this.draft = { ...this.draft };
      this.validateMethods();
    },
    removeMethod(row) {
      const draft = { ...this.draft };
      delete draft[row.id];
      this.draft = draft;
      this.validateMethods();
    },
    onPortChange(row, port) {
      // MethodConfig 给的是行包装对象，端口必须写回 draft 里那一行，否则改了不生效
      const conf = this.draft[row.id];
      if (!conf) return;
      // 清空数字框时 Element 给出 undefined，回落到协议默认端口
      this.$set(conf, 'port', normalizePort(port, row.meta.defaultPort));
    },
    openAdvanced(row) {
      openMethodAdvanced({
        methodId: row.id,
        methodName: t(row.meta.nameKey),
        advanced: row.conf.advanced || {},
        context: { type: 'asset-dialog', isView: this.isView },
      });
    },
    openAuth(row) {
      openMethodAuth({
        methodId: row.id,
        methodName: t(row.meta.nameKey),
        auth: row.conf.auth || null,
        main: { mode: this.form.auth.mode, kind: this.mainKind },
        authKinds: row.meta.authKinds || ['password'],
        context: { type: 'asset-dialog', isView: this.isView },
      });
    },
    validateMethods() {
      if (!this.$refs.form) return;
      this.$refs.form.validateField('methods');
    },
    /** Chrome-style: system identity check before revealing saved password */
    async onTogglePassVisible() {
      if (this.authChecking) return;
      if (this.passVisible) {
        this.passVisible = false;
        return;
      }
      // 新增时口令就是刚敲进去的，不必走系统认证；读回来的已存口令才需要
      if (!this.isEdit && !this.isClone && !this.isView) {
        this.passVisible = true;
        return;
      }
      if (!api.verifySystemAuth) {
        this.$message.error(t('auth.needElectron'));
        return;
      }
      this.authChecking = true;
      try {
        const r = unwrap(await api.verifySystemAuth(t('auth.viewPassReason')));
        if (r && r.ok) {
          this.passVisible = true;
        } else {
          this.$message.error(this.authMessage(r));
        }
      } catch (e) {
        this.$message.error(this.authMessage(e));
      } finally {
        this.authChecking = false;
      }
    },
    authMessage(r) {
      const code = (r && r.code) || '';
      if (/Canceled|UserCanceled/i.test(code)) return t('auth.canceled');
      if (/NotConfigured/i.test(code)) return t('auth.notConfigured');
      return (r && r.message) || t('auth.failed');
    },
    onFolderChange(val) {
      this.form.gid = Array.isArray(val) && val.length ? val[val.length - 1] : '';
      // Element 的选项是 aria-hidden 的 el-radio 原生 input，面板收起时焦点还在它上面，Chrome 会报 a11y 警告
      const focused = document.activeElement;
      if (focused && focused.closest('.el-cascader__dropdown')) focused.blur();
    },
    async load() {
      this.passVisible = false;
      const editId = store.assetDialog.editId;
      const cloneId = store.assetDialog.cloneId;
      const viewId = store.assetDialog.viewId;
      const fallbackGid = store.assetDialog.gid || '';
      const hit = (editId || cloneId || viewId) ? findAsset(editId || cloneId || viewId) : null;
      if (hit) {
        const a = hit.asset;
        const auth = a.auth || { mode: 'none' };
        this.form = {
          name: cloneId && !editId ? `${a.name} ${t('asset.cloneSuffix')}` : a.name,
          icon: a.icon || 'generic',
          gid: hit.group.id,
          path: folderIdPath(this.groups, hit.group.id),
          host: a.host,
          note: a.note || '',
          // auth 必须跟着这次整体赋值一起进 form：后挂上去的属性在 Vue 2 里不是响应式的，单选点了不会重绘
          auth: {
            mode: auth.mode || 'none',
            user: auth.user || '',
            pass: auth.pass || '',
            credentialId: auth.credentialId || '',
          },
        };
        this.draft = JSON.parse(JSON.stringify(a.methods || {}));
        // 手改或旧库的端口可能是 0/越界值，进表单先归一回协议默认端口
        Object.keys(this.draft).forEach((id) => {
          const protocol = getProtocol(id);
          const row = this.draft[id];
          if (protocol && row) this.$set(row, 'port', normalizePort(row.port, protocol.defaultPort));
        });
      } else {
        // 源资产已不在快照里时按新增表单打开，不留下一次编辑的残留内容
        this.form = {
          name: '',
          icon: 'linux',
          gid: fallbackGid,
          path: fallbackGid ? folderIdPath(this.groups, fallbackGid) : [],
          host: '',
          note: '',
          auth: emptyMainAuth(),
        };
        this.draft = {};
      }
      this.$nextTick(() => {
        if (this.$refs.form) this.$refs.form.clearValidate();
      });
    },
    /** 探测按草稿形状解析凭证：资产可能还没落库，引用的凭证却要按库里的真实内容试 */
    draftForProbe(methodId) {
      const row = this.draft[methodId];
      return {
        auth: { ...this.form.auth },
        methods: { [methodId]: { auth: (row && row.auth) || null } },
      };
    },
    async testMethod(row) {
      if (this.testing) return;
      // 只校验真正渲染出来的字段：el-form-item 在 v-if 下不注册，validateField 对未注册的 prop
      // 只打一句 warning 就返回，回调永远不触发，等待它的 Promise 会把整个探测挂死
      const props = ['name', 'host'];
      if (this.form.auth.mode === 'inline') props.push('auth.user', 'auth.pass');
      else if (this.form.auth.mode === 'credential') props.push('auth.credentialId');
      let failed = 0;
      let done = 0;
      const valid = await new Promise((resolve) => {
        props.forEach((prop) => {
          this.$refs.form.validateField(prop, (err) => {
            if (err) failed += 1;
            done += 1;
            if (done === props.length) resolve(!failed);
          });
        });
      });
      if (!valid) return;
      this.testing = true;
      this.testingId = row.id;
      const method = { protocol: row.id, port: row.conf.port, advanced: row.conf.advanced || {} };
      if (row.id === 'sftp') {
        // SFTP 会话沿用同资产 SSH 行的跳板机与主机密钥策略，探测也要按同一条合并配置发起；
        // 资产没配 SSH 行时不合并，否则探测结论和真实连接不一致
        const sshRow = this.draft.ssh;
        if (sshRow) {
          method.advanced = { ...(sshRow.advanced || {}), ...(row.conf.advanced || {}) };
          method.port = row.conf.port || sshRow.port || 22;
        }
      }
      try {
        const r = unwrap(
          await api.sessionTest({
            asset: { host: normalizeHost(this.form.host) },
            method,
            draft: this.draftForProbe(row.id),
          })
        );
        if (r && r.ok) {
          const parts = [`${t(row.meta.nameKey)} · ${r.latencyMs ?? '-'} ms`];
          if (r.nla) parts.push(t('asset.testNla'));
          if (r.note) parts.push(r.note);
          this.$message.success(parts.join(' · '));
        } else {
          this.$message.error(this.testFailureMessage(r));
        }
      } catch (e) {
        this.$message.error(connectionErrorMessage(e));
      } finally {
        this.testing = false;
        this.testingId = null;
      }
    },
    testFailureMessage(r) {
      const code = (r && r.code) || '';
      const map = {
        NO_HOST: t('asset.testNoHost'),
        NO_CREDENTIAL: t('asset.testNoCredential'),
        TCP_TIMEOUT: t('asset.testTcpFail'),
        TCP_ERROR: t('asset.testTcpFail'),
        AUTH_FAILED: t('asset.testAuthFail'),
        HOSTKEY_REJECTED: t('asset.testHostkey'),
        SSH_KEY_PARSE: t('asset.testKeyParse'),
        VNC_NO_AUTH: t('asset.testVncNoAuth'),
        VNC_REJECTED: t('asset.testVncRejected'),
        RDP_BAD_RESPONSE: t('asset.testRdpBad'),
        SFTP_UNAVAILABLE: t('asset.testSftpUnavailable'),
      };
      const detail = r && (r.error || r.__error);
      const base = map[code];
      if (base) return detail ? base + ' — ' + detail : base;
      // 网络层错误码（ENOTFOUND 等）按 err.<CODE> 取译文，英文原文只进日志
      const coded = code ? t('err.' + code) : '';
      return coded !== 'err.' + code ? coded : (detail || t('asset.testFail'));
    },
    save() {
      if (this.isView) return;
      this.$refs.form.validate(async (valid) => {
        if (!valid) return;
        this.saving = true;
        try {
          const methods = {};
          Object.keys(this.draft).forEach((id) => {
            const row = this.draft[id];
            const draftAdv = row.advanced;
            methods[id] = {
              port: row.port,
              advanced: draftAdv && Object.keys(draftAdv).length ? { ...draftAdv } : undefined,
              auth: row.auth ? { ...row.auth } : undefined,
            };
          });
          const payload = {
            name: this.form.name.trim(),
            icon: this.form.icon,
            host: normalizeHost(this.form.host),
            auth: { ...this.form.auth },
            note: this.form.note,
            methods,
            gid: this.form.gid,
          };
          if (this.isEdit) {
            await updateAsset(store.assetDialog.editId, payload);
            this.$message.success(t('msg.assetUpdated'));
          } else {
            await createAsset(payload.gid, payload);
            this.$message.success(t('msg.assetCreated'));
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
</script>

<style scoped>
/* Element 把分隔线与标题底写成死浅色（#DCDFE6 / #FFF），深色主题下会是一块白底，全部换回主题变量 */
.section-divider {
  margin: 4px 0 16px;
  background-color: var(--border);
}
.section-divider /deep/ .el-divider__text {
  background: var(--bg-panel);
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
}
/* 图标格正方形、不带文字，名称走悬停 tooltip；tooltip 不额外包一层元素，格子仍是表单内容的直接子节点 */
.icon-cell {
  width: 38px;
  height: 38px;
  display: inline-grid;
  place-items: center;
  vertical-align: top;
  margin-right: 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-panel);
  cursor: pointer;
}
.icon-cell .slot {
  line-height: 0;
  display: grid;
  place-items: center;
}
.icon-cell .slot /deep/ svg {
  width: 20px;
  height: 20px;
  display: block;
}
.icon-cell .slot.win {
  color: var(--win);
}
.icon-cell .slot.mac {
  color: var(--mac);
}
.icon-cell .slot.linux {
  /* Tux 自带配色，不让 CSS 覆盖路径颜色 */
  color: inherit;
}
.icon-cell .glyph {
  font-size: 20px;
  line-height: 20px;
  color: var(--text-2);
}
.icon-cell:hover:not(.disabled) {
  background: var(--bg-hover);
}
.icon-cell.on {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.icon-cell.on .nm {
  color: var(--text);
}
.icon-cell.disabled {
  cursor: default;
  opacity: 0.5;
}
.auth-modes {
  display: block;
  line-height: 32px;
}
/* 单选这行自己没有报错位，收紧到 6px；下面几格保留 Element 默认 22px，那正是必填提示那一行的位置 */
.auth-row {
  margin-bottom: 6px;
}
.opt-name {
  margin-right: 8px;
}
.methods-item {
  width: 100%;
}
.methods-item /deep/ .el-form-item__label {
  float: none;
  display: none;
  width: 0;
  padding: 0;
  margin: 0;
}
.methods-item /deep/ .el-form-item__content {
  margin-left: 0 !important;
  line-height: normal;
}
.methods-item /deep/ .el-form-item__error {
  position: static;
  margin-top: 6px;
  padding-top: 0;
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
  color: var(--text-2, #9aa7b8);
  cursor: pointer;
}
.pass-reveal-btn:hover:not(:disabled) {
  color: var(--accent, #409eff);
}
.pass-reveal-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
