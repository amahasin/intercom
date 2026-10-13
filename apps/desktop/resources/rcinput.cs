// InterCom remote-control input helper. A tiny console program that turns lines on its standard
// input into real mouse and keyboard input on this PC (Windows SendInput). The InterCom main
// process starts it only while a colleague has been allowed to control the screen or window that
// is being shared, and ends it when control ends.
//
// It is compiled at build time by apps/desktop/scripts/build.mjs with the C# compiler that ships
// with Windows (.NET Framework 4), so nothing needs installing and no script is run on the PC.
//
// Lines (fields separated by single spaces; decimal numbers use '.'):
//   P <pid>              the InterCom process: input is never delivered to its windows
//   R <l> <t> <w> <h>    the target is this rectangle of the screen, in physical pixels
//   T <hwnd>             the target is this window (a shared window)
//   M <x> <y>            move the pointer to x,y (0..1 across the target)
//   B <flags>            a mouse button event (MOUSEEVENTF_* flags) at the pointer
//   W <flags> <delta>    a wheel event
//   K <scan> <up> <ext>  a key by scan code (up and ext are 0 or 1)
//   C <0|1>              start or stop reporting the pointer: lines "C x y" (0..1 across the target)
//   Q                    release everything and exit
// It prints "ready" when started, and "busy" (once per drop) when an event was dropped because
// the pointer is over, or the keyboard is in, a window of InterCom itself.
using System;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;

static class RcInput
{
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int left, top, right, bottom; }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk, scan; public uint dwFlags, time; public IntPtr extra; }
    [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }

    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] i, int size);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT r);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int cmd);

    const uint GA_ROOT = 2;
    static uint ours = 0;
    static RECT screenRect;
    static bool haveScreen = false;
    static IntPtr window = IntPtr.Zero;
    static bool dropping = false;
    static bool goneReported = false;
    static readonly object outLock = new object();
    static System.Threading.Timer reporter;
    static int lastX = -1, lastY = -1;

    static void Say(string text)
    {
        lock (outLock) { Console.Out.WriteLine(text); Console.Out.Flush(); }
    }

    /// <summary>Tell the app where the pointer is on the target, about 30 times a second while it moves.</summary>
    static void Report(object state)
    {
        try
        {
            RECT r;
            if (!Target(out r)) return;
            POINT c;
            GetCursorPos(out c);
            if (c.x == lastX && c.y == lastY) return;
            lastX = c.x; lastY = c.y;
            double w = r.right - r.left, h = r.bottom - r.top;
            if (w <= 0 || h <= 0) return;
            double nx = (c.x - r.left) / w, ny = (c.y - r.top) / h;
            if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;
            Say("C " + nx.ToString("0.0000", CultureInfo.InvariantCulture) + " " + ny.ToString("0.0000", CultureInfo.InvariantCulture));
        }
        catch (Exception) { }
    }

    static bool Mine(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero || ours == 0) return false;
        uint pid;
        GetWindowThreadProcessId(GetAncestor(hwnd, GA_ROOT), out pid);
        return pid == ours;
    }

    static void Drop()
    {
        if (dropping) return;
        dropping = true;
        Say("busy");
    }

    static bool Target(out RECT r)
    {
        r = screenRect;
        if (window != IntPtr.Zero)
        {
            if (!IsWindow(window))
            {
                if (!goneReported) { goneReported = true; Say("gone"); }
                return false;
            }
            return GetWindowRect(window, out r);
        }
        return haveScreen;
    }

    static void Mouse(uint flags, int data)
    {
        var i = new INPUT[1];
        i[0].type = 0;
        i[0].u.mi.dwFlags = flags;
        i[0].u.mi.mouseData = unchecked((uint)data);
        SendInput(1, i, Marshal.SizeOf(typeof(INPUT)));
    }

    static void Key(ushort scan, bool up, bool ext)
    {
        var i = new INPUT[1];
        i[0].type = 1;
        i[0].u.ki.scan = scan;
        i[0].u.ki.dwFlags = 0x8u | (up ? 0x2u : 0u) | (ext ? 0x1u : 0u);
        SendInput(1, i, Marshal.SizeOf(typeof(INPUT)));
    }

    static double D(string s) { return double.Parse(s, CultureInfo.InvariantCulture); }

    static void Main()
    {
        SetProcessDPIAware();
        Say("ready");
        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            var p = line.Split(' ');
            try
            {
                switch (p[0])
                {
                    case "P": ours = uint.Parse(p[1]); break;
                    case "R":
                        screenRect = new RECT { left = int.Parse(p[1]), top = int.Parse(p[2]) };
                        screenRect.right = screenRect.left + int.Parse(p[3]);
                        screenRect.bottom = screenRect.top + int.Parse(p[4]);
                        haveScreen = true; window = IntPtr.Zero;
                        break;
                    case "T": window = new IntPtr(long.Parse(p[1])); haveScreen = false; break;
                    case "M":
                    {
                        RECT r;
                        if (!Target(out r)) break;
                        int x = r.left + (int)Math.Round(Math.Max(0, Math.Min(1, D(p[1]))) * (r.right - r.left - 1));
                        int y = r.top + (int)Math.Round(Math.Max(0, Math.Min(1, D(p[2]))) * (r.bottom - r.top - 1));
                        var pt = new POINT { x = x, y = y };
                        // Never into InterCom's own windows: the person sharing keeps its controls.
                        if (Mine(WindowFromPoint(pt))) { Drop(); break; }
                        dropping = false;
                        SetCursorPos(x, y);
                        break;
                    }
                    case "B":
                    {
                        POINT cur;
                        GetCursorPos(out cur);
                        if (Mine(WindowFromPoint(cur))) { Drop(); break; }
                        uint flags = uint.Parse(p[1]);
                        bool down = (flags & 0x2u) != 0 || (flags & 0x8u) != 0 || (flags & 0x20u) != 0;
                        // Clicking in a shared window brings it to the front, so keys go to it.
                        if (down && window != IntPtr.Zero && GetForegroundWindow() != window)
                        {
                            if (IsIconic(window)) ShowWindow(window, 9);
                            SetForegroundWindow(window);
                        }
                        Mouse(flags, 0);
                        break;
                    }
                    case "W": Mouse(uint.Parse(p[1]), int.Parse(p[2])); break;
                    case "K":
                        if (Mine(GetForegroundWindow())) { Drop(); break; }
                        Key(ushort.Parse(p[1]), p[2] == "1", p[3] == "1");
                        break;
                    case "C":
                        if (p[1] == "1" && reporter == null) reporter = new System.Threading.Timer(Report, null, 0, 33);
                        else if (p[1] == "0" && reporter != null) { reporter.Dispose(); reporter = null; }
                        break;
                    case "Q":
                        // Never leave a button held down.
                        Mouse(0x4, 0); Mouse(0x10, 0); Mouse(0x40, 0);
                        return;
                }
            }
            catch (Exception) { /* a bad line is ignored */ }
        }
        Mouse(0x4, 0); Mouse(0x10, 0); Mouse(0x40, 0);
    }
}
