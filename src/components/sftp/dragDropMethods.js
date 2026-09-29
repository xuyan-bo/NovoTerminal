import { api, unwrap } from '../../store';
import { t } from '../../i18n';
import { joinLocal, joinRemote, isAbsLocalPath } from './utils';

export default {
  /* ========== drag & drop — restore first-working panel+list zones ========== */
  /** Directory a local-side drop lands in; the Windows "This PC" view has no real path. */
  localDropDir() {
    if (isAbsLocalPath(this.localPath)) return this.localPath;
    if (isAbsLocalPath(this.localHome)) return this.localHome;
    return api.platform === 'win32' ? 'C:\\' : '/';
  },
  onDragStart(e, side, f) {
    if (!f || f.isParent) {
      e.preventDefault();
      return false;
    }
    const pathOf = (name, isDir) => ({
      name,
      isDir: !!isDir,
      path: side === 'local' ? joinLocal(this.localPath, name) : joinRemote(this.remotePath, name),
    });
    // Dragging a row that is part of a multi-selection moves the whole selection.
    const sel = side === 'local' ? this.localSel : this.remoteSel;
    const rows = this.itemsOf(side).filter((x) => !x.isParent && sel.indexOf(x.name) >= 0);
    const list = rows.length && rows.some((x) => x.name === f.name)
      ? rows.map((x) => pathOf(x.name, x.isDir))
      : [pathOf(f.name, f.isDir)];
    const payload = { side, list };
    this.dragPayload = payload;
    this._lastDrag = payload;
    try {
      e.dataTransfer.effectAllowed = 'copyMove';
      e.dataTransfer.setData('text/plain', list.map((x) => x.path).join('\n'));
      e.dataTransfer.setData('text/omnidesk-sftp', JSON.stringify(payload));
    } catch (_) {}
    // HTML5 only — in-app drop. Do NOT auto-download to temp on dragstart.
    this.pushDlog(`dragstart ${payload.side} n=${list.length} ${list[0].path}`);
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
    if (el && el.getAttribute('data-isdir') === '1' && el.getAttribute('data-parent') !== '1') {
      this.dropHi = (zoneSide === 'local' ? 'l:' : 'r:') + (el.getAttribute('data-name') || '');
    } else {
      this.dropHi = '';
    }
  },
  onRowOver(e, targetSide, f) {
    this.onZoneDragOver(e, targetSide);
    if (f && f.isDir && !f.isParent && targetSide) {
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
    const payload = this._lastDrag || this.dragPayload;
    const external = this.collectExternalPaths(e);
    this.pushDlog(
      `zone-drop ${zoneSide} p=${payload ? payload.side : 'null'} ext=${external.length} conn=${this.connId || 'null'}`
    );

    // OS files from Explorer / Desktop
    if (external.length) {
      this._lastDrag = null;
      this.dragPayload = null;
      this.handleExternalDrop(external, zoneSide, e);
      return;
    }

    // In-app drag from the other panel: files and folders both land here.
    if (payload && payload.side !== zoneSide && this.connId) {
      const items = payload.list || [];
      this.pushDlog(`zone-drop DIRECT ${payload.side}→${zoneSide} n=${items.length}`);
      this._lastDrag = null;
      this.dragPayload = null;
      this.runTransfers(items, zoneSide).catch((err) => {
        this.pushDlog('zone-drop DIRECT fail ' + (err && err.message));
        this.$message.error(err.message || String(err));
      });
      return;
    }

    this.runDrop(e, zoneSide);
  },
  onRootDragOver() {},
  /** Fallback for panel zones and document drops; keep distinct from direct transfers. */
  async runDrop(e, zoneSide) {
    if (e && e._omniHandled) return;
    if (e) e._omniHandled = true;
    this.dropHi = '';
    const payload = this._lastDrag || this.dragPayload;
    const external = this.collectExternalPaths(e);
    this.pushDlog(
      `runDrop zone=${zoneSide || '-'} payload=${payload ? payload.side + ':n=' + (payload.list || []).length : 'null'} ext=${external.length}`
    );
    if (external.length) {
      this._lastDrag = null;
      this.dragPayload = null;
      await this.handleExternalDrop(external, zoneSide || 'remote', e);
      return;
    }
    if (!payload) {
      this.$message.warning('未识别到拖拽内容，请从列表按住文件拖入');
      return;
    }

    const dest =
      zoneSide === 'remote' ? this.remotePath : zoneSide === 'local' ? this.localDropDir() : null;

    // no zone hint → detect from element under cursor
    let tSide = zoneSide;
    let dropDest = dest;
    if (!tSide) {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const zone =
        el && el.closest
          ? el.closest('.sftp-panel[data-side], .file-list[data-side], .file-row[data-side]')
          : null;
      tSide = zone && zone.getAttribute ? zone.getAttribute('data-side') : null;
      if (!tSide) {
        this.$message.warning('请拖到「本机文件」或「服务器文件」区域');
        return;
      }
      dropDest = tSide === 'remote' ? this.remotePath : this.localDropDir();
      const row = el && el.closest ? el.closest('.file-row') : null;
      if (
        row &&
        row.getAttribute('data-isdir') === '1' &&
        row.getAttribute('data-parent') !== '1'
      ) {
        const name = row.getAttribute('data-name');
        if (name) {
          dropDest =
            tSide === 'remote'
              ? joinRemote(this.remotePath, name)
              : joinLocal(this.localDropDir(), name);
        }
      }
    } else if (!dropDest) {
      dropDest = tSide === 'remote' ? this.remotePath : this.localDropDir();
    }

    // dropped onto a folder row in the zone
    const rowEl = e.target && e.target.closest ? e.target.closest('.file-row') : null;
    if (
      rowEl &&
      rowEl.getAttribute('data-isdir') === '1' &&
      rowEl.getAttribute('data-parent') !== '1'
    ) {
      const name = rowEl.getAttribute('data-name');
      if (name && zoneSide) {
        dropDest =
          tSide === 'remote'
            ? joinRemote(this.remotePath, name)
            : joinLocal(this.localDropDir(), name);
      }
    }

    this.pushDlog(`runDrop dest=${tSide}:${dropDest} conn=${this.connId || 'null'} n=${payload ? (payload.list || []).length : '-'} side=${payload ? payload.side : '-'}`);

    if (!payload) {
      this.pushDlog('runDrop no payload');
      this.$message.warning('未识别到拖拽内容，请从列表按住文件拖入');
      return;
    }
    if (payload.side === tSide) {
      this.pushDlog('runDrop same-side skip');
      return;
    }
    if (!this.connId) {
      this.pushDlog('runDrop no connId, reopen session');
      try {
        const r = unwrap(await api.sftpOpen({ assetId: this.assetId }));
        this.connId = r.connId;
        this.status = 'ready';
        this.pushDlog('runDrop reconnected conn=' + this.connId);
      } catch (err) {
        this.pushDlog('runDrop reconnect fail ' + (err && err.message));
        this.$message.error(err.message || t('sftp.status.idle'));
        return;
      }
    }

    const lockKey = `${payload.side}:${(payload.list || []).map((x) => x.path).join(', ')}>${tSide}:${dropDest}`;
    if (this._dropLock[lockKey]) {
      this.pushDlog('runDrop dup skip');
      return;
    }
    this._dropLock[lockKey] = true;
    setTimeout(() => {
      delete this._dropLock[lockKey];
    }, 1500);

    try {
      const items = payload.list || [];
      this.pushDlog(`runDrop transfer ${payload.side}→${tSide} n=${items.length}`);
      await this.runTransfers(items, tSide, dropDest);
      this.syncTasks();
    } catch (err) {
      this.pushDlog('runDrop fail ' + (err && err.message));
      this.$message.error(err.message || String(err));
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
      console.warn('[sftp] collectExternalPaths', err);
    }
    return out;
  },
  async onRootDrop(e) {
    const el = e.target;
    const inZone = el && el.closest && el.closest('.sftp-panel, .file-list, .file-row');
    if (inZone) return;
    this.runDrop(e, null);
  },

  /** Upload OS files into remote / copy into local folder */
  async handleExternalDrop(external, zoneSide, e) {
    let dest =
      zoneSide === 'remote' ? this.remotePath : this.localDropDir();
    const rowEl = e && e.target && e.target.closest ? e.target.closest('.file-row') : null;
    if (
      rowEl &&
      rowEl.getAttribute('data-isdir') === '1' &&
      rowEl.getAttribute('data-parent') !== '1'
    ) {
      const name = rowEl.getAttribute('data-name');
      if (name) {
        dest =
          zoneSide === 'remote'
            ? joinRemote(this.remotePath, name)
            : joinLocal(this.localPath, name);
      }
    }
    this.pushDlog(`external drop → ${zoneSide}:${dest} n=${external.length}`);
    if (zoneSide === 'remote') {
      if (!this.connId) {
        this.$message.error(t('sftp.status.idle'));
        return;
      }
      let ok = 0;
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
            await this.transferFolderUpload(item.path, dest);
          } else {
            await this.startUpload(item.path, joinRemote(dest, item.name));
          }
          ok += 1;
        } catch (err) {
          this.$message.error(`${item.name}: ${err.message || err}`);
        }
      }
      if (ok) {
        setTimeout(() => this.goRemote(dest), 400);
        this.syncTasks();
      }
      return;
    }
    // drop into local panel: copy local files into current folder
    let ok = 0;
    for (const item of external) {
      try {
        if (api.sftpLocalCopy) {
          unwrap(await api.sftpLocalCopy(item.path, dest));
        } else {
          this.$message.error('本地复制不可用');
        }
        ok += 1;
      } catch (err) {
        this.$message.error(`${item.name}: ${err.message || err}`);
      }
    }
    if (ok) {
      this.$message.success(t('sftp.downloadDone'));
      setTimeout(() => this.goLocal(dest), 400);
    }
  },
};
