import { api, unwrap, connectionErrorMessage } from '../../store';
import { t } from '../../i18n';
import { joinRemote, localPathOf, isAbsLocalPath } from './utils';

export default {
  /* ========== drag & drop — restore first-working panel+list zones ========== */
  /**
   * Directory a local-side drop lands in. Windows 的「此电脑」视图把 '/' 当虚拟根，那里不能落文件，
   * 落点退回本机主目录；其余情况就是面板当前目录。
   */
  localDropDir() {
    const fallback = api.platform === 'win32' ? 'C:\\' : '/';
    if (this.localComputer) return this.localHome || fallback;
    return this.localPath || this.localHome || fallback;
  },
  /** 落点行的真实路径：只靠 data-name 找到当前列表里的那一行，盘符行才不会拼成 /本地磁盘 (C:)。 */
  rowPath(side, name) {
    const hit = (this.itemsOf(side) || []).find((x) => x.name === name);
    if (!hit) return '';
    return side === 'local' ? localPathOf(this.localPath, hit) : joinRemote(this.remotePath, hit.name);
  },
  /** 落在目录行上就进那个目录，否则落在面板当前目录。 */
  dropRowPath(side, rowEl) {
    if (!rowEl) return '';
    if (rowEl.getAttribute('data-isdir') !== '1' || rowEl.getAttribute('data-parent') === '1') return '';
    const name = rowEl.getAttribute('data-name');
    return name ? this.rowPath(side, name) : '';
  },
  onDragStart(e, side, f) {
    // 盘符行只代表一个驱动器，既不参与拖放也不参与上传
    if (!f || f.isParent || f.isDrive) {
      e.preventDefault();
      return false;
    }
    const pathOf = (x) => ({
      name: x.name,
      isDir: !!x.isDir,
      path: side === 'local' ? localPathOf(this.localPath, x) : joinRemote(this.remotePath, x.name),
    });
    // Dragging a row that is part of a multi-selection moves the whole selection.
    const sel = side === 'local' ? this.localSel : this.remoteSel;
    const rows = this.itemsOf(side).filter((x) => !x.isParent && !x.isDrive && sel.indexOf(x.name) >= 0);
    const list = rows.length && rows.some((x) => x.name === f.name)
      ? rows.map(pathOf)
      : [pathOf(f)];
    const payload = { side, list };
    this.dragPayload = payload;
    this._lastDrag = payload;
    try {
      e.dataTransfer.effectAllowed = 'copyMove';
      e.dataTransfer.setData('text/plain', list.map((x) => x.path).join('\n'));
      e.dataTransfer.setData('text/novoterminal-sftp', JSON.stringify(payload));
    } catch (_) {}
    // HTML5 only — in-app drop. Do NOT auto-download to temp on dragstart.
    return true;
  },
  onDragEnd() {
    this.dropHi = '';
    // keep _lastDrag until drop handled; clear payload late
    setTimeout(() => {
      this.dragPayload = null;
    }, 100);
    setTimeout(() => {
      this._lastDrag = null;
    }, 4000);
  },
  onZoneDragOver(e, zoneSide) {
    e.preventDefault();
    try {
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    } catch (_) {}
    const payload = this._lastDrag || this.dragPayload;
    if (!payload || payload.side === zoneSide) {
      // still allow OS file drops into remote
      if (zoneSide === 'remote' && e.dataTransfer && e.dataTransfer.types) {
        const types = Array.from(e.dataTransfer.types || []);
        if (types.indexOf('Files') >= 0) {
          try {
            e.dataTransfer.dropEffect = 'copy';
          } catch (_) {}
        }
      }
      return;
    }
    const el = e.target && e.target.closest ? e.target.closest('.file-row') : null;
    const overDir = el ? this.dropRowPath(zoneSide, el) : '';
    this.dropHi = overDir ? (zoneSide === 'local' ? 'l:' : 'r:') + (el.getAttribute('data-name') || '') : '';
  },
  onRowOver(e, targetSide, f) {
    this.onZoneDragOver(e, targetSide);
    if (f && f.isDir && !f.isParent && !f.isDrive && targetSide) {
      const payload = this._lastDrag || this.dragPayload;
      if (payload && payload.side !== targetSide) {
        this.dropHi = (targetSide === 'local' ? 'l:' : 'r:') + f.name;
      }
    }
  },
  // Preserve direct panel destinations; runDrop resolves folder rows separately.
  onZoneDrop(e, zoneSide) {
    e.preventDefault();
    e.stopPropagation();
    // 页签排序的拖拽经过面板时不是文件拖放
    if (this._tabDragging) return;
    const s = this.s;
    const payload = this._lastDrag || this.dragPayload;
    const external = this.collectExternalPaths(e);

    // OS files from Explorer / Desktop
    if (external.length) {
      this._lastDrag = null;
      this.dragPayload = null;
      this.handleExternalDrop(s, external, zoneSide, e);
      return;
    }

    // In-app drag from the other panel: files and folders both land here.
    if (payload && payload.side !== zoneSide && s && s.connId) {
      const items = payload.list || [];
      const rowEl = e.target && e.target.closest ? e.target.closest('.file-row') : null;
      this._lastDrag = null;
      this.dragPayload = null;
      // 高亮的是目录行就要落进那个目录，不能只按面板当前目录
      this.runTransfers(s, items, zoneSide, this.dropRowPath(zoneSide, rowEl)).catch((err) => {
        this.$message.error(connectionErrorMessage(err));
      });
      return;
    }

    this.runDrop(e, zoneSide);
  },
  /** Fallback for panel zones and document drops; keep distinct from direct transfers. */
  async runDrop(e, zoneSide) {
    if (this._tabDragging) return;
    if (e && e._novoHandled) return;
    if (e) e._novoHandled = true;
    this.dropHi = '';
    let s = this.s;
    const payload = this._lastDrag || this.dragPayload;
    const external = this.collectExternalPaths(e);
    if (external.length) {
      this._lastDrag = null;
      this.dragPayload = null;
      await this.handleExternalDrop(s, external, zoneSide || 'remote', e);
      return;
    }
    if (!payload) {
      this.$message.warning(t('sftp.dragUnknown'));
      return;
    }
    // A drag can only come from the visible panels, so it always targets the active session.
    if (!s) return;

    // 落点：先看光标下的目录行，其次面板自己的目录
    const el = e.target && e.target.closest ? e.target.closest('.sftp-panel[data-side], .file-list[data-side], .file-row[data-side]') : null;
    const zone = el && el.getAttribute ? el.getAttribute('data-side') : '';
    const side = zoneSide || zone;
    if (side !== 'local' && side !== 'remote') {
      this.$message.warning(t('sftp.dragZone'));
      return;
    }
    const rowEl = e.target && e.target.closest ? e.target.closest('.file-row') : null;
    const dropDest = this.dropRowPath(side, rowEl) || (side === 'remote' ? s.remotePath : this.localDropDir());

    if (payload.side === side) return;

    // 先去重锁再重连：若等重连返回后才上锁，这段窗口期里的第二次 drop 会失效并重复传输
    const lockKey = `${payload.side}:${(payload.list || []).map((x) => x.path).join(', ')}>${side}:${dropDest}`;
    if (this._dropLock[lockKey]) return;
    this._dropLock[lockKey] = true;
    setTimeout(() => {
      delete this._dropLock[lockKey];
    }, 1500);

    if (!s.connId) {
      try {
        const r = unwrap(await api.sftpOpen({ assetId: s.assetId }));
        // 重连返回时页签可能已关闭：新连接必须立刻释放，否则没人再管它
        if (!s.alive) {
          if (r.connId && api.sftpClose) api.sftpClose(r.connId).catch(() => {});
          return;
        }
        s.connId = r.connId;
        s.status = 'ready';
      } catch (err) {
        this.$message.error(connectionErrorMessage(err));
        return;
      }
    }
    // Reopening can outlive the tab it belongs to; re-resolve before touching its state.
    s = this.sessionById(s.id) || s;

    try {
      await this.runTransfers(s, payload.list || [], side, dropDest);
    } catch (err) {
      this.$message.error(connectionErrorMessage(err));
    } finally {
      this._lastDrag = null;
      this.dragPayload = null;
    }
  },
  filePathOf(file) {
    if (!file) return '';
    try {
      if (api.getPathForFile) {
        const p = api.getPathForFile(file);
        if (p) return p;
      }
    } catch (_) {}
    try {
      return file.path || '';
    } catch (_) {
      return '';
    }
  },
  collectExternalPaths(e) {
    const out = [];
    const seen = {};
    const push = (p, name) => {
      if (!p || seen[p]) return;
      seen[p] = 1;
      out.push({
        side: 'external',
        name: name || String(p).split(/[\\/]/).pop(),
        isDir: false,
        path: p,
      });
    };
    try {
      const dt = e.dataTransfer;
      if (!dt) return out;
      if (dt.files && dt.files.length) {
        for (let i = 0; i < dt.files.length; i++) {
          const file = dt.files[i];
          push(this.filePathOf(file), file && file.name);
        }
      }
      if (!out.length && dt.items && dt.items.length) {
        for (let i = 0; i < dt.items.length; i++) {
          const it = dt.items[i];
          if (it && it.kind === 'file') {
            const file = it.getAsFile && it.getAsFile();
            push(this.filePathOf(file), file && file.name);
          }
        }
      }
      // Windows often puts the absolute path into text/plain (first working version).
      // An in-app drag already carries its payload in dataTransfer; its text/plain is that
      // payload's own path, so only treat these candidates as OS files when no drag payload is set.
      if (!out.length && !(this._lastDrag || this.dragPayload)) {
        const txt = dt.getData('text/plain') || '';
        const uri = dt.getData('text/uri-list') || '';
        const candidates = [];
        if (txt) candidates.push(txt);
        if (uri) {
          uri.split(/\r?\n/).forEach((line) => {
            if (line.indexOf('file://') === 0) {
              let p = decodeURIComponent(line.slice(7));
              // Only a Windows drive URL needs separator fixing; POSIX paths keep their slashes.
              if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1).replace(/\//g, '\\');
              candidates.push(p);
            }
          });
        }
        candidates.forEach((raw) => {
          const line = String(raw).trim();
          if (!line || line.charAt(0) === '{') return;
          if (isAbsLocalPath(line)) {
            // may contain multiple paths separated by newline
            line.split(/\r?\n/).forEach((one) => {
              const p = one.trim();
              if (isAbsLocalPath(p)) push(p);
            });
          }
        });
      }
    } catch (err) {
      if (api.logWrite) {
        api
          .logWrite({
            level: 'warn',
            source: 'sftp',
            message: 'collect drop paths failed',
            meta: { message: err.message },
          })
          .catch(() => {});
      }
    }
    return out;
  },

  /** Upload OS files into remote / copy into local folder */
  async handleExternalDrop(s, external, zoneSide, e) {
    if (zoneSide === 'remote' && (!s || !s.connId)) {
      this.$message.error(t('err.SFTP_NO_CONN'));
      return;
    }
    const rowEl = e && e.target && e.target.closest ? e.target.closest('.file-row') : null;
    const rowPath = this.dropRowPath(zoneSide, rowEl);
    const dest =
      rowPath || (zoneSide === 'remote' ? s.remotePath : this.localDropDir());
    if (zoneSide === 'remote') {
      for (const item of external) {
        try {
          let isDir = !!item.isDir;
          if (api.sftpLocalExists) {
            try {
              const st = unwrap(await api.sftpLocalExists(item.path));
              if (st && st.exists) isDir = !!st.isDir;
            } catch (_) {}
          }
          if (isDir) {
            await this.transferFolderUpload(s, item.path, dest);
          } else {
            await this.startUpload(s, item.path, joinRemote(dest, item.name));
          }
        } catch (err) {
          this.$message.error(`${item.name}: ${connectionErrorMessage(err)}`);
        }
      }
      return;
    }
    // drop into local panel: copy local files into current folder
    let ok = 0;
    for (const item of external) {
      try {
        unwrap(await api.sftpLocalCopy(item.path, dest));
        ok += 1;
      } catch (err) {
        this.$message.error(`${item.name}: ${connectionErrorMessage(err)}`);
      }
    }
    if (ok) {
      this.$message.success(t('sftp.localCopyDone'));
      // 复制落在当前目录才原地刷新；落在别处不挪动用户视野
      if (dest === this.localPath) this.goLocal(dest);
    }
  },
};
