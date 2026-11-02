# GUI 解锁自动化（仅验收测试用）。
#
# 为什么用真实输入事件：
# egui 是自绘界面，没有 UIAutomation 树，也没有可注入的测试入口。在不改产品代码的
# 前提下，唯一路径是真实鼠标/键盘。三个坑都必须处理，否则会出现"看起来点了但没输进去"：
#
#   1. Windows 前台锁：后台进程的 SetForegroundWindow 会被忽略，点击会打到别的窗口。
#      解法：先模拟一次 Alt 键，让系统认为本进程正在响应用户输入。
#   2. 虚拟键需要扫描码：keybd_event(vk, 0, ...) 对 OEM 键（- . _ 等）与部分布局不可靠，
#      会出现"少字符/错字符"→ 密码错误。解法：用 SendInput + KEYEVENTF_UNICODE，
#      直接按 Unicode 字符注入，与键盘布局无关。
#   3. DPI：窗口矩形与客户区原点不同（有边框），点击坐标必须用客户区原点换算。
#
# 判定成功的证据不看本脚本输出，而看临时数据目录里是否出现 bridge.key：
# 它只在「解锁成功 -> BridgeService::start()」之后才被创建。

param(
    [Parameter(Mandatory = $true)][string]$Master,
    # 输入框中心与解锁按钮中心在客户区内的坐标（1180x760 客户区实测）
    [int]$FieldX = 592,
    [int]$FieldY = 382,
    [int]$ButtonX = 592,
    [int]$ButtonY = 440,
    [switch]$NoSubmit
)

$ErrorActionPreference = 'Stop'

if (-not ('KN274.Input' -as [type])) {
Add-Type -TypeDefinition @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

namespace KN274 {
    public static class Input {
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
        [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
        [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
        [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
        [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")] static extern void mouse_event(uint f, int dx, int dy, uint d, UIntPtr e);
        [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
        [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
        [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
        [DllImport("user32.dll")] static extern void SwitchToThisWindow(IntPtr h, bool altTab);
        [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

        [StructLayout(LayoutKind.Sequential)]
        struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
        [StructLayout(LayoutKind.Sequential)]
        struct POINT { public int X; public int Y; }
        [StructLayout(LayoutKind.Sequential)]
        struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)]
        struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Explicit)]
        struct INPUTUNION { [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public MOUSEINPUT mi; }
        [StructLayout(LayoutKind.Sequential)]
        struct INPUT { public uint type; public INPUTUNION u; }

        const uint INPUT_KEYBOARD = 1;
        const uint KEYEVENTF_KEYUP = 0x0002;
        const uint KEYEVENTF_UNICODE = 0x0004;

        static void TypeChar(char ch) {
            INPUT down = new INPUT();
            down.type = INPUT_KEYBOARD;
            down.u.ki.wVk = 0;
            down.u.ki.wScan = ch;
            down.u.ki.dwFlags = KEYEVENTF_UNICODE;
            INPUT up = new INPUT();
            up.type = INPUT_KEYBOARD;
            up.u.ki.wVk = 0;
            up.u.ki.wScan = ch;
            up.u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
            SendInput(2, new INPUT[] { down, up }, Marshal.SizeOf(typeof(INPUT)));
        }

        static void ClickAt(IntPtr h, int cx, int cy) {
            POINT p = new POINT();
            p.X = cx; p.Y = cy;
            ClientToScreen(h, ref p);
            SetCursorPos(p.X, p.Y);
            Thread.Sleep(140);
            mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
            Thread.Sleep(60);
            mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
            Thread.Sleep(220);
        }

        public static string Unlock(string master, int fx, int fy, int bx, int by, bool noSubmit) {
            Process p = null;
            foreach (var q in Process.GetProcessesByName("keynest-egui"))
                if (q.MainWindowHandle != IntPtr.Zero) { p = q; break; }
            if (p == null) return "NO_WINDOW";

            IntPtr h = p.MainWindowHandle;

            // 抢前台要过三关，缺一关都会失败（失败时鼠标会打到别的窗口上，
            // 现象是「脚本说点了，界面没反应」）：
            //   1. ShowWindow 恢复最小化
            //   2. AttachThreadInput 把自己接到当前前台窗口的输入队列上
            //      —— 这是绕过前台锁的关键；单纯 SetForegroundWindow 对后台进程无效
            //   3. SwitchToThisWindow 作为兜底
            ShowWindow(h, 9);
            BringWindowToTop(h);
            for (int attempt = 0; attempt < 3 && GetForegroundWindow() != h; attempt++) {
                keybd_event(0x12, 0, 0, UIntPtr.Zero);
                Thread.Sleep(40);
                keybd_event(0x12, 0, 2, UIntPtr.Zero);
                Thread.Sleep(60);

                IntPtr fg = GetForegroundWindow();
                uint fgThread = fg == IntPtr.Zero ? 0 : GetWindowThreadProcessId(fg, IntPtr.Zero);
                uint me = GetCurrentThreadId();
                bool attached = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);
                try {
                    SetForegroundWindow(h);
                    BringWindowToTop(h);
                    SwitchToThisWindow(h, true);
                    Thread.Sleep(250);
                } finally {
                    if (attached) AttachThreadInput(me, fgThread, false);
                }
            }
            Thread.Sleep(400);
            if (GetForegroundWindow() != h) return "NO_FOCUS";

            RECT c;
            if (!GetClientRect(h, out c)) return "NO_CLIENT";
            if (fx < 0 || fy < 0 || fx >= (c.Right - c.Left) || fy >= (c.Bottom - c.Top))
                return "BAD_POINT";

            ClickAt(h, fx, fy);
            // 点击后必须等 egui 完成一次重绘：egui 空闲时按 500ms 节流重绘，
            // 焦点与文本编辑状态都是在那一帧才建立的。等不够就会出现
            // 「第一个字符被丢掉」——密码少一位，界面只显示「主密码错误」。
            Thread.Sleep(900);
            foreach (char ch in master) { TypeChar(ch); Thread.Sleep(25); }
            Thread.Sleep(400);

            if (noSubmit) return "TYPED";
            ClickAt(h, bx, by);
            return "CLICKED_SUBMIT";
        }
    }
}
"@
}

Write-Output ([KN274.Input]::Unlock($Master, $FieldX, $FieldY, $ButtonX, $ButtonY, [bool]$NoSubmit))
