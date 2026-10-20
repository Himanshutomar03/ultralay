# scripts/printwindow-capture.ps1
# Captures the full screen using Win32 PrintWindow + GDI BitBlt.
# PW_RENDERFULLCONTENT (0x2) captures DWM-composited content including
# windows marked WDA_EXCLUDEFROMCAPTURE / WDA_MONITOR (SEB, OBS, etc.)
#
# Usage: powershell -File printwindow-capture.ps1 -OutputPath "C:\out.png"
# Exit 0 + prints output path on success, exit 1 on failure.

param(
  [Parameter(Mandatory=$true)] [string]$OutputPath
)

Add-Type -ReferencedAssemblies @('System.Drawing') -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Text;

public class PWCapture {
    // ── Win32 imports ────────────────────────────────────────────────────────
    [DllImport("user32.dll")]
    public static extern IntPtr GetDesktopWindow();

    [DllImport("user32.dll")]
    public static extern IntPtr GetWindowDC(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ReleaseDC(IntPtr hWnd, IntPtr hDC);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsDelegate lpEnumFunc, IntPtr lParam);

    public delegate bool EnumWindowsDelegate(IntPtr hWnd, IntPtr lParam);

    [DllImport("gdi32.dll")]
    public static extern IntPtr CreateCompatibleDC(IntPtr hDC);

    [DllImport("gdi32.dll")]
    public static extern IntPtr CreateCompatibleBitmap(IntPtr hDC, int nWidth, int nHeight);

    [DllImport("gdi32.dll")]
    public static extern IntPtr SelectObject(IntPtr hDC, IntPtr hGdiObj);

    [DllImport("gdi32.dll")]
    public static extern bool BitBlt(
        IntPtr hdcDest, int xDest, int yDest, int wDest, int hDest,
        IntPtr hdcSrc,  int xSrc,  int ySrc,
        uint dwRop);

    [DllImport("gdi32.dll")]
    public static extern bool DeleteDC(IntPtr hDC);

    [DllImport("gdi32.dll")]
    public static extern bool DeleteObject(IntPtr hGdiObj);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left, Top, Right, Bottom;
        public int Width  { get { return Right  - Left; } }
        public int Height { get { return Bottom - Top;  } }
    }

    // PW_RENDERFULLCONTENT — captures DWM-composited content.
    // This bypasses WDA_EXCLUDEFROMCAPTURE on the TARGET window (not ours).
    public const uint PW_RENDERFULLCONTENT = 0x00000002;
    public const uint SRCCOPY              = 0x00CC0020;

    // ── Full-screen capture ───────────────────────────────────────────────────
    public static string Capture(string outputPath) {
        // Step 1: Get screen size from desktop window
        IntPtr desktop = GetDesktopWindow();
        RECT   deskRect;
        GetWindowRect(desktop, out deskRect);
        int sw = deskRect.Width;
        int sh = deskRect.Height;

        // Step 2: Get screen DC and create compatible DC + bitmap
        IntPtr screenDC  = GetWindowDC(desktop);
        IntPtr memDC     = CreateCompatibleDC(screenDC);
        IntPtr hBitmap   = CreateCompatibleBitmap(screenDC, sw, sh);
        IntPtr hOldBmp   = SelectObject(memDC, hBitmap);

        try {
            // Step 3: Base layer — BitBlt the whole screen (fast, captures most content)
            BitBlt(memDC, 0, 0, sw, sh, screenDC, 0, 0, SRCCOPY);

            // Step 4: Overlay protected windows using PrintWindow(PW_RENDERFULLCONTENT)
            // This composites DWM content that BitBlt misses (protected/offscreen windows)
            var protectedWindows = FindProtectedWindows();
            foreach (var hwnd in protectedWindows) {
                RECT r;
                if (!GetWindowRect(hwnd, out r)) continue;
                if (r.Width <= 0 || r.Height <= 0) continue;

                // Create per-window DC + bitmap
                IntPtr winDC    = CreateCompatibleDC(screenDC);
                IntPtr winBmp   = CreateCompatibleBitmap(screenDC, r.Width, r.Height);
                IntPtr winOld   = SelectObject(winDC, winBmp);

                bool ok = PrintWindow(hwnd, winDC, PW_RENDERFULLCONTENT);
                if (ok) {
                    // Blit the PrintWindow result into the correct position on the screen bitmap
                    BitBlt(memDC, r.Left, r.Top, r.Width, r.Height, winDC, 0, 0, SRCCOPY);
                }

                SelectObject(winDC, winOld);
                DeleteObject(winBmp);
                DeleteDC(winDC);
            }

            // Step 5: Convert HBITMAP → System.Drawing.Bitmap → PNG
            using (var bmp = Image.FromHbitmap(hBitmap)) {
                bmp.Save(outputPath, ImageFormat.Png);
            }

            return outputPath;
        } finally {
            SelectObject(memDC, hOldBmp);
            DeleteObject(hBitmap);
            DeleteDC(memDC);
            ReleaseDC(desktop, screenDC);
        }
    }

    // ── Find windows that may be capture-protected ────────────────────────────
    // We overlay all visible top-level windows with PrintWindow to ensure
    // even WDA_EXCLUDEFROMCAPTURE content is composited into our bitmap.
    private static List<IntPtr> FindProtectedWindows() {
        var results = new List<IntPtr>();
        EnumWindows((hwnd, lp) => {
            if (!IsWindowVisible(hwnd)) return true;
            var sb = new StringBuilder(256);
            GetWindowText(hwnd, sb, 256);
            string title = sb.ToString().ToLower();
            // Target SEB and any fullscreen/exam app windows
            if (title.Contains("safe exam") || title.Contains("safeexam") ||
                title.Contains("seb")       || title.Contains("lockdown") ||
                title.Contains("respondus") || title.Contains("proctorio")) {
                results.Add(hwnd);
            }
            return true;
        }, IntPtr.Zero);
        return results;
    }
}
"@ -Language CSharp -ErrorAction SilentlyContinue

try {
    $result = [PWCapture]::Capture($OutputPath)
    Write-Output "OK:$result"
    exit 0
} catch {
    Write-Error "CAPTURE_FAILED: $_"
    exit 1
}
