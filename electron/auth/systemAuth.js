const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

/** Chrome-style: cache successful auth for 30 s to avoid re-prompting */
const AUTH_CACHE_MS = 30 * 1000;
let lastVerifiedAt = 0;

function resultMessage(code) {
  const map = {
    Verified: '验证通过',
    Canceled: '已取消验证',
    DeviceNotPresent: '未检测到可用的身份验证设备',
    NotConfiguredForUser: '系统未配置身份验证（请先在 Windows 设置中启用 Hello / PIN）',
    DisabledByPolicy: '系统策略禁用了身份验证',
    DeviceBusy: '身份验证设备忙，请稍后再试',
    RetriesExhausted: '验证次数过多',
    CredentialNotSaved: '未保存系统凭据',
    UserCanceled: '已取消验证',
    Failed: '系统身份验证失败',
  };
  return map[code] || map.Failed;
}

function encodePs(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** Build the Hello (UserConsentVerifier) script */
function buildHelloScript(reason) {
  const msg = String(reason || 'OmniDesk 需要验证您的身份').replace(/'/g, "''");
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
    "  $null = $task.Wait(120000)",
    "  return $task.Result",
    "}",
    "$result = AwaitWinRt `",
    "    ([Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync('" + msg + "')) `",
    "    ([Windows.Security.Credentials.UI.UserConsentVerificationResult])",
    "Write-Output $result.ToString()",
  ].join('\n');
}

/**
 * Build the modern credential dialog script (CredUIPromptForWindowsCredentials).
 * This is the Windows Security dialog shown in Chrome/Quark — supports Hello/PIN/password.
 */
function buildModernPasswordScript(reason) {
  const msg = String(reason || 'OmniDesk 需要验证您的身份');
  // Write a .ps1 that uses Add-Type with -TypeDefinition (not -MemberDefinition)
  // and calls CredUIPromptForWindowsCredentialsW + CredUnPackAuthenticationBufferW
  return [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$ErrorActionPreference = "Stop"',
    '',
    '# --- C# interop ---',
    '$cs = @"',
    'using System;',
    'using System.Text;',
    'using System.Runtime.InteropServices;',
    '',
    'public static class AuthHelper {',
    '    public const uint CREDUIWIN_GENERIC = 0x1;',
    '    public const uint CREDUIWIN_ENUMERATE_CURRENT_USER = 0x200;',
    '    public const int ERROR_CANCELLED = 1223;',
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
    '        ref CREDUI_INFOW pUiInfo,',
    '        int dwAuthError,',
    '        ref uint pulAuthPackage,',
    '        IntPtr pvInAuthBuffer,',
    '        uint ulInAuthBufferSize,',
    '        out IntPtr ppvOutAuthBuffer,',
    '        out uint pulOutAuthBufferSize,',
    '        ref bool pfSave,',
    '        uint dwFlags);',
    '',
    '    [DllImport("credui.dll", CharSet = CharSet.Unicode)]',
    '    public static extern bool CredUnPackAuthenticationBufferW(',
    '        int dwFlags,',
    '        IntPtr pAuthBuffer,',
    '        uint cbAuthBuffer,',
    '        StringBuilder pszUserName,',
    '        ref uint pcchMaxUserName,',
    '        StringBuilder pszDomainName,',
    '        ref uint pcchMaxDomainName,',
    '        StringBuilder pszPassword,',
    '        ref uint pcchMaxPassword);',
    '',
    '    [DllImport("ole32.dll")]',
    '    public static extern void CoTaskMemFree(IntPtr pv);',
    '',
    '    static bool ValidateCredentials(string domainUser, string password) {',
    '        string username = domainUser;',
    '        if (username.Contains("\\\\")) username = username.Split(new[] { "\\\\" }, 2, StringSplitOptions.None)[1];',
    '        bool ok = false;',
    '        try {',
    '            var pc = new System.DirectoryServices.AccountManagement.PrincipalContext(',
    '                System.DirectoryServices.AccountManagement.ContextType.Machine);',
    '            ok = pc.ValidateCredentials(username, password);',
    '        } catch { }',
    '        if (!ok) {',
    '            try {',
    '                var pc2 = new System.DirectoryServices.AccountManagement.PrincipalContext(',
    '                    System.DirectoryServices.AccountManagement.ContextType.Domain);',
    '                ok = pc2.ValidateCredentials(username, password);',
    '            } catch { }',
    '        }',
    '        return ok;',
    '    }',
    '',
    '    public static string[] Prompt(string message, string caption, int lastError) {',
    '        var info = new CREDUI_INFOW();',
    '        info.cbSize = Marshal.SizeOf(info);',
    '        info.hwndParent = IntPtr.Zero;',
    '        info.pszMessageText = message ?? "";',
    '        info.pszCaptionText = caption ?? "OmniDesk";',
    '        info.hbmBanner = IntPtr.Zero;',
    '',
    '        uint authPackage = 0;',
    '        bool save = false;',
    '',
    '        for (int attempt = 0; attempt < 5; attempt++) {',
    '            IntPtr outBuf = IntPtr.Zero;',
    '            uint outSize = 0;',
    '',
    '            uint result = CredUIPromptForWindowsCredentialsW(',
    '                ref info, lastError, ref authPackage,',
    '                IntPtr.Zero, 0,',
    '                out outBuf, out outSize,',
    '                ref save, CREDUIWIN_ENUMERATE_CURRENT_USER);',
    '',
    '            if (result == (uint)ERROR_CANCELLED) {',
    '                return new string[] { "Canceled", "" };',
    '            }',
    '',
    '            if (result != 0) {',
    '                if (outBuf != IntPtr.Zero) CoTaskMemFree(outBuf);',
    '                return null;',
    '            }',
    '',
    '            var u = new StringBuilder(256);',
    '            var d = new StringBuilder(256);',
    '            var p = new StringBuilder(256);',
    '            uint uLen = 256, dLen = 256, pLen = 256;',
    '',
    '            bool ok = CredUnPackAuthenticationBufferW(',
    '                0, outBuf, outSize,',
    '                u, ref uLen, d, ref dLen, p, ref pLen);',
    '',
    '            CoTaskMemFree(outBuf);',
    '',
    '            if (!ok) return null;',
    '',
    '            string username = u.ToString();',
    '            string password = p.ToString();',
    '            string domainStr = d.ToString();',
    '            string fullUser = string.IsNullOrEmpty(domainStr) ? username : domainStr + "\\\\" + username;',
    '',
    '            if (string.IsNullOrEmpty(username) || string.IsNullOrEmpty(password)) {',
    '                lastError = 0;',
    '                continue;',
    '            }',
    '',
    '            if (ValidateCredentials(fullUser, password)) {',
    '                return new string[] { fullUser, password };',
    '            }',
    '',
    '            lastError = 0x525;',
    '        }',
    '        return null;',
    '    }',
    '}',
    '"@',
    '',
    'Add-Type -TypeDefinition $cs -Language CSharp -ReferencedAssemblies System.DirectoryServices.AccountManagement',
    '',
    '# --- Prompt for credentials ---',
    '$reason = $args[0]',
    '$creds = [AuthHelper]::Prompt($reason, "OmniDesk", 0)',
    '',
    'if ($creds -eq $null) {',
    '  Write-Output "Canceled"',
    '  exit',
    '}',
    '',
    '$rawUser = $creds[0]',
    '$password = $creds[1]',
    '',
    '# Normalize: strip domain (DOMAIN\\user -> user)',
    '$username = $rawUser',
    'if ($username -match "\\\\") { $username = $username.Split("\\")[-1] }',
    '',
    'if ($creds[0] -eq "Canceled") {',
    '  Write-Output "Canceled"',
    '} else {',
    '  Write-Output "Verified"',
    '}',
  ].join('\r\n');
}

/** Run a PowerShell script via -EncodedCommand */
function runPs(script, options) {
  const { timeout, sta } = options || {};
  return new Promise((resolve) => {
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass'];
    if (sta) args.push('-STA');
    args.push('-EncodedCommand', encodePs(script));
    execFile(
      'powershell.exe', args,
      { timeout: timeout || 130000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = String(stdout || '').trim();
        const lines = out.split(/\r?\n/).filter(Boolean);
        resolve({ out: lines[lines.length - 1] || '', err, debug: String(stderr || '').trim() });
      }
    );
  });
}

/** Run a .ps1 file with optional arguments */
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

/**
 * Request system-level user verification.
 *   1. Windows Hello / PIN / biometric (UserConsentVerifier)
 *   2. Modern credential dialog (CredUIPromptForWindowsCredentialsW) + password validation
 */
async function verifySystemAuth(reason) {
  if (process.platform !== 'win32') {
    return { ok: false, code: 'UnsupportedPlatform', method: 'system', message: '当前系统暂不支持系统级身份验证' };
  }

  if (Date.now() - lastVerifiedAt < AUTH_CACHE_MS) {
    return { ok: true, code: 'Verified', method: 'cached', message: '验证通过' };
  }

  // Step 1: Windows Hello
  const hello = await runPs(buildHelloScript(reason), { sta: true });
  if (hello.out === 'Verified') {
    lastVerifiedAt = Date.now();
    return { ok: true, code: 'Verified', method: 'hello', message: '验证通过' };
  }
  const skipFallback = ['Canceled', 'UserCanceled', 'DisabledByPolicy', 'RetriesExhausted', 'DeviceBusy'];
  if (skipFallback.includes(hello.out)) {
    return { ok: false, code: hello.out, method: 'hello', message: resultMessage(hello.out) };
  }

  // Step 2: Modern credential dialog
  const pwScript = buildModernPasswordScript(reason);
  const pw = await runPsFile(pwScript, [reason || 'OmniDesk 需要验证您的身份'], { timeout: 130000 });

  if (pw.debug) console.error('[auth] pw:', pw.debug);

  if (pw.out === 'Verified') {
    lastVerifiedAt = Date.now();
    return { ok: true, code: 'Verified', method: 'password', message: '验证通过' };
  }

  const code = pw.out || 'Failed';
  return {
    ok: false, code, method: 'password',
    message: code === 'Canceled' ? '已取消验证' : '密码错误或验证失败',
  };
}

function resetAuthCache() { lastVerifiedAt = 0; }

module.exports = { verifySystemAuth, resetAuthCache };
