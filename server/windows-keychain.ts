import { execFile } from "node:child_process";
import { join } from "node:path";
import type { KeychainStore } from "./accounts.ts";

const credentialCommand = Buffer.from(String.raw`
$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class AntigravityCredential {
  private const int Generic = 1;
  private const int LocalMachine = 2;
  private const int NotFound = 1168;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct Credential {
    public int Flags, Type;
    public string Target;
    public IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int BlobSize;
    public IntPtr Blob;
    public int Persist, AttributeCount;
    public IntPtr Attributes, TargetAlias;
    public string UserName;
  }

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredRead(string target, int type, int flags, out IntPtr credential);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredWrite(ref Credential credential, int flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredDelete(string target, int type, int flags);
  [DllImport("advapi32.dll")]
  private static extern void CredFree(IntPtr credential);

  public static string Read(string target) {
    IntPtr pointer;
    if (!CredRead(target, Generic, 0, out pointer)) {
      int error = Marshal.GetLastWin32Error();
      if (error == NotFound) return null;
      throw new Win32Exception(error);
    }
    try {
      var credential = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
      byte[] bytes = new byte[credential.BlobSize];
      try {
        if (bytes.Length > 0) Marshal.Copy(credential.Blob, bytes, 0, bytes.Length);
        return Convert.ToBase64String(bytes);
      } finally {
        Array.Clear(bytes, 0, bytes.Length);
      }
    } finally {
      CredFree(pointer);
    }
  }

  public static void Write(string target, string account, string value) {
    byte[] bytes = Convert.FromBase64String(value);
    var pinned = GCHandle.Alloc(bytes, GCHandleType.Pinned);
    try {
      var credential = new Credential {
        Type = Generic, Target = target, UserName = account, Persist = LocalMachine,
        BlobSize = bytes.Length, Blob = pinned.AddrOfPinnedObject()
      };
      if (!CredWrite(ref credential, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
    } finally {
      Array.Clear(bytes, 0, bytes.Length);
      pinned.Free();
    }
  }

  public static void Remove(string target) {
    if (!CredDelete(target, Generic, 0)) {
      int error = Marshal.GetLastWin32Error();
      if (error != NotFound) throw new Win32Exception(error);
    }
  }
}
'@
  $request = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
  $target = $request.service + ':' + $request.account
  switch ($request.operation) {
    'read' {
      $value = [AntigravityCredential]::Read($target)
      if ($null -eq $value) { [Console]::Write('missing') }
      else { [Console]::Write('value:' + $value) }
    }
    'write' {
      [AntigravityCredential]::Write($target, $request.account, $request.value)
      [Console]::Write('ok')
    }
    'remove' {
      [AntigravityCredential]::Remove($target)
      [Console]::Write('ok')
    }
    default { exit 1 }
  }
} catch { exit 1 }
`, "utf16le").toString("base64");

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function credentialOperation(operation: "read" | "write" | "remove", service: string, account: string, value?: string) {
  if (process.platform !== "win32" || !process.env.SystemRoot) {
    throw new Error("Windows Credential Manager is unavailable");
  }
  if (![service, account].every(part => /^[a-zA-Z0-9._-]+$/.test(part))) {
    throw new Error("Invalid Antigravity credential name");
  }
  const powershell = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return new Promise<string>((resolve, reject) => {
    const fail = () => reject(new Error(`Could not ${operation} the Antigravity credential in Windows Credential Manager`));
    const child = execFile(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", credentialCommand],
      { timeout: 10_000, maxBuffer: 16_384, windowsHide: true }, (error, stdout) => error ? fail() : resolve(stdout));
    child.stdin?.on("error", fail);
    child.stdin?.end(JSON.stringify({ operation, service, account, value }));
  });
}

export class WindowsKeychainStore implements KeychainStore {
  async read(service: string, account: string): Promise<string | null> {
    const result = await credentialOperation("read", service, account);
    if (result === "missing") return null;
    if (result.startsWith("value:")) {
      try {
        return utf8.decode(Buffer.from(result.slice("value:".length), "base64"));
      } catch {
        throw new Error("The Antigravity credential is not valid UTF-8");
      }
    }
    throw new Error("Invalid response from Windows Credential Manager");
  }

  async write(service: string, account: string, value: string): Promise<void> {
    const bytes = Buffer.from(value, "utf8");
    if (bytes.length > 2560) throw new Error("Credential exceeds the Windows Credential Manager size limit");
    const encoded = bytes.toString("base64");
    if (await credentialOperation("write", service, account, encoded) !== "ok" ||
        await this.read(service, account) !== value) {
      throw new Error("Antigravity credential write verification failed");
    }
  }

  async remove(service: string, account: string): Promise<void> {
    if (await credentialOperation("remove", service, account) !== "ok") {
      throw new Error("Antigravity credential removal failed");
    }
  }
}
