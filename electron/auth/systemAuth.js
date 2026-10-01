/**
 * OmniDesk system-level identity verification.
 *
 * Windows implementation uses a small PowerShell (.NET) helper to:
 *   1. Show the native credential dialog (CredUIPromptForWindowsCredentialsW),
 *      parented to the main window so it merges into the app's taskbar button
 *      (app icon) and stays on top — no orphaned "ghost" barrier.
 *   2. Validate the submitted password in-process via LogonUserW (fast,
 *      millisecond-level) and report the exact Win32 error so we can tell
 *      "wrong password" (1326 / ERROR_LOGON_FAILURE) apart from "account does
 *      not exist" (1325 / ERROR_NO_SUCH_USER).
 *
 * No koffi / native FFI dependency is required; it relies on built-in .NET.
 */

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

/** Chrome-style: cache a successful auth for 30 s to avoid re-prompting */
const AUTH_CACHE_MS = 30 * 1000;
let lastVerifiedAt = 0;
let authGeneration = 0;
let macAuthProcess = null;

function resultMessage(code, lang) {
  const map = {
    Verified: ['验证通过', 'Identity verified'],
    Canceled: ['已取消验证', 'Identity verification canceled'],
    UserCanceled: ['已取消验证', 'Identity verification canceled'],
    BadCredentials: ['用户名或密码不正确', 'Wrong username or password'],
    AccountNotFound: ['账号不存在', 'Account does not exist'],
    DeviceNotPresent: ['未检测到可用的身份验证设备', 'No usable verification device found'],
    NotConfiguredForUser: ['系统未配置身份验证（请先在 Windows 设置中启用 Hello / PIN）', 'System verification is not set up (enable Windows Hello / PIN first)'],
    DisabledByPolicy: ['系统策略禁用了身份验证', 'Verification disabled by system policy'],
    DeviceBusy: ['身份验证设备忙，请稍后再试', 'Verification device busy, try again later'],
    RetriesExhausted: ['验证次数过多', 'Too many verification attempts'],
    UnsupportedPlatform: ['当前系统暂不支持系统级身份验证', 'System-level verification is not supported on this platform'],
    Failed: ['系统身份验证失败', 'System identity verification failed'],
  };
  const pair = map[code] || map.Failed;
  return pair[lang === 'en' ? 1 : 0];
}

function defaultReason(lang) {
  return lang === 'en' ? 'OmniDesk needs to verify your identity' : 'OmniDesk 需要验证您的身份';
}

// ---------------------------------------------------------------------------
// Windows Hello (biometric / PIN / face) via UserConsentVerifier
// ---------------------------------------------------------------------------

