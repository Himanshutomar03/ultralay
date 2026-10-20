# set-exstyle.ps1
# Usage: powershell -File set-exstyle.ps1 <HWND_decimal> <addStyles_hex>
# OR-in extended window styles (GWL_EXSTYLE) to the given HWND.
#
# Key styles:
#   0x00000020  WS_EX_TRANSPARENT  — sibling/parent gets mouse messages first (click-through)
#   0x08000000  WS_EX_NOACTIVATE   — clicking does NOT activate/focus this window
#   0x00000080  WS_EX_TOOLWINDOW   — hidden from Alt+Tab and task switcher
#   0x00080000  WS_EX_LAYERED      — required for transparency (Electron sets this already)
#
# Combined stealth mask: 0x080000A0 = WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW

param(
  [Parameter(Mandatory=$true)] [string]$HwndStr,
  [Parameter(Mandatory=$true)] [string]$AddStylesStr
)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class WinStyles {
    public const int GWL_EXSTYLE = -20;

    [DllImport("user32.dll", SetLastError = true)]
    public static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter,
        int X, int Y, int cx, int cy, uint uFlags);
}
"@ -Language CSharp -ErrorAction SilentlyContinue

try {
    $hwnd     = [IntPtr][long]$HwndStr
    $addMask  = [int][Convert]::ToUInt32($AddStylesStr, 16)

    $current  = [WinStyles]::GetWindowLong($hwnd, [WinStyles]::GWL_EXSTYLE)
    $newStyle = $current -bor $addMask
    $result   = [WinStyles]::SetWindowLong($hwnd, [WinStyles]::GWL_EXSTYLE, $newStyle)

    if ($result -ne 0 -or $newStyle -eq 0) {
        Write-Output "OK: hwnd=$HwndStr exstyle=0x$($newStyle.ToString('X8')) (was 0x$($current.ToString('X8')))"
        exit 0
    } else {
        $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        Write-Error "FAIL: SetWindowLong returned 0, error=$err"
        exit 1
    }
} catch {
    Write-Error "EXCEPTION: $_"
    exit 2
}
