// intercom-assist.exe: remote help (M6.18) with the Windows Remote Desktop Services session
// sharing API (the same programming interface Windows Remote Assistance is built on).
//
//   intercom-assist.exe share --peer "Name" [--control view|interactive]
//       Shares this PC's desktop. Makes an invitation with a random password and prints it as one
//       JSON line for InterCom to hand to the colleague over the encrypted peer link; nobody
//       types or sees the password. A small window stays on top of this desktop for as long as the
//       session lasts, with Stop control and End session.
//   intercom-assist.exe view
//       Shows a colleague's desktop in a window of its own (full screen, fit or actual size, one
//       screen or all, control on or off). Waits for a connect command on standard input.
//
// Both modes talk to InterCom with one JSON object per line: commands on standard input, events
// on standard output. Compiled by apps/desktop/scripts/build.mjs with the C# compiler that is
// part of Windows (.NET Framework 4); one AnyCPU file serves x64 and ARM64.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace InterComAssist
{
    // The event interface of both the sharing session and the viewer (ids from Windows' own
    // type library, rdpsharercom.dll). A sink must have every member; most do nothing.
    [ComImport, Guid("98a97042-6698-40e9-8efd-b3200990004b"), InterfaceType(ComInterfaceType.InterfaceIsIDispatch)]
    internal interface IRdpEvents
    {
        [DispId(301)] void OnAttendeeConnected(object pAttendee);
        [DispId(302)] void OnAttendeeDisconnected(object pDisconnectInfo);
        [DispId(303)] void OnAttendeeUpdate(object pAttendee);
        [DispId(304)] void OnError(object errorInfo);
        [DispId(305)] void OnConnectionEstablished();
        [DispId(306)] void OnConnectionTerminated(int discReason, int extendedInfo);
        [DispId(307)] void OnConnectionAuthenticated();
        [DispId(308)] void OnConnectionFailed();
        [DispId(309)] void OnControlLevelChangeRequest(object pAttendee, int requestedLevel);
        [DispId(310)] void OnGraphicsStreamPaused();
        [DispId(311)] void OnGraphicsStreamResumed();
        [DispId(312)] void OnChannelBound(object pChannel, int lAttendeeId);
        [DispId(314)] void OnChannelDataReceived(object pChannel, int lAttendeeId, string bstrData);
        [DispId(315)] void OnChannelDataSent(object pChannel, int lAttendeeId, int bytesSent);
        [DispId(316)] void OnApplicationOpen(object pApplication);
        [DispId(317)] void OnApplicationClose(object pApplication);
        [DispId(318)] void OnApplicationUpdate(object pApplication);
        [DispId(319)] void OnWindowOpen(object pWindow);
        [DispId(320)] void OnWindowClose(object pWindow);
        [DispId(321)] void OnWindowUpdate(object pWindow);
        [DispId(323)] void OnSharedRectChanged(int left, int top, int right, int bottom);
        [DispId(324)] void OnFocusReleased(int iDirection);
        [DispId(325)] void OnSharedDesktopSettingsChanged(int width, int height, int colordepth);
        [DispId(338)] void OnControlLevelChangeResponse(object pAttendee, int requestedLevel, int reasonCode);
        [DispId(340)] void OnViewingSizeChanged(int left, int top, int right, int bottom);
    }

    internal class RdpSink : IRdpEvents
    {
        /// <summary>An attendee as text: who, and at what control level.</summary>
        protected static string Describe(object attendee)
        {
            try { dynamic a = attendee; return "name=" + a.RemoteName + " level=" + a.ControlLevel; }
            catch (Exception e) { return "(" + e.Message + ")"; }
        }

        public virtual void OnAttendeeConnected(object pAttendee) { }
        public virtual void OnAttendeeDisconnected(object pDisconnectInfo) { }
        public virtual void OnAttendeeUpdate(object pAttendee) { Io.Trace("OnAttendeeUpdate", Describe(pAttendee)); }
        public virtual void OnError(object errorInfo) { Io.Trace("OnError", errorInfo == null ? "" : errorInfo.ToString()); }
        public virtual void OnConnectionEstablished() { }
        public virtual void OnConnectionTerminated(int discReason, int extendedInfo) { }
        public virtual void OnConnectionAuthenticated() { Io.Trace("OnConnectionAuthenticated"); }
        public virtual void OnConnectionFailed() { }
        public virtual void OnControlLevelChangeRequest(object pAttendee, int requestedLevel) { }
        public virtual void OnGraphicsStreamPaused() { Io.Trace("OnGraphicsStreamPaused"); }
        public virtual void OnGraphicsStreamResumed() { Io.Trace("OnGraphicsStreamResumed"); }
        public virtual void OnChannelBound(object pChannel, int lAttendeeId) { }
        public virtual void OnChannelDataReceived(object pChannel, int lAttendeeId, string bstrData) { }
        public virtual void OnChannelDataSent(object pChannel, int lAttendeeId, int bytesSent) { }
        public virtual void OnApplicationOpen(object pApplication) { }
        public virtual void OnApplicationClose(object pApplication) { }
        public virtual void OnApplicationUpdate(object pApplication) { }
        public virtual void OnWindowOpen(object pWindow) { }
        public virtual void OnWindowClose(object pWindow) { }
        public virtual void OnWindowUpdate(object pWindow) { }
        public virtual void OnSharedRectChanged(int left, int top, int right, int bottom) { Io.Trace("OnSharedRectChanged", left + "," + top + "," + right + "," + bottom); }
        public virtual void OnFocusReleased(int iDirection) { }
        public virtual void OnSharedDesktopSettingsChanged(int width, int height, int colordepth) { Io.Trace("OnSharedDesktopSettingsChanged", width + "x" + height); }
        public virtual void OnControlLevelChangeResponse(object pAttendee, int requestedLevel, int reasonCode) { }
        public virtual void OnViewingSizeChanged(int left, int top, int right, int bottom) { }
    }

    // CTRL_LEVEL of the session sharing API.
    internal static class Level
    {
        public const int None = 1;
        public const int View = 2;
        public const int Interactive = 3;
    }

    internal sealed class Options
    {
        public string Mode = "";
        public string Peer = "";
        public bool ViewOnly;
        /// <summary>Seconds the sharing side waits for the colleague to connect.</summary>
        public int WaitSeconds = 90;
        /// <summary>Print every event the sharing API raises (for finding out what it does).</summary>
        public static bool Debug;

        public static Options Parse(string[] args)
        {
            var o = new Options();
            if (args.Length > 0) o.Mode = args[0];
            for (int i = 1; i < args.Length; i++)
            {
                if (args[i] == "--peer" && i + 1 < args.Length) o.Peer = args[++i];
                else if (args[i] == "--control" && i + 1 < args.Length) o.ViewOnly = args[++i] == "view";
                else if (args[i] == "--debug") Debug = true;
                else if (args[i] == "--wait" && i + 1 < args.Length) int.TryParse(args[++i], out o.WaitSeconds);
            }
            return o;
        }
    }

    // One JSON object per line, in and out.
    internal static class Io
    {
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 1 << 21 };
        static readonly object OutLock = new object();
        static StreamWriter output;
        /// <summary>Marshals work onto the UI thread.</summary>
        public static Control Sync;

        public static void Start(Action<Dictionary<string, object>> onCommand, Action onEof)
        {
            output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
            Sync = new Control();
            var forceHandle = Sync.Handle;
            var thread = new Thread(() =>
            {
                try
                {
                    var input = new StreamReader(Console.OpenStandardInput(), Encoding.UTF8);
                    string line;
                    while ((line = input.ReadLine()) != null)
                    {
                        Dictionary<string, object> cmd;
                        try { cmd = Json.DeserializeObject(line) as Dictionary<string, object>; }
                        catch { continue; }
                        if (cmd != null) Sync.BeginInvoke(new Action(() => { try { onCommand(cmd); } catch (Exception e) { Emit("error", e.Message); } }));
                    }
                }
                catch { }
                // InterCom has gone (or closed our input): there is nobody to help any more.
                try { Sync.BeginInvoke(onEof); } catch { }
            });
            thread.IsBackground = true;
            thread.Start();
        }

        public static void Emit(string ev, string message = null, Dictionary<string, object> extra = null)
        {
            var o = new Dictionary<string, object> { { "event", ev } };
            if (message != null) o["message"] = message;
            if (extra != null) foreach (var kv in extra) o[kv.Key] = kv.Value;
            lock (OutLock)
            {
                try { output.WriteLine(Json.Serialize(o)); } catch { }
            }
        }

        public static void Trace(string what, string detail = "")
        {
            if (Options.Debug) Emit("debug", null, new Dictionary<string, object> { { "what", what }, { "detail", detail } });
        }

        public static string Str(Dictionary<string, object> d, string key)
        {
            object v;
            return d.TryGetValue(key, out v) && v != null ? v.ToString() : "";
        }

        public static int Int(Dictionary<string, object> d, string key, int fallback)
        {
            object v;
            int n;
            return d.TryGetValue(key, out v) && v != null && int.TryParse(v.ToString(), out n) ? n : fallback;
        }
    }

    internal static class Native
    {
        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
        [DllImport("user32.dll", EntryPoint = "SetProcessDpiAwarenessContext")]
        static extern bool SetProcessDpiAwarenessContext(IntPtr value);

        /// <summary>Real pixels, so a screen's size here is the size the session shares.</summary>
        public static void BeDpiAware()
        {
            try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch { }
            try { SetProcessDPIAware(); } catch { }
        }
    }

    internal static class Program
    {
        [STAThread]
        static int Main(string[] args)
        {
            Native.BeDpiAware();
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            var o = Options.Parse(args);
            try
            {
                if (o.Mode == "share") return Sharer.Run(o);
                if (o.Mode == "view") return Viewer.Run(o);
                Console.Error.WriteLine("usage: intercom-assist share|view");
                return 64;
            }
            catch (Exception e)
            {
                try { Io.Emit("error", e.Message); Io.Emit("closed", null, new Dictionary<string, object> { { "reason", "error" } }); } catch { }
                return 1;
            }
        }

        public static string RandomText(int length)
        {
            const string chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
            var bytes = new byte[length];
            using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(bytes);
            var sb = new StringBuilder();
            foreach (var b in bytes) sb.Append(chars[b % chars.Length]);
            return sb.ToString();
        }
    }

    // ---------------------------------------------------------------------------------------
    // The sharing side
    // ---------------------------------------------------------------------------------------

    /// <summary>Toolbar and menu icons, drawn from the icon font Windows ships (Segoe Fluent Icons, else MDL2).</summary>
    internal static class Icons
    {
        public const char FullScreen = '';
        public const char ExitFullScreen = '';
        public const char View = '';
        public const char Monitor = '';
        public const char Control = '';
        public const char Chat = '';
        public const char HangUp = '';

        static string fontName;
        static bool looked;

        static string Font()
        {
            if (looked) return fontName;
            looked = true;
            try
            {
                using (var fonts = new System.Drawing.Text.InstalledFontCollection())
                    foreach (var name in new[] { "Segoe Fluent Icons", "Segoe MDL2 Assets" })
                        if (fonts.Families.Any(f => f.Name == name)) { fontName = name; break; }
            }
            catch { }
            return fontName;
        }

        /// <summary>A 32 px square image of one glyph (a toolbar scales it down); null if the font is missing.</summary>
        public static Image Glyph(char glyph, Color color)
        {
            var name = Font();
            if (name == null) return null;
            var bmp = new Bitmap(32, 32);
            using (var g = Graphics.FromImage(bmp))
            using (var font = new Font(name, 22F, GraphicsUnit.Pixel))
            using (var brush = new SolidBrush(color))
            using (var format = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center })
            {
                g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
                g.DrawString(glyph.ToString(), font, brush, new RectangleF(0, 0, 32, 32), format);
            }
            return bmp;
        }
    }

    /// <summary>
    /// A thin red frame on the edges of the screen (or screens) being shared. A cue that is always
    /// there, cannot be lost behind a window and covers nothing: it never takes a click or the focus.
    /// </summary>
    internal sealed class ScreenFrame : IDisposable
    {
        const int Thickness = 4;

        sealed class Bar : Form
        {
            public Bar()
            {
                FormBorderStyle = FormBorderStyle.None;
                ShowInTaskbar = false;
                StartPosition = FormStartPosition.Manual;
                TopMost = true;
                BackColor = Color.FromArgb(220, 38, 38);
                Opacity = 0.92;
            }

            protected override bool ShowWithoutActivation { get { return true; } }

            protected override CreateParams CreateParams
            {
                get
                {
                    var p = base.CreateParams;
                    // Tool window, click-through, never active, layered.
                    p.ExStyle |= 0x00000080 | 0x00000020 | 0x08000000 | 0x00080000;
                    return p;
                }
            }
        }

        readonly List<Bar> bars = new List<Bar>();

        public void Show(IEnumerable<Rectangle> areas)
        {
            Clear();
            foreach (var r in areas)
            {
                Add(new Rectangle(r.Left, r.Top, r.Width, Thickness));
                Add(new Rectangle(r.Left, r.Bottom - Thickness, r.Width, Thickness));
                Add(new Rectangle(r.Left, r.Top + Thickness, Thickness, Math.Max(1, r.Height - 2 * Thickness)));
                Add(new Rectangle(r.Right - Thickness, r.Top + Thickness, Thickness, Math.Max(1, r.Height - 2 * Thickness)));
            }
        }

        void Add(Rectangle bounds)
        {
            var bar = new Bar();
            bar.Bounds = bounds;
            bar.Show();
            bars.Add(bar);
        }

        void Clear()
        {
            foreach (var b in bars) { try { b.Close(); b.Dispose(); } catch { } }
            bars.Clear();
        }

        public void Dispose() { Clear(); }
    }

    /// <summary>
    /// The notification-area icon of a shared desktop: who is looking, and the two things the person
    /// sharing can do at any time. Click it (or right-click) for the menu.
    /// </summary>
    internal sealed class ShareTray : IDisposable
    {
        readonly NotifyIcon icon = new NotifyIcon();
        readonly ContextMenuStrip menu = new ContextMenuStrip();
        readonly ToolStripMenuItem header = new ToolStripMenuItem();
        readonly ToolStripMenuItem control = new ToolStripMenuItem();
        readonly ToolStripMenuItem end = new ToolStripMenuItem("End session");
        public event EventHandler ControlClicked;
        public event EventHandler EndClicked;

        public ShareTray()
        {
            try { icon.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); }
            catch { icon.Icon = SystemIcons.Information; }
            header.Enabled = false;
            header.Font = new Font(header.Font, FontStyle.Bold);
            control.Image = Icons.Glyph(Icons.Control, Color.Black);
            control.Click += (a, b) => { if (ControlClicked != null) ControlClicked(this, EventArgs.Empty); };
            end.Image = Icons.Glyph(Icons.HangUp, Color.Firebrick);
            end.Click += (a, b) => { if (EndClicked != null) EndClicked(this, EventArgs.Empty); };
            menu.Items.AddRange(new ToolStripItem[] { header, new ToolStripSeparator(), control, end });
            icon.ContextMenuStrip = menu;
            // A left click opens the same menu (a notification icon only opens it on a right click).
            icon.MouseClick += (a, e) =>
            {
                if (e.Button != MouseButtons.Left) return;
                try { typeof(NotifyIcon).GetMethod("ShowContextMenu", BindingFlags.Instance | BindingFlags.NonPublic).Invoke(icon, null); }
                catch { }
            };
            icon.Visible = true;
        }

        /// <summary>What it says now; the control entry is there once someone is connected.</summary>
        public void Show(string text, bool connected, bool controlAllowed)
        {
            header.Text = text;
            icon.Text = text.Length > 60 ? text.Substring(0, 60) : text;
            control.Visible = connected;
            control.Text = controlAllowed ? "Stop control" : "Allow control";
        }

        public void Balloon(string title, string text)
        {
            try { icon.ShowBalloonTip(5000, title, text, ToolTipIcon.Info); } catch { }
        }

        public void Dispose()
        {
            try { icon.Visible = false; icon.Dispose(); menu.Dispose(); } catch { }
        }
    }

    internal sealed class Sharer : RdpSink
    {
        const string SessionClsid = "9B78F0E6-3E05-4A5B-B2E8-E743A8956B65";
        readonly Options options;
        readonly ScreenFrame frame = new ScreenFrame();
        readonly ShareTray tray = new ShareTray();
        readonly System.Windows.Forms.Timer waitTimer = new System.Windows.Forms.Timer();
        object session;
        object invitation;
        AxHost.ConnectionPointCookie cookie;
        object attendee;
        bool controlAllowed;
        bool done;
        /// <summary>Which screen is shared: an index into <c>screens</c>, or -1 for all of them.</summary>
        int shown = -1;
        Screen[] screens;

        Sharer(Options o)
        {
            options = o;
            controlAllowed = !o.ViewOnly;
        }

        public static int Run(Options o)
        {
            var s = new Sharer(o);
            Io.Start(s.OnCommand, () => s.Shutdown("host-gone"));
            s.Start();
            Application.Run();
            return 0;
        }

        string Who { get { return options.Peer.Length > 0 ? options.Peer : "Your colleague"; } }

        void Start()
        {
            // Primary screen first, then left to right: the same order InterCom shows the colleague.
            screens = Screen.AllScreens
                .OrderByDescending(s => s.Primary).ThenBy(s => s.Bounds.X).ThenBy(s => s.Bounds.Y).ToArray();
            tray.Show("Remote help: waiting for " + Who + " to connect", false, controlAllowed);
            tray.EndClicked += (a, b) => Shutdown("ended");
            tray.ControlClicked += (a, b) => ToggleControl();
            try
            {
                session = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid(SessionClsid)));
                cookie = new AxHost.ConnectionPointCookie(session, this, typeof(IRdpEvents));
                dynamic s = session;
                s.Open();
                var password = Program.RandomText(20);
                dynamic inv = s.Invitations.CreateInvitation(Program.RandomText(16), "InterCom", password, 1);
                invitation = inv;
                var list = new List<object>();
                foreach (var sc in screens)
                    list.Add(new Dictionary<string, object> { { "w", sc.Bounds.Width }, { "h", sc.Bounds.Height }, { "primary", sc.Primary } });
                Io.Emit("ready", null, new Dictionary<string, object>
                {
                    { "ticket", (string)inv.ConnectionString }, { "password", password }, { "screens", list }
                });
            }
            catch (Exception e)
            {
                Io.Emit("error", "Windows could not start sharing this screen: " + e.Message);
                Shutdown("error");
                return;
            }
            waitTimer.Interval = Math.Max(5, options.WaitSeconds) * 1000;
            waitTimer.Tick += (a, b) => { waitTimer.Stop(); if (attendee == null) Shutdown("no-viewer"); };
            waitTimer.Start();
        }

        void OnCommand(Dictionary<string, object> cmd)
        {
            var name = Io.Str(cmd, "cmd");
            if (name == "end") Shutdown("ended");
            else if (name == "screen") SelectScreen(Io.Int(cmd, "index", -1));
            else if (name == "control")
            {
                controlAllowed = Io.Str(cmd, "on") != "False";
                ApplyControl();
            }
        }

        void SelectScreen(int index)
        {
            if (session == null || done) return;
            shown = index >= 0 && index < screens.Length ? index : -1;
            Rectangle r = shown >= 0 ? screens[shown].Bounds : SystemInformation.VirtualScreen;
            try { ((dynamic)session).SetDesktopSharedRect(r.Left, r.Top, r.Right, r.Bottom); }
            catch (Exception e) { Io.Emit("error", "Could not change the shared screen: " + e.Message); }
            if (attendee != null) ShowFrame();
        }

        /// <summary>The red frame goes on the screen being looked at (each screen, when it is all of them).</summary>
        void ShowFrame()
        {
            frame.Show(shown >= 0 ? new[] { screens[shown].Bounds } : screens.Select(s => s.Bounds).ToArray());
        }

        void ToggleControl()
        {
            controlAllowed = !controlAllowed;
            ApplyControl();
        }

        void ApplyControl()
        {
            if (attendee == null) return;
            try { ((dynamic)attendee).ControlLevel = controlAllowed ? Level.Interactive : Level.View; } catch { }
            tray.Show(controlAllowed ? Who + " is viewing and controlling your computer" : Who + " is viewing your screen (view only)", true, controlAllowed);
            Io.Emit("control", null, new Dictionary<string, object> { { "on", controlAllowed } });
        }

        public override void OnAttendeeConnected(object pAttendee)
        {
            Io.Trace("OnAttendeeConnected", Describe(pAttendee));
            try
            {
                attendee = pAttendee;
                waitTimer.Stop();
                // The person sharing said yes in InterCom before this existed: view, and control
                // unless the session was started view-only. Stopping control takes it back at once.
                ApplyControl();
                ShowFrame();
                tray.Balloon("Remote help", controlAllowed ? Who + " is now viewing and controlling your computer." : Who + " is now viewing your screen.");
                Io.Emit("attendee");
            }
            catch (Exception e) { Io.Emit("error", e.Message); }
        }

        public override void OnAttendeeDisconnected(object pDisconnectInfo)
        {
            Io.Trace("OnAttendeeDisconnected");
            Shutdown("left");
        }

        public override void OnControlLevelChangeRequest(object pAttendee, int requestedLevel)
        {
            Io.Trace("OnControlLevelChangeRequest", "requested=" + requestedLevel + " " + Describe(pAttendee));
            try
            {
                ((dynamic)pAttendee).ControlLevel =
                    requestedLevel == Level.Interactive && !controlAllowed ? Level.View : requestedLevel;
            }
            catch { }
        }

        void Shutdown(string reason)
        {
            if (done) return;
            done = true;
            try { waitTimer.Stop(); } catch { }
            try { if (invitation != null) ((dynamic)invitation).Revoked = true; } catch { }
            try { if (attendee != null) ((dynamic)attendee).TerminateConnection(); } catch { }
            try { if (cookie != null) cookie.Disconnect(); } catch { }
            try { if (session != null) ((dynamic)session).Close(); } catch { }
            try { if (session != null) Marshal.FinalReleaseComObject(session); } catch { }
            Io.Emit("closed", null, new Dictionary<string, object> { { "reason", reason } });
            try { frame.Dispose(); } catch { }
            try { tray.Dispose(); } catch { }
            Application.ExitThread();
        }
    }

    // ---------------------------------------------------------------------------------------
    // The viewing side
    // ---------------------------------------------------------------------------------------

    /// <summary>Hosts the viewer ActiveX control that rdpviewerax.dll provides.</summary>
    internal sealed class ViewerOcx : AxHost
    {
        object ocx;
        ConnectionPointCookie cookie;
        readonly IRdpEvents sink;

        public ViewerOcx(IRdpEvents sink) : base("32be5ed2-5c86-480f-a914-0ff8885a1b3f")
        {
            this.sink = sink;
        }

        public dynamic Ocx { get { return ocx; } }

        protected override void AttachInterfaces() { ocx = GetOcx(); }

        protected override void CreateSink()
        {
            try { cookie = new ConnectionPointCookie(ocx, sink, typeof(IRdpEvents)); } catch { }
        }

        protected override void DetachSink()
        {
            try { if (cookie != null) cookie.Disconnect(); } catch { }
            cookie = null;
        }
    }

    internal sealed class Viewer : RdpSink
    {
        readonly Form form = new Form();
        readonly ViewerOcx ocx;
        readonly ToolStrip bar = new ToolStrip();
        readonly ToolStripButton fullScreen = new ToolStripButton("Full screen");
        readonly ToolStripDropDownButton view = new ToolStripDropDownButton("View");
        readonly ToolStripMenuItem fit = new ToolStripMenuItem("Fit to window");
        readonly ToolStripMenuItem actual = new ToolStripMenuItem("Actual size");
        readonly ToolStripDropDownButton screenMenu = new ToolStripDropDownButton("Screen");
        readonly ToolStripButton control = new ToolStripButton("Control");
        readonly ToolStripButton chat = new ToolStripButton("Conversation");
        readonly ToolStripButton endSession = new ToolStripButton("End session");
        readonly ToolStripLabel status = new ToolStripLabel("Connecting…");
        readonly Label ended = new Label();
        string selfName = "";
        string peer = "";
        bool connected;
        bool done;
        bool wantControl = true;
        FormBorderStyle normalBorder;
        FormWindowState normalState;

        Viewer()
        {
            ocx = new ViewerOcx(this);
        }

        public static int Run(Options o)
        {
            var v = new Viewer();
            Io.Start(v.OnCommand, () => v.Shutdown("host-gone"));
            Application.Run();
            return 0;
        }

        void OnCommand(Dictionary<string, object> cmd)
        {
            var name = Io.Str(cmd, "cmd");
            if (name == "end") Shutdown("ended");
            else if (name == "connect") Connect(cmd);
            else if (name == "control" && connected)
            {
                control.Checked = Io.Str(cmd, "on") != "False";
                ToggleControl();
            }
        }

        void Connect(Dictionary<string, object> cmd)
        {
            if (connected || done) return;
            connected = true;
            peer = Io.Str(cmd, "peer");
            selfName = Io.Str(cmd, "self");
            BuildWindow(cmd);
            form.Show();
            ocx.CreateControl();
            try
            {
                dynamic o = ocx.Ocx;
                o.SmartSizing = true;
                o.Connect(Io.Str(cmd, "ticket"), selfName.Length > 0 ? selfName : "InterCom", Io.Str(cmd, "password"));
            }
            catch (Exception e)
            {
                Io.Emit("error", "Could not start the connection: " + e.Message);
                Shutdown("connect-failed");
            }
        }

        void BuildWindow(Dictionary<string, object> cmd)
        {
            form.Text = (peer.Length > 0 ? peer + " - " : "") + "Remote help";
            form.AutoScaleDimensions = new SizeF(96F, 96F);
            form.AutoScaleMode = AutoScaleMode.Dpi;
            var area = Screen.PrimaryScreen.WorkingArea;
            form.StartPosition = FormStartPosition.Manual;
            form.Size = new Size((int)(area.Width * 0.8), (int)(area.Height * 0.8));
            form.Location = new Point(area.Left + (area.Width - form.Width) / 2, area.Top + (area.Height - form.Height) / 2);
            form.ShowIcon = true;
            try { form.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            bar.GripStyle = ToolStripGripStyle.Hidden;
            bar.RenderMode = ToolStripRenderMode.System;
            bar.ImageScalingSize = new Size(20, 20);
            bar.Padding = new Padding(6, 3, 6, 3);
            foreach (ToolStripItem item in new ToolStripItem[] { fullScreen, view, screenMenu, control, chat, endSession })
            {
                item.DisplayStyle = ToolStripItemDisplayStyle.ImageAndText;
                item.TextImageRelation = TextImageRelation.ImageBeforeText;
                item.Padding = new Padding(4, 0, 4, 0);
            }
            fullScreen.Image = Icons.Glyph(Icons.FullScreen, Color.Black);
            fullScreen.ToolTipText = "Full screen";
            view.Image = Icons.Glyph(Icons.View, Color.Black);
            screenMenu.Image = Icons.Glyph(Icons.Monitor, Color.Black);
            screenMenu.ToolTipText = "Choose which screen to look at";
            control.Image = Icons.Glyph(Icons.Control, Color.Black);
            control.ToolTipText = "Control the other computer with your mouse and keyboard (click again for view only)";
            chat.Image = Icons.Glyph(Icons.Chat, Color.Black);
            chat.ToolTipText = "Open the conversation in InterCom";
            endSession.Image = Icons.Glyph(Icons.HangUp, Color.Firebrick);
            endSession.ForeColor = Color.Firebrick;
            endSession.Alignment = ToolStripItemAlignment.Right;
            endSession.ToolTipText = "End the session on both computers";
            endSession.Click += (a, b) => Shutdown("closed");
            fullScreen.CheckOnClick = true;
            fullScreen.Click += (a, b) => ToggleFullScreen();
            fit.Checked = true;
            fit.Click += (a, b) => SetFit(true);
            actual.Click += (a, b) => SetFit(false);
            view.DropDownItems.AddRange(new ToolStripItem[] { fit, actual });

            // Screens as the sharing PC reported them; one entry is "all of them".
            var screens = new List<object>();
            if (cmd.ContainsKey("screens") && cmd["screens"] is IEnumerable && !(cmd["screens"] is string))
                foreach (var item in (IEnumerable)cmd["screens"]) screens.Add(item);
            if (screens.Count > 1)
            {
                var all = new ToolStripMenuItem("All screens") { Checked = true, Tag = -1 };
                screenMenu.DropDownItems.Add(all);
                for (int i = 0; i < screens.Count; i++)
                {
                    var d = screens[i] as Dictionary<string, object>;
                    if (d == null) continue;
                    var label = "Screen " + (i + 1) + " (" + Io.Int(d, "w", 0) + "×" + Io.Int(d, "h", 0) + ")"
                        + (d.ContainsKey("primary") && d["primary"] is bool && (bool)d["primary"] ? " - main" : "");
                    screenMenu.DropDownItems.Add(new ToolStripMenuItem(label) { Tag = i });
                }
                foreach (ToolStripMenuItem item in screenMenu.DropDownItems)
                {
                    var mi = item;
                    mi.Click += (a, b) => SelectScreen(mi);
                }
            }

            // Off until the sharing PC confirms control: the button must not claim more than is true.
            control.CheckOnClick = true;
            control.Checked = false;
            control.Click += (a, b) => ToggleControl();
            chat.Click += (a, b) => Io.Emit("chat");
            status.Alignment = ToolStripItemAlignment.Right;
            status.ForeColor = SystemColors.GrayText;

            bar.Items.Add(fullScreen);
            bar.Items.Add(view);
            if (screenMenu.DropDownItems.Count > 0) bar.Items.Add(screenMenu);
            bar.Items.Add(control);
            bar.Items.Add(chat);
            bar.Items.Add(endSession);
            bar.Items.Add(status);

            ocx.Dock = DockStyle.Fill;
            ended.Dock = DockStyle.Fill;
            ended.TextAlign = ContentAlignment.MiddleCenter;
            ended.Font = new Font("Segoe UI", 14F);
            ended.Visible = false;
            form.Controls.Add(ocx);
            form.Controls.Add(ended);
            form.Controls.Add(bar);
            form.FormClosing += (a, b) => { if (!done) Shutdown("closed"); };
        }

        void SetFit(bool smart)
        {
            fit.Checked = smart;
            actual.Checked = !smart;
            try { ocx.Ocx.SmartSizing = smart; } catch { }
        }

        void SelectScreen(ToolStripMenuItem chosen)
        {
            foreach (ToolStripMenuItem item in screenMenu.DropDownItems) item.Checked = item == chosen;
            screenMenu.Text = chosen.Tag is int && (int)chosen.Tag >= 0 ? "Screen " + ((int)chosen.Tag + 1) : "Screen";
            Io.Emit("screen", null, new Dictionary<string, object> { { "index", (int)chosen.Tag } });
        }

        void ToggleControl()
        {
            wantControl = control.Checked;
            RequestControl();
        }

        void RequestControl()
        {
            try { ocx.Ocx.RequestControl(wantControl ? Level.Interactive : Level.View); } catch { }
        }

        void ToggleFullScreen()
        {
            fullScreen.Image = Icons.Glyph(fullScreen.Checked ? Icons.ExitFullScreen : Icons.FullScreen, Color.Black);
            fullScreen.Text = fullScreen.Checked ? "Exit full screen" : "Full screen";
            if (fullScreen.Checked)
            {
                normalBorder = form.FormBorderStyle;
                normalState = form.WindowState;
                form.WindowState = FormWindowState.Normal;
                form.FormBorderStyle = FormBorderStyle.None;
                form.WindowState = FormWindowState.Maximized;
            }
            else
            {
                form.FormBorderStyle = normalBorder;
                form.WindowState = normalState;
            }
        }

        // The link is up but the password has not been checked yet: not "connected" until it has.
        public override void OnConnectionEstablished()
        {
            Io.Trace("OnConnectionEstablished");
            status.Text = "Signing in…";
        }

        public override void OnConnectionAuthenticated()
        {
            Io.Trace("OnConnectionAuthenticated");
            status.Text = "Connected - viewing only";
            Io.Emit("connected");
            RequestControl();
        }

        // The sharing PC changed what this viewer may do: this is how control arrives.
        public override void OnAttendeeUpdate(object pAttendee)
        {
            Io.Trace("OnAttendeeUpdate", Describe(pAttendee));
            try
            {
                int level = (int)((dynamic)pAttendee).ControlLevel;
                bool on = level == Level.Interactive;
                if (level != Level.Interactive && level != Level.View) return;
                control.Checked = on;
                status.Text = on ? "Connected - controlling" : "Connected - viewing only";
                Io.Emit("control", null, new Dictionary<string, object> { { "on", on } });
            }
            catch { }
        }

        public override void OnConnectionFailed()
        {
            Io.Trace("OnConnectionFailed");
            Io.Emit("error", "Could not connect to the other PC.");
            Shutdown("connect-failed");
        }

        public override void OnConnectionTerminated(int discReason, int extendedInfo)
        {
            Io.Trace("OnConnectionTerminated", "reason=" + discReason + " ext=" + extendedInfo);
            if (done) return;
            // The other side ended it (or the link dropped): say so, then let the window go.
            status.Text = "Ended";
            ended.Text = "The session has ended.";
            ended.Visible = true;
            ocx.Visible = false;
            var close = new System.Windows.Forms.Timer { Interval = 2500 };
            close.Tick += (a, b) => { close.Stop(); Shutdown("peer-ended"); };
            close.Start();
        }

        public override void OnControlLevelChangeResponse(object pAttendee, int requestedLevel, int reasonCode)
        {
            Io.Trace("OnControlLevelChangeResponse", "level=" + requestedLevel + " reason=" + reasonCode);
            var interactive = requestedLevel == Level.Interactive && reasonCode == 0;
            control.Checked = interactive;
            status.Text = interactive ? "Connected - controlling" : "Connected - viewing only";
            Io.Emit("control", null, new Dictionary<string, object> { { "on", interactive } });
        }

        void Shutdown(string reason)
        {
            if (done) return;
            done = true;
            try { ocx.Ocx.Disconnect(); } catch { }
            Io.Emit("closed", null, new Dictionary<string, object> { { "reason", reason } });
            try { form.Close(); } catch { }
            Application.ExitThread();
        }
    }
}