function encodePs(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function buildHelloScript(reason, lang) {
  const msg = String(reason || defaultReason(lang)).replace(/'/g, "''");
  return [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$ErrorActionPreference = 'Stop'",
    "[Windows.Security.Credentials.UI.UserConsentVerifier,Windows.Security.Credentials.UI,ContentType=WindowsRuntime] | Out-Null",
    "[Windows.Security.Credentials.UI.UserConsentVerificationResult,Windows.Security.Credentials.UI,ContentType=WindowsRuntime] | Out-Null",
    "Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null",
    "$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {",
    "  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'",
    "})[0]",
    "function AwaitWinRt($op, $resultType) {",
    "  $generic = $asTask.MakeGenericMethod($resultType)",
    "  $task = $generic.Invoke($null, @($op))",
    "  $null = $task.Wait(180000)",
    "  return $task.Result",
    "}",
    "$result = AwaitWinRt `",
    "    ([Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync('" + msg + "')) `",
    "    ([Windows.Security.Credentials.UI.UserConsentVerificationResult])",
    "Write-Output $result.ToString()",
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Native credential dialog + fast password validation (PowerShell/.NET)
// ---------------------------------------------------------------------------

/**
 * Build the password dialog script. Uses a single-quoted here-string (@' ... '@)
 * for the C# interop so PowerShell does not expand `$`/backslashes inside it.
 */
function buildPasswordScript() {
  return [
    'param([int64]$hwnd, [string]$reason)',
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$ErrorActionPreference = 'Stop'",
    '',
    '$cs = @"',
    'using System;',
    'using System.Text;',
    'using System.Runtime.InteropServices;',
    '',
    'public static class AuthHelper {',
    '    const int LOGON32_LOGON_NETWORK = 3;',
    '    const int LOGON32_PROVIDER_DEFAULT = 0;',
    '    const uint ERROR_CANCELLED = 1223;',
    '    const uint ERROR_LOGON_FAILURE = 1326;',
    '    const uint ERROR_NO_SUCH_USER = 1325;',
    '    const uint CREDUIWIN_ENUMERATE_CURRENT_USER = 0x200;',
    '',
    '    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',
    '    public struct CREDUI_INFOW {',
    '        public int cbSize;',
    '        public IntPtr hwndParent;',
    '        [MarshalAs(UnmanagedType.LPWStr)] public string pszMessageText;',
    '        [MarshalAs(UnmanagedType.LPWStr)] public string pszCaptionText;',
    '        public IntPtr hbmBanner;',
    '    }',
    '',
    '    [DllImport("credui.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
    '    public static extern uint CredUIPromptForWindowsCredentialsW(',
    '        ref CREDUI_INFOW pUiInfo, int dwAuthError, ref uint pulAuthPackage,',
    '        IntPtr pvInAuthBuffer, uint ulInAuthBufferSize,',
    '        out IntPtr ppvOutAuthBuffer, out uint pulOutAuthBufferSize,',
    '        ref bool pfSave, uint dwFlags);',
    '',
    '    [DllImport("credui.dll", CharSet = CharSet.Unicode)]',
    '    public static extern bool CredUnPackAuthenticationBufferW(',
    '        int dwFlags, IntPtr pAuthBuffer, uint cbAuthBuffer,',
    '        StringBuilder pszUserName, ref uint pcchMaxUserName,',
    '        StringBuilder pszDomainName, ref uint pcchMaxDomainName,',
    '        StringBuilder pszPassword, ref uint pcchMaxPassword);',
    '',
    '    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
    '    public static extern bool LogonUserW(',
    '        string username, string domain, string password,',
    '        int logonType, int logonProvider, out IntPtr phToken);',
    '',
    '    [DllImport("kernel32.dll")]',
    '    public static extern bool CloseHandle(IntPtr hObject);',
    '',
    '    [DllImport("kernel32.dll")]',
    '    public static extern int GetLastError();',
    '',
    '    [DllImport("ole32.dll")]',
    '    public static extern void CoTaskMemFree(IntPtr pv);',
    '',
    '    // Fast local validation; returns 0 on success, else the Win32 error.',
    '    static int Validate(string fullUser, string password) {',
    '        string[] parts = fullUser.Split(\'\\\\\');',
    '        string domain = parts.Length > 1 ? parts[0] : (string)null;',
    '        string user = parts[parts.Length - 1];',
    '        IntPtr token;',
    '        if (LogonUserW(user, domain, password, LOGON32_LOGON_NETWORK,',
    '                       LOGON32_PROVIDER_DEFAULT, out token)) {',
    '            if (token != IntPtr.Zero) CloseHandle(token);',
    '            return 0;',
    '        }',
    '        return GetLastError();',
    '    }',
    '',
    '    // Returns: "Verified" / "Canceled" / "Error:<code>"',
    '    public static string Prompt(long hwnd, string message, string caption) {',
    '        var info = new CREDUI_INFOW();',
    '        info.cbSize = Marshal.SizeOf(info);',
    '        info.hwndParent = hwnd > 0 ? new IntPtr(hwnd) : IntPtr.Zero;',
    '        info.pszMessageText = string.IsNullOrEmpty(message) ? "" : message;',
    '        info.pszCaptionText = string.IsNullOrEmpty(caption) ? "OmniDesk" : caption;',
    '        info.hbmBanner = IntPtr.Zero;',
    '',
    '        uint authPackage = 0;',
    '        bool save = false;',
    '        int lastError = 0;',
    '',
    '        for (int attempt = 0; attempt < 5; attempt++) {',
    '            IntPtr outBuf = IntPtr.Zero;',
    '            uint outSize = 0;',
    '            uint result = CredUIPromptForWindowsCredentialsW(',
    '                ref info, lastError, ref authPackage,',
    '                IntPtr.Zero, 0,',
    '                out outBuf, out outSize,',
    '                ref save, CREDUIWIN_ENUMERATE_CURRENT_USER);',
    '',
    '            if (result == ERROR_CANCELLED) {',
    '                if (outBuf != IntPtr.Zero) CoTaskMemFree(outBuf);',
    '                return "Canceled";',
    '            }',
    '            if (result != 0) {',
    '                if (outBuf != IntPtr.Zero) CoTaskMemFree(outBuf);',
    '                return "Failed";',
    '            }',
    '',
    '            var u = new StringBuilder(256);',
    '            var d = new StringBuilder(256);',
    '            var p = new StringBuilder(256);',
    '            uint uLen = 256, dLen = 256, pLen = 256;',
    '',
    '            if (!CredUnPackAuthenticationBufferW(0, outBuf, outSize,',
    '                    u, ref uLen, d, ref dLen, p, ref pLen)) {',
    '                CoTaskMemFree(outBuf);',
    '                return "Failed";',
    '            }',
    '            CoTaskMemFree(outBuf);',
    '',
    '            string username = u.ToString();',
    '            string password = p.ToString();',
    '            string domainStr = d.ToString();',
    '            string fullUser = string.IsNullOrEmpty(domainStr)',
    '                ? username : domainStr + "\\\\" + username;',
    '',
    '            if (string.IsNullOrEmpty(username) || string.IsNullOrEmpty(password)) {',
    '                lastError = 0;',
    '                continue;',
    '            }',
    '',
    '            int code = Validate(fullUser, password);',
    '            if (code == 0) return "Verified";',
    '            lastError = code;',
    '        }',
    '',
    '        if (lastError == ERROR_LOGON_FAILURE) return "Error:1326";',
    '        if (lastError == ERROR_NO_SUCH_USER) return "Error:1325";',
    '        return "Error:" + lastError;',
    '    }',
    '}',
    '"@',
    '',
    'Add-Type -TypeDefinition $cs -Language CSharp',
    '',
    '$res = [AuthHelper]::Prompt($hwnd, $reason, "OmniDesk")',
    'Write-Output $res',
  ].join('\r\n');
}

/** Run a PowerShell script via -EncodedCommand (for Hello / WinRT). */
function runPs(script, options) {
  const { timeout } = options || {};
  return new Promise((resolve) => {
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass'];
    args.push('-STA');
    args.push('-EncodedCommand', encodePs(script));
    execFile(
      'powershell.exe', args,
      { timeout: timeout || 190000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = String(stdout || '').trim();
        const lines = out.split(/\r?\n/).filter(Boolean);
        resolve({ out: lines[lines.length - 1] || '', err, debug: String(stderr || '').trim() });
      }
    );
  });
}

/** Run a .ps1 file with arguments (for the credential dialog). */
function runPsFile(psContent, psArgs, options) {
  const { timeout } = options || {};
  return new Promise((resolve) => {
    const tmpFile = path.join(os.tmpdir(), `omnidesk_auth_${Date.now()}.ps1`);
    fs.writeFileSync(tmpFile, psContent, 'utf-8');
    const args = ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', tmpFile];
    if (psArgs) psArgs.forEach((a) => args.push(a));
    execFile(
      'powershell.exe', args,
      { timeout: timeout || 130000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        try { fs.unlinkSync(tmpFile); } catch (_) {}
        const out = String(stdout || '').trim();
        const lines = out.split(/\r?\n/).filter(Boolean);
        resolve({ out: lines[lines.length - 1] || '', err, debug: String(stderr || '').trim() });
      }
    );
  });
}

async function verifyWindowsAuth(reason, hwnd, lang) {
  // Step 1 — Windows Hello (face / fingerprint / PIN).
  const hello = await runPs(buildHelloScript(reason, lang), { timeout: 190000 }).catch(() => null);
  const helloCode = hello && hello.out ? hello.out : '';
  if (helloCode === 'Verified') {
    return { ok: true, code: 'Verified', method: 'hello', message: resultMessage('Verified', lang) };
  }
  if (['Canceled', 'UserCanceled', 'DisabledByPolicy', 'RetriesExhausted', 'DeviceBusy'].includes(helloCode)) {
    return { ok: false, code: helloCode, method: 'hello', message: resultMessage(helloCode, lang) };
  }

  // Step 2 — native password dialog. Parent to the main window (app icon,
  // stays on top, no orphaned taskbar entry).
  const pwScript = buildPasswordScript();
  const h = hwnd && hwnd > 0 ? String(hwnd) : '0';
  const pw = await runPsFile(pwScript, [h, reason || defaultReason(lang)], { timeout: 130000 });

  if (pw.debug) console.error('[auth] pw:', pw.debug);
  const out = pw.out || 'Failed';

  if (out === 'Verified') {
    return { ok: true, code: 'Verified', method: 'password', message: resultMessage('Verified', lang) };
  }
  if (out === 'Canceled') {
    return { ok: false, code: 'Canceled', method: 'password', message: resultMessage('Canceled', lang) };
  }
  if (out === 'Error:1326') {
    return { ok: false, code: 'BadCredentials', method: 'password', message: resultMessage('BadCredentials', lang) };
  }
  if (out === 'Error:1325') {
    return { ok: false, code: 'AccountNotFound', method: 'password', message: resultMessage('AccountNotFound', lang) };
  }
  if (out.startsWith('Error:')) {
    const code = out.slice(6);
    return {
      ok: false,
      code: 'Failed',
      method: 'password',
      message: lang === 'en' ? `Identity verification failed (error code ${code})` : `身份验证失败（错误码 ${code}）`,
    };
  }
  return { ok: false, code: 'Failed', method: 'password', message: resultMessage('Failed', lang) };
}

function macAuthResult(code, lang) {
  const messages = {
    Verified: ['验证通过', 'Identity verified'],
    Canceled: ['已取消验证', 'Identity verification canceled'],
    BadCredentials: ['系统身份验证未通过', 'System authentication failed'],
    Unavailable: ['macOS 系统身份验证不可用，请检查登录密码和系统设置', 'macOS authentication is unavailable. Check your login password and system settings'],
    RetriesExhausted: ['验证次数过多，请稍后重试', 'Too many authentication attempts. Try again later'],
    DeviceBusy: ['系统身份验证正在进行，请稍后重试', 'System authentication is already in progress'],
    HelperMissing: ['macOS 身份验证组件缺失，请重新构建或安装应用', 'The macOS authentication helper is missing. Rebuild or reinstall the app'],
    TimedOut: ['系统身份验证超时，请重试', 'System authentication timed out. Try again'],
    Failed: ['系统身份验证失败', 'System identity verification failed'],
  };
  return { ok: code === 'Verified', code, method: 'macos', message: messages[code][lang === 'en' ? 1 : 0] };
}

function verifyMacAuth(reason, lang) {
  if (macAuthProcess) return Promise.resolve(macAuthResult('DeviceBusy', lang));
  const message = reason || (lang === 'en' ? 'OmniDesk needs to verify your identity' : 'OmniDesk 需要验证您的身份');
  if (typeof message !== 'string' || message.length > 1024 || message.includes('\0')) {
    return Promise.resolve(macAuthResult('Failed', lang));
  }
  const { app } = require('electron');
  const helper = app.isPackaged
    ? path.join(process.resourcesPath, 'auth', 'omnidesk-auth')
    : path.join(app.getAppPath(), 'build', 'auth', 'omnidesk-auth');
  return new Promise((resolve) => {
    macAuthProcess = execFile(helper, [message], {
      timeout: 130000, killSignal: 'SIGKILL', maxBuffer: 4096,
    }, (err, stdout) => {
      macAuthProcess = null;
      let code = String(stdout || '').trim();
      if (err) {
        code = err.code === 'ENOENT' ? 'HelperMissing' : (err.killed ? 'TimedOut' : 'Failed');
      } else if (!['Verified', 'Canceled', 'BadCredentials', 'Unavailable', 'RetriesExhausted', 'Failed', 'TimedOut'].includes(code)) {
        code = 'Failed';
      }
      resolve(macAuthResult(code, lang));
    });
  });
}

async function verifySystemAuth(reason, hwnd, { force = false, lang = 'zh', log } = {}) {
  const startedAt = Date.now();
  const generation = authGeneration;
  let result;
  if (process.platform === 'linux') {
    result = { ok: true, code: 'Skipped', method: 'skipped', message: lang === 'en' ? 'System authentication is skipped on Linux' : 'Linux 跳过系统身份验证' };
  } else if (process.platform !== 'win32' && process.platform !== 'darwin') {
    result = { ok: false, code: 'UnsupportedPlatform', method: 'system', message: resultMessage('UnsupportedPlatform', lang) };
  } else if (!force && Date.now() - lastVerifiedAt < AUTH_CACHE_MS) {
    result = { ok: true, code: 'Verified', method: 'cached', message: lang === 'en' ? 'Identity verified' : '验证通过' };
  } else {
    result = process.platform === 'darwin' ? await verifyMacAuth(reason, lang) : await verifyWindowsAuth(reason, hwnd, lang);
    if (generation !== authGeneration) {
      result = { ok: false, code: 'Canceled', method: result.method, message: lang === 'en' ? 'Identity verification canceled' : '已取消验证' };
    } else if (result.ok) {
      lastVerifiedAt = Date.now();
    }
  }
  if (log) {
    const skipped = result.code === 'Skipped';
    const canceled = result.code === 'Canceled' || result.code === 'UserCanceled';
    const level = skipped || (!result.ok && !canceled) ? 'warn' : 'info';
    log[level]('auth', skipped ? 'system authentication skipped' : 'system authentication completed', {
      platform: process.platform, method: result.method, code: result.code, durationMs: Date.now() - startedAt,
    });
  }
  return result;
}

function resetAuthCache() {
  lastVerifiedAt = 0;
  authGeneration++;
  if (macAuthProcess) macAuthProcess.kill();
}

module.exports = { verifySystemAuth, resetAuthCache };
