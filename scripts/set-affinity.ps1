# set-affinity.ps1
# Usage: powershell -File set-affinity.ps1 <HWND_decimal> <affinity_hex>
# Sets SetWindowDisplayAffinity on the given window handle.
# Note: WDA_EXCLUDEFROMCAPTURE (0x11) requires the PROCESS to own the window —
#       Electron owns its own windows so this works without admin.
#       Error 5 (ACCESS_DENIED) means Windows version < 2004 or a policy block.
#
# Affinity values:
#   0x00  WDA_NONE                 - no restriction
#   0x01  WDA_MONITOR              - black in capture (legacy, works on Win7+)
#   0x11  WDA_EXCLUDEFROMCAPTURE   - excluded from capture, visible to user (Win10 2004+)

param(
  [Parameter(Mandatory=$true)] [string]$HwndStr,
  [Parameter(Mandatory=$true)] [string]$AffinityStr
)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class WinAffinity {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint dwAffinity);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetWindowDisplayAffinity(IntPtr hWnd, out uint dwAffinity);
}
"@ -Language CSharp

try {
    $hwnd     = [IntPtr][long]$HwndStr
    $affinity = [uint32][Convert]::ToUInt32($AffinityStr, 16)

    $current = [uint32]0
    [WinAffinity]::GetWindowDisplayAffinity($hwnd, [ref]$current) | Out-Null

    $ok = [WinAffinity]::SetWindowDisplayAffinity($hwnd, $affinity)

    if ($ok) {
        Write-Output "OK: hwnd=$HwndStr affinity=0x$($affinity.ToString('X2')) (was 0x$($current.ToString('X2')))"
        exit 0
    } else {
        $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        Write-Error "FAIL: SetWindowDisplayAffinity error=$err"
        exit 1
    }
} catch {
    Write-Error "EXCEPTION: $_"
    exit 2
}
