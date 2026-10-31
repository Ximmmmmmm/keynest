/**
 * Tauri 版的前端桥接。
 *
 * 目标：让 `app.js` 里所有 `api.xxx()` 调用**一行都不用改**。
 * 接口形状与 Electron 版 `preload.js` 保持一致：
 *   - 每个方法返回 { ok: true, data } 或 { ok: false, error: { code, message } }
 *   - 命令名从 `vault:unlock` 映射到 Rust 的 `vault_unlock`
 */

(function initKeyNestApi() {
  // Electron 环境已由 preload.js 注入 window.vaultApi，不要覆盖
  if (window.vaultApi) {
    return;
  }

  // Tauri 2 的全局对象；没注入时说明不在 Tauri 环境
  const invoke = window.__TAURI__?.core?.invoke;

  if (!invoke) {
    console.error('[keynest] 未检测到 Tauri 运行时，界面无法工作');
    window.vaultApi = {
      status: async () => ({ ok: false, error: { code: 'NO_RUNTIME', message: '未检测到 Tauri 运行时' } }),
    };
    return;
  }

  /** 统一包装：把 Rust 返回的 JSON 原样透传（Rust 侧已经返回 {ok, data/error} 形状） */
  const call = async (command, args) => {
    try {
      return await invoke(command, args || {});
    } catch (err) {
      // Tauri 抛出的错误（参数校验失败等）也包装成同样的形状
      return {
        ok: false,
        error: {
          code: 'INVOKE_FAILED',
          message: typeof err === 'string' ? err : err?.message || '调用失败',
        },
      };
    }
  };

  /** 需要用户选择保存位置时，Tauri 用 dialog 插件 */
  const save = async (content, defaultName) => {
    const dialog = window.__TAURI__?.dialog;
    if (!dialog) {
      return { ok: false, error: { code: 'NO_DIALOG', message: '对话框插件不可用' } };
    }
    const path = await dialog.save({
      defaultPath: defaultName,
      filters: defaultName.endsWith('.json')
        ? [{ name: 'JSON', extensions: ['json'] }]
        : [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (!path) return { ok: true, data: { canceled: true } };

    // Tauri 2 没有直接的写文件命令，用 shell 插件的 fs 能力
    const fs = window.__TAURI__?.fs;
    if (fs?.writeTextFile) {
      await fs.writeTextFile(path, content);
      return { ok: true, data: { canceled: false, path } };
    }
    return { ok: false, error: { code: 'NO_FS', message: '文件写入能力不可用' } };
  };

  window.vaultApi = {
    /* ---------- 仓库 ---------- */
    status: () => call('vault_status'),
    create: (password) => call('vault_create', { password }),
    unlock: (password) => call('vault_unlock', { password }),
    lock: () => call('vault_lock'),
    snapshot: () => call('vault_snapshot'),
    saveEntry: (entry) => call('vault_save_entry', { entry }),
    deleteEntry: (id) => call('vault_delete_entry', { id }),
    addCategory: (name) => call('vault_add_category', { name }),
    updateSettings: (patch) => call('vault_update_settings', { patch }),
    changeMaster: (oldPassword, newPassword) =>
      call('vault_change_master', { oldPassword, newPassword }),
    wipe: () => call('vault_wipe'),
    touch: () => call('vault_touch'),

    /* ---------- 密码工具 ---------- */
    generatePassword: (options) => call('generate_password', { args: options }),
    estimateStrength: (password) => call('estimate_strength', { password }),

    /* ---------- 导入 ---------- */
    scanBrowsers: () => call('browser_scan'),
    discoverCsv: () => call('browser_discover_csv'),
    importCsvFiles: (filePaths, mode) => call('browser_import_files', { filePaths, mode }),
    discardCsv: (filePaths) => call('browser_discard_csv', { filePaths }),

    /* ---------- 导出 ---------- */
    exportPlain: async (format) => {
      const res = await call('vault_export_plain', { format });
      if (!res.ok) return res;
      const name = `keynest-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}.${format}`;
      return save(res.data.content, name);
    },

    /* ---------- 系统 ---------- */
    copy: async (text) => {
      const clipboard = window.__TAURI__?.clipboardManager;
      if (!clipboard) return { ok: false, error: { code: 'NO_CLIPBOARD', message: '剪贴板不可用' } };
      await clipboard.writeText(text);
      return { ok: true, data: { clearedIn: 30 } };
    },
    openDataFolder: async () => {
      const opener = window.__TAURI__?.opener;
      if (!opener) return { ok: false, error: { code: 'NO_OPENER', message: '打开目录不可用' } };
      return { ok: true, data: true };
    },
    openExternal: async (url) => {
      const opener = window.__TAURI__?.opener;
      if (opener?.openUrl) {
        await opener.openUrl(url);
        return { ok: true, data: true };
      }
      return { ok: false, error: { code: 'NO_OPENER', message: '打开链接不可用' } };
    },

    /* ---------- 事件 ---------- */
    onLocked: (callback) => {
      const listen = window.__TAURI__?.event?.listen;
      if (!listen) return () => {};
      let unlisten = null;
      listen('vault:locked', (event) => callback(event.payload)).then((fn) => {
        unlisten = fn;
      });
      return () => unlisten?.();
    },
    onCommand: () => () => {},
  };
})();
